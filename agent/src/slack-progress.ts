/**
 * agent/src/slack-progress.ts
 *
 * Status-only progress driver for Slack thread replies, plus an opt-in live
 * Thinking Steps stream.
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
 * "Running tests...", etc.). "active" (not "closed") is used on finish
 * because Shipwright threads stay open for follow-up messages — "closed" is
 * for ending a conversation entirely.
 *
 * When `thinkingStepsEnabled` is set, SlackProgress ALSO drives a
 * `chat.startStream` / `chat.appendStream` / `chat.stopStream` Thinking Steps
 * stream in parallel with the setStatus lifecycle above — a per-phase
 * "timeline" of what the run is currently doing (e.g. "Reading files"),
 * using the labels from `PROGRESS_LABELS`. This is entirely additive and
 * off by default: when the flag is unset/false, none of
 * chat.startStream/appendStream/stopStream are ever called, and behavior is
 * byte-identical to before this flag existed. Repeated identical phases
 * collapse into a single appendStream call, mirroring the phase-collapse
 * `_consumeStream` already does upstream in claude.ts before invoking
 * `onProgress` — SlackProgress collapses independently too, since its own
 * onProgress is unit-tested in isolation from that upstream collapsing.
 *
 * Every Slack API call is wrapped in try/catch — a progress failure must
 * never throw or break the real reply. This covers a client that lacks the
 * `agents`/`chat` namespace entirely (property access throws
 * synchronously), not just a call that rejects. `onProgress` is a
 * *synchronous* callback (see `ProgressCallback` in claude.ts), so
 * `chat.appendStream` is fired without `await`: the property-access + call
 * is wrapped in a synchronous try/catch (for the missing-namespace case) and
 * the returned promise gets a trailing `.catch()` (for the async-rejection
 * case).
 */

import type { ProgressPhase } from "@shipwright/lib/progress-phases";
import { PROGRESS_LABELS } from "@shipwright/lib/progress-phases";
import type { ModelUsage } from "./claude.ts";

// biome-ignore lint/suspicious/noExplicitAny: Bolt client type is complex
type SlackClient = any;

export interface SlackProgressOptions {
  client: SlackClient;
  channel: string;
  threadTs: string;
  /**
   * Opt-in live Thinking Steps stream (chat.startStream/appendStream/
   * stopStream). Off by default — omitted or false means zero calls to
   * that Slack API surface, matching behavior from before this flag existed.
   */
  thinkingStepsEnabled?: boolean;
}

/**
 * Drives the agents.sessions.setStatus lifecycle status (and, optionally,
 * the Thinking Steps stream) for a single Claude run. One instance per run —
 * construct it where "processing" used to be set, pass `progress.onProgress`
 * (bound) as the runner's third arg, and call `progress.finish()` in the
 * handler's completion path.
 */
export class SlackProgress {
  private readonly client: SlackClient;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly thinkingStepsEnabled: boolean;
  private streamTs: string | undefined;
  private lastFiredPhase: ProgressPhase | undefined;

  constructor(opts: SlackProgressOptions) {
    this.client = opts.client;
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
    this.thinkingStepsEnabled = opts.thinkingStepsEnabled ?? false;
  }

  /**
   * Announces the initial "processing" agent-session status, and — when
   * `thinkingStepsEnabled` — opens the Thinking Steps stream. Call once, up
   * front.
   */
  async start(): Promise<void> {
    await this.setStatus("processing");
    if (this.thinkingStepsEnabled) {
      await this.startStream();
    }
  }

  private async startStream(): Promise<void> {
    // Whole call (including the `chat` property access) wrapped in
    // try/catch — see the module-level doc comment.
    try {
      const resp = await this.client.chat.startStream({
        channel: this.channel,
        thread_ts: this.threadTs,
        task_display_mode: "timeline",
      });
      this.streamTs = resp?.ts;
    } catch (err) {
      console.warn(
        "[slack-progress] startStream failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async setStatus(
    status: "active" | "processing" | "suspended" | "closed",
  ): Promise<void> {
    // The whole call — including the `agents.sessions` property access, not
    // just the setStatus() promise — is wrapped in try/catch: a Bolt client
    // built from a `@slack/web-api` version that predates the Agent Sessions
    // API (as of 2026-08-20) has no `agents` namespace at all, so accessing
    // it throws synchronously before setStatus() is ever called and a
    // trailing `.catch()` never attaches. A progress failure must never
    // throw or break the real reply.
    try {
      await this.client.agents.sessions.setStatus({
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status,
      });
    } catch (err) {
      console.warn(
        `[slack-progress] setStatus(${status}) failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * The callback passed as the Claude runner's third arg. The Agent Sessions
   * API has no per-phase text slot (status is a fixed lifecycle enum), so
   * this never drives setStatus. When `thinkingStepsEnabled`, it appends one
   * Thinking Steps chunk per *distinct* phase transition — repeats of the
   * same phase (or an undefined phase, i.e. a usage-only tick) are no-ops.
   */
  onProgress = (_usage: ModelUsage, phase?: ProgressPhase): void => {
    if (!this.thinkingStepsEnabled) return;
    if (phase === undefined) return;
    if (phase === this.lastFiredPhase) return;
    this.lastFiredPhase = phase;
    this.appendStream(phase);
  };

  // Fire-and-forget: onProgress is a synchronous callback (ProgressCallback
  // is not async), so this can't be awaited. The property access + call is
  // wrapped in a synchronous try/catch (client missing `chat` entirely), and
  // the returned promise gets a trailing `.catch()` (async rejection).
  private appendStream(phase: ProgressPhase): void {
    try {
      this.client.chat
        .appendStream({
          channel: this.channel,
          thread_ts: this.threadTs,
          ts: this.streamTs,
          chunks: [{ type: "task_update", text: PROGRESS_LABELS[phase] }],
        })
        .catch((err: unknown) => {
          console.warn(
            `[slack-progress] appendStream(${phase}) failed:`,
            err instanceof Error ? err.message : String(err),
          );
        });
    } catch (err) {
      console.warn(
        `[slack-progress] appendStream(${phase}) failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Call in the handler's completion path (finally block or equivalent).
   * Sets the agent-session status back to "active" (idle/ready) — Shipwright
   * threads stay open for follow-up messages, so "closed" would be wrong
   * here. When `thinkingStepsEnabled`, also closes the Thinking Steps stream.
   */
  async finish(): Promise<void> {
    await this.setStatus("active");
    if (this.thinkingStepsEnabled) {
      await this.stopStream();
    }
  }

  private async stopStream(): Promise<void> {
    try {
      await this.client.chat.stopStream({
        channel: this.channel,
        thread_ts: this.threadTs,
        ts: this.streamTs,
      });
    } catch (err) {
      console.warn(
        "[slack-progress] stopStream failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
