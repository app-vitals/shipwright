/**
 * agent/src/slack-progress.ts
 *
 * Live Thinking Steps stream driver for Slack thread replies.
 *
 * Drives a `chat.startStream` / `chat.appendStream` / `chat.stopStream`
 * Thinking Steps stream (STS2-1.1 — replacing STS-1.1/PR #3034's broken
 * first cut, whose `{type: "task_update", text}` chunk shape was rejected by
 * Slack's real API on every single call, root-causing a permanently blank
 * stream; TSD-1.1 then removed the feature flag that gated it, making
 * streaming the only mode):
 *
 *   - `agents.sessions.setStatus` (Slack's Agent Sessions API) is called
 *     eagerly and unconditionally — once at the top of `start()`, before
 *     `startStream()` even runs, and once at the end of `finish()` — rather
 *     than treated as a stream-failure-only fallback. `chat.startStream`'s
 *     `recipient_team_id`/`recipient_user_id` requirement (see below) gates
 *     it from firing in channels until the user opens the message's thread,
 *     an inherent Slack UI limitation that channel @mentions hit but DMs
 *     don't; `setStatus` needs only `channel_id`/`thread_ts` and Slack's own
 *     docs say to call it directly when work begins, so calling it eagerly
 *     gets the native "is working" indicator showing immediately for both
 *     DMs and channel mentions instead of waiting on the stream (ISW-1.1).
 *     The two calls are independent, not either/or: `finish()` always calls
 *     `setStatus` AND still calls `stopStream()` whenever a stream did open.
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
 *   - `finish()` always closes any still-open card before stopping the
 *     stream, even when the run's reply was suppressed (e.g. a [silent]
 *     marker resolved the response and deliverContent() was never called) —
 *     otherwise the seed card's `in_progress` state is left dangling in the
 *     channel forever (STS2-3.1). The fallback title is empty (STS-2.1
 *     AC #4 — "Done" was getting prepended to the response preview in
 *     Slack's UI), unless the caller passes `finish({ silent: true })`, in
 *     which case it's "Ack" — a distinct, deliberately terse label so the
 *     card doesn't imply a real reply was posted, while still giving a
 *     visual signal that Bodhi processed the message and chose not to
 *     reply, rather than something having silently broken.
 *   - `startStream()` passes `recipient_team_id`/`recipient_user_id`
 *     whenever the conversation isn't a DM (see `SlackProgressOptions.isDM`)
 *     — Slack's own SDK types document both as "required when starting a
 *     streaming conversation outside of a DM"; omitting them was the
 *     STS-2.1 root cause (`missing_recipient_team_id` on every channel/group
 *     thread). `finish()` calls `agents.sessions.setStatus` unconditionally
 *     (ISW-1.1) — not only as a fallback when `startStream()` never obtained
 *     a `ts` — so a stream-open failure (for any reason) can never
 *     permanently strand the "is working" indicator, and the indicator is
 *     authoritatively resolved by `setStatus` even when a stream did open
 *     and `stopStream()` also runs.
 *
 * Repeated identical phases collapse into a single appendStream call,
 * mirroring the phase-collapse `_consumeStream` already does upstream in
 * claude.ts before invoking `onProgress` — SlackProgress collapses
 * independently too, since its own onProgress is unit-tested in isolation
 * from that upstream collapsing.
 *
 * Every Slack API call is wrapped in try/catch — a progress failure must
 * never throw or break the real reply. This covers a client that lacks the
 * `chat` namespace entirely (property access throws synchronously), not
 * just a call that rejects. `onProgress` is a *synchronous* callback (see
 * `ProgressCallback` in claude.ts), so `chat.appendStream` is fired without
 * `await`: the property-access + call is wrapped in a synchronous try/catch
 * (for the missing-namespace case) and the returned promise gets a trailing
 * `.catch()` (for the async-rejection case). `deliverContent()` IS awaited
 * (its caller needs to know whether to fall back to say()/blocksConverter),
 * so it awaits the promise directly inside its own try/catch instead.
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
   * True when this run's thread is a DM. Slack's own SDK types document
   * `recipient_team_id`/`recipient_user_id` on `chat.startStream` as
   * "required when starting a streaming conversation outside of a DM" —
   * omitting them in a channel/group thread makes every call fail with
   * `missing_recipient_team_id` (STS-2.1). Passing them for an actual DM
   * isn't meaningful (the DM already fully identifies the recipient), so
   * `startStream()` omits both fields entirely when `isDM` is true,
   * regardless of whether `recipientTeamId`/`recipientUserId` were supplied.
   */
  isDM: boolean;
  /**
   * The triggering user's Slack ID — required by `chat.startStream()` for
   * every non-DM stream (see `isDM`). Ignored (and may be omitted) for DMs.
   */
  recipientUserId?: string;
  /**
   * The bot's own workspace team ID. Resolved once by the caller via
   * `client.auth.test()` and cached (see `createSlackApp()` in slack.ts) —
   * required by `chat.startStream()` for every non-DM stream (see `isDM`).
   * Ignored (and may be omitted) for DMs.
   */
  recipientTeamId?: string;
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
   * session_status stopStream closes with ("processing" instead of
   * "active") — every message still gets its own independent
   * finish()/stream-close call regardless of this flag.
   */
  stillInFlight?: boolean;
  /**
   * True when the caller suppressed the reply (e.g. a [silent] marker
   * resolved the run with nothing to post). When the run's card hasn't
   * already been closed by deliverContent(), finish() still must close the
   * stream's dangling in_progress card (STS2-3.1) — but titles it "Ack"
   * instead of the generic "Done", since "Done" implies a real reply went
   * out. Has no effect once deliverContent() has already closed the card.
   */
  silent?: boolean;
}

