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
  buildReviewStateProductionDeps,
  type GhPrView,
  type GhWorkflowRun,
  type PrOpenTaskRecord,
  type PrReviewStateRecord,
  type PrReviewStateReconcilerDeps,
  type PrStateRecord,
  type PrStateReconcilerDeps,
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
  /** deploying tasks for the new deploying-task reconciliation pass; defaults to [] so existing tests are unaffected. */
  deployingTasks?: PrOpenTaskRecord[];
  /** "org/repo#sha" -> GH Actions runs at that head_sha, or an Error to throw for that lookup. */
  runsForSha?: Record<string, GhWorkflowRun[] | Error>;
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
  deployingTasks = [],
  runsForSha = {},
}: MakeDepsOptions = {}): {
  deps: PrStateReconcilerDeps;
  listCalls: ListPrsCall[];
  patchCalls: PatchCall[];
  taskPatchCalls: PatchCall[];
} {
  const listCalls: ListPrsCall[] = [];
  const patchCalls: PatchCall[] = [];
  const taskPatchCalls: PatchCall[] = [];

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
    listPrOpenTasks: async () => prOpenTasks,
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
    listDeployingTasks: async () => deployingTasks,
    fetchRunsForSha: async (org: string, repo: string, headSha: string) => {
      const key = `${org}/${repo}#${headSha}`;
      const result = runsForSha[key];
      if (result instanceof Error) throw result;
      return result ?? [];
    },
  };

  return { deps, listCalls, patchCalls, taskPatchCalls };
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
});

// ─── reconcilePrState — deploying task reconciliation pass (DSR-1.2) ──────────

