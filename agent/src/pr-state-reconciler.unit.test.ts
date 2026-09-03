/**
 * agent/src/pr-state-reconciler.unit.test.ts
 *
 * Unit tests for reconcilePrState() — self-heals task-store PullRequest
 * records left state:"open" after an untracked merge/close on GitHub.
 *
 * Also covers reconcileReviewState() (CHU-2.2) — self-heals task-store
 * reviewState:"pending" records that are actually terminal on GitHub
 * (an out-of-band reviewer posted directly to GitHub, bypassing every
 * code path that writes to the task-store).
 *
 * Uses injected fake task-store list/patch functions and a fake ghJson — no
 * real network/gh calls, per this repo's unit-test isolation contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import type { PrReviewData, ReviewNode, ReviewThread } from "./check-patch.ts";
import { type Clock, FixedClock } from "./clock.ts";
import {
  type GhPrView,
  type PrOpenTaskRecord,
  type PrReviewStateReconcilerDeps,
  type PrReviewStateRecord,
  type PrStateReconcilerDeps,
  type PrStateRecord,
  SCOPE_DEGRADED,
  __resetPrOpenTasksCursorForTests,
  buildProductionDeps,
  buildReviewStateProductionDeps,
  isWorktreeStale,
  reconcilePrOpenTasks,
  reconcilePrState,
  reconcileReviewState,
} from "./pr-state-reconciler.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface ListPrsCall {
  repo: string;
  state: string;
  limit: number;
  offset: number;
  updatedSince: string;
}

interface ListTasksCall {
  limit: number;
  offset: number;
}

interface PatchCall {
  id: string;
  fields: Record<string, unknown>;
}

/** Default fake "now" — a fixed, clearly-fake timestamp so tests never rely on the real clock. */
const FAKE_NOW = "2026-07-15T00:00:00.000Z";

interface MakeDepsOptions {
  repos?: string[];
  /** repo -> full page of state:"open" records (pagination is simulated by slicing). */
  openRecords?: Record<string, PrStateRecord[]>;
  /** "repo#prNumber" -> gh view result, or an Error to throw for that lookup. */
  ghResults?: Record<string, GhPrView | Error>;
  pageLimit?: number;
  /** pr_open tasks for the new reconcile-tasks pass; defaults to [] so existing tests are unaffected. */
  prOpenTasks?: PrOpenTaskRecord[];
  /** "repo#branch" -> merged-PR-list result, or an Error to throw, for the branch-fallback path. */
  branchResults?: Record<string, Array<{ number: number }> | Error>;
  now?: () => string;
  /** Defaults to `() => repos` so every existing test keeps passing unchanged. */
  getScopedRepos?: () => string[];
  /**
   * "repo#branch" -> full list of task-store tasks sharing that branch
   * (BBR-1.1's bundle-mate guard). Defaults to a lazy single-task stand-in
   * derived per-call from the branch alone (a single-element array) so every
   * pre-existing test — none of which configures this — keeps auto-healing
   * exactly as before. Tests exercising the bundle case override this map
   * with a >1-length array for the branch under test. Tests exercising
   * RSG-1.2's degraded-scope guard set the entry to `SCOPE_DEGRADED` — this
   * fake's `listAllTasksForBranch` returns it verbatim (mirroring how
   * `buildProductionDeps`'s real implementation surfaces "still degraded
   * after retry" to its callers), letting both BBR-1.1 call sites be tested
   * against the sentinel without going through the retry/delay machinery
   * itself (that machinery is covered separately by the
   * `buildProductionDeps` describe block below).
   */
  tasksForBranch?: Record<
    string,
    PrOpenTaskRecord[] | typeof SCOPE_DEGRADED | Error
  >;
  /**
   * WTR-1.3's injected worktree-cleanup policy getter (PLR-1.1: () =>
   * boolean, invoked fresh by reconcileRecord() on every call rather than
   * once at deps-build time). Defaults to `false` so every pre-existing
   * test — none of which configures this — never triggers the new
   * removeWorktree side effect. Also accepts a plain boolean for test
   * convenience, wrapped into a constant-returning getter.
   */
  cleanupMergedWorktreesEnabled?: boolean | (() => boolean);
  /**
   * WTR-1.3's removeWorktree fake. Defaults to a no-op resolve; tests
   * exercising the failure path override this to reject.
   */
  removeWorktree?: (
    shortRepo: string,
    worktreeDirName: string,
  ) => Promise<void>;
}

function makeDeps({
  repos = ["acme/example-repo"],
  openRecords = {},
  ghResults = {},
  pageLimit = 50,
  prOpenTasks = [],
  branchResults = {},
  now = () => FAKE_NOW,
  getScopedRepos = () => repos,
  tasksForBranch = {},
  cleanupMergedWorktreesEnabled = false,
  removeWorktree = async () => {},
}: MakeDepsOptions = {}): {
  deps: PrStateReconcilerDeps;
  listCalls: ListPrsCall[];
  patchCalls: PatchCall[];
  taskPatchCalls: PatchCall[];
  listPrOpenTasksCalls: ListTasksCall[];
  delayCalls: number[];
  listAllTasksForBranchCalls: string[];
  removeWorktreeCalls: Array<{ shortRepo: string; worktreeDirName: string }>;
} {
  const listCalls: ListPrsCall[] = [];
  const patchCalls: PatchCall[] = [];
  const taskPatchCalls: PatchCall[] = [];
  const listPrOpenTasksCalls: ListTasksCall[] = [];
  const delayCalls: number[] = [];
  const listAllTasksForBranchCalls: string[] = [];
  const removeWorktreeCalls: Array<{
    shortRepo: string;
    worktreeDirName: string;
  }> = [];

  const deps: PrStateReconcilerDeps = {
    repos,
    getScopedRepos,
    pageLimit,
    listOpenPrRecords: async (
      repo: string,
      limit: number,
      offset: number,
      updatedSince: string,
    ) => {
      listCalls.push({ repo, state: "open", limit, offset, updatedSince });
      const all = openRecords[repo] ?? [];
      return all.slice(offset, offset + limit);
    },
    patchPrRecord: async (id: string, fields: Record<string, unknown>) => {
      patchCalls.push({ id, fields });
    },
    ghViewPr: async (repo: string, prNumber: number) => {
      const key = `${repo}#${prNumber}`;
      const result = ghResults[key];
      if (result instanceof Error) throw result;
      if (!result) throw new Error(`no fake gh result configured for ${key}`);
      return result;
    },
    listPrOpenTasks: async (limit: number, offset: number) => {
      listPrOpenTasksCalls.push({ limit, offset });
      return prOpenTasks.slice(offset, offset + limit);
    },
    updateTaskStatus: async (id: string, fields: Record<string, unknown>) => {
      taskPatchCalls.push({ id, fields });
    },
    ghListMergedPrsForBranch: async (repo: string, branch: string) => {
      const key = `${repo}#${branch}`;
      const result = branchResults[key];
      if (result instanceof Error) throw result;
      return result ?? [];
    },
    now,
    listAllTasksForBranch: async (repo: string, branch: string) => {
      const key = `${repo}#${branch}`;
      listAllTasksForBranchCalls.push(key);
      const result = tasksForBranch[key];
      if (result instanceof Error) throw result;
      // Default: a single-element stand-in so every pre-existing test (none
      // of which configures tasksForBranch) keeps auto-healing exactly as
      // before — see the field's doc comment on MakeDepsOptions above.
      return result ?? [{ id: "single-task-stand-in", repo, branch }];
    },
    delay: async (ms: number) => {
      delayCalls.push(ms);
    },
    isCleanupMergedWorktreesEnabled:
      typeof cleanupMergedWorktreesEnabled === "function"
        ? cleanupMergedWorktreesEnabled
        : () => cleanupMergedWorktreesEnabled,
    removeWorktree: async (shortRepo: string, worktreeDirName: string) => {
      removeWorktreeCalls.push({ shortRepo, worktreeDirName });
      await removeWorktree(shortRepo, worktreeDirName);
    },
  };

  return {
    deps,
    listCalls,
    patchCalls,
    taskPatchCalls,
    listPrOpenTasksCalls,
    delayCalls,
    listAllTasksForBranchCalls,
    removeWorktreeCalls,
  };
}

