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

import { describe, expect, test } from "bun:test";
import {
  type CheckReviewDeps,
  type PrInfo,
  type PrRecord,
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

function makeDeps(
  prs: PrInfo[],
  queryPrRecordFn: (
    repo: string,
    prNumber: number,
  ) => Promise<PrRecord | null> = async () => null,
  currentUser = "bodhi-agent",
  isSelfReviewAllowed = false,
): CheckReviewDeps {
  return {
    listOpenPrs: async (_repo: string) => prs,
    queryPrRecord: queryPrRecordFn,
    getCurrentUser: () => currentUser,
    isSelfReviewAllowed,
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
        if (prNumber === 1) return { commitSha: "sha-A", reviewState: "posted" };
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
      getCurrentUser: () => "bodhi-agent",
      isSelfReviewAllowed: false,
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
  });

  // ─── age field sourcing ──────────────────────────────────────────────────

  test("age is sourced from readyForReviewAt when a task-store record exists", async () => {
    const pr = makePr({ headRefOid: "newsha", createdAt: "2026-06-01T00:00:00.000Z" });
    const result = await getReviewCandidates(
      makeDeps([pr], async () => ({
        commitSha: "oldsha",
        reviewState: "posted",
        readyForReviewAt: "2026-05-15T00:00:00.000Z",
      })),
    );
    expect(result[0].age).toBe("2026-05-15T00:00:00.000Z");
  });

  test("age falls back to PR createdAt when no task-store record exists", async () => {
    const pr = makePr({ createdAt: "2026-06-01T00:00:00.000Z" });
    const result = await getReviewCandidates(makeDeps([pr], async () => null));
    expect(result[0].age).toBe("2026-06-01T00:00:00.000Z");
  });
});
