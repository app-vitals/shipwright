/**
 * agent/src/slack-progress.ts
 *
 * Milestone-updated progress message driver for Slack thread replies
 * (CFB-5.1).
 *
 * WHY chat.update AND NOT JUST setStatus: `assistant.threads.setStatus`
 * renders ONLY in Slack's AI-app surface and is invisible in an ordinary
 * channel thread — which is why the "Thinking..." status alone is
 * effectively nothing to a user watching a normal thread. SlackProgress
 * keeps calling setStatus (so the AI-app surface stays correct) AND drives a
 * real, visible chat message via chat.postMessage/chat.update.
 *
 * Behavior:
 *  - Lazy first post: no chat.postMessage until the run has been active
 *    for >= LAZY_POST_THRESHOLD_MS (wall clock from construction, via the
 *    injected Clock) AND a milestone/phase has been observed. A fast reply
 *    (the common case) never posts a progress message at all — no channel
 *    noise.
 *  - Once a message is posted, further milestones are throttled to a
 *    trailing-edge window: the first onProgress call after the previous
 *    flush starts a timer; any calls during that timer overwrite what will
 *    be sent; when the timer fires, the newest milestone is sent via
 *    chat.update and the window resets.
 *  - A 429 (WebAPIRateLimitedError, `retryAfter` in seconds) on either
 *    chat.postMessage or chat.update backs off: no further Slack API calls
 *    from this module happen until `retryAfter` seconds have elapsed
 *    (per the injected Clock). Progress continues to track the latest
 *    milestone during the backoff so whatever is current flushes once the
 *    window clears.
 *  - Every Slack API call is wrapped in .catch(() => {}) (or try/catch) —
 *    a progress failure must never throw or break the real reply.
 *
 * Slack cancel (a Block Kit button + app.action handler + thread-to-run map)
 * is explicitly out of scope here — see CFB-5.1's brief. The idle/ceiling
 * timers in claude.ts remain the run-liveness backstop; this module is
 * purely cosmetic.
 */

import {
  PROGRESS_LABELS,
  type ProgressPhase,
} from "@shipwright/lib/progress-phases";
import type { ModelUsage } from "./claude.ts";
import { type Clock, SystemClock } from "./clock.ts";

/** No chat.postMessage until the run has been active at least this long. */
const LAZY_POST_THRESHOLD_MS = 3_000;

/** Trailing-edge throttle window for chat.update once a message is posted. */
const THROTTLE_WINDOW_MS = 15_000;

const DEFAULT_STATUS_LABEL = "Working...";

function labelForPhase(phase: ProgressPhase | undefined): string {
  if (!phase) return DEFAULT_STATUS_LABEL;
  return PROGRESS_LABELS[phase] ?? DEFAULT_STATUS_LABEL;
}

// biome-ignore lint/suspicious/noExplicitAny: Bolt client type is complex
type SlackClient = any;

export interface SlackProgressOptions {
  client: SlackClient;
  channel: string;
  threadTs: string;
  clock?: Clock;
  /** Injected for tests so timer behavior is deterministic. */
  setTimeoutFn?: typeof setTimeout;
  /** Injected for tests so timer behavior is deterministic. */
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Drives a lazily-posted, milestone-updated Slack progress message for a
 * single Claude run, alongside the existing assistant.threads.setStatus
 * AI-app status calls.
 *
 * One instance per run — construct it where "Thinking..." used to be set,
 * pass `progress.onProgress` (bound) as the runner's third arg, and call
 * `progress.finish()` in the handler's completion path.
 */
export class SlackProgress {
  private readonly client: SlackClient;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly clock: Clock;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private readonly startedAtMs: number;

  /** The most recently observed milestone label — always up to date. */
  private latestLabel: string = DEFAULT_STATUS_LABEL;

  /** ts of the posted progress message, once one exists. */
  private messageTs: string | undefined;

  /**
   * True from the moment the lazy first post is kicked off (synchronously,
   * before the postMessage promise resolves) until it either lands
   * (messageTs set) or fails. Prevents a second onProgress call that arrives
   * while the first postMessage is still in flight from firing a duplicate
   * postMessage — the lazy-post decision must be made synchronously even
   * though the Slack call itself is async.
   */
  private postInFlight = false;

  /**
   * The in-flight postInitialMessage() promise, if one is running. finish()
   * awaits this before deciding whether a message needs cleanup — otherwise
   * a run that completes while the lazy post is still in flight would see
   * messageTs still unset, skip cleanup, and orphan the message once the
   * post lands after finish() already returned.
   */
  private postPromise: Promise<void> | undefined;

