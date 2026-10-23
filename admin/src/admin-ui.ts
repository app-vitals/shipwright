/**
 * agent/src/admin-ui.ts
 * Admin UI — server-rendered Hono app factory.
 *
 * Routes:
 *   GET  /admin/login                 — login page (Google sign-in button)
 *   GET  /admin/auth/google           — redirect to Google OAuth consent
 *   GET  /admin/auth/callback         — Google OAuth callback → set session cookie
 *   GET  /admin/auth/okta             — redirect to Okta OIDC consent
 *   GET  /admin/auth/okta/callback    — Okta OAuth callback → set session cookie
 *   POST /admin/logout                — clear cookie → redirect to login
 *   GET  /admin/agents                — list all agents (auth required)
 *   GET  /admin/agents/:id            — agent detail (auth required)
 *   POST /admin/agents/:id/envs       — add/update env var (auth required)
 *   POST /admin/agents/:id/envs/delete — delete env var (auth required)
 *   GET  /admin/provision             — 302 redirect to /admin/agents/new (legacy entry point)
 *
 * Auth: httpOnly JWT cookie named "admin_session".
 * Login is OAuth (Google or Okta) — no password, no DB user lookup. Both
 * providers share a common post-auth step (completeLogin()): verified-email
 * check, admin-allowlist/AgentMember-fallback check, session JWT + cookie.
 * Allowed users are controlled by the adminAllowedEmails allowlist in deps.
 */

import { join } from "node:path";
import { isGithubLogin } from "@app-vitals/agent-lib/github-login";
import { isOrgRepo } from "@app-vitals/agent-lib/org-repo";
import { SECRET_ENV_VARS } from "@app-vitals/agent-lib/secret-env-vars";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import {
  accountIdFromScope,
  getSelfServeAgentType,
} from "./account-agent-create.ts";
import type { AccountCreatedNotifier } from "./account-created-notifier.ts";
import { fireAccountCreatedNotification } from "./account-created-notifier.ts";
import type { AccountInviteService } from "./account-invites.ts";
import type { AccountLifecycle } from "./account-lifecycle.ts";
import type { AccountMemberService } from "./account-members.ts";
import type { AccountOnboardingService } from "./account-onboarding.ts";
import type { AccountService } from "./accounts.ts";
import {
  type AgentDetailCardSlot,
  renderAgentDetailCardSlots,
} from "./admin-extension.ts";
import { registerAccountRoutes } from "./admin-ui-account.ts";
import { runWithAccountNav } from "./admin-ui-account-nav.ts";
import { renderZeroQuotaNotice } from "./admin-ui-account-pages.ts";
import { registerAdminAccountsRoutes } from "./admin-ui-accounts.ts";
import {
  type AgentDetail,
  type AgentOption,
  renderAgentDetailPage,
  renderAgentsPage,
  renderChatMessageBubble,
  renderChatPage,
  renderChatThreadPage,
  renderGithubAppInstalledPage,
  renderGithubAppInstallPage,
  renderGithubAppManifestRedirectPage,
  renderLoginPage,
  renderNewLocalAgentPage,
  renderProvisionCompletePage,
  renderProvisionXappTokenPage,
} from "./admin-ui-pages.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { DeleteAgentFullyDeps } from "./agent-deletion.ts";
import { deleteAgentFully } from "./agent-deletion.ts";
import type { ManualStep } from "./agent-deletion-checklist.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentMemberService } from "./agent-members.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import {
  type AgentTypeManifestResolver,
  AgentTypeRegistry,
} from "./agent-type-manifest-loader.ts";
import type { AgentService } from "./agents.ts";
import { createAgent, describeRepoNameCollision } from "./agents.ts";
import { AnthropicCredentialsBlockedError } from "./anthropic-credential-guard.ts";
import {
  audioContentTypeForFilename,
  validateAttachment,
} from "./attachment-validation.ts";
import {
  type CallerScopeResolver,
  memberOnlyCallerScopeResolver,
  scopeIncludesAgent,
} from "./caller-scope.ts";
import { ForbiddenError, UnprocessableEntityError } from "./errors.ts";
import {
  GITHUB_PROVISION_STATE_COOKIE,
  GITHUB_PROVISION_STATE_TTL_SECONDS,
  GithubProvisioningService,
} from "./github-provisioning-service.ts";
import type { GoogleAuthClient } from "./google-auth-client.ts";
import {
  type ChatClient,
  type ChatThread,
  filterSince,
  toPolledMessage,
} from "./http-chat-client.ts";
import type { OktaAuthClient } from "./okta-auth-client.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";
import type { PushService } from "./push-service.ts";
import {
  buildManifest,
  buildOfflinePageHtml,
  buildServiceWorkerBody,
  getPrecacheList,
  PWA_ASSETS_DIR,
  PWA_ICONS,
  renderPwaHeadTags,
  sanitizeStartUrl,
} from "./pwa.ts";
import {
  DEFAULT_SELF_SERVE_CONTACT_EMAIL,
  type SelfServeConfig,
} from "./self-serve-config.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";
import {
  AGENT_BOT_SCOPES,
  buildAgentManifest,
} from "./slack-provisioning-client.ts";
import {
  PROVISION_STATE_COOKIE,
  PROVISION_STATE_TTL_SECONDS,
  SlackProvisioningService,
} from "./slack-provisioning-service.ts";

export type AdminUIEnv = { Variables: { userEmail: string; isAdmin: boolean } };

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Narrow interface for the admin UI's Slack dependency.
 * Deliberately narrower than the full SlackProvisioningClient
 * in slack-provisioning-client.ts — only this surface is needed here.
 */
export interface AdminUISlackClient {
  createAppManifest(
    xoxpToken: string,
    manifest: AppManifest,
  ): Promise<{
    appId: string;
    oauthRedirectUrl: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
  }>;
  updateAppManifest(
    xoxpToken: string,
    appId: string,
    manifest: AppManifest,
  ): Promise<void>;
  exchangeOAuthCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<{ botToken: string }>;
  authTest(botToken: string): Promise<{ userId: string }>;
}

/**
 * Narrow interface for the admin UI's GitHub App provisioning dependency.
 * Mirrors AdminUISlackClient's DI pattern — deliberately narrower than the
 * full GithubAppProvisioningClient in github-app-provisioning-client.ts.
 */
export interface AdminUIGithubAppClient {
  exchangeManifestCode(code: string): Promise<{
    appId: string;
    slug: string;
    pem: string;
    clientId: string;
    clientSecret: string;
  }>;
}

interface PrismaAgentLike {
  findMany(args?: object): Promise<
    Array<{
      id: string;
      name: string;
      slackId: string | null;
      createdAt: Date;
      updatedAt?: Date;
      repos?: string[];
    }>
  >;
  findUnique(args: { where: { id: string } }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    selfHosted: boolean;
    createdAt: Date;
    updatedAt: Date;
    repos: string[];
  } | null>;
  create(args: {
    data: { name: string; slackId?: string | null; selfHosted?: boolean };
  }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    createdAt: Date;
    updatedAt: Date;
    repos: string[];
  }>;
  update(args: { where: { id: string }; data: { repos: string[] } }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    createdAt: Date;
    updatedAt: Date;
    repos: string[];
  }>;
  delete(args: { where: { id: string } }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    createdAt: Date;
    updatedAt: Date;
    repos: string[];
  }>;
}

interface PrismaLike {
  agent: PrismaAgentLike;
  agentEnv: {
    findMany(args: {
      where: { agentId: string };
      select: { key: true; value: true; secret: true };
    }): Promise<{ key: string; value: string; secret: boolean }[]>;
  };
  agentPlugin: {
    findMany(args: { where: { agentId: string; enabled: boolean } }): Promise<
      Array<{
        id: string;
        name: string;
        version: string | null;
        enabled: boolean;
      }>
    >;
  };
  agentMember: {
    findMany(args: {
      where: { email?: string; agentId?: string };
    }): Promise<
      Array<{ id: string; agentId: string; email: string; createdAt: Date }>
    >;
    findUnique(args: {
      where: { agentId_email: { agentId: string; email: string } };
    }): Promise<{ id: string; agentId: string; email: string } | null>;
    create(args: {
      data: { agentId: string; email: string };
    }): Promise<{ id: string; agentId: string; email: string }>;
    deleteMany(args: { where: { id: string; agentId: string } }): Promise<{
      count: number;
    }>;
  };
}

export interface AdminUIDeps {
  prisma: PrismaLike;
  agentEnvService: Pick<
    AgentEnvService,
    "getByAgentId" | "upsert" | "patch" | "deleteKey" | "getConfigBundle"
  >;
  agentCronJobService: Pick<
    AgentCronJobService,
    | "list"
    | "listWithRunSummary"
    | "create"
    | "update"
    | "setEnabled"
    | "delete"
    | "get"
    | "reconcileSystemCrons"
  >;
  /**
   * Optional extension card slots (AEP-2.1, admin-extension.ts) rendered on
   * the agent detail page at each slot's placement (header or Configuration
   * group); absent renders none.
   */
  agentDetailCards?: readonly AgentDetailCardSlot[];
  /**
   * True when an extension mounts /admin/agents/:id/queue-activity (the coding
   * extension, AEP-3.6); the agents list and agent detail render their Queue &
   * Activity / Logs links only then. Absent renders none.
   */
  queueActivityLinks?: boolean;
  agentToolService: Pick<
    AgentToolService,
    "list" | "add" | "toggle" | "remove"
  >;
  agentTokenService: Pick<
    AgentTokenService,
    "listForAgent" | "create" | "revoke"
  >;
  agentPluginService: Pick<AgentPluginService, "list" | "add">;
  agentMemberService: Pick<
    AgentMemberService,
    "listByEmail" | "exists" | "add" | "remove" | "listByAgentId"
  >;
  /**
   * Account-aware caller-scope resolver (SSP-2.1). Defaults to the
   * AgentMember-only resolver, i.e. today's behavior with the flag off.
   */
  callerScopeResolver?: CallerScopeResolver;
  /**
   * Account lookups for the new-agent form's remaining-quota display
   * (SSP-4.2). Absent → the quota line is omitted.
   */
  accountService?: Pick<
    AccountService,
    "getById" | "countAgents" | "listAgentIds"
  >;
  agentService: Pick<
    AgentService,
    | "listAll"
    | "listByIds"
    | "searchByName"
    | "listOptions"
    | "create"
    | "delete"
    | "getDetail"
    | "updateFields"
  > & {
    /**
     * Runs a function inside a single interactive Prisma transaction — see
     * AgentService.runTransaction(). Optional here (unlike the rest of this
     * Pick) so the many existing test doubles for routes that never touch
     * agent creation don't all need to implement it: POST /admin/agents
     * (the only caller, via createAgent() in agents.ts) falls back to a
     * non-transactional passthrough when it's absent. Every production
     * wiring (main.ts) always supplies the real AgentService method.
     */
    runTransaction?: AgentService["runTransaction"];
  };
  provisioner: AgentProvisioner;
  /** WIF-2.1: Anthropic federation is enabled; defaults to false. */
  anthropicFederationEnabled?: boolean;
  /**
   * Resolves an agent's typeName to its parsed Agent Type manifest and lists
   * the registry's discoverable types (for the new-agent type picker).
   * Defaults to a disk-backed AgentTypeRegistry, matching the DI pattern
   * already used by agents-api.ts's AdminDeps.
   */
  agentTypeRegistry?: AgentTypeManifestResolver;
  /**
   * Cleanup deps for the full delete-agent orchestration (POST
   * /admin/agents/:id/delete → deleteAgentFully()). Matches
   * DeleteAgentFullyDeps's shapes exactly, mirroring agents-api.ts's AdminDeps
   * so both delete entry points share the same production wiring in main.ts.
   */
  serviceIntegrations: DeleteAgentFullyDeps["serviceIntegrations"];
  chatService: DeleteAgentFullyDeps["chatService"];
  slack: DeleteAgentFullyDeps["slack"];
  decrypt: DeleteAgentFullyDeps["decrypt"];
  sessionSecret: string;
  googleClient: GoogleAuthClient;
  googleClientId: string;
  googleClientSecret: string;
  /**
   * Okta OIDC client for GET /admin/auth/okta and GET /admin/auth/okta/callback.
   * Optional — when oktaClientId/oktaIssuer are unset (or oktaClient is absent),
   * both Okta routes redirect to /admin/login?error=server_error without
   * attempting any external call, mirroring Google's own missing-config guard.
   */
  oktaClient?: OktaAuthClient;
  oktaClientId?: string;
  oktaClientSecret?: string;
  oktaIssuer?: string;
  adminAllowedEmails: string[];
  slackClient: AdminUISlackClient;
  /**
   * GitHub App manifest-flow provisioning client, used by the auto-provision
   * sub-flow under ghAuthMode=app: GET /admin/provision/github-app/complete
   * exchanges the manifest-flow code via exchangeManifestCode().
   */
  githubAppClient: AdminUIGithubAppClient;
  appBaseUrl: string;
  /** Enable the /admin/dev-login route. Hard-blocked in production regardless of this value. */
  devAuthEnabled?: boolean;
  /** Resolved self-serve provisioning config (SSP-1.3). */
  selfServe?: SelfServeConfig;
  /**
   * First-login account provisioning (SSP-3.1). Consulted by the Google
   * callback only, and only when selfServe.enabled; absent → no auto-create.
   */
  accountOnboarding?: Pick<AccountOnboardingService, "provisionForEmail">;
  /** Best-effort operator push on auto-created accounts (SSP-3.3). */
  accountCreatedNotifier?: AccountCreatedNotifier;
  /**
   * Account page + nav services (SSP-3.2). Used only when selfServe.enabled;
   * absent → no /admin/account routes content, no nav entry, no quota notice.
   */
  accountServices?: {
    accounts: Pick<
      AccountService,
      | "getByMemberEmail"
      | "update"
      | "countAgents"
      | "listWithCounts"
      | "getWithCounts"
      | "listAgents"
    >;
    members: Pick<
      AccountMemberService,
      "listByAccount" | "getByEmail" | "add" | "remove" | "promote" | "demote"
    >;
    invites: Pick<AccountInviteService, "create" | "listPending" | "revoke">;
    /** SSP-8.2: admin account edits + suspend/reactivate side effects. */
    lifecycle: Pick<AccountLifecycle, "update">;
  };
  /**
   * IANA timezone name for date/time display in the admin UI.
   * Defaults to "America/Los_Angeles" when absent.
   */
  timezone?: string;
  /**
   * Extra `?error=` codes (code → message) an extension's routes redirect to
   * the agent detail page with — merged over the platform's own codes.
   */
  agentDetailErrorMessages?: Record<string, string>;
  /**
   * Chat service client for the /admin/chat routes.
   * When absent, all chat routes render in degraded mode (notice, no table/messages).
   */
  chatClient?: ChatClient;
  /**
   * Base directory the PWA shell's icon route reads committed PNGs from.
   * Injectable for tests; defaults to the committed admin/pwa-assets/icons
   * dir (see admin/src/pwa.ts's PWA_ASSETS_DIR, populated by the
   * one-time/on-demand scripts/build-pwa-icons.ts).
   */
  pwaAssetsDir?: string;
  /**
   * App version string interpolated into the service worker's cache name
   * (see admin/src/pwa.ts's buildServiceWorkerBody) so a version bump busts
   * any previously installed cache. Read once from version.txt at startup —
   * matches the "inject time via a Clock" isolation convention rather than
   * reading the file inside the route handler.
   */
  appVersion?: string;
  /**
   * Web Push (CFB-4.2). All three are set together or none: main.ts only wires
   * them when isPushEnabled() is true (public + private + subject all set), so
   * when push is not fully configured pushService is undefined, the routes 503,
   * and the toggle renders "" (page degrades to the CFB-3.2 page).
   */
  pushService?: PushService;
  /** VAPID PUBLIC key — sent to the browser (NOT a secret). "" disables the toggle. */
  vapidPublicKey?: string;
  /** Shared token the chat service presents to the push-notify webhook. */
  pushWebhookToken?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "admin_session";
const OAUTH_STATE_COOKIE = "oauth_state";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours
const OAUTH_STATE_TTL_SECONDS = 600; // 10 min

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function createSessionToken(
  secret: string,
  userId: string,
  email: string,
  isAdmin: boolean,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      userId,
      email,
      isAdmin,
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    },
    secret,
    "HS256",
  );
}

