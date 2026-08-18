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
import { computeVerdict } from "./compute-review-verdict.ts";
import {
  hasUnaddressedFindings,
  type IssueCommentNode,
  isAddressedByAuthorReply,
  isResolvedByLedger,
  isResolvedByPriorFindingsStatus,
  isSelfCleanApprove,
  isSupersededBySelfReview,
  type PrFinding,
  type PrReviewData,
  type ReviewNode,
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

  // ─── Same-pass resolution via priorFindingsStatus[] (PVD-1.3) ─────────────
  //
  // The regression case for ok-wow/ok-wow-agency#66: a third-party PR (author
  // != CURRENT_USER, CURRENT_USER is the reviewer) where each review pass posts
  // a NEW review object rather than rewriting a prior one. review.md's Step
  // 10/11 always creates a new review, and DRO-1.2's isSupersededBySelfReview
  // exclusion only fires when a LATER self-review is ITSELF a clean
  // "Verdict: APPROVE" body — but that later review can only be clean if
  // unaddressedFindings was already false for its own pass. That circularity
  // deadlocks the PR at COMMENT forever once a single self-authored COMMENT
  // review with a real finding exists. PVD-1.3 breaks the deadlock: the current
  // pass's structured priorFindingsStatus[] attestation excludes the prior
  // review when it is marked resolved:true with non-empty evidence.

  test("returns false when a qualifying self-authored review at HEAD is resolved:true with evidence by the current pass's priorFindingsStatus[] (PR #66 deadlock)", () => {
    const finding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — the retry loop can double-fire on transient errors, needs a guard.",
    };
    const data = makeData({
      reviews: { nodes: [finding] },
      priorFindingsStatus: [
        {
          ref: reviewRef(finding),
          resolved: true,
          evidence:
            "src/retry.ts:42 — added an in-flight guard; the double-fire path is gone.",
        },
      ],
    });
    // The prior finding is attested-resolved for this pass, and there is no
    // fresh finding, so the gate must clear.
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(false);

    // And the resulting verdict, via compute-review-verdict.ts, must be APPROVE
    // for this third-party PR (selfReview=false) with zero fresh blocking
    // findings — the whole point of PVD-1.3 is to let the PR reach an automated
    // APPROVE again.
    const { verdictLabel } = computeVerdict({
      selfReview: false,
      unaddressedFindings: hasUnaddressedFindings(data, "the-agent"),
      currentPassHasBlockingFindings: false,
    });
    expect(verdictLabel).toBe("APPROVE");
  });

  test("excludes a resolved prior finding independently even when a fresh unrelated blocking finding exists in the same pass (Option B independence)", () => {
    const oldFinding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — the retry loop can double-fire, needs a guard.",
    };
    const freshFinding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-27T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — a fresh, unrelated null-deref in the new config parser.",
    };
    const data = makeData({
      reviews: { nodes: [oldFinding, freshFinding] },
      priorFindingsStatus: [
        {
          ref: reviewRef(oldFinding),
          resolved: true,
          evidence: "src/retry.ts:42 — in-flight guard added, double-fire gone.",
        },
        // Note: no entry resolving freshFinding — it is a new, still-open finding.
      ],
    });
    // Option B: the old finding is judged independently and excluded even though
    // a fresh blocking finding coexists in the same pass. The gate reflects ONLY
    // the fresh finding, so it is still true — but for the fresh finding alone,
    // not because the old (resolved) one still counts.
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);

    // Prove the exclusion actually fired on the old finding: with the fresh
    // finding removed, the gate would clear via the same priorFindingsStatus[].
    const dataOldOnly = makeData({
      reviews: { nodes: [oldFinding] },
      priorFindingsStatus: data.priorFindingsStatus,
    });
    expect(hasUnaddressedFindings(dataOldOnly, "the-agent")).toBe(false);
  });

  test("does NOT exclude a prior finding when priorFindingsStatus marks it resolved:false", () => {
    const finding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — the retry loop can double-fire, needs a guard.",
    };
    const data = makeData({
      reviews: { nodes: [finding] },
      priorFindingsStatus: [
        {
          ref: reviewRef(finding),
          resolved: false,
          evidence:
            "src/retry.ts:42 — the guard is still missing; double-fire path remains.",
        },
      ],
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("does NOT exclude a prior finding when priorFindingsStatus marks it resolved:true but evidence is empty", () => {
    const finding: ReviewNode = {
      author: { login: "the-agent" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Verdict: COMMENT — the retry loop can double-fire, needs a guard.",
    };
    const data = makeData({
      reviews: { nodes: [finding] },
      priorFindingsStatus: [
        { ref: reviewRef(finding), resolved: true, evidence: "   " },
      ],
    });
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  test("does NOT exclude a THIRD-PARTY reviewer's finding via priorFindingsStatus (only CURRENT_USER's own prior reviews are self-attestable)", () => {
    const finding: ReviewNode = {
      author: { login: "dodizzle" },
      state: "COMMENTED",
      submittedAt: "2026-05-26T10:00:00Z",
      commit: { oid: "current-head-sha" },
      body: "Missing plugin.json/marketplace.json version bump.",
    };
    const data = makeData({
      reviews: { nodes: [finding] },
      priorFindingsStatus: [
        {
          ref: reviewRef(finding),
          resolved: true,
          evidence: "bumped both files.",
        },
      ],
    });
    // A distinct GitHub identity's review is not self-attestable — the agent
    // can't unilaterally resolve someone else's review via its own subagent
    // attestation; that path stays governed by CPF-2.3 (author reply).
    expect(hasUnaddressedFindings(data, "the-agent")).toBe(true);
  });

  // ─── Ledger-based resolved/superseded exclusion (PFL-3.2) ─────────────────
  //
  // A fifth exclusion, additive to the first four: a qualifying review is also
  // excluded when a task-store ledger entry (source: "review") exists for its
  // ref with disposition "resolved" or "superseded" — independent of
  // self-authorship, unlike isResolvedByPriorFindingsStatus (PVD-1.3), since
  // ledger entries are written by the code-reviewer subagent regardless of
  // whose review is being resolved.

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

  test("excludes a THIRD-PARTY review's finding via a matching ledger entry (unlike isResolvedByPriorFindingsStatus, no self-authorship gate)", () => {
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

  test("excludes a finding via the ledger even when none of the first four exclusions apply (genuine fifth path)", () => {
    // Third-party review (so isSelfCleanApprove/isSupersededBySelfReview/
    // isResolvedByPriorFindingsStatus all structurally can't apply — they are
    // self-authorship-gated), and no author reply (so isAddressedByAuthorReply
    // can't apply either). Only the ledger entry resolves it.
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
      priorFindingsStatus: [],
      findings,
    });
    // None of isSelfCleanApprove/isAddressedByAuthorReply/
    // isSupersededBySelfReview/isResolvedByPriorFindingsStatus can exclude this
    // (proven above: the same shape without `findings` returns true).
    const dataWithoutLedger = makeData({
      reviews: { nodes: [finding] },
      comments: { nodes: [] },
      reviewThreads: { nodes: [] },
      priorFindingsStatus: [],
    });
    expect(hasUnaddressedFindings(dataWithoutLedger, "the-agent")).toBe(true);
    // With the ledger entry present, it is excluded — a genuine fifth path.
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

describe("isResolvedByPriorFindingsStatus", () => {
  const finding: ReviewNode = {
    author: { login: "the-agent" },
    state: "COMMENTED",
    submittedAt: "2026-05-26T10:00:00Z",
    commit: { oid: "current-head-sha" },
    body: "Verdict: COMMENT — real finding.",
  };

  test("true when a self-authored review has a matching resolved:true entry with non-empty evidence", () => {
    expect(
      isResolvedByPriorFindingsStatus(
        finding,
        [{ ref: reviewRef(finding), resolved: true, evidence: "file.ts:1 fixed" }],
        "the-agent",
      ),
    ).toBe(true);
  });

  test("false when the matching entry is resolved:false", () => {
    expect(
      isResolvedByPriorFindingsStatus(
        finding,
        [{ ref: reviewRef(finding), resolved: false, evidence: "still broken" }],
        "the-agent",
      ),
    ).toBe(false);
  });

  test("false when the matching entry has empty/whitespace evidence", () => {
    expect(
      isResolvedByPriorFindingsStatus(
        finding,
        [{ ref: reviewRef(finding), resolved: true, evidence: "  " }],
        "the-agent",
      ),
    ).toBe(false);
  });

  test("false when no entry ref matches the review", () => {
    expect(
      isResolvedByPriorFindingsStatus(
        finding,
        [{ ref: "some-other-ref", resolved: true, evidence: "file.ts:1 fixed" }],
        "the-agent",
      ),
    ).toBe(false);
  });

  test("false when the review is not self-authored, even with a matching resolved entry", () => {
    const thirdParty: ReviewNode = { ...finding, author: { login: "dodizzle" } };
    expect(
      isResolvedByPriorFindingsStatus(
        thirdParty,
        [{ ref: reviewRef(thirdParty), resolved: true, evidence: "fixed" }],
        "the-agent",
      ),
    ).toBe(false);
  });

  test("false when priorFindingsStatus is empty", () => {
    expect(isResolvedByPriorFindingsStatus(finding, [], "the-agent")).toBe(
      false,
    );
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

  test("passes priorFindingsStatus through and prints {unaddressedFindings: false} when it resolves the only finding (PVD-1.3)", async () => {
    const input = JSON.stringify({
      currentUser: "the-agent",
      headRefOid: "current-head-sha",
      reviews: {
        nodes: [
          {
            author: { login: "the-agent" },
            state: "COMMENTED",
            submittedAt: "2026-05-26T10:00:00Z",
            commit: { oid: "current-head-sha" },
            body: "Verdict: COMMENT — the retry loop can double-fire.",
          },
        ],
      },
      reviewThreads: { nodes: [] },
      comments: { nodes: [] },
      priorFindingsStatus: [
        {
          ref: "current-head-sha@2026-05-26T10:00:00Z",
          resolved: true,
          evidence: "src/retry.ts:42 — guard added.",
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
