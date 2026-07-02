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
import { WebClient } from "@slack/web-api";
import nodeCron from "node-cron";
import { createAnalyticsStore } from "./analytics.ts";
import { createChatPoller } from "./chat-poller.ts";
import { createRunClaude, setLiveClaudeConfig } from "./claude.ts";
import { SystemClock } from "./clock.ts";
import { createConfig } from "./config.ts";
import { handleCronRequest } from "./cron-handler.ts";
import type { CronHandlerDeps } from "./cron-handler.ts";
import { HttpChatServiceClient } from "./http-chat-service-client.ts";
import {
  HttpChatTokenReporter,
  NoopChatTokenReporter,
} from "./chat-token-reporter.ts";
import { HttpCronRunReporter } from "./cron-run-reporter.ts";
import { markdownToSlack } from "./format.ts";
import {
  DEFAULT_HEALTH_PORT,
  markSlackConnected,
  markSlackDisconnected,
  startHealthServer,
} from "./health.ts";
import { createComposedApp } from "./run-agent.ts";
import { createFileSessionStore, threadKey } from "./sessions.ts";
import { ensureAgentHome, installPlugins, runMiseStartup } from "./setup.ts";
import { HttpShipwrightRuntimeClient } from "./shipwright-runtime-client.ts";
import { createSlackApp, hasSlackCredentials } from "./slack.ts";
import { sendBackOnlineDm } from "./startup-dm.ts";
import { resolveDisplayName } from "./users.ts";
import { synthesizeSpeech } from "./voice.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

const agentHome = process.env.AGENT_HOME ?? "/data/agent-home";
const { config } = createConfig(agentHome);

// ─── Timestamp prefix ─────────────────────────────────────────────────────────

for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) =>
    orig(`[${new Date().toISOString()}]`, ...args);
}

// ─── Step 1: Agent home ───────────────────────────────────────────────────────

ensureAgentHome(config.paths.home);
console.log(`[agent] agent home initialized: ${config.paths.home}`);

// ─── Step 2: Health server ────────────────────────────────────────────────────
// Bind before mise/plugin install so kubelet liveness probes don't time out
// during a slow toolchain install (e.g. compiling Python from source).

const slackClock = SystemClock();
const sessions = createFileSessionStore(config.paths.sessions);
const analytics = createAnalyticsStore(join(config.paths.home, "analytics"));
analytics.track({ type: "session_start" });

const slack = new WebClient(config.slack.botToken ?? "");
const runner = createRunClaude(
  Bun.spawn,
  sessions,
  undefined,
  config.paths.workspace,
  analytics.track,
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

const cronDeps: CronHandlerDeps = {
  slack,
  runner,
  formatter: markdownToSlack,
  onSession: (channel: string, ts: string, sessionId: string) => {
    sessions.set(threadKey(channel, ts), sessionId);
  },
  synthesizeSpeechFn: synthesizeSpeech,
  voiceConfig: config.voice,
  workspace: config.paths.workspace,
  alertsChannel: config.alerts.channel,
  cronRunReporter,
  agentId: config.shipwright.agentId,
};

const healthPort = Number(
  process.env.SHIPWRIGHT_HEALTH_PORT ?? DEFAULT_HEALTH_PORT,
);
startHealthServer(healthPort, analytics.summarize, cronDeps, slackClock);
console.log(`[agent] health server on port ${healthPort}`);

// ─── Step 3: mise + default plugins ──────────────────────────────────────────

await runMiseStartup(config.paths.home);
console.log("[agent] mise startup complete");

await installPlugins();
console.log("[agent] default plugin install complete");

// ─── Runtime client ───────────────────────────────────────────────────────────

const agentId = config.shipwright.agentId;
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

    // Build desired map of enabled jobs
    const desired = new Map<string, (typeof jobs)[number]>();
    for (const job of jobs) {
      if (job.enabled) desired.set(job.id, job);
    }

    // Cancel removed/disabled jobs
    for (const [id, task] of cronTasks) {
      if (!desired.has(id)) {
        task.stop();
        cronTasks.delete(id);
        console.log(`[cron-sync] unscheduled ${id}`);
      }
    }

    // Schedule new jobs
    for (const [id, job] of desired) {
      if (!cronTasks.has(id)) {
        const task = nodeCron.schedule(job.schedule, async () => {
          console.log(`[cron] firing job ${id}`);
          try {
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
          } catch (err) {
            console.error(
              `[cron] job ${id} failed:`,
              err instanceof Error ? err.message : String(err),
            );
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
  const chatClient = new HttpChatServiceClient({
    baseUrl: config.chat.serviceUrl,
    token: config.chat.serviceToken,
  });
  const chatPoller = createChatPoller({
    client: chatClient,
    runner,
    sessions: chatSessions,
    intervalMs: config.chat.pollIntervalMs ?? 5_000,
  });
  chatPoller.start();
  console.log(
    `[agent] chat poll loop started (${config.chat.pollIntervalMs ?? 5_000}ms interval)`,
  );
}

// ─── Step 7: Slack Bolt Socket Mode (only when credentials present) ───────────
// Bolt's Socket Mode throws "Must provide an App-Level Token" if constructed
// without an appToken, so the agent runs Slack ONLY when both tokens are present.
// Absent creds → offline mode: skip Slack, keep health green, interact via /chat.

const slackAppConfig = {
  botToken: config.slack.botToken ?? "",
  appToken: config.slack.appToken ?? "",
  signingSecret: config.slack.signingSecret ?? "",
};

let app: ReturnType<typeof createSlackApp> | undefined;

if (hasSlackCredentials(slackAppConfig)) {
  app = createSlackApp(
    runner,
    markdownToSlack,
    threadKey,
    undefined, // appFactory — default Bolt App
    slackAppConfig,
    analytics.track,
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
  );

  await app.start();
  markSlackConnected();
  console.log("[agent] Slack app started — running");

  await sendBackOnlineDm(slack, config.owner.user);
} else {
  console.warn(
    "[agent] Slack credentials absent (need SLACK_BOT_TOKEN + SLACK_APP_TOKEN) — " +
      "skipping Slack startup. Offline mode: use the dev /chat endpoint to interact.",
  );
}

// ─── Step 7b: Dev-only /chat transport ────────────────────────────────────────
// DEFAULT-DENY: only when SHIPWRIGHT_DEV_CHAT=true (a CI/doctor guard forbids
// this in production — see chat-guard.ts). Reuses the same Claude runner as
// Slack so local chat exercises the identical code path.
if (process.env.SHIPWRIGHT_DEV_CHAT === "true") {
  const chatPort = Number(process.env.PORT ?? 3000);
  const chatApp = createComposedApp({ devChat: true, chatRunner: runner });
  Bun.serve({ fetch: chatApp.fetch, port: chatPort });
  console.warn(
    `[agent] SHIPWRIGHT_DEV_CHAT=true — dev /chat endpoint on port ${chatPort} (must NOT be used in production)`,
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
