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
 * Wired into agent/src/index.ts's PR-state-reconciler setInterval (WTR-1.4)
 * as a third, independent try/catch pass on the same tick — see the Step 5b
 * doc comment in index.ts for the full rationale.
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  parseCleanupAfterDays,
  parseCleanupMergedWorktrees,
  resolveWorkspacePath,
  splitOrgRepo,
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
  /**
   * Returns the agent's currently-configured repo scope, read fresh on
   * every reconcileStaleWorktrees() call — mirrors PrStateReconcilerDeps's
   * own getScopedRepos field, so a scope change (a repo added/removed via
   * syncConfig()) is picked up on the very next reconcile pass instead of
   * being frozen at first-tick memoization time.
   */
  getScopedRepos: () => string[];
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
 * match.
 *
 * `worktrees/<dirname>` uses the BARE repo name convention (e.g.
 * "ok-wow-agency-feat-foo"), but agentReposRef.get() (and therefore
 * deps.getScopedRepos()) returns "org/repo"-formatted strings in production
 * (see agent-repos-ref.ts's doc comment) — so every scoped entry is first
 * normalized to its bare repo name via splitOrgRepo() (the same helper
 * pr-state-reconciler.ts uses to derive its own worktree dirname prefix from
 * `record.repo`) before comparing against dirname. An entry with no "/" is
 * already bare and normalizes to itself, which keeps the pre-RCO-1.1 bare-
 * name-only scope format meaningful and matching unchanged.
 *
 * Repo names can themselves contain dashes (e.g. "example-repo"), so a naive
 * first-dash split of dirname is unsafe — instead every normalized bare name
 * is checked as a candidate prefix (`dirname === bareName` or
 * `dirname.startsWith(bareName + "-")`, so a match only counts at a "-"
 * boundary, never mid-word) and the LONGEST matching bare name wins (so
 * "example-repo" wins over a hypothetical shorter false-positive prefix like
 * "example").
 *
 * Ambiguity guard: two DISTINCT scoped "org/repo" entries can normalize to
 * the SAME bare name (e.g. "org-a/widget" and "org-b/widget" both ->
 * "widget") — the bare-dirname worktree convention has no way to tell them
 * apart. Rather than arbitrarily picking one org's repo and silently
 * mismatching the worktree (which could point `git worktree remove` at the
 * wrong repo's local clone), a same-bare-name collision among the
 * longest-matching entries is treated as unmatched (null), same as "no
 * match" from the caller's point of view, but logged distinctly by the
 * caller-visible sentinel below so it doesn't read as an ordinary
 * "no scoped repo matches" case in Sentry.
 */
const AMBIGUOUS_MATCH = Symbol("ambiguous-match");

function resolveOwningRepo(
  dirname: string,
  scopedRepos: string[],
): string | null | typeof AMBIGUOUS_MATCH {
  let bestBareName: string | null = null;
  let bestOriginals: Set<string> = new Set();

  for (const repo of scopedRepos) {
    const [, bareName] = splitOrgRepo(repo);
    if (!bareName) continue; // defensive — e.g. a malformed "org/" entry
    const isMatch = dirname === bareName || dirname.startsWith(`${bareName}-`);
    if (!isMatch) continue;

    if (bestBareName === null || bareName.length > bestBareName.length) {
      bestBareName = bareName;
      bestOriginals = new Set([repo]);
    } else if (bareName.length === bestBareName.length) {
      bestOriginals.add(repo);
    }
  }

  if (bestBareName === null) return null;
  // Multiple distinct scoped entries tied for the longest match and share
  // the same normalized bare name — e.g. "org-a/widget" + "org-b/widget".
  // Note a single scoped entry appearing twice (or one repo matching under
  // two different-length prefixes) never reaches here since bestOriginals
  // is reset whenever a strictly longer bareName is found.
  if (bestOriginals.size > 1) return AMBIGUOUS_MATCH;
  return bestBareName;
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
  const scopedRepos = deps.getScopedRepos();

  for (const dirname of dirs) {
    const repo = resolveOwningRepo(dirname, scopedRepos);
    if (repo === AMBIGUOUS_MATCH) {
      console.error(
        `[worktree-reaper] skipping ${dirname} — AMBIGUOUS: multiple distinct scoped org/repo entries normalize to the same bare repo name for this worktree dirname's prefix`,
      );
      continue;
    }
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
  getScopedRepos?: () => string[];
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
    getScopedRepos: opts?.getScopedRepos ?? (() => []),
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
