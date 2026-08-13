/**
 * agent/src/check-review.unit.test.ts
 *
 * Unit tests for getReviewCandidates() — native port of
 * plugins/shipwright/scripts/check-review.ts's qualification logic.
 *
 * Ported from plugins/shipwright/scripts/check-review.unit.test.ts, adjusted to
 * assert on the returned WorkPrCandidate[] array instead of {exit, output}.
 * parseAllowSelfReview tests already exist in check-helpers.unit.test.ts (the
 * function was ported there in WL-2.1) and are not duplicated here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  agentAuthorAllowlistRef,
  createAgentAuthorAllowlistRef,
} from "./agent-author-allowlist-ref.ts";
import type { LinkedTaskInfo } from "./check-helpers.ts";
import type { PrReviewData, ReviewNode } from "./check-patch.ts";
import {
  type CheckReviewDeps,
  type PrInfo,
  type PrRecord,
  buildProductionDeps,
  getReviewCandidates,
  traceReviewCandidacyDecision,
} from "./check-review.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    title: "Add feature X",
    author: { login: "danmcaulay" },
    headRefName: "feat/x",
    headRefOid: "abc123def456",
    repo: "example-org/example-repo",
    isDraft: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Default fetchPrReviews stub: no reviews at all — "no terminal review", every PR stays eligible. */
async function defaultFetchPrReviews(
  _org: string,
  _repo: string,
  _pr: number,
): Promise<PrReviewData> {
  return {
    headRefOid: "abc123def456",
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
  };
}

function makeDeps(
  prs: PrInfo[],
  queryPrRecordFn: (
    repo: string,
    prNumber: number,
  ) => Promise<PrRecord | null> = async () => null,
  currentUser = "bodhi-agent",
  isSelfReviewAllowed = false,
  queryTaskStatus: (
    repo: string,
    prNumber: number,
  ) => Promise<LinkedTaskInfo | null> = async () => null,
  getScopedRepos: () => string[] = () => [
    ...new Set(prs.map((pr) => pr.repo ?? "")),
  ],
  hasScopeSynced: () => boolean = () => true,
  isBundleComplete?: (branch: string) => Promise<boolean>,
  fetchPrReviews: (
    org: string,
    repo: string,
    pr: number,
  ) => Promise<PrReviewData> = defaultFetchPrReviews,
): CheckReviewDeps {
  return {
    listOpenPrs: async (_repo: string) => prs,
    queryPrRecord: queryPrRecordFn,
    getCurrentUser: async () => currentUser,
    isSelfReviewAllowed,
    getScopedRepos,
    hasScopeSynced,
    queryTaskStatus,
    fetchPrReviews,
    ...(isBundleComplete ? { isBundleComplete } : {}),
  };
}

// ─── Live-review fixture helpers (RVD-1.1) ───────────────────────────────────

function makeReviewNode(overrides: Partial<ReviewNode> = {}): ReviewNode {
  return {
    author: { login: "some-reviewer" },
    state: "COMMENTED",
    submittedAt: "2026-07-15T10:00:00.000Z",
    commit: { oid: "abc123def456" },
    body: "",
    ...overrides,
  };
}

