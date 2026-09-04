/**
 * Returns true when `s` is a valid GitHub login: alphanumeric characters and
 * single hyphens only, no leading/trailing hyphen, no consecutive hyphens,
 * and a max length of 39 characters (GitHub's own username constraints).
 *
 * Also accepts GitHub App bot logins in the format "app/<slug>", where slug
 * follows the same validation rules as regular logins.
 */
export function isGithubLogin(s: string): boolean {
  const LOGIN_PATTERN = /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/;

  if (s.startsWith("app/")) {
    const slug = s.slice(4);
    return slug.length > 0 && slug.length <= 39 && LOGIN_PATTERN.test(slug);
  }

  return (
    s.length > 0 && s.length <= 39 && LOGIN_PATTERN.test(s)
  );
}
