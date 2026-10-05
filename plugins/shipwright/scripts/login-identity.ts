/**
 * plugins/shipwright/scripts/login-identity.ts
 *
 * Canonical GitHub login helper.
 *
 * Under an installation token one bot appears in three forms:
 *   - GraphQL viewer.login:            "<slug>[bot]"
 *   - `gh pr view --json author`:      "app/<slug>"
 *   - GraphQL PR/review author.login:  "<slug>"
 *
 * canonicalLogin() collapses all three (and PAT logins) to one comparable value.
 *
 * Standalone by design: no @shipwright/lib import, so the plugin stays
 * installable from the plugin cache.
 */

import { spawnSync } from "node:child_process";

/** Runs `gh` with the given args and returns stdout; throws on failure. */
export type GhRunner = (args: string[]) => string;

const VIEWER_QUERY = "query { viewer { login } }";

/** Strip the "app/" prefix and "[bot]" suffix, then lowercase. */
export function canonicalLogin(login: string): string {
  let result = login.trim();
  if (result.startsWith("app/")) result = result.slice(4);
  if (result.endsWith("[bot]")) result = result.slice(0, -5);
  return result.toLowerCase();
}

export const defaultGhRunner: GhRunner = (args) => {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed: ${result.stderr || result.error?.message}`,
    );
  }
  return result.stdout;
};

/**
 * Resolve the authenticated agent's canonical login via GraphQL viewer.
 * Never uses `gh api /user`, which 403s for installation tokens.
 */
export function getOwnCanonicalLogin(
  runGh: GhRunner = defaultGhRunner,
): string {
  const out = runGh(["api", "graphql", "-f", `query=${VIEWER_QUERY}`]);
  const login = (
    JSON.parse(out) as { data?: { viewer?: { login?: string } } }
  ).data?.viewer?.login;
  if (!login) throw new Error("GraphQL viewer returned no login");
  return canonicalLogin(login);
}

if (import.meta.main) {
  try {
    console.log(getOwnCanonicalLogin());
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
