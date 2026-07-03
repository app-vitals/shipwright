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
import { run } from "./check-patch.ts";

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
  isBehind: boolean;
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
  updateBranch: (
    org: string,
    repo: string,
    pr: number,
  ) => Promise<void> = async () => {},
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
      return mergeStatusByPr[pr] ?? { isBehind: false, isDirty: false };
    },
    updateBranch,
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
    // PR 10 is clean (no findings, no failing CI, not behind) — continues to PR 11
    // PR 11 has findings — triggers patch (exit 0)
    const result = await run(makeDeps(prs, reviewDataMap));
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 when multiple PRs and one has unaddressed findings AND another is behind main", async () => {
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
    // PR 10 is BEHIND main — branch silently synced, loop continues
    // PR 11 has findings — triggers patch (exit 0)
    const result = await run(
      makeDeps(
        prs,
        reviewDataMap,
        {},
        { 10: { isBehind: true, isDirty: false } },
      ),
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

  test("calls updateBranch and exits 1 when PR is BEHIND with no other issues", async () => {
    const pr = makeOwnPr({ number: 10 });
    const updated: number[] = [];
    const result = await run(
      makeDeps(
        [pr],
        {},
        {},
        { 10: { isBehind: true, isDirty: false } },
        async (_org, _repo, prNum) => {
          updated.push(prNum);
        },
      ),
    );
    expect(updated).toContain(10);
    expect(result.exit).toBe(1);
  });

  test("calls updateBranch then exits 0 when PR is BEHIND with failing CI", async () => {
    const pr = makeOwnPr({ number: 10 });
    const updated: number[] = [];
    const result = await run(
      makeDeps(
        [pr],
        {},
        { 10: { hasFailing: true } },
        { 10: { isBehind: true, isDirty: false } },
        async (_org, _repo, prNum) => {
          updated.push(prNum);
        },
      ),
    );
    expect(updated).toContain(10);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("calls updateBranch then exits 0 when PR is BEHIND with unaddressed review findings", async () => {
    const pr = makeOwnPr({ number: 10 });
    const reviewData = makePrReviewData({
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix this",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    const updated: number[] = [];
    const result = await run(
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        { 10: { isBehind: true, isDirty: false } },
        async (_org, _repo, prNum) => {
          updated.push(prNum);
        },
      ),
    );
    // Branch is silently synced; findings trigger patch (exit 0)
    expect(updated).toContain(10);
    expect(result.exit).toBe(0);
    expect(result.output).toContain("patch");
  });

  test("exits 0 (patch-worthy) when updateBranch fails and no other issues", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps(
        [pr],
        {},
        {},
        { 10: { isBehind: true, isDirty: false } },
        async () => {
          throw new Error("update failed");
        },
      ),
    );
    expect(result.exit).toBe(0);
  });

  test("exits 1 when PR has no findings, green CI, and is up to date", async () => {
    const pr = makeOwnPr({ number: 10 });
    const result = await run(
      makeDeps(
        [pr],
        {},
        { 10: { hasFailing: false } },
        { 10: { isBehind: false, isDirty: false } },
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
        { 10: { isBehind: false, isDirty: true } },
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => {},
        async () => commits,
      ),
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => {},
        async () => commits,
      ),
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => {},
        async () => commits,
      ),
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => {},
        async () => commits,
      ),
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
        async () => {},
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
        async () => {},
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
        async () => {},
        async () => [],
        () => "the-agent",
      ),
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => {},
        async () => [],
        () => "the-agent",
      ),
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => {},
        async () => commits,
        () => "the-agent",
      ),
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
      makeDeps(
        [pr],
        { 10: reviewData },
        {},
        {},
        async () => {},
        async () => [],
        () => "the-agent",
      ),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});