function makeRecord(overrides: Partial<PrStateRecord> = {}): PrStateRecord {
  return {
    id: "pr-1",
    repo: "acme/example-repo",
    prNumber: 1,
    state: "open",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("reconcilePrState", () => {
  test("open on GitHub stays open — no PATCH issued", async () => {
    const record = makeRecord({ id: "pr-1", prNumber: 1 });
    const { deps, patchCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#1": { state: "OPEN", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  test("listOpenPrRecords is called with updatedSince computed as now-6h via the injected now() (PSR-1.1, widened per review)", async () => {
    const record = makeRecord({ id: "pr-1", prNumber: 1 });
    const { deps, listCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#1": { state: "OPEN", mergedAt: null },
      },
      now: () => "2026-07-19T23:15:00.000Z",
    });

    await reconcilePrState(deps);

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toEqual({
      repo: "acme/example-repo",
      state: "open",
      limit: 50,
      offset: 0,
      updatedSince: "2026-07-19T17:15:00.000Z",
    });
  });

  test("merged on GitHub gets reconciled — state + mergedAt synced, claim fields cleared", async () => {
    const record = makeRecord({ id: "pr-2", prNumber: 2 });
    const { deps, patchCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#2": {
          state: "MERGED",
          mergedAt: "2026-07-14T09:00:00.000Z",
        },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-2");
    expect(patchCalls[0].fields.state).toBe("merged");
    expect(patchCalls[0].fields.mergedAt).toBe("2026-07-14T09:00:00.000Z");
    expect(patchCalls[0].fields.claimedBy).toBeNull();
    expect(patchCalls[0].fields.claimedAt).toBeNull();
    expect(patchCalls[0].fields.heartbeatAt).toBeNull();
    expect(patchCalls[0].fields.phase).toBeNull();
  });

  test("closed on GitHub gets reconciled — state synced, no mergedAt, claim fields cleared", async () => {
    const record = makeRecord({ id: "pr-3", prNumber: 3 });
    const { deps, patchCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#3": { state: "CLOSED", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-3");
    expect(patchCalls[0].fields.state).toBe("closed");
    expect(patchCalls[0].fields.mergedAt).toBeUndefined();
    expect(patchCalls[0].fields.claimedBy).toBeNull();
    expect(patchCalls[0].fields.claimedAt).toBeNull();
    expect(patchCalls[0].fields.heartbeatAt).toBeNull();
    expect(patchCalls[0].fields.phase).toBeNull();
  });

  // ─── WTR-1.3: worktree removal side effect ───────────────────────────────

  test("merged on GitHub + cleanup_merged_worktrees true — removeWorktree called with repo+branch-slug path, in addition to the state PATCH", async () => {
    const record = makeRecord({ id: "pr-4", prNumber: 4 });
    const { deps, patchCalls, removeWorktreeCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#4": {
          state: "MERGED",
          mergedAt: "2026-07-14T09:00:00.000Z",
          headRefName: "feat/some-cool-thing",
        },
      },
      cleanupMergedWorktreesEnabled: true,
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].fields.state).toBe("merged");
    expect(removeWorktreeCalls).toHaveLength(1);
    expect(removeWorktreeCalls[0]).toEqual({
      shortRepo: "example-repo",
      worktreeDirName: "example-repo-feat-some-cool-thing",
    });
  });

  test("closed on GitHub + cleanup_merged_worktrees true — removeWorktree called with repo+branch-slug path, in addition to the state PATCH", async () => {
    const record = makeRecord({ id: "pr-5", prNumber: 5 });
    const { deps, patchCalls, removeWorktreeCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#5": {
          state: "CLOSED",
          mergedAt: null,
          headRefName: "fix/another-thing",
        },
      },
      cleanupMergedWorktreesEnabled: true,
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].fields.state).toBe("closed");
    expect(removeWorktreeCalls).toHaveLength(1);
    expect(removeWorktreeCalls[0]).toEqual({
      shortRepo: "example-repo",
      worktreeDirName: "example-repo-fix-another-thing",
    });
  });

  test("still OPEN on GitHub — removeWorktree is never called, even with cleanup_merged_worktrees true", async () => {
    const record = makeRecord({ id: "pr-6", prNumber: 6 });
    const { deps, patchCalls, removeWorktreeCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#6": {
          state: "OPEN",
          mergedAt: null,
          headRefName: "feat/still-open",
        },
      },
      cleanupMergedWorktreesEnabled: true,
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(0);
    expect(removeWorktreeCalls).toHaveLength(0);
  });

  test("cleanup_merged_worktrees false — state PATCH still happens, but removeWorktree is not called", async () => {
    const record = makeRecord({ id: "pr-7", prNumber: 7 });
    const { deps, patchCalls, removeWorktreeCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#7": {
          state: "MERGED",
          mergedAt: "2026-07-14T09:00:00.000Z",
          headRefName: "feat/no-cleanup",
        },
      },
      cleanupMergedWorktreesEnabled: false,
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].fields.state).toBe("merged");
    expect(removeWorktreeCalls).toHaveLength(0);
  });

  test("removeWorktree throwing is caught and logged — does not affect the already-succeeded state PATCH, and does not propagate", async () => {
    const record = makeRecord({ id: "pr-8", prNumber: 8 });
    const { deps, patchCalls, removeWorktreeCalls } = makeDeps({
      openRecords: { "acme/example-repo": [record] },
      ghResults: {
        "acme/example-repo#8": {
          state: "MERGED",
          mergedAt: "2026-07-14T09:00:00.000Z",
          headRefName: "feat/removal-fails",
        },
      },
      cleanupMergedWorktreesEnabled: true,
      removeWorktree: async () => {
        throw new Error("git worktree remove failed: directory not found");
      },
    });

    // Must not throw — the failure is isolated to the worktree side effect.
    await expect(reconcilePrState(deps)).resolves.toBeUndefined();

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].fields.state).toBe("merged");
    expect(removeWorktreeCalls).toHaveLength(1);
  });

  // PLR-1.1: isCleanupMergedWorktreesEnabled is a live getter (() =>
  // boolean), invoked fresh by reconcileRecord() on every call — not
  // memoized. A stub that flips its return value between calls must be
  // observed to flip whether removeWorktree fires across two separate
  // merged records reconciled within the same pass, proving the getter is
  // invoked per-record rather than its first result being cached (mirrors
  // an agent-policy.md edit to cleanup_merged_worktrees taking effect on
  // the very next reconcile tick without an agent process restart).
  test("isCleanupMergedWorktreesEnabled getter is invoked fresh on every reconcileRecord call, not memoized", async () => {
    const recordA = makeRecord({ id: "pr-9", prNumber: 9 });
    const recordB = makeRecord({ id: "pr-10", prNumber: 10 });
    const values = [false, true];
    const { deps, patchCalls, removeWorktreeCalls } = makeDeps({
      openRecords: { "acme/example-repo": [recordA, recordB] },
      ghResults: {
        "acme/example-repo#9": {
          state: "MERGED",
          mergedAt: "2026-07-14T09:00:00.000Z",
          headRefName: "feat/first-merge",
        },
        "acme/example-repo#10": {
          state: "MERGED",
          mergedAt: "2026-07-14T09:05:00.000Z",
          headRefName: "feat/second-merge",
        },
      },
      cleanupMergedWorktreesEnabled: () => values.shift() as boolean,
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(2);
    expect(removeWorktreeCalls).toHaveLength(1);
    expect(removeWorktreeCalls[0]).toEqual({
      shortRepo: "example-repo",
      worktreeDirName: "example-repo-feat-second-merge",
    });
  });

  test("gh lookup failure for one PR does not abort reconciliation of the others in the same batch", async () => {
    const recordA = makeRecord({ id: "pr-a", prNumber: 10 });
    const recordB = makeRecord({ id: "pr-b", prNumber: 11 });
    const recordC = makeRecord({ id: "pr-c", prNumber: 12 });
    const { deps, patchCalls } = makeDeps({
      openRecords: { "acme/example-repo": [recordA, recordB, recordC] },
      ghResults: {
        "acme/example-repo#10": {
          state: "MERGED",
          mergedAt: "2026-07-14T00:00:00.000Z",
        },
        "acme/example-repo#11": new Error("gh pr view failed: rate limited"),
        "acme/example-repo#12": { state: "CLOSED", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    // pr-a and pr-c reconciled despite pr-b's lookup failure
    expect(patchCalls).toHaveLength(2);
    const ids = patchCalls.map((c) => c.id).sort();
    expect(ids).toEqual(["pr-a", "pr-c"]);
  });

  test("paginates beyond the default page limit — scans a second page", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) =>
      makeRecord({ id: `pr-p1-${i}`, prNumber: 100 + i }),
    );
    const page2 = Array.from({ length: 1 }, (_, i) =>
      makeRecord({ id: `pr-p2-${i}`, prNumber: 200 + i }),
    );
    const ghResults: Record<string, GhPrView> = {};
    for (const r of [...page1, ...page2]) {
      ghResults[`acme/example-repo#${r.prNumber}`] = {
        state: "OPEN",
        mergedAt: null,
      };
    }

    const { deps, listCalls } = makeDeps({
      openRecords: { "acme/example-repo": [...page1, ...page2] },
      ghResults,
      pageLimit: 2,
    });

    await reconcilePrState(deps);

    // Two pages fetched: offset 0 (full page of 2) then offset 2 (partial page of 1)
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]).toMatchObject({
      repo: "acme/example-repo",
      limit: 2,
      offset: 0,
    });
    expect(listCalls[1]).toMatchObject({
      repo: "acme/example-repo",
      limit: 2,
      offset: 2,
    });
  });

  test("scans multiple repos independently", async () => {
    const recordA = makeRecord({
      id: "pr-repoA",
      repo: "acme/repo-a",
      prNumber: 1,
    });
    const recordB = makeRecord({
      id: "pr-repoB",
      repo: "acme/repo-b",
      prNumber: 1,
    });
    const { deps, patchCalls } = makeDeps({
      repos: ["acme/repo-a", "acme/repo-b"],
      openRecords: {
        "acme/repo-a": [recordA],
        "acme/repo-b": [recordB],
      },
      ghResults: {
        "acme/repo-a#1": {
          state: "MERGED",
          mergedAt: "2026-07-14T00:00:00.000Z",
        },
        "acme/repo-b#1": { state: "OPEN", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-repoA");
  });

  test("no repos configured — no-op, no PATCH calls", async () => {
    const { deps, patchCalls, listCalls } = makeDeps({ repos: [] });

    await reconcilePrState(deps);

    expect(listCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
  });

  test("no open records for a repo — no-op for that repo", async () => {
    const { deps, patchCalls } = makeDeps({
      repos: ["acme/example-repo"],
      openRecords: {},
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  // ─── scope filtering (WL-4.4) ─────────────────────────────────────────────

  test("a repo present locally but absent from getScopedRepos() is excluded from the reconciled set", async () => {
    const recordInScope = makeRecord({
      id: "pr-repoA",
      repo: "acme/repo-a",
      prNumber: 1,
    });
    const recordOutOfScope = makeRecord({
      id: "pr-repoB",
      repo: "acme/repo-b",
      prNumber: 1,
    });
    const { deps, patchCalls, listCalls } = makeDeps({
      repos: ["acme/repo-a", "acme/repo-b"],
      openRecords: {
        "acme/repo-a": [recordInScope],
        "acme/repo-b": [recordOutOfScope],
      },
      ghResults: {
        "acme/repo-a#1": {
          state: "MERGED",
          mergedAt: "2026-07-14T00:00:00.000Z",
        },
        "acme/repo-b#1": {
          state: "MERGED",
          mergedAt: "2026-07-14T00:00:00.000Z",
        },
      },
      getScopedRepos: () => ["acme/repo-a"],
    });

    await reconcilePrState(deps);

    expect(listCalls.map((c) => c.repo)).toEqual(["acme/repo-a"]);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-repoA");
  });

  test("re-evaluates getScopedRepos() on every call — a repo added to scope between two calls appears on the second call", async () => {
    const recordB = makeRecord({
      id: "pr-repoB",
      repo: "acme/repo-b",
      prNumber: 1,
    });
    let scope: string[] = [];
    const { deps, patchCalls, listCalls } = makeDeps({
      repos: ["acme/repo-a", "acme/repo-b"],
      openRecords: {
        "acme/repo-b": [recordB],
      },
      ghResults: {
        "acme/repo-b#1": {
          state: "MERGED",
          mergedAt: "2026-07-14T00:00:00.000Z",
        },
      },
      getScopedRepos: () => scope,
    });

    await reconcilePrState(deps);
    expect(listCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);

    scope = ["acme/repo-b"];
    await reconcilePrState(deps);
    expect(listCalls.map((c) => c.repo)).toEqual(["acme/repo-b"]);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-repoB");
  });

  test("getScopedRepos() returning an empty array filters out all repos — no-op, no crash", async () => {
    const record = makeRecord({ id: "pr-1", prNumber: 1 });
    const { deps, patchCalls, listCalls } = makeDeps({
      repos: ["acme/example-repo"],
      openRecords: { "acme/example-repo": [record] },
      getScopedRepos: () => [],
    });

    await reconcilePrState(deps);

    expect(listCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
  });
});

// ─── reconcileReviewState ──────────────────────────────────────────────────────

interface ListReviewCall {
  repo: string;
  limit: number;
  offset: number;
  updatedSince?: string;
}

interface ReviewPatchCall {
  id: string;
  fields: Record<string, unknown>;
}

interface MakeReviewStateDepsOptions {
  repos?: string[];
  /** repo -> full page of reviewState:"pending" records (pagination simulated by slicing). */
  pendingRecords?: Record<string, PrReviewStateRecord[]>;
  /** repo -> full page of reviewState:"posted" records (pagination simulated by slicing). */
  postedRecords?: Record<string, PrReviewStateRecord[]>;
  /** "repo#prNumber" -> review data, or an Error to throw for that fetch. */
  reviewResults?: Record<string, PrReviewData | Error>;
  pageLimit?: number;
  clock?: Clock;
  claimTtlMs?: number;
  /** Defaults to `() => repos` so every existing test keeps passing unchanged. */
  getScopedRepos?: () => string[];
}

function makeReviewStateDeps({
  repos = ["acme/example-repo"],
  pendingRecords = {},
  postedRecords = {},
  reviewResults = {},
  pageLimit = 50,
  clock = FixedClock(new Date("2026-07-15T12:00:00.000Z")),
  claimTtlMs,
  getScopedRepos = () => repos,
}: MakeReviewStateDepsOptions = {}): {
  deps: PrReviewStateReconcilerDeps;
  listCalls: ListReviewCall[];
  listPostedCalls: ListReviewCall[];
  patchCalls: ReviewPatchCall[];
  fetchCalls: string[];
  delayCalls: number[];
} {
  const listCalls: ListReviewCall[] = [];
  const listPostedCalls: ListReviewCall[] = [];
  const patchCalls: ReviewPatchCall[] = [];
  const fetchCalls: string[] = [];
  const delayCalls: number[] = [];

  const deps: PrReviewStateReconcilerDeps = {
    repos,
    getScopedRepos,
    pageLimit,
    clock,
    ...(claimTtlMs !== undefined ? { claimTtlMs } : {}),
    listPendingReviewRecords: async (
      repo: string,
      limit: number,
      offset: number,
      updatedSince: string,
    ) => {
      listCalls.push({ repo, limit, offset, updatedSince });
      const all = pendingRecords[repo] ?? [];
      return all.slice(offset, offset + limit);
    },
    listPostedReviewRecords: async (
      repo: string,
      limit: number,
      offset: number,
    ) => {
      listPostedCalls.push({ repo, limit, offset });
      const all = postedRecords[repo] ?? [];
      return all.slice(offset, offset + limit);
    },
    patchPrRecord: async (id: string, fields: Record<string, unknown>) => {
      patchCalls.push({ id, fields });
    },
    fetchPrReviews: async (org: string, repo: string, prNumber: number) => {
      const key = `${org}/${repo}#${prNumber}`;
      fetchCalls.push(key);
      const result = reviewResults[key];
      if (result instanceof Error) throw result;
      if (!result)
        throw new Error(`no fake review result configured for ${key}`);
      return result;
    },
    delay: async (ms: number) => {
      delayCalls.push(ms);
    },
  };

  return {
    deps,
    listCalls,
    listPostedCalls,
    patchCalls,
    fetchCalls,
    delayCalls,
  };
}

function makeReviewStateRecord(
  overrides: Partial<PrReviewStateRecord> = {},
): PrReviewStateRecord {
  return {
    id: "pr-rs-1",
    repo: "acme/example-repo",
    prNumber: 1,
    claimedBy: null,
    claimedAt: null,
    heartbeatAt: null,
    ...overrides,
  };
}

function makeReviewNode(overrides: Partial<ReviewNode> = {}): ReviewNode {
  return {
    author: { login: "some-reviewer" },
    state: "COMMENTED",
    submittedAt: "2026-07-15T10:00:00.000Z",
    commit: { oid: "head-sha" },
    body: "",
    ...overrides,
  };
}

function makeReviewThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    isResolved: true,
    comments: { nodes: [{ author: { login: "some-reviewer" }, body: "" }] },
    ...overrides,
  };
}

function makeReviewData(overrides: Partial<PrReviewData> = {}): PrReviewData {
  return {
    headRefOid: "head-sha",
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

describe("reconcileReviewState", () => {
  test("listPendingReviewRecords is called with updatedSince computed as now-6h via the injected clock, but listPostedReviewRecords is not (PSR-1.1, widened per review)", async () => {
    const clock = FixedClock(new Date("2026-07-19T23:15:00.000Z"));
    const { deps, listCalls, listPostedCalls } = makeReviewStateDeps({
      pendingRecords: {},
      postedRecords: {},
      clock,
    });

    await reconcileReviewState(deps);

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toEqual({
      repo: "acme/example-repo",
      limit: 50,
      offset: 0,
      updatedSince: "2026-07-19T17:15:00.000Z",
    });

    expect(listPostedCalls).toHaveLength(1);
    expect(listPostedCalls[0]).toEqual({
      repo: "acme/example-repo",
      limit: 50,
      offset: 0,
    });
  });

  test("clean APPROVE at head commit gets reconciled to reviewState:approved", async () => {
    const record = makeReviewStateRecord({ id: "pr-approve", prNumber: 1 });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "LGTM",
          }),
        ],
      },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#1": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-approve");
    expect(patchCalls[0].fields.reviewState).toBe("approved");
  });

  test("clean-approve-shaped COMMENTED review at head (any author) gets reconciled to approved", async () => {
    const record = makeReviewStateRecord({
      id: "pr-clean-comment",
      prNumber: 2,
    });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "COMMENTED",
            commit: { oid: "head-sha" },
            body: "**APPROVE**\n\nLooks good, nothing else to add.",
            author: { login: "out-of-band-reviewer" },
          }),
        ],
      },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#2": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-clean-comment");
    expect(patchCalls[0].fields.reviewState).toBe("approved");
  });

  test("terminal non-approve review at head (no unresolved threads, empty body) gets reconciled to posted", async () => {
    const record = makeReviewStateRecord({ id: "pr-terminal", prNumber: 3 });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "COMMENTED",
            commit: { oid: "head-sha" },
            body: "",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: true })] },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#3": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-terminal");
    expect(patchCalls[0].fields.reviewState).toBe("posted");
  });

  test("genuine unresolved finding at head — left completely untouched, no PATCH", async () => {
    const record = makeReviewStateRecord({ id: "pr-finding", prNumber: 4 });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "CHANGES_REQUESTED",
            commit: { oid: "head-sha" },
            body: "This breaks the auth flow, please fix.",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: false })] },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#4": reviewData },
    });

    await reconcileReviewState(deps);

    // This is the acceptance-critical assertion: a reconciler bug that flips
    // reviewState on a real, unaddressed finding would silently suppress
    // check-review.ts's eligibility gate for a PR that genuinely needs work.
    expect(patchCalls).toHaveLength(0);
  });

  test("genuine finding via non-empty body only (threads resolved) — left untouched, no PATCH", async () => {
    const record = makeReviewStateRecord({
      id: "pr-finding-body",
      prNumber: 5,
    });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "COMMENTED",
            commit: { oid: "head-sha" },
            body: "Please rename this variable before merging.",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: true })] },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#5": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  test("approve from one reviewer + independent unresolved finding from another reviewer at head — left untouched, no PATCH", async () => {
    const record = makeReviewStateRecord({
      id: "pr-approve-plus-finding",
      prNumber: 30,
    });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "reviewer-a" },
            state: "CHANGES_REQUESTED",
            commit: { oid: "head-sha" },
            body: "This breaks the auth flow, please fix.",
          }),
          makeReviewNode({
            author: { login: "reviewer-b" },
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "LGTM",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: false })] },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#30": reviewData },
    });

    await reconcileReviewState(deps);

    // GitHub's own aggregate reviewDecision would still be CHANGES_REQUESTED
    // here — an unrelated APPROVED from a second reviewer must never mask
    // reviewer-a's genuine unresolved finding.
    expect(patchCalls).toHaveLength(0);
  });

  test("review only at a stale/prior commit — left untouched, no PATCH", async () => {
    const record = makeReviewStateRecord({
      id: "pr-stale-commit",
      prNumber: 6,
    });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "some-old-sha" },
            body: "",
          }),
        ],
      },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#6": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  test("no review at all at current head — left untouched, no PATCH", async () => {
    const record = makeReviewStateRecord({ id: "pr-no-review", prNumber: 7 });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: { nodes: [] },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#7": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  test("actively-claimed record with fresh heartbeat is skipped — claim check short-circuits before any GitHub call", async () => {
    const clock = FixedClock(new Date("2026-07-15T12:00:00.000Z"));
    const record = makeReviewStateRecord({
      id: "pr-claimed",
      prNumber: 8,
      claimedBy: "some-agent",
      // 5 minutes ago — well within the default 65-minute TTL.
      heartbeatAt: "2026-07-15T11:55:00.000Z",
    });
    const { deps, patchCalls, fetchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      clock,
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  test("claimed record with stale heartbeat beyond TTL is still reconciled", async () => {
    const clock = FixedClock(new Date("2026-07-15T12:00:00.000Z"));
    const record = makeReviewStateRecord({
      id: "pr-stale-claim",
      prNumber: 9,
      claimedBy: "some-agent",
      // 70 minutes ago — beyond the default 65-minute TTL.
      heartbeatAt: "2026-07-15T10:50:00.000Z",
    });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "",
          }),
        ],
      },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#9": reviewData },
      clock,
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-stale-claim");
  });

  test("claimedBy null with stale claimedAt but no heartbeat — treated as not actively claimed, reconciled", async () => {
    const clock = FixedClock(new Date("2026-07-15T12:00:00.000Z"));
    const record = makeReviewStateRecord({
      id: "pr-null-claimedby",
      prNumber: 10,
      claimedBy: null,
      claimedAt: "2026-07-15T11:55:00.000Z",
      heartbeatAt: null,
    });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "",
          }),
        ],
      },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#10": reviewData },
      clock,
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(1);
  });

  test("claimedBy set but heartbeatAt null falls back to claimedAt for freshness", async () => {
    const clock = FixedClock(new Date("2026-07-15T12:00:00.000Z"));
    const record = makeReviewStateRecord({
      id: "pr-fallback-claimedat",
      prNumber: 11,
      claimedBy: "some-agent",
      claimedAt: "2026-07-15T11:55:00.000Z",
      heartbeatAt: null,
    });
    const { deps, patchCalls, fetchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [record] },
      clock,
    });

    await reconcileReviewState(deps);

    // claimedAt is only 5 minutes old — within TTL — so this must be skipped
    // just like the fresh-heartbeat case, and without ever calling GitHub.
    expect(patchCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  test("per-record review-fetch failure does not abort reconciliation of the rest of the batch", async () => {
    const recordA = makeReviewStateRecord({ id: "pr-ok-a", prNumber: 20 });
    const recordB = makeReviewStateRecord({ id: "pr-fail-b", prNumber: 21 });
    const recordC = makeReviewStateRecord({ id: "pr-ok-c", prNumber: 22 });
    const okReview = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "",
          }),
        ],
      },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [recordA, recordB, recordC] },
      reviewResults: {
        "acme/example-repo#20": okReview,
        "acme/example-repo#21": new Error("GraphQL rate limited"),
        "acme/example-repo#22": okReview,
      },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(2);
    const ids = patchCalls.map((c) => c.id).sort();
    expect(ids).toEqual(["pr-ok-a", "pr-ok-c"]);
  });

  test("paginates beyond the default page limit across pending review records", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) =>
      makeReviewStateRecord({ id: `pr-p1-${i}`, prNumber: 100 + i }),
    );
    const page2 = Array.from({ length: 1 }, (_, i) =>
      makeReviewStateRecord({ id: `pr-p2-${i}`, prNumber: 200 + i }),
    );
    const reviewResults: Record<string, PrReviewData> = {};
    for (const r of [...page1, ...page2]) {
      reviewResults[`acme/example-repo#${r.prNumber}`] = makeReviewData({
        headRefOid: "head-sha",
      });
    }

    const { deps, listCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": [...page1, ...page2] },
      reviewResults,
      pageLimit: 2,
    });

    await reconcileReviewState(deps);

    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]).toMatchObject({
      repo: "acme/example-repo",
      limit: 2,
      offset: 0,
    });
    expect(listCalls[1]).toMatchObject({
      repo: "acme/example-repo",
      limit: 2,
      offset: 2,
    });
  });

  test("scans multiple repos independently for review state", async () => {
    const recordA = makeReviewStateRecord({
      id: "pr-repoA",
      repo: "acme/repo-a",
      prNumber: 1,
    });
    const recordB = makeReviewStateRecord({
      id: "pr-repoB",
      repo: "acme/repo-b",
      prNumber: 1,
    });
    const approveReview = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "",
          }),
        ],
      },
    });
    const untouchedReview = makeReviewData({
      headRefOid: "head-sha",
      reviews: { nodes: [] },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      repos: ["acme/repo-a", "acme/repo-b"],
      pendingRecords: {
        "acme/repo-a": [recordA],
        "acme/repo-b": [recordB],
      },
      reviewResults: {
        "acme/repo-a#1": approveReview,
        "acme/repo-b#1": untouchedReview,
      },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-repoA");
  });

  test("no repos configured — no-op, no list/patch calls", async () => {
    const { deps, patchCalls, listCalls } = makeReviewStateDeps({ repos: [] });

    await reconcileReviewState(deps);

    expect(listCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
  });

  // ─── scope filtering (PSR-1.3) ────────────────────────────────────────────

  test("a repo present locally but absent from getScopedRepos() is excluded from both the pending and posted scans", async () => {
    const recordInScope = makeReviewStateRecord({
      id: "pr-repoA",
      repo: "acme/repo-a",
      prNumber: 1,
    });
    const recordOutOfScope = makeReviewStateRecord({
      id: "pr-repoB",
      repo: "acme/repo-b",
      prNumber: 1,
    });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [makeReviewNode({ state: "APPROVED" })],
      },
    });
    const { deps, patchCalls, listCalls, listPostedCalls, fetchCalls } =
      makeReviewStateDeps({
        repos: ["acme/repo-a", "acme/repo-b"],
        pendingRecords: {
          "acme/repo-a": [recordInScope],
          "acme/repo-b": [recordOutOfScope],
        },
        postedRecords: {
          "acme/repo-a": [],
          "acme/repo-b": [],
        },
        reviewResults: {
          "acme/repo-a#1": reviewData,
          "acme/repo-b#1": reviewData,
        },
        getScopedRepos: () => ["acme/repo-a"],
      });

    await reconcileReviewState(deps);

    expect(listCalls.map((c) => c.repo)).toEqual(["acme/repo-a"]);
    expect(listPostedCalls.map((c) => c.repo)).toEqual(["acme/repo-a"]);
    expect(fetchCalls).toEqual(["acme/repo-a#1"]);
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-repoA");
  });

  test("getScopedRepos() returning an empty array filters out all repos — no-op, no crash", async () => {
    const record = makeReviewStateRecord({ id: "pr-1", prNumber: 1 });
    const { deps, patchCalls, listCalls, listPostedCalls } =
      makeReviewStateDeps({
        repos: ["acme/example-repo"],
        pendingRecords: { "acme/example-repo": [record] },
        getScopedRepos: () => [],
      });

    await reconcileReviewState(deps);

    expect(listCalls).toHaveLength(0);
    expect(listPostedCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
  });
});