  /** Pending trailing-edge throttle timer, if one is running. */
  private throttleTimer: ReturnType<typeof setTimeout> | undefined;

  /** Whether the label has changed since the last flush (post or update). */
  private hasUnflushedUpdate = false;

  /** 429 backoff: no chat.postMessage/chat.update calls until this passes. */
  private suppressedUntilMs = 0;

  constructor(opts: SlackProgressOptions) {
    this.client = opts.client;
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
    this.clock = opts.clock ?? SystemClock();
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
    this.startedAtMs = this.clock.now().getTime();
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

  private isSuppressed(): boolean {
    return this.clock.now().getTime() < this.suppressedUntilMs;
  }

  /** Detects a Slack `WebAPIRateLimitedError` and applies its backoff. */
  private handleIfRateLimited(err: unknown): void {
    const e = err as { code?: string; retryAfter?: number } | undefined;
    if (e?.code !== "slack_webapi_rate_limited_error") return;
    const retryAfterSec = typeof e.retryAfter === "number" ? e.retryAfter : 0;
    this.suppressedUntilMs = this.clock.now().getTime() + retryAfterSec * 1000;
  }

  /**
   * The callback passed as the Claude runner's third arg. Always drives
   * setStatus; lazily posts the first progress message; throttles further
   * updates to a 15s trailing edge; backs off on 429.
   */
  onProgress = (_usage: ModelUsage, phase?: ProgressPhase): void => {
    const label = labelForPhase(phase);
    this.latestLabel = label;
    this.hasUnflushedUpdate = true;

    void this.setStatus(label);

    if (!this.messageTs) {
      if (this.postInFlight) return; // first post already underway
      const elapsed = this.clock.now().getTime() - this.startedAtMs;
      if (elapsed >= LAZY_POST_THRESHOLD_MS) {
        this.postInFlight = true;
        this.postPromise = this.postInitialMessage();
      }
      return;
    }

    this.scheduleThrottledUpdate();
  };

  private async postInitialMessage(): Promise<void> {
    if (this.isSuppressed()) {
      this.postInFlight = false;
      return;
    }
    const sentLabel = this.latestLabel;
    try {
      const result = await this.client.chat.postMessage({
        channel: this.channel,
        thread_ts: this.threadTs,
        text: sentLabel,
      });
      const ts = (result as { ts?: string } | undefined)?.ts;
      if (ts) {
        this.messageTs = ts;
        if (this.latestLabel === sentLabel) {
          this.hasUnflushedUpdate = false;
        } else {
          // A newer milestone arrived while this post was in flight — its
          // label was never sent (chat.postMessage captured sentLabel
          // synchronously before this await suspended). Leave the pending
          // flag set and schedule a flush so it isn't silently dropped.
          this.hasUnflushedUpdate = true;
          this.scheduleThrottledUpdate();
        }
      }
    } catch (err) {
      this.handleIfRateLimited(err);
    } finally {
      this.postInFlight = false;
    }
  }

  private scheduleThrottledUpdate(): void {
    if (this.throttleTimer) return; // a flush is already scheduled
    this.throttleTimer = this.setTimeoutFn(() => {
      this.throttleTimer = undefined;
      void this.flushUpdate();
    }, THROTTLE_WINDOW_MS);
  }

  private async flushUpdate(): Promise<void> {
    if (!this.messageTs || !this.hasUnflushedUpdate) return;
    if (this.isSuppressed()) return;
    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.messageTs,
        text: this.latestLabel,
      });
      this.hasUnflushedUpdate = false;
    } catch (err) {
      this.handleIfRateLimited(err);
    }
  }

  /**
   * Call in the handler's completion path (finally block or equivalent).
   * Clears the AI-app status, cancels any pending throttle timer, and either
   * deletes the progress message (the real reply is the artifact) or, if
   * that fails, falls back to a collapsed terminal chat.update.
   */
  async finish(): Promise<void> {
    if (this.throttleTimer) {
      this.clearTimeoutFn(this.throttleTimer);
      this.throttleTimer = undefined;
    }

    // Let an in-flight lazy post land first — otherwise messageTs is still
    // unset here, cleanup is skipped, and the message posted moments later
    // is orphaned in the channel forever.
    if (this.postPromise) await this.postPromise;

    await this.setStatus("");

    if (!this.messageTs) return;

    try {
      await this.client.chat.delete({
        channel: this.channel,
        ts: this.messageTs,
      });
    } catch {
      await this.client.chat
        .update({
          channel: this.channel,
          ts: this.messageTs,
          text: "Done",
        })
        .catch(() => {});
    }
  }
}
