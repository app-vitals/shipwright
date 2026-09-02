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
 * (or "processing", when other messages on the thread are still in flight)
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
 * When `thinkingStepsEnabled` is set, SlackProgress instead drives a
 * `chat.startStream` / `chat.appendStream` / `chat.stopStream` Thinking Steps
 * stream (STS2-1.1 — replacing STS-1.1/PR #3034's broken first cut, whose
 * `{type: "task_update", text}` chunk shape was rejected by Slack's real API
 * on every single call, root-causing a permanently blank stream):
 *
 *   - `agents.sessions.setStatus` is skipped ENTIRELY in this mode —
 *     `chat.startStream` already flips the session status to "processing"
 *     itself, so calling both produces two overlapping "is working"
 *     indicators.
 *   - `start()` opens the stream and immediately seeds it with an
 *     `in_progress` task_update card (no blank gap before the first real
 *     phase transition), titled "Thinking…" or "Queued…" depending on the
 *     caller-supplied `queued` flag (see `ThreadStatusTracker`).
 *   - Every task_update chunk — the seed card, each phase transition from
 *     `onProgress`, and the terminal card from `deliverContent()`/`finish()`
 *     — uses the `{type, id, title, status}` shape with ONE stable `id`
 *     reused for the life of the run: a fresh id per update stacks a
 *     separate card in Slack's timeline UI instead of updating the existing
 *     one in place (confirmed live, a second STS-1.1 bug). `status` is
 *     `"in_progress"` for the seed/phase cards and `"complete"` for the
 *     terminal one — leaving the final card `"in_progress"` when the stream
 *     closes renders as an error/warning triangle even on success.
 *   - The final reply text is delivered via `deliverContent()` as its own
 *     `markdown_text` chunk (alongside the terminal `status: "complete"`
 *     task_update) through `chat.appendStream` — NOT via `chat.stopStream`'s
 *     top-level `markdown_text` param, which Slack rejects with
 *     `streaming_mode_mismatch` once `task_display_mode: "timeline"` locks
 *     the stream into chunk-based mode.
 *   - `finish()` passes `session_status` through to `chat.stopStream`
 *     ("active" for the genuine last-to-finish message of a burst,
 *     "processing" while others are still in flight — stopStream's
 *     `session_status` defaults to "active" and is per-thread, not
 *     per-message, so without this the first-to-finish message of a burst
 *     would prematurely dismiss the "is working" indicator for the whole
 *     thread).
 *
 * This is entirely additive and off by default: when the flag is
 * unset/false, none of chat.startStream/appendStream/stopStream are ever
 * called, and behavior is byte-identical to before this flag existed.
 * Repeated identical phases collapse into a single appendStream call,
 * mirroring the phase-collapse `_consumeStream` already does upstream in
 * claude.ts before invoking `onProgress` — SlackProgress collapses
 * independently too, since its own onProgress is unit-tested in isolation
 * from that upstream collapsing.
 *
 * Every Slack API call is wrapped in try/catch — a progress failure must
 * never throw or break the real reply. This covers a client that lacks the
 * `agents`/`chat` namespace entirely (property access throws
 * synchronously), not just a call that rejects. `onProgress` is a
 * *synchronous* callback (see `ProgressCallback` in claude.ts), so
 * `chat.appendStream` is fired without `await`: the property-access + call
 * is wrapped in a synchronous try/catch (for the missing-namespace case) and
 * the returned promise gets a trailing `.catch()` (for the async-rejection
 * case). `deliverContent()` IS awaited (its caller needs to know whether to
 * fall back to say()/blocksConverter), so it awaits the promise directly
 * inside its own try/catch instead.
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

export interface SlackProgressStartOptions {
  /**
   * True when the caller (ThreadStatusTracker.enter()'s inverse — see
   * slack-thread-status-tracker.ts) signals another message on this thread
   * is already in flight. Only changes the seed card's title ("Queued…"
   * instead of "Thinking…") — every message still gets its own independent
   * start()/stream lifecycle regardless of this flag.
   */
  queued?: boolean;
}

