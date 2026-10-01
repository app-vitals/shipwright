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
   * falls back to state/agent-policy.md while this is false, so a
   * persistent config-sync failure (or the brief window before the first
   * tick) doesn't silently override an operator's file-based policy with an
   * unsynced default.
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
 * readCleanupAfterDays() reads it as the DB tier before falling back to
 * state/agent-policy.md, so a DB-side change (via PATCH /agents/:id) takes
 * effect on the very next config-sync tick without requiring an agent
 * restart. If the agent's config bundle never becomes available,
 * hasSynced() stays false for the process lifetime — readers must fall
 * through to the file tier in that case.
 */
export const cleanupAfterDaysRef: CleanupAfterDaysRef =
  createCleanupAfterDaysRef();
