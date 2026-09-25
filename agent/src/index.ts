/**
 * agent/src/index.ts
 * Shipwright agent startup entrypoint.
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
import * as Sentry from "@sentry/bun";
import { initSentry } from "@shipwright/lib/sentry";
import { WebClient } from "@slack/web-api";
import nodeCron from "node-cron";
import { agentReposRef } from "./agent-repos-ref.ts";
import {
  agentSlackMembershipRef,
  resolveSlackMembership,
} from "./agent-slack-membership-ref.ts";
import { agentTrialExpiryRef } from "./agent-trial-expiry-ref.ts";
import { createChatPoller } from "./chat-poller.ts";
import {
  HttpChatTokenReporter,
  NoopChatTokenReporter,
} from "./chat-token-reporter.ts";
import { ghGraphql, ghJson } from "./check-helpers.ts";
import {
  buildProductionDeps as buildClaimInvariantReconcilerDeps,
  reconcileClaimInvariant,
} from "./claim-invariant-reconciler.ts";
import {
  createRunClaude,
  type EarlySessionIdCallback,
  type ProgressCallback,
  setLiveClaudeConfig,
} from "./claude.ts";
import { SystemClock } from "./clock.ts";
import { createConfig } from "./config.ts";
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
  startGitHubAuthIfPossible,
} from "./github-auth-startup.ts";
import {
  DEFAULT_HEALTH_PORT,
  markSlackConnected,
  markSlackDisconnected,
  startHealthServer,
} from "./health.ts";
import { HttpChatServiceClient } from "./http-chat-service-client.ts";
import { buildLogPrefix } from "./log-prefix.ts";
import type { CronJobLike } from "./loop-cron-classifier.ts";
import { classifyCronJobsForScheduling } from "./loop-cron-classifier.ts";
import { createJobsRef } from "./loop-jobs-ref.ts";
import { createLoopOrchestratorGetter } from "./loop-orchestrator.ts";
import {
  patchAuthorAllowlistRef,
  resolvePatchAuthorAllowlist,
} from "./patch-author-allowlist-ref.ts";
import { validatePiperVoice } from "./piper-voice.ts";
import {
  buildProductionDeps as buildPrCensusDeps,
  runPrCensus,
} from "./pr-census.ts";
import {
  buildProductionDeps as buildPrStateReconcilerDeps,
  buildReviewStateProductionDeps as buildReviewStateReconcilerDeps,
  reconcilePrState,
  reconcileReviewState,
} from "./pr-state-reconciler.ts";
import {
  resolveReviewAuthorAllowlist,
  reviewAuthorAllowlistRef,
} from "./review-author-allowlist-ref.ts";
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
import { resolveDisplayName, resolveUserEmail } from "./users.ts";
import { synthesizeSpeech, transcribeAudio } from "./voice.ts";
import {
  HttpWorkQueueReporter,
  NoopWorkQueueReporter,
} from "./work-queue-reporter.ts";
import {
  buildProductionDeps as buildWorktreeReaperDeps,
  reconcileStaleWorktrees,
} from "./worktree-reaper.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

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
// `Object.assign(process.env, bundle.env)`, so re-reading `config.slack.*`
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

const workQueueReporter =
  config.shipwright.apiUrl &&
  config.shipwright.apiKey &&
  config.shipwright.agentId
    ? new HttpWorkQueueReporter({
        apiUrl: config.shipwright.apiUrl,
        agentId: config.shipwright.agentId,
        apiKey: config.shipwright.apiKey,
      })
    : new NoopWorkQueueReporter();

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
};

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
const GITHUB_AUTH_SCRIPTS_BIN = join(import.meta.dir, "..", "scripts", "bin");
const githubAuthStartDeps = {
  env: process.env as Record<string, string | undefined>,
  isActive: githubAuthActiveRef.isActive,
  markActive: () => githubAuthActiveRef.setActive(true),
  setupGitHubAuth: () =>
    setupGitHubAuth(buildGitHubAuthDeps(agentHome, GITHUB_AUTH_SCRIPTS_BIN)),
};

const healthPort = Number(
  process.env.SHIPWRIGHT_HEALTH_PORT ?? DEFAULT_HEALTH_PORT,
);
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

      // Apply env vars — log changed keys (mask values)
      const changed: string[] = [];
      for (const key of Object.keys(bundle.env)) {
        if (bundle.env[key] !== process.env[key]) changed.push(key);
      }
      Object.assign(process.env, bundle.env);
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

      // Sync the agent's review-author-allowlist live ref
      reviewAuthorAllowlistRef.set(
        resolveReviewAuthorAllowlist(bundle.reviewAuthorAllowlist),
      );

      // Sync the agent's patch-author-allowlist live ref
      patchAuthorAllowlistRef.set(
        resolvePatchAuthorAllowlist(bundle.patchAuthorAllowlist),
      );

      // Sync the agent's Slack-membership-restriction live ref
      agentSlackMembershipRef.set(
        resolveSlackMembership(
          bundle.restrictSlackToMembers,
          bundle.memberEmails,
        ),
      );

      // Sync the agent's trial-expiry live ref (ATE-3.1) — read by
      // agent/src/slack.ts's isTrialExpired() gate to block Slack access
      // once the trial has passed.
      agentTrialExpiryRef.set(
        bundle.trialExpiresAt ? new Date(bundle.trialExpiresAt) : null,
      );
    } catch (err) {
      if (
        (err as { statusCode?: number }).statusCode === 404 &&
        !configNotFoundLogged
      ) {
        console.log("[config-sync] no config bundle found — skipping env sync");
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
    // no-op unless GH_APP_ID/GH_APP_INSTALLATION_ID/GH_APP_PRIVATE_KEY are
    // newly complete against live process.env AND setup hasn't already
    // succeeded in this process (see startGitHubAuthIfPossible's own
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

// ─── Step 5b: PR state reconciler — self-heals stale state:"open" records ─────
// Crash backstop for the *business state* (state/mergedAt), distinct from
// StaleClaimReaper's *claim* fields — see pr-state-reconciler.ts for the full
// rationale. Deliberately its own interval, independent of syncConfig/
// syncCrons above and the loop-orchestrator's per-tick candidate collection:
// this only needs to run every 30-60 min, not every minute, since it scans
// the bounded state:"open" set and a record naturally drops out of future
// scans once reconciled. Deps are built lazily on first tick so a
// not-yet-ready workspace/GH auth at boot can't crash agent startup.
//
// CHU-2.2 adds a second, independent reconciliation pass on this SAME tick
// (not a second timer): reviewState drift from an out-of-band GitHub
// reviewer. Its own try/catch means one pass failing never prevents the
// other from running — see reconcileReviewState() in pr-state-reconciler.ts.
//
// WTR-1.4 adds a third, independent pass on this SAME tick: WTR-1.2's
// reconcileStaleWorktrees, a pure-filesystem sweep (no GitHub/task-store
// calls) that force-removes worktrees/<repo>-<branch> dirs older than
// agent-policy.md's cleanup_after_days. Same lazy-deps + own-try/catch
// shape as the two passes above, so a failure here never blocks the other
// two — see worktree-reaper.ts. WTR-1.3's removeWorktree wiring for the
// *merged/closed-PR* cleanup path needed no separate pass here: it already
// flows through the existing PR-state-reconciler pass above, since
// buildPrStateReconcilerDeps (buildProductionDeps in pr-state-reconciler.ts)
// constructs removeWorktree internally.
//
// TCS-4.1 adds a fourth, independent pass on this SAME tick: a claim-
// invariant self-heal sweep (reconcileClaimInvariant) that scans
// status:"pending" task-store tasks in scope for a non-null claimedBy (the
// AGH-3.4 shape — a pending task should never carry a claim) and releases
// each violation via POST /tasks/:id/release. Pure task-store HTTP, no
// GitHub calls, so it lives in its own sibling module
// (claim-invariant-reconciler.ts) rather than pr-state-reconciler.ts. Same
// lazy-deps + own-try/catch shape as the three passes above — an independent
// safety net alongside TCS-2.1's DB constraint on the same invariant, not a
// replacement for it.
//
// POM-4.1 adds a fifth, independent pass on this SAME tick: runPrCensus, a
// repo-wide merged-PR origin census sweep. Unlike the four passes above, this
// one intentionally has NO GitHub-label dependency (that approach was
// rejected) — it classifies each newly-merged PR (ci / dependency_bot /
// shipwright / human / unknown) via a pure classifier and an incremental
// `gh pr list --search "merged:>=<cursor>"` call per repo, POSTing the
// classified batch to POM-1.1's `POST /prs/census`. Same lazy-deps + own-
// try/catch shape as the four passes above — see pr-census.ts for the full
// rationale, including why a null cursor (first run) issues zero gh calls
// instead of a full historical backfill.
if (runtimeClient && agentId) {
  let reconcilerDeps: ReturnType<typeof buildPrStateReconcilerDeps> | undefined;
  let reviewStateReconcilerDeps:
    | ReturnType<typeof buildReviewStateReconcilerDeps>
    | undefined;
  let worktreeReaperDeps:
    | ReturnType<typeof buildWorktreeReaperDeps>
    | undefined;
  let claimInvariantReconcilerDeps:
    | ReturnType<typeof buildClaimInvariantReconcilerDeps>
    | undefined;
  let prCensusDeps: ReturnType<typeof buildPrCensusDeps> | undefined;

  async function runPrStateReconciler() {
    try {
      reconcilerDeps ??= buildPrStateReconcilerDeps({
        ghJson,
        getScopedRepos: agentReposRef.get,
      });
      await reconcilePrState(reconcilerDeps);
    } catch (err) {
      console.error(
        "[pr-state-reconciler] tick failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      reviewStateReconcilerDeps ??= buildReviewStateReconcilerDeps({
        ghGraphql,
        getScopedRepos: agentReposRef.get,
      });
      await reconcileReviewState(reviewStateReconcilerDeps);
    } catch (err) {
      console.error(
        "[pr-state-reconciler:review] tick failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      worktreeReaperDeps ??= buildWorktreeReaperDeps({
        getScopedRepos: agentReposRef.get,
      });
      await reconcileStaleWorktrees(worktreeReaperDeps);
    } catch (err) {
      console.error(
        "[pr-state-reconciler:worktree-reaper] tick failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      claimInvariantReconcilerDeps ??= buildClaimInvariantReconcilerDeps({
        getScopedRepos: agentReposRef.get,
      });
      await reconcileClaimInvariant(claimInvariantReconcilerDeps);
    } catch (err) {
      console.error(
        "[claim-invariant-reconciler] tick failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      prCensusDeps ??= buildPrCensusDeps({
        ghJson,
        getScopedRepos: agentReposRef.get,
      });
      await runPrCensus(prCensusDeps);
    } catch (err) {
      console.error(
        "[pr-census] tick failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const reconcilerIntervalMs = Number(
    process.env.SHIPWRIGHT_PR_STATE_RECONCILER_INTERVAL_MS ?? 45 * 60_000,
  );
  setInterval(() => void runPrStateReconciler(), reconcilerIntervalMs);
  console.log(
    `[agent] PR state reconciler started (${reconcilerIntervalMs}ms interval)`,
  );
}

// ─── Step 6: Cron sync loop ───────────────────────────────────────────────────

const cronTasks = new Map<string, ReturnType<typeof nodeCron.schedule>>();

// Live view of the most recently fetched cron job list. The shipwright-loop
// job is only ever nodeCron.schedule()'d once (see the `if (!cronTasks.has(id))`
// guard below), so its dispatch callback must read this ref at fire-time
// rather than close over a single syncCrons() tick's `jobs` array — otherwise
// its phase-toggle view (resolveLoopPhaseToggles, read inside runLoopTick)
// freezes at whatever dev-task/review/patch/deploy's enabled flags were at
// first-schedule time. See loop-jobs-ref.ts for the full rationale.
const loopJobsRef = createJobsRef<CronJobLike>();

// The shipwright-loop orchestrator is a single stateful closure (it owns the
// cross-tick busy flag), so it must be constructed once and reused across
// ticks — not rebuilt per fire. Built lazily on the first loop dispatch so
// agents without a shipwright-loop cron never pay its GitHub/workspace dep
// wiring cost, and its construction errors surface at fire time (logged by the
// cron callback's try/catch) rather than crashing agent startup.
const getLoopOrchestrator = createLoopOrchestratorGetter({
  // DTW-1.3/DTR-1.1/CRT-1.3: sessionKey is no longer hardcoded undefined for
  // the loop path — the orchestrator supplies a stable `dev-task:{taskId}`
  // key for dev-task dispatches, a per-dispatch nonce `{phase}:{itemId}:
  // {uuid}` key for review/patch/deploy dispatches (CRT-1.3), and nothing for
  // plan, plus an onEarlySessionId callback. The dev-task key is stable (not
  // a per-dispatch nonce) so a later, separate dispatch of the same
  // still-in_progress task can resume this same session; the
  // review/patch/deploy keys only ever resume within one dispatch's own
  // resume loop, never across dispatches — see loop-orchestrator.ts's
  // sessionKey doc comment. The loop never passes extraEnv (only
  // cron-handler's dispatch does), so the former 3rd `extraEnv` param here
  // was dead for this call site.
  runner: (
    message: string,
    onProgress?: ProgressCallback,
    sessionKey?: string,
    onEarlySessionId?: EarlySessionIdCallback,
  ) =>
    runner(
      message,
      sessionKey,
      onProgress,
      undefined,
      undefined,
      onEarlySessionId,
    ),
  cronRunReporter: cronRunReporter ?? new NoopCronRunReporter(),
  workQueueReporter,
  // DTW-1.3/DTR-1.1: lets the dev-task resume loop drop its stable session
  // key, but only once the orchestrator's fresh getTaskState check confirms
  // the task has reached a terminal dev-task-work status — not
  // unconditionally on every dispatch exit, since the key must otherwise
  // survive so a later, separate dispatch of the same still-in_progress task
  // can resume it. `sessions.json` (shared with Slack thread sessions) still
  // relies on this eventually firing so it doesn't accumulate a permanent
  // entry per task that finishes dev-task work.
  // CRT-1.3: review/patch/deploy dispatches share this same callback, but
  // clear their per-dispatch nonce key unconditionally on every exit instead
  // — there is no cross-dispatch state to preserve for those three phases,
  // so no terminal-status check gates their clear.
  clearSessionKey: (key: string) => sessions.clear(key),
  // LO-1.1: same optional-by-convention pattern as every other sentryClient
  // call site in this file (undefined, i.e. fully inert, when SENTRY_DSN is
  // unset) — see LoopOrchestratorDeps's sentryClient doc comment.
  sentryClient: process.env.SENTRY_DSN ? Sentry : undefined,
});

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

    // Keep the live jobs ref current every tick, regardless of whether any
    // job actually gets (re)scheduled below — this is what the already-
    // scheduled shipwright-loop callback reads at fire-time.
    loopJobsRef.set(jobs);

    // Classify this agent's own job list: which jobs get an independent
    // schedule, and with which dispatch kind (loop vs. generic). See
    // loop-cron-classifier.ts for the full decision — in particular, the
    // five pipeline phase jobs are excluded here (loop-config-only) only
    // when this agent's own shipwright-loop job is present and enabled.
    const scheduled = classifyCronJobsForScheduling(jobs);
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
              const orchestrator = await getLoopOrchestrator(id);
              await orchestrator(loopJobsRef.get());
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
