/**
 * agent/src/runtime/boot.ts
 * Agent runtime boot sequence, exported as startAgent(extensions).
 *
 * A consumer entry (agent/src/index.ts for the coding agent) calls startAgent
 * with the extension factories for its agent type — the runtime itself imports
 * no agent-type module, so it can be extracted and shared.
 *
 * Boot order:
 *  1. ensureAgentHome
 *  2. Health server — binds immediately so kubelet probes stay green during setup
 *  3. runMiseStartup + installPlugins (defaults)
 *  4. Config sync — fetch AgentConfigBundle, apply env, install agent plugins (await first)
 *  5. reconcileSystemCrons — best-effort, non-fatal
 *  6. Cron sync loop (60s)
 *  7. Slack Bolt Socket Mode app
 *  8. Graceful SIGTERM/SIGINT shutdown
 */

import { join } from "node:path";
import { initSentry } from "@app-vitals/agent-lib/sentry";
import * as Sentry from "@sentry/bun";
import { WebClient } from "@slack/web-api";
import nodeCron from "node-cron";
import { agentAccountStatusRef } from "./agent-account-status-ref.ts";
import {
  type AgentExtensionContext,
  type AgentExtensionFactory,
  composeExtensions,
  planCronSchedule,
  runPeriodicPasses,
} from "./agent-extension.ts";
import { agentReposRef } from "./agent-repos-ref.ts";
import {
  agentSlackMembershipRef,
  resolveSlackMembership,
} from "./agent-slack-membership-ref.ts";
import { agentTrialExpiryRef } from "./agent-trial-expiry-ref.ts";
import { applyEnvToProcess } from "./anthropic-federation-guard.ts";
import { createChatPoller } from "./chat-poller.ts";
import {
  HttpChatTokenReporter,
  NoopChatTokenReporter,
} from "./chat-token-reporter.ts";
import {
  createRunClaude,
  type EarlySessionIdCallback,
  type ProgressCallback,
  setLiveClaudeConfig,
} from "./claude.ts";
import { bunExec, detectClaudeCodeVersion } from "./claude-version.ts";
import { cleanupAfterDaysRef } from "./cleanup-after-days-ref.ts";
import { SystemClock } from "./clock.ts";
import { createConfig } from "./config.ts";
import { createContextStampReader } from "./context-stamp.ts";
import { reportCronFailure } from "./cron-failure-reporter.ts";
import type { CronHandlerDeps } from "./cron-handler.ts";
import { handleCronRequest } from "./cron-handler.ts";
import {
  HttpCronRunReporter,
  NoopCronRunReporter,
} from "./cron-run-reporter.ts";
import { markdownToSlack } from "./format.ts";
import { buildGitHubAuthDeps } from "./github-auth-deps.ts";
import {
  githubAuthActiveRef,
  githubInstallationsManagerRef,
  reconcileGitHubInstallations,
  startGitHubAuthIfPossible,
} from "./github-auth-startup.ts";
import {
  HttpGitHubInstallationsReporter,
  NoopGitHubInstallationsReporter,
} from "./github-installations-reporter.ts";
import {
  claudeVersionState,
  DEFAULT_HEALTH_PORT,
  markSlackConnected,
  markSlackDisconnected,
  startHealthServer,
} from "./health.ts";
import { HttpChatServiceClient } from "./http-chat-service-client.ts";
import { buildLogPrefix } from "./log-prefix.ts";
import { validatePiperVoice } from "./piper-voice.ts";
import {
  createFileSessionStore,
  startSessionPruner,
  threadKey,
} from "./sessions.ts";
import { ensureAgentHome, installPlugins, runMiseStartup } from "./setup.ts";
import { setupGitHubAuth } from "./setup-github-auth.ts";
import { HttpShipwrightRuntimeClient } from "./shipwright-runtime-client.ts";
import { createSlackApp, hasSlackCredentials } from "./slack.ts";
import {
  type StartableSlackApp,
  slackClientRef,
  startSlackIfPossible,
} from "./slack-startup.ts";
import { sendBackOnlineDm } from "./startup-dm.ts";
import {
  buildProductionDeps as buildSyncConfigCloneDeps,
  syncClonedRepos,
} from "./sync-config-clone.ts";
import { resolveDisplayName, resolveUserEmail } from "./users.ts";
import { synthesizeSpeech, transcribeAudio } from "./voice.ts";
import {
  buildProductionDeps as buildWorktreeReaperDeps,
  reconcileStaleWorktrees,
} from "./worktree-reaper.ts";

