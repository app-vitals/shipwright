/**
 * Agent cron request handler.
 *
 * Receives a cron payload, runs the prompt through Claude, and posts the
 * result to Slack. Extracted as a pure function with injected deps for
 * testability.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { WebClient } from "@slack/web-api";
import type { ClaudeRunResult, TokenUsage } from "./claude.ts";
import { dominantModel, liveClaudeConfig } from "./claude.ts";
import { calculateCost } from "./pricing.ts";
import type { ModelBreakdownEntry } from "./cron-run-reporter.ts";
import { type Clock, SystemClock } from "./clock.ts";
import type { CronRunReporter } from "./cron-run-reporter.ts";
import { markdownToSlack } from "./format.ts";
import { parseMarkers } from "./markers.ts";
import { type SynthesizeSpeechFn, dispatchMarkers } from "./slack.ts";
import type { VoiceConfig } from "./voice.ts";

function buildTokenPayload(
  usage: TokenUsage | undefined,
  totalCostUsd: number | undefined,
  modelUsage: Record<string, TokenUsage> | undefined,
): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  model?: string;
  modelBreakdown?: ModelBreakdownEntry[];
} {
  // Build per-model breakdown when modelUsage has entries
  let modelBreakdown: ModelBreakdownEntry[] | undefined;
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    modelBreakdown = Object.entries(modelUsage).map(([model, mu]) => ({
      model,
      inputTokens: mu.input_tokens,
      outputTokens: mu.output_tokens,
      cacheReadTokens: mu.cache_read_input_tokens,
      cacheCreationTokens: mu.cache_creation_input_tokens,
      costUsd: calculateCost(mu, model),
    }));
  }

  return {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheReadTokens: usage?.cache_read_input_tokens,
    cacheCreationTokens: usage?.cache_creation_input_tokens,
    costUsd: totalCostUsd ?? (usage ? calculateCost(usage, liveClaudeConfig.model) : undefined),
    model: dominantModel(modelUsage ?? {}) ?? liveClaudeConfig.model,
    ...(modelBreakdown !== undefined && { modelBreakdown }),
  };
}

type ClaudeRunner = (message: string) => Promise<ClaudeRunResult>;

interface CronRequest {
  jobId: string;
  prompt: string;
  channel?: string;
  user?: string;
  silent?: boolean;
  preCheck?: string;
}

export interface CronHandlerDeps {
  slack: WebClient;
  runner: ClaudeRunner;
  formatter?: (text: string) => string;
  /** Called after a successful post so the caller can track the thread. */
  onPost?: (channel: string, ts: string) => void;
  /** Called after a successful post when a sessionId is available. */
  onSession?: (channel: string, ts: string, sessionId: string) => void;
  /** Optional speech synthesis — if absent, [speak:] markers are skipped. */
  synthesizeSpeechFn?: SynthesizeSpeechFn;
  voiceConfig?: VoiceConfig;
  /** Workspace root — used to resolve relative preCheck scripts and root the run. */
  workspace?: string;
  /** Plugin cache dir — overridable for testing. */
  pluginCacheDir?: string;
  pluginManifestPath?: string;
  alertsChannel?: string;
  /** Reports cron run outcomes to the admin API (fire-and-forget). */
  cronRunReporter?: CronRunReporter;
  /** The agent's own ID — used to construct the reporter URL. */
  agentId?: string;
  /** Clock for deterministic time in tests. Defaults to SystemClock(). */
  clock?: Clock;
}