/** Text used for the seed task_update card's title. Always ends in "…". */
function seedTitle(opts: SlackProgressStartOptions | undefined): string {
  return opts?.queued ? "Queued…" : "Thinking…";
}

/**
 * Title for the terminal task_update card. Never ends in "…" (AC #4).
 * Empty — not "Done" — because the "Done" title was getting prepended to
 * the response preview in Slack's UI, adding confusion (STS-2.1 AC #4).
 * Slack's TaskUpdateChunk type (`@slack/types`) declares `title: string`
 * with no documented minLength constraint, so an empty string is used
 * directly; if Slack's live API ever proves to reject a true empty string,
 * fall back to a single space (`" "`) instead.
 */
const COMPLETE_TITLE = "";

/** Title for the terminal card on a thrown run (STS2-4.1 AC #1). */
const ERROR_TITLE = "Error";

/**
 * Title for the terminal task_update card when finish() closes it for a
 * suppressed (e.g. [silent]-marker) response — see SlackProgressFinishOptions
 * (STS2-3.1). Distinct from COMPLETE_TITLE so the card doesn't imply a real
 * reply was posted, while still giving a visual signal the run completed
 * rather than having silently broken.
 */
const SILENT_COMPLETE_TITLE = "Ack";

/**
 * Drives the live Thinking Steps stream for a single Claude run. One
 * instance per run — construct it where "processing" used to be set, pass
 * `progress.onProgress` (bound) as the runner's third arg, try
 * `progress.deliverContent()` before falling back to say()/blocksConverter,
 * and call `progress.finish()` in the handler's completion path.
 */
export class SlackProgress {
  private readonly client: SlackClient;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly isDM: boolean;
  private readonly recipientUserId: string | undefined;
  private readonly recipientTeamId: string | undefined;
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
  // Set by markExternallyStopped() when Slack's agent_session_stopped event
  // fires for this run's stream (AGS-1.1). Once true, every further
  // appendStream/stopStream call becomes a no-op instead of an API call —
  // Slack has already discarded the stream server-side, so any further
  // write would just fail with message_not_in_streaming_state. Mirrors
  // openclaw's applySlackStreamStop pattern.
  private externallyStopped = false;