function makeReviewData(overrides: Partial<PrReviewData> = {}): PrReviewData {
  return {
    headRefOid: "abc123def456",
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getReviewCandidates", () => {
  test("returns empty array when no open PRs exist", async () => {
    const result = await getReviewCandidates(makeDeps([]));
    expect(result).toEqual([]);
  });

  test("returns a candidate when open PR has no PR record (queryPrRecord returns null)", async () => {
    const result = await getReviewCandidates(
      makeDeps([makePr()], async () => null),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "example-org/example-repo#42",
      phase: "review",
      title: "Add feature X",
      commitSha: "abc123def456",
    });
  });

  test("returns empty array when PR record has matching reviewedCommitSha and reviewState is posted (already reviewed)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "sha111",
        reviewedCommitSha: "sha111",
        reviewState: "posted",
      })),
    );
    expect(result).toEqual([]);
  });

  // ─── RCO-1.2: terminal-skip must key on reviewedCommitSha, not commitSha ────
  // commitSha is shared claim-lock bookkeeping overwritten by any unrelated
  // claim/patch/deploy action — it is NOT a reliable "this exact commit was
  // reviewed" signal (see the staged-check comment a few blocks below, which
  // already documents this same trap for the staged guard). Regression
  // guard: a commitSha bump from an unrelated action must not mask a PR
  // that was never actually re-reviewed at its current head.

  test("RCO-1.2 regression: returns a candidate when commitSha matches headRefOid (stale bump from an unrelated claim/patch/deploy action) but reviewedCommitSha does not", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "sha111", // bumped by an unrelated claim/patch/deploy action
        reviewedCommitSha: "oldsha000", // last commit actually reviewed
        reviewState: "posted",
      })),
    );
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("sha111");
  });

  test("RCO-1.2: still returns empty array when reviewedCommitSha genuinely matches headRefOid and reviewState is not pending (preserved correct-skip path)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "sha111",
        reviewedCommitSha: "sha111",
        reviewState: "posted",
      })),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when PR record has different commitSha (new commits since review)", async () => {
    const pr = makePr({ headRefOid: "newsha999" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "oldsha111",
        reviewState: "posted",
      })),
    );
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("newsha999");
  });

  test("returns a candidate when PR record has reviewState=pending (even if commitSha matches)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "sha111",
        reviewState: "pending",
      })),
    );
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("sha111");
  });

  test("returns a candidate when PR record has null commitSha", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: null,
        reviewState: "posted",
      })),
    );
    expect(result).toHaveLength(1);
  });

  test("returns empty array when all open PRs have matching commitSha and non-pending reviewState", async () => {
    const prs = [
      makePr({ number: 1, headRefOid: "sha-A" }),
      makePr({ number: 2, headRefOid: "sha-B" }),
    ];
    const result = await getReviewCandidates(
      makeDeps([...prs], async (_repo, prNumber) => ({
        commitSha: prNumber === 1 ? "sha-A" : "sha-B",
        reviewedCommitSha: prNumber === 1 ? "sha-A" : "sha-B",
        reviewState: "posted",
      })),
    );
    expect(result).toEqual([]);
  });

  test("returns only the PR needing review when others are already reviewed (does not early-return)", async () => {
    const prs = [
      makePr({ number: 1, headRefOid: "sha-A" }),
      makePr({ number: 2, headRefOid: "sha-B-new" }),
    ];
    const result = await getReviewCandidates(
      makeDeps([...prs], async (_repo, prNumber) => {
        if (prNumber === 1)
          return {
            commitSha: "sha-A",
            reviewedCommitSha: "sha-A",
            reviewState: "posted",
          };
        return {
          commitSha: "sha-B-old",
          reviewedCommitSha: "sha-B-old",
          reviewState: "posted",
        };
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toContain("#2");
  });

  test("returns empty array when only PRs are from current user and isSelfReviewAllowed is false", async () => {
    const pr = makePr({ author: { login: "bodhi-agent" } });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => null, "bodhi-agent", false),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when PR is authored by current user and isSelfReviewAllowed is true", async () => {
    const pr = makePr({ author: { login: "bodhi-agent" } });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => null, "bodhi-agent", true),
    );
    expect(result).toHaveLength(1);
  });

  test("returns a candidate when PR is authored by different user", async () => {
    const pr = makePr({ author: { login: "danmcaulay" } });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => null, "bodhi-agent"),
    );
    expect(result).toHaveLength(1);
  });

  // ─── multi-repo: dedup keyed on repo+prNumber via queryPrRecord ──────────────

  test("multi-repo: two repos with the same PR number are deduped independently", async () => {
    const prA = makePr({
      number: 42,
      headRefOid: "sha-A",
      repo: "example-org/repo-a",
    });
    const prB = makePr({
      number: 42,
      headRefOid: "sha-B",
      repo: "example-org/repo-b",
    });
    const result = await getReviewCandidates(
      makeDeps([prA, prB], async (repo, _prNumber) => {
        if (repo === "example-org/repo-a") {
          return {
            commitSha: "sha-A",
            reviewedCommitSha: "sha-A",
            reviewState: "posted",
          };
        }
        return null; // repo-b has no record → eligible
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("example-org/repo-b#42");
    expect(result[0].commitSha).toBe("sha-B");
  });

  // ─── queryPrRecord failure → treat as eligible ───────────────────────────────

  test("returns a candidate (eligible) when queryPrRecord throws (graceful degradation)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const deps: CheckReviewDeps = {
      listOpenPrs: async (_repo: string) => [pr],
      queryPrRecord: async (
        _repo: string,
        _prNumber: number,
      ): Promise<PrRecord | null> => {
        throw new Error("Network error");
      },
      getCurrentUser: async () => "bodhi-agent",
      isSelfReviewAllowed: false,
      getScopedRepos: () => [pr.repo ?? ""],
      hasScopeSynced: () => true,
      fetchPrReviews: defaultFetchPrReviews,
    };
    const result = await getReviewCandidates(deps);
    expect(result).toHaveLength(1);
  });

  // ─── draft / dependabot exclusions ───────────────────────────────────────────

  test("returns empty array when all open PRs are drafts", async () => {
    const prs = [
      makePr({ number: 1, isDraft: true }),
      makePr({ number: 2, isDraft: true }),
    ];
    const result = await getReviewCandidates(makeDeps(prs, async () => null));
    expect(result).toEqual([]);
  });

  test("returns empty array when all open PRs are authored by app/dependabot", async () => {
    const prs = [
      makePr({ number: 1, author: { login: "app/dependabot" } }),
      makePr({ number: 2, author: { login: "app/dependabot" } }),
    ];
    const result = await getReviewCandidates(makeDeps(prs, async () => null));
    expect(result).toEqual([]);
  });

  test("returns the one eligible non-draft non-dependabot PR from a mixed set (all matches collected)", async () => {
    const prs = [
      makePr({ number: 1, isDraft: true }),
      makePr({ number: 2, author: { login: "app/dependabot" } }),
      makePr({ number: 3, author: { login: "danmcaulay" } }),
    ];
    const result = await getReviewCandidates(makeDeps(prs, async () => null));
    expect(result).toHaveLength(1);
    expect(result[0].id).toContain("#3");
  });

  // ─── automated label exclusion ────────────────────────────────────────────

  test("returns empty array when all open PRs are labeled automated", async () => {
    const prs = [
      makePr({ number: 1, labels: [{ name: "automated" }] }),
      makePr({ number: 2, labels: [{ name: "automated" }] }),
    ];
    const result = await getReviewCandidates(makeDeps(prs, async () => null));
    expect(result).toEqual([]);
  });

  test("returns the one eligible non-automated PR from a mix of automated/eligible PRs", async () => {
    const prs = [
      makePr({ number: 1, labels: [{ name: "automated" }] }),
      makePr({ number: 2, author: { login: "danmcaulay" } }),
    ];
    const result = await getReviewCandidates(makeDeps(prs, async () => null));
    expect(result).toHaveLength(1);
    expect(result[0].id).toContain("#2");
  });

  test("returns a candidate when PR has unrelated labels (not automated)", async () => {
    const pr = makePr({ labels: [{ name: "bug" }, { name: "enhancement" }] });
    const result = await getReviewCandidates(makeDeps([pr], async () => null));
    expect(result).toHaveLength(1);
  });

  // ─── collect-all behavior (WL-2.2 architectural difference) ──────────────

  test("returns ALL qualifying PRs across multiple repos, not just the first (no early-return)", async () => {
    const prs = [
      makePr({ number: 1, repo: "example-org/repo-a", headRefOid: "sha-1" }),
      makePr({ number: 2, repo: "example-org/repo-b", headRefOid: "sha-2" }),
      makePr({ number: 3, repo: "example-org/repo-c", headRefOid: "sha-3" }),
    ];
    const result = await getReviewCandidates(makeDeps(prs, async () => null));
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.id)).toEqual([
      "example-org/repo-a#1",
      "example-org/repo-b#2",
      "example-org/repo-c#3",
    ]);
    expect(result.map((c) => c.commitSha)).toEqual(["sha-1", "sha-2", "sha-3"]);
  });

  // ─── age field sourcing ──────────────────────────────────────────────────

  test("age is sourced from the linked task's createdAt when a task is linked, even when a task-store PR record exists", async () => {
    const pr = makePr({
      headRefOid: "newsha",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "oldsha",
          reviewState: "posted",
          readyForReviewAt: "2026-05-15T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => ({
          status: "in_progress",
          createdAt: "2026-05-01T00:00:00.000Z",
        }),
      ),
    );
    expect(result[0].age).toBe("2026-05-01T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when no task is linked (queryTaskStatus resolves null), even when a task-store record exists", async () => {
    const pr = makePr({
      headRefOid: "newsha",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "oldsha",
        reviewState: "posted",
        readyForReviewAt: "2026-05-15T00:00:00.000Z",
      })),
    );
    expect(result[0].age).toBe("2026-06-01T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when no task-store record exists and no task is linked", async () => {
    const pr = makePr({ createdAt: "2026-06-01T00:00:00.000Z" });
    const result = await getReviewCandidates(makeDeps([pr], async () => null));
    expect(result[0].age).toBe("2026-06-01T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when queryTaskStatus throws (lookup failure does not disqualify or block age fallback)", async () => {
    const pr = makePr({ createdAt: "2026-06-01T00:00:00.000Z" });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => {
          throw new Error("task-store unreachable");
        },
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].age).toBe("2026-06-01T00:00:00.000Z");
  });

  // ─── hitl / blocked exclusion (CBD-2.2, PRB-2.3) ─────────────────────────────

  test("a PR whose linked task is hitl:true is excluded from review candidacy (isTaskBlockedForDispatch)", async () => {
    const pr = makePr();
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => ({ status: "pr_open", hitl: true }),
      ),
    );
    expect(result).toHaveLength(0);
  });

  test("a PR whose linked task has status:blocked is excluded from review candidacy (new behavior)", async () => {
    const pr = makePr();
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => ({ status: "blocked", hitl: false }),
      ),
    );
    expect(result).toHaveLength(0);
  });

  test("a PR whose PR-record has blocked:true is excluded from review candidacy, even with no linked task at all", async () => {
    const pr = makePr();
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: null,
          reviewState: "pending",
          blocked: true,
        }),
        "bodhi-agent",
        false,
        async () => null,
      ),
    );
    expect(result).toHaveLength(0);
  });

  test("a PR is still an eligible candidate when the linked task has hitl:false or no linked task exists", async () => {
    const pr = makePr();
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => ({ status: "pr_open", hitl: false }),
      ),
    );
    expect(result).toHaveLength(1);

    const resultNoTask = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => null,
      ),
    );
    expect(resultNoTask).toHaveLength(1);
  });

  test("readyForReviewAt is never used for age sourcing when a task is linked", async () => {
    const pr = makePr({
      headRefOid: "newsha",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "oldsha",
          reviewState: "posted",
          readyForReviewAt: "2026-05-20T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => ({
          status: "in_progress",
          createdAt: "2026-05-01T00:00:00.000Z",
        }),
      ),
    );
    expect(result[0].age).not.toBe("2026-05-20T00:00:00.000Z");
    expect(result[0].age).toBe("2026-05-01T00:00:00.000Z");
  });

  // ─── claim gating (LPF-2.2) ───────────────────────────────────────────────

  test("excludes a PR whose task-store record has claimedBy set, even when otherwise eligible (pending reviewState, no commitSha match)", async () => {
    // Regression guard for the LPF-2.2 trap: a claimed-but-not-yet-reviewed
    // record (reviewState: "pending", no commitSha match — which would
    // otherwise fall into the "eligible" branch) must still be excluded when
    // claimedBy is set, since another agent is currently mid-review on it.
    const pr = makePr({ headRefOid: "sha111" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: null,
        reviewState: "pending",
        claimedBy: "agent-other",
      })),
    );
    expect(result).toEqual([]);
  });

  // ─── staged-review exclusion, independent of reviewState (CHU-2.5) ──────────
  // RCS-1.3: the staged guard compares record.reviewedCommitSha (the review
  // pipeline's exclusive, review.md-written field) against pr.headRefOid, NOT
  // record.commitSha — commitSha is shared bookkeeping also advanced by
  // PullRequestService.patch() (e.g. after a CI-fix cycle), independent of
  // whether the PR was actually re-reviewed at that new commit.

  test("excludes a PR whose record has staged:true and matching reviewedCommitSha, even when reviewState reads pending (the #1769 regression case)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "sha111",
        reviewedCommitSha: "sha111",
        reviewState: "pending",
        staged: true,
      })),
    );
    expect(result).toEqual([]);
  });

  test("returns a candidate when record has staged:true but a different reviewedCommitSha (author pushed since staging)", async () => {
    const pr = makePr({ headRefOid: "newsha999" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "oldsha111",
        reviewedCommitSha: "oldsha111",
        reviewState: "pending",
        staged: true,
      })),
    );
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("newsha999");
  });

  test("returns a candidate when record has staged:false and reviewState:pending (unaffected by the staged guard)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "sha111",
        reviewedCommitSha: "sha111",
        reviewState: "pending",
        staged: false,
      })),
    );
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("sha111");
  });

  test("returns a candidate (does NOT falsely hide) when a patch()-driven bump advanced commitSha to match headRefOid, but reviewedCommitSha still reflects the older, actually-reviewed commit", async () => {
    // Regression guard for the original RCS-1.3 bug: PullRequestService.patch()
    // advances the shared commitSha field for its own bookkeeping (e.g. after
    // a CI-fix cycle) without the PR having actually been re-reviewed at that
    // new head. A staged guard keyed on commitSha would misread this as
    // "still current" and silently hide the PR from review forever.
    const pr = makePr({ headRefOid: "newsha999" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "newsha999", // bumped by patch()'s unrelated bookkeeping
        reviewedCommitSha: "oldsha111", // last commit actually reviewed
        reviewState: "pending",
        staged: true,
      })),
    );
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("newsha999");
  });

  test("returns a candidate (re-queues for review) when reviewedCommitSha diverges from headRefOid due to a genuine new commit", async () => {
    const pr = makePr({ headRefOid: "brandnewsha" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "brandnewsha",
        reviewedCommitSha: "previously-reviewed-sha",
        reviewState: "pending",
        staged: true,
      })),
    );
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("brandnewsha");
  });

  // ─── agent-scope filtering (WL-4.3) ──────────────────────────────────────

  test("excludes a PR from a repo returned by the local-clone scan but absent from getScopedRepos()", async () => {
    const inScope = makePr({ number: 1, repo: "example-org/in-scope" });
    const outOfScope = makePr({ number: 2, repo: "example-org/out-of-scope" });
    const result = await getReviewCandidates(
      makeDeps(
        [inScope, outOfScope],
        async () => null,
        "bodhi-agent",
        false,
        undefined,
        () => ["example-org/in-scope"],
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("example-org/in-scope#1");
  });

  test("re-evaluates getScopedRepos() on every call — a scope change between two calls changes the result on the second call", async () => {
    const pr = makePr({ number: 1, repo: "example-org/newly-added" });
    let scope: string[] = [];
    const deps = makeDeps(
      [pr],
      async () => null,
      "bodhi-agent",
      false,
      undefined,
      () => scope,
    );

    const first = await getReviewCandidates(deps);
    expect(first).toEqual([]);

    scope = ["example-org/newly-added"];
    const second = await getReviewCandidates(deps);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe("example-org/newly-added#1");
  });

  test("fails open (does not filter) when hasScopeSynced() is false, even if getScopedRepos() would otherwise exclude everything", async () => {
    const pr = makePr({ number: 1, repo: "example-org/never-synced" });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        undefined,
        () => [],
        () => false,
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("example-org/never-synced#1");
  });

  test("filters normally when hasScopeSynced() is true, even if the synced scope is a deliberately empty list", async () => {
    const pr = makePr({ number: 1, repo: "example-org/some-repo" });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        undefined,
        () => [],
        () => true,
      ),
    );
    expect(result).toEqual([]);
  });

  // ─── author allowlist filtering (HRA-1.1) ────────────────────────────────

  test("isAuthorAllowed filters out a PR whose author does not match", async () => {
    const pr = makePr({ author: { login: "danmcaulay" } });
    const deps: CheckReviewDeps = {
      ...makeDeps([pr], async () => null),
      isAuthorAllowed: (login) => login === "someone-else",
    };
    const result = await getReviewCandidates(deps);
    expect(result).toEqual([]);
  });

  test("isAuthorAllowed passes through a PR whose author matches", async () => {
    const pr = makePr({ author: { login: "danmcaulay" } });
    const deps: CheckReviewDeps = {
      ...makeDeps([pr], async () => null),
      isAuthorAllowed: (login) => login === "danmcaulay",
    };
    const result = await getReviewCandidates(deps);
    expect(result).toHaveLength(1);
  });

  // ─── requested-reviewer inclusion (RRR-1.1) ──────────────────────────────

  test("a self-authored PR is included when isSelfReviewAllowed is false but currentUser is a requested reviewer", async () => {
    const pr = makePr({
      author: { login: "bodhi-agent" },
      reviewRequests: [{ login: "bodhi-agent" }],
    });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => null, "bodhi-agent", false),
    );
    expect(result).toHaveLength(1);
  });

  test("an allowlist-excluded author's PR is included when currentUser is a requested reviewer (RRA-1.1: requested-reviewer bypass extends to the allowlist)", async () => {
    const pr = makePr({
      author: { login: "danmcaulay" },
      reviewRequests: [{ login: "bodhi-agent" }],
    });
    const deps: CheckReviewDeps = {
      ...makeDeps([pr], async () => null),
      isAuthorAllowed: (login) => login === "someone-else",
    };
    const result = await getReviewCandidates(deps);
    expect(result).toHaveLength(1);
  });

  test("requested-reviewer status does not override the unconditional draft exclusion", async () => {
    const pr = makePr({
      isDraft: true,
      reviewRequests: [{ login: "bodhi-agent" }],
    });
    const result = await getReviewCandidates(makeDeps([pr], async () => null));
    expect(result).toEqual([]);
  });

  test("requested-reviewer status does not override the unconditional dependabot exclusion", async () => {
    const pr = makePr({
      author: { login: "app/dependabot" },
      reviewRequests: [{ login: "bodhi-agent" }],
    });
    const result = await getReviewCandidates(makeDeps([pr], async () => null));
    expect(result).toEqual([]);
  });

  test("requested-reviewer status does not override the unconditional hitl-blocked exclusion", async () => {
    const pr = makePr({
      author: { login: "bodhi-agent" },
      reviewRequests: [{ login: "bodhi-agent" }],
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => ({ status: "pr_open", hitl: true }),
      ),
    );
    expect(result).toEqual([]);
  });

  test("a self-authored PR with no reviewRequests (and isSelfReviewAllowed false) is still excluded (regression guard)", async () => {
    const pr = makePr({ author: { login: "bodhi-agent" } });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => null, "bodhi-agent", false),
    );
    expect(result).toEqual([]);
  });

  test("a self-authored PR whose reviewRequests does not include currentUser is still excluded (regression guard)", async () => {
    const pr = makePr({
      author: { login: "bodhi-agent" },
      reviewRequests: [{ login: "someone-else" }],
    });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => null, "bodhi-agent", false),
    );
    expect(result).toEqual([]);
  });

  // ─── bundle completeness gate (RBG-1.1) ──────────────────────────────────

  test("excludes a PR when isBundleComplete resolves false for its branch", async () => {
    const pr = makePr({ headRefName: "feat/bundle-incomplete" });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        async (branch: string) => branch !== "feat/bundle-incomplete",
      ),
    );
    expect(result).toEqual([]);
  });

  test("includes a PR when isBundleComplete resolves true for its branch", async () => {
    const pr = makePr({ headRefName: "feat/bundle-complete" });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        async (branch: string) => branch === "feat/bundle-complete",
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("example-org/example-repo#42");
  });

  test("includes a PR when isBundleComplete rejects for its branch (fail-open)", async () => {
    const pr = makePr({ headRefName: "feat/bundle-check-throws" });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        async () => {
          throw new Error("bundle status check failed");
        },
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("example-org/example-repo#42");
  });

  // ─── live-GitHub review dedup (RVD-1.1) ──────────────────────────────────

  test("excludes a PR with a live terminal review at head from a non-self author, even with no task-store record (identity-agnostic dedup)", async () => {
    const pr = makePr({ headRefOid: "head-sha" });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "out-of-band-reviewer" },
            state: "APPROVED",
            commit: { oid: "head-sha" },
            body: "LGTM",
          }),
        ],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null, // no task-store record — this instance never claimed it
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toEqual([]);
  });

  test("includes a PR whose only live reviews are at a stale (non-head) commit", async () => {
    const pr = makePr({ headRefOid: "head-sha" });
    const reviewData = makeReviewData({
      headRefOid: "head-sha",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "old-stale-sha" },
            body: "LGTM",
          }),
        ],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("example-org/example-repo#42");
  });

  test("fails open (stays eligible) when fetchPrReviews throws/rejects", async () => {
    const pr = makePr({ headRefOid: "head-sha" });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => null,
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error("GraphQL rate limited");
        },
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("example-org/example-repo#42");
  });

  test("a live terminal review at head still excludes the PR even when the task-store record independently says eligible", async () => {
    // The second, independent signal: even a fresh/pending task-store record
    // must not override a live terminal review at head.
    const pr = makePr({ headRefOid: "head-sha" });
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
      reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [] } }] },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({ commitSha: null, reviewState: "pending" }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toEqual([]);
  });

  test("RVD-2.1: a self-authored COMMENTED review at head with a genuine finding (classifyReviewState → null) still excludes — app-vitals/shipwright#2600 shape", async () => {
    // Live-confirmed shape (app-vitals/shipwright#2600, app-vitals/goals#68):
    // a self-authored COMMENTED review posted at the current head commit,
    // with a non-empty, non-clean-approve body (a real finding) and an
    // unresolved thread — classifyReviewState() returns null for this
    // (genuine unaddressed finding, not "no review at head"), and the
    // task-store record's reviewState is stuck at "pending". Before this
    // fix, classifyReviewState() !== null was the exclusion condition, so
    // this shape was WRONGLY treated as review-eligible (identical to "no
    // review at head at all") even though a review already exists at head —
    // causing the loop to re-select this PR for the review phase every
    // tick. hasAnyReviewAtHead() correctly reports true here, so the PR
    // must be excluded regardless of what classifyReviewState() returns.
    const pr = makePr({ headRefOid: "sha2600" });
    const reviewData = makeReviewData({
      headRefOid: "sha2600",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "bodhi-agent" },
            state: "COMMENTED",
            commit: { oid: "sha2600" },
            body: "Found a real issue: the error handler swallows the original exception.",
          }),
        ],
      },
      reviewThreads: {
        nodes: [{ isResolved: false, comments: { nodes: [] } }],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({ commitSha: null, reviewState: "pending" }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toEqual([]);
  });

  test("RFR-1.1: a clean/no-finding COMMENT review (classifyReviewState → 'approved') at head, plus a fresh author reply after reviewedAt, stays a candidate", async () => {
    // Real-world trigger shape (PR #2456): unlike the RVG-1.1 fixtures below
    // (which deliberately use an unresolved thread so classifyReviewState()
    // returns null and never reaches RVD-1.1's short-circuit), this review
    // is clean — no finding body, resolved/no thread — so classifyReviewState
    // returns "approved" and RVD-1.1's `continue` fires FIRST unless the
    // fresh-author-reply exception is also applied there.
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "some-reviewer" },
            state: "COMMENTED",
            commit: { oid: "sha111" },
            body: "",
          }),
        ],
      },
      reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [] } }] },
      comments: {
        nodes: [
          {
            author: { login: "danmcaulay" },
            body: "fixed, please take another look",
            createdAt: "2026-07-20T00:00:00.000Z",
          },
        ],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "sha111",
          reviewState: "posted",
          reviewedAt: "2026-07-15T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("sha111");
  });

  test("RFR-1.1 regression: a clean/no-finding COMMENT review at head with NO fresh author reply is still skipped", async () => {
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "some-reviewer" },
            state: "COMMENTED",
            commit: { oid: "sha111" },
            body: "",
          }),
        ],
      },
      reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [] } }] },
      comments: {
        nodes: [
          {
            author: { login: "danmcaulay" },
            body: "an old reply, before the review",
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "sha111",
          reviewState: "posted",
          reviewedAt: "2026-07-15T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toEqual([]);
  });

  // ─── author-reply retrigger at unchanged HEAD (RVG-1.1) ──────────────────
  // A PR that is already terminal (record.reviewedCommitSha === pr.headRefOid
  // && reviewState !== "pending") is normally skipped at the terminal-skip
  // check. RVG-1.1 adds one exception: if the PR AUTHOR has posted a
  // PR-level comment with createdAt after record.reviewedAt, the PR is
  // re-added as a candidate so a follow-up review pass can consume the
  // reply (review.md's CPF-2.3 exclusion never gets exercised otherwise).
  //
  // These fixtures use a qualifying COMMENTED review with an unresolved
  // thread at head (mirrors the "still a genuine finding" shape from the
  // RVD-1.1 block above), so classifyReviewState() returns null for it.
  // Since RVD-2.1, the earlier live-review dedup now short-circuits on
  // this shape too (hasAnyReviewAtHead() is true regardless of what
  // classifyReviewState() classifies it as) — every test below hits
  // exactly the same fresh-author-reply exception at that earlier
  // check-point instead of falling through to the terminal-skip branch,
  // so the asserted candidate-list outcomes are unchanged.

  test("regression: no new author comment since reviewedAt → still skipped", async () => {
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "some-reviewer" },
            state: "COMMENTED",
            commit: { oid: "sha111" },
            body: "Please fix this",
          }),
        ],
      },
      reviewThreads: {
        nodes: [{ isResolved: false, comments: { nodes: [] } }],
      },
      comments: {
        nodes: [
          {
            author: { login: "danmcaulay" },
            body: "an old reply",
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "sha111",
          reviewedCommitSha: "sha111",
          reviewState: "posted",
          reviewedAt: "2026-07-15T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toEqual([]);
  });

  test("becomes eligible again once the PR author posts a comment with createdAt after record.reviewedAt", async () => {
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "some-reviewer" },
            state: "COMMENTED",
            commit: { oid: "sha111" },
            body: "Please fix this",
          }),
        ],
      },
      reviewThreads: {
        nodes: [{ isResolved: false, comments: { nodes: [] } }],
      },
      comments: {
        nodes: [
          {
            author: { login: "danmcaulay" },
            body: "fixed, please take another look",
            createdAt: "2026-07-20T00:00:00.000Z",
          },
        ],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "sha111",
          reviewState: "posted",
          reviewedAt: "2026-07-15T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toHaveLength(1);
    expect(result[0].commitSha).toBe("sha111");
  });

  test("a comment from a non-author (another reviewer or bot) does not trigger re-candidacy", async () => {
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "some-reviewer" },
            state: "COMMENTED",
            commit: { oid: "sha111" },
            body: "Please fix this",
          }),
        ],
      },
      reviewThreads: {
        nodes: [{ isResolved: false, comments: { nodes: [] } }],
      },
      comments: {
        nodes: [
          {
            author: { login: "some-reviewer" },
            body: "bumping this",
            createdAt: "2026-07-20T00:00:00.000Z",
          },
          {
            author: { login: "some-bot" },
            body: "CI passed",
            createdAt: "2026-07-21T00:00:00.000Z",
          },
        ],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "sha111",
          reviewedCommitSha: "sha111",
          reviewState: "posted",
          reviewedAt: "2026-07-15T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toEqual([]);
  });

  test("does not keep re-triggering on the same author comment once a fresh review advances reviewedAt", async () => {
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "some-reviewer" },
            state: "COMMENTED",
            commit: { oid: "sha111" },
            body: "Please fix this",
          }),
        ],
      },
      reviewThreads: {
        nodes: [{ isResolved: false, comments: { nodes: [] } }],
      },
      comments: {
        nodes: [
          {
            author: { login: "danmcaulay" },
            body: "fixed, please take another look",
            createdAt: "2026-07-20T00:00:00.000Z",
          },
        ],
      },
    });
    // A later review pass consumed the reply and advanced reviewedAt past
    // the comment's createdAt — the same original comment must not keep
    // re-triggering candidacy on subsequent ticks.
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "sha111",
          reviewedCommitSha: "sha111",
          reviewState: "posted",
          reviewedAt: "2026-07-25T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toEqual([]);
  });

  test("treats a missing/null record.reviewedAt as no watermark — any author comment counts", async () => {
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            author: { login: "some-reviewer" },
            state: "COMMENTED",
            commit: { oid: "sha111" },
            body: "Please fix this",
          }),
        ],
      },
      reviewThreads: {
        nodes: [{ isResolved: false, comments: { nodes: [] } }],
      },
      comments: {
        nodes: [
          {
            author: { login: "danmcaulay" },
            body: "responding",
            createdAt: "2020-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "sha111",
          reviewState: "posted",
          reviewedAt: null,
        }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toHaveLength(1);
  });

  test("does not retrigger when fetchPrReviews fails (reviewData never populated) — old skip behavior preserved", async () => {
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "sha111",
          reviewedCommitSha: "sha111",
          reviewState: "posted",
          reviewedAt: "2026-07-15T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error("GraphQL rate limited");
        },
      ),
    );
    expect(result).toEqual([]);
  });

  test("the staged-review skip check remains unaffected by an author reply", async () => {
    // Guard: this task's retrigger logic must not interact with the
    // separate staged-review skip (record.staged===true &&
    // record.reviewedCommitSha===pr.headRefOid), which sits below the
    // terminal-skip check and is unrelated to this task.
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: {
        nodes: [
          {
            author: { login: "danmcaulay" },
            body: "fixed, please take another look",
            createdAt: "2026-07-20T00:00:00.000Z",
          },
        ],
      },
    });
    const result = await getReviewCandidates(
      makeDeps(
        [pr],
        async () => ({
          commitSha: "sha111",
          reviewedCommitSha: "sha111",
          reviewState: "pending",
          staged: true,
          reviewedAt: "2026-07-15T00:00:00.000Z",
        }),
        "bodhi-agent",
        false,
        async () => null,
        undefined,
        undefined,
        undefined,
        async () => reviewData,
      ),
    );
    expect(result).toEqual([]);
  });
});

