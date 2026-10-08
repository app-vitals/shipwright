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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitInfo, LinkedTaskInfo } from "./check-helpers.ts";
import {
  type CheckPatchDeps,
  type CiCheckStatus,
  type MergeStatusInfo,
  type OwnPr,
  type PrReviewData,
  buildProductionDeps,
  findCancelledRuns,
  getPatchCandidates,
  hasFailingCi,
} from "./check-patch.ts";
import { createPatchAuthorAllowlistRef } from "./patch-author-allowlist-ref.ts";

// ─── PHS-1.1 characterization inventory ─────────────────────────────────────
// Exclusion path -> tests. "EXISTING" = pre-PHS-1.1 (by name); "PHS-1.1" =
// the "getPatchCandidates — PHS-1.1 characterization" describe at file bottom.
// The pure hasUnaddressedFindings matrix lives in
// plugins/shipwright/scripts/compute-unaddressed-findings.unit.test.ts (its
// header maps those); here we pin the getPatchCandidates/hasMergeOnlyStaleFindings
// wiring.
//
// Head-level exclusions reached through getPatchCandidates:
//   PSL-1.1 same-head approval: EXISTING "is not a candidate when a body-only
//     COMMENTED review is followed by the same reviewer's same-head APPROVED".
//   CPF-2.1/PFL-5.1 self clean-APPROVE, empty ledger: EXISTING "self-authored
//     clean-APPROVE at current HEAD with no task-store record ...".
//   DRO-1.2/PFL-5.1 self-review supersede, empty ledger: PHS-1.1.
//   PFL-3.2/5.3 ledger via record.findings: EXISTING "a qualifying THIRD-PARTY
//     review with a matching ... ledger entry ...", "does NOT exclude ... non-matching
//     ref"; PHS-1.1 adds source:patch / rejected via the record, and an allowlisted PR.
//   CPF-2.3 author reply (self-authored): EXISTING "self-authored PR: prAuthor still
//     defaults to currentUser".
//   URT-1.1 thread reply: PHS-1.1 (own PR, allowlisted PR real author, allowlisted PR
//     agent reply). NOTE: production fetchPrReviews requests comments(first: 1) with
//     no createdAt, so URT-1.1 can never fire from buildProductionDeps data; these
//     tests inject richer data.
// prAuthor vs currentUser (RAS-1.1 / DBR-1.4 / ok-wow-agency PR #80 incident):
//   EXISTING "allowlisted PR: a reply from the REAL author ...", "... a comment from the
//     AGENT (not the PR author) does not address ...", "... hasMergeOnlyStaleFindings also
//     uses the real author ...".
//   PHS-1.1: allowlisted PR keeps isSelfCleanApprove keyed on currentUser (agent's own
//     clean approve), authorLogin on candidates.
// hasMergeOnlyStaleFindings (stale commit, merge-only since):
//   EXISTING CPF-1.1/1.2 self clean-APPROVE vs real-finding tests, third-party author
//     reply (CPF-2.3) both directions, anchor sort, unresolved-thread test.
//   PHS-1.1 pins what the stale path does NOT apply: ledger, URT-1.1 thread replies,
//     DRO-1.2 supersede, PSL-1.1 same-head approval (each still yields a candidate).

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
  queryTaskStatus?: (
    repo: string,
    prNumber: number,
  ) => Promise<LinkedTaskInfo | null>;
  isBundleComplete?: (branch: string) => Promise<boolean>;
  /**
   * PRs authored by allowlisted (non-self) logins (DBR-1.4) — wired into the
   * new listAllowlistedOpenPrs dep. Defaults to [] so all pre-existing tests
   * (which never set this) keep exercising the empty-allowlist / self-authored-
   * only default behavior unchanged.
   */
  allowlistedPrs?: OwnPr[];
}

