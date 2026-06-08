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
import type { TokenUsage } from "./claude.ts";
import { markdownToSlack } from "./format.ts";
import { parseMarkers } from "./markers.ts";
import {
  forwardNewMetrics,
  forwardTokenUsage,
  snapshotMetrics,
} from "./posthog.ts";
import { type SynthesizeSpeechFn, dispatchMarkers } from "./slack.ts";
import type { VoiceConfig } from "./voice.ts";

type ClaudeRunner = (
  message: string,
) => Promise<{ result: string; sessionId?: string; usage?: TokenUsage }>;

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
  /** Workspace root — used to forward metrics.jsonl entries to PostHog. */
  workspace?: string;
  /** Plugin cache dir — overridable for testing. */
  pluginCacheDir?: string;
  pluginManifestPath?: string;
  alertsChannel?: string;
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
  } = deps;

  if (!prompt) {
    throw new ValidationError("missing required field: prompt");
  }
  if (!silent && !channel && !user) {
    throw new ValidationError(
      "missing delivery target: provide channel or user (or set silent=true)",
    );
  }

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
      return;
    }

    const checkProc = Bun.spawn(["bun", scriptPath], {
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
          console.error("[agent:cron] failed to post preCheck alert:", alertErr);
        }
      }
      return;
    }

    if (checkExitCode !== 0 || !output) {
      console.log(
        `[agent:cron] preCheck returned no work for job "${jobId}" — skipping tick`,
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

  const metricsSnapshot = workspace ? snapshotMetrics(workspace) : undefined;
  const { result, sessionId, usage } = await runner(message);
  if (workspace && metricsSnapshot) {
    await forwardNewMetrics(workspace, metricsSnapshot);
  }
  await forwardTokenUsage(usage, "cron");

  const { cleaned, markers } = parseMarkers(result);
  const isSilentMarker = markers.some((m) => m.type === "silent");

  if (silent || isSilentMarker) {
    console.log(`[agent:cron] job "${jobId}" completed (silent — no post)`);
    return;
  }

  const formatted = formatter(cleaned);

  if (channel) {
    if (user) {
      console.warn(
        `[agent:cron] job "${jobId}" has both channel and user — posting to channel`,
      );
    }
    const postResult = await slack.chat.postMessage({ channel, text: formatted });
    console.log(`[agent:cron] job "${jobId}" posted to channel ${channel}`);
    if (postResult.ts) {
      onPost?.(channel, postResult.ts);
      if (onSession && sessionId) onSession(channel, postResult.ts, sessionId);
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
