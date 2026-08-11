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

  test("returns empty array when PR record has matching commitSha and reviewState is posted (already reviewed)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "sha111",
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
          return { commitSha: "sha-A", reviewState: "posted" };
        return { commitSha: "sha-B-old", reviewState: "posted" };
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
          return { commitSha: "sha-A", reviewState: "posted" };
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
  // A PR that is already terminal (record.commitSha === pr.headRefOid &&
  // reviewState !== "pending") is normally skipped at the terminal-skip
  // check. RVG-1.1 adds one exception: if the PR AUTHOR has posted a
  // PR-level comment with createdAt after record.reviewedAt, the PR is
  // re-added as a candidate so a follow-up review pass can consume the
  // reply (review.md's CPF-2.3 exclusion never gets exercised otherwise).
  //
  // These fixtures use a qualifying COMMENTED review with an unresolved
  // thread at head (mirrors the "still a genuine finding" shape from the
  // RVD-1.1 block above) so classifyReviewState() returns null and the
  // earlier live-review dedup does NOT short-circuit before reaching the
  // terminal-skip branch under test.

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
