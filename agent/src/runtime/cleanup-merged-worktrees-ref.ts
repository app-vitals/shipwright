/**
 * agent/src/runtime/cleanup-merged-worktrees-ref.ts
 *
 * A tiny mutable box holding the agent's most recently synced
 * `cleanupMergedWorktrees` policy field (APM-1.6), so downstream consumers
 * (check-helpers.ts's readCleanupMergedWorktrees()) can read a live view
 * without closing over a single syncConfig() tick. Kept pure and zero-I/O so
 * it's unit-testable in isolation — mirrors allow-self-review-ref.ts's style
 * exactly.
 */

export interface CleanupMergedWorktreesRef {
  /**
   * Returns the most recently synced `cleanupMergedWorktrees` value, or
   * `true` if set() was never called. The underlying Agent row field
   * defaults to `true` in the database (admin/prisma/schema.prisma), so once
   * synced this always reflects a real DB value — callers that need to
   * distinguish "never synced" (config-bundle fetch has never succeeded)
   * from "synced to a DB value of true" must check hasSynced() rather than
   * inferring it from this return value, since both states return true.
   */
  get(): boolean;
  /**
   * True once set() has been called at least once. readCleanupMergedWorktrees()
   * returns its hardcoded default while this is false (config-sync has
   * never succeeded, e.g. the fetch keeps failing).
   */
  hasSynced(): boolean;
  /** Replaces the current cleanupMergedWorktrees value. */
  set(cleanupMergedWorktrees: boolean): void;
}

/** Creates a new, independent cleanup-merged-worktrees ref defaulting to unsynced/true. */
export function createCleanupMergedWorktreesRef(): CleanupMergedWorktreesRef {
  let cleanupMergedWorktrees = true;
  let synced = false;

  return {
    get(): boolean {
      return cleanupMergedWorktrees;
    },
    hasSynced(): boolean {
      return synced;
    },
    set(next: boolean): void {
      cleanupMergedWorktrees = next;
      synced = true;
    },
  };
}

/**
 * The process-wide cleanup-merged-worktrees ref. agent/src/index.ts's
 * syncConfig() writes into this on every successful config-sync tick;
 * check-helpers.ts's readCleanupMergedWorktrees() reads it with a hardcoded default when unsynced, so a DB-side change (via
 * PATCH /agents/:id) takes effect on the very next config-sync tick without
 * requiring an agent restart. If the agent's config bundle never becomes
 * available, hasSynced() stays false for the process lifetime — readers
 * readers must return their hardcoded default in that case.
 */
export const cleanupMergedWorktreesRef: CleanupMergedWorktreesRef =
  createCleanupMergedWorktreesRef();

/**
 * Read the `cleanup_merged_worktrees` policy field (WTR-1.1): the synced DB
 * value from `configRef` (default: the process-wide
 * `cleanupMergedWorktreesRef`), else the hardcoded default `true` while the
 * ref has never synced. Same shape as `readAllowSelfReview()`.
 */
export async function readCleanupMergedWorktrees(
  _workspacePath: string,
  configRef: CleanupMergedWorktreesRef = cleanupMergedWorktreesRef,
): Promise<boolean> {
  return configRef.hasSynced() ? configRef.get() : true;
}
