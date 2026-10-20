/**
 * agent/src/cleanup-after-days-ref.ts
 *
 * A tiny mutable box holding the agent's most recently synced
 * `cleanupAfterDays` policy field (APM-1.6), so downstream consumers
 * (check-helpers.ts's readCleanupAfterDays()) can read a live view without
 * closing over a single syncConfig() tick. Kept pure and zero-I/O so it's
 * unit-testable in isolation — mirrors allow-self-review-ref.ts's style
 * exactly.
 */

export interface CleanupAfterDaysRef {
  /**
   * Returns the most recently synced `cleanupAfterDays` value, or `14` if
   * set() was never called. The underlying Agent row field defaults to `14`
   * in the database (admin/prisma/schema.prisma), so once synced this
   * always reflects a real DB value — callers that need to distinguish
   * "never synced" (config-bundle fetch has never succeeded) from "synced
   * to a DB value of 14" must check hasSynced() rather than inferring it
   * from this return value, since both states return 14.
   */
  get(): number;
  /**
   * True once set() has been called at least once. readCleanupAfterDays()
   * returns its hardcoded default while this is false (config-sync has
   * never succeeded, e.g. the fetch keeps failing).
   */
  hasSynced(): boolean;
  /** Replaces the current cleanupAfterDays value. */
  set(cleanupAfterDays: number): void;
}

/** Creates a new, independent cleanup-after-days ref defaulting to unsynced/14. */
export function createCleanupAfterDaysRef(): CleanupAfterDaysRef {
  let cleanupAfterDays = 14;
  let synced = false;

  return {
    get(): number {
      return cleanupAfterDays;
    },
    hasSynced(): boolean {
      return synced;
    },
    set(next: number): void {
      cleanupAfterDays = next;
      synced = true;
    },
  };
}

/**
 * The process-wide cleanup-after-days ref. agent/src/index.ts's syncConfig()
 * writes into this on every successful config-sync tick; check-helpers.ts's
 * readCleanupAfterDays() reads it with a hardcoded default when unsynced, so a DB-side change (via PATCH /agents/:id) takes
 * effect on the very next config-sync tick without requiring an agent
 * restart. If the agent's config bundle never becomes available,
 * hasSynced() stays false for the process lifetime — readers must
 * return their hardcoded default in that case.
 */
export const cleanupAfterDaysRef: CleanupAfterDaysRef =
  createCleanupAfterDaysRef();

/**
 * Read the `cleanup_after_days` policy field: the synced DB value from
 * `configRef` (default: the process-wide `cleanupAfterDaysRef`), else the
 * hardcoded default `14` while the ref has never synced.
 *
 * WTR-1.4: reused as the staleness threshold gating the force-removal of a
 * merged/closed PR's worktree (see `removeWorktree`'s production
 * implementation in pr-state-reconciler.ts) — the same field that governs
 * "remove worktrees older than N days, even if the PR is still open" also
 * governs "don't force-remove a worktree younger than N days even if its PR
 * just merged/closed", so a worktree still being actively worked on by a
 * concurrent dev-task/patch/deploy session isn't yanked out from under it
 * purely on remote GitHub state.
 */
export async function readCleanupAfterDays(
  _workspacePath: string,
  configRef: CleanupAfterDaysRef = cleanupAfterDaysRef,
): Promise<number> {
  return configRef.hasSynced() ? configRef.get() : 14;
}
