// Unit tests for compute-unaddressed-findings.ts — pure logic, no I/O.
//
// Ported from agent/src/check-patch.unit.test.ts's getPatchCandidates()-level
// scenario matrix (PVD-1.1) — these scenarios exercised hasUnaddressedFindings
// and its helpers only indirectly, through the full candidate collection
// pipeline. Now that hasUnaddressedFindings is extracted and exported, these
// scenarios are ported to call it directly with a PrReviewData + currentUser
// input, asserting the boolean result — same scenarios, new location, not
// duplicated in agent/src/check-patch.unit.test.ts (see that file's
// remaining getPatchCandidates() tests for wiring-level smoke coverage
// instead).
//
// PFL-4.1 removed the isSelfCleanApprove/isSupersededBySelfReview/
// isResolvedByPriorFindingsStatus exclusions from hasUnaddressedFindings
// (production ledger data confirmed isResolvedByLedger, PFL-3.2, covers
// every case they caught) and deleted the now-dead isResolvedByPriorFindingsStatus
// entirely. isSelfCleanApprove and isSupersededBySelfReview themselves are
// still exported and still tested directly below — review.md's Step 5.5
// still calls them to decide what to write to the findings ledger.

import { describe, expect, test } from "bun:test";
import { computeVerdict } from "./compute-review-verdict.ts";
import {
  type IssueCommentNode,
  type PrFinding,
  type PrReviewData,
  type ReviewNode,
  type ReviewThread,
  hasUnaddressedFindings,
  isAddressedByAuthorReply,
  isResolvedByLedger,
  isSelfCleanApprove,
  isSupersededBySelfReview,
  isThreadAddressedByAuthorReply,
  parseCliInput,
  reviewRef,
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

  // ─── Ledger-based resolved/superseded exclusion (PFL-3.2) ─────────────────
  //
  // A qualifying review is excluded when a task-store ledger entry
  // (source: "review") exists for its ref with disposition "resolved" or
  // "superseded" — independent of self-authorship, since ledger entries are
  // written by the code-reviewer subagent regardless of whose review is
  // being resolved. (PFL-4.1 removed the three inference-based exclusions
  // this used to be additive to — see this file's header comment.)

  test("returns false when a qualifying review's ledger entry has disposition resolved (source: review)", () => {
    const finding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — found a race condition in the retry logic.",
    };
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref: reviewRef(finding),
        disposition: "resolved",
        source: "review",
        evidence: "src/retry.ts:42 — guard added.",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    const data = makeData({ reviews: { nodes: [finding] }, findings });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("returns false when a qualifying review's ledger entry has disposition superseded (source: review)", () => {
    const finding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — found a race condition in the retry logic.",
    };
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref: reviewRef(finding),
        disposition: "superseded",
        source: "review",
        evidence: "later pass covers this.",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    const data = makeData({ reviews: { nodes: [finding] }, findings });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("does NOT exclude when the matching ledger entry has source: patch", () => {
    const finding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — found a race condition in the retry logic.",
    };
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref: reviewRef(finding),
        disposition: "resolved",
        source: "patch",
        evidence: "fixed via patch run.",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    const data = makeData({ reviews: { nodes: [finding] }, findings });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("does NOT exclude when the matching ledger entry has disposition rejected", () => {
    const finding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — found a race condition in the retry logic.",
    };
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref: reviewRef(finding),
        disposition: "rejected",
        source: "review",
        evidence: "not a real issue.",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    const data = makeData({ reviews: { nodes: [finding] }, findings });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("does NOT exclude when the ledger entry's ref does not match the review", () => {
    const finding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — found a race condition in the retry logic.",
    };
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref: "some-other-ref",
        disposition: "resolved",
        source: "review",
        evidence: "unrelated.",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    const data = makeData({ reviews: { nodes: [finding] }, findings });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("excludes a THIRD-PARTY review's finding via a matching ledger entry (no self-authorship gate)", () => {
    const finding: ReviewNode = {
      author: { login: "dodizzle" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Missing plugin.json/marketplace.json version bump.",
    };
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref: reviewRef(finding),
        disposition: "resolved",
        source: "review",
        evidence: "bumped both files.",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    const data = makeData({ reviews: { nodes: [finding] }, findings });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("excludes a finding via the ledger even when the author-reply exclusion doesn't apply (ledger is the sole path)", () => {
    // Third-party review with no author reply (so isAddressedByAuthorReply
    // can't apply). Only the ledger entry resolves it.
    const finding: ReviewNode = {
      author: { login: "dodizzle" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Missing plugin.json/marketplace.json version bump.",
    };
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref: reviewRef(finding),
        disposition: "resolved",
        source: "review",
        evidence: "bumped both files.",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    const data = makeData({
      reviews: { nodes: [finding] },
      comments: { nodes: [] },
      reviewThreads: { nodes: [] },
      findings,
    });
    // isAddressedByAuthorReply can't exclude this (proven above: the same
    // shape without `findings` returns true).
    const dataWithoutLedger = makeData({
      reviews: { nodes: [finding] },
      comments: { nodes: [] },
      reviewThreads: { nodes: [] },
    });
    expect(hasUnaddressedFindings(dataWithoutLedger, "the-agent")).toBe(true);
    // With the ledger entry present, it is excluded.
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
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

  // ─── prAuthor scoping (RAS-1.1, ok-wow-agency PR #80 incident) ─────────────
  //
  // Before RAS-1.1, isAddressedByAuthorReply always compared a reply's author
  // against currentUser (the bot) — correct for check-patch.ts's own-PR scope
  // (currentUser IS the PR author there), but wrong for review.md's Step 9.5,
  // which reuses hasUnaddressedFindings for third-party PRs the bot reviews.
  // On ok-wow-agency PR #80, round-3 automated review was forced to COMMENT
  // despite zero findings and both prior issues confirmed fixed, because the
  // reply came from the real PR author (zayyen-p), not currentUser (the-agent)
  // — the reply never matched. These tests mirror that incident directly.

  test("excludes a third-party review's finding when the real PR author (not currentUser) replies after it, given explicit prAuthor (mirrors ok-wow-agency PR #80)", () => {
    const data = makeData({
      prAuthor: "zayyen-p",
      reviews: {
        nodes: [
          {
            author: { login: "some-reviewer" },
            state: "COMMENTED",
            submittedAt: "2026-08-19T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Two issues found in round 2.",
          },
        ],
      },
      comments: {
        nodes: [
          {
            author: { login: "zayyen-p" },
            body: "Both issues fixed in this round.",
            createdAt: "2026-08-19T11:00:00Z", // after the review's submittedAt
          },
        ],
      },
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("does NOT exclude a third-party review's finding when currentUser (not the explicit prAuthor) replies after it — proves prAuthor actually changes behavior", () => {
    const data = makeData({
      prAuthor: "zayyen-p",
      reviews: {
        nodes: [
          {
            author: { login: "some-reviewer" },
            state: "COMMENTED",
            submittedAt: "2026-08-19T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Two issues found in round 2.",
          },
        ],
      },
      comments: {
        nodes: [
          {
            // currentUser replies, but the real PR author (zayyen-p) never
            // did — this must NOT count as the author addressing the finding.
            author: { login: "the-agent" },
            body: "Investigating.",
            createdAt: "2026-08-19T11:00:00Z", // after the review's submittedAt
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

  // ─── Thread addressed by a later PR-author reply (URT-1.1) ────────────────
  //
  // The unresolved-threads check previously applied zero of the exclusions
  // the rest of this function uses — it was a raw pass over
  // reviewThreads.nodes gated only on GitHub's isResolved flag, which
  // nothing in the shipwright review pipeline ever sets. Once a thread
  // existed and wasn't resolved, it blocked the verdict permanently even
  // when the PR author had replied in that exact thread confirming a fix.
  // This sixth exclusion mirrors isAddressedByAuthorReply (CPF-2.3) but is
  // scoped to a single thread's own comments, comparing each thread's first
  // (flagging) comment's createdAt against later comments from prAuthor — no
  // cross-review correlation, since none is available in the GraphQL schema.

  test("excludes a thread addressed by a later PR-author reply — hasUnaddressedFindings returns false when it's the only qualifying signal", () => {
    const data = makeData({
      prAuthor: "pr-author",
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
                {
                  author: { login: "reviewer1" },
                  body: "Missing test coverage for the retry path.",
                  createdAt: "2026-05-26T10:05:00Z",
                },
                {
                  author: { login: "pr-author" },
                  body: "Added a test covering the retry path in the latest push.",
                  createdAt: "2026-05-26T12:00:00Z",
                },
              ],
            },
          },
        ],
      },
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
  });

  test("does NOT exclude a thread when the PR-author reply predates the flagging comment", () => {
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
                {
                  author: { login: "pr-author" },
                  body: "Unrelated earlier comment in this thread.",
                  createdAt: "2026-05-26T09:00:00Z",
                },
                {
                  author: { login: "reviewer1" },
                  body: "Missing test coverage for the retry path.",
                  createdAt: "2026-05-26T10:05:00Z",
                },
              ],
            },
          },
        ],
      },
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("does NOT exclude a thread when the later reply is from someone other than prAuthor", () => {
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
                {
                  author: { login: "reviewer1" },
                  body: "Missing test coverage for the retry path.",
                  createdAt: "2026-05-26T10:05:00Z",
                },
                {
                  author: { login: "some-other-contributor" },
                  body: "I can look into this too.",
                  createdAt: "2026-05-26T12:00:00Z",
                },
              ],
            },
          },
        ],
      },
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("does NOT exclude a thread when comments are missing createdAt (regression-safe default, same as today)", () => {
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
                {
                  author: { login: "reviewer1" },
                  body: "Missing test coverage for the retry path.",
                },
                {
                  author: { login: "pr-author" },
                  body: "Added a test covering the retry path in the latest push.",
                },
              ],
            },
          },
        ],
      },
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("end-to-end repro: a qualifying review plus one unresolved thread with an author reply after the flag resolves to no unaddressed findings", () => {
    // Reproduces the confirmed live incident: a reviewer flagged missing test
    // coverage inline, the author pushed a fix and replied in the same thread
    // confirming it, nobody clicked "Resolve conversation" on GitHub, and the
    // bot's next re-review concluded APPROVE in its own narrative but posted
    // COMMENT anyway because of this gate.
    const data = makeData({
      prAuthor: "pr-author",
      reviews: {
        nodes: [
          {
            author: { login: "reviewer1" },
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-08-20T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Please add test coverage for the new branch.",
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            comments: {
              nodes: [
                {
                  author: { login: "reviewer1" },
                  body: "This new branch has no test coverage.",
                  createdAt: "2026-08-20T10:01:00Z",
                },
                {
                  author: { login: "pr-author" },
                  body: "Pushed a fix with a new unit test covering this branch.",
                  createdAt: "2026-08-21T09:00:00Z",
                },
              ],
            },
          },
        ],
      },
      comments: {
        nodes: [
          {
            author: { login: "pr-author" },
            body: "Pushed a fix with a new unit test covering this branch.",
            createdAt: "2026-08-21T09:00:00Z",
          },
        ],
      },
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);
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
    expect(isAddressedByAuthorReply(review, comments, "the-agent")).toBe(true);
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
    expect(isAddressedByAuthorReply(review, comments, "the-agent")).toBe(false);
  });
});

describe("isThreadAddressedByAuthorReply", () => {
  test("true when prAuthor replies after the thread's first (flagging) comment", () => {
    const thread: ReviewThread = {
      isResolved: false,
      comments: {
        nodes: [
          {
            author: { login: "reviewer1" },
            body: "Missing test coverage.",
            createdAt: "2026-05-26T10:00:00Z",
          },
          {
            author: { login: "pr-author" },
            body: "Added a test.",
            createdAt: "2026-05-26T11:00:00Z",
          },
        ],
      },
    };
    expect(isThreadAddressedByAuthorReply(thread, "pr-author")).toBe(true);
  });

  test("false when the prAuthor comment predates the thread's first comment", () => {
    const thread: ReviewThread = {
      isResolved: false,
      comments: {
        nodes: [
          {
            author: { login: "pr-author" },
            body: "Unrelated earlier comment.",
            createdAt: "2026-05-26T09:00:00Z",
          },
          {
            author: { login: "reviewer1" },
            body: "Missing test coverage.",
            createdAt: "2026-05-26T10:00:00Z",
          },
        ],
      },
    };
    expect(isThreadAddressedByAuthorReply(thread, "pr-author")).toBe(false);
  });

  test("false when the later reply is from someone other than prAuthor", () => {
    const thread: ReviewThread = {
      isResolved: false,
      comments: {
        nodes: [
          {
            author: { login: "reviewer1" },
            body: "Missing test coverage.",
            createdAt: "2026-05-26T10:00:00Z",
          },
          {
            author: { login: "someone-else" },
            body: "I can take a look.",
            createdAt: "2026-05-26T11:00:00Z",
          },
        ],
      },
    };
    expect(isThreadAddressedByAuthorReply(thread, "pr-author")).toBe(false);
  });

  test("false when comments are missing createdAt (regression-safe default)", () => {
    const thread: ReviewThread = {
      isResolved: false,
      comments: {
        nodes: [
          { author: { login: "reviewer1" }, body: "Missing test coverage." },
          { author: { login: "pr-author" }, body: "Added a test." },
        ],
      },
    };
    expect(isThreadAddressedByAuthorReply(thread, "pr-author")).toBe(false);
  });

  test("false when the thread has only a single comment (no reply at all)", () => {
    const thread: ReviewThread = {
      isResolved: false,
      comments: {
        nodes: [
          {
            author: { login: "reviewer1" },
            body: "Missing test coverage.",
            createdAt: "2026-05-26T10:00:00Z",
          },
        ],
      },
    };
    expect(isThreadAddressedByAuthorReply(thread, "pr-author")).toBe(false);
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

describe("reviewRef", () => {
  test("derives a stable ref from full commit oid and submittedAt (not a lossy short SHA)", () => {
    const review: Pick<ReviewNode, "commit" | "submittedAt"> = {
      commit: { oid: "abcdef0123456789abcdef0123456789abcdef01" },
      submittedAt: "2026-05-26T10:00:00Z",
    };
    const ref = reviewRef(review);
    // Full oid must be present verbatim (no truncation) so distinct reviews on
    // different commits never collide.
    expect(ref).toContain("abcdef0123456789abcdef0123456789abcdef01");
    expect(ref).toContain("2026-05-26T10:00:00Z");
  });

  test("is deterministic — same review yields the same ref", () => {
    const review: Pick<ReviewNode, "commit" | "submittedAt"> = {
      commit: { oid: "sha" },
      submittedAt: "2026-05-26T10:00:00Z",
    };
    expect(reviewRef(review)).toBe(reviewRef(review));
  });

  test("distinguishes two reviews at the same commit but different submittedAt", () => {
    const a: Pick<ReviewNode, "commit" | "submittedAt"> = {
      commit: { oid: "sha" },
      submittedAt: "2026-05-26T10:00:00Z",
    };
    const b: Pick<ReviewNode, "commit" | "submittedAt"> = {
      commit: { oid: "sha" },
      submittedAt: "2026-05-27T10:00:00Z",
    };
    expect(reviewRef(a)).not.toBe(reviewRef(b));
  });
});

describe("isResolvedByLedger", () => {
  const ref = "current-head-sha@2026-05-26T10:00:00Z";

  test("true when a matching entry has source review and disposition resolved", () => {
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref,
        disposition: "resolved",
        source: "review",
        evidence: "fixed",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    expect(isResolvedByLedger(ref, findings)).toBe(true);
  });

  test("true when a matching entry has source review and disposition superseded", () => {
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref,
        disposition: "superseded",
        source: "review",
        evidence: "superseded by later pass",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    expect(isResolvedByLedger(ref, findings)).toBe(true);
  });

  test("false when the matching entry has source patch", () => {
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref,
        disposition: "resolved",
        source: "patch",
        evidence: "fixed via patch",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    expect(isResolvedByLedger(ref, findings)).toBe(false);
  });

  test("false when the matching entry has disposition rejected", () => {
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref,
        disposition: "rejected",
        source: "review",
        evidence: "not a real issue",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    expect(isResolvedByLedger(ref, findings)).toBe(false);
  });

  test("false when no entry ref matches", () => {
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref: "some-other-ref",
        disposition: "resolved",
        source: "review",
        evidence: "fixed",
        at: "2026-05-27T10:00:00Z",
        createdAt: "2026-05-27T10:00:00Z",
      },
    ];
    expect(isResolvedByLedger(ref, findings)).toBe(false);
  });

  test("false when findings is empty", () => {
    expect(isResolvedByLedger(ref, [])).toBe(false);
  });
});

// ─── parseCliInput (direct calls — validation branches, not exercised by the
// subprocess-spawn CLI entrypoint tests below, which only cover the happy
// path per scenario) ────────────────────────────────────────────────────────

describe("parseCliInput", () => {
  function validInput(overrides: Record<string, unknown> = {}) {
    return {
      currentUser: "the-agent",
      headRefOid: "current-head-sha",
      reviews: { nodes: [] },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      ...overrides,
    };
  }

  test("parses valid input, defaulting priorFindingsStatus and findings to [] when absent", () => {
    const result = parseCliInput(JSON.stringify(validInput()));
    expect(result.currentUser).toBe("the-agent");
    expect(result.headRefOid).toBe("current-head-sha");
    expect(result.priorFindingsStatus).toEqual([]);
    expect(result.findings).toEqual([]);
  });

  test("passes findings through when present", () => {
    const findings: PrFinding[] = [
      {
        id: "f1",
        prRecordId: "pr1",
        ref: "sha@2026-05-26T10:00:00Z",
        disposition: "resolved",
        source: "review",
        evidence: "fixed",
        at: "2026-05-26T11:00:00Z",
        createdAt: "2026-05-26T11:00:00Z",
      },
    ];
    const result = parseCliInput(JSON.stringify(validInput({ findings })));
    expect(result.findings).toEqual(findings);
  });

  test("throws when currentUser is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).currentUser = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a string "currentUser" field',
    );
  });

  test("throws when headRefOid is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).headRefOid = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a string "headRefOid" field',
    );
  });

  test("throws when reviews is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).reviews = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a "reviews" field shaped { nodes: [...] }',
    );
  });

  test("throws when reviewThreads is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).reviewThreads = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a "reviewThreads" field shaped { nodes: [...] }',
    );
  });

  test("throws when comments is missing", () => {
    const input = validInput();
    (input as Record<string, unknown>).comments = undefined;
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON must have a "comments" field shaped { nodes: [...] }',
    );
  });

  test("throws when priorFindingsStatus is present but not an array", () => {
    const input = validInput({ priorFindingsStatus: "not-an-array" });
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON "priorFindingsStatus" field, when present, must be an array',
    );
  });

  test("throws when findings is present but not an array", () => {
    const input = validInput({ findings: "not-an-array" });
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON "findings" field, when present, must be an array',
    );
  });

  test("throws when prAuthor is present but not a string (RAS-1.1)", () => {
    const input = validInput({ prAuthor: 123 });
    expect(() => parseCliInput(JSON.stringify(input))).toThrow(
      'Input JSON "prAuthor" field, when present, must be a string',
    );
  });

  test("passes prAuthor through when present, and leaves it undefined when absent (RAS-1.1)", () => {
    const withPrAuthor = parseCliInput(
      JSON.stringify(validInput({ prAuthor: "zayyen-p" })),
    );
    expect(withPrAuthor.prAuthor).toBe("zayyen-p");

    const withoutPrAuthor = parseCliInput(JSON.stringify(validInput()));
    expect(withoutPrAuthor.prAuthor).toBeUndefined();
  });
});

// ─── CLI entrypoint (argv/stdin JSON parsing) ──────────────────────────────

const SCRIPT_PATH = new URL(
  "./compute-unaddressed-findings.ts",
  import.meta.url,
).pathname;

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

  test("passes findings through and prints {unaddressedFindings: false} when a ledger entry resolves the only finding (PFL-3.2)", async () => {
    const input = JSON.stringify({
      currentUser: "the-agent",
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
      comments: { nodes: [] },
      findings: [
        {
          id: "f1",
          prRecordId: "pr1",
          ref: "current-head-sha@2026-05-26T10:00:00Z",
          disposition: "resolved",
          source: "review",
          evidence: "bumped both files.",
          at: "2026-05-27T10:00:00Z",
          createdAt: "2026-05-27T10:00:00Z",
        },
      ],
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
    expect(JSON.parse(stdout.trim())).toEqual({ unaddressedFindings: false });
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
    const proc = Bun.spawn(
      ["bun", "run", SCRIPT_PATH, '{"currentUser":"the-agent"}'],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [_stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