// ─── RCO-1.3: traceReviewCandidacyDecision ────────────────────────────────
//
// Covers the "later" exclusion checks — the ones that depend on already-
// fetched live state (task-store record, live GitHub review data, linked
// task, bundle-completeness) — as a single reusable, exported pure
// function. The earlier cheap checks (draft/dependabot/automated-label/
// self-review/not-allowlisted) are simple enough that getReviewCandidates
// traces them inline rather than through a shared function; their
// candidate-list behavior is already covered by the existing
// describe("getReviewCandidates") tests above.

describe("traceReviewCandidacyDecision", () => {
  function baseArgs(
    overrides: Partial<Parameters<typeof traceReviewCandidacyDecision>[0]> = {},
  ): Parameters<typeof traceReviewCandidacyDecision>[0] {
    return {
      pr: makePr({ headRefOid: "sha111" }),
      record: null,
      reviewData: undefined,
      hasFreshAuthorReply: false,
      linkedTask: null,
      isBundleComplete: undefined,
      ...overrides,
    };
  }

  test("returns eligible when no exclusion applies", () => {
    const trace = traceReviewCandidacyDecision(baseArgs());
    expect(trace).toEqual({ check: "eligible" });
  });

  test("already-reviewed-live: a terminal live review at head with no fresh author reply excludes", () => {
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "sha111" },
            body: "LGTM",
          }),
        ],
      },
    });
    const trace = traceReviewCandidacyDecision(
      baseArgs({ reviewData, hasFreshAuthorReply: false }),
    );
    expect(trace).toEqual({
      check: "already-reviewed-live",
      classifiedState: "approved",
      hasFreshAuthorReply: false,
    });
  });

  test("already-reviewed-live: a fresh author reply bypasses the live-review exclusion (eligible)", () => {
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "sha111" },
            body: "LGTM",
          }),
        ],
      },
    });
    const trace = traceReviewCandidacyDecision(
      baseArgs({ reviewData, hasFreshAuthorReply: true }),
    );
    expect(trace).toEqual({ check: "eligible" });
  });

  // ─── RVG-2.1: fresh author reply sourced from an inline review-thread reply ──
  //
  // Mirrors production hasFreshAuthorReply's OR condition (check-review.ts
  // ~460-471): true when EITHER a top-level PR comment OR a reviewThreads
  // reply is authored by the PR author after record.reviewedAt. This block
  // recomputes that boolean from the fixture the same way production does,
  // rather than hardcoding `true`, so the computation itself is exercised —
  // not just traceReviewCandidacyDecision's pass-through of a given boolean.
  function computeHasFreshAuthorReply(
    reviewData: PrReviewData,
    authorLogin: string,
    reviewedAtMs: number,
  ): boolean {
    const topLevelFresh = reviewData.comments.nodes.some(
      (c) =>
        c.author.login === authorLogin &&
        new Date(c.createdAt).getTime() > reviewedAtMs,
    );
    const threadReplyFresh = reviewData.reviewThreads.nodes.some((t) =>
      t.comments.nodes.some(
        (c) =>
          c.author.login === authorLogin &&
          c.createdAt !== undefined &&
          new Date(c.createdAt).getTime() > reviewedAtMs,
      ),
    );
    return topLevelFresh || threadReplyFresh;
  }

  test("already-reviewed-live: a fresh author reply posted inline on a review thread bypasses the live-review exclusion (eligible)", () => {
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const record: PrRecord = {
      reviewedAt: "2026-07-15T09:00:00.000Z",
    } as PrRecord;
    const reviewedAtMs = new Date(record.reviewedAt as string).getTime();

    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "sha111" },
            body: "LGTM",
          }),
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [
                {
                  author: { login: "some-reviewer" },
                  body: "Can you address this?",
                  createdAt: "2026-07-15T08:00:00.000Z",
                },
                {
                  author: { login: "danmcaulay" },
                  body: "I will pick this up in a follow-up PR -- deferring it, not dropping it.",
                  createdAt: "2026-07-15T10:00:00.000Z",
                },
              ],
            },
          },
        ],
      },
    });

    // Sanity check: this is genuinely testing the new OR'd computation, not
    // just the trace's pass-through — the OLD (comments-only) computation
    // would have produced false for this fixture since the author's reply
    // only appears in reviewThreads, never in top-level comments.
    const oldComputation = reviewData.comments.nodes.some(
      (c) =>
        c.author.login === pr.author.login &&
        new Date(c.createdAt).getTime() > reviewedAtMs,
    );
    expect(oldComputation).toBe(false);

    const hasFreshAuthorReply = computeHasFreshAuthorReply(
      reviewData,
      pr.author.login,
      reviewedAtMs,
    );
    expect(hasFreshAuthorReply).toBe(true);

    const trace = traceReviewCandidacyDecision(
      baseArgs({ pr, record, reviewData, hasFreshAuthorReply }),
    );
    expect(trace).toEqual({ check: "eligible" });
  });

  test("already-reviewed-live: a review-thread reply from someone other than the PR author, or before reviewedAt, does not flip hasFreshAuthorReply (still excluded)", () => {
    const pr = makePr({
      headRefOid: "sha111",
      author: { login: "danmcaulay" },
    });
    const record: PrRecord = {
      reviewedAt: "2026-07-15T09:00:00.000Z",
    } as PrRecord;
    const reviewedAtMs = new Date(record.reviewedAt as string).getTime();

    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "sha111" },
            body: "LGTM",
          }),
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [
                // Fresh, but NOT the PR author.
                {
                  author: { login: "some-other-agent" },
                  body: "I'll take this one.",
                  createdAt: "2026-07-15T10:00:00.000Z",
                },
                // The PR author, but BEFORE reviewedAt (stale).
                {
                  author: { login: "danmcaulay" },
                  body: "Old reply from before the last review.",
                  createdAt: "2026-07-15T08:00:00.000Z",
                },
              ],
            },
          },
        ],
      },
    });

    const hasFreshAuthorReply = computeHasFreshAuthorReply(
      reviewData,
      pr.author.login,
      reviewedAtMs,
    );
    expect(hasFreshAuthorReply).toBe(false);

    const trace = traceReviewCandidacyDecision(
      baseArgs({ pr, record, reviewData, hasFreshAuthorReply }),
    );
    expect(trace).toEqual({
      check: "already-reviewed-live",
      classifiedState: "approved",
      hasFreshAuthorReply: false,
    });
  });

  test("RVD-2.1: already-reviewed-live: a genuine-finding review at head (classifyReviewState → null) still excludes, with classifiedState: null in the trace", () => {
    // The exact ambiguity being fixed: classifyReviewState() returns null
    // both for "no review at head at all" and for "a review exists but has
    // a genuine unaddressed finding". hasAnyReviewAtHead() disambiguates —
    // this fixture has a qualifying COMMENTED review with an unresolved
    // thread at head, so hasAnyReviewAtHead() is true even though
    // classifyReviewState() classifies it as null.
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "COMMENTED",
            commit: { oid: "sha111" },
            body: "Found a real issue here.",
          }),
        ],
      },
      reviewThreads: {
        nodes: [{ isResolved: false, comments: { nodes: [] } }],
      },
    });
    const trace = traceReviewCandidacyDecision(
      baseArgs({ reviewData, hasFreshAuthorReply: false }),
    );
    expect(trace).toEqual({
      check: "already-reviewed-live",
      classifiedState: null,
      hasFreshAuthorReply: false,
    });
  });

  test("eligible: no review at all at head (classifyReviewState → null, hasAnyReviewAtHead → false) stays eligible", () => {
    // The OTHER null case — genuinely no review exists at head yet. Must
    // remain review-eligible, unlike the genuine-finding null case above.
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: { nodes: [] },
    });
    const trace = traceReviewCandidacyDecision(baseArgs({ reviewData }));
    expect(trace).toEqual({ check: "eligible" });
  });

  test("task-blocked: linked task hitl:true excludes", () => {
    const linkedTask: LinkedTaskInfo = { status: "pr_open", hitl: true };
    const trace = traceReviewCandidacyDecision(baseArgs({ linkedTask }));
    expect(trace).toEqual({
      check: "task-blocked",
      hitl: true,
      taskStatus: "pr_open",
    });
  });

  test("task-blocked: linked task status:blocked excludes", () => {
    const linkedTask: LinkedTaskInfo = { status: "blocked", hitl: false };
    const trace = traceReviewCandidacyDecision(baseArgs({ linkedTask }));
    expect(trace).toEqual({
      check: "task-blocked",
      hitl: false,
      taskStatus: "blocked",
    });
  });

  test("bundle-incomplete: excludes with the branch name", () => {
    const pr = makePr({ headRefOid: "sha111", headRefName: "feat/incomplete" });
    const trace = traceReviewCandidacyDecision(
      baseArgs({ pr, isBundleComplete: false }),
    );
    expect(trace).toEqual({
      check: "bundle-incomplete",
      branch: "feat/incomplete",
    });
  });

  test("claimed: a record with claimedBy set excludes", () => {
    const record: PrRecord = {
      commitSha: null,
      reviewState: "pending",
      claimedBy: "agent-other",
    };
    const trace = traceReviewCandidacyDecision(baseArgs({ record }));
    expect(trace).toEqual({ check: "claimed", claimedBy: "agent-other" });
  });

  test("pr-record-blocked: a record with blocked:true excludes", () => {
    const record: PrRecord = {
      commitSha: null,
      reviewState: "pending",
      blocked: true,
    };
    const trace = traceReviewCandidacyDecision(baseArgs({ record }));
    expect(trace).toEqual({ check: "pr-record-blocked" });
  });

  test("already-reviewed-terminal: matching reviewedCommitSha and non-pending reviewState excludes", () => {
    const pr = makePr({ headRefOid: "sha111" });
    const record: PrRecord = {
      commitSha: "sha111",
      reviewedCommitSha: "sha111",
      reviewState: "posted",
    };
    const trace = traceReviewCandidacyDecision(baseArgs({ pr, record }));
    expect(trace).toEqual({
      check: "already-reviewed-terminal",
      reviewedCommitSha: "sha111",
      headRefOid: "sha111",
      reviewState: "posted",
    });
  });

  test("already-reviewed-terminal: a fresh author reply bypasses the terminal-skip exclusion (eligible)", () => {
    const pr = makePr({ headRefOid: "sha111" });
    const record: PrRecord = {
      commitSha: "sha111",
      reviewedCommitSha: "sha111",
      reviewState: "posted",
    };
    const trace = traceReviewCandidacyDecision(
      baseArgs({ pr, record, hasFreshAuthorReply: true }),
    );
    expect(trace).toEqual({ check: "eligible" });
  });

  test("staged: staged:true with matching reviewedCommitSha excludes regardless of reviewState", () => {
    const pr = makePr({ headRefOid: "sha111" });
    const record: PrRecord = {
      commitSha: "sha111",
      reviewedCommitSha: "sha111",
      reviewState: "pending",
      staged: true,
    };
    const trace = traceReviewCandidacyDecision(baseArgs({ pr, record }));
    expect(trace).toEqual({
      check: "staged",
      reviewedCommitSha: "sha111",
      headRefOid: "sha111",
    });
  });

  test("eligible: a record with a different reviewedCommitSha (new commits) is eligible", () => {
    const pr = makePr({ headRefOid: "newsha999" });
    const record: PrRecord = {
      commitSha: "oldsha111",
      reviewedCommitSha: "oldsha111",
      reviewState: "posted",
    };
    const trace = traceReviewCandidacyDecision(baseArgs({ pr, record }));
    expect(trace).toEqual({ check: "eligible" });
  });

  test("eligible: no record at all (never reviewed) is eligible", () => {
    const trace = traceReviewCandidacyDecision(baseArgs({ record: null }));
    expect(trace).toEqual({ check: "eligible" });
  });

  test("check precedence: already-reviewed-live is checked before task-blocked", () => {
    const reviewData = makeReviewData({
      headRefOid: "sha111",
      reviews: {
        nodes: [
          makeReviewNode({
            state: "APPROVED",
            commit: { oid: "sha111" },
            body: "LGTM",
          }),
        ],
      },
    });
    const linkedTask: LinkedTaskInfo = { status: "blocked", hitl: false };
    const trace = traceReviewCandidacyDecision(
      baseArgs({ reviewData, linkedTask }),
    );
    expect(trace.check).toBe("already-reviewed-live");
  });

  test("check precedence: claimed is checked before pr-record-blocked", () => {
    const record: PrRecord = {
      commitSha: null,
      reviewState: "pending",
      claimedBy: "agent-other",
      blocked: true,
    };
    const trace = traceReviewCandidacyDecision(baseArgs({ record }));
    expect(trace.check).toBe("claimed");
  });
});

