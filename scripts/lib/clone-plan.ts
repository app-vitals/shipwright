/**
 * scripts/lib/clone-plan.ts
 * Pure planning helper for "which repos still need `gh repo clone`" —
 * shared by scripts/hitl.ts (local dev-loop bootstrap) and
 * scripts/agent-workspace-pull.ts (mirrors a real agent's repos locally).
 *
 * Extracted out of hitl.ts (AWP-1.1) so neither script reaches into the
 * other's module — both import this shared helper instead.
 */

import { join } from "node:path";

/**
 * Given the configured "org/repo" list, the repos dir, and an injectable
 * existence check, reports which repos still need cloning (and their
 * destination path). Repos already present under reposDir are left
 * untouched. Kept side-effect free so it's unit-testable without touching
 * the filesystem or network.
 */
export function computeMissingClones(
  repos: string[],
  reposDir: string,
  exists: (path: string) => boolean,
): { repo: string; dest: string }[] {
  return repos
    .map((repo) => ({
      repo,
      dest: join(reposDir, repo.slice(repo.lastIndexOf("/") + 1)),
    }))
    .filter(({ dest }) => !exists(dest));
}
