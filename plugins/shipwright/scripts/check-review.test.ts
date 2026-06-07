/**
 * plugins/shipwright/scripts/check-review.test.ts
 *
 * Unit tests for check-review.ts
 *
 * Design: the script exports a `run(deps)` function with injectable deps
 * for GH PR listing, current headRefOid fetching, and reviews.json reading.
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
}

interface ReviewEntry {
  pr: number;
  repo: string;
  lastReviewedCommit?: string;
  status?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface CommitInfo {
  sha: string;
  parents: Array<{ sha: string }>;
}

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 42,
    title: "Add feature X",
    author: { login: "danmcaulay" },
    headRefName: "feat/x",
    headRefOid: "abc123def456",
    ...overrides,
  };
}

function makeDeps(
  prs: PrInfo[],
  reviewEntries: ReviewEntry[] = [],
  currentUser = "bodhi-agent",
  isSelfReviewAllowed = false,
  prCommits: CommitInfo[] = [],
) {
  return {
    listOpenPrs: async (_repo: string) => prs,
    readReviews: () => reviewEntries,
    getCurrentUser: () => currentUser,
    isSelfReviewAllowed,
    listPrCommits: async (_prNumber: number) => prCommits,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-review", () => {
  test("exits 1 when no open PRs exist", async () => {
    const result = await run(makeDeps([]));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 with prompt when open PR has no review entry", async () => {
    const result = await run(makeDeps([makePr()], []));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when open PR entry has matching lastReviewedCommit (already reviewed)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const entry: ReviewEntry = {
      pr: 42,
      repo: "vitals-os",
      lastReviewedCommit: "sha111",
      status: "posted",
    };
    const result = await run(makeDeps([pr], [entry]));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when open PR entry has different lastReviewedCommit (new commits since review)", async () => {
    const pr = makePr({ headRefOid: "newsha999" });
    const entry: ReviewEntry = {
      pr: 42,
      repo: "vitals-os",
      lastReviewedCommit: "oldsha111",
      status: "posted",
    };
    const result = await run(makeDeps([pr], [entry]));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 when open PR entry has no lastReviewedCommit field", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const entry: ReviewEntry = {
      pr: 42,
      repo: "vitals-os",
      status: "pending",
    };
    const result = await run(makeDeps([pr], [entry]));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when all open PRs are already reviewed at current HEAD", async () => {
    const prs = [
      makePr({ number: 1, headRefOid: "sha-A" }),
      makePr({ number: 2, headRefOid: "sha-B" }),
    ];
    const entries: ReviewEntry[] = [
      { pr: 1, repo: "vitals-os", lastReviewedCommit: "sha-A" },
      { pr: 2, repo: "vitals-os", lastReviewedCommit: "sha-B" },
    ];
    const result = await run(makeDeps(prs, entries));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when at least one PR needs review (others already reviewed)", async () => {
    const prs = [
      makePr({ number: 1, headRefOid: "sha-A" }),
      makePr({ number: 2, headRefOid: "sha-B-new" }),
    ];
    const entries: ReviewEntry[] = [
      { pr: 1, repo: "vitals-os", lastReviewedCommit: "sha-A" },
      { pr: 2, repo: "vitals-os", lastReviewedCommit: "sha-B-old" },
    ];
    const result = await run(makeDeps(prs, entries));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when only PRs are from current user and isSelfReviewAllowed is false", async () => {
    const pr = makePr({ author: { login: "bodhi-agent" } });
    const result = await run(makeDeps([pr], [], "bodhi-agent", false));
    // Own PRs are excluded when allow_self_review is false
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 when PR is authored by current user and isSelfReviewAllowed is true", async () => {
    const pr = makePr({ author: { login: "bodhi-agent" } });
    const result = await run(makeDeps([pr], [], "bodhi-agent", true));
    // Own PRs are eligible when isSelfReviewAllowed is true
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 when PR is authored by different user", async () => {
    const pr = makePr({ author: { login: "danmcaulay" } });
    const result = await run(makeDeps([pr], [], "bodhi-agent"));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 1 when entry has status cleaned or merged (terminal)", async () => {
    const pr = makePr({ headRefOid: "sha111" });
    const entry: ReviewEntry = {
      pr: 42,
      repo: "vitals-os",
      lastReviewedCommit: "sha000",
      status: "cleaned",
    };
    const result = await run(makeDeps([pr], [entry]));
    // cleaned = terminal, skip regardless of sha mismatch
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("prompt mentions shipwright:review", async () => {
    const result = await run(makeDeps([makePr()]));
    expect(result.exit).toBe(0);
    expect(result.output.toLowerCase()).toContain("review");
  });

  test("exits 1 (skips PR) when SHA mismatch but all new commits are merge commits (merge-only update)", async () => {
    const pr = makePr({ number: 42, headRefOid: "sha-new" });
    const entry: ReviewEntry = {
      pr: 42,
      repo: "vitals-os",
      lastReviewedCommit: "sha-anchor",
      status: "posted",
    };
    const prCommits: CommitInfo[] = [
      { sha: "sha-anchor", parents: [{ sha: "p1" }] },
      { sha: "sha-new", parents: [{ sha: "a" }, { sha: "b" }] },
    ];
    const result = await run(
      makeDeps([pr], [entry], "bodhi-agent", false, prCommits),
    );
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 (triggers review) when SHA mismatch and at least one new commit is not a merge commit", async () => {
    const pr = makePr({ number: 42, headRefOid: "sha-new2" });
    const entry: ReviewEntry = {
      pr: 42,
      repo: "vitals-os",
      lastReviewedCommit: "sha-anchor",
      status: "posted",
    };
    const prCommits: CommitInfo[] = [
      { sha: "sha-anchor", parents: [{ sha: "p1" }] },
      { sha: "sha-real-work", parents: [{ sha: "p2" }] },
      { sha: "sha-new2", parents: [{ sha: "a" }, { sha: "b" }] },
    ];
    const result = await run(
      makeDeps([pr], [entry], "bodhi-agent", false, prCommits),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("exits 0 (triggers review) when listPrCommits throws (graceful degradation)", async () => {
    const pr = makePr({ number: 42, headRefOid: "sha-new" });
    const entry: ReviewEntry = {
      pr: 42,
      repo: "vitals-os",
      lastReviewedCommit: "sha-anchor",
      status: "posted",
    };
    const deps = {
      listOpenPrs: async (_repo: string) => [pr],
      readReviews: () => [entry],
      getCurrentUser: () => "bodhi-agent",
      isSelfReviewAllowed: false,
      listPrCommits: async (_prNumber: number): Promise<CommitInfo[]> => {
        throw new Error("API error");
      },
    };
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("does not call listPrCommits when no lastReviewedCommit (never reviewed)", async () => {
    const pr = makePr({ number: 42, headRefOid: "sha111" });
    const entry: ReviewEntry = {
      pr: 42,
      repo: "vitals-os",
      status: "pending",
      // no lastReviewedCommit
    };
    let listPrCommitsCalled = false;
    const deps = {
      listOpenPrs: async (_repo: string) => [pr],
      readReviews: () => [entry],
      getCurrentUser: () => "bodhi-agent",
      isSelfReviewAllowed: false,
      listPrCommits: async (_prNumber: number): Promise<CommitInfo[]> => {
        listPrCommitsCalled = true;
        return [];
      },
    };
    const result = await run(deps);
    expect(result.exit).toBe(0);
    expect(listPrCommitsCalled).toBe(false);
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
