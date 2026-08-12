/**
 * agent/src/check-patch.unit.test.ts
 *
 * Unit tests for getPatchCandidates() — native port of
 * plugins/shipwright/scripts/check-patch.ts's qualification logic.
 *
 * Ported from plugins/shipwright/scripts/check-patch.unit.test.ts, adjusted to
 * assert on the returned WorkPrCandidate[] array instead of {exit, output}.
 * The "no early return" tests are adjusted to assert ALL qualifying PRs are
 * collected (the WL-2.2 architectural difference from the plugin's
 * first-match gate).
 */

import { describe, expect, test } from "bun:test";
import type { CommitInfo, LinkedTaskInfo } from "./check-helpers.ts";
import {
  type CheckPatchDeps,
  type CiCheckStatus,
  type MergeStatusInfo,
  type OwnPr,
  type PrReviewData,
  findCancelledRuns,
  getPatchCandidates,
  hasFailingCi,
} from "./check-patch.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOwnPr(overrides: Partial<OwnPr> = {}): OwnPr {
  return {
    number: 10,
    title: "My feature",
    headRefName: "feat/my-feature",
    headRefOid: "current-head-sha",
    repo: "acme/example-repo",
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function makePrReviewData(overrides: Partial<PrReviewData> = {}): PrReviewData {
  return {
    headRefOid: "current-head-sha",
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

interface MakeDepsOptions {
  ownPrs: OwnPr[];
  reviewDataByPr: Record<number, PrReviewData>;
  ciStatusByPr?: Record<number, CiCheckStatus>;
  mergeStatusByPr?: Record<number, MergeStatusInfo>;
  listPrCommits?: (_prNumber: number) => Promise<CommitInfo[]>;
  getCurrentUser?: () => Promise<string>;
  getScopedRepos?: () => string[];
  hasScopeSynced?: () => boolean;
  queryTaskStatus?: (
    repo: string,
    prNumber: number,
  ) => Promise<LinkedTaskInfo | null>;
  isBundleComplete?: (branch: string) => Promise<boolean>;
}

function makeDeps({
  ownPrs,
  reviewDataByPr,
  ciStatusByPr = {},
  mergeStatusByPr = {},
  listPrCommits = async () => [],
  getCurrentUser = async () => "the-agent",
  getScopedRepos = () => [...new Set(ownPrs.map((pr) => pr.repo))],
  hasScopeSynced = () => true,
  queryTaskStatus = async () => null,
  isBundleComplete,
}: MakeDepsOptions): CheckPatchDeps {
  return {
    listOwnOpenPrs: async (_repo: string) => ownPrs,
    getScopedRepos,
    hasScopeSynced,
    fetchPrReviews: async (
      _org: string,
      _repo: string,
      pr: number,
    ): Promise<PrReviewData> => {
      return (
        reviewDataByPr[pr] ??
        makePrReviewData({ headRefOid: "current-head-sha" })
      );
    },
    fetchCiStatus: async (
      _org: string,
      _repo: string,
      pr: number,
    ): Promise<CiCheckStatus> => {
      return ciStatusByPr[pr] ?? { hasFailing: false };
    },
    fetchMergeStatus: async (
      _org: string,
      _repo: string,
      pr: number,
    ): Promise<MergeStatusInfo> => {
      return mergeStatusByPr[pr] ?? { isDirty: false };
    },
    listPrCommits,
    getCurrentUser,
    queryTaskStatus,
    ...(isBundleComplete ? { isBundleComplete } : {}),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getPatchCandidates", () => {
  test("returns empty array when no own open PRs exist", async () => {
    const result = await getPatchCandidates(
      makeDeps({ ownPrs: [], reviewDataByPr: {} }),
    );
    expect(result).toEqual([]);
  });

  test("collects ALL PRs with unaddressed findings, not just the first (no early-return)", async () => {
    const prs = [
      makeOwnPr({ number: 10, headRefOid: "sha-dirty-1" }),
      makeOwnPr({ number: 11, headRefOid: "sha-dirty-2" }),
    ];
    const findingReview = (sha: string): PrReviewData =>
      makePrReviewData({
        headRefOid: sha,
        reviews: {
          nodes: [
            {
              author: { login: "reviewer1" },
              state: "COMMENTED",
              submittedAt: "2026-05-26T10:00:00Z",
              commit: { oid: sha },
              body: "",
            },
          ],
        },
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              comments: {
                nodes: [
                  { author: { login: "reviewer1" }, body: "Please fix this" },
                ],
              },
            },
          ],
        },
      });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: prs,
        reviewDataByPr: {
          10: findingReview("sha-dirty-1"),
          11: findingReview("sha-dirty-2"),
        },
      }),
    );
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual([
      "acme/example-repo#10",
      "acme/example-repo#11",
    ]);
    expect(result.map((c) => c.commitSha)).toEqual([
      "sha-dirty-1",
      "sha-dirty-2",
    ]);
  });

  test("skips a clean PR and still collects a later PR with findings (continues past clean PRs)", async () => {
    const prs = [
      makeOwnPr({ number: 10, headRefOid: "sha-clean" }),
      makeOwnPr({ number: 11, headRefOid: "sha-dirty" }),
    ];
    const reviewDataMap: Record<number, PrReviewData> = {
      10: makePrReviewData({
        headRefOid: "sha-clean",
        reviews: { nodes: [] },
      }),
      11: makePrReviewData({
        headRefOid: "sha-dirty",
        reviews: {
          nodes: [
            {
              author: { login: "reviewer1" },
              state: "COMMENTED",
              submittedAt: "2026-05-26T10:00:00Z",
              commit: { oid: "sha-dirty" },
              body: "",
            },
          ],
        },
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              comments: {
                nodes: [
                  { author: { login: "reviewer1" }, body: "Please fix this" },
                ],
              },
            },
          ],
        },
      }),
    };
    const result = await getPatchCandidates(
      makeDeps({ ownPrs: prs, reviewDataByPr: reviewDataMap }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/example-repo#11");
    expect(result[0].commitSha).toBe("sha-dirty");
  });

  test("returns a candidate when a PR has findings AND another is merely behind main (not dirty)", async () => {
    const prs = [
      makeOwnPr({ number: 10, headRefOid: "sha-behind" }),
      makeOwnPr({ number: 11, headRefOid: "sha-findings" }),
    ];
    const reviewDataMap: Record<number, PrReviewData> = {
      10: makePrReviewData({
        headRefOid: "sha-behind",
        reviews: { nodes: [] },
      }),
      11: makePrReviewData({
        headRefOid: "sha-findings",
        reviews: {
          nodes: [
            {
              author: { login: "reviewer1" },
              state: "COMMENTED",
              submittedAt: "2026-05-26T10:00:00Z",
              commit: { oid: "sha-findings" },
              body: "Please fix this",
            },
          ],
        },
        reviewThreads: { nodes: [] },
      }),
    };
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: prs,
        reviewDataByPr: reviewDataMap,
        ciStatusByPr: {},
        mergeStatusByPr: { 10: { isDirty: false } },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/example-repo#11");
  });

  test("returns a candidate when PR has failing CI", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns one candidate (not duplicated) when PR has unaddressed findings AND failing CI", async () => {
    const pr = makeOwnPr({ number: 10 });
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Must fix before merge.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: { 10: { hasFailing: true } },
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns a candidate when own PR has failing CI checks", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
      }),
    );
    expect(result).toHaveLength(1);
  });

  // ─── cancelled-only CI candidacy (PCC-1.1) ──────────────────────────────────

  test("returns a candidate when PR's only CI signal is hasCancelled (no genuine failure)", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: {
          10: { hasFailing: false, hasCancelled: true, cancelledRunId: 555 },
        },
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns empty array when hasCancelled is false and hasFailing is false (green CI, no findings, no conflict)", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: false, hasCancelled: false } },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when PR has no findings, green CI, and no merge conflict (defaults hasCancelled to false when omitted)", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: false } },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when PR is merely behind main (not dirty) with no other issues", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: {},
        mergeStatusByPr: { 10: { isDirty: false } },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when PR has no findings, green CI, and no merge conflict", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: false } },
        mergeStatusByPr: { 10: { isDirty: false } },
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when own PR has DIRTY merge state", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: false } },
        mergeStatusByPr: { 10: { isDirty: true } },
      }),
    );
    expect(result).toHaveLength(1);
  });

  // ─── Merge-only stale findings ────────────────────────────────────────────

  test("returns a candidate when stale COMMENT review has findings and all new commits are merge-only", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" },
            body: "Please fix this",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] },
    ];
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns a candidate when stale review has unresolved threads and all new commits are merge-only", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" },
            body: "",
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [{ author: { login: "reviewer1" }, body: "Fix this" }],
            },
          },
        ],
      },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] },
    ];
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns empty array when stale review has findings but real commits pushed since (not merge-only)", async () => {
    const pr = makeOwnPr({ headRefOid: "real-work-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "real-work-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" },
            body: "Please fix this",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "real-work-sha", parents: [{ sha: "p1" }] },
    ];
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when stale COMMENT review at older commit has no findings (empty body, no unresolved threads)", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" },
            body: "",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] },
    ];
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
      }),
    );
    expect(result).toEqual([]);
  });

  // ─── Self-authored review exclusion (CPF-1.1) ─────────────────────────────

  test("returns empty array when only review is self-authored COMMENTED at a stale commit with merge-only commits since", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" },
            body: "APPROVE — looks good, no changes needed.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] },
    ];
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
        getCurrentUser: async () => "the-agent",
      }),
    );
    expect(result).toEqual([]);
  });

  // ─── Self-review with real findings still counts (CPF-1.2) ────────────────

  test("returns a candidate when self-authored review at a stale commit has a non-APPROVE body with merge-only commits since", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" },
            body: "Verdict: COMMENT — found a race condition in the retry logic, needs a fix before merge.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] },
    ];
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
        getCurrentUser: async () => "the-agent",
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns empty array for hasMergeOnlyStaleFindings when a stale third-party review's body is followed by a PR-author reply after it", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "dodizzle" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" }, // posted before the merge commit
            body: "Missing plugin.json/marketplace.json version bump.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
      comments: {
        nodes: [
          {
            author: { login: "the-agent" },
            body: "Verified false positive, resolved.",
            createdAt: "2026-05-26T10:30:00Z", // after the stale review's submittedAt
          },
        ],
      },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] }, // merge commit
    ];
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
        getCurrentUser: async () => "the-agent",
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate for hasMergeOnlyStaleFindings when a stale third-party review's body has no PR-author reply", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "dodizzle" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" },
            body: "Missing plugin.json/marketplace.json version bump.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] },
    ];
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
        getCurrentUser: async () => "the-agent",
      }),
    );
    expect(result).toHaveLength(1);
  });

  // ─── age field sourcing ────────────────────────────────────────────────────

  test("age is sourced from the linked task's createdAt when a task is linked, even when queryPrRecord's readyForPatchAt is available", async () => {
    const pr = makeOwnPr({ number: 10, createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryPrRecord = async () => ({
      readyForPatchAt: "2026-05-20T00:00:00.000Z",
    });
    deps.queryTaskStatus = async () => ({
      status: "in_progress",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    const result = await getPatchCandidates(deps);
    expect(result[0].age).toBe("2026-05-01T00:00:00.000Z");
    expect(result[0].age).not.toBe("2026-05-20T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when no task is linked (queryTaskStatus resolves null), even when queryPrRecord's readyForPatchAt is available", async () => {
    const pr = makeOwnPr({ number: 10, createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryPrRecord = async () => ({
      readyForPatchAt: "2026-05-20T00:00:00.000Z",
    });
    const result = await getPatchCandidates(deps);
    expect(result[0].age).toBe("2026-06-01T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when queryPrRecord is not provided and no task is linked", async () => {
    const pr = makeOwnPr({ number: 10, createdAt: "2026-06-01T00:00:00.000Z" });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
      }),
    );
    expect(result[0].age).toBe("2026-06-01T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when queryTaskStatus throws (lookup failure does not disqualify or block age fallback)", async () => {
    const pr = makeOwnPr({ number: 10, createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryTaskStatus = async () => {
      throw new Error("task-store unreachable");
    };
    const result = await getPatchCandidates(deps);
    expect(result).toHaveLength(1);
    expect(result[0].age).toBe("2026-06-01T00:00:00.000Z");
  });

  // ─── hitl + task-blocked exclusion (CBD-2.2, PRB-2.2) ───────────────────────

  test("a PR whose linked task is hitl:true is excluded from patch candidacy entirely", async () => {
    const pr = makeOwnPr({ number: 10 });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryTaskStatus = async () => ({
      status: "pr_open",
      createdAt: "2026-05-01T00:00:00.000Z",
      hitl: true,
    });
    const result = await getPatchCandidates(deps);
    expect(result).toHaveLength(0);
  });

  test("a PR is still an eligible candidate when the linked task has hitl:false or no linked task exists", async () => {
    const pr = makeOwnPr({ number: 10 });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryTaskStatus = async () => ({
      status: "pr_open",
      createdAt: "2026-05-01T00:00:00.000Z",
      hitl: false,
    });
    const result = await getPatchCandidates(deps);
    expect(result).toHaveLength(1);

    deps.queryTaskStatus = async () => null;
    const resultNoTask = await getPatchCandidates(deps);
    expect(resultNoTask).toHaveLength(1);
  });

  test("a hitl:true PR does not block a different, non-hitl PR from being collected", async () => {
    const hitlPr = makeOwnPr({ number: 10 });
    const okPr = makeOwnPr({ number: 11, headRefOid: "ok-sha" });
    const deps = makeDeps({
      ownPrs: [hitlPr, okPr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true }, 11: { hasFailing: true } },
    });
    deps.queryTaskStatus = async (_repo: string, prNumber: number) =>
      prNumber === 10
        ? {
            status: "pr_open",
            createdAt: "2026-05-01T00:00:00.000Z",
            hitl: true,
          }
        : { status: "pr_open", createdAt: "2026-05-01T00:00:00.000Z" };
    const result = await getPatchCandidates(deps);
    expect(result.map((c) => c.id)).toEqual(["acme/example-repo#11"]);
  });

  test("a PR whose task-store PR record has blocked:true is excluded, even when there is no linked task at all (isPrRecordBlockedForDispatch)", async () => {
    const pr = makeOwnPr({ number: 10, createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryPrRecord = async () => ({ blocked: true });
    deps.queryTaskStatus = async () => null;
    const result = await getPatchCandidates(deps);
    expect(result).toEqual([]);
  });

  test('a PR whose linked task has status:"blocked" is excluded from patch candidacy (isTaskBlockedForDispatch, new behavior)', async () => {
    const pr = makeOwnPr({ number: 10 });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryTaskStatus = async () => ({
      status: "blocked",
      createdAt: "2026-05-01T00:00:00.000Z",
      hitl: false,
    });
    const result = await getPatchCandidates(deps);
    expect(result).toEqual([]);
  });

  // ─── claim gating (LPF-2.2) ────────────────────────────────────────────────

  test("excludes a PR whose task-store record has claimedBy set, even though it otherwise needs patch attention", async () => {
    // Regression guard for the LPF-2.2 trap: a record with claimedBy set
    // means another agent currently holds the claim on this PR — excluded,
    // mirroring check-review.ts.
    const pr = makeOwnPr({ number: 10, createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryPrRecord = async () => ({ claimedBy: "agent-other" });
    const result = await getPatchCandidates(deps);
    expect(result).toEqual([]);
  });

  test("does NOT exclude a PR when queryPrRecord resolves null (no record yet — e.g. self-authored PR skipped by claim() under allow_self_review: false)", async () => {
    const pr = makeOwnPr({ number: 10, createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryPrRecord = async () => null;
    const result = await getPatchCandidates(deps);
    expect(result).toHaveLength(1);
  });

  test("does NOT exclude a PR when queryPrRecord throws (transient task-store error) — falls back to createdAt", async () => {
    const pr = makeOwnPr({ number: 10, createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryPrRecord = async () => {
      throw new Error("task-store unavailable");
    };
    const result = await getPatchCandidates(deps);
    expect(result).toHaveLength(1);
  });

  // ─── agent-scope filtering (WL-4.3) ──────────────────────────────────────

  test("excludes a PR from a repo returned by the local-clone scan but absent from getScopedRepos()", async () => {
    const inScope = makeOwnPr({
      number: 10,
      repo: "example-org/in-scope",
    });
    const outOfScope = makeOwnPr({
      number: 20,
      repo: "example-org/out-of-scope",
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [inScope, outOfScope],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true }, 20: { hasFailing: true } },
        getScopedRepos: () => ["example-org/in-scope"],
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("example-org/in-scope#10");
  });

  test("re-evaluates getScopedRepos() on every call — a scope change between two calls changes the result on the second call", async () => {
    const pr = makeOwnPr({ number: 10, repo: "example-org/newly-added" });
    let scope: string[] = [];
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
      getScopedRepos: () => scope,
    });

    const first = await getPatchCandidates(deps);
    expect(first).toEqual([]);

    scope = ["example-org/newly-added"];
    const second = await getPatchCandidates(deps);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("example-org/newly-added#10");
  });

  test("fails open (does not filter) when hasScopeSynced() is false, even if getScopedRepos() would otherwise exclude everything", async () => {
    const pr = makeOwnPr({ number: 10, repo: "example-org/never-synced" });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
        getScopedRepos: () => [],
        hasScopeSynced: () => false,
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("example-org/never-synced#10");
  });

  test("filters normally when hasScopeSynced() is true, even if the synced scope is a deliberately empty list", async () => {
    const pr = makeOwnPr({ number: 10, repo: "example-org/some-repo" });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
        getScopedRepos: () => [],
        hasScopeSynced: () => true,
      }),
    );
    expect(result).toEqual([]);
  });

  test("excludes a PR when isBundleComplete resolves false for its branch", async () => {
    const pr = makeOwnPr({
      headRefName: "feat/bundle-incomplete",
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
        isBundleComplete: async (branch: string) =>
          branch !== "feat/bundle-incomplete",
      }),
    );
    expect(result).toEqual([]);
  });

  test("includes a PR when isBundleComplete resolves true for its branch", async () => {
    const pr = makeOwnPr({
      headRefName: "feat/bundle-complete",
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
        isBundleComplete: async (branch: string) =>
          branch === "feat/bundle-complete",
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/example-repo#10");
  });
});

// ─── hasFailingCi (CPC-1.1) ────────────────────────────────────────────────────

describe("hasFailingCi", () => {
  test("returns false when a workflow's earlier run failed but a later rerun (same workflow_id, higher run_number) succeeded", () => {
    const runs = [
      { workflow_id: 290585892, run_number: 2131, conclusion: "failure" },
      { workflow_id: 290585892, run_number: 2132, conclusion: "success" },
    ];
    expect(hasFailingCi(runs)).toBe(false);
  });

  test("returns true when the latest run for a workflow_id has conclusion 'failure'", () => {
    const runs = [
      { workflow_id: 1, run_number: 1, conclusion: "success" },
      { workflow_id: 2, run_number: 1, conclusion: "failure" },
      { workflow_id: 2, run_number: 2, conclusion: "failure" },
    ];
    expect(hasFailingCi(runs)).toBe(true);
  });

  test("returns true when the latest run for a workflow_id has conclusion 'timed_out'", () => {
    const runs = [
      { workflow_id: 1, run_number: 1, conclusion: "success" },
      { workflow_id: 3, run_number: 5, conclusion: "timed_out" },
    ];
    expect(hasFailingCi(runs)).toBe(true);
  });

  test("returns false for an empty runs array", () => {
    expect(hasFailingCi([])).toBe(false);
  });

  test("returns false for a single passing run", () => {
    const runs = [{ workflow_id: 1, run_number: 1, conclusion: "success" }];
    expect(hasFailingCi(runs)).toBe(false);
  });
});

// ─── findCancelledRuns (PCC-1.1) ───────────────────────────────────────────────

describe("findCancelledRuns", () => {
  test("cancelled with no newer run for that workflow → true (returns the qualifying run)", () => {
    const runs = [
      { id: 111, workflow_id: 1, run_number: 1, conclusion: "cancelled" },
    ];
    const result = findCancelledRuns(runs);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 111,
      workflow_id: 1,
      run_number: 1,
    });
  });

  test("cancelled but a newer run for the same workflow exists and succeeded → false (no qualifying runs)", () => {
    const runs = [
      { id: 111, workflow_id: 1, run_number: 1, conclusion: "cancelled" },
      { id: 112, workflow_id: 1, run_number: 2, conclusion: "success" },
    ];
    expect(findCancelledRuns(runs)).toEqual([]);
  });

  test("one workflow's latest run is cancelled AND a different workflow's latest run genuinely failed — both signals independently detectable", () => {
    const runs = [
      { id: 201, workflow_id: 1, run_number: 1, conclusion: "cancelled" },
      { id: 202, workflow_id: 2, run_number: 1, conclusion: "failure" },
    ];
    const cancelled = findCancelledRuns(runs);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ id: 201, workflow_id: 1 });

    // hasFailingCi (unchanged) still independently reports the failed workflow.
    expect(hasFailingCi(runs)).toBe(true);
  });

  test("returns false for an empty runs array", () => {
    expect(findCancelledRuns([])).toEqual([]);
  });

  test("returns false for a single passing run", () => {
    const runs = [
      { id: 1, workflow_id: 1, run_number: 1, conclusion: "success" },
    ];
    expect(findCancelledRuns(runs)).toEqual([]);
  });

  test("a workflow's earlier run was cancelled but a later rerun (same workflow_id, higher run_number) also cancelled → still true (latest is cancelled)", () => {
    const runs = [
      { id: 301, workflow_id: 1, run_number: 1, conclusion: "cancelled" },
      { id: 302, workflow_id: 1, run_number: 2, conclusion: "cancelled" },
    ];
    const result = findCancelledRuns(runs);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 302, workflow_id: 1 });
  });
});