// ─── reconcileReviewState — posted-scan pass (CHU-2.4) ──────────────────────────

describe("reconcileReviewState — posted-scan pass (CHU-2.4)", () => {
  test("#1814 case: posted record, all reviews at a stale commit, no review at current head at all — PATCH back to pending", async () => {
    const record = makeReviewStateRecord({
      id: "pr-1814",
      prNumber: 1814,
    });
    // A new commit landed since the posted verdict; the only review on file
    // targets the prior (now-stale) commit, so nothing at all qualifies at
    // the current head.
    const reviewData = makeReviewData({
      headRefOid: "new-head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "CHANGES_REQUESTED",
            commit: { oid: "stale-sha" },
            body: "Please fix the auth flow.",
          }),
        ],
      },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      postedRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#1814": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-1814");
    expect(patchCalls[0].fields).toEqual({ reviewState: "pending" });
  });

  test("posted record with a genuine unresolved finding at the new head — left untouched, no PATCH", async () => {
    const record = makeReviewStateRecord({
      id: "pr-posted-real-finding",
      prNumber: 1815,
    });
    const reviewData = makeReviewData({
      headRefOid: "new-head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "CHANGES_REQUESTED",
            commit: { oid: "new-head-sha" },
            body: "This still breaks the auth flow, please fix.",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: false })] },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      postedRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#1815": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  test("posted record with a genuine finding via non-empty body only (threads resolved) at new head — left untouched, no PATCH", async () => {
    const record = makeReviewStateRecord({
      id: "pr-posted-real-finding-body",
      prNumber: 1816,
    });
    const reviewData = makeReviewData({
      headRefOid: "new-head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "COMMENTED",
            commit: { oid: "new-head-sha" },
            body: "Please rename this variable before merging.",
          }),
        ],
      },
      reviewThreads: { nodes: [makeReviewThread({ isResolved: true })] },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      postedRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#1816": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  test("posted record still terminal/clean at head (e.g. still approved) — no PATCH, nothing changed", async () => {
    const record = makeReviewStateRecord({
      id: "pr-posted-still-approved",
      prNumber: 1817,
    });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "LGTM",
          }),
        ],
      },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      postedRecords: { "acme/example-repo": [record] },
      reviewResults: { "acme/example-repo#1817": reviewData },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(0);
  });

  test("actively-claimed posted record is skipped without any GitHub call", async () => {
    const clock = FixedClock(new Date("2026-07-15T12:00:00.000Z"));
    const record = makeReviewStateRecord({
      id: "pr-posted-claimed",
      prNumber: 1818,
      claimedBy: "some-agent",
      // 5 minutes ago — well within the default 65-minute TTL.
      heartbeatAt: "2026-07-15T11:55:00.000Z",
    });
    const { deps, patchCalls, fetchCalls } = makeReviewStateDeps({
      postedRecords: { "acme/example-repo": [record] },
      clock,
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  test("posted scan paginates beyond the default page limit", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) =>
      makeReviewStateRecord({ id: `pr-posted-p1-${i}`, prNumber: 300 + i }),
    );
    const page2 = Array.from({ length: 1 }, (_, i) =>
      makeReviewStateRecord({ id: `pr-posted-p2-${i}`, prNumber: 400 + i }),
    );
    const reviewResults: Record<string, PrReviewData> = {};
    for (const r of [...page1, ...page2]) {
      // All still terminal/clean at head — nothing should PATCH, this test
      // only cares about the pagination call shape.
      reviewResults[`acme/example-repo#${r.prNumber}`] = makeReviewData({
        headRefOid: "head-sha",
        reviews: {
          nodes: [
            makeReviewNode({
              state: "APPROVED",
              commit: { oid: "head-sha" },
              body: "",
            }),
          ],
        },
      });
    }

    const { deps, listPostedCalls } = makeReviewStateDeps({
      postedRecords: { "acme/example-repo": [...page1, ...page2] },
      reviewResults,
      pageLimit: 2,
    });

    await reconcileReviewState(deps);

    expect(listPostedCalls).toHaveLength(2);
    expect(listPostedCalls[0]).toMatchObject({
      repo: "acme/example-repo",
      limit: 2,
      offset: 0,
    });
    expect(listPostedCalls[1]).toMatchObject({
      repo: "acme/example-repo",
      limit: 2,
      offset: 2,
    });
  });

  test("posted-list fetch failure for one repo does not abort the pending scan or other repos' posted scans", async () => {
    const pendingRecord = makeReviewStateRecord({
      id: "pr-pending-ok",
      repo: "acme/repo-a",
      prNumber: 1,
    });
    const postedRecordB = makeReviewStateRecord({
      id: "pr-posted-ok-b",
      repo: "acme/repo-b",
      prNumber: 1,
    });
    const approveReview = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "",
          }),
        ],
      },
    });
    const noReviewAtHead = makeReviewData({
      headRefOid: "new-head-sha",
      reviews: { nodes: [] },
    });

    const deps: PrReviewStateReconcilerDeps = {
      repos: ["acme/repo-a", "acme/repo-b"],
      getScopedRepos: () => ["acme/repo-a", "acme/repo-b"],
      pageLimit: 50,
      clock: FixedClock(new Date("2026-07-15T12:00:00.000Z")),
      listPendingReviewRecords: async (repo: string) => {
        if (repo === "acme/repo-a") return [pendingRecord];
        return [];
      },
      listPostedReviewRecords: async (repo: string) => {
        if (repo === "acme/repo-a") {
          throw new Error("task-store GET /prs → 503");
        }
        return [postedRecordB];
      },
      patchPrRecord: async () => {},
      fetchPrReviews: async (org: string, repo: string, prNumber: number) => {
        const key = `${org}/${repo}#${prNumber}`;
        if (key === "acme/repo-a#1") return approveReview;
        if (key === "acme/repo-b#1") return noReviewAtHead;
        throw new Error(`no fake review result configured for ${key}`);
      },
      delay: async () => {},
    };
    const patchCalls: ReviewPatchCall[] = [];
    deps.patchPrRecord = async (
      id: string,
      fields: Record<string, unknown>,
    ) => {
      patchCalls.push({ id, fields });
    };

    await reconcileReviewState(deps);

    // repo-a's pending scan still succeeds (approved), and repo-b's posted
    // scan still runs and PATCHes back to pending — the repo-a posted-list
    // failure is isolated to that repo/pass only.
    expect(patchCalls).toHaveLength(2);
    const byId = Object.fromEntries(patchCalls.map((c) => [c.id, c.fields]));
    expect(byId["pr-pending-ok"]).toEqual({ reviewState: "approved" });
    expect(byId["pr-posted-ok-b"]).toEqual({ reviewState: "pending" });
  });

  test("scans multiple repos independently for the posted pass", async () => {
    const recordA = makeReviewStateRecord({
      id: "pr-posted-repoA",
      repo: "acme/repo-a",
      prNumber: 1,
    });
    const recordB = makeReviewStateRecord({
      id: "pr-posted-repoB",
      repo: "acme/repo-b",
      prNumber: 1,
    });
    const noReviewAtHead = makeReviewData({
      headRefOid: "new-head-sha",
      reviews: { nodes: [] },
    });
    const stillApproved = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "",
          }),
        ],
      },
    });
    const { deps, patchCalls } = makeReviewStateDeps({
      repos: ["acme/repo-a", "acme/repo-b"],
      postedRecords: {
        "acme/repo-a": [recordA],
        "acme/repo-b": [recordB],
      },
      reviewResults: {
        "acme/repo-a#1": noReviewAtHead,
        "acme/repo-b#1": stillApproved,
      },
    });

    await reconcileReviewState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-posted-repoA");
    expect(patchCalls[0].fields).toEqual({ reviewState: "pending" });
  });
});