describe("buildProductionDeps isAuthorAllowed default (AAL-2.2)", () => {
  beforeEach(() => {
    agentAuthorAllowlistRef.set([]);
  });

  afterEach(() => {
    agentAuthorAllowlistRef.set([]);
  });

  const noopGhJson = async <T>(): Promise<T> => [] as unknown as T;
  // These tests only care about the isAuthorAllowed default — pass an
  // explicit workspacePath stub so buildProductionDeps doesn't fall through
  // to resolveWorkspacePath() and depend on ambient AGENT_HOME/WORKSPACE_PATH
  // process.env state, which check-helpers.unit.test.ts's resolveWorkspacePath
  // suite temporarily deletes/restores around its own tests in this same
  // shared Bun test process.
  const stubWorkspacePath = "/tmp/aal-2.2-stub-workspace";

  test("defaults to unfiltered (fail-open) when the ref's allowlist is empty", async () => {
    agentAuthorAllowlistRef.set([]);
    const deps = await buildProductionDeps({
      ghJson: noopGhJson,
      workspacePath: stubWorkspacePath,
    });
    expect(deps.isAuthorAllowed).toBeDefined();
    expect(deps.isAuthorAllowed?.("anyone-at-all")).toBe(true);
  });

  test("defaults to filtering by the ref's allowlist when it is non-empty", async () => {
    agentAuthorAllowlistRef.set(["allowed-user"]);
    const deps = await buildProductionDeps({
      ghJson: noopGhJson,
      workspacePath: stubWorkspacePath,
    });
    expect(deps.isAuthorAllowed?.("allowed-user")).toBe(true);
    expect(deps.isAuthorAllowed?.("someone-else")).toBe(false);
  });

  test("an explicit opts.isAuthorAllowed overrides the ref-backed default", async () => {
    agentAuthorAllowlistRef.set(["ref-user"]);
    const deps = await buildProductionDeps({
      ghJson: noopGhJson,
      workspacePath: stubWorkspacePath,
      isAuthorAllowed: (login) => login === "explicit-user",
    });
    expect(deps.isAuthorAllowed?.("ref-user")).toBe(false);
    expect(deps.isAuthorAllowed?.("explicit-user")).toBe(true);
  });
});

