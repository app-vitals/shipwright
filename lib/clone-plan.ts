/**
 * lib/clone-plan.ts
 * Pure planning helper for "which repos still need `gh repo clone`" —
 * shared by scripts/hitl.ts (local dev-loop bootstrap),
 * scripts/agent-workspace-pull.ts (mirrors a real agent's repos locally),
 * and agent/src/sync-config-clone.ts (the deployed agent's config-sync
 * auto-clone step).
 *
 * Extracted out of hitl.ts (AWP-1.1) so neither script reaches into the
 * other's module — both import this shared helper instead. Lives in `lib/`
 * (not `scripts/`) because the deployed agent imports it too and the
 * runtime stage of agent/Dockerfile copies `lib/` but not `scripts/` — a
 * `scripts/` import would resolve locally and crash-loop in the container.
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

export interface RepoNameCollision {
  /** The later-listed repo — the one a sync should skip. */
  repo: string;
  /** The earlier-listed repo that already claimed the `repos/<name>` folder. */
  collidesWith: string;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const i = repo.lastIndexOf("/");
  return {
    owner: repo.slice(0, i).toLowerCase(),
    name: repo.slice(i + 1).toLowerCase(),
  };
}

/**
 * Reports repos whose basename matches an earlier-listed repo under a
 * different owner (case-insensitive). `repos/<name>` is keyed by basename
 * alone, so two such repos would share one folder and a clone/push could
 * land on the wrong customer's repo. The later-listed repo is the collider;
 * identical repos (same owner and name) are not collisions.
 */
export function findRepoNameCollisions(repos: string[]): RepoNameCollision[] {
  const firstByName = new Map<string, { repo: string; owner: string }>();
  const collisions: RepoNameCollision[] = [];
  for (const repo of repos) {
    const { owner, name } = splitRepo(repo);
    const first = firstByName.get(name);
    if (!first) {
      firstByName.set(name, { repo, owner });
    } else if (first.owner !== owner) {
      collisions.push({ repo, collidesWith: first.repo });
    }
  }
  return collisions;
}
