// Unit tests for compute-unaddressed-findings.ts — pure logic, no I/O.
//
// Ported from agent/src/check-patch.unit.test.ts's getPatchCandidates()-level
// scenario matrix (PVD-1.1) — these scenarios exercised hasUnaddressedFindings
// and its three helpers (isSelfCleanApprove, isAddressedByAuthorReply,
// isSupersededBySelfReview) only indirectly, through the full candidate
// collection pipeline. Now that hasUnaddressedFindings is extracted and
// exported, these scenarios are ported to call it directly with a
// PrReviewData + currentUser input, asserting the boolean result — same
// scenarios, new location, not duplicated in agent/src/check-patch.unit.test.ts
// (see that file's remaining getPatchCandidates() tests for wiring-level
// smoke coverage instead).

import { describe, expect, test } from "bun:test";
import {
  hasUnaddressedFindings,
  type IssueCommentNode,
  isAddressedByAuthorReply,
  isSelfCleanApprove,
  isSupersededBySelfReview,
  type PrReviewData,
  type ReviewNode,
} from "./compute-unaddressed-findings.ts";

function makeData(overrides: Partial<PrReviewData> = {}): PrReviewData {
  return {
    headRefOid: "current-head-sha",
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    ...overrides,
  };
}

describe("hasUnaddressedFindings", () => {
  test("returns false when there are no COMMENT/CHANGES_REQUESTED reviews", () => {
    const data = makeData({
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
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("returns true when a COMMENT review has unresolved inline threads", () => {
    const data = makeData({
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
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("returns true when a CHANGES_REQUESTED review has a non-empty body at current HEAD", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("returns false when the COMMENT review was posted at an older commit (new commits pushed since)", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("returns false when all inline threads are resolved and review body is empty", () => {
    const data = makeData({
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
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("returns true when a COMMENT review has a non-empty body and no inline threads", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  // ─── Self-authored review exclusion (CPF-1.1) ─────────────────────────────

  test("returns false when only review is self-authored COMMENTED at current HEAD with non-empty APPROVE body", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("returns true when self-authored clean-APPROVE review coexists with a different reviewer's CHANGES_REQUESTED finding", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  // ─── Self-review with real findings still counts (CPF-1.2) ────────────────

  test("returns true when self-authored COMMENTED review at current HEAD has a non-APPROVE body with a real finding", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  // ─── Bold-wrapped self-APPROVE verdicts (CPF-1.3) ──────────────────────────

  test("returns false when only review is self-authored COMMENTED at current HEAD with a bold-wrapped APPROVE verdict", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  // ─── Narrative "Verdict: APPROVE" self-reviews (CPF-2.1) ───────────────────

  test("returns false when only review is self-authored COMMENTED at current HEAD with a narrative ending in Verdict: APPROVE", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("returns false when self-authored review trails reasoning after Verdict: APPROVE on the same line (verbatim shipwright PR #1272 case)", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("returns true when a narrative Verdict: APPROVE self-review coexists with a different reviewer's CHANGES_REQUESTED finding", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("returns true when self-authored review has a narrative ending in Verdict: CHANGES_REQUESTED", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  // ─── Self-review superseded by a later clean self-review (DRO-1.2) ────────

  test("returns false when an earlier self-authored COMMENT review is superseded by a later clean self-review", () => {
    const data = makeData({
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verdict: COMMENT — found a race condition in the retry logic, needs a fix before merge.",
          },
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-27T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verified the race condition is fixed. Verdict: APPROVE",
          },
        ],
      },
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("returns true when an earlier self-authored COMMENT review is followed by a LATER self-review that is itself non-clean", () => {
    const data = makeData({
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verdict: COMMENT — found issue #1.",
          },
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-27T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verdict: COMMENT — found a fresh issue #2.",
          },
        ],
      },
    });
    // Both self-reviews still count as findings: the earlier one is not
    // superseded (the later one isn't clean), and the later one is its own
    // real finding.
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("does NOT supersede an earlier self-review when the clean self-review comes BEFORE it (order matters)", () => {
    const data = makeData({
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verdict: APPROVE — looks good so far.",
          },
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-27T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verdict: COMMENT — found a new issue on a later pass.",
          },
        ],
      },
    });
    // The earlier review is a clean-APPROVE itself (excluded on its own
    // grounds), and the later non-clean self-review is a real, un-superseded
    // finding.
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("does NOT supersede a THIRD-PARTY review's finding, even when a later self-review is clean", () => {
    const data = makeData({
      reviews: {
        nodes: [
          {
            author: { login: "dodizzle" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Missing plugin.json/marketplace.json version bump.",
          },
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-27T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verdict: APPROVE",
          },
        ],
      },
    });
    // The DRO-1.2 exclusion only supersedes self-authored reviews — a
    // third-party's finding is untouched by a later self-review.
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  // ─── Third-party review addressed via author reply (CPF-2.3) ──────────────

  test("returns false when a third-party COMMENTED review's non-empty body is followed by a PR-author reply (mirrors PR #1432)", () => {
    const data = makeData({
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
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("returns true when the PR-author's reply predates the review (stale reply doesn't address a later review)", () => {
    const data = makeData({
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
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("returns true when a third-party review has a non-empty body, no unresolved threads, and no PR-author reply at all", () => {
    const data = makeData({
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
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("returns true when a third-party review's body is followed by an author reply BUT an inline thread is still unresolved", () => {
    const data = makeData({
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
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("returns true when the PR-level reply is from someone other than the PR author", () => {
    const data = makeData({
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
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });
});

// ─── Helper predicates, tested directly ────────────────────────────────────

describe("isSelfCleanApprove", () => {
  test("false when the review is not self-authored", () => {
    const review: Pick<ReviewNode, "author" | "body"> = {
      author: { login: "reviewer1" },
      body: "APPROVE",
    };
    expect(isSelfCleanApprove(review, "the-agent")).toBe(false);
  });

  test("true when self-authored and body starts with APPROVE", () => {
    const review: Pick<ReviewNode, "author" | "body"> = {
      author: { login: "the-agent" },
      body: "APPROVE — looks good.",
    };
    expect(isSelfCleanApprove(review, "the-agent")).toBe(true);
  });

  test("false when self-authored but body is a real finding", () => {
    const review: Pick<ReviewNode, "author" | "body"> = {
      author: { login: "the-agent" },
      body: "Verdict: CHANGES_REQUESTED — found a bug.",
    };
    expect(isSelfCleanApprove(review, "the-agent")).toBe(false);
  });
});

describe("isAddressedByAuthorReply", () => {
  test("true when currentUser replied after the review", () => {
    const review: Pick<ReviewNode, "submittedAt"> = {
      submittedAt: "2026-05-26T10:00:00Z",
    };
    const comments: IssueCommentNode[] = [
      {
        author: { login: "the-agent" },
        body: "fixed",
        createdAt: "2026-05-26T11:00:00Z",
      },
    ];
    expect(isAddressedByAuthorReply(review, comments, "the-agent")).toBe(
      true,
    );
  });

  test("false when currentUser's reply predates the review", () => {
    const review: Pick<ReviewNode, "submittedAt"> = {
      submittedAt: "2026-05-26T10:00:00Z",
    };
    const comments: IssueCommentNode[] = [
      {
        author: { login: "the-agent" },
        body: "unrelated",
        createdAt: "2026-05-26T09:00:00Z",
      },
    ];
    expect(isAddressedByAuthorReply(review, comments, "the-agent")).toBe(
      false,
    );
  });
});

describe("isSupersededBySelfReview", () => {
  test("true when a later clean self-review from the same author exists", () => {
    const review: Pick<ReviewNode, "author" | "submittedAt"> = {
      author: { login: "the-agent" },
      submittedAt: "2026-05-26T10:00:00Z",
    };
    const allReviews: ReviewNode[] = [
      {
        author: { login: "the-agent" },
        state: "COMMENTED",
        submittedAt: "2026-05-26T10:00:00Z",
        commit: { oid: "sha" },
        body: "Verdict: COMMENT — found issue.",
      },
      {
        author: { login: "the-agent" },
        state: "COMMENTED",
        submittedAt: "2026-05-27T10:00:00Z",
        commit: { oid: "sha" },
        body: "Verdict: APPROVE",
      },
    ];
    expect(isSupersededBySelfReview(review, allReviews, "the-agent")).toBe(
      true,
    );
  });

  test("false when the later self-review is not itself clean", () => {
    const review: Pick<ReviewNode, "author" | "submittedAt"> = {
      author: { login: "the-agent" },
      submittedAt: "2026-05-26T10:00:00Z",
    };
    const allReviews: ReviewNode[] = [
      {
        author: { login: "the-agent" },
        state: "COMMENTED",
        submittedAt: "2026-05-26T10:00:00Z",
        commit: { oid: "sha" },
        body: "Verdict: COMMENT — found issue #1.",
      },
      {
        author: { login: "the-agent" },
        state: "COMMENTED",
        submittedAt: "2026-05-27T10:00:00Z",
        commit: { oid: "sha" },
        body: "Verdict: COMMENT — found issue #2.",
      },
    ];
    expect(isSupersededBySelfReview(review, allReviews, "the-agent")).toBe(
      false,
    );
  });

  test("false when not self-authored", () => {
    const review: Pick<ReviewNode, "author" | "submittedAt"> = {
      author: { login: "dodizzle" },
      submittedAt: "2026-05-26T10:00:00Z",
    };
    const allReviews: ReviewNode[] = [
      {
        author: { login: "the-agent" },
        state: "COMMENTED",
        submittedAt: "2026-05-27T10:00:00Z",
        commit: { oid: "sha" },
        body: "Verdict: APPROVE",
      },
    ];
    expect(isSupersededBySelfReview(review, allReviews, "the-agent")).toBe(
      false,
    );
  });
});

// ─── CLI entrypoint (argv/stdin JSON parsing) ──────────────────────────────

const SCRIPT_PATH = new URL("./compute-unaddressed-findings.ts", import.meta.url)
  .pathname;

describe("CLI entrypoint", () => {
  test("reads input from argv and prints {unaddressedFindings: true} for a qualifying finding", async () => {
    const input = JSON.stringify({
      currentUser: "the-agent",
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please fix this.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
    });
    const proc = Bun.spawn(["bun", "run", SCRIPT_PATH, input], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ unaddressedFindings: true });
    expect(stderr).toBe("");
  });

  test("reads input from stdin when no argv arg is provided, and prints {unaddressedFindings: false} for a clean PR", async () => {
    const input = JSON.stringify({
      currentUser: "the-agent",
      headRefOid: "current-head-sha",
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
    });
    const proc = Bun.spawn(["bun", "run", SCRIPT_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(input);
    await proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ unaddressedFindings: false });
    expect(stderr).toBe("");
  });

  test("exits non-zero with an error when required fields are missing", async () => {
    const proc = Bun.spawn(["bun", "run", SCRIPT_PATH, '{"currentUser":"the-agent"}'], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [_stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
