/**
 * agent/src/worktree-reaper.ts
 *
 * Stale-worktree age sweep (WTR-1.2) — a pure-filesystem background pass
 * that force-removes `worktrees/<repo>-<branch>` directories that have gone
 * stale (older than the agent-policy.md-configured cleanup_after_days),
 * mirroring the workspace CLAUDE.md instruction that worktrees older than 14
 * days are removed automatically.
 *
 * Unlike pr-state-reconciler.ts, this module makes NO GitHub or task-store
 * calls — it only reads agent-policy.md, lists the worktrees/ directory,
 * checks mtimes against an injected clock, and runs `git worktree remove
 * --force` for stale matches. It reuses WTR-1.1's parseCleanupMergedWorktrees
 * / parseCleanupAfterDays (check-helpers.ts) rather than reimplementing
 * policy parsing.
 *
 * Shape mirrors pr-state-reconciler.ts: an injected-deps interface, a pure
 * `reconcileStaleWorktrees(deps)` core function, per-directory try/catch
 * error isolation (console.error, not console.warn — matches
 * reconcilePrState's per-record loop) so one bad directory can't abort the
 * rest of the batch, and a `buildProductionDeps()` factory wiring real
 * fs/git calls at the bottom.
 *
 * Not wired into agent/src/index.ts's setInterval registration — that's
 * out of scope for this task (WTR-1.2 covers only the module + its unit
 * tests).
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  parseCleanupAfterDays,
  parseCleanupMergedWorktrees,
  resolveWorkspacePath,
} from "./check-helpers.ts";
import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single `removeWorktree(repo, dirname)` invocation — exported for test-fixture typing. */
export interface RemoveWorktreeCall {
  repo: string;
  dirname: string;
}

export interface WorktreeReaperDeps {
  /** Reads agent-policy.md content. */
  readAgentPolicy: () => string;
  /** Lists dirnames directly under worktrees/ (not full paths). */
  listWorktreeDirs: () => string[];
  /** The list of repo names to prefix-match worktree dirnames against. */
  scopedRepos: string[];
  /** mtime lookup for a given worktree dirname. */
  statMtime: (dirname: string) => Date;
  /** Force-removes a worktree: `git -C repos/{repo} worktree remove worktrees/{dirname} --force`. */
  removeWorktree: (repo: string, dirname: string) => Promise<void>;
  /** Injected time source — never call Date.now()/new Date() directly. */
  clock: Clock;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve the scoped repo that owns a worktree dirname via longest-prefix
 * match. Repo names can themselves contain dashes (e.g. "vitals-os"), so a
 * naive first-dash split is unsafe — instead, every scoped repo is checked
 * as a candidate prefix (`dirname === repo` or `dirname.startsWith(repo +
 * "-")`, so a match only counts at a "-" boundary, never mid-word) and the
 * LONGEST matching repo name wins (so "vitals-os" wins over a hypothetical
 * shorter false-positive prefix like "vitals").
 *
 * Returns null when no scoped repo's name is a prefix of dirname.
 */
function resolveOwningRepo(
  dirname: string,
  scopedRepos: string[],
): string | null {
  let best: string | null = null;
  for (const repo of scopedRepos) {
    const isMatch = dirname === repo || dirname.startsWith(`${repo}-`);
    if (!isMatch) continue;
    if (best === null || repo.length > best.length) best = repo;
  }
  return best;
}

/** True when `mtime` is older than `cleanupAfterDays` days before `now`. */
function isStale(mtime: Date, now: Date, cleanupAfterDays: number): boolean {
  const cutoff = now.getTime() - cleanupAfterDays * MS_PER_DAY;
  return mtime.getTime() < cutoff;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Scan worktrees/ for directories that have gone stale (older than the
 * policy's cleanup_after_days) and force-remove each one via the injected
 * removeWorktree dep. No-ops entirely (zero fs/git calls beyond reading the
 * policy) when cleanup_merged_worktrees parses to false.
 *
 * A dirname whose prefix matches no scoped repo is skipped defensively
 * (logged, not fatal). A single directory's removeWorktree failure is
 * caught and logged; it does not abort processing of the remaining
 * directories — mirrors pr-state-reconciler.ts's reconcilePrState per-record
 * continue-on-error isolation.
 */
export async function reconcileStaleWorktrees(
  deps: WorktreeReaperDeps,
): Promise<void> {
  const policyContent = deps.readAgentPolicy();
  if (!parseCleanupMergedWorktrees(policyContent)) return; // disabled — no fs/git calls at all

  const cleanupAfterDays = parseCleanupAfterDays(policyContent);
  const now = deps.clock.now();

  const dirs = deps.listWorktreeDirs();

  for (const dirname of dirs) {
    const repo = resolveOwningRepo(dirname, deps.scopedRepos);
    if (repo === null) {
      console.error(
        `[worktree-reaper] skipping ${dirname} — no scoped repo matches this worktree dirname's prefix`,
      );
      continue;
    }

    try {
      const mtime = deps.statMtime(dirname);
      if (!isStale(mtime, now, cleanupAfterDays)) continue; // still fresh — leave untouched

      await deps.removeWorktree(repo, dirname);
    } catch (err) {
      console.error(
        `[worktree-reaper] failed to reconcile worktree ${dirname}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ─── Production deps ──────────────────────────────────────────────────────────

/**
 * Production deps for `reconcileStaleWorktrees()`. Reads agent-policy.md and
 * worktrees/ from the resolved workspace path, and shells out to `git
 * worktree remove --force` for the actual removal.
 */
export function buildProductionDeps(opts?: {
  clock?: Clock;
  scopedRepos?: string[];
}): WorktreeReaperDeps {
  const workspacePath = resolveWorkspacePath();

  return {
    readAgentPolicy: () => {
      try {
        return readFileSync(
          join(workspacePath, "state", "agent-policy.md"),
          "utf-8",
        );
      } catch {
        return ""; // missing policy file — parseCleanupMergedWorktrees defaults to true, parseCleanupAfterDays to 14
      }
    },
    listWorktreeDirs: () => {
      try {
        return readdirSync(join(workspacePath, "worktrees"), {
          withFileTypes: true,
        })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    scopedRepos: opts?.scopedRepos ?? [],
    statMtime: (dirname: string) =>
      statSync(join(workspacePath, "worktrees", dirname)).mtime,
    removeWorktree: async (repo: string, dirname: string) => {
      await execFileAsync("git", [
        "-C",
        join(workspacePath, "repos", repo),
        "worktree",
        "remove",
        join(workspacePath, "worktrees", dirname),
        "--force",
      ]);
    },
    clock: opts?.clock ?? SystemClock(),
  };
}