export interface SlackProgressFinishOptions {
  /**
   * True when the caller (ThreadStatusTracker.exit()'s inverse) signals
   * other messages on this thread are still in flight. Only changes the
   * session_status stopStream/setStatus closes with ("processing" instead
   * of "active") — every message still gets its own independent
   * finish()/stream-close call regardless of this flag.
   */
  stillInFlight?: boolean;
}

/** Text used for the seed task_update card's title. Always ends in "…". */
function seedTitle(opts: SlackProgressStartOptions | undefined): string {
  return opts?.queued ? "Queued…" : "Thinking…";
}

/** Title for the terminal task_update card. Never ends in "…" (AC #4). */
const COMPLETE_TITLE = "Done";

/** Title for the terminal card on a thrown run (STS2-4.1 AC #1). */
const ERROR_TITLE = "Error";

/**
 * Drives the agents.sessions.setStatus lifecycle status (when
 * `thinkingStepsEnabled` is off), or the live Thinking Steps stream (when
 * it's on), for a single Claude run. One instance per run — construct it
 * where "processing" used to be set, pass `progress.onProgress` (bound) as
 * the runner's third arg, try `progress.deliverContent()` before falling
 * back to say()/blocksConverter, and call `progress.finish()` in the
 * handler's completion path.
 */
export class SlackProgress {
  private readonly client: SlackClient;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly thinkingStepsEnabled: boolean;
  private streamTs: string | undefined;
  private lastFiredPhase: ProgressPhase | undefined;
  // One stable id for every task_update chunk in this run's stream — a
  // fresh id per update stacks a separate card in Slack's timeline UI
  // instead of updating the existing one in place (AC #1).
  private readonly taskId: string;
  // Set once the terminal (status:"complete") card has been sent, whether
  // via deliverContent() or finish()'s own fallback — prevents finish()
  // from sending a redundant second "complete" update.
  private completed = false;