function makeDeps({
  ownPrs,
  reviewDataByPr,
  ciStatusByPr = {},
  mergeStatusByPr = {},
  listPrCommits = async () => [],
  getCurrentUser = async () => "the-agent",
  getScopedRepos = () => [...new Set(ownPrs.map((pr) => pr.repo))],
  queryTaskStatus = async () => null,
  isBundleComplete,
  allowlistedPrs = [],
}: MakeDepsOptions): CheckPatchDeps {
  return {
    listOwnOpenPrs: async (_repo: string) => ownPrs,
    listAllowlistedOpenPrs: async (_repo: string) => allowlistedPrs,
    getScopedRepos,
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

  test("is not a candidate when a body-only COMMENTED review is followed by the same reviewer's same-head APPROVED (PSL-1.1)", async () => {
    const pr = makeOwnPr({ number: 12, headRefOid: "sha-approved" });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {
          12: makePrReviewData({
            headRefOid: "sha-approved",
            reviews: {
              nodes: [
                {
                  author: { login: "reviewer1" },
                  state: "COMMENTED",
                  submittedAt: "2026-05-26T10:00:00Z",
                  commit: { oid: "sha-approved" },
                  body: "Body-only finding",
                },
                {
                  author: { login: "reviewer1" },
                  state: "APPROVED",
                  submittedAt: "2026-05-26T11:00:00Z",
                  commit: { oid: "sha-approved" },
                  body: "",
                },
              ],
            },
          }),
        },
      }),
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

  test("with multiple stale reviews, anchors on the most recently submitted one (sort comparator)", async () => {
    // Two stale (non-head-commit) reviews with findings, submitted at
    // different times and different commits — hasMergeOnlyStaleFindings
    // must sort by submittedAt desc and use the LATEST one's commit as the
    // isMergeOnlyUpdate anchor. Exercises the multi-element branch of the
    // `[...staleReviews].sort(...)` comparator, which a single-review
    // fixture never reaches.
    const pr = makeOwnPr({ headRefOid: "merge-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "merge-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-20T10:00:00Z",
            commit: { oid: "older-review-sha" },
            body: "Earlier finding",
          },
          {
            author: { login: "reviewer2" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "newer-review-sha" },
            body: "Later finding",
          },
        ],
      },
      reviewThreads: { nodes: [] },
    });
    // Commits since the LATEST stale review's commit (newer-review-sha) are
    // all merge-only — this must qualify. If the comparator anchored on the
    // wrong (older) review's commit instead, isMergeOnlyUpdate would see a
    // different (non-merge-only) commit range and behavior could differ.
    const commits: CommitInfo[] = [
      { sha: "older-review-sha", parents: [{ sha: "p0" }] },
      { sha: "newer-review-sha", parents: [{ sha: "p1" }] },
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

  // ─── PTL-1.1: bundle-mate (multi-task-per-PR) OR-blocked exclusion ────────
  //
  // A PR can be linked to more than one task-store task (a bundle). These
  // exercise getPatchCandidates' consumption of the queryTaskStatus result
  // the way createTaskStatusQuery now returns it — merged/OR'd across every
  // matched task — so the caller correctly excludes on a bundle-mate's
  // hitl/blocked signal even though the PR's "own" task looks eligible.

  test("a PR whose bundle-mate task (not its own task) is hitl:true is excluded from patch candidacy", async () => {
    const pr = makeOwnPr({ number: 10 });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    // Simulates createTaskStatusQuery's merged result: the PR's own task is
    // pr_open/hitl:false, but a bundle-mate is hitl:true, so the merged
    // LinkedTaskInfo reports hitl:true.
    deps.queryTaskStatus = async () => ({
      status: "pr_open",
      createdAt: "2026-05-01T00:00:00.000Z",
      hitl: true,
    });
    const result = await getPatchCandidates(deps);
    expect(result).toHaveLength(0);
  });

  test("a PR whose bundle-mate task (not its own task) has status:'blocked' is excluded from patch candidacy", async () => {
    const pr = makeOwnPr({ number: 10 });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    // Simulates createTaskStatusQuery's merged result: the PR's own task is
    // pr_open, but a bundle-mate is status:blocked, so the merged
    // LinkedTaskInfo's status is surfaced as "blocked".
    deps.queryTaskStatus = async () => ({
      status: "blocked",
      createdAt: "2026-05-01T00:00:00.000Z",
      hitl: false,
    });
    const result = await getPatchCandidates(deps);
    expect(result).toEqual([]);
  });

  test("a PR with two linked tasks where neither bundle-mate is hitl/blocked is still an eligible candidate", async () => {
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

  // ─── task-store ledger findings wiring (PFL-5.3) ──────────────────────────

  test("self-authored clean-APPROVE at current HEAD with no task-store record (empty ledger) is still not a candidate", async () => {
    // Regression guard for the incident PR's exact shape: no ledger entry
    // exists at all (queryPrRecord resolves null), so this only passes
    // because of PFL-5.1's isSelfCleanApprove fallback — proving the two
    // fixes compose correctly, not just that PFL-5.3's wiring alone works.
    const pr = makeOwnPr({ number: 10, headRefOid: "current-head-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verdict: APPROVE — looks good, no changes needed.",
          },
        ],
      },
    });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: { 10: reviewData },
      getCurrentUser: async () => "the-agent",
    });
    deps.queryPrRecord = async () => null;
    const result = await getPatchCandidates(deps);
    expect(result).toEqual([]);
  });

  test("a qualifying THIRD-PARTY review with a matching source:review/resolved ledger entry on the PR record is excluded (proves the wiring, not the PFL-5.1 fallback)", async () => {
    // A third-party (non-self-authored) review is never touched by
    // isSelfCleanApprove/isSupersededBySelfReview — only isResolvedByLedger
    // can exclude it. If this passes, record.findings actually reached
    // hasUnaddressedFindings via the PFL-5.3 wiring, not via the fallback.
    const pr = makeOwnPr({ number: 10, headRefOid: "current-head-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix the retry logic before merging.",
          },
        ],
      },
    });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: { 10: reviewData },
      getCurrentUser: async () => "the-agent",
    });
    deps.queryPrRecord = async () => ({
      findings: [
        {
          id: "f1",
          prRecordId: "pr1",
          ref: "current-head-sha@2026-05-26T10:00:00Z",
          disposition: "resolved",
          source: "review",
          evidence: "Fixed in a follow-up commit reviewed separately.",
          at: "2026-05-27T00:00:00Z",
          createdAt: "2026-05-27T00:00:00Z",
        },
      ],
    });
    const result = await getPatchCandidates(deps);
    expect(result).toEqual([]);
  });

  test("does NOT exclude a qualifying review when the PR record's ledger entry has a non-matching ref (wiring reaches hasUnaddressedFindings but the entry doesn't apply)", async () => {
    const pr = makeOwnPr({ number: 10, headRefOid: "current-head-sha" });
    const reviewData = makePrReviewData({
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix the retry logic before merging.",
          },
        ],
      },
    });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: { 10: reviewData },
      getCurrentUser: async () => "the-agent",
    });
    deps.queryPrRecord = async () => ({
      findings: [
        {
          id: "f1",
          prRecordId: "pr1",
          ref: "some-other-commit@2026-01-01T00:00:00Z",
          disposition: "resolved",
          source: "review",
          evidence: "Unrelated finding.",
          at: "2026-05-27T00:00:00Z",
          createdAt: "2026-05-27T00:00:00Z",
        },
      ],
    });
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

  test("getScopedRepos() returning an empty array filters out all PRs — no-op, no crash", async () => {
    const pr = makeOwnPr({ number: 10, repo: "example-org/some-repo" });
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [pr],
        reviewDataByPr: {},
        ciStatusByPr: { 10: { hasFailing: true } },
        getScopedRepos: () => [],
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

const skipBlocked: Record<string, unknown> = {
  id: "pr-rec-1",
  blocked: true,
  blockedReason:
    "Auto-blocked after 3 consecutive skips (dispatched but found nothing to do)",
  blockedHeadSha: "old-sha",
  blockedReviewId: null,
};

describe("getPatchCandidates skip-block auto-clear (PSL-3.2)", () => {
  function setup(record: Record<string, unknown>, resetFails = false) {
    const pr = makeOwnPr({ number: 10, headRefOid: "new-sha" });
    const deps = makeDeps({
      ownPrs: [pr],
      reviewDataByPr: {},
      ciStatusByPr: { 10: { hasFailing: true } },
    });
    const resets: string[] = [];
    deps.queryPrRecord = async () => record as never;
    deps.resetSkip = async (id: string) => {
      resets.push(id);
      if (resetFails) throw new Error("boom");
    };
    return { deps, resets };
  }

  test("changed head SHA clears the block via resetSkip and the PR becomes a candidate", async () => {
    const { deps, resets } = setup(skipBlocked);
    const result = await getPatchCandidates(deps);
    expect(result.map((c) => c.id)).toEqual(["acme/example-repo#10"]);
    expect(resets).toEqual(["pr-rec-1"]);
  });

  test("a new review-source finding clears the block even at the same head", async () => {
    const { deps, resets } = setup({
      ...skipBlocked,
      blockedHeadSha: "new-sha",
      findings: [
        {
          id: "f-new",
          prRecordId: "pr-rec-1",
          ref: "x",
          disposition: "rejected",
          source: "review",
          evidence: "",
          at: "2026-10-07T18:39:00Z",
          createdAt: "2026-10-07T18:39:00Z",
        },
      ],
    });
    const result = await getPatchCandidates(deps);
    expect(result).toHaveLength(1);
    expect(resets).toEqual(["pr-rec-1"]);
  });

  test("unchanged state stays blocked", async () => {
    const { deps, resets } = setup({ ...skipBlocked, blockedHeadSha: "new-sha" });
    expect(await getPatchCandidates(deps)).toEqual([]);
    expect(resets).toEqual([]);
  });

  test("legacy block (null blockedHeadSha) stays blocked", async () => {
    const { deps, resets } = setup({ ...skipBlocked, blockedHeadSha: null });
    expect(await getPatchCandidates(deps)).toEqual([]);
    expect(resets).toEqual([]);
  });

  test("CI-streak block stays blocked", async () => {
    const { deps, resets } = setup({
      ...skipBlocked,
      blockedReason: "Auto-blocked after 3 consecutive CI failures",
    });
    expect(await getPatchCandidates(deps)).toEqual([]);
    expect(resets).toEqual([]);
  });

  test("resetSkip error stays blocked", async () => {
    const { deps } = setup(skipBlocked, true);
    expect(await getPatchCandidates(deps)).toEqual([]);
  });
});

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

// ─── getPatchCandidates — allowlisted authors (DBR-1.4) ───────────────────────
//
// Unlike check-review.ts's isAuthorAllowed (a FILTER on an existing broad
// candidate pool, fail-open when empty), patch's allowlist is an ADDITIVE
// SOURCE: listAllowlistedOpenPrs contributes MORE candidates on top of the
// existing self-authored-only list, and is skipped entirely (no gh calls,
// contributes nothing) when the allowlist is empty — preserving exact
// pre-DBR-1.4 self-authored-only behavior as the default.

describe("getPatchCandidates — allowlisted authors (DBR-1.4)", () => {
  const dirtyMergeStatus = (
    prNumber: number,
  ): Record<number, MergeStatusInfo> => ({
    [prNumber]: { isDirty: true },
  });

  test("empty allowlist (default): only self-authored PRs are returned, listAllowlistedOpenPrs contributes nothing", async () => {
    const ownPrs = [makeOwnPr({ number: 10, repo: "acme/example-repo" })];
    const deps = makeDeps({
      ownPrs,
      reviewDataByPr: {},
      mergeStatusByPr: dirtyMergeStatus(10),
      allowlistedPrs: [],
    });

    const result = await getPatchCandidates(deps);

    expect(result).toHaveLength(1);
    expect(result.map((c) => c.id)).toEqual(["acme/example-repo#10"]);
  });

  test("non-empty allowlist: PRs from listAllowlistedOpenPrs merge into the candidate list alongside self-authored PRs", async () => {
    const ownPr = makeOwnPr({
      number: 10,
      repo: "acme/example-repo",
      headRefOid: "own-sha",
    });
    const allowlistedPr = makeOwnPr({
      number: 20,
      repo: "acme/example-repo",
      title: "Someone else's feature",
      headRefOid: "allowlisted-sha",
    });
    const deps = makeDeps({
      ownPrs: [ownPr],
      reviewDataByPr: {},
      mergeStatusByPr: { 10: { isDirty: true }, 20: { isDirty: true } },
      allowlistedPrs: [allowlistedPr],
      getScopedRepos: () => ["acme/example-repo"],
    });

    const result = await getPatchCandidates(deps);

    expect(result.map((c) => c.id).sort()).toEqual([
      "acme/example-repo#10",
      "acme/example-repo#20",
    ]);
  });

  test("dedup: the same (repo, PR number) returned by both listOwnOpenPrs and listAllowlistedOpenPrs appears only once", async () => {
    const sharedPr = makeOwnPr({
      number: 10,
      repo: "acme/example-repo",
      headRefOid: "shared-sha",
    });
    const deps = makeDeps({
      ownPrs: [sharedPr],
      reviewDataByPr: {},
      mergeStatusByPr: dirtyMergeStatus(10),
      // Same (repo, number) shows up in both sources — e.g. the current user
      // is also present in the allowlist, or a race between the two queries.
      allowlistedPrs: [sharedPr],
      getScopedRepos: () => ["acme/example-repo"],
    });

    const result = await getPatchCandidates(deps);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("acme/example-repo#10");
  });

  // ─── prAuthor threading (RAS-1.1 × DBR-1.4) ───────────────────────────────
  //
  // Every test above short-circuits on mergeStatus.isDirty, so none of them
  // reach the review-findings path. These do (isDirty: false), and they are
  // what actually pins the OwnPr.author → reviewData.prAuthor threading:
  // without it, `prAuthor` silently defaults to `currentUser` (the agent),
  // and an allowlisted PR's author-reply exclusions compare against the
  // WRONG identity in both directions — a genuine author reply is never
  // recognized (PR stuck as a permanent patch candidate) and the agent's own
  // comment is misread as an author reply (real finding wrongly suppressed).

  const reviewWithBody = (login: string, submittedAt: string, oid: string) => ({
    author: { login },
    state: "COMMENTED",
    submittedAt,
    commit: { oid },
    body: "Please rename this variable",
  });

  test("allowlisted PR: a reply from the REAL author after a review addresses the finding (no patch needed)", async () => {
    const allowlistedPr = makeOwnPr({
      number: 20,
      repo: "acme/example-repo",
      title: "Someone else's feature",
      headRefOid: "allowlisted-sha",
      author: "allowlisted-one",
    });
    const deps = makeDeps({
      ownPrs: [],
      allowlistedPrs: [allowlistedPr],
      getScopedRepos: () => ["acme/example-repo"],
      // Reaches the review-findings path instead of short-circuiting.
      mergeStatusByPr: { 20: { isDirty: false } },
      reviewDataByPr: {
        20: makePrReviewData({
          headRefOid: "allowlisted-sha",
          reviews: {
            nodes: [
              reviewWithBody(
                "reviewer1",
                "2026-05-26T10:00:00Z",
                "allowlisted-sha",
              ),
            ],
          },
          comments: {
            nodes: [
              {
                author: { login: "allowlisted-one" },
                body: "Renamed, thanks.",
                createdAt: "2026-05-26T11:00:00Z",
              },
            ],
          },
        }),
      },
    });

    const result = await getPatchCandidates(deps);

    expect(result).toEqual([]);
  });

  test("allowlisted PR: a comment from the AGENT (not the PR author) does not address the finding", async () => {
    const allowlistedPr = makeOwnPr({
      number: 20,
      repo: "acme/example-repo",
      headRefOid: "allowlisted-sha",
      author: "allowlisted-one",
    });
    const deps = makeDeps({
      ownPrs: [],
      allowlistedPrs: [allowlistedPr],
      getScopedRepos: () => ["acme/example-repo"],
      mergeStatusByPr: { 20: { isDirty: false } },
      reviewDataByPr: {
        20: makePrReviewData({
          headRefOid: "allowlisted-sha",
          reviews: {
            nodes: [
              reviewWithBody(
                "reviewer1",
                "2026-05-26T10:00:00Z",
                "allowlisted-sha",
              ),
            ],
          },
          comments: {
            nodes: [
              {
                // The agent itself commented — NOT the PR author, so this
                // must not suppress a real finding.
                author: { login: "the-agent" },
                body: "Taking a look.",
                createdAt: "2026-05-26T11:00:00Z",
              },
            ],
          },
        }),
      },
    });

    const result = await getPatchCandidates(deps);

    expect(result.map((c) => c.id)).toEqual(["acme/example-repo#20"]);
  });

  test("allowlisted PR: hasMergeOnlyStaleFindings also uses the real author for the reply exclusion", async () => {
    const allowlistedPr = makeOwnPr({
      number: 20,
      repo: "acme/example-repo",
      headRefOid: "head-sha",
      author: "allowlisted-one",
    });
    const deps = makeDeps({
      ownPrs: [],
      allowlistedPrs: [allowlistedPr],
      getScopedRepos: () => ["acme/example-repo"],
      mergeStatusByPr: { 20: { isDirty: false } },
      reviewDataByPr: {
        20: makePrReviewData({
          headRefOid: "head-sha",
          reviews: {
            nodes: [
              // Stale review (commit oid !== headRefOid) with no unresolved
              // threads — only the body can carry the finding, so the
              // author-reply exclusion is the sole thing gating candidacy.
              reviewWithBody(
                "reviewer1",
                "2026-05-26T10:00:00Z",
                "stale-sha",
              ),
            ],
          },
          comments: {
            nodes: [
              {
                author: { login: "allowlisted-one" },
                body: "Renamed, thanks.",
                createdAt: "2026-05-26T11:00:00Z",
              },
            ],
          },
        }),
      },
      // Merge-only update since the stale review — so if the reply exclusion
      // were evaluated against the wrong identity, this PR WOULD qualify.
      listPrCommits: async () => [
        { sha: "stale-sha", parents: [{ sha: "p1" }] },
        { sha: "head-sha", parents: [{ sha: "p1" }, { sha: "p2" }] },
      ],
    });

    const result = await getPatchCandidates(deps);

    expect(result).toEqual([]);
  });

  test("self-authored PR: prAuthor still defaults to currentUser (unchanged pre-DBR-1.4 behavior)", async () => {
    // No `author` field — listOwnOpenPrs never sets one, so the agent's own
    // reply must keep addressing the finding exactly as before.
    const ownPr = makeOwnPr({ number: 10, headRefOid: "own-sha" });
    const deps = makeDeps({
      ownPrs: [ownPr],
      getScopedRepos: () => ["acme/example-repo"],
      mergeStatusByPr: { 10: { isDirty: false } },
      reviewDataByPr: {
        10: makePrReviewData({
          headRefOid: "own-sha",
          reviews: {
            nodes: [
              reviewWithBody("reviewer1", "2026-05-26T10:00:00Z", "own-sha"),
            ],
          },
          comments: {
            nodes: [
              {
                author: { login: "the-agent" },
                body: "Renamed, thanks.",
                createdAt: "2026-05-26T11:00:00Z",
              },
            ],
          },
        }),
      },
    });

    const result = await getPatchCandidates(deps);

    expect(result).toEqual([]);
  });
});

// ─── PHS-1.1 characterization ─────────────────────────────────────────────────

describe("getPatchCandidates — PHS-1.1 characterization", () => {
  const HEAD = "current-head-sha";
  const rev = (overrides: Record<string, unknown> = {}) => ({
    author: { login: "reviewer1" },
    state: "COMMENTED",
    submittedAt: "2026-05-26T10:00:00Z",
    commit: { oid: HEAD },
    body: "Please fix this.",
    ...overrides,
  });
  const ledgerEntry = (ref: string, overrides: Record<string, unknown> = {}) => ({
    id: "f1",
    prRecordId: "pr1",
    ref,
    disposition: "resolved" as const,
    source: "review" as const,
    evidence: "e",
    at: "2026-05-27T00:00:00Z",
    createdAt: "2026-05-27T00:00:00Z",
    ...overrides,
  });
  const threadWith = (
    comments: Array<{ login: string; createdAt: string }>,
  ) => ({
    isResolved: false,
    comments: {
      nodes: comments.map((c) => ({
        author: { login: c.login },
        body: "x",
        createdAt: c.createdAt,
      })),
    },
  });
  const run = (
    reviewData: PrReviewData,
    opts: Partial<MakeDepsOptions> & {
      record?: Parameters<NonNullable<CheckPatchDeps["queryPrRecord"]>> extends unknown
        ? Awaited<ReturnType<NonNullable<CheckPatchDeps["queryPrRecord"]>>>
        : never;
    } = {},
  ) => {
    const { record, ...rest } = opts;
    const deps = makeDeps({
      ownPrs: [makeOwnPr({ number: 10, headRefOid: reviewData.headRefOid })],
      reviewDataByPr: { 10: reviewData },
      ...rest,
    });
    if (record !== undefined) deps.queryPrRecord = async () => record;
    return getPatchCandidates(deps);
  };
  const mergeOnly = (stale: string, head: string) => async () => [
    { sha: stale, parents: [{ sha: "p0" }] },
    { sha: head, parents: [{ sha: "a" }, { sha: "b" }] },
  ];

  // --- head-level ---

  test("DRO-1.2/PFL-5.1: earlier self COMMENT superseded by a later clean self-review is not a candidate with an empty ledger", async () => {
    const result = await run(
      makePrReviewData({
        headRefOid: HEAD,
        reviews: {
          nodes: [
            rev({
              author: { login: "the-agent" },
              body: "Verdict: COMMENT — bug.",
            }),
            rev({
              author: { login: "the-agent" },
              body: "Verdict: APPROVE",
              submittedAt: "2026-05-26T11:00:00Z",
            }),
          ],
        },
      }),
      { record: null },
    );
    expect(result).toEqual([]);
  });

  test("PFL-3.2: ledger entries with source:patch or disposition:rejected on the PR record do NOT exclude a third-party review", async () => {
    const ref = `${HEAD}@2026-05-26T10:00:00Z`;
    for (const override of [{ source: "patch" }, { disposition: "rejected" }]) {
      const result = await run(
        makePrReviewData({ headRefOid: HEAD, reviews: { nodes: [rev()] } }),
        { record: { findings: [ledgerEntry(ref, override)] } as never },
      );
      expect(result).toHaveLength(1);
    }
  });

  test("URT-1.1: own PR — an unresolved thread the agent (= PR author) replied to after the flag is not a candidate", async () => {
    const result = await run(
      makePrReviewData({
        headRefOid: HEAD,
        reviews: { nodes: [rev({ body: "" })] },
        reviewThreads: {
          nodes: [
            threadWith([
              { login: "reviewer1", createdAt: "2026-05-26T10:00:00Z" },
              { login: "the-agent", createdAt: "2026-05-26T11:00:00Z" },
            ]),
          ],
        },
      }),
    );
    expect(result).toEqual([]);
  });

  test("URT-1.1 x DBR-1.4: allowlisted PR — a thread reply by the REAL author addresses the thread; a reply by the agent does not", async () => {
    const mk = (replier: string) =>
      makePrReviewData({
        headRefOid: "allow-sha",
        reviews: { nodes: [rev({ body: "", commit: { oid: "allow-sha" } })] },
        reviewThreads: {
          nodes: [
            threadWith([
              { login: "reviewer1", createdAt: "2026-05-26T10:00:00Z" },
              { login: replier, createdAt: "2026-05-26T11:00:00Z" },
            ]),
          ],
        },
      });
    const go = (replier: string) =>
      getPatchCandidates(
        makeDeps({
          ownPrs: [],
 getScopedRepos: () => ["acme/example-repo"],
          allowlistedPrs: [
            makeOwnPr({ number: 20, headRefOid: "allow-sha", author: "allowlisted-one" }),
          ],
          reviewDataByPr: { 20: mk(replier) },
        }),
      );
    expect(await go("allowlisted-one")).toEqual([]);
    expect(await go("the-agent")).toHaveLength(1);
  });

  test("PFL-3.2 x DBR-1.4: allowlisted PR — a ledger entry on the PR record excludes the third-party review", async () => {
    const reviewData = makePrReviewData({
      headRefOid: "allow-sha",
      reviews: { nodes: [rev({ commit: { oid: "allow-sha" } })] },
    });
    const deps = makeDeps({
      ownPrs: [],
 getScopedRepos: () => ["acme/example-repo"],
      allowlistedPrs: [
        makeOwnPr({ number: 20, headRefOid: "allow-sha", author: "allowlisted-one" }),
      ],
      reviewDataByPr: { 20: reviewData },
    });
    deps.queryPrRecord = async () => ({
      findings: [ledgerEntry("allow-sha@2026-05-26T10:00:00Z")],
    });
    expect(await getPatchCandidates(deps)).toEqual([]);
  });

  test("RAS-1.1 x CPF-2.1: allowlisted PR — the agent's OWN clean self-approve is still excluded (keyed on currentUser, not prAuthor)", async () => {
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [],
 getScopedRepos: () => ["acme/example-repo"],
        allowlistedPrs: [
          makeOwnPr({ number: 20, headRefOid: "allow-sha", author: "allowlisted-one" }),
        ],
        reviewDataByPr: {
          20: makePrReviewData({
            headRefOid: "allow-sha",
            reviews: {
              nodes: [
                rev({
                  author: { login: "the-agent" },
                  body: "Verdict: APPROVE",
                  commit: { oid: "allow-sha" },
                }),
              ],
            },
          }),
        },
      }),
    );
    expect(result).toEqual([]);
  });

  test("DBR-1.4: candidate authorLogin is the allowlisted author for allowlisted PRs and undefined for self-authored PRs", async () => {
    const result = await getPatchCandidates(
      makeDeps({
        ownPrs: [makeOwnPr({ number: 10 })],
        allowlistedPrs: [makeOwnPr({ number: 20, author: "allowlisted-one" })],
        reviewDataByPr: {},
        mergeStatusByPr: { 10: { isDirty: true }, 20: { isDirty: true } },
      }),
    );
    const byId = Object.fromEntries(result.map((c) => [c.id, c.authorLogin]));
    expect(byId["acme/example-repo#10"]).toBeUndefined();
    expect(byId["acme/example-repo#20"]).toBe("allowlisted-one");
  });

  // --- stale-commit / merge-only path: exclusions it does NOT apply ---
  // NOTE: these pin asymmetries between hasUnaddressedFindings and
  // hasMergeOnlyStaleFindings. They may be unintended but are pinned as-is.

  test("stale path does not consult the ledger: a ledger-resolved stale third-party review with merge-only commits since is still a candidate", async () => {
    const result = await run(
      makePrReviewData({
        headRefOid: "merge-sha",
        reviews: { nodes: [rev({ commit: { oid: "stale-sha" } })] },
      }),
      {
        record: {
          findings: [ledgerEntry("stale-sha@2026-05-26T10:00:00Z")],
        } as never,
        listPrCommits: mergeOnly("stale-sha", "merge-sha"),
      },
    );
    expect(result).toHaveLength(1);
  });

  test("stale path does not apply URT-1.1: an author-replied stale thread still counts as unresolved", async () => {
    const result = await run(
      makePrReviewData({
        headRefOid: "merge-sha",
        reviews: {
          nodes: [rev({ body: "", commit: { oid: "stale-sha" } })],
        },
        reviewThreads: {
          nodes: [
            threadWith([
              { login: "reviewer1", createdAt: "2026-05-26T10:00:00Z" },
              { login: "the-agent", createdAt: "2026-05-26T11:00:00Z" },
            ]),
          ],
        },
      }),
      { listPrCommits: mergeOnly("stale-sha", "merge-sha") },
    );
    expect(result).toHaveLength(1);
  });

  test("stale path does not apply DRO-1.2: an earlier self COMMENT with a real finding stays a stale finding even after a later clean self-review", async () => {
    const result = await run(
      makePrReviewData({
        headRefOid: "merge-sha",
        reviews: {
          nodes: [
            rev({
              author: { login: "the-agent" },
              body: "Verdict: COMMENT — bug.",
              commit: { oid: "stale-sha" },
            }),
            rev({
              author: { login: "the-agent" },
              body: "Verdict: APPROVE",
              submittedAt: "2026-05-26T11:00:00Z",
              commit: { oid: "stale-sha" },
            }),
          ],
        },
      }),
      { listPrCommits: mergeOnly("stale-sha", "merge-sha") },
    );
    expect(result).toHaveLength(1);
  });

  test("stale path does not apply PSL-1.1: a stale COMMENTED review followed by the same reviewer's same-head APPROVED is still a candidate", async () => {
    const result = await run(
      makePrReviewData({
        headRefOid: "merge-sha",
        reviews: {
          nodes: [
            rev({ commit: { oid: "stale-sha" } }),
            rev({
              state: "APPROVED",
              body: "",
              submittedAt: "2026-05-26T11:00:00Z",
              commit: { oid: "stale-sha" },
            }),
          ],
        },
      }),
      { listPrCommits: mergeOnly("stale-sha", "merge-sha") },
    );
    expect(result).toHaveLength(1);
  });
});

