/**
 * agent/src/sync-config-clone.ts
 *
 * Auto-clones newly-configured repos on config sync (RSF-4.1).
 *
 * index.ts's syncConfig() tick (runs every 60s) fetches the agent's config
 * bundle and calls agentReposRef.set(bundle.repos) to update the in-memory
 * scope — but historically did nothing to actually fetch a newly-added repo
 * onto disk, leaving a human to clone it manually before any dev-task/review/
 * patch/deploy work against it could proceed.
 *
 * This module reuses scripts/lib/clone-plan.ts's computeMissingClones() — the
 * same pure, already-unit-tested planner already used by the manual
 * agent-workspace-pull CLI and hitl.ts — against the real repos/ dir, and
 * clones anything missing via `gh repo clone`, mirroring
 * agent-workspace-pull.ts's realCloneRepo() shell-out.
 *
 * Kept deliberately simple (explicit product decision): runs inline/blocking
 * within syncConfig()'s own tick, not backgrounded or queued — no new
 * interval, no fire-and-forget dispatch. A single repo's clone failure (auth
 * hiccup, rate limit, invalid repo name, ...) is caught and logged per-repo —
 * never thrown — so one bad repo can't block the rest of the plan or crash
 * the tick; since the repo stays missing on disk, the very next tick's
 * computeMissingClones() naturally retries it, with no explicit
 * retry/backoff logic needed.
 */

import { existsSync } from "node:fs";
import { computeMissingClones } from "../../scripts/lib/clone-plan.ts";

export interface SyncConfigCloneDeps {
  /**
   * The agent's currently-configured repo scope ("org/repo" strings) — read
   * fresh on every call (mirrors worktree-reaper.ts's own getScopedRepos
   * doc comment) so a repo added between two ticks is picked up on the very
   * next call without rebuilding deps.
   */
  getScopedRepos: () => string[];
  /** Absolute path to the repos/ dir clones land in. */
  reposDir: string;
  /** Existence check for the clone-skip plan — injectable for tests. */
  exists: (path: string) => boolean;
  /** Clones a single repo ("org/repo") to `dest` via `gh repo clone`. */
  cloneRepo: (repo: string, dest: string) => Promise<void>;
}

/**
 * Clones every configured-but-missing repo onto disk via computeMissingClones()'s
 * plan. Already-present repos are left untouched — this reuses
 * computeMissingClones()'s own skip-if-exists logic rather than
 * re-implementing it.
 *
 * A single repo's cloneRepo() failure is caught and logged; it never prevents
 * the remaining repos in the plan from being attempted, and it never throws
 * out of this function — callers (index.ts's syncConfig()) can call this
 * every tick without a wrapping try/catch of their own being load-bearing.
 */
export async function syncClonedRepos(
  deps: SyncConfigCloneDeps,
): Promise<void> {
  const repos = deps.getScopedRepos();
  const plan = computeMissingClones(repos, deps.reposDir, deps.exists);

  for (const { repo, dest } of plan) {
    try {
      await deps.cloneRepo(repo, dest);
    } catch (err) {
      console.error(
        `[config-sync] clone failed for ${repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Shells out to `gh repo clone <repo> <dest>` — mirrors agent-workspace-pull.ts's realCloneRepo(). */
async function realCloneRepo(repo: string, dest: string): Promise<void> {
  const result = Bun.spawnSync(["gh", "repo", "clone", repo, dest], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`gh repo clone failed for ${repo}`);
  }
}

/**
 * Production deps for syncClonedRepos(): real existsSync + real `gh repo
 * clone` shell-out. `reposDir` is passed in by the caller (index.ts, via
 * join(config.paths.workspace, "repos") — the repos dir convention confirmed
 * by setup.ts/worktree-reaper.ts/pr-state-reconciler.ts/check-helpers.ts)
 * rather than re-resolved here, so this module stays free of any direct
 * process.env/AGENT_HOME dependency of its own.
 */
export function buildProductionDeps(opts: {
  getScopedRepos: () => string[];
  reposDir: string;
}): SyncConfigCloneDeps {
  return {
    getScopedRepos: opts.getScopedRepos,
    reposDir: opts.reposDir,
    exists: existsSync,
    cloneRepo: realCloneRepo,
  };
}
