/**
 * Session slug format (STI-1.2). Applies to NEW sessions only — existing
 * sessions are grandfathered and keep resolving under their legacy slug.
 * A bad slug is never truncated or rewritten; the caller is asked to choose
 * a different name.
 */

export const SESSION_SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidSessionSlug(slug: string): boolean {
  return SESSION_SLUG_PATTERN.test(slug);
}

/** The rename-me message returned (as a 400) for an invalid new slug. */
export function invalidSessionSlugMessage(slug: string): string {
  const shown = slug.length > 80 ? `${slug.slice(0, 80)}…` : slug;
  return `Invalid session slug '${shown}': must match ${SESSION_SLUG_PATTERN.source} — please choose a different name`;
}

/** The 409 message when a new slug differs from an existing one only by case. */
export function sessionSlugCaseConflictMessage(
  requested: string,
  existing: string,
): string {
  return `Session slug '${requested}' differs only by case from existing session '${existing}' — use '${existing}' or choose a different name`;
}