// ─── buildReviewStateProductionDeps ─────────────────────────────────────────────

describe("buildReviewStateProductionDeps", () => {
  const savedEnv = {
    SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS:
      process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS,
  };

  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be fully removed, not set to "undefined" string
    delete process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS;
  });

  afterEach(() => {
    if (savedEnv.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS === undefined) {
      // biome-ignore lint/performance/noDelete: restore to fully-unset state
      delete process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS;
    } else {
      process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS =
        savedEnv.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS;
    }
  });

  test("claimTtlMs falls back to the default when the env var is unset", () => {
    const deps = buildReviewStateProductionDeps({
      ghGraphql: <T>() => Promise.resolve({}) as Promise<T>,
      getScopedRepos: () => [],
      // A nonexistent workspace path is fine — resolveAllRepos() just
      // returns [] when workspace/repos/ doesn't exist, and this suite only
      // cares about the claimTtlMs field.
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });

    expect(deps.claimTtlMs).toBe(DEFAULT_CLAIM_TTL_MS);
  });

  test("claimTtlMs reads SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS when set, matching stale-claim-reaper.ts", () => {
    process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS = "60000";

    const deps = buildReviewStateProductionDeps({
      ghGraphql: <T>() => Promise.resolve({}) as Promise<T>,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });

    expect(deps.claimTtlMs).toBe(60_000);
  });
});

describe("buildProductionDeps — task-store GET /tasks pagination (TCR-1.2)", () => {
  /**
   * Fake fetchFn that simulates the task-store's GET /tasks?status=<status>
   * pagination contract: returns up to `limit` records starting at `offset`
   * from a fixed per-status backing array. Records every request's status,
   * limit, and offset so tests can assert the full paging sequence.
   * `updatedSince` is recorded when present but is never sent by the pr_open
   * list call path (RCB-1.1) — present here only so a caller could assert its
   * absence (`hasUpdatedSince: false`).
   */
  function makeFakeTaskStoreFetch(opts: {
    tasksByStatus: Record<string, PrOpenTaskRecord[]>;
  }): {
    fetchFn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    calls: Array<{
      status: string;
      limit: number;
      offset: number;
      hasUpdatedSince: boolean;
    }>;
  } {
    const calls: Array<{
      status: string;
      limit: number;
      offset: number;
      hasUpdatedSince: boolean;
    }> = [];
    const fetchFn = async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      const status = parsed.searchParams.get("status") ?? "";
      const limit = Number(parsed.searchParams.get("limit"));
      const offset = Number(parsed.searchParams.get("offset"));
      const hasUpdatedSince = parsed.searchParams.has("updatedSince");
      calls.push({ status, limit, offset, hasUpdatedSince });
      const all = opts.tasksByStatus[status] ?? [];
      const page = all.slice(offset, offset + limit);
      return new Response(JSON.stringify({ tasks: page }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    return { fetchFn, calls };
  }

  const savedTaskStoreEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_URL =
      process.env.SHIPWRIGHT_TASK_STORE_URL;
    savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_TOKEN =
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://task-store.example.test";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "fake-token";
  });

  afterEach(() => {
    if (savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_URL === undefined) {
      // biome-ignore lint/performance/noDelete: restore to fully-unset state
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    } else {
      process.env.SHIPWRIGHT_TASK_STORE_URL =
        savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_TOKEN === undefined) {
      // biome-ignore lint/performance/noDelete: restore to fully-unset state
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    } else {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN =
        savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("listPrOpenTasks issues a single GET when under the page limit — no updatedSince param (RCB-1.1)", async () => {
    const tasks = [{ id: "t1", repo: "acme/example-repo", pr: 1 }];
    const { fetchFn, calls } = makeFakeTaskStoreFetch({
      tasksByStatus: { pr_open: tasks },
    });
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });

    const result = await deps.listPrOpenTasks(50, 0);

    expect(result).toEqual(tasks);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      status: "pr_open",
      limit: 50,
      offset: 0,
      hasUpdatedSince: false,
    });
  });

  /**
   * Fake fetchFn for `listAllTasksForBranch` (BBR-1.1) — simulates the
   * task-store's GET /tasks?repo=<repo>&branch=<branch> pagination contract,
   * mirroring `makeFakeTaskStoreFetch` above but keyed on repo+branch
   * instead of status.
   */
  function makeFakeBranchTaskStoreFetch(opts: {
    tasksByRepoBranch: Record<string, PrOpenTaskRecord[]>;
  }): {
    fetchFn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    calls: Array<{
      repo: string;
      branch: string;
      limit: number;
      offset: number;
    }>;
  } {
    const calls: Array<{
      repo: string;
      branch: string;
      limit: number;
      offset: number;
    }> = [];
    const fetchFn = async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      const repo = parsed.searchParams.get("repo") ?? "";
      const branch = parsed.searchParams.get("branch") ?? "";
      const limit = Number(parsed.searchParams.get("limit"));
      const offset = Number(parsed.searchParams.get("offset"));
      calls.push({ repo, branch, limit, offset });
      const all = opts.tasksByRepoBranch[`${repo}#${branch}`] ?? [];
      const page = all.slice(offset, offset + limit);
      return new Response(JSON.stringify({ tasks: page }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    return { fetchFn, calls };
  }

  test("listAllTasksForBranch issues a single GET scoped by repo+branch when under the page limit", async () => {
    const tasks = [
      { id: "t1", repo: "acme/example-repo", branch: "feat/bundle" },
      { id: "t2", repo: "acme/example-repo", branch: "feat/bundle" },
    ];
    const { fetchFn, calls } = makeFakeBranchTaskStoreFetch({
      tasksByRepoBranch: { "acme/example-repo#feat/bundle": tasks },
    });
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });

    const result = await deps.listAllTasksForBranch(
      "acme/example-repo",
      "feat/bundle",
    );

    expect(result).toEqual(tasks);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      repo: "acme/example-repo",
      branch: "feat/bundle",
      limit: 50,
      offset: 0,
    });
  });

  test("listAllTasksForBranch pages past the default 50-row task-store page", async () => {
    const tasks = Array.from({ length: 62 }, (_, i) => ({
      id: `bundle-task-${i}`,
      repo: "acme/example-repo",
      branch: "feat/big-bundle",
    }));
    const { fetchFn, calls } = makeFakeBranchTaskStoreFetch({
      tasksByRepoBranch: { "acme/example-repo#feat/big-bundle": tasks },
    });
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });

    const result = await deps.listAllTasksForBranch(
      "acme/example-repo",
      "feat/big-bundle",
    );

    expect(result).toHaveLength(62);
    expect(calls).toEqual([
      {
        repo: "acme/example-repo",
        branch: "feat/big-bundle",
        limit: 50,
        offset: 0,
      },
      {
        repo: "acme/example-repo",
        branch: "feat/big-bundle",
        limit: 50,
        offset: 50,
      },
    ]);
  });

  // ─── RSG-1.2: degraded scope resolution retry ────────────────────────────

  /**
   * Fake fetchFn for `listAllTasksForBranch` (RSG-1.2) — same request shape
   * as `makeFakeBranchTaskStoreFetch` above, but every response also carries
   * a `scopeDegraded` flag (mirroring RSG-1.1's real GET /tasks response
   * shape — `{ tasks, total, scopeDegraded }`, task-store/src/routes/tasks.ts).
   * `degradedForCalls` responses are degraded (scopeDegraded:true, tasks:[]
   * — mirrors the real under-count symptom: the resolver failure forces
   * `repos` to `[]` server-side, which starves the agent-scope OR-union and
   * silently drops pool/bundle-mate tasks from the result) before the
   * response settles into whatever `tasksByRepoBranch` actually holds.
   */
  function makeFakeDegradableBranchTaskStoreFetch(opts: {
    tasksByRepoBranch: Record<string, PrOpenTaskRecord[]>;
    /** How many leading calls return scopeDegraded:true (with an empty tasks page). */
    degradedForCalls: number;
  }): {
    fetchFn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    calls: Array<{
      repo: string;
      branch: string;
      limit: number;
      offset: number;
    }>;
  } {
    const calls: Array<{
      repo: string;
      branch: string;
      limit: number;
      offset: number;
    }> = [];
    let callCount = 0;
    const fetchFn = async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      const repo = parsed.searchParams.get("repo") ?? "";
      const branch = parsed.searchParams.get("branch") ?? "";
      const limit = Number(parsed.searchParams.get("limit"));
      const offset = Number(parsed.searchParams.get("offset"));
      calls.push({ repo, branch, limit, offset });
      callCount += 1;
      if (callCount <= opts.degradedForCalls) {
        return new Response(
          JSON.stringify({ tasks: [], total: 0, scopeDegraded: true }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const all = opts.tasksByRepoBranch[`${repo}#${branch}`] ?? [];
      const page = all.slice(offset, offset + limit);
      return new Response(
        JSON.stringify({
          tasks: page,
          total: all.length,
          scopeDegraded: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    return { fetchFn, calls };
  }

  test("RSG-1.2: listAllTasksForBranch retries once (bounded delay) then still-degraded — returns SCOPE_DEGRADED without paging further", async () => {
    const tasks = [
      { id: "t1", repo: "acme/example-repo", branch: "feat/bundle" },
      { id: "t2", repo: "acme/example-repo", branch: "feat/bundle" },
    ];
    const { fetchFn, calls } = makeFakeDegradableBranchTaskStoreFetch({
      tasksByRepoBranch: { "acme/example-repo#feat/bundle": tasks },
      // Both the initial call and the single retry come back degraded.
      degradedForCalls: 2,
    });
    const delayCalls: number[] = [];
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });
    const originalDelay = deps.delay;
    deps.delay = async (ms: number) => {
      delayCalls.push(ms);
      await originalDelay(0); // don't actually wait in the test
    };

    const result = await deps.listAllTasksForBranch(
      "acme/example-repo",
      "feat/bundle",
    );

    expect(result).toBe(SCOPE_DEGRADED);
    // Exactly one retry — the initial call plus one bounded-delay retry, no more.
    expect(calls).toHaveLength(2);
    expect(delayCalls).toHaveLength(1);
    expect(delayCalls[0]).toBeGreaterThan(0);
  });

  test("RSG-1.2: listAllTasksForBranch retries once then recovers — returns the true sibling count, behaving identically to a non-degraded response", async () => {
    const tasks = [
      { id: "t1", repo: "acme/example-repo", branch: "feat/bundle" },
      { id: "t2", repo: "acme/example-repo", branch: "feat/bundle" },
    ];
    const { fetchFn, calls } = makeFakeDegradableBranchTaskStoreFetch({
      tasksByRepoBranch: { "acme/example-repo#feat/bundle": tasks },
      // Only the initial call is degraded; the retry succeeds.
      degradedForCalls: 1,
    });
    const delayCalls: number[] = [];
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });
    const originalDelay = deps.delay;
    deps.delay = async (ms: number) => {
      delayCalls.push(ms);
      await originalDelay(0);
    };

    const result = await deps.listAllTasksForBranch(
      "acme/example-repo",
      "feat/bundle",
    );

    expect(result).toEqual(tasks);
    expect(delayCalls).toHaveLength(1);
  });

  test("RSG-1.2: a non-degraded response with 0 or 1 tasks is unaffected — no retry, no delay call", async () => {
    const { fetchFn, calls } = makeFakeDegradableBranchTaskStoreFetch({
      tasksByRepoBranch: { "acme/example-repo#feat/solo": [] },
      degradedForCalls: 0,
    });
    const delayCalls: number[] = [];
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });
    const originalDelay = deps.delay;
    deps.delay = async (ms: number) => {
      delayCalls.push(ms);
      await originalDelay(0);
    };

    const result = await deps.listAllTasksForBranch(
      "acme/example-repo",
      "feat/solo",
    );

    expect(result).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(delayCalls).toHaveLength(0);
  });
});

