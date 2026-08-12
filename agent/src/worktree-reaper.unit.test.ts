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
    getScopedRepos: () => scopedRepos,
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

  test("RCO-1.1: an org/repo scoped entry matches its corresponding bare-name worktree dirname", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["ok-wow-agency-feat-foo"],
      scopedRepos: ["ok-wow/ok-wow-agency"],
      mtimes: { "ok-wow-agency-feat-foo": oldMtime },
    });

    await reconcileStaleWorktrees(deps);

    // The bare repo name ("ok-wow-agency"), not the raw "org/repo" string, is
    // what's passed to removeWorktree — mirrors pr-state-reconciler.ts's own
    // splitOrgRepo(record.repo) -> shortRepo usage for the same worktree path
    // shape.
    expect(removeCalls).toEqual([
      { repo: "ok-wow-agency", dirname: "ok-wow-agency-feat-foo" },
    ]);
  });

  test("RCO-1.1: bare-repo-name-only scoped entries (no slash) still match directly", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["shipwright-feat-bar"],
      scopedRepos: ["shipwright"],
      mtimes: { "shipwright-feat-bar": oldMtime },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([
      { repo: "shipwright", dirname: "shipwright-feat-bar" },
    ]);
  });

  test("RCO-1.1: two org/repo entries from different orgs sharing the same bare repo name are treated as ambiguous — neither is matched", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["widget-feat-foo"],
      scopedRepos: ["org-a/widget", "org-b/widget"],
      mtimes: { "widget-feat-foo": oldMtime },
    });

    await reconcileStaleWorktrees(deps);

    // Ambiguous — must NOT arbitrarily pick org-a or org-b's "widget".
    expect(removeCalls).toEqual([]);
  });

  test("RCO-1.1: longest-match-wins still applies to the normalized (bare) name when an org/repo entry and a longer bare entry both match", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    const { deps, removeCalls } = makeDeps({
      dirs: ["example-repo-feat-foo"],
      // "org/example" normalizes to "example" — a false-positive shorter
      // prefix; "example-repo" (already bare) is the real, longer match.
      scopedRepos: ["org/example", "example-repo"],
      mtimes: { "example-repo-feat-foo": oldMtime },
    });

    await reconcileStaleWorktrees(deps);

    expect(removeCalls).toEqual([
      { repo: "example-repo", dirname: "example-repo-feat-foo" },
    ]);
  });

  test("getScopedRepos is invoked live on each call — a repo added between two reconcile passes is picked up on the second pass without rebuilding deps", async () => {
    const oldMtime = new Date("2026-07-08T00:00:00.000Z");
    // Mutable backing array, mirroring agentReposRef.get()'s live-scope semantics.
    let backingScopedRepos: string[] = ["example-repo"];
    const { deps, removeCalls } = makeDeps({
      dirs: ["example-repo-feat-foo", "shipwright-feat-bar"],
      mtimes: {
        "example-repo-feat-foo": oldMtime,
        "shipwright-feat-bar": oldMtime,
      },
    });
    const liveDeps: WorktreeReaperDeps = {
      ...deps,
      getScopedRepos: () => backingScopedRepos,
    };

    // First pass: "shipwright" is not yet in scope — its worktree is skipped.
    await reconcileStaleWorktrees(liveDeps);
    expect(removeCalls).toEqual([
      { repo: "example-repo", dirname: "example-repo-feat-foo" },
    ]);

    // Scope changes out-of-band (e.g. syncConfig() adds a repo) between passes.
    backingScopedRepos = ["example-repo", "shipwright"];

    // Second pass against the SAME deps object: the live getter must reflect
    // the mutation without deps being rebuilt/memoized. (The fake
    // removeWorktree doesn't actually delete anything, so
    // "example-repo-feat-foo" is still stale and removed again on this pass —
    // the assertion only cares that "shipwright-feat-bar" is now included.)
    await reconcileStaleWorktrees(liveDeps);
    expect(removeCalls).toEqual([
      { repo: "example-repo", dirname: "example-repo-feat-foo" },
      { repo: "example-repo", dirname: "example-repo-feat-foo" },
      { repo: "shipwright", dirname: "shipwright-feat-bar" },
    ]);
  });
});
