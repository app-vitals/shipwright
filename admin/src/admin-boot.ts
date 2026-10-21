/**
 * admin/src/admin-boot.ts
 *
 * Admin platform boot sequence, exported as startAdmin(extensions). A consumer
 * entry (admin/src/main.ts for Shipwright) passes its AdminExtensions; with
 * none (or hookless ones) this is exactly the bare admin platform. See
 * admin-extension.ts for the seam and where each hook lands in the sequence.
 *
 * Boot order (pinned by admin-boot.boot-order.unit.test.ts):
 *   Sentry → migrations → Prisma → platform services → resolve extensions →
 *   routes (health, runtime API, admin API, accounts API, extension APIs,
 *   admin UI, extension UI) → platform sweepers → extension background
 *   passes → Bun.serve → graceful shutdown → startup policy reconcile.
 *
 * Route mount order (important — avoids shadowing):
 *   GET  /health                 — liveness check (no auth, DB-independent)
 *   GET  /health/ready           — readiness check (no auth, DB-aware)
 *   *    /agents/*               — runtime API  (admin key | per-agent bearer | session JWT)
 *                                  + admin CRUD API (admin key | per-agent bearer | session JWT)
 *   *    /admin/*                — admin UI       (session JWT)
 *
 * Both runtimeApp and adminApiApp serve routes under /agents/*.
 * They use non-overlapping sub-paths so Hono resolves them correctly:
 *   runtime  → GET  /agents/:id/config, GET /agents/:id/crons
 *   admin    → GET /agents/:id/crons/summary (enriched with run stats)
 *              POST/PATCH/DELETE /agents/:id/envs, /crons, /tools, /tokens, /plugins
 *
 * This file must not import any coding module — main.ts is the only file
 * that wires a concrete extension in.
 */

import { join } from "node:path";
import * as Sentry from "@sentry/bun";
import { sentry } from "@sentry/hono/bun";
import { registerGracefulShutdown } from "@shipwright/lib/graceful-shutdown";
import { buildSentryInitOptions, initSentry } from "@shipwright/lib/sentry";
import { Hono } from "hono";
import { createAccountCreatedNotifier } from "./account-created-notifier.ts";
import { AccountInviteService } from "./account-invites.ts";
import { AccountLifecycle } from "./account-lifecycle.ts";
import { AccountMemberService } from "./account-members.ts";
import { AccountOnboardingService } from "./account-onboarding.ts";
import { AccountTrialExpirySweeper } from "./account-trial-expiry-sweeper.ts";
import { AccountTrialWarningSweeper } from "./account-trial-warning-sweeper.ts";
import { AccountService } from "./accounts.ts";
import { createAccountsApp } from "./accounts-api.ts";
import {
  buildDeletionClients,
  buildProvisioner,
  checkDbReady,
  DEFAULT_PORT,
  DEFAULT_TRIAL_EXPIRY_WARNING_SWEEP_INTERVAL_MS,
  isAnthropicFederationEnabled,
  resolveTrialExpiryWarningDays,
  runMigrations,
} from "./admin-boot-config.ts";
import {
  type AdminExtension,
  type AdminExtensionContext,
  collectServiceIntegrations,
  mountRouteContributions,
  resolveAdminExtensions,
  startBackgroundPasses,
} from "./admin-extension.ts";
import { createAdminUIApp } from "./admin-ui.ts";
import { AgentChatTokenService } from "./agent-chat-tokens.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentCronRunStatsService } from "./agent-cron-run-stats.ts";
import { AgentCronRunService } from "./agent-cron-runs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentGitHubInstallationsService } from "./agent-github-installations.ts";
import { AgentMemberService } from "./agent-members.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { AgentTypeRegistry } from "./agent-type-manifest-loader.ts";
import { AgentService } from "./agents.ts";
import { createAdminApp, parseAdminApiKeys } from "./agents-api.ts";
import { createAgentRuntimeApp } from "./api.ts";
import {
  callerScopeDepsFromServices,
  createCallerScopeResolver,
} from "./caller-scope.ts";
import { AgentPhaseMethodologyService } from "./coding/agent-phase-methodology.ts";
import { AgentWorkQueueService } from "./coding/agent-work-queue.ts";
import { DevTaskAdherenceService } from "./coding/dev-task-adherence.ts";
import { isDevAuthAllowed } from "./dev-auth-guard.ts";
import { HttpGithubAppProvisioningClient } from "./github-app-provisioning-client.ts";
import { HttpGoogleAuthClient } from "./google-auth-client.ts";
import { HttpChatClient } from "./http-chat-client.ts";
import { HttpOktaAuthClient } from "./okta-auth-client.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";
import { isPushEnabled } from "./push-sender.ts";
import { PushService } from "./push-service.ts";
import { parseSelfServeConfig } from "./self-serve-config.ts";
import { HttpSlackProvisioningClient } from "./slack-provisioning-client.ts";
import { runStartupPolicyReconcile } from "./startup-policy-reconcile.ts";
import { makeTokenCrypto } from "./token-crypto.ts";
import {
  resolveTrialExpirySweepIntervalMs,
  TrialExpirySweeper,
} from "./trial-expiry-sweeper.ts";
import { TrialExpiryWarningSweeper } from "./trial-expiry-warning-sweeper.ts";

