/**
 * plugins/shipwright/scripts/check-patch.test.ts
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

interface PrReviewData {
  headRefOid: string;
  reviews: { nodes: ReviewNode[] };
  reviewThreads: { nodes: ReviewThread[] };
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
    ...overrides,
  };
}

function makeDeps(
  ownPrs: OwnPr[],
  reviewDataByPr: Record<number, PrReviewData>,
  ciStatusByPr: Record<number, CiCheckStatus> = {},
  mergeStatusByPr: Record<number, MergeStatusInfo> = {},
  listPrCommits: (_prNumber: number) => Promise<CommitInfo[]> = async () => [],
  getCurrentUser: () => string = () => "the-agent",
) {
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
    const result = await run(makeDeps([], {}));
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
    const result = await run(makeDeps([pr], { 10: reviewData }));
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
    const result = await run(makeDeps([pr], { 10: reviewData }));
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
    const result = await run(makeDeps([pr], { 10: reviewData }));
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
    const result = await run(makeDeps([pr], { 10: reviewData }));
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
    const result = await run(makeDeps([pr], { 10: reviewData }));
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
    const result = await run(makeDeps([pr], { 10: reviewData }));
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
    const result = await run(makeDeps(prs, reviewDataMap));
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
      makeDeps(prs, reviewDataMap, {}, { 10: { isDirty: false } }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("prompt mentions shipwright:patch when PR has failing CI", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(makeDeps([pr], {}, { 10: { hasFailing: true } }));
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
      makeDeps([pr], { 10: reviewData }, { 10: { hasFailing: true } }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when own PR has failing CI checks", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(makeDeps([pr], {}, { 10: { hasFailing: true } }));
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 1 when PR is merely behind main (not dirty) with no other issues", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps([pr], {}, {}, { 10: { isDirty: false } }),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when PR has no findings, green CI, and no merge conflict", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps(
        [pr],
        {},
        { 10: { hasFailing: false } },
        { 10: { isDirty: false } },
      ),
    );
    expect(result.exit).toBe(1);
  });

  test("exits 0 when own PR has DIRTY merge state", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps(
        [pr],
        {},
        { 10: { hasFailing: false } },
        { 10: { isDirty: true } },
      ),
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
      makeDeps([pr], { 10: reviewData }, {}, {}, async () => commits),
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
      makeDeps([pr], { 10: reviewData }, {}, {}, async () => commits),
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
      makeDeps([pr], { 10: reviewData }, {}, {}, async () => commits),
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
      makeDeps([pr], { 10: reviewData }, {}, {}, async () => commits),
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => [],
        () => "the-agent",
      ),
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => commits,
        () => "the-agent",
      ),
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => [],
        () => "the-agent",
      ),
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