async function getSessionUser(
  token: string,
  secret: string,
): Promise<{ email: string; isAdmin: boolean } | null> {
  try {
    const payload = (await verify(token, secret, "HS256")) as Record<
      string,
      unknown
    >;
    if (
      typeof payload.userId === "string" &&
      payload.userId.length > 0 &&
      typeof payload.email === "string" &&
      payload.email.length > 0
    ) {
      return { email: payload.email, isAdmin: payload.isAdmin === true };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

export function createUIAuthMiddleware(
  sessionSecret: string,
): MiddlewareHandler<AdminUIEnv> {
  return async (c, next) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    const user = sessionToken
      ? await getSessionUser(sessionToken, sessionSecret)
      : null;
    if (!user) {
      return c.redirect("/admin/login", 302);
    }
    c.set("userEmail", user.email);
    c.set("isAdmin", user.isAdmin);
    return next();
  };
}

// ─── Back-link validation ───────────────────────────────────────────────────

// Shared allowlist resolver: a `from` query param is only honored as a back
// link when it matches the given same-origin pattern. Rejects protocol-relative
// (//evil.com), absolute (https://evil.com), javascript:, and any other-path
// values — those fall back to the given default so a "← X" anchor can never be
// used as an open-redirect/phishing hop off the admin domain.
export function resolveBackHref(
  fromParam: string | undefined,
  pattern: RegExp,
  fallback: string,
): string {
  if (fromParam && pattern.test(fromParam)) {
    return fromParam;
  }
  return fallback;
}

/**
 * Redirects to the agent detail page, appending the zero-members warning
 * query param when restrictSlackToMembers was just enabled on an agent with
 * no AgentMember rows. Non-blocking — the caller's save already succeeded;
 * this only decides which redirect target to use.
 */
async function redirectWithMembersWarning(
  c: Context<AdminUIEnv>,
  agentMemberService: Pick<AgentMemberService, "listByAgentId">,
  agentId: string,
  restrictSlackToMembers: boolean,
) {
  if (restrictSlackToMembers) {
    const members = await agentMemberService.listByAgentId(agentId);
    if (members.length === 0) {
      return c.redirect(
        `/admin/agents/${agentId}?warning=restrict_slack_no_members`,
        302,
      );
    }
  }
  return c.redirect(`/admin/agents/${agentId}`, 302);
}

// ─── HTML helper ──────────────────────────────────────────────────────────────

/** Renders an admin page body as an HTML Response (see createHtmlResponder). */
export type AdminHtmlResponder = (
  content: string,
  opts?: { includePwaTags?: boolean; status?: number },
) => Response;

/**
 * The admin UI's HTML response helper, shared by the platform UI and extension
 * UIs (AEP-3.2) so every admin page gets the same head tags and headers.
 */
export function createHtmlResponder(appBaseUrl: string): AdminHtmlResponder {
  // Precomputed once per app instance (not per-request): the manifest link +
  // SW-registration script, gated on appBaseUrl being https (see
  // admin/src/pwa.ts's renderPwaHeadTags — "" when the gate fails, e.g. a
  // home-lab operator on plain HTTP).
  const pwaHeadTags = renderPwaHeadTags(appBaseUrl);

  /**
   * Splices the PWA head tags in just before </head> so every rendered
   * admin page gets the manifest link + SW registration site-wide, without
   * threading appBaseUrl through every render*Page function. A no-op when
   * pwaHeadTags is "" (non-https appBaseUrl).
   */
  function injectPwaHeadTags(content: string): string {
    if (!pwaHeadTags) return content;
    return content.replace("</head>", `  ${pwaHeadTags}\n</head>`);
  }

  /**
   * `includePwaTags` defaults to true for every /admin/* page. The opt-out is
   * for an extension's unauthenticated pages outside /admin/ — the manifest's
   * scope is /admin/, and such a page must never reference /admin/ URLs.
   */
  return (content, opts) => {
    const body =
      opts?.includePwaTags === false ? content : injectPwaHeadTags(content);
    return new Response(body, {
      status: opts?.status ?? 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // CSP is out of scope (would need unsafe-inline today and buys
        // nothing here) — these three are the low-risk, high-value headers
        // for a server-rendered admin console.
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
      },
    });
  };
}

// ─── Agent access ─────────────────────────────────────────────────────────────

/**
 * Agent access checks shared by the platform UI and extension UIs (AEP-3.2).
 * resolveAccessibleAgents: admins see the full fleet, non-admins only the
 * agents in their caller scope (no ordering beyond what listAll()/listByIds()
 * return). assertAgentAccess: admins always, others when the agent is in scope.
 */
export function createAgentAccessChecks(deps: {
  agentService: Pick<AgentService, "listAll" | "listByIds">;
  callerScopeResolver: CallerScopeResolver;
}) {
  const { agentService, callerScopeResolver } = deps;
  return {
    async resolveAccessibleAgents(
      userEmail: string,
      isAdmin: boolean,
    ): Promise<Awaited<ReturnType<AgentService["listAll"]>>> {
      if (isAdmin) {
        return agentService.listAll();
      }
      const scope = await callerScopeResolver(userEmail, false);
      return agentService.listByIds(scope.kind === "all" ? [] : scope.agentIds);
    },
    async assertAgentAccess(
      agentId: string,
      userEmail: string,
      isAdmin: boolean,
    ): Promise<boolean> {
      if (isAdmin) return true;
      return scopeIncludesAgent(
        await callerScopeResolver(userEmail, false),
        agentId,
      );
    },
  };
}

// ─── App factory ──────────────────────────────────────────────────────────────

export function createAdminUIApp(deps: AdminUIDeps): Hono<AdminUIEnv> {
  const {
    prisma,
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    agentMemberService,
    agentService,
    provisioner,
    selfServe,
    accountService,
    accountOnboarding,
    accountCreatedNotifier,
    accountServices,
    agentTypeRegistry = new AgentTypeRegistry(),
    callerScopeResolver = memberOnlyCallerScopeResolver(agentMemberService),
    serviceIntegrations,
    chatService,
    slack,
    decrypt,
    sessionSecret,
    googleClient,
    googleClientId,
    googleClientSecret,
    oktaClient,
    oktaClientId = "",
    oktaClientSecret = "",
    oktaIssuer = "",
    adminAllowedEmails,
    slackClient,
    githubAppClient,
    appBaseUrl,
    devAuthEnabled = false,
    timezone = "America/Los_Angeles",
    chatClient,
    pwaAssetsDir = PWA_ASSETS_DIR,
    appVersion = "0.0.0",
    pushService,
    vapidPublicKey = "",
    pushWebhookToken,
  } = deps;

  // Push is enabled only when the service was constructed (VAPID fully set) AND
  // a public key is available for the browser. A single derived flag so the
  // toggle-render gate and the route-503 gate can't drift.
  const pushEnabled = Boolean(pushService && vapidPublicKey);

  const app = new Hono<AdminUIEnv>();

  const requireAuth = createUIAuthMiddleware(sessionSecret);

  // SSP-3.2: show the toolbar's "Account" entry only for signed-in users who
  // belong to an account, and only while self-serve is on. The flag is carried
  // in AsyncLocalStorage so renderAdminToolbar() needs no extra parameter.
  const accountNavEnabled = Boolean(selfServe?.enabled && accountServices);
  if (accountNavEnabled && accountServices) {
    app.use("/admin/*", async (c, next) => {
      const token = getCookie(c, SESSION_COOKIE);
      const user = token ? await getSessionUser(token, sessionSecret) : null;
      let showAccount = false;
      if (user) {
        try {
          showAccount =
            (await accountServices.accounts.getByMemberEmail(user.email)) !==
            null;
        } catch {
          // nav is cosmetic — never fail the page over the lookup
        }
      }
      return runWithAccountNav(showAccount, () => next());
    });
  }

  // Extracted Slack app-manifest-creation/OAuth/app-token orchestration
  // (UAP-1.1) — shared by the legacy /admin/provision/* wizard's Slack
  // branch and the new per-agent /admin/agents/:id/connect-slack routes so
  // both reach the same outcome via the same code path.
  const slackProvisioningService = new SlackProvisioningService({
    slackClient,
    agentService,
    agentEnvService,
    agentCronJobService,
    sessionSecret,
    appBaseUrl,
    secretEnvVars: new Set(SECRET_ENV_VARS),
  });

  // Extracted GitHub App manifest-flow/PAT provisioning orchestration
  // (UAP-1.2) — shared by the legacy /admin/provision/* wizard's GitHub
  // branches (+ github-app/complete + github-app/installed) and the new
  // per-agent /admin/agents/:id/connect-github routes so both reach the same
  // outcome via the same code path.
  const githubProvisioningService = new GithubProvisioningService({
    githubAppClient,
    agentService,
    agentEnvService,
    agentCronJobService,
    sessionSecret,
    appBaseUrl,
    secretEnvVars: new Set(SECRET_ENV_VARS),
  });

  const html = createHtmlResponder(appBaseUrl);

  // ─── Login / OAuth / Logout ───────────────────────────────────────────────

  /**
   * Shared post-authentication step for every OAuth provider (Google, Okta):
   * checks the verified-email + admin-allowlist/AgentMember-fallback rules,
   * mints the session JWT, sets the session cookie, and redirects to
   * `returnTo` (or the default landing page). Each provider's callback route
   * normalizes its own userinfo shape into this common `{sub, email,
   * email_verified}` input before calling in — callers never see a
   * provider-specific type here.
   *
   * Returns a Response in every case (a redirect or a 403), matching each
   * inline early-return the Google callback used before this was extracted.
   */
  async function completeLogin(
    // biome-ignore lint/suspicious/noExplicitAny: matches each OAuth callback route's own path-string literal type; the path itself is irrelevant here.
    c: Context<AdminUIEnv, any>,
    userInfo: { sub: string; email?: string; email_verified?: boolean },
    returnTo: string | undefined,
    opts: { selfServeSignup?: boolean } = {},
  ): Promise<Response> {
    if (!userInfo.email) {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    if (!userInfo.email_verified) {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Check admin allowlist first, then fall back to member access
    const isAdmin = adminAllowedEmails
      .map((e) => e.toLowerCase())
      .includes(userInfo.email.toLowerCase());

    if (!isAdmin) {
      const memberships = await agentMemberService.listByEmail(
        userInfo.email.toLowerCase(),
      );
      if (memberships.length === 0) {
        // Self-serve (SSP-3.1): a verified Google email with no AgentMember
        // rows joins its invited account or gets a new one. Okta and flag-off
        // keep the existing 403.
        const onboarding = accountOnboarding;
        if (!(opts.selfServeSignup && selfServe?.enabled && onboarding)) {
          return new Response("Forbidden", { status: 403 });
        }
        const email = userInfo.email.toLowerCase();
        let result: Awaited<ReturnType<typeof onboarding.provisionForEmail>>;
        try {
          result = await onboarding.provisionForEmail(email);
        } catch (err) {
          console.error("[admin] self-serve account provisioning failed", err);
          return c.redirect("/admin/login?error=server_error", 302);
        }
        if (result.kind !== "existing") {
          console.log(
            JSON.stringify({
              event: `account_${result.kind}`,
              accountId: result.accountId,
              emailDomain: email.slice(email.lastIndexOf("@") + 1),
            }),
          );
        }
        // Only a brand-new account notifies; invite-joins do not.
        if (result.kind === "created") {
          fireAccountCreatedNotification(accountCreatedNotifier, {
            accountId: result.accountId,
            emailDomain: email.slice(email.lastIndexOf("@") + 1),
          });
        }
      }
    }

    // Create session
    const token = await createSessionToken(
      sessionSecret,
      userInfo.sub,
      userInfo.email,
      isAdmin,
    );
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: appBaseUrl.startsWith("https://"),
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
    });
    // Redirect to returnTo if it's a valid same-origin relative path, otherwise default.
    const destination =
      returnTo?.startsWith("/") && !returnTo.startsWith("//")
        ? returnTo
        : "/admin/agents";
    return c.redirect(destination, 302);
  }

  /**
   * Shared OAuth-start step for every provider (Google, Okta): mints a CSRF
   * nonce, validates `returnTo` as a same-origin relative path (dropping
   * malformed/absolute values), and stores both in the oauth_state cookie.
   */
  function beginOAuthFlow(
    // biome-ignore lint/suspicious/noExplicitAny: matches each OAuth start route's own path-string literal type; the path itself is irrelevant here.
    c: Context<AdminUIEnv, any>,
  ): { nonce: string; returnTo: string | undefined } {
    const nonce = crypto.randomUUID();

    const rawReturnTo = c.req.query("returnTo");
    const returnTo =
      rawReturnTo?.startsWith("/") && !rawReturnTo.startsWith("//")
        ? rawReturnTo
        : undefined;

    const oauthState = JSON.stringify({ nonce, returnTo });
    setCookie(c, OAUTH_STATE_COOKIE, oauthState, {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: OAUTH_STATE_TTL_SECONDS,
      path: "/admin/auth",
    });

    return { nonce, returnTo };
  }

  /**
   * Shared OAuth-callback CSRF check for every provider: reads + clears the
   * oauth_state cookie, and confirms its nonce matches the `state` query
   * param. Returns the carried `returnTo` on success, or `null` if the
   * cookie is missing/malformed or the nonce doesn't match.
   */
  function validateOAuthState(
    // biome-ignore lint/suspicious/noExplicitAny: matches each OAuth callback route's own path-string literal type; the path itself is irrelevant here.
    c: Context<AdminUIEnv, any>,
    state: string | undefined,
  ): { returnTo: string | undefined } | null {
    const storedStateCookie = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/admin/auth" });

    let storedNonce: string | undefined;
    let returnTo: string | undefined;
    try {
      if (storedStateCookie) {
        const parsed = JSON.parse(storedStateCookie) as {
          nonce?: string;
          returnTo?: string;
        };
        storedNonce = parsed.nonce;
        returnTo = parsed.returnTo;
      }
    } catch {
      // Malformed cookie — treat as missing
    }

    if (!storedNonce || !state || storedNonce !== state) {
      return null;
    }
    return { returnTo };
  }

  // ─── PWA shell (manifest, service worker, icons, offline page) ───────────
  //
  // Deliberately unauthenticated (no requireAuth) — this is required, not a
  // shortcut. Browsers fetch the manifest and service worker with
  // credentials:omit, so gating either behind the session cookie would 302
  // to /admin/login and silently break install. Neither route leaks
  // secrets: the manifest is static config, and the SW's own caching
  // predicate (admin/src/pwa.ts) refuses every authenticated document/JSON
  // route by construction.

  app.get("/admin/manifest.webmanifest", (c) => {
    // PWA-1.1: renderPwaHeadTags rewrites the manifest link's href with
    // ?start=<current pathname> on every page, so "Add to Home Screen"
    // installs a shortcut back into whichever page the user was on.
    // sanitizeStartUrl always returns a safe value (defaulting to
    // /admin/chat), so this is safe to call unconditionally even when the
    // query param is absent, malformed, or malicious.
    const startUrl = sanitizeStartUrl(c.req.query("start"));
    return c.json(buildManifest(startUrl), 200, {
      "Content-Type": "application/manifest+json",
    });
  });

  app.get("/admin/sw.js", (_c) => {
    const body = buildServiceWorkerBody(appVersion, getPrecacheList());
    return new Response(body, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        // A cached service worker is unupdatable — browsers must always
        // revalidate this file so a version bump's new cache name (and any
        // precache-list change) actually takes effect.
        "Cache-Control": "no-cache",
      },
    });
  });

  app.get("/admin/offline.html", (_c) => {
    return new Response(buildOfflinePageHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  const PWA_ICON_FILENAMES = new Set(PWA_ICONS.map((icon) => icon.filename));

  app.get("/admin/icons/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!PWA_ICON_FILENAMES.has(filename)) {
      return c.json({ error: "Not found" }, 404);
    }
    try {
      const body = await Bun.file(
        join(pwaAssetsDir, "icons", filename),
      ).arrayBuffer();
      return new Response(body, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "Not found" }, 404);
      }
      console.error(`[admin-ui] PWA icon read error [${filename}]:`, err);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  app.get("/admin/login", (c) => {
    const error = c.req.query("error") ?? undefined;
    const returnTo = c.req.query("returnTo") ?? undefined;
    const googleEnabled = Boolean(googleClientId && googleClientSecret);
    const oktaEnabled = Boolean(oktaClientId && oktaIssuer && oktaClient);
    return html(
      renderLoginPage({ error, returnTo, googleEnabled, oktaEnabled }),
    );
  });

  app.get("/admin/auth/google", (c) => {
    if (!googleClientId) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    const { nonce } = beginOAuthFlow(c);

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: `${appBaseUrl}/admin/auth/callback`,
      response_type: "code",
      scope: "openid profile email",
      state: nonce,
      prompt: "select_account",
    });

    return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
  });

  app.get("/admin/auth/callback", async (c) => {
    const { code, state, error: googleError } = c.req.query();

    // Google returned an error (e.g. access_denied)
    if (googleError) {
      const slug =
        googleError === "access_denied" ? "access_denied" : "auth_failed";
      return c.redirect(`/admin/login?error=${slug}`, 302);
    }

    // CSRF: validate state nonce. The oauth_state cookie is JSON: {nonce, returnTo?}.
    const validated = validateOAuthState(c, state);
    if (!validated) {
      return c.redirect("/admin/login?error=invalid_state", 302);
    }
    const { returnTo } = validated;

    if (!googleClientId || !googleClientSecret) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    if (!code) {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Exchange authorization code for tokens
    let accessToken: string;
    try {
      const tokens = await googleClient.exchangeCode({
        code,
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        redirectUri: `${appBaseUrl}/admin/auth/callback`,
      });
      accessToken = tokens.accessToken;
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Fetch user info from Google
    let userInfo: {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name: string;
    };
    try {
      userInfo = await googleClient.getUserInfo(accessToken);
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    return completeLogin(c, userInfo, returnTo, { selfServeSignup: true });
  });

  app.get("/admin/auth/okta", (c) => {
    if (!oktaClientId || !oktaIssuer || !oktaClient) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    const { nonce } = beginOAuthFlow(c);

    const authUrl = oktaClient.getAuthorizationUrl({
      clientId: oktaClientId,
      redirectUri: `${appBaseUrl}/admin/auth/okta/callback`,
      state: nonce,
      scope: "openid profile email",
    });

    return c.redirect(authUrl, 302);
  });

  app.get("/admin/auth/okta/callback", async (c) => {
    const { code, state, error: oktaError } = c.req.query();

    // Okta returned an error (e.g. access_denied)
    if (oktaError) {
      const slug =
        oktaError === "access_denied" ? "access_denied" : "auth_failed";
      return c.redirect(`/admin/login?error=${slug}`, 302);
    }

    // CSRF: validate state nonce. The oauth_state cookie is JSON: {nonce, returnTo?}.
    const validated = validateOAuthState(c, state);
    if (!validated) {
      return c.redirect("/admin/login?error=invalid_state", 302);
    }
    const { returnTo } = validated;

    if (!oktaClientId || !oktaClientSecret || !oktaIssuer || !oktaClient) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    if (!code) {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Exchange authorization code for tokens
    let accessToken: string;
    try {
      const tokens = await oktaClient.exchangeCode({
        code,
        clientId: oktaClientId,
        clientSecret: oktaClientSecret,
        redirectUri: `${appBaseUrl}/admin/auth/okta/callback`,
      });
      accessToken = tokens.accessToken;
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Fetch user info from Okta
    let userInfo: {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name: string;
      picture?: string;
    };
    try {
      userInfo = await oktaClient.getUserInfo(accessToken);
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    return completeLogin(c, userInfo, returnTo);
  });

  app.post("/admin/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/admin/login", 302);
  });

  // ─── Dev auto-login (non-prod only) ──────────────────────────────────────

  app.get("/admin/dev-login", async (c) => {
    // Hard-blocked: devAuthEnabled must be true AND we must not be in production.
    // The devAuthEnabled flag is pre-computed from isDevAuthAllowed() at startup;
    // this route simply trusts the injected value.
    if (!devAuthEnabled) {
      return new Response("Not Found", { status: 404 });
    }
    const token = await createSessionToken(
      sessionSecret,
      "dev",
      "dev@localhost",
      true,
    );
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: appBaseUrl.startsWith("https://"),
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
    });
    return c.redirect("/admin/agents", 302);
  });

  // ─── Agents list ──────────────────────────────────────────────────────────

  // Access-scoping for the agents list (and extension views via the same
  // createAgentAccessChecks helper).
  const { resolveAccessibleAgents, assertAgentAccess } =
    createAgentAccessChecks({ agentService, callerScopeResolver });

  app.get("/admin/agents", requireAuth, async (c) => {
    const agents = await resolveAccessibleAgents(
      c.var.userEmail,
      c.var.isAdmin,
    );
    const successMsg =
      c.req.query("success") === "deleted" ? "Agent deleted." : undefined;
    // Surfaced by POST /admin/agents/:id/delete after a successful
    // deleteAgentFully() call — operator-facing reminders that would
    // otherwise be silently dropped on the redirect to this list.
    const manualStepsRaw = c.req.query("manualSteps");
    let manualSteps: ManualStep[] | undefined;
    if (manualStepsRaw) {
      try {
        const parsed = JSON.parse(manualStepsRaw);
        if (Array.isArray(parsed)) manualSteps = parsed;
      } catch {
        // malformed/tampered query param — render without the panel
      }
    }
    // SSP-3.2: a zero-quota account sees a request-a-trial message and a
    // disabled create button instead of the create CTA.
    let zeroQuotaContactEmail: string | undefined;
    if (accountNavEnabled && accountServices && selfServe) {
      const account = await accountServices.accounts.getByMemberEmail(
        c.var.userEmail,
      );
      if (account && account.maxAgents === 0) {
        zeroQuotaContactEmail = selfServe.contactEmail;
      }
    }
    // SSP-5.2: admins get an Account column (flag on only).
    let accountNames: Map<string, string> | undefined;
    if (c.var.isAdmin && accountNavEnabled && accountServices) {
      accountNames = new Map(
        (await accountServices.accounts.listWithCounts()).map((a) => [
          a.id,
          a.name,
        ]),
      );
    }
    return html(
      renderAgentsPage(agents, c.var.userEmail, c.var.isAdmin, timezone, {
        accountNames,
        queueActivityLinks: deps.queueActivityLinks,
        successMsg,
        manualSteps,
        zeroQuotaNotice: zeroQuotaContactEmail
          ? renderZeroQuotaNotice(zeroQuotaContactEmail)
          : undefined,
      }),
    );
  });

  // ─── Agent detail ─────────────────────────────────────────────────────────

  /**
   * SSP-4.3: with self-serve on, anyone who passes assertAgentAccess for an
   * agent (owner or member) fully controls it — settings, members, delete.
   * Flag off: admin-only, so existing platform AgentMembers gain no power.
   */
  const canManageAgents = (isAdmin: boolean): boolean =>
    isAdmin || deps.selfServe?.enabled === true;

  async function assertCanManageAgent(
    agentId: string,
    userEmail: string,
    isAdmin: boolean,
  ): Promise<boolean> {
    if (isAdmin) return true;
    if (!canManageAgents(false)) return false;
    return assertAgentAccess(agentId, userEmail, false);
  }

  const ERROR_MESSAGES: Record<string, string> = {
    missing_fields: "Required fields are missing.",
    create_failed: "Failed to create — please try again.",
    invalid_schedule: "Invalid cron schedule expression.",
    invalid_target:
      "Invalid delivery target — set channel or user (or enable silent mode).",
    invalid_repo_format:
      "Repo must be in org/repo format (e.g. my-org/my-repo).",
    invalid_author_allowlist_format:
      "Author allowlist entries must be valid GitHub logins.",
    invalid_type: "Select a valid agent type.",
    provisioning_disabled:
      "In-cluster provisioning is not enabled on this admin service — create a self-hosted agent instead.",
    provision_failed:
      "Failed to provision the agent's cluster resources — the agent was not created.",
    quota_exceeded: "This account has reached its agent limit.",
    account_inactive: "This account is not active.",
    ...deps.agentDetailErrorMessages,
  };

  // ─── New agent form (MUST be before /:id to avoid "new" being captured as param)

  // Account the caller may create agents in (SSP-4.2): null for platform
  // admins (unassigned agents, today's behavior) and for non-admins without an
  // account (flag off / no membership) — the latter are denied by the callers.
  async function resolveCreateAccountId(
    userEmail: string,
    isAdmin: boolean,
  ): Promise<string | null> {
    if (isAdmin) return null;
    return accountIdFromScope(await callerScopeResolver(userEmail, false));
  }

  app.get("/admin/agents/new", requireAuth, async (c) => {
    const accountId = await resolveCreateAccountId(
      c.var.userEmail,
      c.var.isAdmin,
    );
    if (!c.var.isAdmin && accountId === null) {
      return new Response("Forbidden", { status: 403 });
    }
    let selfServeOpts:
      | { remaining: number; max: number; contactEmail: string }
      | undefined;
    if (accountId !== null && accountService) {
      const [account, count] = await Promise.all([
        accountService.getById(accountId),
        accountService.countAgents(accountId),
      ]);
      selfServeOpts = {
        remaining: Math.max(0, (account?.maxAgents ?? 0) - count),
        max: account?.maxAgents ?? 0,
        contactEmail:
          selfServe?.contactEmail ?? DEFAULT_SELF_SERVE_CONTACT_EMAIL,
      };
    }
    const rawError = c.req.query("error") ?? undefined;
    const error = rawError ? (ERROR_MESSAGES[rawError] ?? rawError) : undefined;
    const types = agentTypeRegistry.listTypes();
    return html(
      renderNewLocalAgentPage(c.var.userEmail, types, {
        error,
        canProvision: provisioner.canProvision,
        anthropicFederationEnabled: deps.anthropicFederationEnabled,
        ...(selfServeOpts ? { selfServe: selfServeOpts } : {}),
      }),
    );
  });

  // ─── Create agent (self-hosted or provisioned in-cluster) ────────────────

  app.post("/admin/agents", requireAuth, async (c) => {
    const accountId = await resolveCreateAccountId(
      c.var.userEmail,
      c.var.isAdmin,
    );
    if (!c.var.isAdmin && accountId === null) {
      return new Response("Forbidden", { status: 403 });
    }
    let name: string | undefined;
    let typeName: string | undefined;
    let reposRaw: string | undefined;
    let authorAllowlistRaw: string | undefined;
    let patchAuthorAllowlistRaw: string | undefined;
    let memberEmailsRaw: string | undefined;
    let restrictSlackToMembersRaw: string | undefined;
    let runtime: string | undefined;
    let claudeCodeOauthToken: string | undefined;
    let anthropicApiKey: string | undefined;
    let connectSlackRaw: string | undefined;
    let xoxpToken: string | undefined;
    let ghAuthMode: string | undefined;
    let ghPat: string | undefined;
    let githubOrg: string | undefined;
    let ghAppMode: string | undefined;
    let ghAppId: string | undefined;
    let ghAppInstallationId: string | undefined;
    let ghAppPrivateKey: string | undefined;
    try {
      const formData = await c.req.formData();
      name = formData.get("name")?.toString()?.trim();
      typeName = formData.get("type")?.toString()?.trim();
      reposRaw = formData.get("repos")?.toString()?.trim();
      authorAllowlistRaw = formData.get("authorAllowlist")?.toString()?.trim();
      patchAuthorAllowlistRaw = formData
        .get("patchAuthorAllowlist")
        ?.toString()
        ?.trim();
      memberEmailsRaw = formData.get("memberEmails")?.toString()?.trim();
      restrictSlackToMembersRaw = formData
        .get("restrictSlackToMembers")
        ?.toString();
      runtime = formData.get("runtime")?.toString()?.trim();
      claudeCodeOauthToken = formData
        .get("claudeCodeOauthToken")
        ?.toString()
        ?.trim();
      anthropicApiKey = formData.get("anthropicApiKey")?.toString()?.trim();
      connectSlackRaw = formData.get("connectSlack")?.toString();
      xoxpToken = formData.get("xoxpToken")?.toString();
      ghAuthMode = formData.get("ghAuthMode")?.toString()?.trim();
      ghPat = formData.get("ghPat")?.toString();
      githubOrg = formData.get("githubOrg")?.toString()?.trim();
      ghAppMode = formData.get("ghAppMode")?.toString()?.trim();
      ghAppId = formData.get("ghAppId")?.toString();
      ghAppInstallationId = formData.get("ghAppInstallationId")?.toString();
      // UAP-5.3: the "Use existing GitHub App" option submits the private
      // key as a file upload rather than pasted text — read its contents
      // server-side, mirroring the per-agent connect-github route.
      const ghAppPrivateKeyFile = formData.get("ghAppPrivateKeyFile");
      ghAppPrivateKey =
        ghAppPrivateKeyFile instanceof File
          ? await ghAppPrivateKeyFile.text()
          : undefined;
    } catch {
      return c.redirect("/admin/agents/new", 302);
    }
    const connectSlack = connectSlackRaw === "true";
    // SSP-4.2: account users always create "coding" agents in their own
    // account — any submitted type/accountId is ignored.
    if (accountId !== null) typeName = getSelfServeAgentType();
    // Absent/unrecognized runtime means self-hosted — the historical behavior
    // of this form. createAgent() below re-derives this same value itself
    // (it owns the runtime/provisioning validation); it's recomputed here
    // too only to gate the UAP-2.1 Slack/GitHub connect block further down,
    // which runs after createAgent() returns and has no other way to learn
    // whether this agent is in-cluster.
    const inCluster = runtime === "in-cluster";

    // APA-1.1: the entire create-agent sequence (validate name/typeName,
    // create the Agent row, seed AgentTool/AgentPlugin from the type
    // manifest, attach repos/allowlists/members, patch Claude credentials,
    // provision Kubernetes when requested, best-effort reconcile system
    // crons) lives in createAgent() (agents.ts) as the single implementation
    // of agent creation. Every failure mode redirects to the same
    // `/admin/agents/new?error=<code>` shape the inline handler used to
    // build itself, so `result.errorCode` maps directly into the query
    // param.
    const result = await createAgent(
      {
        // Bind each method createAgent() needs (CreateAgentDeps.agentService
        // = create | delete | updateFields | runTransaction) explicitly
        // rather than spreading `agentService`: in production this is a real
        // `new AgentService(prisma)` whose methods live on
        // AgentService.prototype, and object spread copies only own
        // enumerable properties — a spread would silently drop
        // create/delete/updateFields and throw at the first call.
        agentService: {
          create: agentService.create.bind(agentService),
          delete: agentService.delete.bind(agentService),
          updateFields: agentService.updateFields.bind(agentService),
          // Test doubles for routes unrelated to agent creation don't
          // implement runTransaction (see AdminUIDeps.agentService above) —
          // fall back to a non-transactional passthrough so createAgent()
          // always has a concrete implementation to call. Production always
          // supplies the real AgentService method.
          runTransaction:
            agentService.runTransaction?.bind(agentService) ??
            (<T>(fn: (tx: PrismaTransactionClient) => Promise<T>) =>
              fn(undefined as unknown as PrismaTransactionClient)),
        },
        agentToolService,
        agentPluginService,
        agentMemberService,
        agentEnvService,
        agentCronJobService,
        provisioner,
        agentTypeRegistry,
        anthropicFederationEnabled: deps.anthropicFederationEnabled,
      },
      {
        name,
        typeName,
        runtime,
        reposRaw,
        authorAllowlistRaw,
        patchAuthorAllowlistRaw,
        memberEmailsRaw,
        restrictSlackToMembersRaw,
        claudeCodeOauthToken,
        anthropicApiKey,
        ...(accountId !== null ? { accountId } : {}),
        // PAI-1.2: owner is the authenticated session user, never form data.
        ownerEmail: c.var.userEmail,
      },
    );
    if (!result.ok) {
      return c.redirect(
        `/admin/agents/new?error=${encodeURIComponent(result.errorMessage ?? result.errorCode)}`,
        302,
      );
    }
    const { agent, restrictSlackToMembers } = result;

    // ─── UAP-2.1: inline Slack/GitHub connect branches ─────────────────────
    // The agent row already exists at this point, so any failure below
    // redirects to the agent DETAIL page with an error — never rolls back
    // the agent (mirrors how the standalone connect-slack/connect-github
    // routes behave against an already-existing agent).
    //
    // Slack's OAuth flow is an external browser redirect, so at most one of
    // Slack/GitHub can produce the final HTTP response. When both are
    // requested, GitHub's storage/redirect-prep runs first (PAT storage is
    // synchronous; the App-manifest flow can't run before Slack's redirect
    // either, so it's skipped when Slack is also requested) so GH_TOKEN is
    // already in place by the time the user lands back from Slack's OAuth
    // callback — then Slack's redirect is returned last.
    //
    // UAP-5.1: this whole block only applies to in-cluster agents. Self-hosted
    // agents use local git config for GitHub auth, not admin-managed
    // provisioning, so Slack/GitHub connect must never run for them — even if
    // connectSlack/ghAuthMode were submitted via a raw POST bypassing the UI
    // (the New Agent form hides these sections for self-hosted, but that's
    // client-side only).
    if (inCluster) {
      let ghPatResult:
        | Awaited<ReturnType<typeof githubProvisioningService.startPatConnect>>
        | undefined;
      if (ghAuthMode === "pat") {
        ghPatResult = await githubProvisioningService.startPatConnect(
          agent.id,
          ghPat,
        );
        if (!ghPatResult.ok && !connectSlack) {
          return c.redirect(
            `/admin/agents/${agent.id}?error=${encodeURIComponent(ghPatResult.error)}`,
            302,
          );
        }
        if (!ghPatResult.ok) {
          console.error(
            "[admin-ui] GitHub PAT storage failed during combined Slack+GitHub connect:",
            ghPatResult.error,
          );
        }
      }

      if (connectSlack) {
        const redirectUri = `${appBaseUrl}/admin/agents/${agent.id}/connect-slack/callback`;
        // Carry a failed-PAT-storage warning (UAP-2.1) through Slack's OAuth
        // round trip via the signed provision-state cookie so it resurfaces on
        // the post-callback landing page. Without this, a GitHub PAT that failed
        // to store above would be silently swallowed and the operator misled
        // into believing GH_TOKEN was connected.
        const ghConnectError =
          ghPatResult && !ghPatResult.ok ? ghPatResult.error : undefined;
        const slackResult = await slackProvisioningService.startConnect(
          agent.id,
          xoxpToken,
          redirectUri,
          ghConnectError,
        );
        if (!slackResult.ok) {
          return c.redirect(
            `/admin/agents/${agent.id}?error=${encodeURIComponent(slackResult.error)}`,
            302,
          );
        }
        setCookie(c, PROVISION_STATE_COOKIE, slackResult.provisionStateToken, {
          httpOnly: true,
          maxAge: PROVISION_STATE_TTL_SECONDS,
          sameSite: "Lax",
          path: "/",
          secure: appBaseUrl.startsWith("https://"),
        });
        return c.redirect(slackResult.oauthRedirectUrl, 302);
      }

      if (ghAuthMode === "app" && ghAppMode === "manual") {
        // UAP-5.3: "Use existing GitHub App" — validates and persists
        // GH_APP_ID/GH_APP_INSTALLATION_ID/GH_APP_PRIVATE_KEY directly, no
        // GitHub API call. On success falls through to the shared
        // redirectWithMembersWarning below, matching the ghAuthMode=pat
        // branch's success path.
        const manualResult =
          await githubProvisioningService.startAppManualConnect(agent.id, {
            ghAppId,
            ghAppInstallationId,
            ghAppPrivateKey,
          });
        if (!manualResult.ok) {
          return c.redirect(
            `/admin/agents/${agent.id}?error=${encodeURIComponent(manualResult.error)}`,
            302,
          );
        }
      } else if (ghAuthMode === "app") {
        const appResult = await githubProvisioningService.startAppAutoConnect(
          agent.id,
          githubOrg,
          {
            redirectUri: `${appBaseUrl}/admin/agents/${agent.id}/connect-github/callback`,
            setupUrl: `${appBaseUrl}/admin/agents/${agent.id}/connect-github/installed`,
          },
        );
        if (!appResult.ok) {
          return c.redirect(
            `/admin/agents/${agent.id}?error=${encodeURIComponent(appResult.error)}`,
            302,
          );
        }
        setCookie(
          c,
          GITHUB_PROVISION_STATE_COOKIE,
          appResult.provisionStateToken,
          {
            httpOnly: true,
            maxAge: GITHUB_PROVISION_STATE_TTL_SECONDS,
            sameSite: "Lax",
            path: "/",
            secure: appBaseUrl.startsWith("https://"),
          },
        );
        return c.html(
          renderGithubAppManifestRedirectPage(c.var.userEmail, {
            githubOrg: appResult.githubOrg,
            manifest: appResult.manifest,
          }),
        );
      }
    }

    return redirectWithMembersWarning(
      c,
      agentMemberService,
      agent.id,
      restrictSlackToMembers,
    );
  });

  app.get("/admin/agents/:id", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const agent = await agentService.getDetail(agentId);
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }
    const agentDetail: AgentDetail = {
      id: agent.id,
      name: agent.name,
      slackId: agent.slackId ?? null,
      selfHosted: agent.selfHosted,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      repos: agent.repos,
      authorAllowlist: agent.reviewAuthorAllowlist,
      patchAuthorAllowlist: agent.patchAuthorAllowlist,
      restrictSlackToMembers: agent.restrictSlackToMembers,
      typeName: agent.typeName,
      missingRequiredEnv: agent.missingRequiredEnv,
      autoPostReviews: agent.autoPostReviews ?? true,
      allowSelfReview: agent.allowSelfReview ?? false,
      minConfidence: agent.minConfidence ?? 75,
      maxFindings: agent.maxFindings ?? 5,
      cleanupMergedWorktrees: agent.cleanupMergedWorktrees ?? true,
      cleanupAfterDays: agent.cleanupAfterDays ?? 14,
      ownerEmail: agent.ownerEmail ?? null,
      anthropicIdentityName: agent.anthropicIdentityName ?? null,
      anthropicServiceAccountId: agent.anthropicServiceAccountId ?? null,
      anthropicFederationRuleId: agent.anthropicFederationRuleId ?? null,
    };

    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }

    const rawError = c.req.query("error") ?? undefined;
    const error = rawError ? (ERROR_MESSAGES[rawError] ?? rawError) : undefined;
    const newToken = c.req.query("newToken") ?? undefined;
    const successParam = c.req.query("success");
    const successMsg =
      successParam === "manifest_synced"
        ? "Manifest synced successfully."
        : successParam === "reinstalled"
          ? "Slack app reinstalled successfully."
          : undefined;
    const warningParam = c.req.query("warning");
    const warning =
      warningParam === "restrict_slack_no_members"
        ? "This agent has no members — enabling restrictSlackToMembers will block all Slack senders."
        : // Free-form warning text (e.g. UAP-2.1's combined-flow GitHub PAT
          // failure carried through the Slack OAuth round trip). Passed through
          // verbatim rather than mapped to a fixed key.
          (warningParam ?? undefined);

    const [envResult, crons, tools, tokens, plugins, members] =
      await Promise.all([
        agentEnvService
          .getByAgentId(agentId)
          .then((e) => e ?? { env: {}, secretKeys: [] }),
        agentCronJobService.listWithRunSummary(agentId),
        agentToolService.list(agentId),
        agentTokenService.listForAgent(agentId),
        agentPluginService.list(agentId),
        canManageAgents(c.var.isAdmin)
          ? agentMemberService.listByAgentId(agentId)
          : Promise.resolve([]),
      ]);

    // Extension card slots (AEP-2.1/AEP-3.2), grouped by placement; a failing
    // slot is omitted.
    const cards = await renderAgentDetailCardSlots(
      deps.agentDetailCards ?? [],
      {
        agentId,
        userEmail: c.var.userEmail,
        isAdmin: c.var.isAdmin,
        accountId: agent.accountId ?? null,
        timezone,
      },
    );

    return html(
      renderAgentDetailPage(
        agentDetail,
        envResult,
        crons,
        tools,
        tokens,
        plugins,
        members,
        c.var.userEmail,
        c.var.isAdmin,
        {
          canManage: canManageAgents(c.var.isAdmin),
          error,
          newToken,
          successMsg,
          warning,
          timezone,
          extensionCardsHtml: cards.header,
          configurationCardsHtml: cards.configuration,
          queueActivityLinks: deps.queueActivityLinks,
        },
      ),
    );
  });

  // ─── Env var mutations ────────────────────────────────────────────────────

  app.post("/admin/agents/:id/envs", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let key: string | undefined;
    let value: string | undefined;
    let secretStr: string | undefined;
    try {
      const formData = await c.req.formData();
      key = formData.get("key")?.toString();
      value = formData.get("value")?.toString();
      secretStr = formData.get("secret")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (key && value !== undefined) {
      const isSecret = secretStr === "true";
      try {
        await agentEnvService.patch(
          agentId,
          { [key]: value },
          isSecret ? new Set([key]) : new Set(),
        );
      } catch (err) {
        // WIF-2.1: surface the typed rejection (key names only, never the
        // value) on the agent page instead of a 500.
        if (err instanceof AnthropicCredentialsBlockedError) {
          return c.redirect(
            `/admin/agents/${agentId}?error=${encodeURIComponent(err.message)}`,
            302,
          );
        }
        throw err;
      }
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/envs/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let key: string | undefined;
    try {
      const formData = await c.req.formData();
      key = formData.get("key")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (key) {
      await agentEnvService.deleteKey(agentId, key);
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Repo mutations ───────────────────────────────────────────────────────

  app.post("/admin/agents/:id/repos/add", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let repo: string | undefined;
    try {
      const formData = await c.req.formData();
      repo = formData.get("repo")?.toString()?.trim();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (!repo || !isOrgRepo(repo)) {
      return c.redirect(
        `/admin/agents/${agentId}?error=invalid_repo_format`,
        302,
      );
    }
    const agent = await agentService.getDetail(agentId);
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }
    const existing = agent.repos ?? [];
    const deduped = existing.includes(repo) ? existing : [...existing, repo];
    const collision = describeRepoNameCollision(deduped);
    if (collision) {
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent(collision)}`,
        302,
      );
    }
    await agentService.updateFields(agentId, { repos: deduped });
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/repos/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let repo: string | undefined;
    try {
      const formData = await c.req.formData();
      repo = formData.get("repo")?.toString()?.trim();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (repo) {
      const agent = await agentService.getDetail(agentId);
      if (!agent) {
        return new Response("Agent not found", { status: 404 });
      }
      const updated = (agent.repos ?? []).filter((r) => r !== repo);
      await agentService.updateFields(agentId, { repos: updated });
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Author allowlist (review) mutations ───────────────────────────────────

  app.post(
    "/admin/agents/:id/review-author-allowlist/add",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      let login: string | undefined;
      try {
        const formData = await c.req.formData();
        login = formData.get("login")?.toString()?.trim();
      } catch {
        return c.redirect(`/admin/agents/${agentId}`, 302);
      }
      if (!login || !isGithubLogin(login)) {
        return c.redirect(
          `/admin/agents/${agentId}?error=invalid_author_allowlist_format`,
          302,
        );
      }
      const agent = await agentService.getDetail(agentId);
      if (!agent) {
        return new Response("Agent not found", { status: 404 });
      }
      const existing = agent.reviewAuthorAllowlist ?? [];
      const deduped = existing.includes(login)
        ? existing
        : [...existing, login];
      await agentService.updateFields(agentId, {
        reviewAuthorAllowlist: deduped,
      });
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  app.post(
    "/admin/agents/:id/review-author-allowlist/delete",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      let login: string | undefined;
      try {
        const formData = await c.req.formData();
        login = formData.get("login")?.toString()?.trim();
      } catch {
        return c.redirect(`/admin/agents/${agentId}`, 302);
      }
      if (login) {
        const agent = await agentService.getDetail(agentId);
        if (!agent) {
          return new Response("Agent not found", { status: 404 });
        }
        const updated = (agent.reviewAuthorAllowlist ?? []).filter(
          (l) => l !== login,
        );
        await agentService.updateFields(agentId, {
          reviewAuthorAllowlist: updated,
        });
      }
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  // ─── Author allowlist (patch) mutations ────────────────────────────────────

  app.post(
    "/admin/agents/:id/patch-author-allowlist/add",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      let login: string | undefined;
      try {
        const formData = await c.req.formData();
        login = formData.get("login")?.toString()?.trim();
      } catch {
        return c.redirect(`/admin/agents/${agentId}`, 302);
      }
      if (!login || !isGithubLogin(login)) {
        return c.redirect(
          `/admin/agents/${agentId}?error=invalid_author_allowlist_format`,
          302,
        );
      }
      const agent = await agentService.getDetail(agentId);
      if (!agent) {
        return new Response("Agent not found", { status: 404 });
      }
      const existing = agent.patchAuthorAllowlist ?? [];
      const deduped = existing.includes(login)
        ? existing
        : [...existing, login];
      await agentService.updateFields(agentId, {
        patchAuthorAllowlist: deduped,
      });
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  app.post(
    "/admin/agents/:id/patch-author-allowlist/delete",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      let login: string | undefined;
      try {
        const formData = await c.req.formData();
        login = formData.get("login")?.toString()?.trim();
      } catch {
        return c.redirect(`/admin/agents/${agentId}`, 302);
      }
      if (login) {
        const agent = await agentService.getDetail(agentId);
        if (!agent) {
          return new Response("Agent not found", { status: 404 });
        }
        const updated = (agent.patchAuthorAllowlist ?? []).filter(
          (l) => l !== login,
        );
        await agentService.updateFields(agentId, {
          patchAuthorAllowlist: updated,
        });
      }
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  // ─── Slack access + Agent Policy settings ──────────────────────────────────
  //
  // Shared by two forms on the agent detail page: "Slack access"
  // (restrictSlackToMembers) and "Agent Policy" (APM-1.3's six DB-backed
  // policy fields). Each field is read independently and only included in
  // the updateFields() call when present in THIS submission's form data —
  // this lets the two forms share one route without a save from one form
  // silently clobbering the other's fields back to false/defaults. Every
  // checkbox in both forms renders a hidden "false" fallback alongside it
  // (see admin-ui-pages.ts) so an unchecked box still submits a real value
  // rather than being omitted entirely (the standard HTML checkbox gotcha) —
  // that hidden fallback is what makes "this form's box is unchecked"
  // distinguishable from "a different form was submitted, this field is
  // simply absent".

  app.post("/admin/agents/:id/settings", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (
      !(await assertCanManageAgent(agentId, c.var.userEmail, c.var.isAdmin))
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }

    const readBool = (name: string): boolean | undefined => {
      const raw = formData.get(name)?.toString();
      return raw === undefined ? undefined : raw === "true";
    };
    // Defensive: reject non-finite/negative values rather than writing NaN
    // (or a nonsensical negative count) to Postgres — falls back to
    // undefined (leave the field unchanged) instead of throwing or silently
    // persisting garbage. An emptied <input type="number"> submits "" (not
    // undefined), and Number("") is 0 — so blank/whitespace-only input is
    // treated as absent too, otherwise clearing a field would silently zero it.
    const readInt = (name: string): number | undefined => {
      const raw = formData.get(name)?.toString();
      if (raw === undefined || raw.trim() === "") return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    };

    const restrictSlackToMembers = readBool("restrictSlackToMembers");
    const autoPostReviews = readBool("autoPostReviews");
    const allowSelfReview = readBool("allowSelfReview");
    const cleanupMergedWorktrees = readBool("cleanupMergedWorktrees");
    const minConfidence = readInt("minConfidence");
    const maxFindings = readInt("maxFindings");
    const cleanupAfterDays = readInt("cleanupAfterDays");

    const agent = await agentService.updateFields(agentId, {
      ...(restrictSlackToMembers !== undefined && { restrictSlackToMembers }),
      ...(autoPostReviews !== undefined && { autoPostReviews }),
      ...(allowSelfReview !== undefined && { allowSelfReview }),
      ...(cleanupMergedWorktrees !== undefined && { cleanupMergedWorktrees }),
      ...(minConfidence !== undefined && { minConfidence }),
      ...(maxFindings !== undefined && { maxFindings }),
      ...(cleanupAfterDays !== undefined && { cleanupAfterDays }),
    });
    return redirectWithMembersWarning(
      c,
      agentMemberService,
      agent.id,
      agent.restrictSlackToMembers,
    );
  });

  // ─── Cron job mutations ───────────────────────────────────────────────────

  app.post("/admin/agents/:id/crons", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let schedule: string | undefined;
    let prompt: string | undefined;
    let channel: string | null = null;
    let user: string | null = null;
    let silent = false;
    let enabled = true;
    let name: string | null = null;
    try {
      const formData = await c.req.formData();
      schedule = formData.get("schedule")?.toString();
      prompt = formData.get("prompt")?.toString();
      channel = formData.get("channel")?.toString() || null;
      user = formData.get("user")?.toString() || null;
      silent =
        formData.get("silent") === "on" || formData.get("silent") === "true";
      const enabledVal = formData.get("enabled");
      // Checkbox: present as "on" when checked, absent (null) when unchecked.
      // Programmatic callers may send "true"/"false" explicitly.
      enabled = enabledVal === "on" || enabledVal === "true";
      name = formData.get("name")?.toString() || null;
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (!schedule || !prompt) {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }
    try {
      await agentCronJobService.create(agentId, {
        schedule,
        prompt,
        channel,
        user,
        silent,
        enabled,
        name,
      });
    } catch (err) {
      if (err instanceof UnprocessableEntityError) {
        const msg = err.message.toLowerCase();
        if (msg.includes("invalid cron")) {
          return c.redirect(
            `/admin/agents/${agentId}?error=invalid_schedule`,
            302,
          );
        }
        if (
          msg.includes("channel") ||
          msg.includes("user") ||
          msg.includes("target")
        ) {
          return c.redirect(
            `/admin/agents/${agentId}?error=invalid_target`,
            302,
          );
        }
      }
      return c.redirect(`/admin/agents/${agentId}?error=create_failed`, 302);
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/crons/:cronId/toggle", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let enabled = true;
    try {
      const formData = await c.req.formData();
      enabled = formData.get("enabled") !== "false";
    } catch {
      // use default
    }
    try {
      await agentCronJobService.setEnabled(agentId, cronId, enabled);
    } catch {
      // ignore errors — redirect back regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/crons/:cronId/update", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let schedule = "";
    let prompt = "";
    let channel: string | null = null;
    let preCheck: string | null = null;
    try {
      const formData = await c.req.formData();
      schedule = ((formData.get("schedule") as string | null) ?? "").trim();
      prompt = ((formData.get("prompt") as string | null) ?? "").trim();
      const ch = ((formData.get("channel") as string | null) ?? "").trim();
      channel = ch === "" ? null : ch;
      const pc = ((formData.get("preCheck") as string | null) ?? "").trim();
      preCheck = pc === "" ? null : pc; // empty clears the preCheck
    } catch {
      // fall through to validation
    }
    if (!schedule || !prompt) {
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent("schedule and prompt are required")}`,
        302,
      );
    }
    try {
      // Fetch the existing cron so we (a) block edits to system crons — their
      // contents are owned by reconcileSystemCrons and would be reverted — and
      // (b) forward `user`/`silent`. Without them the service resolves user→null,
      // silent→false and validateDeliveryTarget throws for any DM-routed cron.
      const existing = await agentCronJobService.get(agentId, cronId);
      if (existing.system) {
        return c.redirect(
          `/admin/agents/${agentId}?error=${encodeURIComponent("system crons cannot be edited")}`,
          302,
        );
      }
      await agentCronJobService.update(agentId, cronId, {
        schedule,
        prompt,
        channel,
        preCheck,
        user: existing.user,
        silent: existing.silent,
      });
    } catch (err) {
      // Surface validation errors (e.g. invalid cron expression) back to the page.
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent(
          err instanceof Error ? err.message : "cron update failed",
        )}`,
        302,
      );
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/crons/:cronId/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const cron = await agentCronJobService.get(agentId, cronId);
      if (cron.system) {
        throw new ForbiddenError("system crons cannot be deleted");
      }
      await agentCronJobService.delete(agentId, cronId);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.redirect(
          `/admin/agents/${agentId}?error=${encodeURIComponent(err.message)}`,
          302,
        );
      }
      // other errors (NotFoundError, etc.) — redirect back silently
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Tool mutations ───────────────────────────────────────────────────────

  app.post("/admin/agents/:id/tools", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let pattern: string | undefined;
    try {
      const formData = await c.req.formData();
      pattern = formData.get("pattern")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (!pattern) {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }
    try {
      await agentToolService.add(agentId, pattern);
    } catch {
      // ignore errors — redirect back regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/tools/:toolId/toggle", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let enabled = true;
    try {
      const formData = await c.req.formData();
      enabled = formData.get("enabled") !== "false";
    } catch {
      // use default
    }
    try {
      await agentToolService.toggle(agentId, toolId, enabled);
    } catch {
      // ignore errors — redirect back regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/tools/:toolId/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      await agentToolService.remove(agentId, toolId);
    } catch {
      // ignore errors — redirect back regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Token mutations ──────────────────────────────────────────────────────

  app.post("/admin/agents/:id/tokens", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let label: string | undefined;
    try {
      const formData = await c.req.formData();
      label = formData.get("label")?.toString() || undefined;
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    const agent = await agentService.getDetail(agentId);
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }
    const agentDetail: AgentDetail = {
      id: agent.id,
      name: agent.name,
      slackId: agent.slackId ?? null,
      selfHosted: agent.selfHosted,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      repos: agent.repos,
      authorAllowlist: agent.reviewAuthorAllowlist,
      patchAuthorAllowlist: agent.patchAuthorAllowlist,
      restrictSlackToMembers: agent.restrictSlackToMembers,
      typeName: agent.typeName,
      missingRequiredEnv: agent.missingRequiredEnv,
      autoPostReviews: agent.autoPostReviews ?? true,
      allowSelfReview: agent.allowSelfReview ?? false,
      minConfidence: agent.minConfidence ?? 75,
      maxFindings: agent.maxFindings ?? 5,
      cleanupMergedWorktrees: agent.cleanupMergedWorktrees ?? true,
      cleanupAfterDays: agent.cleanupAfterDays ?? 14,
      ownerEmail: agent.ownerEmail ?? null,
      anthropicIdentityName: agent.anthropicIdentityName ?? null,
      anthropicServiceAccountId: agent.anthropicServiceAccountId ?? null,
      anthropicFederationRuleId: agent.anthropicFederationRuleId ?? null,
    };
    try {
      const { rawToken } = await agentTokenService.create(agentId, label);
      // Render the page directly (200) rather than redirecting with the token in the URL.
      // A redirect would expose the raw token in server access logs and browser history.
      const [envResult, crons, tools, tokens, plugins, members] =
        await Promise.all([
          agentEnvService
            .getByAgentId(agentId)
            .then((e) => e ?? { env: {}, secretKeys: [] }),
          agentCronJobService.listWithRunSummary(agentId),
          agentToolService.list(agentId),
          agentTokenService.listForAgent(agentId),
          agentPluginService.list(agentId),
          canManageAgents(c.var.isAdmin)
            ? agentMemberService.listByAgentId(agentId)
            : Promise.resolve([]),
        ]);
      // The token page renders only the Configuration-group extension cards;
      // header cards keep their place empty, as before the slot split.
      const cards = await renderAgentDetailCardSlots(
        deps.agentDetailCards ?? [],
        {
          agentId,
          userEmail: c.var.userEmail,
          isAdmin: c.var.isAdmin,
          accountId: agent.accountId ?? null,
          timezone,
        },
        ["configuration"],
      );
      return html(
        renderAgentDetailPage(
          agentDetail,
          envResult,
          crons,
          tools,
          tokens,
          plugins,
          members,
          c.var.userEmail,
          c.var.isAdmin,
          {
            canManage: canManageAgents(c.var.isAdmin),
            newToken: rawToken,
            timezone,
            extensionCardsHtml: cards.header,
            configurationCardsHtml: cards.configuration,
            queueActivityLinks: deps.queueActivityLinks,
          },
        ),
      );
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=create_failed`, 302);
    }
  });

  app.post(
    "/admin/agents/:id/tokens/:tokenId/revoke",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      const tokenId = c.req.param("tokenId");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        await agentTokenService.revoke(tokenId);
      } catch {
        // ignore errors — redirect back regardless
      }
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  // ─── Provisioning state constants ────────────────────────────────────────
  // PROVISION_STATE_COOKIE / PROVISION_STATE_TTL_SECONDS now live in
  // slack-provisioning-service.ts (UAP-1.1); GITHUB_PROVISION_STATE_COOKIE /
  // GITHUB_PROVISION_STATE_TTL_SECONDS / GITHUB_ORG_PATTERN now live in
  // github-provisioning-service.ts (UAP-1.2) — re-imported above so every
  // route in this file keeps using the same names.

  // ─── Manifest sync ────────────────────────────────────────────────────────

  app.post("/admin/agents/:id/sync-manifest", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    const agent = await agentService.getDetail(agentId);
    if (!agent) return new Response("Agent not found", { status: 404 });

    let xoxpToken: string | undefined;
    try {
      const formData = await c.req.formData();
      xoxpToken = formData.get("xoxpToken")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }

    if (!xoxpToken?.startsWith("xoxe.xoxp-")) {
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent("Slack app configuration token must start with xoxe.xoxp-")}`,
        302,
      );
    }

    const envBundle = await agentEnvService.getConfigBundle(agentId);
    const appId = envBundle?.env.SLACK_APP_ID;
    if (!appId) {
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent("SLACK_APP_ID is not set — provision the agent first.")}`,
        302,
      );
    }

    try {
      const redirectUri = `${appBaseUrl}/admin/agents/${agentId}/connect-slack/callback`;
      const manifest = buildAgentManifest(agent.name, redirectUri);
      await slackClient.updateAppManifest(xoxpToken, appId, manifest);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown error syncing manifest.";
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent(msg)}`,
        302,
      );
    }

    // If the agent has OAuth credentials stored, trigger a reinstall via Slack OAuth
    const clientId = envBundle?.env.SLACK_CLIENT_ID;
    const clientSecret = envBundle?.env.SLACK_CLIENT_SECRET;
    const signingSecret = envBundle?.env.SLACK_SIGNING_SECRET;

    if (clientId && clientSecret && signingSecret) {
      // Sign a provision-state cookie so the connect-slack callback can exchange the code
      const now = Math.floor(Date.now() / 1000);
      const provisionToken = await sign(
        {
          agentId,
          clientId,
          clientSecret,
          signingSecret,
          appId,
          iat: now,
          exp: now + PROVISION_STATE_TTL_SECONDS,
        },
        sessionSecret,
        "HS256",
      );
      setCookie(c, PROVISION_STATE_COOKIE, provisionToken, {
        httpOnly: true,
        maxAge: PROVISION_STATE_TTL_SECONDS,
        sameSite: "Lax",
        path: "/",
        secure: appBaseUrl.startsWith("https://"),
      });

      // Build the Slack OAuth v2 authorize URL — use the canonical scope list
      // exported from slack-provisioning-client.ts so this stays in sync with
      // what buildAgentManifest declares.
      const scopes = AGENT_BOT_SCOPES.join(",");
      const redirectUri = `${appBaseUrl}/admin/agents/${agentId}/connect-slack/callback`;
      const oauthParams = new URLSearchParams({
        client_id: clientId,
        scope: scopes,
        redirect_uri: redirectUri,
      });
      return c.redirect(
        `https://slack.com/oauth/v2/authorize?${oauthParams.toString()}`,
        302,
      );
    }

    return c.redirect(`/admin/agents/${agentId}?success=manifest_synced`, 302);
  });

  // ─── connect-slack (UAP-1.1) ───────────────────────────────────────────────
  // Per-agent equivalents of the legacy /admin/provision/* Slack wizard,
  // scoped to an already-existing agent id. All three delegate to the same
  // SlackProvisioningService the wizard now calls — pure routing/rendering
  // here, no business logic.

  app.post("/admin/agents/:id/connect-slack", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }

    let xoxpToken: string | undefined;
    try {
      const formData = await c.req.formData();
      xoxpToken = formData.get("xoxpToken")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }

    const result = await slackProvisioningService.startConnect(
      agentId,
      xoxpToken,
      `${appBaseUrl}/admin/agents/${agentId}/connect-slack/callback`,
    );

    if (!result.ok) {
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent(result.error)}`,
        302,
      );
    }

    setCookie(c, PROVISION_STATE_COOKIE, result.provisionStateToken, {
      httpOnly: true,
      maxAge: PROVISION_STATE_TTL_SECONDS,
      sameSite: "Lax",
      path: "/",
      secure: appBaseUrl.startsWith("https://"),
    });

    return c.redirect(result.oauthRedirectUrl, 302);
  });

  app.get(
    "/admin/agents/:id/connect-slack/callback",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      const userEmail = c.var.userEmail;

      const rawStateCookie = getCookie(c, PROVISION_STATE_COOKIE);
      const code = c.req.query("code");
      const result = await slackProvisioningService.completeConnect(
        rawStateCookie,
        code,
        `${appBaseUrl}/admin/agents/${agentId}/connect-slack/callback`,
      );

      if (result.outcome === "invalid_state") {
        deleteCookie(c, PROVISION_STATE_COOKIE);
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      if (result.outcome === "missing_code") {
        // Cookie must remain intact so the user can restart the provision flow.
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // Every other outcome consumed the cookie's OAuth code — clear it now.
      deleteCookie(c, PROVISION_STATE_COOKIE);

      if (result.outcome === "exchange_failed") {
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // A non-fatal GitHub PAT storage failure from the combined create+connect
      // flow (UAP-2.1) rode through Slack's OAuth round trip in the signed
      // cookie — surface it now so the operator isn't misled into believing
      // GH_TOKEN was stored.
      const ghConnectWarning = result.ghConnectError
        ? `GitHub was not connected — storing the PAT failed: ${result.ghConnectError}`
        : undefined;

      if (result.outcome === "reinstalled") {
        const query = ghConnectWarning
          ? `?success=reinstalled&warning=${encodeURIComponent(ghConnectWarning)}`
          : "?success=reinstalled";
        return c.redirect(`/admin/agents/${result.agentId}${query}`, 302);
      }

      // result.outcome === "needs_app_token"
      return html(
        renderProvisionXappTokenPage(userEmail, {
          agentId: result.agentId,
          warning: ghConnectWarning,
        }),
      );
    },
  );

  app.post(
    "/admin/agents/:id/connect-slack/app-token",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      const userEmail = c.var.userEmail;

      let xappToken: string | undefined;
      try {
        const formData = await c.req.formData();
        xappToken = formData.get("xappToken")?.toString();
      } catch {
        return html(
          renderProvisionXappTokenPage(userEmail, {
            agentId,
            error: "Invalid form submission.",
          }),
        );
      }

      const result = await slackProvisioningService.saveAppToken(
        agentId,
        xappToken,
      );

      if (!result.ok) {
        return html(
          renderProvisionXappTokenPage(userEmail, {
            agentId: result.agentId,
            error: result.error,
          }),
        );
      }

      return html(
        renderProvisionCompletePage(userEmail, {
          success: true,
          agentId: result.agentId,
        }),
      );
    },
  );

  // ─── connect-github (UAP-1.2) ───────────────────────────────────────────────
  // Per-agent equivalents of the legacy /admin/provision/* GitHub App/PAT
  // wizard branches, scoped to an already-existing agent id. All three
  // delegate to the same GithubProvisioningService the wizard now calls —
  // pure routing/rendering here, no business logic. Supports all three modes
  // selected via `ghAuthMode`/`ghAppMode` form fields, mirroring the legacy
  // wizard's form shape: pat, app+manual, app+auto.

  app.post("/admin/agents/:id/connect-github", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    const userEmail = c.var.userEmail;

    let ghAuthMode: string | undefined;
    let ghPat: string | undefined;
    let ghAppMode: string | undefined;
    let ghAppId: string | undefined;
    let ghAppInstallationId: string | undefined;
    let ghAppPrivateKey: string | undefined;
    let githubOrg: string | undefined;
    let ghAppPublic = false;
    try {
      const formData = await c.req.formData();
      ghAuthMode = formData.get("ghAuthMode")?.toString() ?? "pat";
      ghPat = formData.get("ghPat")?.toString();
      ghAppMode = formData.get("ghAppMode")?.toString() ?? "manual";
      ghAppId = formData.get("ghAppId")?.toString();
      ghAppInstallationId = formData.get("ghAppInstallationId")?.toString();
      // The detail page's "Use existing GitHub App" action (UAP-5.4) submits
      // the private key as a file upload rather than pasted text — read its
      // contents server-side. Falls back to a plain ghAppPrivateKey text
      // field for back-compat with any other caller still posting it that
      // way (e.g. API clients).
      const ghAppPrivateKeyFile = formData.get("ghAppPrivateKeyFile");
      ghAppPrivateKey =
        ghAppPrivateKeyFile instanceof File
          ? await ghAppPrivateKeyFile.text()
          : formData.get("ghAppPrivateKey")?.toString();
      githubOrg = formData.get("githubOrg")?.toString()?.trim();
      ghAppPublic = formData.get("ghAppPublic")?.toString() === "true";
    } catch {
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          agentId,
          error: "Invalid form submission.",
        }),
      );
    }

    if (ghAuthMode === "pat") {
      const result = await githubProvisioningService.startPatConnect(
        agentId,
        ghPat,
      );
      if (!result.ok) {
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            agentId: result.agentId,
            error: result.error,
          }),
        );
      }
      return html(
        renderProvisionCompletePage(userEmail, {
          success: true,
          agentId: result.agentId,
        }),
      );
    }

    if (ghAppMode === "auto") {
      const result = await githubProvisioningService.startAppAutoConnect(
        agentId,
        githubOrg,
        {
          redirectUri: `${appBaseUrl}/admin/agents/${agentId}/connect-github/callback`,
          setupUrl: `${appBaseUrl}/admin/agents/${agentId}/connect-github/installed`,
        },
        { public: ghAppPublic },
      );
      if (!result.ok) {
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            agentId,
            error: result.error,
          }),
        );
      }
      setCookie(c, GITHUB_PROVISION_STATE_COOKIE, result.provisionStateToken, {
        httpOnly: true,
        maxAge: GITHUB_PROVISION_STATE_TTL_SECONDS,
        sameSite: "Lax",
        path: "/",
        secure: appBaseUrl.startsWith("https://"),
      });
      // Use c.html() so the Set-Cookie header from setCookie() is included
      return c.html(
        renderGithubAppManifestRedirectPage(userEmail, {
          githubOrg: result.githubOrg,
          manifest: result.manifest,
        }),
      );
    }

    // ghAppMode === "manual" (default)
    const result = await githubProvisioningService.startAppManualConnect(
      agentId,
      { ghAppId, ghAppInstallationId, ghAppPrivateKey },
    );
    if (!result.ok) {
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          agentId: result.agentId,
          error: result.error,
        }),
      );
    }
    return html(
      renderProvisionCompletePage(userEmail, {
        success: true,
        agentId: result.agentId,
      }),
    );
  });

  app.get(
    "/admin/agents/:id/connect-github/callback",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      const userEmail = c.var.userEmail;

      const rawStateCookie = getCookie(c, GITHUB_PROVISION_STATE_COOKIE);
      const code = c.req.query("code");
      const result = await githubProvisioningService.completeConnect(
        rawStateCookie,
        code,
        agentId,
      );

      if (result.outcome === "invalid_state") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      if (result.outcome === "agent_mismatch") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return new Response("Forbidden", { status: 403 });
      }

      if (result.outcome === "missing_code") {
        // Cookie must remain intact so the user can restart the provision flow.
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // Every other outcome consumed the cookie's manifest code — clear it now.
      deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);

      if (result.outcome === "exchange_failed") {
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // result.outcome === "success"
      return html(
        renderGithubAppInstallPage(userEmail, {
          installUrl: result.installUrl,
        }),
      );
    },
  );

  app.get(
    "/admin/agents/:id/connect-github/installed",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      const userEmail = c.var.userEmail;

      const rawStateCookie = getCookie(c, GITHUB_PROVISION_STATE_COOKIE);
      const installationId = c.req.query("installation_id");
      const result = await githubProvisioningService.completeInstalled(
        rawStateCookie,
        installationId,
        agentId,
      );

      if (result.outcome === "invalid_state") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      if (result.outcome === "agent_mismatch") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return new Response("Forbidden", { status: 403 });
      }

      if (result.outcome === "invalid_installation_id") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // result.outcome === "success"
      deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
      return html(
        renderGithubAppInstalledPage(userEmail, {
          success: true,
          alreadyStored: result.alreadyStored,
        }),
      );
    },
  );

  app.get(
    "/admin/agents/:id/connect-github/add-org",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      const result = await githubProvisioningService.getAddOrgUrl(agentId);
      if (!result.ok) {
        return c.redirect(
          `/admin/agents/${agentId}?error=${encodeURIComponent(result.error)}`,
          302,
        );
      }
      return c.redirect(result.url, 302);
    },
  );

  // ─── Provisioning flow ────────────────────────────────────────────────────

  app.get("/admin/provision", (c) => c.redirect("/admin/agents/new", 302));

  // ─── Member management (admin, or any agent-access holder when self-serve is on) ──────────────────────────────────────

  app.post("/admin/agents/:id/members", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (
      !(await assertCanManageAgent(agentId, c.var.userEmail, c.var.isAdmin))
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    let email: string | undefined;
    try {
      const formData = await c.req.formData();
      email = formData.get("email")?.toString()?.toLowerCase();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (email) {
      try {
        await agentMemberService.add(agentId, email);
      } catch {
        // unique constraint violation — already a member, ignore
      }
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/members/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (
      !(await assertCanManageAgent(agentId, c.var.userEmail, c.var.isAdmin))
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    let memberId: string | undefined;
    try {
      const formData = await c.req.formData();
      memberId = formData.get("memberId")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (memberId) {
      try {
        await agentMemberService.remove(agentId, memberId);
      } catch {
        // already gone, ignore
      }
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Account page (SSP-3.2) ───────────────────────────────────────────────

  if (accountServices) {
    registerAccountRoutes(app, {
      enabled: accountNavEnabled,
      requireAuth,
      ...accountServices,
      html,
    });
    registerAdminAccountsRoutes(app, {
      enabled: accountNavEnabled,
      requireAuth,
      ...accountServices,
      agents: agentService,
      provisioner,
      html,
    });
  }

  // ─── Chat routes ─────────────────────────────────────────────────────────

  /**
   * Chat access gate (admins: always; members: only agents they belong to).
   * The chat service is reached with a single admin token, so for non-admins
   * the thread must also be verified to belong to the URL's agent — otherwise a
   * member could pass their own agentId with another agent's threadId.
   */
  async function canAccessChat(
    userEmail: string,
    isAdmin: boolean,
    agentId: string,
    threadId?: string,
  ): Promise<boolean> {
    if (isAdmin) return true;
    if (!agentId || !(await assertAgentAccess(agentId, userEmail, false))) {
      return false;
    }
    if (!threadId) return true;
    if (!chatClient) return true;
    try {
      const thread = await chatClient.getThread(threadId);
      return thread.agentId === agentId;
    } catch {
      return false;
    }
  }

  /**
   * SSP-8.4: message-send gate. A suspended / trial-expired account's agents
   * stop accepting chat messages (read-only history stays available). Platform
   * admins are exempt; agents with no account are unaffected.
   */
  async function chatSendBlockedMessage(
    agentId: string,
    isAdmin: boolean,
  ): Promise<string | null> {
    if (isAdmin || !accountService) return null;
    const agent = await agentService.getDetail(agentId);
    if (!agent?.accountId) return null;
    const account = await accountService.getById(agent.accountId);
    if (account?.status === "suspended") {
      return "This account is suspended — chat messages can't be sent. Contact support to reactivate it.";
    }
    if (account?.status === "trial_expired") {
      return "This account's trial has expired — chat messages can't be sent. Upgrade to continue.";
    }
    return null;
  }

  app.get("/admin/chat", requireAuth, async (c) => {
    const selectedAgentId = c.req.query("agentId") || undefined;
    const q = c.req.query("q") || undefined;
    const agents: AgentOption[] = c.var.isAdmin
      ? await agentService.listOptions()
      : (await resolveAccessibleAgents(c.var.userEmail, false)).map((a) => ({
          id: a.id,
          name: a.name,
        }));
    if (
      selectedAgentId &&
      !c.var.isAdmin &&
      !agents.some((a) => a.id === selectedAgentId)
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!chatClient) {
      return html(
        renderChatPage(agents, selectedAgentId, null, c.var.userEmail, q),
      );
    }

    let threads: ChatThread[] = [];
    if (selectedAgentId) {
      try {
        const result = await chatClient.listThreads(selectedAgentId);
        threads = result.threads;
        // Server-side filter by search query
        if (q) {
          const lowerQ = q.toLowerCase();
          threads = threads.filter((t) =>
            (t.title ?? "").toLowerCase().includes(lowerQ),
          );
        }
      } catch {
        threads = [];
      }
    }

    return html(
      renderChatPage(agents, selectedAgentId, threads, c.var.userEmail, q),
    );
  });

  app.get("/admin/chat/:agentId/threads/:threadId", requireAuth, async (c) => {
    if (
      !(await canAccessChat(
        c.var.userEmail,
        c.var.isAdmin,
        c.req.param("agentId") ?? "",
        c.req.param("threadId"),
      ))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const agentId = c.req.param("agentId");
    const threadId = c.req.param("threadId");

    // Test-only override for the live-progress stall-warning threshold so e2e
    // doesn't need a real 2-minute wait. Clamped to a sane range; production
    // never passes it, so the 120s default stands.
    const rawStall = c.req.query("stallWarnAfterMs");
    const stallWarnAfterMs =
      rawStall !== undefined &&
      Number.isFinite(Number(rawStall)) &&
      Number(rawStall) > 0
        ? Number(rawStall)
        : undefined;

    if (!chatClient) {
      return html(
        renderChatThreadPage(agentId, null, null, null, c.var.userEmail),
      );
    }

    try {
      const [thread, messagesResult, threadListResult, statsResult] =
        await Promise.all([
          chatClient.getThread(threadId),
          chatClient.listMessages(threadId),
          chatClient.listThreads(agentId).catch(() => null),
          chatClient.getThreadStats(threadId).catch(() => null),
        ]);
      const threadList = threadListResult ? threadListResult.threads : null;
      return html(
        renderChatThreadPage(
          agentId,
          thread,
          messagesResult.messages,
          threadList,
          c.var.userEmail,
          statsResult,
          { stallWarnAfterMs, pushEnabled, vapidPublicKey },
        ),
      );
    } catch {
      return html(
        renderChatThreadPage(agentId, null, null, null, c.var.userEmail),
      );
    }
  });

  app.post("/admin/chat/:agentId/threads", requireAuth, async (c) => {
    if (
      !(await canAccessChat(
        c.var.userEmail,
        c.var.isAdmin,
        c.req.param("agentId") ?? "",
        c.req.param("threadId"),
      ))
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const agentId = c.req.param("agentId");

    if (!chatClient) {
      return c.redirect(
        `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
        302,
      );
    }

    let title: string | undefined;
    try {
      const formData = await c.req.formData();
      title = formData.get("title")?.toString()?.trim() || undefined;
    } catch {
      return c.redirect(
        `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
        302,
      );
    }

    try {
      const thread = await chatClient.createThread(agentId, { title });
      return c.redirect(
        `/admin/chat/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(thread.id)}`,
        302,
      );
    } catch {
      return c.redirect(
        `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
        302,
      );
    }
  });

  // Upload route — registered BEFORE the form POST /messages route so the more
  // specific `/messages/upload` segment matches first. Returns JSON so the inline
  // send flow can surface validation errors without a full-page redirect.
  app.post(
    "/admin/chat/:agentId/threads/:threadId/messages/upload",
    requireAuth,
    async (c) => {
      if (
        !(await canAccessChat(
          c.var.userEmail,
          c.var.isAdmin,
          c.req.param("agentId") ?? "",
          c.req.param("threadId"),
        ))
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const sendBlocked = await chatSendBlockedMessage(
        c.req.param("agentId") ?? "",
        c.var.isAdmin,
      );
      if (sendBlocked) {
        return c.json(
          { error: "account_suspended", message: sendBlocked },
          403,
        );
      }

      const agentId = c.req.param("agentId");
      const threadId = c.req.param("threadId");

      if (!chatClient) {
        return c.json({ error: "chat service not configured" }, 503);
      }

      let body: string | undefined;
      let file: File | null = null;
      try {
        const formData = await c.req.formData();
        body = formData.get("body")?.toString()?.trim();
        const rawFile = formData.get("file");
        file = rawFile instanceof File && rawFile.size > 0 ? rawFile : null;
      } catch {
        return c.json({ error: "invalid form data" }, 400);
      }

      let attachment:
        | { filename: string; size: number; bytes: Uint8Array }
        | undefined;
      if (file) {
        const validation = validateAttachment(file.name, file.size, file.type);
        if (!validation.ok) {
          return c.json({ error: validation.error }, validation.status);
        }
        attachment = {
          filename: file.name,
          size: file.size,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }

      // A message needs at least a body or a file.
      if (!body && !attachment) {
        return c.json({ error: "message body or file is required" }, 400);
      }

      try {
        const message = await chatClient.createMessage(
          threadId,
          "user",
          body ?? "",
          attachment,
        );
        // Record that this user is watching the thread so the agent's reply
        // can be targeted back to them via push (CFB-4.2). This is the route
        // the live chat UI's send box actually posts to (see
        // admin-ui-pages.ts's uploadUrl) — the form POST /messages and
        // /messages.json routes above are alternate entry points with their
        // own identical call; all three must stay in sync. Best-effort —
        // never block the response.
        if (pushEnabled) {
          await pushService?.recordWatch(c.var.userEmail, agentId, threadId);
        }
        return c.json({ message }, 201);
      } catch {
        return c.json({ error: "failed to create message" }, 500);
      }
    },
  );

  // Attachment proxy (VM-3.1) — streams a message's attachment bytes back to
  // the browser so audio attachments can play inline via `<audio src>`. The
  // browser never holds the chat service's admin bearer token, so it can't
  // call the chat service's GET /:id/attachment directly; this route fetches
  // on its behalf and re-serves with a real audio/* Content-Type (the chat
  // service itself always streams application/octet-stream, which most
  // browsers won't play inline in an <audio> element).
  app.get(
    "/admin/chat/:agentId/threads/:threadId/messages/:messageId/attachment",
    requireAuth,
    async (c) => {
      if (
        !(await canAccessChat(
          c.var.userEmail,
          c.var.isAdmin,
          c.req.param("agentId") ?? "",
          c.req.param("threadId"),
        ))
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      if (!chatClient) {
        return c.json({ error: "chat service not configured" }, 503);
      }

      const threadId = c.req.param("threadId");
      const messageId = c.req.param("messageId");

      try {
        const attachment = await chatClient.getAttachment(threadId, messageId);
        if (!attachment) {
          return c.json({ error: "attachment not found" }, 404);
        }
        const contentType =
          audioContentTypeForFilename(attachment.filename) ??
          "application/octet-stream";
        // .slice() normalizes to Uint8Array<ArrayBuffer> — Hono's Data type
        // requires that exact generic, not the wider Uint8Array<ArrayBufferLike>
        // that new Uint8Array(await res.arrayBuffer()) produces.
        return c.body(attachment.bytes.slice(), 200, {
          "Content-Type": contentType,
          "Content-Disposition": `inline; filename="${attachment.filename.replace(/"/g, "")}"`,
        });
      } catch {
        return c.json({ error: "failed to fetch attachment" }, 500);
      }
    },
  );

  app.post(
    "/admin/chat/:agentId/threads/:threadId/messages",
    requireAuth,
    async (c) => {
      if (
        !(await canAccessChat(
          c.var.userEmail,
          c.var.isAdmin,
          c.req.param("agentId") ?? "",
          c.req.param("threadId"),
        ))
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const sendBlocked = await chatSendBlockedMessage(
        c.req.param("agentId") ?? "",
        c.var.isAdmin,
      );
      if (sendBlocked) {
        return new Response(sendBlocked, { status: 403 });
      }

      const agentId = c.req.param("agentId");
      const threadId = c.req.param("threadId");

      const backUrl = `/admin/chat/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`;

      if (!chatClient) {
        return c.redirect(backUrl, 302);
      }

      const ALLOWED_ROLES = ["user", "assistant"] as const;
      type MessageRole = (typeof ALLOWED_ROLES)[number];

      let body: string | undefined;
      let role: MessageRole = "user";
      let file: File | null = null;
      try {
        const formData = await c.req.formData();
        body = formData.get("body")?.toString()?.trim();
        const rawRole = formData.get("role")?.toString() || "user";
        role = (ALLOWED_ROLES as readonly string[]).includes(rawRole)
          ? (rawRole as MessageRole)
          : "user";
        const rawFile = formData.get("file");
        file = rawFile instanceof File && rawFile.size > 0 ? rawFile : null;
      } catch {
        return c.redirect(backUrl, 302);
      }

      let attachment:
        | { filename: string; size: number; bytes: Uint8Array }
        | undefined;
      if (file) {
        const validation = validateAttachment(file.name, file.size, file.type);
        if (!validation.ok) {
          // Invalid attachment — bounce back without queuing anything.
          return c.redirect(backUrl, 302);
        }
        attachment = {
          filename: file.name,
          size: file.size,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }

      if (!body && !attachment) {
        return c.redirect(backUrl, 302);
      }

      try {
        await chatClient.createMessage(threadId, role, body ?? "", attachment);
      } catch {
        // swallow — redirect back regardless
      }

      // Record that this user is watching the thread so the agent's reply can
      // be targeted back to them via push (CFB-4.2). Only on user messages, and
      // only when push is configured. Best-effort — never block the redirect.
      if (pushEnabled && role === "user") {
        await pushService?.recordWatch(c.var.userEmail, agentId, threadId);
      }

      return c.redirect(backUrl, 302);
    },
  );

  app.post(
    "/admin/chat/:agentId/threads/:threadId/rename",
    requireAuth,
    async (c) => {
      if (
        !(await canAccessChat(
          c.var.userEmail,
          c.var.isAdmin,
          c.req.param("agentId") ?? "",
          c.req.param("threadId"),
        ))
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const agentId = c.req.param("agentId");
      const threadId = c.req.param("threadId");
      const backUrl = `/admin/chat/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`;

      if (!chatClient) {
        return c.redirect(backUrl, 302);
      }

      let title: string | undefined;
      try {
        const formData = await c.req.formData();
        title = formData.get("title")?.toString()?.trim() || undefined;
      } catch {
        return c.redirect(backUrl, 302);
      }

      // Guard: skip the API call when title is blank to avoid a silent no-op PATCH
      if (!title) {
        return c.redirect(backUrl, 302);
      }

      try {
        await chatClient.updateThread(threadId, { title });
      } catch {
        // swallow — redirect back regardless
      }

      return c.redirect(backUrl, 302);
    },
  );

  app.post(
    "/admin/chat/:agentId/threads/:threadId/delete",
    requireAuth,
    async (c) => {
      if (
        !(await canAccessChat(
          c.var.userEmail,
          c.var.isAdmin,
          c.req.param("agentId") ?? "",
          c.req.param("threadId"),
        ))
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const agentId = c.req.param("agentId");
      const threadId = c.req.param("threadId");

      if (!chatClient) {
        return c.redirect(
          `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
          302,
        );
      }

      try {
        await chatClient.deleteThread(threadId);
      } catch {
        // swallow — redirect back regardless
      }

      return c.redirect(
        `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
        302,
      );
    },
  );

  // ─── Chat JSON API routes ─────────────────────────────────────────────────

  app.get(
    "/admin/chat/:agentId/threads/:threadId/messages.json",
    requireAuth,
    async (c) => {
      if (
        !(await canAccessChat(
          c.var.userEmail,
          c.var.isAdmin,
          c.req.param("agentId") ?? "",
          c.req.param("threadId"),
        ))
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const agentId = c.req.param("agentId");
      const threadId = c.req.param("threadId");
      // ?since=<messageId> → incremental poll: only messages after that id.
      const since = c.req.query("since") || undefined;

      if (!chatClient) {
        return c.json({ messages: [] });
      }

      try {
        const result = await chatClient.listMessages(threadId);
        // Track retryBody (CFB-2.4) over the FULL ordered list — not the
        // ?since-filtered slice — so a retry button on a polled-in error
        // reply still resolves to its originating user message even when
        // that user message was delivered in an earlier poll response.
        const retryBodyByMessageId = new Map<string, string | null>();
        let lastUserBody: string | null = null;
        for (const m of result.messages) {
          retryBodyByMessageId.set(m.id, lastUserBody);
          if (m.role === "user") lastUserBody = m.body;
        }
        // ?since filtering is applied here at the admin (server) layer over the
        // full ordered list, so it works regardless of the chat client impl.
        const ordered = since
          ? filterSince(result.messages, since)
          : result.messages;
        // Emit an explicit field set rather than spreading the upstream
        // message: the chat service once leaked its raw `attachmentBytes`
        // column here, which JSON-expanded a few MB of audio into ~36 MB per
        // poll and OOM-killed this service. The browser's poll loop reads
        // id/role/createdAt/repliedAt/progressPhase/progressSeq/bubbleHtml.
        // bubbleHtml is the server-rendered bubble so polled bubbles are
        // byte-identical to a full reload's.
        const messages = ordered.map((m) =>
          toPolledMessage(m, {
            bubbleHtml: renderChatMessageBubble(
              m,
              retryBodyByMessageId.get(m.id) ?? null,
              agentId,
            ),
          }),
        );
        return c.json({ messages });
      } catch {
        return c.json({ messages: [] });
      }
    },
  );

  app.post(
    "/admin/chat/:agentId/threads/:threadId/messages.json",
    requireAuth,
    async (c) => {
      if (
        !(await canAccessChat(
          c.var.userEmail,
          c.var.isAdmin,
          c.req.param("agentId") ?? "",
          c.req.param("threadId"),
        ))
      ) {
        return new Response("Forbidden", { status: 403 });
      }

      const sendBlocked = await chatSendBlockedMessage(
        c.req.param("agentId") ?? "",
        c.var.isAdmin,
      );
      if (sendBlocked) {
        return c.json(
          { error: "account_suspended", message: sendBlocked },
          403,
        );
      }

      const threadId = c.req.param("threadId");

      if (!chatClient) {
        return c.json({ message: null });
      }

      let body: string | undefined;
      try {
        const jsonBody = await c.req.json<{ body?: string }>();
        body = jsonBody.body?.trim();
      } catch {
        return c.json({ message: null }, 400);
      }

      if (!body) {
        return c.json({ message: null }, 400);
      }

      try {
        const message = await chatClient.createMessage(threadId, "user", body);
        if (pushEnabled) {
          await pushService?.recordWatch(
            c.var.userEmail,
            c.req.param("agentId"),
            threadId,
          );
        }
        return c.json({ message });
      } catch {
        return c.json({ message: null }, 500);
      }
    },
  );

  // ─── Web Push routes (CFB-4.2) ────────────────────────────────────────────
  // All 503 when push is not fully configured server-side, so the client-side
  // toggle (which is itself absent in that case) degrades cleanly.

  app.post("/admin/chat/:agentId/push/subscribe", requireAuth, async (c) => {
    if (
      !(await canAccessChat(
        c.var.userEmail,
        c.var.isAdmin,
        c.req.param("agentId") ?? "",
        c.req.param("threadId"),
      ))
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!pushEnabled) return c.json({ error: "push_disabled" }, 503);

    let payload: { endpoint?: string; p256dh?: string; auth?: string };
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    const { endpoint, p256dh, auth } = payload;
    if (!endpoint || !p256dh || !auth) {
      return c.json({ error: "bad_request" }, 400);
    }
    const result = await pushService?.subscribe(
      c.var.userEmail,
      endpoint,
      p256dh,
      auth,
    );
    if (!result?.ok) {
      if (result?.reason === "store_failed") {
        return c.json({ error: "store_failed" }, 500);
      }
      return c.json({ error: "push_disabled" }, 503);
    }
    return c.json({ ok: true });
  });

  app.post("/admin/chat/:agentId/push/unsubscribe", requireAuth, async (c) => {
    if (
      !(await canAccessChat(
        c.var.userEmail,
        c.var.isAdmin,
        c.req.param("agentId") ?? "",
        c.req.param("threadId"),
      ))
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!pushEnabled) return c.json({ error: "push_disabled" }, 503);

    let endpoint: string | undefined;
    try {
      endpoint = (await c.req.json<{ endpoint?: string }>()).endpoint;
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!endpoint) return c.json({ error: "bad_request" }, 400);
    // Scoped to the caller (userEmail) inside PushService.unsubscribe so a
    // stale endpoint can't be used to prune another user's subscription.
    const result = await pushService?.unsubscribe(c.var.userEmail, endpoint);
    if (!result?.ok) {
      return c.json({ error: "push_disabled" }, 503);
    }
    return c.json({ ok: true });
  });

  // Inbound webhook the chat service calls when an agent posts a reply, so the
  // watching user(s) get notified. Authenticated by a shared bearer token
  // (SHIPWRIGHT_ADMIN_PUSH_WEBHOOK_TOKEN) — NOT a user session — since the
  // caller is a service, not a browser.
  app.post("/admin/push/notify", async (c) => {
    if (!pushEnabled || !pushService || !pushWebhookToken) {
      return c.json({ error: "push_disabled" }, 503);
    }
    const auth = c.req.header("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!presented || presented !== pushWebhookToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: {
      threadId?: string;
      agentId?: string;
      title?: string | null;
      preview?: string | null;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!body.threadId || !body.agentId) {
      return c.json({ error: "bad_request" }, 400);
    }
    const result = await pushService.notifyThreadReply({
      threadId: body.threadId,
      agentId: body.agentId,
      title: body.title ?? null,
      preview: body.preview ?? null,
    });
    return c.json({ ok: true, ...result });
  });

  // ─── Agent delete (danger zone) ───────────────────────────────────────────

  app.post("/admin/agents/:id/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (
      !(await assertCanManageAgent(agentId, c.var.userEmail, c.var.isAdmin))
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      // Full teardown: K8s workload, task-store + chat-service tokens/threads,
      // optional Slack app deletion, then the Agent row itself (deleted last,
      // only if every automatable step succeeded). Same orchestration DELETE
      // /agents/:id uses (agents-api.ts) — this was previously a separate
      // inline provisioner.deprovision() + direct-prisma-delete path that had
      // drifted from it. deleteAgentFully() still takes prisma directly (its
      // own dependency shape, not routed through AgentService).
      const result = await deleteAgentFully(agentId, {
        prisma,
        provisioner,
        serviceIntegrations,
        chatService,
        slack,
        decrypt,
      });
      if (!result.agentDeleted) {
        // Cleanup is incomplete — keep the operator on the agent's own page
        // (NOT the agents list) so the agent doesn't appear deleted while
        // steps still need a retry.
        const failedSteps = result.failed.map((f) => f.step).join(", ");
        return c.redirect(
          `/admin/agents/${agentId}?error=${encodeURIComponent(
            `Cleanup incomplete — retry. Failed steps: ${failedSteps}`,
          )}`,
          302,
        );
      }
      const manualStepsParam =
        result.manualStepsRequired.length > 0
          ? `&manualSteps=${encodeURIComponent(
              JSON.stringify(result.manualStepsRequired),
            )}`
          : "";
      return c.redirect(
        `/admin/agents?success=deleted${manualStepsParam}`,
        302,
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? encodeURIComponent(err.message)
          : "delete_failed";
      return c.redirect(`/admin/agents/${agentId}?error=${msg}`, 302);
    }
  });

  return app;
}
