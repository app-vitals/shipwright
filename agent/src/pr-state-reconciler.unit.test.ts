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
import type { PrReviewData, ReviewNode, ReviewThread } from "./check-patch.ts";
import { type Clock, FixedClock } from "./clock.ts";
import {
  type GhPrView,
  type PrOpenTaskRecord,
  type PrReviewStateReconcilerDeps,
  type PrReviewStateRecord,
  type PrStateReconcilerDeps,
  type PrStateRecord,
  buildProductionDeps,
  buildReviewStateProductionDeps,
  reconcileDeployingTasks,
  reconcilePrState,
  reconcileReviewState,
} from "./pr-state-reconciler.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface ListPrsCall {
  repo: string;
  state: string;
  limit: number;
  offset: number;
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
  /** "repo#prNumber" -> existing task-store PullRequest record, for the taskId backfill lookup. */
  prRecords?: Record<string, PrStateRecord>;
  now?: () => string;
  /** Defaults to `() => repos` so every existing test keeps passing unchanged. */
  getScopedRepos?: () => string[];
  /** orphan-candidate (pending/in_progress, branch set, no pr linked) tasks for the TCR-1.2 pass; defaults to [] so existing tests are unaffected. */
  orphanCandidateTasks?: PrOpenTaskRecord[];
  /** "repo#branch" -> open-PR-list result, or an Error to throw, for the TCR-1.2 orphan pass. */
  openBranchResults?: Record<
    string,
    Array<{ number: number; createdAt: string }> | Error
  >;
  /** deploying tasks for the DSR-2.1 pass; defaults to [] so existing tests are unaffected. */
  deployingTasks?: PrOpenTaskRecord[];
  /** repo -> newest-first "Promote to Prod" workflow runs, or an Error to throw, for the DSR-2.1 pass. */
  workflowRunsResults?: Record<
    string,
    Array<{ createdAt: string; conclusion: string | null; id: number }> | Error
  >;
}

