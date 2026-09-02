/**
 * agent/src/slack-thread-status-tracker.ts
 *
 * Per-thread reference counter that gates whether SlackProgress.start()/
 * finish() actually fire agents.sessions.setStatus.
 *
 * agents.sessions.setStatus is a per-thread lifecycle status, not per-message
 * — but each of the three Slack handlers in slack.ts (app.message,
 * app_mention, reaction_added) constructs its own SlackProgress and calls
 * start()/finish() independently around its own runner() call. Messages on
 * the same thread are serialized behind a per-session queue, but start()
 * fires immediately on receipt (before the message enters that queue) and
 * finish() fires as soon as that specific message's own runner() call
 * resolves. Without gating, a burst of 2+ messages on the same thread flips
 * the status to "active" (idle) as soon as the FIRST message finishes, even
 * though a later message is still queued/running behind it — a false "done"
 * signal mid-queue.
 *
 * ThreadStatusTracker fixes this by only allowing the 0->1 transition (first
 * concurrent run on a thread) to trigger "processing", and only the 1->0
 * transition (last concurrent run draining) to trigger "active". Construct
 * one instance per createSlackApp() call (closure-scoped) — never
 * module-level — so multiple app instances (e.g. in tests) stay isolated
 * from each other's refcount state.
 */

export class ThreadStatusTracker {
  private readonly counts = new Map<string, number>();

  /**
   * Marks a run as starting for `key`. Returns true only when this is the
   * transition from 0 in-flight runs to 1 (the caller should then actually
   * fire progress.start()) — false for any overlapping run beyond the first.
   */
  enter(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    const next = current + 1;
    this.counts.set(key, next);
    return current === 0;
  }

  /**
   * Marks a run as finished for `key`. Returns true only when this is the
   * transition from 1 in-flight run to 0 (the caller should then actually
   * fire progress.finish()) — false while other runs are still in flight.
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
