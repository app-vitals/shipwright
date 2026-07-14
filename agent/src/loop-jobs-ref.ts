/**
 * agent/src/loop-jobs-ref.ts
 *
 * A tiny mutable box holding the most recently fetched cron-job list, so the
 * shipwright-loop cron's dispatch callback can read a live view of every
 * job's `enabled` flag on each fire instead of the list closed over at the
 * moment the loop was first scheduled.
 *
 * Why this exists: syncCrons() (agent/src/index.ts) only calls
 * nodeCron.schedule() for a job the first time it's missing from the
 * cronTasks map. The shipwright-loop job's node-cron callback used to close
 * over that one syncCrons() invocation's `jobs` array — and
 * resolveLoopPhaseToggles(jobs) (loop-cron-classifier.ts, read inside
 * runLoopTick) is what decides which of dev-task/review/patch/deploy are
 * enabled. Because the loop is scheduled once, its toggle view was frozen at
 * whatever those four jobs' enabled flags were at first-schedule time — a
 * later flag change was silently ignored until the loop cron itself was
 * fully unscheduled and rescheduled.
 *
 * The fix: keep one instance of this ref at module scope in index.ts,
 * `.set(jobs)` it at the top of every syncCrons() tick (right after the
 * fresh fetch), and have the loop's dispatch callback call `.get()` at
 * fire-time rather than closing over the per-tick `jobs` const. Kept pure
 * and zero-I/O so it's unit-testable in isolation — mirrors
 * loop-cron-classifier.ts's style.
 */

export interface JobsRef<T> {
  /** Returns the most recently set jobs list, or [] if set() was never called. */
  get(): T[];
  /** Replaces the current jobs list. */
  set(jobs: T[]): void;
}

/** Creates a new, independent jobs ref defaulting to an empty list. */
export function createJobsRef<T>(): JobsRef<T> {
  let jobs: T[] = [];

  return {
    get(): T[] {
      return jobs;
    },
    set(next: T[]): void {
      jobs = next;
    },
  };
}
