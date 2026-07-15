/**
 * plugins/shipwright/scripts/check-patch.unit.test.ts
 *
 * Unit tests for check-patch.ts
 *
 * Design: the script exports a `run(deps)` function with injectable deps for
 * GH PR listing and GraphQL review data fetching.
 *
 * check-patch does NOT read state/reviews.json — all data comes from GH directly.
 */

import { describe, expect, test } from "bun:test";
import type { CommitInfo } from "./check-helpers.ts";
import { hasFailingCi, run } from "./check-patch.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OwnPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  repo: string;
}

interface ReviewNode {
  author: { login: string };
  state: string; // "COMMENTED" | "CHANGES_REQUESTED" | "APPROVED" | "DISMISSED"
  submittedAt: string;
  commit: { oid: string };
  body: string;
}

interface ReviewThread {
  isResolved: boolean;
  comments: { nodes: Array<{ author: { login: string }; body: string }> };
}

interface IssueCommentNode {
  author: { login: string };
  body: string;
  createdAt: string;
}

interface PrReviewData {
  headRefOid: string;
  reviews: { nodes: ReviewNode[] };
  reviewThreads: { nodes: ReviewThread[] };
  comments: { nodes: IssueCommentNode[] };
}

interface CiCheckStatus {
  hasFailing: boolean;
}

