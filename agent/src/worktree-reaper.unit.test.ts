/**
 * agent/src/worktree-reaper.unit.test.ts
 *
 * Unit tests for reconcileStaleWorktrees() — a pure-filesystem background
 * pass (WTR-1.2) that force-removes worktrees/ directories older than the
 * agent-policy.md-configured cleanup_after_days threshold.
 *
 * Uses fully injected fs/git-exec/clock doubles — no real filesystem or git
 * calls, no global.fetch/global.* overrides, time injected via FixedClock —
 * per this repo's unit-test isolation contract.
 */

import { describe, expect, test } from "bun:test";
import { FixedClock } from "./clock.ts";
import {
  type RemoveWorktreeCall,
  type WorktreeReaperDeps,
  reconcileStaleWorktrees,
} from "./worktree-reaper.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

const FAKE_NOW = new Date("2026-07-28T00:00:00.000Z");

interface MakeDepsOptions {
  policyContent?: string;
  dirs?: string[];
  scopedRepos?: string[];
  /** dirname -> mtime. Any dirname not present here throws (defensive — every test must configure the dirs it lists). */
  mtimes?: Record<string, Date>;
  /** dirname -> Error to throw from removeWorktree, if configured. */
  removeErrors?: Record<string, Error>;
  now?: Date;
}

