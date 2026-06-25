/** Returns true when `s` is a valid "org/repo" string with non-empty org and repo parts. */
export function isOrgRepo(s: string): boolean {
  const parts = s.split("/");
  return parts.length === 2 && parts[0].trim().length > 0 && parts[1].trim().length > 0;
}