describe("reconcilePrState — deploying task reconciliation pass", () => {
  function withCommitShaPrRecord(
    repo: string,
    prNumber: number,
    commitSha: string | null,
  ): Record<string, PrStateRecord> {
    return {
      [`${repo}#${prNumber}`]: {
        id: `pr-record-${prNumber}`,
        repo,
        prNumber,
        state: "merged",
        commitSha,
      },
    };
  }

  test("successful Deploy run marks the task deployed", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d1",
      repo: "acme/example-repo",
      pr: 100,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      prRecords: withCommitShaPrRecord("acme/example-repo", 100, "sha-100"),
      runsForSha: {
        "acme/example-repo#sha-100": [
          { id: 1, name: "Deploy", status: "completed", conclusion: "success" },
        ],
      },
      now: () => "2026-07-16T00:00:00.000Z",
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-d1");
    expect(taskPatchCalls[0].fields.status).toBe("deployed");
    expect(taskPatchCalls[0].fields.deployedAt).toBe(
      "2026-07-16T00:00:00.000Z",
    );
  });

  test("failed Deploy run marks the task blocked with a note citing the run", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d2",
      repo: "acme/example-repo",
      pr: 101,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      prRecords: withCommitShaPrRecord("acme/example-repo", 101, "sha-101"),
      runsForSha: {
        "acme/example-repo#sha-101": [
          {
            id: 42,
            name: "Deploy",
            status: "completed",
            conclusion: "failure",
          },
        ],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-d2");
    expect(taskPatchCalls[0].fields.status).toBe("blocked");
    expect(taskPatchCalls[0].fields.note).toBe(
      "Deploy stage failed — run ID: 42",
    );
  });

  test("no Deploy workflow but green post-merge CI marks the task deployed via fallback", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d3",
      repo: "acme/example-repo",
      pr: 102,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      prRecords: withCommitShaPrRecord("acme/example-repo", 102, "sha-102"),
      runsForSha: {
        "acme/example-repo#sha-102": [
          { id: 7, name: "CI", status: "completed", conclusion: "success" },
        ],
      },
      now: () => "2026-07-16T01:00:00.000Z",
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-d3");
    expect(taskPatchCalls[0].fields.status).toBe("deployed");
    expect(taskPatchCalls[0].fields.deployedAt).toBe(
      "2026-07-16T01:00:00.000Z",
    );
  });

  test("no Deploy workflow and failed post-merge CI marks the task blocked via fallback", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d4",
      repo: "acme/example-repo",
      pr: 103,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      prRecords: withCommitShaPrRecord("acme/example-repo", 103, "sha-103"),
      runsForSha: {
        "acme/example-repo#sha-103": [
          { id: 9, name: "CI", status: "completed", conclusion: "failure" },
        ],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-d4");
    expect(taskPatchCalls[0].fields.status).toBe("blocked");
    expect(taskPatchCalls[0].fields.note).toBe(
      "Post-merge CI failed — run ID: 9",
    );
  });

  test("runs still in progress are left untouched — not yet resolvable", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d5",
      repo: "acme/example-repo",
      pr: 104,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      prRecords: withCommitShaPrRecord("acme/example-repo", 104, "sha-104"),
      runsForSha: {
        "acme/example-repo#sha-104": [
          { id: 11, name: "Deploy", status: "in_progress", conclusion: null },
        ],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("no runs found at all for the SHA yet is left untouched — not yet resolvable", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d6",
      repo: "acme/example-repo",
      pr: 105,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      prRecords: withCommitShaPrRecord("acme/example-repo", 105, "sha-105"),
      runsForSha: {
        "acme/example-repo#sha-105": [],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("a failed earlier Deploy attempt followed by a successful retry is deployed, not blocked", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d7",
      repo: "acme/example-repo",
      pr: 106,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      prRecords: withCommitShaPrRecord("acme/example-repo", 106, "sha-106"),
      runsForSha: {
        "acme/example-repo#sha-106": [
          {
            id: 20,
            name: "Deploy",
            status: "completed",
            conclusion: "failure",
          },
          {
            id: 21,
            name: "Deploy",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
      now: () => "2026-07-16T02:00:00.000Z",
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].fields.status).toBe("deployed");
    expect(taskPatchCalls[0].fields.deployedAt).toBe(
      "2026-07-16T02:00:00.000Z",
    );
  });

  test("no PR record found for the deploying task is skipped — no PATCH, no throw", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d8",
      repo: "acme/example-repo",
      pr: 107,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      prRecords: {},
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("PR record found but commitSha is null is skipped — no PATCH, no throw", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d9",
      repo: "acme/example-repo",
      pr: 108,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
      prRecords: withCommitShaPrRecord("acme/example-repo", 108, null),
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("deploying task with no pr number is skipped — no PATCH, no throw", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d10",
      repo: "acme/example-repo",
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [task],
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("task.repo without a slash and no configured repos is skipped defensively — no throw", async () => {
    const task: PrOpenTaskRecord = {
      id: "task-d11",
      repo: "example-repo",
      pr: 109,
    };
    const { deps, taskPatchCalls } = makeDeps({
      repos: [],
      deployingTasks: [task],
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(0);
  });

  test("a lookup failure for one deploying task does not abort reconciliation of the others in the batch", async () => {
    const taskA: PrOpenTaskRecord = {
      id: "task-d12",
      repo: "acme/example-repo",
      pr: 110,
    };
    const taskB: PrOpenTaskRecord = {
      id: "task-d13",
      repo: "acme/example-repo",
      pr: 111,
    };
    const { deps, taskPatchCalls } = makeDeps({
      deployingTasks: [taskA, taskB],
      prRecords: {
        ...withCommitShaPrRecord("acme/example-repo", 110, "sha-110"),
        ...withCommitShaPrRecord("acme/example-repo", 111, "sha-111"),
      },
      runsForSha: {
        "acme/example-repo#sha-110": new Error("gh api failed: rate limited"),
        "acme/example-repo#sha-111": [
          {
            id: 55,
            name: "Deploy",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    });

    await reconcilePrState(deps);

    expect(taskPatchCalls).toHaveLength(1);
    expect(taskPatchCalls[0].id).toBe("task-d13");
  });

  test("a listDeployingTasks() failure is logged and does not throw", async () => {
    const { deps, taskPatchCalls } = makeDeps({});
    deps.listDeployingTasks = async () => {
      throw new Error("task-store unreachable");
    };

    await expect(reconcilePrState(deps)).resolves.toBeUndefined();
    expect(taskPatchCalls).toHaveLength(0);
  });
});