describe("reconcilePrState — pr_open task reconciliation pass", () => {
  beforeEach(() => {
    __resetPrOpenTasksCursorForTests();
  });

  test("listPrOpenTasks is called with a plain limit/offset — no updatedSince anywhere in the call (RCB-1.1)", async () => {
    const { deps, listPrOpenTasksCalls } = makeDeps({
      prOpenTasks: [],
      now: () => "2026-07-19T23:15:00.000Z",
    });

    await reconcilePrState(deps);

    expect(listPrOpenTasksCalls).toHaveLength(1);
    expect(listPrOpenTasksCalls[0]).toEqual({
      limit: 50,
      offset: 0,
    });
  });

  test("pr_open task with merged PR (direct path) is reconciled to merged, using GitHub's mergedAt", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-1",
      repo: "acme/example-repo",
      pr: 42,
    };
    const { deps, taskPatchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#42": {
          state: "MERGED",
          mergedAt: "2026-07-10T00:00:00.000Z",
        },
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-1");
    expect(taskPatchCalls[0].fields.status).toBe("merged");
    expect(taskPatchCalls[0].fields.mergedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(taskPatchCalls[0].fields.pr).toBeUndefined();
  });

  test("pr_open task whose PR has no mergedAt from GitHub falls back to the injected clock", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-2",
      repo: "acme/example-repo",
      pr: 43,
    };
    const { deps, taskPatchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#43": { state: "MERGED", mergedAt: null },
      },
      now: () => "2026-07-15T12:00:00.000Z",
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].fields.mergedAt).toBe("2026-07-15T12:00:00.000Z");
  });

  test("pr_open task whose PR is still open on GitHub is left untouched — no PATCH", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-3",
      repo: "acme/example-repo",
      pr: 44,
    };
    const { deps, taskPatchCalls, patchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#44": { state: "OPEN", mergedAt: null },
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
  });

  test("task with no pr number is resolved via the branch fallback", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-4",
      repo: "acme/example-repo",
      branch: "feat/sw-x-y",
      startedAt: "2026-07-01T00:00:00.000Z",
    };
    const { deps, taskPatchCalls } = makeDeps({
      prOpenTasks: [task],
      branchResults: {
        "acme/example-repo#feat/sw-x-y": [{ number: 55 }],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-4");
    expect(taskPatchCalls[0].fields.status).toBe("merged");
    expect(taskPatchCalls[0].fields.pr).toBe(55);
    expect(taskPatchCalls[0].fields.mergedAt).toBe(FAKE_NOW);
  });

  // ─── bundle-mate guard (BBR-1.1) ─────────────────────────────────────────

  test("BBR-1.1: a pending sibling on a 2-task bundle branch is skipped in the branch-fallback merged path despite a real merged PR on the branch — no status PATCH, no PR-record PATCH, skip logged", async () => {
    const sibling: PrOpenTaskRecord = {
      id: "task-bundle-sibling-merged",
      repo: "acme/example-repo",
      branch: "feat/asa-slack-oauth-ui",
      // startedAt set so this test still exercises the BBR-1.1 headcount
      // guard specifically (RCP-1.1's own startedAt-null skip fires earlier
      // and is covered by its own dedicated test above).
      startedAt: "2026-07-01T00:00:00.000Z",
    };
    const { deps, taskPatchCalls, patchCalls, listAllTasksForBranchCalls } =
      makeDeps({
        prOpenTasks: [sibling],
        branchResults: {
          "acme/example-repo#feat/asa-slack-oauth-ui": [{ number: 501 }],
        },
        tasksForBranch: {
          "acme/example-repo#feat/asa-slack-oauth-ui": [
            { id: "task-bundle-real-work-merged", repo: "acme/example-repo" },
            sibling,
          ],
        },
      });

    const errorSpy: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    try {
      await reconcilePrState(deps);
    } finally {
      console.error = originalConsoleError;
    }

    expect(listAllTasksForBranchCalls).toContain(
      "acme/example-repo#feat/asa-slack-oauth-ui",
    );
    // No status:"merged" PATCH on the sibling task.
    expect(taskPatchCalls).toHaveLength(0);
    // No PR-record PATCH either — guarded before both effects.
    expect(patchCalls).toHaveLength(0);
    expect(
      errorSpy.some((args) =>
        args.some(
          (a) =>
            typeof a === "string" && a.includes("task-bundle-sibling-merged"),
        ),
      ),
    ).toBe(true);
  });

  test("RCP-1.1: a single-task branch (BBR-1.1 headcount guard passes) with task.startedAt null is skipped in the branch-fallback merged path — no PATCH, no ghListMergedPrsForBranch call, distinct skip logged", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-never-started-merged",
      repo: "acme/example-repo",
      branch: "feat/never-started",
      startedAt: null,
    };
    const { deps, taskPatchCalls, patchCalls } = makeDeps({
      prOpenTasks: [task],
      branchResults: {
        "acme/example-repo#feat/never-started": [{ number: 700 }],
      },
      // Deliberately NOT overriding tasksForBranch — makeDeps's default
      // single-element stand-in means the BBR-1.1 headcount guard alone
      // would pass (only one task shares this branch).
    });

    const ghListMergedPrsForBranchCalls: string[] = [];
    const originalGhListMergedPrsForBranch = deps.ghListMergedPrsForBranch;
    deps.ghListMergedPrsForBranch = async (repo: string, branch: string) => {
      ghListMergedPrsForBranchCalls.push(`${repo}#${branch}`);
      return await originalGhListMergedPrsForBranch(repo, branch);
    };

    const errorSpy: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    try {
      await reconcilePrState(deps);
    } finally {
      console.error = originalConsoleError;
    }

    // No GitHub call at all — the startedAt-null check must happen before
    // ghListMergedPrsForBranch is ever invoked.
    expect(ghListMergedPrsForBranchCalls).toHaveLength(0);
    expect(taskPatchCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
    // Distinct from the BBR-1.1 "N tasks share this branch" message — must
    // mention this specific task and that it was never started.
    expect(
      errorSpy.some((args) =>
        args.some(
          (a) =>
            typeof a === "string" &&
            a.includes("task-never-started-merged") &&
            a.includes("startedAt"),
        ),
      ),
    ).toBe(true);
    // Must NOT be the BBR-1.1 bundle-mate message (which mentions "share branch").
    expect(
      errorSpy.some((args) =>
        args.some((a) => typeof a === "string" && a.includes("share branch")),
      ),
    ).toBe(false);
  });

  // ─── RSG-1.2: degraded scope resolution guard ────────────────────────────

  test("RSG-1.2: listAllTasksForBranch signals SCOPE_DEGRADED (still degraded after retry) — branch-fallback merge heal is skipped with a distinct log message, not the 'N tasks share this branch' message", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-degraded-branch-fallback",
      repo: "acme/example-repo",
      branch: "feat/asa-slack-oauth-ui",
      // startedAt set so this test exercises the RSG-1.2 degraded-scope
      // guard specifically (RCP-1.1's own startedAt-null skip fires earlier
      // and is covered by its own dedicated test above).
      startedAt: "2026-07-01T00:00:00.000Z",
    };
    const { deps, taskPatchCalls, patchCalls, listAllTasksForBranchCalls } =
      makeDeps({
        prOpenTasks: [task],
        branchResults: {
          "acme/example-repo#feat/asa-slack-oauth-ui": [{ number: 501 }],
        },
        tasksForBranch: {
          "acme/example-repo#feat/asa-slack-oauth-ui": SCOPE_DEGRADED,
        },
      });

    const errorSpy: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    try {
      await reconcilePrState(deps);
    } finally {
      console.error = originalConsoleError;
    }

    expect(listAllTasksForBranchCalls).toContain(
      "acme/example-repo#feat/asa-slack-oauth-ui",
    );
    // No status:"merged" PATCH and no PR-record PATCH — same effective
    // outcome as the >1-sibling case above.
    expect(taskPatchCalls).toHaveLength(0);
    expect(patchCalls).toHaveLength(0);
    // The skip must be logged, but with a message distinguishable from the
    // existing "N tasks share this branch" wording — this asserts the
    // degraded-scope message mentions the task and does NOT claim a
    // confirmed sibling count via the "share branch" phrasing.
    const degradedLog = errorSpy.find((args) =>
      args.some(
        (a) =>
          typeof a === "string" && a.includes("task-degraded-branch-fallback"),
      ),
    );
    expect(degradedLog).toBeDefined();
    expect(
      degradedLog?.some((a) => typeof a === "string" && /degraded/i.test(a)),
    ).toBe(true);
    expect(
      degradedLog?.some(
        (a) => typeof a === "string" && a.includes("share branch"),
      ),
    ).toBe(false);
  });

  test("RSG-1.2: listAllTasksForBranch recovers on retry (non-degraded, true single-task count) — branch-fallback merge heal proceeds normally", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-recovered-branch-fallback",
      repo: "acme/example-repo",
      branch: "feat/asa-slack-oauth-ui-recovered",
      // startedAt set so this test exercises the RSG-1.2 recovery path
      // specifically, not RCP-1.1's own startedAt-null skip.
      startedAt: "2026-07-01T00:00:00.000Z",
    };
    const { deps, taskPatchCalls, patchCalls } = makeDeps({
      prOpenTasks: [task],
      branchResults: {
        "acme/example-repo#feat/asa-slack-oauth-ui-recovered": [
          { number: 502 },
        ],
      },
      // Only the sibling itself is returned — a real, non-degraded single-task
      // branch (as if the first call had been degraded and a retry recovered
      // to reveal the true count) — the heal must proceed exactly as the
      // pre-existing single-task-stand-in default behaves.
      tasksForBranch: {
        "acme/example-repo#feat/asa-slack-oauth-ui-recovered": [task],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-recovered-branch-fallback");
    expect(taskPatchCalls[0].fields.status).toBe("merged");
    expect(taskPatchCalls[0].fields.pr).toBe(502);
    // PTL-3.1: the pr_open merge pass no longer PATCHes the PullRequest
    // record at all (the taskId backfill is gone with the column).
    expect(patchCalls).toHaveLength(0);
  });

  // ─── RDG-1.1: bundle-mate + startedAt guard on the DIRECT path ───────────

  test("RDG-1.1: a task.pr-set task on a 2-task bundle branch with startedAt null is skipped in the direct path despite GitHub confirming MERGED — no status PATCH, no PR-record PATCH, skip logged", async () => {
    const sibling: PrOpenTaskRecord = {
      id: "task-direct-bundle-sibling",
      repo: "acme/example-repo",
      pr: 601,
      branch: "feat/rdg-bundle-branch",
      startedAt: null,
    };
    const { deps, taskPatchCalls, patchCalls, listAllTasksForBranchCalls } =
      makeDeps({
        prOpenTasks: [sibling],
        ghResults: {
          "acme/example-repo#601": {
            state: "MERGED",
            mergedAt: "2026-07-10T00:00:00.000Z",
          },
        },
        tasksForBranch: {
          "acme/example-repo#feat/rdg-bundle-branch": [
            { id: "task-direct-bundle-real-work", repo: "acme/example-repo" },
            sibling,
          ],
        },
      });

    const errorSpy: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errorSpy.push(args);
    };

    try {
      await reconcilePrState(deps);
    } finally {
      console.error = originalConsoleError;
    }

    expect(listAllTasksForBranchCalls).toContain(
      "acme/example-repo#feat/rdg-bundle-branch",
    );
    // No status:"merged" PATCH on the sibling task.
    expect(taskPatchCalls).toHaveLength(0);
    // No PR-record PATCH either — guarded before both effects.
    expect(patchCalls).toHaveLength(0);
    expect(
      errorSpy.some((args) =>
        args.some(
          (a) =>
            typeof a === "string" && a.includes("task-direct-bundle-sibling"),
        ),
      ),
    ).toBe(true);
  });

  test("RDG-1.1: a task.pr-set task on a 2-task bundle branch with startedAt SET advances to merged as before (direct path)", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-direct-bundle-started",
      repo: "acme/example-repo",
      pr: 602,
      branch: "feat/rdg-bundle-branch-started",
      startedAt: "2026-07-01T00:00:00.000Z",
    };
    const { deps, taskPatchCalls, patchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#602": {
          state: "MERGED",
          mergedAt: "2026-07-10T00:00:00.000Z",
        },
      },
      tasksForBranch: {
        "acme/example-repo#feat/rdg-bundle-branch-started": [
          { id: "task-direct-bundle-real-work-2", repo: "acme/example-repo" },
          task,
        ],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-direct-bundle-started");
    expect(taskPatchCalls[0].fields.status).toBe("merged");
    expect(taskPatchCalls[0].fields.mergedAt).toBe("2026-07-10T00:00:00.000Z");
    // PTL-3.1: the pr_open merge pass no longer PATCHes the PullRequest
    // record at all (the taskId backfill is gone with the column).
    expect(patchCalls).toHaveLength(0);
  });

  test("RDG-1.1 regression guard: a solo-branch task.pr-set task with startedAt null still advances to merged (direct path unchanged for the common case)", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-direct-solo-not-started",
      repo: "acme/example-repo",
      pr: 603,
      branch: "feat/rdg-solo-branch",
      startedAt: null,
    };
    // Deliberately NOT overriding tasksForBranch — makeDeps's default
    // single-element stand-in means this branch has exactly one task-store
    // record sharing it, so the new guard must not fire.
    const { deps, taskPatchCalls, patchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#603": {
          state: "MERGED",
          mergedAt: "2026-07-10T00:00:00.000Z",
        },
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-direct-solo-not-started");
    expect(taskPatchCalls[0].fields.status).toBe("merged");
    // PTL-3.1: the pr_open merge pass no longer PATCHes the PullRequest
    // record at all (the taskId backfill is gone with the column).
    expect(patchCalls).toHaveLength(0);
  });

  test("RDG-1.1 regression guard: a task.pr-set task with no branch set still advances to merged regardless of startedAt (direct path unchanged)", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-direct-no-branch",
      repo: "acme/example-repo",
      pr: 604,
      startedAt: null,
    };
    const { deps, taskPatchCalls, patchCalls, listAllTasksForBranchCalls } =
      makeDeps({
        prOpenTasks: [task],
        ghResults: {
          "acme/example-repo#604": {
            state: "MERGED",
            mergedAt: "2026-07-10T00:00:00.000Z",
          },
        },
      });

    await reconcilePrState(deps);

    // No branch set — listAllTasksForBranch must never be called.
    expect(listAllTasksForBranchCalls).toHaveLength(0);
    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-direct-no-branch");
    expect(taskPatchCalls[0].fields.status).toBe("merged");
    // PTL-3.1: the pr_open merge pass no longer PATCHes the PullRequest
    // record at all (the taskId backfill is gone with the column).
    expect(patchCalls).toHaveLength(0);
  });

  test("task with no pr AND no branch is skipped — no PATCH, no throw", async () => {
    const task: PrOpenTaskRecord = { id: "task-5", repo: "acme/example-repo" };
    const { deps, taskPatchCalls } = makeDeps({ prOpenTasks: [task] });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("PTL-3.1: a confirmed merge advances the task but never PATCHes the PullRequest record (backfill removed)", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-6",
      repo: "acme/example-repo",
      pr: 60,
    };
    const { deps, taskPatchCalls, patchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#60": {
          state: "MERGED",
          mergedAt: "2026-07-10T00:00:00.000Z",
        },
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-6");
    expect(taskPatchCalls[0].fields.status).toBe("merged");
    expect(patchCalls).toHaveLength(0);
  });

  test("a lookup failure for one pr_open task does not abort reconciliation of the others in the batch", async () => {
    const taskA: PrOpenTaskRecord = {
      id: "task-8",
      repo: "acme/example-repo",
      pr: 70,
    };
    const taskB: PrOpenTaskRecord = {
      id: "task-9",
      repo: "acme/example-repo",
      pr: 71,
    };
    const { deps, taskPatchCalls } = makeDeps({
      prOpenTasks: [taskA, taskB],
      ghResults: {
        "acme/example-repo#70": new Error("gh pr view failed: rate limited"),
        "acme/example-repo#71": {
          state: "MERGED",
          mergedAt: "2026-07-10T00:00:00.000Z",
        },
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-9");
  });

  test("task.repo without a slash and no configured repos is skipped defensively — no throw", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-10",
      repo: "example-repo",
      pr: 80,
    };
    const { deps, taskPatchCalls } = makeDeps({
      repos: [],
      prOpenTasks: [task],
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("listPrOpenTasks paginates within a single batch — scans a second page starting at the cursor", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => ({
      id: `task-p1-${i}`,
      repo: "acme/example-repo",
      pr: 100 + i,
    }));
    const page2: PrOpenTaskRecord[] = [
      { id: "task-p2-0", repo: "acme/example-repo", pr: 200 },
    ];
    const ghResults: Record<string, GhPrView> = {};
    for (const t of [...page1, ...page2]) {
      ghResults[`acme/example-repo#${t.pr}`] = {
        state: "OPEN",
        mergedAt: null,
      };
    }

    const { deps, listPrOpenTasksCalls } = makeDeps({
      prOpenTasks: [...page1, ...page2],
      ghResults,
      pageLimit: 2,
    });

    await reconcilePrState(deps);

    // Two pages fetched: offset 0 (full page of 2) then offset 2 (partial page of 1),
    // both starting from cursor 0 — no updatedSince anywhere (RCB-1.1).
    expect(listPrOpenTasksCalls).toHaveLength(2);
    expect(listPrOpenTasksCalls[0]).toEqual({ limit: 2, offset: 0 });
    expect(listPrOpenTasksCalls[1]).toEqual({ limit: 2, offset: 2 });
  });

  // ─── batch + rotating cursor (RCB-1.1) ─────────────────────────────────────

  test("a pr_open list smaller than BATCH_SIZE is fully covered in a single reconcilePrOpenTasks() call — no wraparound", async () => {
    const tasks = Array.from({ length: 3 }, (_, i) => ({
      id: `task-small-${i}`,
      repo: "acme/example-repo",
      pr: 300 + i,
    }));
    const ghResults: Record<string, GhPrView> = {};
    for (const t of tasks) {
      ghResults[`acme/example-repo#${t.pr}`] = {
        state: "OPEN",
        mergedAt: null,
      };
    }
    const { deps, listPrOpenTasksCalls } = makeDeps({
      prOpenTasks: tasks,
      ghResults,
    });

    await reconcilePrOpenTasks(deps);

    // One page (well under both DEFAULT_PAGE_LIMIT=50 and BATCH_SIZE=200) —
    // page shorter than the page limit ends pagination, and since the total
    // fetched (3) is also under BATCH_SIZE, the cursor wraps back to 0.
    expect(listPrOpenTasksCalls).toEqual([{ limit: 50, offset: 0 }]);

    // A second call starts again at offset 0 — confirms the cursor wrapped
    // rather than continuing to advance past the end of the list.
    await reconcilePrOpenTasks(deps);
    expect(listPrOpenTasksCalls).toEqual([
      { limit: 50, offset: 0 },
      { limit: 50, offset: 0 },
    ]);
  });

  test("a pr_open list larger than BATCH_SIZE is split across two reconcilePrOpenTasks() calls — cursor advances by the batch size", async () => {
    const totalTasks = 225; // > RECONCILER_PR_OPEN_TASK_BATCH_SIZE default of 200
    const tasks = Array.from({ length: totalTasks }, (_, i) => ({
      id: `task-big-${i}`,
      repo: "acme/example-repo",
      pr: 1000 + i,
    }));
    const ghResults: Record<string, GhPrView> = {};
    for (const t of tasks) {
      ghResults[`acme/example-repo#${t.pr}`] = {
        state: "OPEN",
        mergedAt: null,
      };
    }
    const { deps, listPrOpenTasksCalls } = makeDeps({
      prOpenTasks: tasks,
      ghResults,
    });

    await reconcilePrOpenTasks(deps);

    // First call fetches exactly BATCH_SIZE=200 tasks, paginated in
    // DEFAULT_PAGE_LIMIT=50 chunks starting at cursor 0: offsets 0/50/100/150.
    expect(listPrOpenTasksCalls).toEqual([
      { limit: 50, offset: 0 },
      { limit: 50, offset: 50 },
      { limit: 50, offset: 100 },
      { limit: 50, offset: 150 },
    ]);

    listPrOpenTasksCalls.length = 0;

    await reconcilePrOpenTasks(deps);

    // Second call picks up where the first left off (cursor now 200), fetching
    // the remaining 25 tasks in a single (partial, < limit) page — batch ends
    // there since the page returned fewer than the page limit.
    expect(listPrOpenTasksCalls).toEqual([{ limit: 50, offset: 200 }]);
  });

  test("cursor wraps to 0 once it passes the end of the list, so the next call restarts from the beginning", async () => {
    const totalTasks = 220; // > BATCH_SIZE (200), so the whole list needs 2 calls
    const tasks = Array.from({ length: totalTasks }, (_, i) => ({
      id: `task-wrap-${i}`,
      repo: "acme/example-repo",
      pr: 2000 + i,
    }));
    const ghResults: Record<string, GhPrView> = {};
    for (const t of tasks) {
      ghResults[`acme/example-repo#${t.pr}`] = {
        state: "OPEN",
        mergedAt: null,
      };
    }
    const { deps, listPrOpenTasksCalls } = makeDeps({
      prOpenTasks: tasks,
      ghResults,
    });

    // 1st call: cursor 0 -> fetches 200 (BATCH_SIZE), cursor advances to 200.
    await reconcilePrOpenTasks(deps);
    listPrOpenTasksCalls.length = 0;

    // 2nd call: cursor 200 -> only 20 tasks remain, a page shorter than the
    // page limit signals end-of-list reached before the batch filled, so the
    // cursor wraps back to 0 for the call after this one.
    await reconcilePrOpenTasks(deps);
    expect(listPrOpenTasksCalls).toEqual([{ limit: 50, offset: 200 }]);
    listPrOpenTasksCalls.length = 0;

    // 3rd call: cursor should have wrapped to 0 — starts over from the
    // beginning of the list instead of requesting an out-of-range offset.
    await reconcilePrOpenTasks(deps);
    expect(listPrOpenTasksCalls[0]).toEqual({ limit: 50, offset: 0 });
  });

  // ─── scope filtering (PSR-1.3) ─────────────────────────────────────────────

  test("a pr_open task whose resolveTaskRepo() is out of scope is skipped with zero gh calls, while an in-scope task in the same batch still reconciles", async () => {
    const taskInScope: PrOpenTaskRecord = {
      id: "task-in-scope",
      repo: "acme/repo-a",
      pr: 1,
    };
    const taskOutOfScope: PrOpenTaskRecord = {
      id: "task-out-of-scope",
      repo: "acme/repo-b",
      pr: 2,
    };
    const ghCalls: string[] = [];
    const { deps, taskPatchCalls, patchCalls } = makeDeps({
      repos: ["acme/repo-a", "acme/repo-b"],
      prOpenTasks: [taskInScope, taskOutOfScope],
      ghResults: {
        "acme/repo-a#1": {
          state: "MERGED",
          mergedAt: "2026-07-14T00:00:00.000Z",
        },
        "acme/repo-b#2": {
          state: "MERGED",
          mergedAt: "2026-07-14T00:00:00.000Z",
        },
      },
      getScopedRepos: () => ["acme/repo-a"],
    });
    const originalGhViewPr = deps.ghViewPr;
    deps.ghViewPr = async (repo: string, prNumber: number) => {
      ghCalls.push(`${repo}#${prNumber}`);
      return await originalGhViewPr(repo, prNumber);
    };

    await reconcilePrState(deps);

    expect(ghCalls).toEqual(["acme/repo-a#1"]);
    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-in-scope");
    expect(patchCalls).toHaveLength(0);
  });
});

// ─── gh-call throttling (PSR-1.2) ──────────────────────────────────────────────

describe("reconcile delay throttling (PSR-1.2)", () => {
  test("reconcilePrState invokes deps.delay once per record, scaling with batch size", async () => {
    const records = Array.from({ length: 25 }, (_, i) =>
      makeRecord({ id: `pr-throttle-${i}`, prNumber: i + 1 }),
    );
    const ghResults: Record<string, GhPrView> = {};
    for (const record of records) {
      ghResults[`acme/example-repo#${record.prNumber}`] = {
        state: "OPEN",
        mergedAt: null,
      };
    }
    const { deps, delayCalls } = makeDeps({
      openRecords: { "acme/example-repo": records },
      ghResults,
    });

    await reconcilePrState(deps);

    // one delay call per record iteration, none skipped or doubled
    expect(delayCalls).toHaveLength(25);
    expect(delayCalls.every((ms) => ms > 0)).toBe(true);
  });

  test("reconcileReviewState invokes deps.delay once per record across both the pending and posted passes", async () => {
    const pending = Array.from({ length: 20 }, (_, i) =>
      makeReviewStateRecord({ id: `pr-pending-${i}`, prNumber: i + 1 }),
    );
    const posted = Array.from({ length: 5 }, (_, i) =>
      makeReviewStateRecord({ id: `pr-posted-${i}`, prNumber: 100 + i }),
    );
    const reviewResults: Record<string, PrReviewData> = {};
    for (const record of [...pending, ...posted]) {
      reviewResults[`acme/example-repo#${record.prNumber}`] = makeReviewData({
        headRefOid: "head-sha",
        reviews: {
          nodes: [
            makeReviewNode({ state: "COMMENTED", commit: { oid: "head-sha" } }),
          ],
        },
        reviewThreads: { nodes: [makeReviewThread({ isResolved: true })] },
      });
    }
    const { deps, delayCalls } = makeReviewStateDeps({
      pendingRecords: { "acme/example-repo": pending },
      postedRecords: { "acme/example-repo": posted },
      reviewResults,
    });

    await reconcileReviewState(deps);

    // 20 from the pending-scan pass + 5 from the posted-scan pass
    expect(delayCalls).toHaveLength(25);
  });
});

// ─── updatedSince filtering (PSR-1.1) ───────────────────────────────────────────

describe("buildProductionDeps — updatedSince filtering (PSR-1.1)", () => {
  /**
   * Fake fetchFn for GET /prs?... that records every request's full query
   * params, mirroring `makeFakeTaskStoreFetch`'s pattern above but for the
   * PR-record list endpoint instead of /tasks.
   */
  function makeFakePrsFetch(): {
    fetchFn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    calls: Array<Record<string, string>>;
  } {
    const calls: Array<Record<string, string>> = [];
    const fetchFn = async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      calls.push(Object.fromEntries(parsed.searchParams.entries()));
      return new Response(
        JSON.stringify({ prs: [], total: 0, limit: 50, offset: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    return { fetchFn, calls };
  }

  /** Same GET /tasks fake as the TCR-1.2 suite above, but records full params (including updatedSince). */
  function makeFakeTasksFetch(): {
    fetchFn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    calls: Array<Record<string, string>>;
  } {
    const calls: Array<Record<string, string>> = [];
    const fetchFn = async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      calls.push(Object.fromEntries(parsed.searchParams.entries()));
      return new Response(JSON.stringify({ tasks: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    return { fetchFn, calls };
  }

  const savedTaskStoreEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_URL =
      process.env.SHIPWRIGHT_TASK_STORE_URL;
    savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_TOKEN =
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://task-store.example.test";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "fake-token";
  });

  afterEach(() => {
    if (savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_URL === undefined) {
      // biome-ignore lint/performance/noDelete: restore to fully-unset state
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    } else {
      process.env.SHIPWRIGHT_TASK_STORE_URL =
        savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_TOKEN === undefined) {
      // biome-ignore lint/performance/noDelete: restore to fully-unset state
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    } else {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN =
        savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("listOpenPrRecords passes updatedSince computed as now-6h via the injected now()", async () => {
    const { fetchFn, calls } = makeFakePrsFetch();
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });
    // Override the injected now() with a fixed, deterministic value — matches
    // this suite's "never Date.now()/new Date() directly" isolation contract.
    (deps as { now: () => string }).now = () => "2026-07-19T23:00:00.000Z";

    const updatedSince = new Date(
      new Date(deps.now()).getTime() - 6 * 60 * 60 * 1000,
    ).toISOString();
    await deps.listOpenPrRecords("acme/example-repo", 50, 0, updatedSince);

    expect(calls).toHaveLength(1);
    expect(calls[0].updatedSince).toBe("2026-07-19T17:00:00.000Z");
  });

  test("listTasksByStatus (backing listPrOpenTasks) never sends an updatedSince param (RCB-1.1)", async () => {
    const { fetchFn, calls } = makeFakeTasksFetch();
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });

    await deps.listPrOpenTasks(50, 0);

    expect(calls.length).toBeGreaterThanOrEqual(1); // pr_open
    for (const call of calls) {
      expect(call.updatedSince).toBeUndefined();
    }
  });
});

describe("buildReviewStateProductionDeps — updatedSince filtering (PSR-1.1)", () => {
  function makeFakePrsFetch(): {
    fetchFn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    calls: Array<Record<string, string>>;
  } {
    const calls: Array<Record<string, string>> = [];
    const fetchFn = async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      calls.push(Object.fromEntries(parsed.searchParams.entries()));
      return new Response(
        JSON.stringify({ prs: [], total: 0, limit: 50, offset: 0 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    return { fetchFn, calls };
  }

  const savedTaskStoreEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_URL =
      process.env.SHIPWRIGHT_TASK_STORE_URL;
    savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_TOKEN =
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    process.env.SHIPWRIGHT_TASK_STORE_URL = "https://task-store.example.test";
    process.env.SHIPWRIGHT_TASK_STORE_TOKEN = "fake-token";
  });

  afterEach(() => {
    if (savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_URL === undefined) {
      // biome-ignore lint/performance/noDelete: restore to fully-unset state
      delete process.env.SHIPWRIGHT_TASK_STORE_URL;
    } else {
      process.env.SHIPWRIGHT_TASK_STORE_URL =
        savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_URL;
    }
    if (savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_TOKEN === undefined) {
      // biome-ignore lint/performance/noDelete: restore to fully-unset state
      delete process.env.SHIPWRIGHT_TASK_STORE_TOKEN;
    } else {
      process.env.SHIPWRIGHT_TASK_STORE_TOKEN =
        savedTaskStoreEnv.SHIPWRIGHT_TASK_STORE_TOKEN;
    }
  });

  test("listPendingReviewRecords passes updatedSince computed as now-6h via the injected clock", async () => {
    const { fetchFn, calls } = makeFakePrsFetch();
    const clock = FixedClock(new Date("2026-07-19T23:00:00.000Z"));
    const deps = buildReviewStateProductionDeps({
      ghGraphql: <T>() => Promise.resolve({}) as Promise<T>,
      fetchFn,
      clock,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });
    const updatedSince = new Date(
      clock.now().getTime() - 6 * 60 * 60 * 1000,
    ).toISOString();

    await deps.listPendingReviewRecords(
      "acme/example-repo",
      50,
      0,
      updatedSince,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].updatedSince).toBe("2026-07-19T17:00:00.000Z");
    expect(calls[0].reviewState).toBe("pending");
  });

  test("listPostedReviewRecords does NOT receive an updatedSince param — CHU-2.4's healing pass must scan records regardless of age", async () => {
    const { fetchFn, calls } = makeFakePrsFetch();
    const clock = FixedClock(new Date("2026-07-19T23:00:00.000Z"));
    const deps = buildReviewStateProductionDeps({
      ghGraphql: <T>() => Promise.resolve({}) as Promise<T>,
      fetchFn,
      clock,
      getScopedRepos: () => [],
      workspacePath: "/nonexistent/workspace-for-unit-test",
    });

    await deps.listPostedReviewRecords("acme/example-repo", 50, 0);

    expect(calls).toHaveLength(1);
    expect(calls[0].updatedSince).toBeUndefined();
    expect(calls[0].reviewState).toBe("posted");
  });
});

// ─── isWorktreeStale (WTR-1.4) ─────────────────────────────────────────────────

describe("isWorktreeStale", () => {
  let tmpDir: string;
  let worktreePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "worktree-staleness-test-"));
    worktreePath = join(tmpDir, "example-repo-feat-some-branch");
    mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns true when the directory does not exist — nothing to protect", () => {
    const missingPath = join(tmpDir, "does-not-exist");
    expect(isWorktreeStale(missingPath, 14)).toBe(true);
  });

  test("returns false for a freshly-modified directory (well within the threshold)", () => {
    const now = new Date();
    utimesSync(worktreePath, now, now);
    expect(isWorktreeStale(worktreePath, 14)).toBe(false);
  });

  test("returns true for a directory modified well before the threshold", () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(worktreePath, twentyDaysAgo, twentyDaysAgo);
    expect(isWorktreeStale(worktreePath, 14)).toBe(true);
  });

  test("returns false for a directory modified just under the threshold", () => {
    const justUnderThreshold = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);
    utimesSync(worktreePath, justUnderThreshold, justUnderThreshold);
    expect(isWorktreeStale(worktreePath, 14)).toBe(false);
  });

  test("returns true for a directory modified just over the threshold", () => {
    const justOverThreshold = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    utimesSync(worktreePath, justOverThreshold, justOverThreshold);
    expect(isWorktreeStale(worktreePath, 14)).toBe(true);
  });

  test("cleanupAfterDays of 0 treats any existing directory as immediately stale", () => {
    const now = new Date();
    utimesSync(worktreePath, now, now);
    expect(isWorktreeStale(worktreePath, 0)).toBe(true);
  });
});

