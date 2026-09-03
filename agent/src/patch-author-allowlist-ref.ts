/**
 * agent/src/patch-author-allowlist-ref.ts
 *
 * A tiny mutable box holding the agent's most recently synced allowlist of
 * author logins (GitHub username/login strings) permitted to trigger patch,
 * so downstream consumers can read a live view without closing over a single
 * syncConfig() tick. Kept pure and zero-I/O so it's unit-testable in
 * isolation — mirrors review-author-allowlist-ref.ts's style.
 *
 * Unlike reviewAuthorAllowlistRef (which dual-reads a legacy authorAllowlist
 * column during DBR-2.1's rename-in-progress phase), patchAuthorAllowlist
 * (DBR-1.1) is a brand-new column with no legacy predecessor to fall back to.
 */

export interface PatchAuthorAllowlistRef {
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
   * every author from triggering patch — before this ref existed, the
   * allowlist was never a triggering gate at all, and that pre-sync
   * behavior must be preserved.
   */
  hasSynced(): boolean;
  /** Replaces the current author-allowlist. */
  set(authorLogins: string[]): void;
}

/**
 * Resolves the config-bundle's patch-author-allowlist before it's handed to
 * patchAuthorAllowlistRef.set(). patchAuthorAllowlist (DBR-1.1) is a brand
 * new column with no legacy predecessor, so there's no fallback field to
 * consult — this simply defaults a nullish value to [] so downstream
 * consumers never see a nullish value (mirrors resolveReviewAuthorAllowlist's
 * null-safety, minus the legacy-field fallback).
 */
export function resolvePatchAuthorAllowlist(
  patchAuthorAllowlist: string[] | null | undefined,
): string[] {
  return patchAuthorAllowlist ?? [];
}

/** Creates a new, independent patch-author-allowlist ref defaulting to an empty list. */
export function createPatchAuthorAllowlistRef(): PatchAuthorAllowlistRef {
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
 * The process-wide patch-author-allowlist ref. check-patch.ts's
 * buildProductionDeps will default its author-allowlist-checking dependency
 * to `.get`/`.hasSynced` from this same instance, so allowlist changes take
 * effect on the very next candidate-collection call without requiring
 * loop-orchestrator.ts (which builds those deps once and reuses them for the
 * orchestrator's lifetime) to be touched at all. If the agent's config
 * bundle never becomes available, `hasSynced()` stays false for the process
 * lifetime — consumers must fail open in that case.
 */
export const patchAuthorAllowlistRef: PatchAuthorAllowlistRef =
  createPatchAuthorAllowlistRef();