  constructor(opts: SlackProgressOptions) {
    this.client = opts.client;
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
    this.thinkingStepsEnabled = opts.thinkingStepsEnabled ?? false;
    this.taskId = `thinking-steps-${this.channel}-${this.threadTs}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Call once, up front. When `thinkingStepsEnabled` is off, announces the
   * initial "processing" agent-session status. When on, opens the Thinking
   * Steps stream and seeds it with an immediate in_progress card (AC #4) —
   * agents.sessions.setStatus is skipped entirely in this mode, since
   * chat.startStream already flips the session status itself (AC #3).
   */
  async start(opts?: SlackProgressStartOptions): Promise<void> {
    if (this.thinkingStepsEnabled) {
      await this.startStream();
      this.appendTaskUpdate(seedTitle(opts), "in_progress");
    } else {
      await this.setStatus("processing");
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
    this.appendTaskUpdate(PROGRESS_LABELS[phase], "in_progress");
  };

  // Fire-and-forget: onProgress is a synchronous callback (ProgressCallback
  // is not async), so this can't be awaited. The property access + call is
  // wrapped in a synchronous try/catch (client missing `chat` entirely), and
  // the returned promise gets a trailing `.catch()` (async rejection).
  //
  // Always the {type, id, title, status} shape with this.taskId reused
  // across every call — see the module-level doc comment for why the old
  // {type, text} shape (and a fresh id per update) were the STS-1.1 bugs.
  private appendTaskUpdate(
    title: string,
    status: "in_progress" | "complete" | "error",
  ): void {
    const label = `appendStream(${title})`;
    try {
      this.client.chat
        .appendStream({
          channel: this.channel,
          thread_ts: this.threadTs,
          ts: this.streamTs,
          chunks: [{ type: "task_update", id: this.taskId, title, status }],
        })
        .catch((err: unknown) => {
          console.warn(
            `[slack-progress] ${label} failed:`,
            err instanceof Error ? err.message : String(err),
          );
        });
    } catch (err) {
      console.warn(
        `[slack-progress] ${label} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Delivers the final reply text through the Thinking Steps stream as its
   * own markdown_text chunk, alongside a status:"complete" task_update
   * closing out the run's card (AC #2) — NOT via chat.stopStream's
   * top-level markdown_text param, which Slack rejects with
   * streaming_mode_mismatch once task_display_mode:"timeline" locks the
   * stream into chunk-based mode.
   *
   * Returns `true` on success, or `undefined` whenever delivery fails or
   * streaming is unavailable (flag off, stream never opened, or the append
   * call itself rejects) — the caller MUST fall back to
   * say()/blocksConverter in that case; the reply must never be silently
   * dropped.
   */
  async deliverContent(text: string): Promise<true | undefined> {
    if (!this.thinkingStepsEnabled) return undefined;
    if (!this.streamTs) return undefined;
    try {
      await this.client.chat.appendStream({
        channel: this.channel,
        thread_ts: this.threadTs,
        ts: this.streamTs,
        chunks: [
          { type: "markdown_text", text },
          {
            type: "task_update",
            id: this.taskId,
            title: COMPLETE_TITLE,
            status: "complete",
          },
        ],
      });
      this.completed = true;
      return true;
    } catch (err) {
      console.warn(
        "[slack-progress] deliverContent failed:",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  /**
   * Call from the handler's catch block when the run throws, before
   * `finish()` closes the stream (STS2-4.1 AC #1). Marks the run's card
   * `status: "error"` so a thrown run doesn't leave the card stuck in
   * whatever `in_progress` state it was last in. This is a UI-state signal
   * only — the caller's existing `sentryClient.captureException(err)` call
   * remains the single log point for the error; this method does not log.
   *
   * No-op (matching `deliverContent()`'s guard) when `thinkingStepsEnabled`
   * is off or no stream is open — never throws, never calls
   * `chat.appendStream` in that case. Sets the same `completed` flag
   * `deliverContent()` sets, so `finish()`'s "only if !this.completed" guard
   * doesn't send a redundant `status: "complete"` card after the error card.
   */
  reportError(): void {
    if (!this.thinkingStepsEnabled) return;
    if (!this.streamTs) return;
    this.appendTaskUpdate(ERROR_TITLE, "error");
    this.completed = true;
  }

  /**
   * Call in the handler's completion path (finally block or equivalent).
   * When `thinkingStepsEnabled` is off, sets the agent-session status back
   * to "active" (idle/ready — thread stays open for follow-ups), or
   * "processing" when `stillInFlight` signals other messages on this
   * thread haven't finished yet. When on, closes out the run's card with a
   * final status:"complete" update (unless deliverContent() already sent
   * one) and closes the Thinking Steps stream, passing session_status
   * through to stopStream — stopStream's session_status defaults to
   * "active" and is per-thread, not per-message, so the caller must pass
   * `stillInFlight: true` for every message except the genuine last one to
   * finish in a burst (AC #5).
   */
  async finish(opts?: SlackProgressFinishOptions): Promise<void> {
    const sessionStatus = opts?.stillInFlight ? "processing" : "active";
    if (this.thinkingStepsEnabled) {
      if (!this.completed) {
        this.appendTaskUpdate(COMPLETE_TITLE, "complete");
      }
      await this.stopStream(sessionStatus);
    } else {
      await this.setStatus(sessionStatus);
    }
  }

  private async stopStream(
    sessionStatus: "active" | "processing",
  ): Promise<void> {
    try {
      await this.client.chat.stopStream({
        channel: this.channel,
        thread_ts: this.threadTs,
        ts: this.streamTs,
        session_status: sessionStatus,
      });
    } catch (err) {
      console.warn(
        "[slack-progress] stopStream failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
