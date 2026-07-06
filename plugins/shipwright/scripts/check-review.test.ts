/**
 * plugins/shipwright/scripts/check-review.test.ts
 *
 * Unit tests for check-review.ts
 *
 * Design: the script exports a `run(deps)` function with injectable deps
 * for GH PR listing, current headRefOid fetching, and PR table querying.
 */

import { describe, expect, test } from "bun:test";
import { parseAllowSelfReview, run } from "./check-review.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PrInfo {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  headRefOid: string;
  repo?: string;
  isDraft: boolean;
  labels?: { name: string }[];
}

interface PrRecord {
  commitSha?: string | null;
  reviewState: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    title: "Add feature X",
    author: { login: "danmcaulay" },
    headRefName: "feat/x",
    headRefOid: "abc123def456",
    repo: "example-repo",
    isDraft: false,
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
) {
  return {
    listOpenPrs: async (_repo: string) => prs,
    queryPrRecord: queryPrRecordFn,
    getCurrentUser: () => currentUser,
    isSelfReviewAllowed,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-review", () => {
  test("exits 1 when no open PRs exist", async () => {
    const result = await run(makeDeps([]));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 with prompt when open PR has no PR record (queryPrRecord returns null)", async () => {
    const result = await run(makeDeps([makePr()], async () => null));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when PR record has matching commitSha and reviewState is posted (already reviewed)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await run(
      makeDeps([pr], async () => ({
        commitSha: "sha111",
        reviewState: "posted",
      })),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when PR record has different commitSha (new commits since review)", async () => {
    const pr = makePr({ headRefOid: "newsha999" });
    const result = await run(
      makeDeps([pr], async () => ({
        commitSha: "oldsha111",
        reviewState: "posted",
      })),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 when PR record has reviewState=pending (even if commitSha matches)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await run(
      makeDeps([pr], async () => ({
        commitSha: "sha111",
        reviewState: "pending",
      })),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 when PR record has null commitSha", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const result = await run(
      makeDeps([pr], async () => ({
        commitSha: null,
        reviewState: "posted",
      })),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when all open PRs have matching commitSha and non-pending reviewState", async () => {
    const prs = [
      makePr({ number: 1, headRefOid: "sha-A" }),
      makePr({ number: 2, headRefOid: "sha-B" }),
    ];
    const result = await run(
      makeDeps([...prs], async (_repo, prNumber) => ({
        commitSha: prNumber === 1 ? "sha-A" : "sha-B",
        reviewState: "posted",
      })),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when at least one PR needs review (others already reviewed)", async () => {
    const prs = [
      makePr({ number: 1, headRefOid: "sha-A" }),
      makePr({ number: 2, headRefOid: "sha-B-new" }),
    ];
    const result = await run(
      makeDeps([...prs], async (_repo, prNumber) => {
        if (prNumber === 1) return { commitSha: "sha-A", reviewState: "posted" };
        return { commitSha: "sha-B-old", reviewState: "posted" };
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when only PRs are from current user and isSelfReviewAllowed is false", async () => {
    const pr = makePr({ author: { login: "bodhi-agent" } });
    const result = await run(makeDeps([pr], async () => null, "bodhi-agent", false));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when PR is authored by current user and isSelfReviewAllowed is true", async () => {
    const pr = makePr({ author: { login: "bodhi-agent" } });
    const result = await run(makeDeps([pr], async () => null, "bodhi-agent", true));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 when PR is authored by different user", async () => {
    const pr = makePr({ author: { login: "danmcaulay" } });
    const result = await run(makeDeps([pr], async () => null, "bodhi-agent"));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("prompt mentions shipwright:review", async () => {
    const result = await run(makeDeps([makePr()], async () => null));
    expect(result.exit).toBe(0);
    expect(result.output.toLowerCase()).toContain("review");
  });

  // ─── multi-repo: dedup keyed on repo+prNumber via queryPrRecord ──────────────

  test("multi-repo: two repos with the same PR number are deduped independently", async () => {
    // PR #42 in repo-A is reviewed (commitSha matches, reviewState=posted).
    // PR #42 in repo-B has no record → should trigger.
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
    const result = await run(
      makeDeps([prA, prB], async (repo, _prNumber) => {
        if (repo === "example-org/repo-a") {
          return { commitSha: "sha-A", reviewState: "posted" };
        }
        return null; // repo-b has no record → eligible
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  // ─── queryPrRecord failure → treat as eligible ───────────────────────────────

  test("exits 0 (eligible) when queryPrRecord throws (graceful degradation)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const deps = {
      listOpenPrs: async (_repo: string) => [pr],
      queryPrRecord: async (_repo: string, _prNumber: number): Promise<PrRecord | null> => {
        throw new Error("Network error");
      },
      getCurrentUser: () => "bodhi-agent",
      isSelfReviewAllowed: false,
    };
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  // ─── draft / dependabot exclusions ───────────────────────────────────────────

  test("exits 1 when all open PRs are drafts", async () => {
    const prs = [
      makePr({ number: 1, isDraft: true }),
      makePr({ number: 2, isDraft: true }),
    ];
    const result = await run(makeDeps(prs, async () => null));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when all open PRs are authored by app/dependabot", async () => {
    const prs = [
      makePr({ number: 1, author: { login: "app/dependabot" } }),
      makePr({ number: 2, author: { login: "app/dependabot" } }),
    ];
    const result = await run(makeDeps(prs, async () => null));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when mix of draft/dependabot/eligible PRs has one eligible non-draft non-dependabot PR", async () => {
    const prs = [
      makePr({ number: 1, isDraft: true }),
      makePr({ number: 2, author: { login: "app/dependabot" } }),
      makePr({ number: 3, author: { login: "danmcaulay" } }),
    ];
    const result = await run(makeDeps(prs, async () => null));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  // ─── automated label exclusion ────────────────────────────────────────────

  test("exits 1 when all open PRs are labeled automated", async () => {
    const prs = [
      makePr({ number: 1, labels: [{ name: "automated" }] }),
      makePr({ number: 2, labels: [{ name: "automated" }] }),
    ];
    const result = await run(makeDeps(prs, async () => null));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when mix of automated/eligible PRs has one eligible non-automated PR", async () => {
    const prs = [
      makePr({ number: 1, labels: [{ name: "automated" }] }),
      makePr({ number: 2, author: { login: "danmcaulay" } }),
    ];
    const result = await run(makeDeps(prs, async () => null));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 when PR has unrelated labels (not automated)", async () => {
    const pr = makePr({ labels: [{ name: "bug" }, { name: "enhancement" }] });
    const result = await run(makeDeps([pr], async () => null));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });
});

describe("parseAllowSelfReview", () => {
  test("table format with true returns true", () => {
    const content = "| `allow_self_review` | true | some description |";
    expect(parseAllowSelfReview(content)).toBe(true);
  });

  test("table format with false returns false", () => {
    const content = "| `allow_self_review` | false | some description |";
    expect(parseAllowSelfReview(content)).toBe(false);
  });

  test("bold-colon format with true returns true", () => {
    const content = "- **allow_self_review**: true";
    expect(parseAllowSelfReview(content)).toBe(true);
  });

  test("bold-colon format with false returns false", () => {
    const content = "- **allow_self_review**: false";
    expect(parseAllowSelfReview(content)).toBe(false);
  });

  test("no match returns true (default)", () => {
    const content = "# Agent Policy\n\nSome unrelated content.";
    expect(parseAllowSelfReview(content)).toBe(true);
  });

  test("empty string returns true (default)", () => {
    expect(parseAllowSelfReview("")).toBe(true);
  });
});
