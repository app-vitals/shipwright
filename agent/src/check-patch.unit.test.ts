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
import type { CommitInfo } from "./check-helpers.ts";
import {
  type CheckPatchDeps,
  type CiCheckStatus,
  type MergeStatusInfo,
  type OwnPr,
  type PrReviewData,
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
    ...overrides,
  };
}

interface MakeDepsOptions {
  ownPrs: OwnPr[];
  reviewDataByPr: Record<number, PrReviewData>;
  ciStatusByPr?: Record<number, CiCheckStatus>;
  mergeStatusByPr?: Record<number, MergeStatusInfo>;
  listPrCommits?: (_prNumber: number) => Promise<CommitInfo[]>;
  getCurrentUser?: () => string;
}

function makeDeps({
  ownPrs,
  reviewDataByPr,
  ciStatusByPr = {},
  mergeStatusByPr = {},
  listPrCommits = async () => [],
  getCurrentUser = () => "the-agent",
}: MakeDepsOptions): CheckPatchDeps {
  return {
    listOwnOpenPrs: async (_repo: string) => ownPrs,
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

  test("returns empty array when own PR has no COMMENT/CHANGES_REQUESTED reviews", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "APPROVED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "",
          },
        ],
      },
    });
    const result = await getPatchCandidates(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when own PR has COMMENT review with unresolved inline threads", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
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
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "acme/example-repo#10", phase: "patch" });
  });

  test("returns a candidate when own PR has CHANGES_REQUESTED review with non-empty body at current HEAD", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please address these issues before merging.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns empty array when COMMENT review was posted at an older commit (new commits pushed since)", async () => {
    const pr = makeOwnPr({ headRefOid: "new-head-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "new-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T09:00:00Z",
            commit: { oid: "old-head-sha" },
            body: "Please fix this",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when all inline threads are resolved and review body is empty", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "",
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: true,
            comments: {
              nodes: [{ author: { login: "reviewer1" }, body: "Fixed now" }],
            },
          },
        ],
      },
    });
    const result = await getPatchCandidates(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when COMMENT review has non-empty body and no inline threads", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "End-of-queue summary doesn't count deploy_handed_off PRs.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result).toHaveLength(1);
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

  test("returns empty array when only review is self-authored COMMENTED at current HEAD with non-empty body", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "APPROVE — looks good, no changes needed.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toEqual([]);
  });

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
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when self-authored review coexists with a different reviewer's CHANGES_REQUESTED finding", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "APPROVE — looks good, no changes needed.",
          },
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T11:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please address these issues before merging.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toHaveLength(1);
  });

  // ─── Self-review with real findings still counts (CPF-1.2) ────────────────

  test("returns a candidate when self-authored COMMENTED review at current HEAD has a non-APPROVE body with a real finding", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verdict: COMMENT — found a race condition in the retry logic, needs a fix before merge.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toHaveLength(1);
  });

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
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toHaveLength(1);
  });

  // ─── Bold-wrapped self-APPROVE verdicts (CPF-1.3) ──────────────────────────

  test("returns empty array when only review is self-authored COMMENTED at current HEAD with a bold-wrapped APPROVE verdict", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "**APPROVE** — looks good, no changes needed.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toEqual([]);
  });

  // ─── Narrative "Verdict: APPROVE" self-reviews (CPF-2.1) ───────────────────

  test("returns empty array when only review is self-authored COMMENTED at current HEAD with a narrative ending in Verdict: APPROVE", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Reviewed the diff for correctness and style. Everything checks out, no issues found.\n\nVerdict: APPROVE",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns empty array when self-authored review trails reasoning after Verdict: APPROVE on the same line (verbatim shipwright PR #1272 case)", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Clean, well-scoped PR. Verified the generator output is byte-identical to the committed `docs/mcp-tools.md` (no drift), all 9 sections match the allowlist's filtered tool set exactly, unit tests (10/10) and lint pass, and no Helm/Kubernetes content leaked into the doc. All 5 acceptance criteria met. Verdict: APPROVE (posted as COMMENT — GitHub disallows self-approval via the API).",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when a narrative Verdict: APPROVE self-review coexists with a different reviewer's CHANGES_REQUESTED finding", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Reviewed the diff for correctness and style. Everything checks out, no issues found.\n\nVerdict: APPROVE",
          },
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T11:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please address these issues before merging.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toHaveLength(1);
  });

  test("returns a candidate when self-authored review has a narrative ending in Verdict: CHANGES_REQUESTED", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Reviewed the diff and found a race condition in the retry logic that needs a fix before merge.\n\nVerdict: CHANGES_REQUESTED",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result).toHaveLength(1);
  });

  // ─── age field sourcing ────────────────────────────────────────────────────

  test("age is sourced from queryPrRecord's readyForPatchAt when available", async () => {
    const pr = makeOwnPr({ number: 10, createdAt: "2026-06-01T00:00:00.000Z" });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    deps.queryPrRecord = async () => ({
      readyForPatchAt: "2026-05-20T00:00:00.000Z",
      claimedBy: null,
    });
    const result = await getPatchCandidates(deps);
    expect(result[0].age).toBe("2026-05-20T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when queryPrRecord is not provided", async () => {
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
