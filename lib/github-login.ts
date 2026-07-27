/**
 * Returns true when `s` is a valid GitHub login: alphanumeric characters and
 * single hyphens only, no leading/trailing hyphen, no consecutive hyphens,
 * and a max length of 39 characters (GitHub's own username constraints).
 */
export function isGithubLogin(s: string): boolean {
  return (
    s.length > 0 && s.length <= 39 && /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/.test(s)
  );
}