function makeDeps({
  repos = ["acme/example-repo"],
  openRecords = {},
  ghResults = {},
  pageLimit = 50,
  prOpenTasks = [],
  branchResults = {},
  prRecords = {},
  now = () => FAKE_NOW,
  getScopedRepos = () => repos,
  orphanCandidateTasks = [],
  openBranchResults = {},
  deployingTasks = [],
  workflowRunsResults = {},
}: MakeDepsOptions = {}): {
  deps: PrStateReconcilerDeps;
  listCalls: ListPrsCall[];
  patchCalls: PatchCall[];
  taskPatchCalls: PatchCall[];
  listPrOpenTasksCalls: ListTasksCall[];
  listDeployingTasksCalls: ListTasksCall[];
} {
  const listCalls: ListPrsCall[] = [];
  const patchCalls: PatchCall[] = [];
  const taskPatchCalls: PatchCall[] = [];
  const listPrOpenTasksCalls: ListTasksCall[] = [];
  const listDeployingTasksCalls: ListTasksCall[] = [];

  const deps: PrStateReconcilerDeps = {
    repos,
    getScopedRepos,
    pageLimit,
    listOpenPrRecords: async (repo: string, limit: number, offset: number) => {
      listCalls.push({ repo, state: "open", limit, offset });
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
    findPrRecordByRepoAndPrNumber: async (repo: string, prNumber: number) => {
      const key = `${repo}#${prNumber}`;
      return prRecords[key] ?? null;
    },
    now,
    listOrphanCandidateTasks: async () => orphanCandidateTasks,
    ghListOpenPrsForBranch: async (repo: string, branch: string) => {
      const key = `${repo}#${branch}`;
      const result = openBranchResults[key];
      if (result instanceof Error) throw result;
      return result ?? [];
    },
    listDeployingTasks: async (limit: number, offset: number) => {
      listDeployingTasksCalls.push({ limit, offset });
      return deployingTasks.slice(offset, offset + limit);
    },
    ghListWorkflowRuns: async (
      repo: string,
      _workflow: string,
      _limit: number,
    ) => {
      const result = workflowRunsResults[repo];
      if (result instanceof Error) throw result;
      return result ?? [];
    },
  };

  return {
    deps,
    listCalls,
    patchCalls,
    taskPatchCalls,
    listPrOpenTasksCalls,
    listDeployingTasksCalls,
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
}

interface ReviewPatchCall {
  id: string;
  fields: Record<string, unknown>;
}

interface MakeReviewStateDepsOptions {
  repos?: string[];
  /** repo -> full page of reviewState:"pending" records (pagination simulated by slicing). */
  pendingRecords?: Record<string, PrReviewStateRecord[]>;
  /** "repo#prNumber" -> review data, or an Error to throw for that fetch. */
  reviewResults?: Record<string, PrReviewData | Error>;
  pageLimit?: number;
  clock?: Clock;
  claimTtlMs?: number;
}

function makeReviewStateDeps({
  repos = ["acme/example-repo"],
  pendingRecords = {},
  reviewResults = {},
  pageLimit = 50,
  clock = FixedClock(new Date("2026-07-15T12:00:00.000Z")),
  claimTtlMs,
}: MakeReviewStateDepsOptions = {}): {
  deps: PrReviewStateReconcilerDeps;
  listCalls: ListReviewCall[];
  patchCalls: ReviewPatchCall[];
  fetchCalls: string[];
} {
  const listCalls: ListReviewCall[] = [];
  const patchCalls: ReviewPatchCall[] = [];
  const fetchCalls: string[] = [];

  const deps: PrReviewStateReconcilerDeps = {
    repos,
    pageLimit,
    clock,
    ...(claimTtlMs !== undefined ? { claimTtlMs } : {}),
    listPendingReviewRecords: async (
      repo: string,
      limit: number,
      offset: number,
    ) => {
      listCalls.push({ repo, limit, offset });
      const all = pendingRecords[repo] ?? [];
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
  };

  return { deps, listCalls, patchCalls, fetchCalls };
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
      // 5 minutes ago — well within the default 35-minute TTL.
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
      // 40 minutes ago — beyond the default 35-minute TTL.
      heartbeatAt: "2026-07-15T11:20:00.000Z",
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
});

// ─── buildReviewStateProductionDeps ─────────────────────────────────────────────

describe("buildReviewStateProductionDeps", () => {
  const savedEnv = {
    WORKSPACE_PATH: process.env.WORKSPACE_PATH,
    SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS:
      process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS,
  };

  beforeEach(() => {
    // A nonexistent workspace path is fine — resolveAllRepos() just returns
    // [] when workspace/repos/ doesn't exist, and this suite only cares
    // about the claimTtlMs field.
    process.env.WORKSPACE_PATH = "/nonexistent/workspace-for-unit-test";
    // biome-ignore lint/performance/noDelete: env var must be fully removed, not set to "undefined" string
    delete process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS;
  });

  afterEach(() => {
    if (savedEnv.WORKSPACE_PATH === undefined) {
      // biome-ignore lint/performance/noDelete: restore to fully-unset state
      delete process.env.WORKSPACE_PATH;
    } else {
      process.env.WORKSPACE_PATH = savedEnv.WORKSPACE_PATH;
    }
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
    });

    expect(deps.claimTtlMs).toBe(2_100_000);
  });

  test("claimTtlMs reads SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS when set, matching stale-claim-reaper.ts", () => {
    process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS = "60000";

    const deps = buildReviewStateProductionDeps({
      ghGraphql: <T>() => Promise.resolve({}) as Promise<T>,
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
   */
  function makeFakeTaskStoreFetch(opts: {
    tasksByStatus: Record<string, PrOpenTaskRecord[]>;
  }): {
    fetchFn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    calls: Array<{ status: string; limit: number; offset: number }>;
  } {
    const calls: Array<{ status: string; limit: number; offset: number }> = [];
    const fetchFn = async (url: RequestInfo | URL) => {
      const parsed = new URL(String(url));
      const status = parsed.searchParams.get("status") ?? "";
      const limit = Number(parsed.searchParams.get("limit"));
      const offset = Number(parsed.searchParams.get("offset"));
      calls.push({ status, limit, offset });
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

  test("listPrOpenTasks issues a single GET when under the page limit", async () => {
    const tasks = [{ id: "t1", repo: "acme/example-repo", pr: 1 }];
    const { fetchFn, calls } = makeFakeTaskStoreFetch({
      tasksByStatus: { pr_open: tasks },
    });
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
    });

    const result = await deps.listPrOpenTasks(50, 0);

    expect(result).toEqual(tasks);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ status: "pr_open", limit: 50, offset: 0 });
  });

  test("listOrphanCandidateTasks pages past the default 50-row task-store page for both statuses (regression: previously silently truncated at 50)", async () => {
    // 62 pending + 55 in_progress tasks, all orphan candidates (branch set,
    // no pr linked) — mirrors the live truncation this finding reported
    // (GET /tasks?status=pending had total: 62, but returned only 50).
    const pending = Array.from({ length: 62 }, (_, i) => ({
      id: `pending-${i}`,
      repo: "acme/example-repo",
      branch: `feat/pending-${i}`,
    }));
    const inProgress = Array.from({ length: 55 }, (_, i) => ({
      id: `in-progress-${i}`,
      repo: "acme/example-repo",
      branch: `feat/in-progress-${i}`,
    }));
    const { fetchFn, calls } = makeFakeTaskStoreFetch({
      tasksByStatus: { pending, in_progress: inProgress },
    });
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
    });

    const result = await deps.listOrphanCandidateTasks();

    // All 117 orphan candidates returned — not truncated at 50.
    expect(result).toHaveLength(117);
    expect(result.map((t) => t.id)).toEqual([
      ...pending.map((t) => t.id),
      ...inProgress.map((t) => t.id),
    ]);

    // "pending" paged across 2 requests (50 + 12), "in_progress" across 2 (50 + 5).
    const pendingCalls = calls.filter((c) => c.status === "pending");
    const inProgressCalls = calls.filter((c) => c.status === "in_progress");
    expect(pendingCalls).toEqual([
      { status: "pending", limit: 50, offset: 0 },
      { status: "pending", limit: 50, offset: 50 },
    ]);
    expect(inProgressCalls).toEqual([
      { status: "in_progress", limit: 50, offset: 0 },
      { status: "in_progress", limit: 50, offset: 50 },
    ]);
  });

  test("listOrphanCandidateTasks still filters out tasks with no branch or an existing pr across paginated pages", async () => {
    const pending = [
      { id: "keep-1", repo: "acme/example-repo", branch: "feat/keep-1" },
      { id: "no-branch", repo: "acme/example-repo" },
      {
        id: "has-pr",
        repo: "acme/example-repo",
        branch: "feat/has-pr",
        pr: 5,
      },
    ];
    const { fetchFn } = makeFakeTaskStoreFetch({
      tasksByStatus: { pending, in_progress: [] },
    });
    const deps = buildProductionDeps({
      ghJson: () => Promise.reject(new Error("not used in this test")),
      fetchFn,
      getScopedRepos: () => [],
    });

    const result = await deps.listOrphanCandidateTasks();

    expect(result.map((t) => t.id)).toEqual(["keep-1"]);
  });
});