  constructor(opts: SlackProgressOptions) {
    this.client = opts.client;
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
    this.isDM = opts.isDM;
    this.recipientUserId = opts.recipientUserId;
    this.recipientTeamId = opts.recipientTeamId;
    this.taskId = `thinking-steps-${this.channel}-${this.threadTs}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Call once, up front. Eagerly sets the session status to "processing" via
   * agents.sessions.setStatus (ISW-1.1) before opening the Thinking Steps
   * stream, so Slack's native "is working" indicator shows immediately —
   * chat.startStream's recipient_team_id/recipient_user_id requirement (see
   * SlackProgressOptions.isDM) means its own stream-status effect is gated
   * behind the user opening the message's thread in a channel, an inherent
   * Slack UI limitation channel @mentions hit but DMs don't. A setStatus
   * failure here is caught and logged like every other Slack API call in
   * this file — it must never block startStream() or the seed card below.
   * Then opens the Thinking Steps stream and seeds it with an immediate
   * in_progress card (AC #4).
   */
  async start(opts?: SlackProgressStartOptions): Promise<void> {
    await this.setSessionStatus("processing");
    await this.startStream();
    this.appendTaskUpdate(seedTitle(opts), "in_progress");
  }

  /**
   * The `channel:streaming_message_ts` key identifying this run's live
   * Thinking Steps stream, matching the shape Slack's agent_session_stopped
   * event carries (event.channel + event.streaming_message_ts) — used by
   * createSlackApp()'s closure-scoped registry (AGS-1.1) to look up the
   * SlackProgress instance a stopped-stream event refers to. Returns
   * undefined before the stream has opened (flag off, start() not yet
   * called, or startStream() failed to obtain a `ts`).
   */
  streamKey(): string | undefined {
    if (!this.streamTs) return undefined;
    return `${this.channel}:${this.streamTs}`;
  }

  /**
   * This run's actual thread ts (as opposed to the stream's own message ts
   * returned by streamKey()) — the value agents.sessions.setStatus expects
   * for `thread_ts`. Used by createSlackApp()'s agent_session_stopped
   * handler (AGS-1.1) to reset the correct thread's status once the
   * matching SlackProgress instance has been found via streamKey().
   */
  getThreadTs(): string {
    return this.threadTs;
  }

  /**
   * Marks this run's stream as externally stopped by Slack (AGS-1.1) — call
   * when the agent_session_stopped event fires for this instance's
   * streamKey(). From this point on, appendTaskUpdate/deliverContent/
   * reportError/stopStream are all no-ops: Slack has already discarded the
   * stream server-side, so any further write would only fail with
   * message_not_in_streaming_state. Idempotent and safe to call more than
   * once.
   */
  markExternallyStopped(): void {
    this.externallyStopped = true;
  }

  private async startStream(): Promise<void> {
    // Whole call (including the `chat` property access) wrapped in
    // try/catch — see the module-level doc comment.
    try {
      const resp = await this.client.chat.startStream({
        channel: this.channel,
        thread_ts: this.threadTs,
        task_display_mode: "timeline",
        // recipient_team_id/recipient_user_id are "required when starting a
        // streaming conversation outside of a DM" per Slack's own SDK types
        // — omitted entirely for DMs, where they're not required and may
        // not even be meaningful (STS-2.1 AC #1/#2).
        ...(this.isDM
          ? {}
          : {
              recipient_team_id: this.recipientTeamId,
              recipient_user_id: this.recipientUserId,
            }),
      });
      this.streamTs = resp?.ts;
    } catch (err) {
      console.warn(
        "[slack-progress] startStream failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * The callback passed as the Claude runner's third arg. Appends one
   * Thinking Steps chunk per *distinct* phase transition — repeats of the
   * same phase (or an undefined phase, i.e. a usage-only tick) are no-ops.
   */
  onProgress = (_usage: ModelUsage, phase?: ProgressPhase): void => {
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
    if (this.externallyStopped) return;
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
   * streaming is unavailable (stream never opened, or the append call
   * itself rejects) — the caller MUST fall back to say()/blocksConverter in
   * that case; the reply must never be silently dropped.
   */
  async deliverContent(text: string): Promise<true | undefined> {
    if (!this.streamTs) return undefined;
    if (this.externallyStopped) return undefined;
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
   * No-op (matching `deliverContent()`'s guard) when no stream is open —
   * never throws, never calls `chat.appendStream` in that case. Sets the
   * same `completed` flag `deliverContent()` sets, so `finish()`'s "only if
   * !this.completed" guard doesn't send a redundant `status: "complete"`
   * card after the error card.
   */
  reportError(): void {
    if (!this.streamTs) return;
    if (this.externallyStopped) return;
    this.appendTaskUpdate(ERROR_TITLE, "error");
    this.completed = true;
  }

  /**
   * Call in the handler's completion path (finally block or equivalent).
   * Closes out the run's card with a final status:"complete" update (unless
   * deliverContent() already sent one), then unconditionally sets the final
   * session status via agents.sessions.setStatus (ISW-1.1) — the
   * authoritative resolution of Slack's native "is working" indicator,
   * independent of whether a stream ever opened — AND, whenever a stream
   * did open (this.streamTs is set), also closes it via stopStream, passing
   * the same session_status through. session_status defaults to "active"
   * and is per-thread, not per-message, so the caller must pass
   * `stillInFlight: true` for every message except the genuine last one to
   * finish in a burst (AC #5). The card's title is empty (COMPLETE_TITLE),
   * unless `opts.silent` signals the reply was suppressed
   * (e.g. a [silent] marker), in which case it's titled "Ack" instead
   * (STS2-3.1) — closing the dangling in_progress card either way so no
   * in-progress indicator is left visible in the channel forever.
   */
  async finish(opts?: SlackProgressFinishOptions): Promise<void> {
    const sessionStatus = opts?.stillInFlight ? "processing" : "active";
    if (!this.completed) {
      const title = opts?.silent ? SILENT_COMPLETE_TITLE : COMPLETE_TITLE;
      this.appendTaskUpdate(title, "complete");
    }
    // Unconditional and authoritative (ISW-1.1) — no longer gated behind
    // "only when startStream() never opened" (see setSessionStatus's doc
    // comment). Independent of stopStream() below, not either/or.
    await this.setSessionStatus(sessionStatus);
    if (this.streamTs) {
      await this.stopStream(sessionStatus);
    }
  }

  private async stopStream(
    sessionStatus: "active" | "processing",
  ): Promise<void> {
    if (this.externallyStopped) return;
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

  /**
   * Shared helper for both eager call sites (ISW-1.1): start() calls this
   * with a fixed "processing" before startStream() even runs, so Slack's
   * native "is working" indicator shows immediately regardless of whether
   * chat.startStream ever succeeds; finish() calls this unconditionally
   * (independent of whether a stream opened) as the authoritative
   * resolution of that indicator, alongside — not instead of — stopStream()
   * whenever a stream did open. No longer a stream-failure-only fallback.
   * Needs only channel_id/thread_ts (no recipient_team_id/recipient_user_id,
   * unlike chat.startStream in non-DM channels — see SlackProgressOptions.
   * isDM), and never throws: every Slack API call in this file is wrapped in
   * try/catch, including the property access itself (a client missing the
   * `agents` namespace entirely throws synchronously on access, not just on
   * a rejected call). Mirrors the shape used by slack.ts's
   * agent_session_stopped handler for the same API.
   */
  private async setSessionStatus(
    sessionStatus: "active" | "processing",
  ): Promise<void> {
    if (this.externallyStopped) return;
    try {
      await this.client.agents.sessions.setStatus({
        channel_id: this.channel,
        thread_ts: this.threadTs,
        status: sessionStatus,
      });
    } catch (err) {
      console.warn(
        "[slack-progress] setStatus failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