interface MergeStatusInfo {
  isDirty: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOwnPr(overrides: Partial<OwnPr> = {}): OwnPr {
  return {
    number: 10,
    title: "My feature",
    headRefName: "feat/my-feature",
    headRefOid: "current-head-sha",
    repo: "acme/example-repo",
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
  getCurrentUser?: () => string;
}

function makeDeps({
  ownPrs,
  reviewDataByPr,
  ciStatusByPr = {},
  mergeStatusByPr = {},
  listPrCommits = async () => [],
  getCurrentUser = () => "the-agent",
}: MakeDepsOptions) {
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

describe("check-patch", () => {
  test("exits 1 when no own open PRs exist", async () => {
    const result = await run(makeDeps({ ownPrs: [], reviewDataByPr: {} }));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when own PR has no COMMENT/CHANGES_REQUESTED reviews", async () => {
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
    const result = await run(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when own PR has COMMENT review with unresolved inline threads", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" }, // same as headRefOid — no new commits
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
    const result = await run(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when own PR has CHANGES_REQUESTED review with non-empty body at current HEAD", async () => {
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
    const result = await run(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 1 when COMMENT review was posted at an older commit (new commits pushed since)", async () => {
    const pr = makeOwnPr({ headRefOid: "new-head-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "new-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T09:00:00Z",
            commit: { oid: "old-head-sha" }, // review posted at old commit
            body: "Please fix this",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await run(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when all inline threads are resolved and review body is empty", async () => {
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
            body: "", // no body-level findings
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: true, // all resolved
            comments: {
              nodes: [{ author: { login: "reviewer1" }, body: "Fixed now" }],
            },
          },
        ],
      },
    });
    const result = await run(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when COMMENT review has non-empty body and no inline threads", async () => {
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
      reviewThreads: { nodes: [] }, // no inline threads — finding is in the body
    });
    const result = await run(
      makeDeps({ ownPrs: [pr], reviewDataByPr: { 10: reviewData } }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when multiple PRs and one has unaddressed findings (first findings PR triggers patch)", async () => {
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
    // PR 10 is clean (no findings, no failing CI, no conflict) — continues to PR 11
    // PR 11 has findings — triggers patch (exit 0)
    const result = await run(
      makeDeps({ ownPrs: prs, reviewDataByPr: reviewDataMap }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when multiple PRs and one has unaddressed findings AND another is merely behind main (not dirty)", async () => {
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
    // PR 10 is behind but not dirty — not patch-worthy on its own, loop continues
    // PR 11 has findings — triggers patch (exit 0)
    const result = await run(
      makeDeps({
        ownPrs: prs,
        reviewDataByPr: reviewDataMap,
        ciStatusByPr: {},
        mergeStatusByPr: { 10: { isDirty: false } },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("prompt mentions shipwright:patch when PR has failing CI", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output.toLowerCase()).toContain("patch");
  });

  test("exits 0 when PR has unaddressed findings AND failing CI (findings trigger patch before CI is checked)", async () => {
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
    // PR has both unaddressed findings AND failing CI — findings guard fires first, exit 0
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: { 10: { hasFailing: true } },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when own PR has failing CI checks", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 1 when PR is merely behind main (not dirty) with no other issues", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: {},
        mergeStatusByPr: { 10: { isDirty: false } },
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when PR has no findings, green CI, and no merge conflict", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: false } },
        mergeStatusByPr: { 10: { isDirty: false } },
      }),
    );
    expect(result.exit).toBe(1);
  });

  test("exits 0 when own PR has DIRTY merge state", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: false } },
        mergeStatusByPr: { 10: { isDirty: true } },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output.toLowerCase()).toContain("patch");
  });

  // ─── Merge-only stale findings ────────────────────────────────────────────

  test("exits 0 when stale COMMENT review has findings and all new commits are merge-only", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" }, // posted before the merge commit
            body: "Please fix this",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] }, // merge commit
    ];
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when stale review has unresolved threads and all new commits are merge-only", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 1 when stale review has findings but real commits pushed since (not merge-only)", async () => {
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
      { sha: "real-work-sha", parents: [{ sha: "p1" }] }, // regular (non-merge) commit
    ];
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when stale COMMENT review at older commit has no findings (empty body, no unresolved threads)", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
      }),
    );
    expect(result.exit).toBe(1);
  });

  // ─── Self-authored review exclusion (CPF-1.1) ─────────────────────────────

  test("exits 1 when only review is self-authored COMMENTED at current HEAD with non-empty body", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when only review is self-authored COMMENTED at a stale commit with merge-only commits since", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" }, // posted before the merge commit
            body: "APPROVE — looks good, no changes needed.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] }, // merge commit
    ];
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when only review is a clean 'Verdict: APPROVE' from a different author than currentUser (identity-agnostic clean-approve)", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "some-other-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Reviewed the diff for correctness and style. Everything checks out, no issues found.\n\nVerdict: APPROVE",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when self-authored review coexists with a different reviewer's CHANGES_REQUESTED finding", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  // ─── Self-review with real findings still counts (CPF-1.2) ────────────────

  test("exits 0 when self-authored COMMENTED review at current HEAD has a non-APPROVE body with a real finding", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when self-authored review at a stale commit has a non-APPROVE body with merge-only commits since", async () => {
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "review-sha" }, // posted before the merge commit
            body: "Verdict: COMMENT — found a race condition in the retry logic, needs a fix before merge.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const commits: CommitInfo[] = [
      { sha: "review-sha", parents: [{ sha: "p0" }] },
      { sha: "merge-sha", parents: [{ sha: "a" }, { sha: "b" }] }, // merge commit
    ];
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  // ─── Bold-wrapped self-APPROVE verdicts (CPF-1.3) ──────────────────────────

  test("exits 1 when only review is self-authored COMMENTED at current HEAD with a bold-wrapped APPROVE verdict", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  // ─── Narrative "Verdict: APPROVE" self-reviews (CPF-2.1) ───────────────────

  test("exits 1 when only review is self-authored COMMENTED at current HEAD with a narrative ending in Verdict: APPROVE", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when self-authored review trails reasoning after Verdict: APPROVE on the same line (verbatim shipwright PR #1272 case)", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when a narrative Verdict: APPROVE self-review coexists with a different reviewer's CHANGES_REQUESTED finding", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when self-authored review has a narrative ending in Verdict: CHANGES_REQUESTED", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  // ─── Third-party review addressed via author reply (CPF-2.3) ──────────────

  test("exits 1 when a third-party COMMENTED review's non-empty body is followed by a PR-author reply (mirrors PR #1432)", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "dodizzle" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Missing plugin.json/marketplace.json version bump.",
          },
        ],
      },
      reviewThreads: { nodes: [] }, // all inline threads resolved (none outstanding)
      comments: {
        nodes: [
          {
            author: { login: "the-agent" },
            body: "Verified this is a false positive — no version bump needed here; resolved the thread.",
            createdAt: "2026-05-26T11:00:00Z", // after the review's submittedAt
          },
        ],
      },
    });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when the PR-author's reply predates the review (stale reply doesn't address a later review)", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "dodizzle" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Missing plugin.json/marketplace.json version bump.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
      comments: {
        nodes: [
          {
            author: { login: "the-agent" },
            body: "Unrelated earlier comment.",
            createdAt: "2026-05-26T09:00:00Z", // before the review's submittedAt
          },
        ],
      },
    });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when a third-party review has a non-empty body, no unresolved threads, and no PR-author reply at all", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "dodizzle" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Missing plugin.json/marketplace.json version bump.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] }, // no reply at all — regression guard for current behavior
    });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when a third-party review's body is followed by an author reply BUT an inline thread is still unresolved", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "dodizzle" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Missing plugin.json/marketplace.json version bump.",
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [{ author: { login: "dodizzle" }, body: "Still open" }],
            },
          },
        ],
      },
      comments: {
        nodes: [
          {
            author: { login: "the-agent" },
            body: "Replied, but forgot to resolve the thread.",
            createdAt: "2026-05-26T11:00:00Z",
          },
        ],
      },
    });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when the PR-level reply is from someone other than the PR author", async () => {
    const pr = makeOwnPr();
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "dodizzle" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Missing plugin.json/marketplace.json version bump.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
      comments: {
        nodes: [
          {
            author: { login: "some-other-reviewer" },
            body: "I agree with dodizzle's point, though I'm not the PR author.",
            createdAt: "2026-05-26T11:00:00Z",
          },
        ],
      },
    });
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => [],
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 1 for hasMergeOnlyStaleFindings when a stale third-party review's body is followed by a PR-author reply after it", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 for hasMergeOnlyStaleFindings when a stale third-party review's body has no PR-author reply", async () => {
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
    const result = await run(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: { 10: reviewData },
        ciStatusByPr: {},
        mergeStatusByPr: {},
        listPrCommits: async () => commits,
        getCurrentUser: () => "the-agent",
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });
});

// ─── hasFailingCi (CPC-1.1) ────────────────────────────────────────────────────

describe("hasFailingCi", () => {
  test("returns false when a workflow's earlier run failed but a later rerun (same workflow_id, higher run_number) succeeded", () => {
    // Mirrors app-vitals/shipwright#1045: pr-title-lint run #2131 (workflow_id
    // 290585892) failed, was rerun as run #2132 (same workflow_id, same SHA)
    // and passed. Only the latest run per workflow should count.
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