// ─── buildProductionDeps ────────────────────────────────────────────────────
//
// Exercises the closures buildProductionDeps wires up against a fake
// ghJson/ghGraphql (no real `gh` process, no real GitHub API) — the same
// injection pattern the rest of this file uses for getPatchCandidates. Only
// the deps' own request-shaping/response-parsing/error-fallback logic is
// under test here; downstream helpers they delegate to (hasFailingCi,
// findCancelledRuns, createPrRecordQuery, createTaskStatusQuery,
// createBundleCompleteQuery) are already covered by their own dedicated
// tests (above, and in check-helpers.unit.test.ts) and are not re-verified.
describe("buildProductionDeps", () => {
  let savedWorkspacePath: string | undefined;
  let savedAgentHome: string | undefined;

  beforeEach(() => {
    savedWorkspacePath = process.env.WORKSPACE_PATH;
    savedAgentHome = process.env.AGENT_HOME;
    // Point resolveWorkspacePath() at a directory with no repos/ subfolder,
    // so resolveAllRepos() deterministically returns [] regardless of what
    // this sandbox's real workspace layout looks like — listOwnOpenPrs then
    // maps over zero repos, which is fine since these tests call the other
    // deps functions directly, not listOwnOpenPrs's repo-scanning path.
    process.env.WORKSPACE_PATH = "/tmp/check-patch-buildProductionDeps-stub";
    delete process.env.AGENT_HOME;
  });

  afterEach(() => {
    if (savedWorkspacePath !== undefined) {
      process.env.WORKSPACE_PATH = savedWorkspacePath;
    } else {
      delete process.env.WORKSPACE_PATH;
    }
    if (savedAgentHome !== undefined) {
      process.env.AGENT_HOME = savedAgentHome;
    } else {
      delete process.env.AGENT_HOME;
    }
  });

  test("listOwnOpenPrs maps gh pr list output onto each scanned repo (empty repo scan → empty result)", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
      ghGraphql: async <T>() => ({}) as unknown as T,
      getCurrentUser: async () => "the-agent",
    });
    // resolveAllRepos() sees no repos/ dir under the stub workspace, so
    // mapReposTolerant has nothing to map over.
    expect(await deps.listOwnOpenPrs("default")).toEqual([]);
  });

  test("listOwnOpenPrs queries gh pr list for each scanned repo and tags each returned PR with its repo (real repos/ scan)", async () => {
    // Point WORKSPACE_PATH at a real scratch dir with one fake git clone so
    // resolveAllRepos() finds a non-empty repo list — exercises the
    // mapReposTolerant(...) closure body that the empty-scan test above
    // can't reach.
    const scratchDir = mkdtempSync(
      join(tmpdir(), "check-patch-listOwnOpenPrs-"),
    );
    try {
      const repoDir = join(scratchDir, "repos", "example-repo");
      mkdirSync(join(repoDir, ".git"), { recursive: true });
      writeFileSync(
        join(repoDir, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/example-repo.git\n`,
      );
      process.env.WORKSPACE_PATH = scratchDir;

      const seenArgs: string[][] = [];
      const deps = await buildProductionDeps({
        ghJson: async <T>(args: string[]) => {
          seenArgs.push(args);
          return [
            {
              number: 5,
              title: "Fix thing",
              headRefName: "fix/thing",
              headRefOid: "sha5",
              createdAt: "2026-05-01T00:00:00Z",
            },
          ] as unknown as T;
        },
        ghGraphql: async <T>() => ({}) as unknown as T,
        getCurrentUser: async () => "agent-login",
        // Explicit override so this test is deterministic regardless of the
        // shared agentReposRef singleton's live state in this Bun test
        // process (RSF-1.1: scoping now happens inside this closure, before
        // any gh call, so an unscoped default would otherwise make this
        // assertion depend on other test files' ref mutations).
        getScopedRepos: () => ["acme/example-repo"],
      });

      const prs = await deps.listOwnOpenPrs("default");

      expect(prs).toEqual([
        {
          number: 5,
          title: "Fix thing",
          headRefName: "fix/thing",
          headRefOid: "sha5",
          createdAt: "2026-05-01T00:00:00Z",
          repo: "acme/example-repo",
        },
      ]);
      expect(seenArgs).toHaveLength(1);
      expect(seenArgs[0]).toEqual([
        "pr",
        "list",
        "--state",
        "open",
        "--repo",
        "acme/example-repo",
        "--author",
        "agent-login",
        "--json",
        "number,title,headRefName,headRefOid,createdAt",
      ]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("listOwnOpenPrs never calls gh pr list for a repo returned by the filesystem scan but absent from getScopedRepos() (RSF-1.1)", async () => {
    // Two fake git clones under repos/ — only one is in the live scope.
    // Asserts the scoping happens BEFORE any gh call is issued, not just as
    // a post-filter on the result.
    const scratchDir = mkdtempSync(
      join(tmpdir(), "check-patch-listOwnOpenPrs-scoped-"),
    );
    try {
      for (const name of ["in-scope-repo", "out-of-scope-repo"]) {
        const repoDir = join(scratchDir, "repos", name);
        mkdirSync(join(repoDir, ".git"), { recursive: true });
        writeFileSync(
          join(repoDir, ".git", "config"),
          `[remote "origin"]\n\turl = https://github.com/acme/${name}.git\n`,
        );
      }
      process.env.WORKSPACE_PATH = scratchDir;

      const seenRepos: string[] = [];
      const deps = await buildProductionDeps({
        ghJson: async <T>(args: string[]) => {
          const repoIdx = args.indexOf("--repo");
          if (repoIdx !== -1) seenRepos.push(args[repoIdx + 1]);
          return [] as unknown as T;
        },
        ghGraphql: async <T>() => ({}) as unknown as T,
        getCurrentUser: async () => "agent-login",
        getScopedRepos: () => ["acme/in-scope-repo"],
      });

      await deps.listOwnOpenPrs("default");

      expect(seenRepos).toEqual(["acme/in-scope-repo"]);
      expect(seenRepos).not.toContain("acme/out-of-scope-repo");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("fetchPrReviews sends a GraphQL query and unwraps repository.pullRequest from the response", async () => {
    const fakePrData = {
      headRefOid: "abc123",
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
    };
    let seenQuery = "";
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
      ghGraphql: async <T>(query: string) => {
        seenQuery = query;
        return { data: { repository: { pullRequest: fakePrData } } } as T;
      },
      getCurrentUser: async () => "the-agent",
    });

    const result = await deps.fetchPrReviews("acme", "widgets", 42);

    expect(result).toEqual(fakePrData);
    expect(seenQuery).toContain('owner: "acme"');
    expect(seenQuery).toContain('name: "widgets"');
    expect(seenQuery).toContain("pullRequest(number: 42)");
  });

  test("fetchCiStatus reports hasFailing/hasCancelled from workflow_runs and picks the highest run_number cancelled run", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>(args: string[]) => {
        expect(args).toContain(
          "repos/acme/widgets/actions/runs?head_sha=deadbeef",
        );
        return {
          workflow_runs: [
            {
              id: 1,
              status: "completed",
              conclusion: "failure",
              workflow_id: 10,
              run_number: 1,
            },
            {
              id: 2,
              status: "completed",
              conclusion: "cancelled",
              workflow_id: 20,
              run_number: 1,
            },
            {
              id: 3,
              status: "completed",
              conclusion: "cancelled",
              workflow_id: 20,
              run_number: 2,
            },
          ],
        } as unknown as T;
      },
      ghGraphql: async <T>() => ({}) as unknown as T,
      getCurrentUser: async () => "the-agent",
    });

    const status = await deps.fetchCiStatus("acme", "widgets", 42, "deadbeef");

    expect(status.hasFailing).toBe(true);
    expect(status.hasCancelled).toBe(true);
    // Two cancelled entries share workflow_id 20; run_number 2 (id 3) is the
    // latest and should win, and id 1's earlier cancelled run_number 1 must
    // NOT surface via a different workflow — this exercises the
    // `cancelledRuns.sort(...)` tie-break, not just latestRunPerWorkflow.
    expect(status.cancelledRunId).toBe(3);
  });

  test("fetchCiStatus falls back to hasFailing:false/hasCancelled:false and logs to stderr when the API call throws", async () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const deps = await buildProductionDeps({
        ghJson: async <T>(): Promise<T> => {
          throw new Error("gh api failed");
        },
        ghGraphql: async <T>() => ({}) as unknown as T,
        getCurrentUser: async () => "the-agent",
      });

      const status = await deps.fetchCiStatus("acme", "widgets", 42, "sha1");

      expect(status).toEqual({ hasFailing: false, hasCancelled: false });
      expect(written.join("")).toContain(
        "check-patch: actions/runs query failed for PR 42 sha sha1",
      );
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("fetchMergeStatus reports isDirty true only when mergeStateStatus is DIRTY", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>(args: string[]) => {
        expect(args).toContain("mergeStateStatus");
        return { mergeStateStatus: "DIRTY" } as unknown as T;
      },
      ghGraphql: async <T>() => ({}) as unknown as T,
      getCurrentUser: async () => "the-agent",
    });

    expect(await deps.fetchMergeStatus("acme", "widgets", 42)).toEqual({
      isDirty: true,
    });
  });

  test("fetchMergeStatus reports isDirty false for a non-DIRTY mergeStateStatus", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => ({ mergeStateStatus: "BEHIND" }) as unknown as T,
      ghGraphql: async <T>() => ({}) as unknown as T,
      getCurrentUser: async () => "the-agent",
    });

    expect(await deps.fetchMergeStatus("acme", "widgets", 42)).toEqual({
      isDirty: false,
    });
  });

  test("fetchMergeStatus falls back to isDirty:false and logs to stderr when the gh call throws", async () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const deps = await buildProductionDeps({
        ghJson: async <T>(): Promise<T> => {
          throw new Error("gh pr view failed");
        },
        ghGraphql: async <T>() => ({}) as unknown as T,
        getCurrentUser: async () => "the-agent",
      });

      const status = await deps.fetchMergeStatus("acme", "widgets", 99);

      expect(status).toEqual({ isDirty: false });
      expect(written.join("")).toContain(
        "check-patch: gh merge status query failed for PR 99",
      );
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  test("listPrCommits fetches paginated commits for the given repo", async () => {
    const fakeCommits: CommitInfo[] = [{ sha: "c1", parents: [{ sha: "p0" }] }];
    const deps = await buildProductionDeps({
      ghJson: async <T>(args: string[]) => {
        expect(args).toContain("repos/acme/widgets/pulls/7/commits");
        expect(args).toContain("--paginate");
        return fakeCommits as unknown as T;
      },
      ghGraphql: async <T>() => ({}) as unknown as T,
      getCurrentUser: async () => "the-agent",
    });

    expect(await deps.listPrCommits(7, "acme/widgets")).toEqual(fakeCommits);
  });

  test("getCurrentUser delegates directly to the injected getCurrentUser callback", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
      ghGraphql: async <T>() => ({}) as unknown as T,
      getCurrentUser: async () => "specific-agent-login",
    });

    expect(await deps.getCurrentUser()).toBe("specific-agent-login");
  });

  test("getScopedRepos defaults to the shared agentReposRef when not overridden", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
      ghGraphql: async <T>() => ({}) as unknown as T,
      getCurrentUser: async () => "the-agent",
    });

    // Wired to agentReposRef's own get — just confirm the shape is present
    // and callable without throwing, since the ref's actual sync state is
    // exercised by check-review.unit.test.ts's buildProductionDeps suites
    // (shared ref, not check-patch-specific).
    expect(typeof deps.getScopedRepos).toBe("function");
    expect(() => deps.getScopedRepos()).not.toThrow();
  });

  test("an explicit opts.getScopedRepos overrides the agentReposRef default", async () => {
    const deps = await buildProductionDeps({
      ghJson: async <T>() => [] as unknown as T,
      ghGraphql: async <T>() => ({}) as unknown as T,
      getCurrentUser: async () => "the-agent",
      getScopedRepos: () => ["acme/widgets"],
    });

    expect(deps.getScopedRepos()).toEqual(["acme/widgets"]);
  });

  test("listAllowlistedOpenPrs makes no gh calls when patchAuthorAllowlistRef is empty (default)", async () => {
    const allowlistRef = createPatchAuthorAllowlistRef();
    // Never call .set() — stays empty, mirroring the un-synced/default state.
    let ghJsonCalls = 0;
    const deps = await buildProductionDeps({
      ghJson: async <T>() => {
        ghJsonCalls++;
        return [] as unknown as T;
      },
      ghGraphql: async <T>() => ({}) as unknown as T,
      getCurrentUser: async () => "the-agent",
      patchAuthorAllowlistRef: allowlistRef,
    });

    const result = await deps.listAllowlistedOpenPrs?.("default");

    expect(result).toEqual([]);
    expect(ghJsonCalls).toBe(0);
  });

  test("listAllowlistedOpenPrs queries gh pr list --author once per allowlisted login, per scanned repo", async () => {
    const scratchDir = mkdtempSync(
      join(tmpdir(), "check-patch-listAllowlistedOpenPrs-"),
    );
    try {
      const repoDir = join(scratchDir, "repos", "example-repo");
      mkdirSync(join(repoDir, ".git"), { recursive: true });
      writeFileSync(
        join(repoDir, ".git", "config"),
        `[remote "origin"]\n\turl = https://github.com/acme/example-repo.git\n`,
      );
      process.env.WORKSPACE_PATH = scratchDir;

      const allowlistRef = createPatchAuthorAllowlistRef();
      allowlistRef.set(["allowlisted-one", "allowlisted-two"]);

      const seenArgs: string[][] = [];
      const deps = await buildProductionDeps({
        ghJson: async <T>(args: string[]) => {
          seenArgs.push(args);
          const author = args[args.indexOf("--author") + 1];
          return [
            {
              number: author === "allowlisted-one" ? 21 : 22,
              title: `PR by ${author}`,
              headRefName: `feat/${author}`,
              headRefOid: `sha-${author}`,
              createdAt: "2026-05-01T00:00:00Z",
            },
          ] as unknown as T;
        },
        ghGraphql: async <T>() => ({}) as unknown as T,
        getCurrentUser: async () => "the-agent",
        patchAuthorAllowlistRef: allowlistRef,
        // Explicit override so this test is deterministic regardless of the
        // shared agentReposRef singleton's live state in this Bun test
        // process (RSF-1.1: see the identical rationale on
        // listOwnOpenPrs's own real-repos/-scan test above).
        getScopedRepos: () => ["acme/example-repo"],
      });

      const prs = await deps.listAllowlistedOpenPrs?.("default");

      expect(prs).toEqual([
        {
          number: 21,
          title: "PR by allowlisted-one",
          headRefName: "feat/allowlisted-one",
          headRefOid: "sha-allowlisted-one",
          createdAt: "2026-05-01T00:00:00Z",
          repo: "acme/example-repo",
          // The queried login is attached as the PR's author so
          // getPatchCandidates can thread a real prAuthor downstream.
          author: "allowlisted-one",
        },
        {
          number: 22,
          title: "PR by allowlisted-two",
          headRefName: "feat/allowlisted-two",
          headRefOid: "sha-allowlisted-two",
          createdAt: "2026-05-01T00:00:00Z",
          repo: "acme/example-repo",
          author: "allowlisted-two",
        },
      ]);
      // One gh call per (repo, login) pair — 1 repo × 2 logins.
      expect(seenArgs).toHaveLength(2);
      for (const args of seenArgs) {
        expect(args).toEqual(
          expect.arrayContaining([
            "pr",
            "list",
            "--state",
            "open",
            "--repo",
            "acme/example-repo",
            "--json",
            "number,title,headRefName,headRefOid,createdAt",
          ]),
        );
      }
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  test("listAllowlistedOpenPrs never calls gh pr list for a repo returned by the filesystem scan but absent from getScopedRepos() (RSF-1.1)", async () => {
    const scratchDir = mkdtempSync(
      join(tmpdir(), "check-patch-listAllowlistedOpenPrs-scoped-"),
    );
    try {
      for (const name of ["in-scope-repo", "out-of-scope-repo"]) {
        const repoDir = join(scratchDir, "repos", name);
        mkdirSync(join(repoDir, ".git"), { recursive: true });
        writeFileSync(
          join(repoDir, ".git", "config"),
          `[remote "origin"]\n\turl = https://github.com/acme/${name}.git\n`,
        );
      }
      process.env.WORKSPACE_PATH = scratchDir;

      const allowlistRef = createPatchAuthorAllowlistRef();
      allowlistRef.set(["allowlisted-one"]);

      const seenRepos: string[] = [];
      const deps = await buildProductionDeps({
        ghJson: async <T>(args: string[]) => {
          const repoIdx = args.indexOf("--repo");
          if (repoIdx !== -1) seenRepos.push(args[repoIdx + 1]);
          return [] as unknown as T;
        },
        ghGraphql: async <T>() => ({}) as unknown as T,
        getCurrentUser: async () => "the-agent",
        patchAuthorAllowlistRef: allowlistRef,
        getScopedRepos: () => ["acme/in-scope-repo"],
      });

      await deps.listAllowlistedOpenPrs?.("default");

      expect(seenRepos).toEqual(["acme/in-scope-repo"]);
      expect(seenRepos).not.toContain("acme/out-of-scope-repo");
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
