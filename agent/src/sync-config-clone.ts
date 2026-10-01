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
 * This module reuses lib/clone-plan.ts's computeMissingClones() — the same
 * pure, already-unit-tested planner already used by the manual
 * agent-workspace-pull CLI and hitl.ts — against the real repos/ dir, and
 * clones anything missing via `gh repo clone`. The planner lives in `lib/`
 * (not `scripts/`) precisely because this module imports it: agent/Dockerfile's
 * runtime stage copies `lib/` but not `scripts/`, so a `scripts/` import would
 * resolve locally and then crash-loop the deployed pod.
 *
 * Kept deliberately simple (explicit product decision): the clone step runs
 * within syncConfig()'s own tick, not backgrounded or queued — no new
 * interval, no fire-and-forget dispatch. The `gh` child process itself is
 * spawned *asynchronously* (`Bun.spawn` + `await proc.exited`, matching
 * claude.ts's convention for long-running children) rather than with
 * `Bun.spawnSync`: this runs inside the long-lived server process that also
 * serves the liveness/readiness probes, and a synchronous clone would block
 * that process's event loop for the full duration of the clone — long enough
 * for a probe to fail and restart the pod mid-clone.
 *
 * Because the spawn is async, two syncConfig() ticks can now overlap (index.ts
 * schedules them with a bare `setInterval`, which does not serialize), so an
 * in-flight set guards against two ticks racing the same destination.
 *
 * A single repo's clone failure (auth hiccup, rate limit, invalid repo name,
 * ...) is caught and logged per-repo — never thrown — so one bad repo can't
 * block the rest of the plan or crash the tick; the partially-written
 * destination is removed so the next tick's computeMissingClones() sees it as
 * missing again and retries it, with no explicit retry/backoff logic needed.
 */

import { existsSync, rmSync } from "node:fs";
import { computeMissingClones } from "@shipwright/lib/clone-plan";

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
  /**
   * Deletes a destination directory left behind by a failed clone, so the
   * next tick's computeMissingClones() plans it again instead of treating the
   * half-written directory as an already-cloned repo.
   */
  removePartialClone: (dest: string) => void;
}

/**
 * Destinations with a clone in flight right now. Module-scoped (not per-deps)
 * because the hazard it guards is process-wide: index.ts drives this with
 * `setInterval(() => void syncConfig(), 60_000)`, which never waits for the
 * previous tick, so a clone slower than 60s would otherwise be started a
 * second time by the next tick before `gh` has created the destination dir.
 */
const inFlightClones = new Set<string>();

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
    // An overlapping tick is already cloning this destination — skip rather
    // than racing a second `gh repo clone` into the same directory.
    if (inFlightClones.has(dest)) continue;
    inFlightClones.add(dest);
    try {
      await deps.cloneRepo(repo, dest);
    } catch (err) {
      console.error(
        `[config-sync] clone failed for ${repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Clear whatever the failed clone left on disk: a half-written
      // directory still satisfies the planner's existence check and would
      // otherwise wedge this repo as "cloned" forever.
      try {
        deps.removePartialClone(dest);
      } catch (rmErr) {
        console.error(
          `[config-sync] failed to clean up partial clone at ${dest}: ${
            rmErr instanceof Error ? rmErr.message : String(rmErr)
          }`,
        );
      }
    } finally {
      inFlightClones.delete(dest);
    }
  }
}

/**
 * Builds the real `gh repo clone` shell-out. Async by design — see the module
 * header: `Bun.spawnSync` here would block the event loop of the process that
 * serves the health probes for the whole duration of the clone.
 *
 * The spawner is injectable so unit tests can assert the command, the options
 * and the exit-code handling without a real `gh` invocation (mirrors
 * claude.ts's `spawner: typeof Bun.spawn = Bun.spawn` parameter).
 */
export function makeCloneRepo(
  spawn: typeof Bun.spawn = Bun.spawn,
): (repo: string, dest: string) => Promise<void> {
  return async (repo: string, dest: string): Promise<void> => {
    const proc = spawn(["gh", "repo", "clone", repo, dest], {
      // env: process.env is required — Bun.spawn otherwise snapshots env at
      // Bun startup and misses runtime mutations. This clone runs inside
      // syncConfig()'s tick, right after Object.assign(process.env,
      // bundle.env), so without this a freshly-synced/rotated GH_TOKEN never
      // reaches `gh`. Mirrors setup.ts's defaultExec and cron-handler.ts,
      // which document the same gotcha.
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`gh repo clone failed for ${repo} (exit ${exitCode})`);
    }
  };
}

/**
 * Production deps for syncClonedRepos(): real existsSync, real async `gh repo
 * clone` shell-out, real recursive delete for partial clones. `reposDir` is
 * passed in by the caller (index.ts, via join(config.paths.workspace,
 * "repos") — the repos dir convention confirmed by setup.ts/
 * worktree-reaper.ts/pr-state-reconciler.ts/check-helpers.ts) rather than
 * re-resolved here, so this module stays free of any direct
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
    cloneRepo: makeCloneRepo(),
    removePartialClone: (dest: string) =>
      rmSync(dest, { recursive: true, force: true }),
  };
}