describe("reconcilePrState — pr_open task reconciliation pass", () => {
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

  test("task with no pr AND no branch is skipped — no PATCH, no throw", async () => {
    const task: PrOpenTaskRecord = { id: "task-5", repo: "acme/example-repo" };
    const { deps, taskPatchCalls } = makeDeps({ prOpenTasks: [task] });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("taskId is backfilled on the matching PR record when it is currently null", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-6",
      repo: "acme/example-repo",
      pr: 60,
    };
    const { deps, patchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#60": {
          state: "MERGED",
          mergedAt: "2026-07-10T00:00:00.000Z",
        },
      },
      prRecords: {
        "acme/example-repo#60": {
          id: "pr-record-60",
          repo: "acme/example-repo",
          prNumber: 60,
          state: "open",
          taskId: null,
        },
      },
    });

    await reconcilePrState(deps);

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].id).toBe("pr-record-60");
    expect(patchCalls[0].fields).toEqual({ taskId: "task-6" });
  });

  test("taskId is left untouched when the PR record already has one set", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-7",
      repo: "acme/example-repo",
      pr: 61,
    };
    const { deps, patchCalls } = makeDeps({
      prOpenTasks: [task],
      ghResults: {
        "acme/example-repo#61": {
          state: "MERGED",
          mergedAt: "2026-07-10T00:00:00.000Z",
        },
      },
      prRecords: {
        "acme/example-repo#61": {
          id: "pr-record-61",
          repo: "acme/example-repo",
          prNumber: 61,
          state: "open",
          taskId: "some-other-task",
        },
      },
    });

    await reconcilePrState(deps);

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

  test("listPrOpenTasks paginates beyond the default page limit — scans a second page", async () => {
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

    // Two pages fetched: offset 0 (full page of 2) then offset 2 (partial page of 1)
    expect(listPrOpenTasksCalls).toHaveLength(2);
    expect(listPrOpenTasksCalls[0]).toEqual({ limit: 2, offset: 0 });
    expect(listPrOpenTasksCalls[1]).toEqual({ limit: 2, offset: 2 });
  });
});