// ─── buildProductionDeps().removeWorktree staleness gate (WTR-1.4) ─────────────

describe("buildProductionDeps — removeWorktree staleness gate (WTR-1.4)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.SHIPWRIGHT_WORKTREE_DIR = process.env.SHIPWRIGHT_WORKTREE_DIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  /**
   * Sets up a fake workspace with `state/agent-policy.md` (configuring
   * `cleanup_after_days`), a `repos/<shortRepo>` git repo, and a
   * `worktrees/<shortRepo>-<branchSlug>` directory registered as a real git
   * worktree of that repo — so `deps.removeWorktree()` exercises the actual
   * `git worktree remove --force` invocation end-to-end when the staleness
   * gate allows it through.
   */
  function setupFakeWorkspace(opts: { cleanupAfterDays: number }): {
    workspacePath: string;
    shortRepo: string;
    worktreeDirName: string;
    worktreePath: string;
  } {
    const workspacePath = mkdtempSync(
      join(tmpdir(), "removeworktree-staleness-test-"),
    );
    mkdirSync(join(workspacePath, "state"), { recursive: true });
    writeFileSync(
      join(workspacePath, "state", "agent-policy.md"),
      `**cleanup_after_days**: ${opts.cleanupAfterDays}`,
    );

    const shortRepo = "example-repo";
    const repoPath = join(workspacePath, "repos", shortRepo);
    mkdirSync(repoPath, { recursive: true });
    Bun.spawnSync(["git", "init", "--quiet"], { cwd: repoPath });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], {
      cwd: repoPath,
    });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: repoPath });
    writeFileSync(join(repoPath, "README.md"), "hello\n");
    Bun.spawnSync(["git", "add", "README.md"], { cwd: repoPath });
    Bun.spawnSync(["git", "commit", "--quiet", "-m", "init"], {
      cwd: repoPath,
    });

    const worktreeDirName = `${shortRepo}-feat-some-branch`;
    const worktreeRoot = join(workspacePath, "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    const worktreePath = join(worktreeRoot, worktreeDirName);
    const addResult = Bun.spawnSync(
      ["git", "worktree", "add", worktreePath, "-b", "feat/some-branch"],
      { cwd: repoPath },
    );
    if (addResult.exitCode !== 0) {
      throw new Error(
        `git worktree add failed in test setup: ${addResult.stderr.toString()}`,
      );
    }

    return { workspacePath, shortRepo, worktreeDirName, worktreePath };
  }

  test("fresh worktree (mtime within cleanup_after_days) is skipped, not removed", async () => {
    const { workspacePath, shortRepo, worktreeDirName, worktreePath } =
      setupFakeWorkspace({ cleanupAfterDays: 14 });
    // biome-ignore lint/performance/noDelete: ensure no leftover override from a prior test
    delete process.env.SHIPWRIGHT_WORKTREE_DIR;
    const now = new Date();
    utimesSync(worktreePath, now, now);

    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      getScopedRepos: () => [],
      workspacePath,
    });

    await deps.removeWorktree(shortRepo, worktreeDirName);

    // Still present — the staleness gate skipped the actual removal.
    expect(existsSync(worktreePath)).toBe(true);

    rmSync(workspacePath, { recursive: true, force: true });
  });

  test("stale worktree (mtime older than cleanup_after_days) is force-removed", async () => {
    const { workspacePath, shortRepo, worktreeDirName, worktreePath } =
      setupFakeWorkspace({ cleanupAfterDays: 14 });
    // biome-ignore lint/performance/noDelete: ensure no leftover override from a prior test
    delete process.env.SHIPWRIGHT_WORKTREE_DIR;
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(worktreePath, twentyDaysAgo, twentyDaysAgo);

    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      getScopedRepos: () => [],
      workspacePath,
    });

    await deps.removeWorktree(shortRepo, worktreeDirName);

    // Removed by git worktree remove --force.
    expect(existsSync(worktreePath)).toBe(false);

    rmSync(workspacePath, { recursive: true, force: true });
  });
});

