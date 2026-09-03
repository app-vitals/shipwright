/**
 * agent/src/review-author-allowlist-ref.ts
 *
 * A tiny mutable box holding the agent's most recently synced allowlist of
 * author logins (GitHub username/login strings) permitted to trigger review,
 * so downstream consumers can read a live view without closing over a single
 * syncConfig() tick. Kept pure and zero-I/O so it's unit-testable in
 * isolation — mirrors loop-jobs-ref.ts's style.
 *
 * Renamed from agent-author-allowlist-ref.ts (DBR-2.3) now that a second,
 * distinct patch-author allowlist exists — this ref is specifically for the
 * *review* trigger allowlist.
 */

export interface ReviewAuthorAllowlistRef {
  /**
   * Returns the most recently set author-allowlist, or [] if set() was never
   * called. Callers that need to distinguish "never synced" (config-bundle
   * fetch has never succeeded — e.g. a persistent 404) from "synced to a
   * deliberately empty allowlist" must check hasSynced() rather than
   * inferring it from an empty get() result, since both states return [].
   */
  get(): string[];
  /**
   * True once set() has been called at least once. Consumers that gate on
   * the allowlist should fail open (skip filtering / allow) while this is
   * false, so a persistent config-sync failure doesn't silently exclude
   * every author from triggering review — before this ref existed, the
   * allowlist was never a triggering gate at all, and that pre-sync
   * behavior must be preserved.
   */
  hasSynced(): boolean;
  /** Replaces the current author-allowlist. */
  set(authorLogins: string[]): void;
}

/**
 * Resolves the config-bundle's review-author-allowlist before it's handed to
 * reviewAuthorAllowlistRef.set(). DBR-2.4 removed the legacy
 * `authorAllowlist` field and its fallback — `reviewAuthorAllowlist` is now
 * the sole source. A nullish value (observed in production, see Sentry issue
 * 7633628941) defaults to [] so downstream consumers never see it.
 */
export function resolveReviewAuthorAllowlist(
  reviewAuthorAllowlist: string[] | null | undefined,
): string[] {
  return reviewAuthorAllowlist ?? [];
}

/** Creates a new, independent review-author-allowlist ref defaulting to an empty list. */
export function createReviewAuthorAllowlistRef(): ReviewAuthorAllowlistRef {
  let authorLogins: string[] = [];
  let synced = false;

  return {
    get(): string[] {
      return authorLogins;
    },
    hasSynced(): boolean {
      return synced;
    },
    set(next: string[]): void {
      authorLogins = next;
      synced = true;
    },
  };
}

/**
 * The process-wide review-author-allowlist ref. check-review.ts's
 * buildProductionDeps will default its author-allowlist-checking dependency
 * to `.get`/`.hasSynced` from this same instance, so allowlist changes take
 * effect on the very next candidate-collection call without requiring
 * loop-orchestrator.ts (which builds those deps once and reuses them for the
 * orchestrator's lifetime) to be touched at all. If the agent's config
 * bundle never becomes available, `hasSynced()` stays false for the process
 * lifetime — consumers must fail open in that case.
 */
export const reviewAuthorAllowlistRef: ReviewAuthorAllowlistRef =
  createReviewAuthorAllowlistRef();
