/**
 * agent/src/slack-thread-status-tracker.ts
 *
 * Per-thread reference counter used by all three Slack handlers in
 * slack.ts (app.message, app_mention, reaction_added) around their own
 * SlackProgress instance's start()/finish() calls.
 *
 * agents.sessions.setStatus is a per-thread lifecycle status, not per-message
 * — but each handler constructs its own SlackProgress and calls
 * start()/finish() independently around its own runner() call. Messages on
 * the same thread are serialized behind a per-session queue, but start()
 * fires immediately on receipt (before the message enters that queue) and
 * finish() fires as soon as that specific message's own runner() call
 * resolves. Without gating, a burst of 2+ messages on the same thread flips
 * the status to "active" (idle) as soon as the FIRST message finishes, even
 * though a later message is still queued/running behind it — a false "done"
 * signal mid-queue.
 *
 * enter()/exit() are ALWAYS called by every handler, in both modes — every
 * enter() needs a matching exit(), or the refcount leaks upward forever.
 * What their boolean return values are used FOR differs by mode (STS2-1.1):
 *
 *   - Non-streaming (thinkingStepsEnabled off, the original SSF-1.1 design):
 *     the boolean still GATES whether start()/finish() get called at all —
 *     only the 0->1 transition (first concurrent run on a thread) actually
 *     fires agents.sessions.setStatus("processing"), and only the 1->0
 *     transition (last concurrent run draining) fires setStatus("active").
 *   - Streaming (thinkingStepsEnabled on): every message gets its own
 *     independent chat.startStream/appendStream/stopStream lifecycle
 *     regardless of the refcount — start()/finish() are called
 *     unconditionally. The boolean instead selects (a) the seed card's
 *     title ("Queued…" when enter() signals another message on this thread
 *     is already in flight, "Thinking…" otherwise) and (b) the
 *     session_status stopStream closes with ("processing" when exit()
 *     signals other messages are still in flight, "active" only for the
 *     genuine last one — see SlackProgress.finish() in slack-progress.ts).
 *
 * Construct one instance per createSlackApp() call (closure-scoped) — never
 * module-level — so multiple app instances (e.g. in tests) stay isolated
 * from each other's refcount state.
 */

export class ThreadStatusTracker {
  private readonly counts = new Map<string, number>();

  /**
   * Marks a run as starting for `key`. Always called, in both modes. Returns
   * true only when this is the transition from 0 in-flight runs to 1 —
   * false for any overlapping run beyond the first. Non-streaming callers
   * use this to gate whether progress.start() is actually called; streaming
   * callers call progress.start() unconditionally and use this only to pick
   * the seed card's title (see the module doc comment).
   */
  enter(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    const next = current + 1;
    this.counts.set(key, next);
    return current === 0;
  }

  /**
   * Marks a run as finished for `key`. Always called, in both modes —
   * every enter() needs a matching exit(). Returns true only when this is
   * the transition from 1 in-flight run to 0 — false while other runs are
   * still in flight. Non-streaming callers use this to gate whether
   * progress.finish() is actually called; streaming callers call
   * progress.finish() unconditionally and use this only to pick the
   * session_status stopStream closes with (see the module doc comment).
   *
   * Calling exit() on a key that is already at 0 (never entered, or already
   * fully drained) is a no-op that returns false rather than going negative
   * or throwing.
   */
  exit(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    if (current === 0) return false;
    const next = current - 1;
    if (next === 0) {
      // Clean up so the map doesn't grow unbounded with fully-drained keys.
      this.counts.delete(key);
      return true;
    }
    this.counts.set(key, next);
    return false;
  }
}