// ─── RCO-1.5: per-pass summary logging ─────────────────────────────────────

/**
 * Captures console.log calls for the duration of `fn`, restoring the
 * original afterward (including on throw) — mirrors this file's existing
 * console.error-capture pattern used throughout (see e.g. the RCP-1.1/RSG-1.2
 * tests above), just for console.log instead, since the summary line is
 * logged via console.log (a normal-operation summary, not a failure).
 */
async function captureConsoleLog(fn: () => Promise<void>): Promise<string[][]> {
  const logSpy: string[][] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logSpy.push(args.map((a) => (typeof a === "string" ? a : String(a))));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logSpy;
}

/** Finds the captured summary log line matching `prefix` + `label` (e.g. `"[pr-state-reconciler]"` + `"pass summary"`). */
function findSummaryLine(
  logs: string[][],
  prefix: string,
  label: string,
): string[] | undefined {
  return logs.find((args) =>
    args.some((a) => a.includes(prefix) && a.includes(label)),
  );
}

describe("reconcilePrState — per-pass summary logging (RCO-1.5)", () => {
  test("mixed outcomes (patched, no-op, per-record error) — one summary line with correct counts", async () => {
    const patchedRecord = makeRecord({ id: "pr-patched", prNumber: 1 });
    const noopRecord = makeRecord({ id: "pr-noop", prNumber: 2 });
    const erroredRecord = makeRecord({ id: "pr-erroring", prNumber: 3 });
    const { deps } = makeDeps({
      openRecords: {
        "acme/example-repo": [patchedRecord, noopRecord, erroredRecord],
      },
      ghResults: {
        "acme/example-repo#1": {
          state: "MERGED",
          mergedAt: "2026-07-14T00:00:00.000Z",
        },
        "acme/example-repo#2": { state: "OPEN", mergedAt: null },
        "acme/example-repo#3": new Error("gh lookup failed"),
      },
    });

    const errOriginal = console.error;
    console.error = () => {};
    let logs: string[][];
    try {
      logs = await captureConsoleLog(() => reconcilePrState(deps));
    } finally {
      console.error = errOriginal;
    }

    const summaryLine = findSummaryLine(
      logs,
      "[pr-state-reconciler]",
      "pass summary",
    );
    expect(summaryLine).toBeDefined();
    const text = summaryLine?.join(" ") ?? "";
    expect(text).toContain("evaluated=3");
    expect(text).toContain("patched=1");
    expect(text).toContain("skippedClaimed=0");
    expect(text).toContain("errored=1");
  });

  test("zero records found — summary line still emitted with all-zero counts", async () => {
    const { deps } = makeDeps({ openRecords: {} });

    const logs = await captureConsoleLog(() => reconcilePrState(deps));

    const summaryLine = findSummaryLine(
      logs,
      "[pr-state-reconciler]",
      "pass summary",
    );
    expect(summaryLine).toBeDefined();
    const text = summaryLine?.join(" ") ?? "";
    expect(text).toContain("evaluated=0");
    expect(text).toContain("patched=0");
    expect(text).toContain("skippedClaimed=0");
    expect(text).toContain("errored=0");
  });

  test("every repo's list call fails — summary line reflects zero-evaluated with the failure counted into errored", async () => {
    const { deps } = makeDeps({
      repos: ["acme/repo-a", "acme/repo-b"],
      getScopedRepos: () => ["acme/repo-a", "acme/repo-b"],
    });
    deps.listOpenPrRecords = async () => {
      throw new Error("task-store unreachable");
    };

    const errOriginal = console.error;
    console.error = () => {};
    let logs: string[][];
    try {
      logs = await captureConsoleLog(() => reconcilePrState(deps));
    } finally {
      console.error = errOriginal;
    }

    const summaryLine = findSummaryLine(
      logs,
      "[pr-state-reconciler]",
      "pass summary",
    );
    expect(summaryLine).toBeDefined();
    const text = summaryLine?.join(" ") ?? "";
    expect(text).toContain("evaluated=0");
    expect(text).toContain("patched=0");
    expect(text).toContain("errored=2");
  });
});