export async function startAgent(
  extensions: AgentExtensionFactory[] = [],
): Promise<void> {
  const agentHome = process.env.AGENT_HOME ?? "/data/agent-home";
  const { config } = createConfig(agentHome);

  // Discovery-based startup validation: fail loudly now (log) rather than
  // silently at speak time if PIPER_VOICE doesn't match a baked voice.
  const resolvedPiperVoice = validatePiperVoice(config.voice.piperVoice);
  console.log(`[agent] piper voice resolved: ${resolvedPiperVoice}`);

  // ─── Agent ID (hoisted for use in console monkeypatch) ────────────────────────

  const agentId = config.shipwright.agentId;

  // ─── Timestamp + agent ID prefix ──────────────────────────────────────────────

  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const timestamp = new Date().toISOString();
      const prefix = buildLogPrefix(agentId, timestamp);
      orig(prefix, ...args);
    };
  }

  // ─── Sentry (no-op when SENTRY_DSN is unset) ─────────────────────────────────
  // Placed AFTER the console monkeypatch above so Sentry's consoleLoggingIntegration
  // wraps on top of it — this captures clean log args in Sentry while local
  // output keeps its timestamp prefix.

  initSentry({ service: "agent", agentId });

  // ─── Step 1: Agent home ───────────────────────────────────────────────────────

  ensureAgentHome(config.paths.home);
  console.log(`[agent] agent home initialized: ${config.paths.home}`);

  // ─── Step 2: Health server ────────────────────────────────────────────────────
  // Bind before mise/plugin install so kubelet liveness probes don't time out
  // during a slow toolchain install (e.g. compiling Python from source).

  const slackClock = SystemClock();
  const sessions = createFileSessionStore(config.paths.sessions);
  // DTW-1.3: make the store's TTL prune real. Slack thread keys are re-read (so
  // they expire lazily via get()), but a dev-task dispatch's per-dispatch session
  // key is written once and never read again — its owning resume loop clears it
  // on exit, and this sweep is the backstop for the ones an abrupt process kill
  // strands.
  startSessionPruner(sessions, "sessions.json");

  // Slack is optional (see Step 7 + startSlackIfPossible in slack-startup.ts).
  // Building a WebClient around an empty token would make every downstream
  // call fail with `invalid_auth` instead of being skipped, so a chat-only
  // agent gets no client at all and callers branch on `undefined`.
  //
  // buildSlackAppConfig() reads live process.env rather than the static
  // `config` snapshot taken above at module-load time — SLK-1.1: credentials
  // saved to the admin DB after boot only reach this process via syncConfig()'s
  // `applyEnvToProcess(bundle.env)`, so re-reading `config.slack.*`
  // here would keep seeing the boot-time (absent) values forever.
  function buildSlackAppConfig() {
    return {
      botToken: process.env.SLACK_BOT_TOKEN ?? "",
      appToken: process.env.SLACK_APP_TOKEN ?? "",
      signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
    };
  }
  const runner = createRunClaude(
    Bun.spawn,
    sessions,
    undefined,
    config.paths.workspace,
    process.env.SENTRY_DSN ? Sentry : undefined,
    undefined,
    undefined,
    undefined,
    config.claude.timeoutMs,
    config.claude.idleTimeoutMs,
  );

  const cronRunReporter =
    config.shipwright.apiUrl &&
    config.shipwright.apiKey &&
    config.shipwright.agentId
      ? new HttpCronRunReporter({
          apiUrl: config.shipwright.apiUrl,
          agentId: config.shipwright.agentId,
          apiKey: config.shipwright.apiKey,
        })
      : undefined;

  const chatTokenReporter =
    config.shipwright.apiUrl &&
    config.shipwright.apiKey &&
    config.shipwright.agentId
      ? new HttpChatTokenReporter({
          apiUrl: config.shipwright.apiUrl,
          agentId: config.shipwright.agentId,
          apiKey: config.shipwright.apiKey,
        })
      : new NoopChatTokenReporter();

  const githubInstallationsReporter =
    config.shipwright.apiUrl &&
    config.shipwright.apiKey &&
    config.shipwright.agentId
      ? new HttpGitHubInstallationsReporter({
          apiUrl: config.shipwright.apiUrl,
          agentId: config.shipwright.agentId,
          apiKey: config.shipwright.apiKey,
        })
      : new NoopGitHubInstallationsReporter();

  // Always-loaded-context stamp (context-stamp.ts): fingerprints the workspace
  // CLAUDE.md + its imports + no-`paths` rules + the plugin version, read once
  // per run so cron-run rows can be grouped by what the model was given. The
  // plugin.json path resolves to the in-image copy of the shipwright plugin,
  // whose version the Dockerfile stamps at build time (sync-version.ts).
  const contextStamp = createContextStampReader({
    workspace: config.paths.workspace,
    pluginJsonPath: join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "plugins",
      "shipwright",
      ".claude-plugin",
      "plugin.json",
    ),
    claudeCodeVersion: () => claudeVersionState.version,
  });

  const cronDeps: CronHandlerDeps = {
    // SLK-1.1: a getter, not a plain field — Slack may start after boot (see
    // slack-startup.ts's startSlackIfPossible()), so cron dispatch must read
    // the live slackClientRef on every fire rather than closing over a
    // boot-time `undefined` forever.
    get slack() {
      return slackClientRef.get();
    },
    runner: (
      message: string,
      onProgress?: ProgressCallback,
      extraEnv?: Record<string, string>,
      onEarlySessionId?: EarlySessionIdCallback,
    ) =>
      runner(
        message,
        undefined,
        onProgress,
        undefined,
        extraEnv,
        onEarlySessionId,
      ),
    formatter: markdownToSlack,
    onSession: async (channel: string, ts: string, sessionId: string) => {
      await sessions.set(threadKey(channel, ts), sessionId);
    },
    synthesizeSpeechFn: synthesizeSpeech,
    voiceConfig: config.voice,
    workspace: config.paths.workspace,
    alertsChannel: config.alerts.channel,
    cronRunReporter,
    agentId: config.shipwright.agentId,
    contextStamp,
  };

  // ARD-3.1: the agent-type extension seam (agent-extension.ts). The consumer
  // entry (index.ts for the coding agent) passes the extension factories; they
  // are built here (after every dep they need exists, before config sync / cron
  // sync call their hooks) and composed into the single extension the rest of
  // boot talks to.
  const extensionContext: AgentExtensionContext = {
    config,
    runner,
    sessions,
    cronRunReporter,
    contextStamp,
    sentryClient: process.env.SENTRY_DSN ? Sentry : undefined,
  };
  const extension = composeExtensions(
    extensions.map((createExtension) => createExtension(extensionContext)),
  );

  // SLK-1.1: shared Slack-start deps, built once so both the Step 4
  // (config-sync) and Step 7 (boot) call sites of startSlackIfPossible()
  // operate on the same module-scope `app`/client-ref state — a start from
  // either call site is visible to the other via isAppStarted()/slackClientRef.
  let app: ReturnType<typeof createSlackApp> | undefined;

  function buildSlackApp() {
    return createSlackApp(
      (
        message: string,
        sessionKey?: string,
        onProgress?: ProgressCallback,
        extraEnv?: Record<string, string>,
      ) => runner(message, sessionKey, onProgress, undefined, extraEnv),
      markdownToSlack,
      threadKey,
      undefined, // appFactory — default Bolt App
      buildSlackAppConfig(),
      process.env.SENTRY_DSN ? Sentry : undefined,
      undefined, // fileDownloaderFn — default
      config.voice,
      undefined, // transcribeAudioFn — default
      synthesizeSpeech,
      (userId, client) => resolveDisplayName(userId, client),
      undefined, // botUserId — resolved by Bolt
      undefined, // conversationsRepliesFn — default
      (key) => sessions.get(key),
      undefined, // blocksConverter — default
      chatTokenReporter,
      (userId, client) => resolveUserEmail(userId, client),
      agentSlackMembershipRef,
      agentTrialExpiryRef,
      agentAccountStatusRef,
    );
  }

  const slackStartDeps = {
    buildSlackConfig: buildSlackAppConfig,
    hasSlackCredentials,
    isAppStarted: () => app !== undefined,
    createSlackApp: buildSlackApp,
    setApp: (started: StartableSlackApp) => {
      app = started as ReturnType<typeof createSlackApp>;
    },
    createSlackClient: () => new WebClient(buildSlackAppConfig().botToken),
    setSlackClient: slackClientRef.set,
    markSlackConnected,
    sendBackOnlineDm: (client: WebClient) =>
      sendBackOnlineDm(client, config.owner.user),
  };

  // ABF-2.1: shared GitHub-App-auth-start deps, built once so syncConfig()'s
  // retry call site (below) reuses the same live process.env reference and
  // production wiring (spawnSync/writeToken/tokenPath/credentialHelperPath)
  // as entrypoint-main.ts's one-shot boot call — see github-auth-deps.ts.
  // Unlike Slack, there is no boot-time call site here: entrypoint-main.ts
  // already runs setupGitHubAuth() once at boot in its own (separate)
  // process, and this process's first syncConfig() tick (awaited below,
  // before Step 5) is this process's own "boot" for GitHub App auth.
  const GITHUB_AUTH_SCRIPTS_BIN = join(
    import.meta.dir,
    "..",
    "..",
    "scripts",
    "bin",
  );
  const githubAuthStartDeps = {
    env: process.env as Record<string, string | undefined>,
    isActive: githubAuthActiveRef.isActive,
    markActive: () => githubAuthActiveRef.setActive(true),
    setupGitHubAuth: () =>
      setupGitHubAuth(
        buildGitHubAuthDeps(agentHome, GITHUB_AUTH_SCRIPTS_BIN, {
          withInstallations: true,
          installationsReporter: githubInstallationsReporter,
        }),
      ),
  };

  // RSF-4.1: shared auto-clone deps for syncConfig()'s repo-clone step, built
  // once so reposDir (join(config.paths.workspace, "repos") — the convention
  // confirmed by setup.ts/worktree-reaper.ts/pr-state-reconciler.ts/
  // check-helpers.ts) and getScopedRepos (agentReposRef.get, read live on every
  // call) aren't re-wired per tick.
  const syncConfigCloneDeps = buildSyncConfigCloneDeps({
    getScopedRepos: agentReposRef.get,
    reposDir: join(config.paths.workspace, "repos"),
  });

  const healthPort = Number(
    process.env.SHIPWRIGHT_HEALTH_PORT ?? DEFAULT_HEALTH_PORT,
  );
  claudeVersionState.version = await detectClaudeCodeVersion(bunExec);
  console.log(`[agent] claude code version: ${claudeVersionState.version}`);
  startHealthServer(
    healthPort,
    cronDeps,
    slackClock,
    undefined,
    process.env.SENTRY_DSN ? Sentry : undefined,
  );
  console.log(`[agent] health server on port ${healthPort}`);

  // ─── Step 3: mise + default plugins ──────────────────────────────────────────

  await runMiseStartup(config.paths.home);
  console.log("[agent] mise startup complete");

  await installPlugins();
  console.log("[agent] default plugin install complete");

  // ─── Runtime client ───────────────────────────────────────────────────────────

  const runtimeClient =
    config.shipwright.apiUrl && config.shipwright.apiKey
      ? new HttpShipwrightRuntimeClient({
          apiUrl: config.shipwright.apiUrl,
          apiKey: config.shipwright.apiKey,
        })
      : null;

  // ─── Step 4: Config sync ──────────────────────────────────────────────────────

  if (runtimeClient && agentId) {
    let configNotFoundLogged = false;

    async function syncConfig() {
      if (!runtimeClient || !agentId) return;
      try {
        const bundle = await runtimeClient.getAgentConfigBundle(agentId);
        configNotFoundLogged = false;

        // Apply env vars — log changed keys (mask values). WIF-2.1: under
        // federation the Anthropic credential keys never reach process.env,
        // even if a stale admin still serves them.
        const changed = applyEnvToProcess(bundle.env);
        if (changed.length > 0) {
          console.log(`[config-sync] updated: ${changed.join(", ")}`);
        }

        // Sync allowed tools
        const allowedTools = bundle.allowedTools ?? [];
        if (allowedTools.length > 0) {
          process.env.AGENT_ALLOWED_TOOLS = JSON.stringify(allowedTools);
        }

        // Push new config into the live claude runner
        setLiveClaudeConfig({
          model: process.env.ANTHROPIC_MODEL ?? config.claude.model,
          fallbackModel: process.env.ANTHROPIC_FALLBACK_MODEL,
          effortLevel: process.env.ANTHROPIC_EFFORT_LEVEL,
          allowedTools,
        });

        // Install agent-specific plugins from bundle (non-fatal)
        if (bundle.plugins?.length) {
          await installPlugins(undefined, undefined, bundle.plugins).catch(
            (err) =>
              console.warn(
                "[config-sync] agent plugin install failed (non-fatal):",
                (err as Error).message,
              ),
          );
        }

        // Sync the agent's scoped repos live ref
        agentReposRef.set(bundle.repos);

        // MGI-2.4: re-run GitHub App installation discovery against the new
        // scope — a no-op until App auth has activated via the installations
        // manager (startGitHubAuthIfPossible below). Never starts a second
        // refresh interval; reconcile() itself never throws.
        await reconcileGitHubInstallations(
          githubInstallationsManagerRef,
          agentReposRef,
        );

        // RSF-4.1: auto-clone any repo that's newly configured but not yet on
        // disk — reuses computeMissingClones()'s existing skip-if-exists plan
        // (the same planner the manual agent-workspace-pull CLI and hitl.ts
        // already use) against the real repos/ dir. Awaited within this tick
        // (not backgrounded) per explicit product decision — but the `gh`
        // child process itself is spawned asynchronously, so the clone never
        // blocks this process's event loop (and therefore never stalls the
        // health-probe server sharing it).
        // syncClonedRepos() itself catches and logs each repo's clone failure
        // without throwing; this try/catch is defense-in-depth against an
        // unexpected failure in the plan computation itself (e.g. a bad
        // exists() call), so one bad tick's repo-clone step can never prevent
        // the rest of this tick's config sync (or crash the process) — a
        // repo that fails to clone simply stays missing and is retried next
        // tick.
        try {
          await syncClonedRepos(syncConfigCloneDeps);
        } catch (err) {
          console.error(
            "[config-sync] repo clone sync failed (non-fatal):",
            err instanceof Error ? err.message : String(err),
          );
        }

        // Agent-type extension: the coding extension syncs the PR-policy refs
        // (review/patch author allowlists, allow-self-review, cleanup-merged-
        // worktrees) here.
        extension.onConfigSync?.(bundle);

        // Sync the agent's Slack-membership-restriction live ref
        agentSlackMembershipRef.set(
          resolveSlackMembership(
            bundle.restrictSlackToMembers,
            bundle.memberEmails,
          ),
        );

        // Sync the agent's trial-expiry live ref (ATE-3.1) — read by
        // agent/src/runtime/slack.ts's isTrialExpired() gate to block Slack access
        // once the trial has passed.
        agentTrialExpiryRef.set(
          bundle.trialExpiresAt ? new Date(bundle.trialExpiresAt) : null,
        );

        // Sync the agent's owning-account status live ref (SSP-8.3) — read by
        // agent/src/runtime/slack.ts's isAccountPaused() gate to pause Slack access
        // while the account is suspended or trial_expired.
        agentAccountStatusRef.set(bundle.accountStatus ?? null);

        // Sync the agent's cleanup-after-days live ref (APM-1.6) — read by the
        // runtime's worktree reaper.
        cleanupAfterDaysRef.set(bundle.cleanupAfterDays);
      } catch (err) {
        if (
          (err as { statusCode?: number }).statusCode === 404 &&
          !configNotFoundLogged
        ) {
          console.log(
            "[config-sync] no config bundle found — skipping env sync",
          );
          configNotFoundLogged = true;
          return;
        }
        console.error(
          "[config-sync] failed to fetch config bundle:",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      // SLK-1.1: retry Slack startup on every successful tick — a no-op unless
      // credentials are newly complete against live process.env AND Bolt
      // hasn't already started (see startSlackIfPossible's own guards). Kept
      // in its own try/catch, separate from the fetch/env-sync try above, so a
      // Bolt start failure (e.g. a bad token that fails Socket Mode auth) is
      // logged distinctly rather than being misreported as a config-bundle
      // fetch failure — and so it can never mask an already-successful env
      // sync that happened earlier in this same tick.
      try {
        if (await startSlackIfPossible(slackStartDeps)) {
          console.log("[config-sync] Slack app started — running");
        }
      } catch (err) {
        console.error(
          "[config-sync] Slack startup failed:",
          err instanceof Error ? err.message : String(err),
        );
      }

      // ABF-2.1: retry GitHub App auth setup on every successful tick — a
      // no-op unless GH_APP_ID/GH_APP_PRIVATE_KEY are present in live
      // process.env AND setup hasn't already activated in this process (it
      // stays inactive — and is retried — while there is no
      // GH_APP_INSTALLATION_ID pin and no usable in-scope installation) (see startGitHubAuthIfPossible's own
      // guards). Kept in its own try/catch, separate from both the
      // fetch/env-sync try above and the Slack-retry try above, so a GitHub
      // auth start failure is logged distinctly rather than being
      // misreported as either of those, and so it can never mask an
      // already-successful env sync or Slack start earlier in this same tick.
      try {
        if (await startGitHubAuthIfPossible(githubAuthStartDeps)) {
          console.log("[config-sync] GitHub App auth configured — running");
        }
      } catch (err) {
        console.error(
          "[config-sync] GitHub App auth startup failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Await first sync so ANTHROPIC_API_KEY is set before Slack starts
    await syncConfig();
    setInterval(() => void syncConfig(), 60_000);
    console.log("[agent] config sync started (60s interval)");
  }

  // ─── Step 5: reconcileSystemCrons — best-effort ───────────────────────────────

  if (runtimeClient && agentId) {
    try {
      await runtimeClient.reconcileSystemCrons(agentId);
      console.log("[agent] system crons reconciled");
    } catch (err) {
      console.error(
        "[agent] reconcileSystemCrons failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ─── Step 5b: Periodic passes — self-heal stale state ─────────────────────────
  // Deliberately its own interval, independent of syncConfig/syncCrons above and
  // the loop-orchestrator's per-tick candidate collection: these only need to run
  // every 30-60 min, not every minute. Each pass has its own deps (built lazily on
  // first tick so a not-yet-ready workspace/GH auth at boot can't crash agent
  // startup) and its own try/catch (see runPeriodicPasses) so one failing pass
  // never blocks the others.
  //
  // WTR-1.4's reconcileStaleWorktrees — a pure-filesystem sweep that force-removes
  // worktrees/<repo>-<branch> dirs older than cleanup_after_days — is a runtime
  // pass (ARD-3.1): it runs first, before the extension's periodic passes (the
  // coding extension's PR-state/review-state/claim-invariant/census passes). The
  // passes are independent, so the reaper moving ahead of them is the one
  // pass-order change in this refactor.
  if (runtimeClient && agentId) {
    let worktreeReaperDeps:
      | ReturnType<typeof buildWorktreeReaperDeps>
      | undefined;

    const runtimePasses = [
      {
        name: "worktree-reaper",
        logPrefix: "[pr-state-reconciler:worktree-reaper]",
        run: async () => {
          worktreeReaperDeps ??= buildWorktreeReaperDeps({
            getScopedRepos: agentReposRef.get,
          });
          await reconcileStaleWorktrees(worktreeReaperDeps);
        },
      },
    ];

    async function runPeriodicTick() {
      await runPeriodicPasses([
        ...runtimePasses,
        ...(extension.periodicPasses ?? []),
      ]);
    }

    const reconcilerIntervalMs = Number(
      process.env.SHIPWRIGHT_PR_STATE_RECONCILER_INTERVAL_MS ?? 45 * 60_000,
    );
    setInterval(() => void runPeriodicTick(), reconcilerIntervalMs);
    console.log(
      `[agent] PR state reconciler started (${reconcilerIntervalMs}ms interval)`,
    );
  }

  // ─── Step 6: Cron sync loop ───────────────────────────────────────────────────

  const cronTasks = new Map<string, ReturnType<typeof nodeCron.schedule>>();

  if (runtimeClient && agentId) {
    async function syncCrons() {
      if (!runtimeClient || !agentId) return;
      let jobs: Awaited<ReturnType<typeof runtimeClient.listAgentCronJobs>>;
      try {
        jobs = await runtimeClient.listAgentCronJobs(agentId);
      } catch (err) {
        console.error(
          "[cron-sync] failed to fetch cron jobs:",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      // Hand the extension the fresh job list (every tick, regardless of whether
      // any job gets (re)scheduled below — the coding extension keeps its live
      // loop jobs ref current this way), then classify this agent's own job
      // list: which jobs get an independent schedule, and with which dispatch
      // kind (loop vs. generic). See planCronSchedule in agent-extension.ts and
      // the coding extension's loop-cron-classifier.ts for the full decision.
      const scheduled = planCronSchedule(extension, jobs);
      const desired = new Map(scheduled.map((entry) => [entry.job.id, entry]));

      // Cancel removed/disabled jobs
      for (const [id, task] of cronTasks) {
        if (!desired.has(id)) {
          task.stop();
          cronTasks.delete(id);
          console.log(`[cron-sync] unscheduled ${id}`);
        }
      }

      // Schedule new jobs
      for (const [id, entry] of desired) {
        if (!cronTasks.has(id)) {
          const { job, dispatch } = entry;
          const task = nodeCron.schedule(job.schedule, async () => {
            console.log(`[cron] firing job ${id}`);
            try {
              if (dispatch === "loop") {
                if (!extension.dispatchLoop) {
                  throw new Error(
                    `cron job ${id} classified as loop but the agent extension has no dispatchLoop`,
                  );
                }
                await extension.dispatchLoop(id);
              } else {
                await handleCronRequest(
                  {
                    jobId: id,
                    prompt: job.prompt,
                    channel: job.channel ?? undefined,
                    user: job.user ?? undefined,
                    silent: job.silent,
                    preCheck: job.preCheck ?? undefined,
                  },
                  cronDeps,
                );
              }
            } catch (err) {
              await reportCronFailure(id, err, {
                cronRunReporter: cronRunReporter ?? new NoopCronRunReporter(),
                sentryClient: process.env.SENTRY_DSN ? Sentry : undefined,
                clock: SystemClock(),
              });
            }
          });
          cronTasks.set(id, task);
          console.log(`[cron-sync] scheduled ${id} (${job.schedule})`);
        }
      }
    }

    void syncCrons();
    setInterval(() => void syncCrons(), 60_000);
    console.log("[agent] cron sync started (60s interval)");
  }

  // ─── Step 6b: Chat poll loop ──────────────────────────────────────────────────
  // Start when both SHIPWRIGHT_CHAT_SERVICE_URL and SHIPWRIGHT_CHAT_SERVICE_TOKEN
  // are set. Uses a separate session store (chat-sessions.json) for per-thread
  // Claude session continuity across restarts.

  if (config.chat.serviceUrl && config.chat.serviceToken) {
    const chatSessions = createFileSessionStore(config.paths.chatSessions);
    const chatRunner = createRunClaude(
      Bun.spawn,
      chatSessions,
      undefined,
      config.paths.workspace,
      process.env.SENTRY_DSN ? Sentry : undefined,
      undefined,
      undefined,
      undefined,
      config.claude.timeoutMs,
      config.claude.idleTimeoutMs,
    );
    const chatClient = new HttpChatServiceClient({
      baseUrl: config.chat.serviceUrl,
      token: config.chat.serviceToken,
    });
    const chatPoller = createChatPoller({
      client: chatClient,
      runner: chatRunner,
      intervalMs: config.chat.pollIntervalMs ?? 5_000,
      workspaceDir: config.paths.workspace,
      transcribeAudioFn: transcribeAudio,
      synthesizeSpeechFn: synthesizeSpeech,
      voiceConfig: config.voice,
    });
    chatPoller.start();
    console.log(
      `[agent] chat poll loop started (${config.chat.pollIntervalMs ?? 5_000}ms interval)`,
    );
  }

  // ─── Step 7: Slack Bolt Socket Mode (only when credentials present) ───────────
  // Bolt's Socket Mode throws "Must provide an App-Level Token" if constructed
  // without an appToken, so the agent runs Slack ONLY when both tokens are present.
  // Absent creds → offline mode: skip Slack, keep health green, interact via the chat UI.
  //
  // SLK-1.1: startSlackIfPossible() (slack-startup.ts) is the single shared
  // start path — attempted here AND again from inside syncConfig()'s success
  // branch (Step 4, above — slackStartDeps is built earlier in this file so
  // both call sites can share it). In the common case where credentials are
  // already present at boot, Step 4's `await syncConfig()` (which runs before
  // this point) already starts Slack, making this call a no-op; this call site
  // exists so a config-bundle fetch that 404s or errors on the very first tick
  // doesn't prevent Slack from starting when creds are already in the process
  // env at boot. Every later syncConfig() tick is what retries the start for
  // credentials that arrive after boot (the SLK-1.1 fix). Its own
  // start-in-flight guard makes overlapping call sites racing safe; its own
  // isAppStarted() check makes an already-successful start here a permanent
  // no-op for every later attempt.

  if (await startSlackIfPossible(slackStartDeps)) {
    console.log("[agent] Slack app started — running");
  } else if (!hasSlackCredentials(buildSlackAppConfig())) {
    console.warn(
      "[agent] Slack credentials absent (need SLACK_BOT_TOKEN + SLACK_APP_TOKEN) — " +
        "skipping Slack startup. Offline mode: use the admin chat UI (/admin/chat) to interact.",
    );
  }

  // ─── Step 8: Graceful shutdown ────────────────────────────────────────────────

  let shuttingDown = false;

  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agent] received ${signal}, beginning graceful shutdown`);
    markSlackDisconnected(slackClock);

    // Stop cron tasks so no new Claude work fires during drain
    for (const [id, task] of cronTasks) {
      task.stop();
      console.log(`[agent] cron unscheduled on shutdown: ${id}`);
    }
    cronTasks.clear();

    // Close the Slack socket (bounded — don't let Bolt hang indefinitely).
    // Skipped entirely when Slack never started (offline mode).
    if (app) {
      try {
        await Promise.race([
          app.stop(),
          new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
        ]);
        console.log("[agent] Slack app stopped");
      } catch (err) {
        console.error(
          "[agent] app.stop() failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    console.log("[agent] shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
