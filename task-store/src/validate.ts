/**
 * task-store/src/validate.ts
 * Shared input validators for the task-store API.
 */

/**
 * Returns true when `s` is a valid "org/repo" string:
 *   - exactly one slash
 *   - non-empty org part
 *   - non-empty repo part
 */
export function isOrgRepo(s: string): boolean {
  const parts = s.split("/");
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}
