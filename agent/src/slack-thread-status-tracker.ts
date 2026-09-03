/**
 * agent/src/slack-thread-status-tracker.ts
 *
 * Per-thread reference counter used by all three Slack handlers in
 * slack.ts (app.message, app_mention, reaction_added) around their own
 * SlackProgress instance's start()/finish() calls.
 *
 * Each handler constructs its own SlackProgress and calls start()/finish()
 * independently around its own runner() call, unconditionally — every
 * message gets its own independent chat.startStream/appendStream/stopStream
 * lifecycle regardless of the refcount. enter()/exit() are ALWAYS called by
 * every handler — every enter() needs a matching exit(), or the refcount
 * leaks upward forever — but their boolean return values are used only to
 * select (STS2-1.1):
 *
 *   (a) the seed card's title ("Queued…" when enter() signals another
 *       message on this thread is already in flight, "Thinking…"
 *       otherwise), and
 *   (b) the session_status stopStream closes with ("processing" when
 *       exit() signals other messages are still in flight, "active" only
 *       for the genuine last one — see SlackProgress.finish() in
 *       slack-progress.ts).
 *
 * Construct one instance per createSlackApp() call (closure-scoped) — never
 * module-level — so multiple app instances (e.g. in tests) stay isolated
 * from each other's refcount state.
 */

export class ThreadStatusTracker {
  private readonly counts = new Map<string, number>();

  /**
   * Marks a run as starting for `key`. Always called. Returns true only
   * when this is the transition from 0 in-flight runs to 1 — false for any
   * overlapping run beyond the first. Callers call progress.start()
   * unconditionally and use this only to pick the seed card's title (see
   * the module doc comment).
   */
  enter(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    const next = current + 1;
    this.counts.set(key, next);
    return current === 0;
  }

  /**
   * Marks a run as finished for `key`. Always called — every enter() needs
   * a matching exit(). Returns true only when this is the transition from 1
   * in-flight run to 0 — false while other runs are still in flight.
   * Callers call progress.finish() unconditionally and use this only to
   * pick the session_status stopStream closes with (see the module doc
   * comment).
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