export async function handleCronRequest(
  req: CronRequest,
  deps: CronHandlerDeps,
): Promise<void> {
  const { jobId, channel, user, silent } = req;
  let { prompt } = req;
  const {
    slack,
    runner,
    formatter = markdownToSlack,
    onPost,
    onSession,
    synthesizeSpeechFn,
    voiceConfig,
    workspace,
    pluginCacheDir,
    pluginManifestPath = join(
      homedir(),
      ".claude",
      "plugins",
      "installed_plugins.json",
    ),
    cronRunReporter,
    agentId,
    clock = SystemClock(),
  } = deps;

  const startedAt = clock.now();

  if (!prompt) {
    throw new ValidationError("missing required field: prompt");
  }
  if (!silent && !channel && !user) {
    throw new ValidationError(
      "missing delivery target: provide channel or user (or set silent=true)",
    );
  }

  // CREATE run at start (before preCheck)
  const runId = cronRunReporter
    ? await cronRunReporter.createRun(jobId, startedAt)
    : null;

  if (req.preCheck) {
    const isRelative =
      req.preCheck.startsWith("./") || req.preCheck.startsWith("../");
    const isFilePath = isRelative || req.preCheck.startsWith("/");

    let scriptPath: string | undefined;

    if (isFilePath) {
      if (isRelative && workspace === undefined) {
        console.warn(
          `[agent:cron] preCheck is a relative path but no workspace is set — skipping job "${jobId}"`,
        );
        await cronRunReporter?.skipRun(
          jobId,
          runId,
          clock.now(),
          "preCheck:not-found",
        );
        return;
      }
      const candidate = isRelative
        ? resolve(workspace as string, req.preCheck)
        : req.preCheck;
      if (existsSync(candidate)) scriptPath = candidate;
    } else {
      const [plugin, script] = req.preCheck.split(":");

      if (pluginCacheDir) {
        const candidate = join(pluginCacheDir, plugin, "scripts", script);
        if (existsSync(candidate)) scriptPath = candidate;
      } else {
        try {
          const manifest = JSON.parse(
            readFileSync(pluginManifestPath, "utf-8"),
          ) as {
            version: number;
            plugins: Record<string, Array<{ installPath?: string }>>;
          };
          const entry = Object.entries(manifest.plugins).find(([k]) =>
            k.startsWith(`${plugin}@`),
          );
          const installPath = entry?.[1]?.[0]?.installPath;
          if (installPath) {
            const candidate = join(installPath, "scripts", script);
            if (existsSync(candidate)) scriptPath = candidate;
          }
        } catch (err) {
          console.warn(
            `[agent:cron] failed to read installed_plugins.json: ${String(err)}`,
          );
        }
      }
    }

    if (!scriptPath) {
      console.warn(
        `[agent:cron] preCheck script not found for "${req.preCheck}" — skipping job "${jobId}"`,
      );
      await cronRunReporter?.skipRun(
        jobId,
        runId,
        clock.now(),
        "preCheck:not-found",
      );
      return;
    }

    // Run the preCheck from the workspace, not the agent's cwd (/app). Plugin
    // preChecks resolve state relative to process.cwd() — e.g. check-dev-task.ts
    // → JsonTaskStore(process.cwd()) reads `state/todos.json`. Without this the
    // store roots at /app, the file is missing, and the job is wrongly suppressed
    // ("/app/state/todos.json not found — run setup first"). Mirrors the claude
    // run, which is already rooted at the workspace.
    const checkProc = Bun.spawn(["bun", scriptPath], {
      ...(workspace ? { cwd: workspace } : {}),
      // env: process.env is required — Bun.spawn otherwise snapshots env at Bun
      // startup and misses runtime mutations from config-sync (index.ts does
      // Object.assign(process.env, bundle.env) every 60s). Without this, a
      // preCheck reads boot-time credentials — e.g. a rotated
      // SHIPWRIGHT_TASK_STORE_TOKEN — and fails (401) until the pod restarts.
      // Mirrors setup.ts defaultExec, which documents the same gotcha.
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [checkOutput, checkStderr] = await Promise.all([
      new Response(checkProc.stdout).text(),
      new Response(checkProc.stderr).text(),
    ]);
    const checkExitCode = await checkProc.exited;
    const output = checkOutput.trim();

    if (checkExitCode >= 2) {
      const detail = checkStderr.trim();
      console.error(
        `[agent:cron] preCheck for job "${jobId}" crashed (exit ${checkExitCode})${detail ? `: ${detail}` : ""} — session suppressed`,
      );
      if (deps.alertsChannel) {
        try {
          await deps.slack.chat.postMessage({
            channel: deps.alertsChannel,
            text: `[cron] preCheck for \`${jobId}\` crashed (exit ${checkExitCode}) — session suppressed${detail ? `\n\`\`\`\n${detail}\n\`\`\`` : ""}`,
          });
        } catch (alertErr) {
          console.error(
            "[agent:cron] failed to post preCheck alert:",
            alertErr,
          );
        }
      }
      await cronRunReporter?.skipRun(
        jobId,
        runId,
        clock.now(),
        "preCheck:crash",
        { error: detail || undefined },
      );
      return;
    }

    if (checkExitCode !== 0 || !output) {
      console.log(
        `[agent:cron] preCheck returned no work for job "${jobId}" — skipping tick`,
      );
      await cronRunReporter?.skipRun(
        jobId,
        runId,
        clock.now(),
        "preCheck:no-output",
      );
      return;
    }

    prompt = output;
  }

  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
  });
  const message = `[Cron job: ${jobId}] Current time: ${now}\n\n${prompt}`;

  console.log(`[agent:cron] running job "${jobId}"`);

  // ── Runner scope ─────────────────────────────────────────────────────────
  // Errors here record a genuine failure and re-throw so the caller sees them.
  let usage: TokenUsage | undefined;
  let totalCostUsd: number | undefined;
  let modelUsage: Record<string, TokenUsage> | undefined;
  let result: string;
  let sessionId: string | undefined;
  try {
    const runResult = await runner(message);
    usage = runResult.usage;
    totalCostUsd = runResult.totalCostUsd;
    modelUsage = runResult.modelUsage;
    result = runResult.result;
    sessionId = runResult.sessionId;
  } catch (err) {
    await cronRunReporter?.completeRun(jobId, runId, clock.now(), "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // ── Post-run scope ───────────────────────────────────────────────────────
  // Slack delivery errors must NOT corrupt the run record with outcome='failed'
  // when Claude completed successfully — they are logged and re-thrown, but the
  // run is already recorded as 'completed' (with full token/cost data) before
  // any Slack call is attempted.
  const { cleaned, markers } = parseMarkers(result);
  const isSilentMarker = markers.some((m) => m.type === "silent");

  if (silent) {
    console.log(`[agent:cron] job "${jobId}" completed (silent — no post)`);
    await cronRunReporter?.completeRun(
      jobId,
      runId,
      clock.now(),
      "completed",
      buildTokenPayload(usage, totalCostUsd, modelUsage),
    );
    return;
  }
  const isDmOnly = !!user && !channel;
  if (isSilentMarker && !isDmOnly) {
    // [silent] marker suppresses channel posts (and channel-wins-over-user posts)
    // DMs always get a reply — [silent] is ignored when routing to a DM
    console.log(`[agent:cron] job "${jobId}" completed (silent — no post)`);
    await cronRunReporter?.completeRun(
      jobId,
      runId,
      clock.now(),
      "completed",
      buildTokenPayload(usage, totalCostUsd, modelUsage),
    );
    return;
  }

  const formatted = formatter(cleaned);

  if (channel) {
    if (user) {
      console.warn(
        `[agent:cron] job "${jobId}" has both channel and user — posting to channel`,
      );
    }

    // Record completion before Slack delivery — a Slack error must not
    // overwrite a successful run with outcome='failed'.
    await cronRunReporter?.completeRun(
      jobId,
      runId,
      clock.now(),
      "completed",
      buildTokenPayload(usage, totalCostUsd, modelUsage),
    );

    const postResult = await slack.chat.postMessage({
      channel,
      text: formatted,
    });
    console.log(`[agent:cron] job "${jobId}" posted to channel ${channel}`);
    if (postResult.ts) {
      onPost?.(channel, postResult.ts);
      if (onSession && sessionId)
        onSession(channel, postResult.ts, sessionId);
    } else {
      console.warn(
        `[agent:cron] job "${jobId}" postMessage returned no ts — react markers will be skipped`,
      );
    }
    await dispatchMarkers(markers, {
      client: slack,
      channel,
      postedTs: postResult.ts,
      synthesizeSpeechFn,
      voiceConfig,
    });
  } else if (user) {
    // Record completion before any Slack calls — conversations.open can also
    // fail (network error or null channel), and we must not leave the
    // AgentCronRun row permanently open if it does.
    await cronRunReporter?.completeRun(
      jobId,
      runId,
      clock.now(),
      "completed",
      buildTokenPayload(usage, totalCostUsd, modelUsage),
    );

    const dmResult = await slack.conversations.open({ users: user });
    const dmChannel = dmResult.channel?.id;
    if (!dmChannel) {
      throw new Error(`[agent:cron] could not open DM for user ${user}`);
    }

    const dmPostResult = await slack.chat.postMessage({
      channel: dmChannel,
      text: formatted,
    });
    console.log(`[agent:cron] job "${jobId}" posted DM to user ${user}`);
    if (dmPostResult.ts) {
      onPost?.(dmChannel, dmPostResult.ts);
      if (onSession && sessionId)
        onSession(dmChannel, dmPostResult.ts, sessionId);
    } else {
      console.warn(
        `[agent:cron] job "${jobId}" DM postMessage returned no ts — react markers will be skipped`,
      );
    }
    await dispatchMarkers(markers, {
      client: slack,
      channel: dmChannel,
      postedTs: dmPostResult.ts,
      synthesizeSpeechFn,
      voiceConfig,
    });
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