describe("reconcileReviewState — per-pass summary logging (RCO-1.5)", () => {
  test("pending scan: mixed outcomes (patched, skipped-claimed, errored) get their own summary line", async () => {
    const clock = FixedClock(new Date("2026-07-15T12:00:00.000Z"));
    const patchedRecord = makeReviewStateRecord({
      id: "pr-pending-patched",
      prNumber: 1,
    });
    const claimedRecord = makeReviewStateRecord({
      id: "pr-pending-claimed",
      prNumber: 2,
      claimedBy: "some-agent",
      heartbeatAt: "2026-07-15T11:55:00.000Z", // fresh — within TTL
    });
    const erroredRecord = makeReviewStateRecord({
      id: "pr-pending-erroring",
      prNumber: 3,
    });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "LGTM",
          }),
        ],
      },
    });
    const { deps } = makeReviewStateDeps({
      pendingRecords: {
        "acme/example-repo": [patchedRecord, claimedRecord, erroredRecord],
      },
      reviewResults: {
        "acme/example-repo#1": reviewData,
        "acme/example-repo#3": new Error("gh fetch failed"),
      },
      clock,
    });

    const errOriginal = console.error;
    console.error = () => {};
    let logs: string[][];
    try {
      logs = await captureConsoleLog(() => reconcileReviewState(deps));
    } finally {
      console.error = errOriginal;
    }

    const summaryLine = findSummaryLine(
      logs,
      "[pr-state-reconciler:review]",
      "pending scan summary",
    );
    expect(summaryLine).toBeDefined();
    const text = summaryLine?.join(" ") ?? "";
    expect(text).toContain("evaluated=3");
    expect(text).toContain("patched=1");
    expect(text).toContain("skippedClaimed=1");
    expect(text).toContain("errored=1");
  });

  test("posted scan: mixed outcomes (patched, skipped-claimed, errored) get their own summary line, distinct from the pending scan's", async () => {
    const clock = FixedClock(new Date("2026-07-15T12:00:00.000Z"));
    const patchedRecord = makeReviewStateRecord({
      id: "pr-posted-patched",
      prNumber: 1814,
    });
    const claimedRecord = makeReviewStateRecord({
      id: "pr-posted-claimed",
      prNumber: 1818,
      claimedBy: "some-agent",
      heartbeatAt: "2026-07-15T11:55:00.000Z", // fresh — within TTL
    });
    const erroredRecord = makeReviewStateRecord({
      id: "pr-posted-erroring",
      prNumber: 1819,
    });
    // Stale-commit-only review — nothing at current head — heals to pending.
    const staleReviewData = makeReviewData({
      headRefOid: "new-head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "CHANGES_REQUESTED",
            commit: { oid: "stale-sha" },
            body: "Please fix.",
          }),
        ],
      },
    });
    const { deps } = makeReviewStateDeps({
      postedRecords: {
        "acme/example-repo": [patchedRecord, claimedRecord, erroredRecord],
      },
      reviewResults: {
        "acme/example-repo#1814": staleReviewData,
        "acme/example-repo#1819": new Error("gh fetch failed"),
      },
      clock,
    });

    const errOriginal = console.error;
    console.error = () => {};
    let logs: string[][];
    try {
      logs = await captureConsoleLog(() => reconcileReviewState(deps));
    } finally {
      console.error = errOriginal;
    }

    const summaryLine = findSummaryLine(
      logs,
      "[pr-state-reconciler:review]",
      "posted scan summary",
    );
    expect(summaryLine).toBeDefined();
    const text = summaryLine?.join(" ") ?? "";
    expect(text).toContain("evaluated=3");
    expect(text).toContain("patched=1");
    expect(text).toContain("skippedClaimed=1");
    expect(text).toContain("errored=1");

    // The pending scan's own (separate) summary line must also be present,
    // scoped to zero records (no pendingRecords configured in this test).
    const pendingSummary = findSummaryLine(
      logs,
      "[pr-state-reconciler:review]",
      "pending scan summary",
    );
    expect(pendingSummary).toBeDefined();
    const pendingText = pendingSummary?.join(" ") ?? "";
    expect(pendingText).toContain("evaluated=0");
  });

  test("zero records in both scans — both summary lines still emitted with all-zero counts", async () => {
    const { deps } = makeReviewStateDeps({
      pendingRecords: {},
      postedRecords: {},
    });

    const logs = await captureConsoleLog(() => reconcileReviewState(deps));

    const pendingSummary = findSummaryLine(
      logs,
      "[pr-state-reconciler:review]",
      "pending scan summary",
    );
    const postedSummary = findSummaryLine(
      logs,
      "[pr-state-reconciler:review]",
      "posted scan summary",
    );
    expect(pendingSummary).toBeDefined();
    expect(postedSummary).toBeDefined();
    for (const summary of [pendingSummary, postedSummary]) {
      const text = summary?.join(" ") ?? "";
      expect(text).toContain("evaluated=0");
      expect(text).toContain("patched=0");
      expect(text).toContain("skippedClaimed=0");
      expect(text).toContain("errored=0");
    }
  });

  test("every repo's list call fails in both scans — summary lines reflect zero-evaluated with the failures counted into errored", async () => {
    const { deps } = makeReviewStateDeps({
      repos: ["acme/repo-a", "acme/repo-b"],
      getScopedRepos: () => ["acme/repo-a", "acme/repo-b"],
    });
    deps.listPendingReviewRecords = async () => {
      throw new Error("task-store unreachable");
    };
    deps.listPostedReviewRecords = async () => {
      throw new Error("task-store unreachable");
    };

    const errOriginal = console.error;
    console.error = () => {};
    let logs: string[][];
    try {
      logs = await captureConsoleLog(() => reconcileReviewState(deps));
    } finally {
      console.error = errOriginal;
    }

    const pendingSummary = findSummaryLine(
      logs,
      "[pr-state-reconciler:review]",
      "pending scan summary",
    );
    const postedSummary = findSummaryLine(
      logs,
      "[pr-state-reconciler:review]",
      "posted scan summary",
    );
    expect(pendingSummary).toBeDefined();
    expect(postedSummary).toBeDefined();
    for (const summary of [pendingSummary, postedSummary]) {
      const text = summary?.join(" ") ?? "";
      expect(text).toContain("evaluated=0");
      expect(text).toContain("patched=0");
      expect(text).toContain("errored=2");
    }
  });
});