describe("reconcilePrState — orphaned pending/in_progress task reconciliation pass", () => {
  test("orphaned pending task with a real open PR on its branch self-heals to pr_open", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-orphan-1",
      repo: "acme/example-repo",
      branch: "feat/tcr-1-2-orphan",
    };
    const { deps, taskPatchCalls } = makeDeps({
      orphanCandidateTasks: [task],
      openBranchResults: {
        "acme/example-repo#feat/tcr-1-2-orphan": [
          { number: 99, createdAt: "2026-07-16T00:00:00.000Z" },
        ],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-orphan-1");
    expect(taskPatchCalls[0].fields.status).toBe("pr_open");
    expect(taskPatchCalls[0].fields.pr).toBe(99);
    expect(taskPatchCalls[0].fields.prCreatedAt).toBe(
      "2026-07-16T00:00:00.000Z",
    );
  });

  test("orphan candidate task with a branch but no matching open PR is left untouched — no PATCH", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-orphan-2",
      repo: "acme/example-repo",
      branch: "feat/tcr-1-2-no-pr-yet",
    };
    const { deps, taskPatchCalls } = makeDeps({
      orphanCandidateTasks: [task],
      openBranchResults: {},
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("a task already at pr_open is not touched by this pass (no double-processing with the existing pr_open pass)", async () => {
    // listOrphanCandidateTasks, per its contract, only ever returns
    // pending/in_progress tasks — a correct production implementation would
    // never include a pr_open task here. This fixture asserts the reconciler
    // doesn't blow up or double-count when a pr_open task coexists in the
    // data: it's returned by listPrOpenTasks (the existing pass) but NOT by
    // listOrphanCandidateTasks (this new pass).
    const prOpenTask: PrOpenTaskRecord = {
      id: "task-already-pr-open",
      repo: "acme/example-repo",
      pr: 123,
      branch: "feat/already-open",
    };
    const { deps, taskPatchCalls } = makeDeps({
      prOpenTasks: [prOpenTask],
      orphanCandidateTasks: [], // correctly excludes the pr_open task
      ghResults: {
        "acme/example-repo#123": { state: "OPEN", mergedAt: null },
      },
      openBranchResults: {
        "acme/example-repo#feat/already-open": [
          { number: 123, createdAt: "2026-07-16T00:00:00.000Z" },
        ],
      },
    });

    await reconcilePrState(deps);

    // Still open on GitHub via the existing pr_open pass — no merge PATCH —
    // and the orphan pass never even sees this task, so no pr_open PATCH either.
    expect(taskPatchCalls).toHaveLength(0);
  });

  test("orphan candidate task with no branch set is skipped defensively — no throw", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-orphan-no-branch",
      repo: "acme/example-repo",
    };
    const { deps, taskPatchCalls } = makeDeps({
      orphanCandidateTasks: [task],
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("ghListOpenPrsForBranch failure for one orphan task does not abort reconciliation of the others", async () => {
    const taskA: PrOpenTaskRecord = {
      id: "task-orphan-fail",
      repo: "acme/example-repo",
      branch: "feat/will-fail",
    };
    const taskB: PrOpenTaskRecord = {
      id: "task-orphan-ok",
      repo: "acme/example-repo",
      branch: "feat/will-succeed",
    };
    const { deps, taskPatchCalls } = makeDeps({
      orphanCandidateTasks: [taskA, taskB],
      openBranchResults: {
        "acme/example-repo#feat/will-fail": new Error(
          "gh pr list failed: rate limited",
        ),
        "acme/example-repo#feat/will-succeed": [
          { number: 200, createdAt: "2026-07-17T00:00:00.000Z" },
        ],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-orphan-ok");
    expect(taskPatchCalls[0].fields.pr).toBe(200);
  });

  test("multiple candidate tasks where only some have a matching open PR", async () => {
    const taskMatch: PrOpenTaskRecord = {
      id: "task-orphan-match",
      repo: "acme/example-repo",
      branch: "feat/has-pr",
    };
    const taskNoMatch: PrOpenTaskRecord = {
      id: "task-orphan-no-match",
      repo: "acme/example-repo",
      branch: "feat/no-pr-yet",
    };
    const { deps, taskPatchCalls } = makeDeps({
      orphanCandidateTasks: [taskMatch, taskNoMatch],
      openBranchResults: {
        "acme/example-repo#feat/has-pr": [
          { number: 300, createdAt: "2026-07-18T00:00:00.000Z" },
        ],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-orphan-match");
  });

  test("listOrphanCandidateTasks failure is logged and does not abort the rest of reconcilePrState", async () => {
    const { deps, taskPatchCalls } = makeDeps({
      orphanCandidateTasks: [],
    });
    deps.listOrphanCandidateTasks = async () => {
      throw new Error("task-store GET /tasks failed");
    };

    await expect(reconcilePrState(deps)).resolves.toBeUndefined();
    expect(taskPatchCalls).toHaveLength(0);
  });
});

describe("reconcileDeployingTasks", () => {
  test("deploying task whose merge is followed by a successful promote transitions to deployed, using the run's createdAt (not now())", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-deploying-1",
      repo: "acme/example-repo",
      mergedAt: "2026-07-17T00:00:00.000Z",
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      workflowRunsResults: {
        "acme/example-repo": [
          {
            id: 1,
            conclusion: "success",
            createdAt: "2026-07-17T00:10:00.000Z",
          },
        ],
      },
      now: () => "2026-07-19T00:00:00.000Z",
    });

    await reconcileDeployingTasks(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-deploying-1");
    expect(taskPatchCalls[0].fields).toEqual({
      status: "deployed",
      deployedAt: "2026-07-17T00:10:00.000Z",
    });
  });

  test("deploying task with no successful promote after its merge is left untouched", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-deploying-2",
      repo: "acme/example-repo",
      mergedAt: "2026-07-17T00:00:00.000Z",
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      workflowRunsResults: {
        "acme/example-repo": [],
      },
    });

    await reconcileDeployingTasks(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("a task in any status other than deploying is never modified — listDeployingTasks contract means non-deploying tasks are never seen by this pass", async () => {
    const prOpenTask: PrOpenTaskRecord = {
      id: "task-not-deploying",
      repo: "acme/example-repo",
      pr: 5,
    };
    const { deps, taskPatchCalls, listDeployingTasksCalls } = makeDeps({
      prOpenTasks: [prOpenTask],
      deployingTasks: [], // correctly excludes the pr_open task
      workflowRunsResults: {
        "acme/example-repo": [
          {
            id: 1,
            conclusion: "success",
            createdAt: "2026-07-17T00:10:00.000Z",
          },
        ],
      },
    });

    await reconcileDeployingTasks(deps);

    expect(listDeployingTasksCalls.length).toBeGreaterThan(0);
    expect(taskPatchCalls).toHaveLength(0);
  });

  test("a task with a null mergedAt is skipped and logged, never guessed at", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-deploying-null-merged-at",
      repo: "acme/example-repo",
      mergedAt: null,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      workflowRunsResults: {
        "acme/example-repo": [
          {
            id: 1,
            conclusion: "success",
            createdAt: "2026-07-17T00:10:00.000Z",
          },
        ],
      },
    });

    const originalError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };
    try {
      await reconcileDeployingTasks(deps);
    } finally {
      console.error = originalError;
    }

    expect(taskPatchCalls).toHaveLength(0);
    expect(
      errorCalls.some((call) =>
        call.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("task-deploying-null-merged-at"),
        ),
      ),
    ).toBe(true);
  });

  test("a single task's workflow-run lookup failure does not abort reconciliation of the rest of the batch", async () => {
    const taskA: PrOpenTaskRecord = {
      id: "task-deploying-fail",
      repo: "acme/example-repo",
      mergedAt: "2026-07-17T00:00:00.000Z",
    };
    const taskB: PrOpenTaskRecord = {
      id: "task-deploying-ok",
      repo: "other-org/other-repo",
      mergedAt: "2026-07-17T00:00:00.000Z",
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [taskA, taskB],
      workflowRunsResults: {
        "acme/example-repo": new Error("gh api failed: rate limited"),
        "other-org/other-repo": [
          {
            id: 2,
            conclusion: "success",
            createdAt: "2026-07-17T00:10:00.000Z",
          },
        ],
      },
    });

    await reconcileDeployingTasks(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-deploying-ok");
  });

  test("a tick with nothing to reconcile performs zero writes; an immediate re-run is a no-op", async () => {
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [],
    });

    await reconcileDeployingTasks(deps);
    expect(taskPatchCalls).toHaveLength(0);

    await reconcileDeployingTasks(deps);
    expect(taskPatchCalls).toHaveLength(0);
  });

  test("a run with conclusion !== 'success' is ignored even if newest", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-deploying-failed-run",
      repo: "acme/example-repo",
      mergedAt: "2026-07-17T00:00:00.000Z",
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      workflowRunsResults: {
        "acme/example-repo": [
          {
            id: 1,
            conclusion: "failure",
            createdAt: "2026-07-17T00:10:00.000Z",
          },
          {
            id: 2,
            conclusion: "success",
            createdAt: "2026-07-16T23:00:00.000Z", // older, before mergedAt
          },
        ],
      },
    });

    await reconcileDeployingTasks(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("a run createdAt exactly equal to (not strictly after) mergedAt is NOT reconciled", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-deploying-exact-equal",
      repo: "acme/example-repo",
      mergedAt: "2026-07-17T00:10:00.000Z",
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      workflowRunsResults: {
        "acme/example-repo": [
          {
            id: 1,
            conclusion: "success",
            createdAt: "2026-07-17T00:10:00.000Z",
          },
        ],
      },
    });

    await reconcileDeployingTasks(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("listDeployingTasks paginates beyond the default page limit — scans a second page", async () => {
    const page1 = Array.from({ length: 2 }, (_, i) => ({
      id: `task-deploying-p1-${i}`,
      repo: "acme/example-repo",
      mergedAt: "2026-07-17T00:00:00.000Z",
    }));
    const page2: PrOpenTaskRecord[] = [
      {
        id: "task-deploying-p2-0",
        repo: "acme/example-repo",
        mergedAt: "2026-07-17T00:00:00.000Z",
      },
    ];
    const { deps, listDeployingTasksCalls, taskPatchCalls } = makeDeps({
      deployingTasks: [...page1, ...page2],
      workflowRunsResults: {
        "acme/example-repo": [],
      },
      pageLimit: 2,
    });

    await reconcileDeployingTasks(deps);

    // Two pages fetched: offset 0 (full page of 2) then offset 2 (partial page of 1)
    expect(listDeployingTasksCalls).toHaveLength(2);
    expect(listDeployingTasksCalls[0]).toEqual({ limit: 2, offset: 0 });
    expect(listDeployingTasksCalls[1]).toEqual({ limit: 2, offset: 2 });
    // No successful runs configured — nothing is reconciled, but all 3 tasks were scanned.
    expect(taskPatchCalls).toHaveLength(0);
  });

  test("task.repo without a slash and no configured repos is skipped defensively — no throw", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-deploying-no-repo",
      repo: "example-repo",
      mergedAt: "2026-07-17T00:00:00.000Z",
    };
    const { deps, taskPatchCalls } = makeDeps({
      repos: [],
      deployingTasks: [task],
    });

    await reconcileDeployingTasks(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("listDeployingTasks failure is logged and does not throw", async () => {
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [],
    });
    deps.listDeployingTasks = async () => {
      throw new Error("task-store GET /tasks failed");
    };

    await expect(reconcileDeployingTasks(deps)).resolves.toBeUndefined();
    expect(taskPatchCalls).toHaveLength(0);
  });
});

describe("buildProductionDeps — ghListWorkflowRuns is scoped server-side by workflow (DSR-2.1 review fix)", () => {
  /**
   * Regression coverage for the finding on PR #1941: a client-side-filtered
   * `actions/runs?per_page=N` repo-wide fetch can miss the target workflow's
   * real recent runs when unrelated workflows are noisy (confirmed live on
   * vitals-os — bursts of unrelated workflow runs pushed a real "Promote to
   * Prod" run outside a top-20 window). This asserts `ghListWorkflowRuns`
   * now resolves the workflow's id via the "list repo workflows" endpoint
   * and queries that workflow's own runs endpoint — server-side scoped, so a
   * burst of unrelated workflow activity can never push the target workflow's
   * runs out of the page.
   */
  test("resolves the workflow id by name, then fetches only that workflow's runs", async () => {
    const calls: string[] = [];
    const ghJson = async <T>(args: string[]): Promise<T> => {
      const path = args[1] ?? "";
      calls.push(path);
      if (path.startsWith("repos/acme/example-repo/actions/workflows?")) {
        return {
          workflows: [
            { id: 111, name: "Bump Shipwright Chart" },
            { id: 222, name: "Promote to Prod" },
          ],
        } as T;
      }
      if (path === "repos/acme/example-repo/actions/workflows/222/runs?per_page=20") {
        return {
          workflow_runs: [
            {
              status: "completed",
              conclusion: "success",
              created_at: "2026-07-19T12:00:00.000Z",
              id: 999,
            },
          ],
        } as T;
      }
      throw new Error(`unexpected gh api call: ${path}`);
    };
    const deps = buildProductionDeps({
      ghJson,
      getScopedRepos: () => [],
    });

    const runs = await deps.ghListWorkflowRuns(
      "acme/example-repo",
      "Promote to Prod",
      20,
    );

    expect(runs).toEqual([
      {
        createdAt: "2026-07-19T12:00:00.000Z",
        conclusion: "success",
        id: 999,
      },
    ]);
    // Only the scoped workflow-runs endpoint is queried for run data — never
    // the unscoped repo-wide `actions/runs` endpoint a noisy burst of other
    // workflows (like "Bump Shipwright Chart") could crowd out.
    expect(calls).toEqual([
      "repos/acme/example-repo/actions/workflows?per_page=100",
      "repos/acme/example-repo/actions/workflows/222/runs?per_page=20",
    ]);
  });

  test("returns an empty list when no workflow matches the given name, rather than falling back to an unscoped fetch", async () => {
    const ghJson = async <T>(): Promise<T> => {
      return { workflows: [{ id: 111, name: "Bump Shipwright Chart" }] } as T;
    };
    const deps = buildProductionDeps({
      ghJson,
      getScopedRepos: () => [],
    });

    const runs = await deps.ghListWorkflowRuns(
      "acme/example-repo",
      "Promote to Prod",
      20,
    );

    expect(runs).toEqual([]);
  });
});
