/**
 * agent/src/coding/allow-self-review-ref.ts
 *
 * A tiny mutable box holding the agent's most recently synced
 * `allowSelfReview` policy field (APM-1.4), so downstream consumers
 * (check-helpers.ts's readAllowSelfReview()) can read a live view without
 * closing over a single syncConfig() tick. Kept pure and zero-I/O so it's
 * unit-testable in isolation — mirrors agent-trial-expiry-ref.ts's style
 * exactly.
 */

export interface AllowSelfReviewRef {
  /**
   * Returns the most recently synced `allowSelfReview` value, or `false` if
   * set() was never called. The underlying Agent row field defaults to
   * `false` in the database (admin/prisma/schema.prisma), so once synced
   * this always reflects a real DB value — callers that need to distinguish
   * "never synced" (config-bundle fetch has never succeeded) from "synced to
   * a DB value of false" must check hasSynced() rather than inferring it
   * from this return value, since both states return false.
   */
  get(): boolean;
  /**
   * True once set() has been called at least once. readAllowSelfReview()
   * returns its hardcoded default while this is false (config-sync has
   * never succeeded, e.g. the fetch keeps failing).
   */
  hasSynced(): boolean;
  /** Replaces the current allowSelfReview value. */
  set(allowSelfReview: boolean): void;
}

/** Creates a new, independent allow-self-review ref defaulting to unsynced/false. */
export function createAllowSelfReviewRef(): AllowSelfReviewRef {
  let allowSelfReview = false;
  let synced = false;

  return {
    get(): boolean {
      return allowSelfReview;
    },
    hasSynced(): boolean {
      return synced;
    },
    set(next: boolean): void {
      allowSelfReview = next;
      synced = true;
    },
  };
}

/**
 * The process-wide allow-self-review ref. agent/src/index.ts's syncConfig()
 * writes into this on every successful config-sync tick;
 * check-helpers.ts's readAllowSelfReview() reads it as the DB tier before
 * falling back to its hardcoded default, so a DB-side change (via PATCH
 * /agents/:id) takes effect on the very next config-sync tick without
 * requiring an agent restart. If the agent's config bundle never becomes
 * available, hasSynced() stays false for the process lifetime — readers
 * readers must return their hardcoded default in that case.
 */
export const allowSelfReviewRef: AllowSelfReviewRef =
  createAllowSelfReviewRef();