describe("buildProductionDeps isAuthorAllowed default — never-synced equivalence (T-078)", () => {
  // Deliberately NOT using the shared agentAuthorAllowlistRef singleton or its
  // beforeEach(() => ref.set([])) reset (see the AAL-2.2 block above) — that
  // reset stamps hasSynced() === true before every test in that block, which
  // makes it structurally impossible to exercise the true "never synced"
  // (hasSynced() === false) state from in there. Each test below builds its
  // own fresh, independent ref via createAgentAuthorAllowlistRef() instead.

  const noopGhJson = async <T>(): Promise<T> => [] as unknown as T;
  // See stubWorkspacePath comment in the AAL-2.2 describe block above — same
  // rationale applies here.
  const stubWorkspacePath = "/tmp/t-078-stub-workspace";

  test("a never-synced ref (hasSynced() === false, .set() never called) fails open / unfiltered", async () => {
    const neverSyncedRef = createAgentAuthorAllowlistRef();
    expect(neverSyncedRef.hasSynced()).toBe(false);
    expect(neverSyncedRef.get()).toEqual([]);

    const deps = await buildProductionDeps({
      ghJson: noopGhJson,
      workspacePath: stubWorkspacePath,
      authorAllowlistRef: neverSyncedRef,
    });

    expect(deps.isAuthorAllowed).toBeDefined();
    expect(deps.isAuthorAllowed?.("anyone-at-all")).toBe(true);
    expect(deps.isAuthorAllowed?.("literally-anyone-else")).toBe(true);
  });

  test("a ref synced-to-empty (hasSynced() === true, .set([]) called) behaves identically: also fails open / unfiltered", async () => {
    const syncedEmptyRef = createAgentAuthorAllowlistRef();
    syncedEmptyRef.set([]);
    expect(syncedEmptyRef.hasSynced()).toBe(true);
    expect(syncedEmptyRef.get()).toEqual([]);

    const deps = await buildProductionDeps({
      ghJson: noopGhJson,
      workspacePath: stubWorkspacePath,
      authorAllowlistRef: syncedEmptyRef,
    });

    expect(deps.isAuthorAllowed).toBeDefined();
    expect(deps.isAuthorAllowed?.("anyone-at-all")).toBe(true);
    expect(deps.isAuthorAllowed?.("literally-anyone-else")).toBe(true);
  });

  test("never-synced and synced-to-empty are intentionally, not accidentally, equivalent: same input, same output", async () => {
    const neverSyncedRef = createAgentAuthorAllowlistRef();
    const syncedEmptyRef = createAgentAuthorAllowlistRef();
    syncedEmptyRef.set([]);

    const neverSyncedDeps = await buildProductionDeps({
      ghJson: noopGhJson,
      workspacePath: stubWorkspacePath,
      authorAllowlistRef: neverSyncedRef,
    });
    const syncedEmptyDeps = await buildProductionDeps({
      ghJson: noopGhJson,
      workspacePath: stubWorkspacePath,
      authorAllowlistRef: syncedEmptyRef,
    });

    for (const login of ["danmcaulay", "anyone-at-all", ""]) {
      expect(neverSyncedDeps.isAuthorAllowed?.(login)).toBe(
        syncedEmptyDeps.isAuthorAllowed?.(login),
      );
      expect(neverSyncedDeps.isAuthorAllowed?.(login)).toBe(true);
    }
  });

  test("a never-synced ref does not affect the singleton-backed default in the other describe block", async () => {
    // Sanity guard: using an injected fresh ref must not accidentally reach
    // into / mutate the process-wide singleton.
    agentAuthorAllowlistRef.set(["some-user"]);
    const neverSyncedRef = createAgentAuthorAllowlistRef();

    const deps = await buildProductionDeps({
      ghJson: noopGhJson,
      workspacePath: stubWorkspacePath,
      authorAllowlistRef: neverSyncedRef,
    });

    expect(deps.isAuthorAllowed?.("some-user")).toBe(true);
    expect(deps.isAuthorAllowed?.("unrelated-user")).toBe(true);
    expect(agentAuthorAllowlistRef.get()).toEqual(["some-user"]);

    // cleanup so this doesn't leak into other describe blocks in the file
    agentAuthorAllowlistRef.set([]);
  });
});