function makeDeps(opts: MakeDepsOptions = {}): {
  deps: WorktreeReaperDeps;
  removeCalls: RemoveWorktreeCall[];
} {
  const {
    policyContent = "- **cleanup_merged_worktrees**: true\n- **cleanup_after_days**: 14\n",
    dirs = [],
    scopedRepos = [],
    mtimes = {},
    removeErrors = {},
    now = FAKE_NOW,
  } = opts;

  const removeCalls: RemoveWorktreeCall[] = [];

  const deps: WorktreeReaperDeps = {
    readAgentPolicy: () => policyContent,
    listWorktreeDirs: () => dirs,
    scopedRepos,
    statMtime: (dirname: string) => {
      const mtime = mtimes[dirname];
      if (!mtime) {
        throw new Error(`test fixture missing mtime for dirname: ${dirname}`);
      }
      return mtime;
    },
    removeWorktree: async (repo: string, dirname: string) => {
      removeCalls.push({ repo, dirname });
      const err = removeErrors[dirname];
      if (err) throw err;
    },
    clock: FixedClock(now),
  };

  return { deps, removeCalls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reconcileStaleWorktrees", () => {
  test("AC1: removes a worktree older than cleanup_after_days whose name's prefix matches a scoped repo", async () => {
    // 20 days old, threshold 14 — stale.
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["example-repo-feat-foo"],
      scopedRepos: ["example-repo"],
      mtimes: { "example-repo-feat-foo": oldMtime },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([
      { repo: "example-repo", dirname: "example-repo-feat-foo" },
    ]);
  });

  test("AC2: leaves a worktree younger than the threshold untouched", async () => {
    // 2 days old, threshold 14 — not stale.
    const recentMtime = new Date("2026-07-26T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["example-repo-feat-foo"],
      scopedRepos: ["example-repo"],
      mtimes: { "example-repo-feat-foo": recentMtime },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([]);
  });

  test("AC3: cleanup_merged_worktrees false — no directories scanned or removed", async () => {
    let listCalled = false;
    let statCalled = false;
    const { deps, removeCalls } = makeDeps({
      policyContent: "- **cleanup_merged_worktrees**: false\n",
      dirs: ["example-repo-feat-foo"],
      scopedRepos: ["example-repo"],
      mtimes: { "example-repo-feat-foo": new Date("2020-01-01T00:00:00.000Z") },
    });
    const wrappedDeps: WorktreeReaperDeps = {
      ...deps,
      listWorktreeDirs: () => {
        listCalled = true;
        return deps.listWorktreeDirs();
      },
      statMtime: (dirname: string) => {
        statCalled = true;
        return deps.statMtime(dirname);
      },
    };

    await reconcileStaleWorktrees(wrappedDeps);

    expect(listCalled).toBe(false);
    expect(statCalled).toBe(false);
    expect(removeCalls).toEqual([]);
  });

  test("AC4: dirname whose prefix matches no scoped repo is skipped defensively", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["unknown-repo-feat-foo"],
      scopedRepos: ["example-repo", "shipwright"],
      mtimes: { "unknown-repo-feat-foo": oldMtime },
    });

    await expect(reconcileStaleWorktrees(deps)).resolves.toBeUndefined();
    expect(removeCalls).toEqual([]);
  });

  test("AC5: a single directory's removeWorktree failure is caught and logged; remaining directories still processed", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["example-repo-feat-broken", "shipwright-feat-fine"],
      scopedRepos: ["example-repo", "shipwright"],
      mtimes: {
        "example-repo-feat-broken": oldMtime,
        "shipwright-feat-fine": oldMtime,
      },
      removeErrors: {
        "example-repo-feat-broken": new Error("git worktree remove failed"),
      },
    });

    await expect(reconcileStaleWorktrees(deps)).resolves.toBeUndefined();

    expect(removeCalls).toEqual([
      { repo: "example-repo", dirname: "example-repo-feat-broken" },
      { repo: "shipwright", dirname: "shipwright-feat-fine" },
    ]);
  });

  test("longest-prefix match: dashed repo names don't false-positive against a shorter prefix", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["example-repo-feat-foo"],
      // "example" is a false-positive shorter prefix; "example-repo" is the real, longer match.
      scopedRepos: ["example", "example-repo"],
      mtimes: { "example-repo-feat-foo": oldMtime },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([
      { repo: "example-repo", dirname: "example-repo-feat-foo" },
    ]);
  });

  test("dirname exactly equal to a scoped repo name matches", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["example-repo"],
      scopedRepos: ["example-repo"],
      mtimes: { "example-repo": oldMtime },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([{ repo: "example-repo", dirname: "example-repo" }]);
  });

  test("a dirname that merely starts with a repo name's characters but not at a '-' boundary does not match", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      // "example-repository-feat-x" should NOT match scoped repo "example-repo" —
      // the character after the prefix must be a "-" boundary (or nothing).
      dirs: ["example-repository-feat-x"],
      scopedRepos: ["example-repo"],
      mtimes: { "example-repository-feat-x": oldMtime },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([]);
  });

  test("uses the default cleanup_after_days (14) when unset in policy content", async () => {
    // 15 days old — stale under the 14-day default.
    const staleUnderDefault = new Date("2026-07-13T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      policyContent: "- **cleanup_merged_worktrees**: true\n",
      dirs: ["example-repo-feat-foo"],
      scopedRepos: ["example-repo"],
      mtimes: { "example-repo-feat-foo": staleUnderDefault },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([
      { repo: "example-repo", dirname: "example-repo-feat-foo" },
    ]);
  });

  test("multiple stale directories across different repos are all removed", async () => {
    const oldMtime = new Date("2026-07-01T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["example-repo-feat-a", "shipwright-feat-b", "example-repo-fix-c"],
      scopedRepos: ["example-repo", "shipwright"],
      mtimes: {
        "example-repo-feat-a": oldMtime,
        "shipwright-feat-b": oldMtime,
        "example-repo-fix-c": oldMtime,
      },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([
      { repo: "example-repo", dirname: "example-repo-feat-a" },
      { repo: "shipwright", dirname: "shipwright-feat-b" },
      { repo: "example-repo", dirname: "example-repo-fix-c" },
    ]);
  });

  test("a mix of stale, fresh, and unmatched directories only removes the stale+matched one", async () => {
    const oldMtime = new Date("2026-07-01T00:00:00.000Z");
    const recentMtime = new Date("2026-07-27T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: [
        "example-repo-feat-stale",
        "example-repo-feat-fresh",
        "ghost-repo-feat-x",
      ],
      scopedRepos: ["example-repo"],
      mtimes: {
        "example-repo-feat-stale": oldMtime,
        "example-repo-feat-fresh": recentMtime,
        "ghost-repo-feat-x": oldMtime,
      },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([
      { repo: "example-repo", dirname: "example-repo-feat-stale" },
    ]);
  });
});
