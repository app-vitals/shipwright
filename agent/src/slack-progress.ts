/**
 * agent/src/slack-progress.ts
 *
 * Status-only progress driver for Slack thread replies.
 *
 * Drives `assistant.threads.setStatus` (Slack's AI-app status surface) for
 * the lifecycle of a single Claude run: "Thinking..." on start, the current
 * milestone label on each real progress phase, and cleared on finish. No
 * visible chat message is posted, updated, or deleted — SlackProgress never
 * calls chat.postMessage/chat.update/chat.delete.
 *
 * Phase-stomping fix: `agent/src/claude.ts`'s onProgress callback fires
 * twice per stream line for most turns — once with a real phase (via
 * `phaseForBlock`) and once with no phase when the line carries usage data
 * only. `onProgress` here only calls setStatus when `phase !== undefined`
 * (mirroring `chat/src/message-service.ts`'s `if (phase !== undefined)
 * data.progressPhase = phase;` pattern) — a usage-only tick is a no-op, so
 * the last real milestone label stays visible instead of being immediately
 * overwritten by a generic default.
 *
 * Every Slack API call is wrapped in .catch(() => {}) — a progress failure
 * must never throw or break the real reply.
 */

import {
  PROGRESS_LABELS,
  type ProgressPhase,
} from "@shipwright/lib/progress-phases";
import type { ModelUsage } from "./claude.ts";

const DEFAULT_STATUS_LABEL = "Working...";

function labelForPhase(phase: ProgressPhase): string {
  return PROGRESS_LABELS[phase] ?? DEFAULT_STATUS_LABEL;
}

// biome-ignore lint/suspicious/noExplicitAny: Bolt client type is complex
type SlackClient = any;

export interface SlackProgressOptions {
  client: SlackClient;
  channel: string;
  threadTs: string;
}

/**
 * Drives the assistant.threads.setStatus AI-app status for a single Claude
 * run. One instance per run — construct it where "Thinking..." used to be
 * set, pass `progress.onProgress` (bound) as the runner's third arg, and
 * call `progress.finish()` in the handler's completion path.
 */
export class SlackProgress {
  private readonly client: SlackClient;
  private readonly channel: string;
  private readonly threadTs: string;

  constructor(opts: SlackProgressOptions) {
    this.client = opts.client;
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
  }

  /** Announces the initial "Thinking..." AI-app status. Call once, up front. */
  async start(): Promise<void> {
    await this.setStatus("Thinking...");
  }

  private async setStatus(status: string): Promise<void> {
    await this.client.assistant.threads
      .setStatus({
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status,
      })
      .catch(() => {});
  }

  /**
   * The callback passed as the Claude runner's third arg. Only updates the
   * AI-app status when a real phase is present — a usage-only tick
   * (phase === undefined) is a no-op, leaving the last real milestone label
   * in place.
   */
  onProgress = (_usage: ModelUsage, phase?: ProgressPhase): void => {
    if (phase === undefined) return;
    void this.setStatus(labelForPhase(phase));
  };

  /**
   * Call in the handler's completion path (finally block or equivalent).
   * Clears the AI-app status.
   */
  async finish(): Promise<void> {
    await this.setStatus("");
  }
}
