/**
 * agent/src/slack-progress.ts
 *
 * Status-only progress driver for Slack thread replies.
 *
 * Drives `agents.sessions.setStatus` (Slack's Agent Sessions API, part of
 * the Agent messaging experience rolled out 2026-08-20 — the replacement for
 * the deprecated Assistant messaging experience's `assistant.threads.setStatus`)
 * for the lifecycle of a single Claude run: "processing" on start, "active"
 * on finish. No visible chat message is posted, updated, or deleted —
 * SlackProgress never calls chat.postMessage/chat.update/chat.delete.
 *
 * Unlike the old `assistant.threads.setStatus`, `status` here is a fixed
 * lifecycle enum (active/processing/suspended/closed), not free text — there
 * is no replacement for the old per-phase custom labels ("Reading files...",
 * "Running tests...", etc.), so `onProgress` no longer drives any Slack API
 * call. "active" (not "closed") is used on finish because Shipwright threads
 * stay open for follow-up messages — "closed" is for ending a conversation
 * entirely.
 *
 * Every Slack API call is wrapped in .catch(() => {}) — a progress failure
 * must never throw or break the real reply.
 */

import type { ModelUsage } from "./claude.ts";
import type { ProgressPhase } from "@shipwright/lib/progress-phases";

// biome-ignore lint/suspicious/noExplicitAny: Bolt client type is complex
type SlackClient = any;

export interface SlackProgressOptions {
  client: SlackClient;
  channel: string;
  threadTs: string;
}

/**
 * Drives the agents.sessions.setStatus lifecycle status for a single Claude
 * run. One instance per run — construct it where "processing" used to be
 * set, pass `progress.onProgress` (bound) as the runner's third arg (kept as
 * a no-op for API-shape compatibility with the runner's callback signature),
 * and call `progress.finish()` in the handler's completion path.
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

  /** Announces the initial "processing" agent-session status. Call once, up front. */
  async start(): Promise<void> {
    await this.setStatus("processing");
  }

  private async setStatus(
    status: "active" | "processing" | "suspended" | "closed",
  ): Promise<void> {
    await this.client.agents.sessions
      .setStatus({
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status,
      })
      .catch(() => {});
  }

  /**
   * The callback passed as the Claude runner's third arg. The Agent Sessions
   * API has no per-phase text slot (status is a fixed lifecycle enum), so
   * this is a documented no-op — kept only so existing call sites can keep
   * wiring it in as the runner's onProgress callback without change.
   */
  onProgress = (_usage: ModelUsage, _phase?: ProgressPhase): void => {};

  /**
   * Call in the handler's completion path (finally block or equivalent).
   * Sets the agent-session status back to "active" (idle/ready) — Shipwright
   * threads stay open for follow-up messages, so "closed" would be wrong here.
   */
  async finish(): Promise<void> {
    await this.setStatus("active");
  }
}