// startAdmin() is the process boot: it runs the real migration preflight,
// constructs a real PrismaClient (live DB connection), calls Bun.serve to bind
// an actual socket, and mounts every sub-app. This is process-wiring / real-I/O
// by design — its pure logic lives in admin-boot-config.ts (unit-tested via
// main.unit.test.ts) and admin-extension.ts (admin-extension.unit.test.ts),
// and its sequence is pinned structurally by admin-boot.boot-order.unit.test.ts.
// It is exercised in deployed environments (and via the smoke/integration
// suites of the services it wires together), not by a unit test — forcing a
// mock-heavy unit test here would mean re-implementing
// Bun.serve/PrismaClient/Hono routing as fakes without gaining real coverage
// of the wiring behavior itself.
export async function startAdmin(
  extensions: readonly AdminExtension[] = [],
): Promise<void> {
  // Initializes Sentry (no-op when SENTRY_DSN is unset) so that startup
  // failures below (e.g. a failed migration) are captured too. See
  // task-store's main.ts for the rationale on why re-initializing is safe.
  initSentry({ service: "admin" });

  const port = Number(process.env.PORT ?? DEFAULT_PORT);

  console.log(`[admin] starting admin service on port ${port}`);

  // Run DB migrations as idempotent preflight
  await runMigrations();

  // Construct PrismaClient once at boot. Prisma 7 has no built-in query
  // engine, so this is a PrismaPg driver adapter over a pg.Pool built from
  // DATABASE_URL_SHIPWRIGHT_ADMIN — see prisma-client.ts. An unset URL throws
  // there (an empty connection string would otherwise make pg fall back to the
  // PG* env vars or localhost, silently pointing the service at a different
  // database); the top-level catch turns that into a named
  // "[admin] fatal startup error" and exit 1, matching how Prisma 6 refused to
  // construct a client without the env var.
  const prisma = createAdminPrismaClient(
    process.env.DATABASE_URL_SHIPWRIGHT_ADMIN ?? "",
  );

  // Construct TokenCrypto — reads SHIPWRIGHT_ENCRYPTION_KEY at call time
  const crypto = makeTokenCrypto();

  // Construct all services with injected deps
  const agentService = new AgentService(prisma);
  const anthropicFederationEnabled = isAnthropicFederationEnabled(process.env);
  const agentEnvService = new AgentEnvService(
    prisma,
    crypto,
    undefined,
    anthropicFederationEnabled,
  );
  const agentCronJobService = new AgentCronJobService(prisma);
  const agentCronRunService = new AgentCronRunService(prisma);
  const agentToolService = new AgentToolService(prisma);
  const agentTokenService = new AgentTokenService(prisma);
  const agentPluginService = new AgentPluginService(prisma);
  const agentPhaseMethodologyService = new AgentPhaseMethodologyService(prisma);
  const agentMemberService = new AgentMemberService(prisma);
  // Account-aware caller scope (SSP-2.1). Account membership contributes
  // agents only when the self-serve flag is on; off → AgentMember-only.
  const accountService = new AccountService(prisma);
  const callerScopeResolver = createCallerScopeResolver(
    callerScopeDepsFromServices({
      accountService,
      agentMemberService,
    }),
    process.env.SHIPWRIGHT_SELF_SERVE_ENABLED === "enabled",
  );
  const agentChatTokenService = new AgentChatTokenService(prisma);
  const agentCronRunStatsService = new AgentCronRunStatsService(prisma);
  const devTaskAdherenceService = new DevTaskAdherenceService(prisma);
  const agentWorkQueueService = new AgentWorkQueueService(prisma);
  const agentGitHubInstallationsService = new AgentGitHubInstallationsService(
    prisma,
  );

  // Extension-registered service integrations (task-store, via the coding
  // extension): env-only, so resolved before the provisioner that mints their
  // tokens and the agent deletion that revokes them.
  const serviceIntegrations = collectServiceIntegrations(
    extensions,
    process.env,
  );

  // Real K8s provisioner when SHIPWRIGHT_K8S_PROVISIONING=enabled, else Noop.
  const provisioner = buildProvisioner(
    process.env,
    agentTokenService,
    prisma,
    serviceIntegrations,
  );

  // Read config values at call time (no module-level env reads)
  const sessionSecret = process.env.SHIPWRIGHT_SESSION_SECRET ?? "";
  const googleClientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  const oktaIssuer = process.env.OKTA_ISSUER ?? "";
  const oktaClientId = process.env.OKTA_CLIENT_ID ?? "";
  const oktaClientSecret = process.env.OKTA_CLIENT_SECRET ?? "";
  const adminAllowedEmails = (process.env.SHIPWRIGHT_ADMIN_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  const appBaseUrl =
    process.env.SHIPWRIGHT_ADMIN_APP_BASE_URL ?? `http://localhost:${port}`;
  // Read once at startup (not per-request) and interpolated into the
  // service worker's cache name — see admin/src/pwa.ts's
  // buildServiceWorkerBody. Falls back to "0.0.0" if version.txt is
  // missing so a broken read never blocks server startup.
  const appVersion = await Bun.file(
    join(import.meta.dir, "..", "..", "version.txt"),
  )
    .text()
    .then((v) => v.trim())
    .catch(() => "0.0.0");
  const adminApiKeys = parseAdminApiKeys(process.env.SHIPWRIGHT_ADMIN_API_KEYS);
  // Self-serve provisioning config (SSP-1.3) — read once at startup and
  // injected as deps; no consumers yet.
  const selfServe = parseSelfServeConfig(process.env);
  // Account status transitions → cron lockdown/restore (SSP-8.2). Shared by
  // the /accounts PATCH handler, the admin UI and the account sweepers.
  const accountLifecycle = new AccountLifecycle({
    accounts: accountService,
    cronJobs: agentCronJobService,
  });

  const googleClient = new HttpGoogleAuthClient();
  // Constructed only when an issuer is configured — HttpOktaAuthClient requires
  // `issuer` in its constructor, and an empty issuer would produce nonsensical
  // (double-slash-free but bogus) endpoint URLs. When unset, oktaClient stays
  // undefined and both Okta routes redirect to /admin/login?error=server_error
  // without attempting any external call (see admin-ui.ts's AdminUIDeps doc).
  const oktaClient = oktaIssuer
    ? new HttpOktaAuthClient({ issuer: oktaIssuer })
    : undefined;
  const slackClient = new HttpSlackProvisioningClient();
  const githubAppClient = new HttpGithubAppProvisioningClient();

  // Chat-service client for deleteAgentFully() cleanup, shared by both delete
  // entry points (DELETE /agents/:id and the admin-ui danger zone) —
  // independent of SHIPWRIGHT_K8S_PROVISIONING (see buildDeletionClients doc
  // comment). Extension service integrations are cleaned up before it.
  const { chatService: deletionChatService } = buildDeletionClients(
    process.env,
  );

  // Web Push (CFB-4.2). Enabled ONLY when public + private + subject are all
  // set — a partial config must not half-enable the feature. When disabled,
  // pushService is undefined, the push routes 503, and the toggle renders "".
  const vapidConfig = {
    publicKey: process.env.SHIPWRIGHT_ADMIN_VAPID_PUBLIC_KEY ?? "",
    privateKey: process.env.SHIPWRIGHT_ADMIN_VAPID_PRIVATE_KEY ?? "",
    subject: process.env.SHIPWRIGHT_ADMIN_VAPID_SUBJECT ?? "",
  };
  const pushWebhookToken = process.env.SHIPWRIGHT_ADMIN_PUSH_WEBHOOK_TOKEN;
  // Operator ceiling for how much detail a notification may reveal on a locked
  // screen. Defaults to "title" per the content policy.
  const pushMaxDetail = process.env.SHIPWRIGHT_ADMIN_PUSH_MAX_DETAIL ?? "title";
  const pushService = isPushEnabled(vapidConfig)
    ? new PushService(prisma as never, vapidConfig, fetch, pushMaxDetail)
    : undefined;

  // AEP-2.1: resolve the extensions once, after every platform service they
  // may build on exists and before any route is mounted. With no extensions
  // (or hookless ones) every contribution below is empty and the admin is the
  // bare platform.
  const extensionContext: AdminExtensionContext = {
    env: process.env,
    prisma,
    sessionSecret,
    adminApiKeys,
    adminAllowedEmails,
    appBaseUrl,
    ...(process.env.SHIPWRIGHT_ADMIN_TZ
      ? { timezone: process.env.SHIPWRIGHT_ADMIN_TZ }
      : {}),
    ...(pushService
      ? {
          push: {
            service: pushService,
            maxDetail: pushMaxDetail,
            vapidPublicKey: vapidConfig.publicKey,
          },
        }
      : {}),
    services: {
      agentService,
      agentEnvService,
      agentCronJobService,
      agentCronRunService,
      agentGitHubInstallationsService,
      agentTokenService,
      agentMemberService,
      accountService,
      callerScopeResolver,
      provisioner,
    },
  };
  const resolvedExtensions = resolveAdminExtensions(
    extensions,
    extensionContext,
  );

  // Reassigned below, after Bun.serve() + registerGracefulShutdown() run —
  // the /health/ready handler only calls this at request time (well after
  // startAdmin() finishes its synchronous setup), so it always sees the
  // real graceful-shutdown flag once one exists.
  let isShuttingDown = (): boolean => false;

  const root = new Hono();

  // Only mounted when SENTRY_DSN is set — a complete no-op otherwise, matching
  // the app's behavior with Sentry absent. `@sentry/hono`'s `sentry()`
  // middleware performs its own `Sentry.init` call internally, so this stays
  // the only Hono-level init site; it's mounted on the root app (rather than
  // inside a single sub-app) since root is the actual process entry composing
  // the full route tree (health, runtime API, admin API, admin UI).
  const sentryInitOptions = buildSentryInitOptions({ service: "admin" });
  if (sentryInitOptions) {
    root.use("*", sentry(root, sentryInitOptions));
  }

  // 1. Health checks — no auth
  //    /health       — liveness: process-alive only, independent of DB state.
  //                    A transient DB blip must never trigger a
  //                    liveness-driven restart.
  //    /health/ready — readiness: DB-aware. Used by the chart's readinessProbe
  //                    so Kubernetes doesn't route traffic to this pod before
  //                    the Cloud SQL proxy sidecar has finished connecting.
  root.get("/health", (c) => c.json({ status: "ok" }));
  root.get("/health/ready", async (c) => {
    // Once a shutdown signal has been received, fail readiness immediately
    // (no DB round-trip) so Kubernetes pulls this pod from Service endpoints
    // as early as possible — see lib/graceful-shutdown.ts.
    if (isShuttingDown()) {
      return c.json({ status: "unavailable" }, 503);
    }
    const ready = await checkDbReady(prisma);
    return c.json({ status: ready ? "ok" : "unavailable" }, ready ? 200 : 503);
  });

  // Redirect bare root to the login page — no handler exists at "/" otherwise.
  root.get("/", (c) => c.redirect("/admin/login", 302));

  // 2. Runtime API — admin key | per-agent bearer | session JWT
  //    Mounted via root.route("/agents", runtimeApp). Hono v4 strips the prefix
  //    before dispatching, so runtimeApp routes are registered as /:id/config
  //    and /:id/crons (without the /agents prefix) and resolve correctly at
  //    GET /agents/:id/config and GET /agents/:id/crons from root.
  const runtimeApp = createAgentRuntimeApp({
    agentEnvService,
    agentCronJobService,
    agentService,
    agentPluginService,
    agentPhaseMethodologyService,
    sessionSecret,
    adminApiKeys,
    agentTokenService,
    anthropicFederationEnabled,
  });

  root.route("/agents", runtimeApp);

  // 3. Admin CRUD API — /agents/:id/* — admin key | per-agent bearer | session JWT
  //    Routes are now at /agents/:id/* (same prefix as runtime, different sub-paths).
  //    MUST be mounted before admin-ui (/admin/*) to avoid shadowing.
  const adminApiApp = createAdminApp({
    agentService,
    agentEnvService,
    agentCronJobService,
    agentCronRunService,
    agentCronRunStatsService,
    devTaskAdherenceService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    agentPhaseMethodologyService,
    agentMemberService,
    callerScopeResolver,
    agentTypeRegistry: new AgentTypeRegistry(),
    agentChatTokenService,
    agentWorkQueueService,
    agentGitHubInstallationsService,
    prisma,
    provisioner,
    serviceIntegrations,
    chatService: deletionChatService,
    slack: slackClient,
    decrypt: crypto.decrypt,
    sessionSecret,
    adminApiKeys,
    sentryClient: process.env.SENTRY_DSN ? Sentry : undefined,
    selfServe,
    anthropicFederationEnabled,
    ...resolvedExtensions.apiDeps,
  });
  root.route("/", adminApiApp);

  // 3b. Accounts API — /accounts/* — admin-only, flag-gated (SSP-5.1)
  root.route(
    "/",
    createAccountsApp({
      accountService: new AccountService(prisma),
      accountLifecycle,
      selfServe,
      sessionSecret,
      adminApiKeys,
      agentTokenService,
    }),
  );

  // 3c. Extension API routes — after every platform API, before the admin UI
  //     (same no-shadowing rule as the admin CRUD API above).
  mountRouteContributions(root, resolvedExtensions.apiRoutes);

  // 4. Admin UI — /admin/* — session JWT
  // Validate SHIPWRIGHT_ADMIN_TZ at startup — toLocaleDateString/toLocaleString
  // will throw RangeError at render time if the timezone is invalid, causing a 500
  // on every admin page. Catch it early with a clean error and exit.
  const adminTz = process.env.SHIPWRIGHT_ADMIN_TZ;
  if (adminTz) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: adminTz });
    } catch {
      console.error("[admin] Invalid SHIPWRIGHT_ADMIN_TZ:", adminTz);
      process.exit(1);
    }
  }

  // Build chat client when both SHIPWRIGHT_CHAT_SERVICE_URL and
  // SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN are set. When absent the /admin/chat
  // routes render in degraded mode (notice, no table/messages).
  const chatServiceUrl = process.env.SHIPWRIGHT_CHAT_SERVICE_URL;
  const chatServiceAdminToken = process.env.SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN;
  const chatClient =
    chatServiceUrl && chatServiceAdminToken
      ? new HttpChatClient(chatServiceUrl, chatServiceAdminToken)
      : undefined;

  const adminUIApp = createAdminUIApp({
    prisma: prisma as never,
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    agentMemberService,
    callerScopeResolver,
    agentService,
    provisioner,
    anthropicFederationEnabled,
    serviceIntegrations,
    chatService: deletionChatService,
    slack: slackClient,
    decrypt: crypto.decrypt,
    sessionSecret,
    googleClientId,
    googleClientSecret,
    adminAllowedEmails,
    googleClient,
    oktaClientId,
    oktaClientSecret,
    oktaIssuer,
    ...(oktaClient ? { oktaClient } : {}),
    slackClient,
    githubAppClient,
    appBaseUrl,
    appVersion,
    devAuthEnabled: isDevAuthAllowed(process.env),
    selfServe,
    accountService,
    accountOnboarding: new AccountOnboardingService(
      prisma,
      selfServe.defaultMaxAgents,
    ),
    ...(() => {
      const accountCreatedNotifier = createAccountCreatedNotifier({
        ...(pushService ? { pushService } : {}),
        adminEmails: adminAllowedEmails,
      });
      return accountCreatedNotifier ? { accountCreatedNotifier } : {};
    })(),
    accountServices: {
      accounts: new AccountService(prisma),
      members: new AccountMemberService(prisma),
      invites: new AccountInviteService(prisma),
      lifecycle: accountLifecycle,
    },
    timezone: adminTz,
    ...(chatClient ? { chatClient } : {}),
    ...(pushService
      ? {
          pushService,
          vapidPublicKey: vapidConfig.publicKey,
          ...(pushWebhookToken ? { pushWebhookToken } : {}),
        }
      : {}),
    ...(resolvedExtensions.agentDetailCards.length > 0
      ? { agentDetailCards: resolvedExtensions.agentDetailCards }
      : {}),
    ...resolvedExtensions.uiDeps,
  });
  root.route("/", adminUIApp);

  // 4b. Extension admin UI routes — after the platform UI.
  mountRouteContributions(root, resolvedExtensions.adminUiRoutes);

  // Trial-expiry warning sweeper (ATE-2.1) — warns an agent's own Slack alert
  // channel once, shortly BEFORE its trial lapses. Registered HERE, never
  // inside createAdminUIApp()/createAdminApp(), which must stay
  // side-effect-free (same rule as the session alert sweeper's registration).
  // Unlike the session alert sweeper, this one needs no external service
  // config to be meaningful — its only dependencies (Prisma, AgentService,
  // AgentEnvService) are always constructed above — so it always starts.
  {
    const trialExpiryWarningSweeper = new TrialExpiryWarningSweeper({
      prisma: prisma as never,
      agentService,
      agentEnvService,
      warningDays: resolveTrialExpiryWarningDays(process.env),
    });
    setInterval(() => {
      trialExpiryWarningSweeper
        .tick()
        .catch((err) =>
          console.error("[trial-expiry-warning-sweeper] tick error:", err),
        );
    }, DEFAULT_TRIAL_EXPIRY_WARNING_SWEEP_INTERVAL_MS);
    console.log(
      `[admin] trial expiry warning sweeper started (interval: ${DEFAULT_TRIAL_EXPIRY_WARNING_SWEEP_INTERVAL_MS}ms)`,
    );
  }

  // Trial-expiry sweeper (ATE-3.1) — the lockdown half, running AFTER the
  // warning sweeper above has had its say: disables every enabled AgentCronJob
  // belonging to an agent whose trialExpiresAt has passed. Registered HERE,
  // never inside createAdminUIApp(), same rule as the session alert sweeper
  // above. Reuses the same agentCronJobService instance constructed earlier
  // in this function — no HTTP self-call, just the service's setEnabled(),
  // the identical method the PATCH /agents/:id/crons/:cronId route calls.
  // Deliberately does NOT deprovision the agent (no deleteAgentFully()) — see
  // trial-expiry-sweeper.ts's header comment.
  {
    const trialExpirySweeper = new TrialExpirySweeper({ agentCronJobService });
    const trialExpirySweepIntervalMs = resolveTrialExpirySweepIntervalMs(
      process.env,
    );
    setInterval(() => {
      trialExpirySweeper
        .tick()
        .catch((err) =>
          console.error("[trial-expiry-sweeper] tick error:", err),
        );
    }, trialExpirySweepIntervalMs);
    console.log(
      `[admin] trial expiry sweeper started (interval: ${trialExpirySweepIntervalMs}ms)`,
    );
  }

  // Account trial sweepers (SSP-8.2) — the account-level counterparts of the
  // two per-agent sweepers above (which keep running unchanged). Flag-gated:
  // accounts only exist when self-serve is enabled. Same cadences as the
  // per-agent pair: hourly warning, minutely expiry/lockdown. Registered
  // HERE, never inside an app factory. No deleteAgentFully call anywhere.
  if (selfServe.enabled) {
    const accountTrialWarningSweeper = new AccountTrialWarningSweeper({
      accounts: accountService,
      agentEnvService,
      warningDays: resolveTrialExpiryWarningDays(process.env),
    });
    setInterval(() => {
      accountTrialWarningSweeper
        .tick()
        .catch((err) =>
          console.error("[account-trial-warning-sweeper] tick error:", err),
        );
    }, DEFAULT_TRIAL_EXPIRY_WARNING_SWEEP_INTERVAL_MS);

    const accountTrialExpirySweeper = new AccountTrialExpirySweeper({
      accounts: accountService,
      lifecycle: accountLifecycle,
    });
    const accountTrialExpiryIntervalMs = resolveTrialExpirySweepIntervalMs(
      process.env,
    );
    setInterval(() => {
      accountTrialExpirySweeper
        .tick()
        .catch((err) =>
          console.error("[account-trial-expiry-sweeper] tick error:", err),
        );
    }, accountTrialExpiryIntervalMs);
    console.log(
      `[admin] account trial sweepers started (warning: ${DEFAULT_TRIAL_EXPIRY_WARNING_SWEEP_INTERVAL_MS}ms, expiry: ${accountTrialExpiryIntervalMs}ms)`,
    );
  }

  // Extension background passes (AEP-2.1) — after every platform sweeper,
  // same "registered here, never inside an app factory" rule.
  startBackgroundPasses(resolvedExtensions.backgroundPasses);

  const server = Bun.serve({ fetch: root.fetch, port });

  const shutdown = registerGracefulShutdown({
    server,
    cleanup: [() => prisma.$disconnect()],
    serviceName: "admin",
  });
  isShuttingDown = shutdown.isShuttingDown;

  console.log(`[admin] admin service listening on port ${port}`);

  // Policy-only reconcile (ACP-1.3): a Claude policy change restarts admin via
  // the chart's policy-hash env var, so rolling only the agents whose policy
  // wiring drifted happens here. Runs even with no policy configured so agents
  // lose the mount once it is disabled. Fire-and-forget: it never throws and
  // must not delay serving.
  void runStartupPolicyReconcile({
    agentService,
    provisioner,
    logger: console,
  });
}
