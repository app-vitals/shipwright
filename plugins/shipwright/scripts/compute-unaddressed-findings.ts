#!/usr/bin/env bun
// Mechanical unaddressed-findings computation gate (PVD-1.1).
//
// Extracts agent/src/check-patch.ts's private `hasUnaddressedFindings` (and its
// three helper functions) into a pure, exported function plus a CLI
// entrypoint, mirroring compute-review-verdict.ts's structure (DRO-1.1) —
// this is one layer upstream of that gate: `hasUnaddressedFindings` computes
// the `unaddressedFindings` boolean that `compute-review-verdict.ts`'s
// `computeVerdict`/`validateReviewVerdict` then consume as one of their three
// inputs (see plugins/shipwright/commands/review.md's Step 9.5 and Step 10).
//
// Before this extraction, review.md's Step 9.5 only ever instructed the LLM
// to freehand-replicate this exact definition in prose at review-post time —
// a fourth divergent copy of the same logic already implemented in
// check-patch.ts (`getPatchCandidates`'s List A qualification) and restated
// in patch.md's Step 3a. This module is now the single source of truth;
// check-patch.ts imports `hasUnaddressedFindings` (plus the two helpers
// `hasMergeOnlyStaleFindings` also needs) from here instead of defining them
// locally, and review.md's Step 9.5 invokes this file's CLI instead of
// asking the LLM to recompute the definition by hand.
//
// CLI:
//   bun run plugins/shipwright/scripts/compute-unaddressed-findings.ts '{"currentUser":"the-agent","headRefOid":"abc123","reviews":{"nodes":[...]},"reviewThreads":{"nodes":[...]},"comments":{"nodes":[...]}}'
// or pipe the same JSON blob via stdin.

// ─── Types ────────────────────────────────────────────────────────────────────
//
// Mirrors agent/src/check-patch.ts's ReviewNode/ReviewThread/IssueCommentNode/
// PrReviewData type definitions exactly (duplicated here, not imported —
// plugins/shipwright is a separate, repo-agnostic package from agent/src, see
// plugins/shipwright/CLAUDE.md; the same rationale compute-review-verdict.ts's
// VERDICT_APPROVE_LABEL duplication already documents).

export interface ReviewNode {
  author: { login: string };
  state: string;
  submittedAt: string;
  commit: { oid: string };
  body: string;
}

export interface ReviewThread {
  isResolved: boolean;
  comments: { nodes: Array<{ author: { login: string }; body: string }> };
}

export interface IssueCommentNode {
  author: { login: string };
  body: string;
  createdAt: string;
}

export interface PrReviewData {
  headRefOid: string;
  reviews: { nodes: ReviewNode[] };
  reviewThreads: { nodes: ReviewThread[] };
  comments: { nodes: IssueCommentNode[] };
}

// ─── Self-review body matching ────────────────────────────────────────────────
//
// Duplicated from agent/src/check-helpers.ts's `isCleanApproveBody` (rather
// than imported) because plugins/shipwright is a separate, repo-agnostic
// package from agent/src — see plugins/shipwright/CLAUDE.md. Mirrors
// compute-review-verdict.ts's identical duplication of the sibling
// VERDICT_APPROVE_LABEL regex for the same reason.

const VERDICT_APPROVE_LABEL = /verdict\**\s*:\s*\**approve\b/i;

/**
 * True when a review body is a clean APPROVE verdict, matched either by:
 * - a leading `APPROVE` (after stripping leading markdown bold markers), or
 * - a "Verdict: APPROVE" label anywhere in the body (the narrative
 *   self-review convention, which ends a summary with the verdict rather
 *   than leading with it).
 */
function isCleanApproveBody(body: string): boolean {
  return (
    body.trimStart().replace(/^\*+/, "").startsWith("APPROVE") ||
    VERDICT_APPROVE_LABEL.test(body)
  );
}

// ─── Helper predicates ──────────────────────────────────────────────────────

/**
 * True when a review is self-authored and is a clean APPROVE verdict (see
 * isCleanApproveBody above — leading `APPROVE` or a "Verdict: APPROVE" label
 * anywhere in the body, the agent's narrative self-review convention, which
 * ends a summary with the verdict rather than leading with it — CPF-2.1).
 *
 * GitHub blocks self-APPROVE via the API, so the agent's own clean approvals
 * are always posted as COMMENTED — treating those as findings would create a
 * permanent false positive. A self-review with a real (non-APPROVE) verdict
 * (e.g. "Verdict: CHANGES_REQUESTED") is not matched here, so it still counts
 * as a finding.
 */
export function isSelfCleanApprove(
  review: Pick<ReviewNode, "author" | "body">,
  currentUser: string,
): boolean {
  if (review.author.login !== currentUser) return false;

  return isCleanApproveBody(review.body);
}

/**
 * Returns true when a review's non-empty body has been addressed by a
 * subsequent PR-author reply (CPF-2.3).
 *
 * The self-review "Verdict: APPROVE" rewrite workaround (CPF-2.1, CPF-2.2)
 * relies on `updatePullRequestReview`, which only permits editing a review's
 * OWN author's body. For a third-party review (e.g. posted by a distinct
 * GitHub identity), the PR author cannot rewrite the review body to signal
 * the finding was addressed or rejected — the review text stays exactly as
 * the third party wrote it forever. A subsequent PR-author reply (a
 * top-level PR comment posted after the review) is the only available
 * signal in that case, so we treat it as evidence the finding was addressed
 * (fixed or rebutted) even though the review body itself never changes.
 */
export function isAddressedByAuthorReply(
  review: Pick<ReviewNode, "submittedAt">,
  comments: IssueCommentNode[],
  currentUser: string,
): boolean {
  const reviewedAt = new Date(review.submittedAt).getTime();
  return comments.some(
    (c) =>
      c.author.login === currentUser &&
      new Date(c.createdAt).getTime() > reviewedAt,
  );
}

/**
 * Returns true when a self-authored review is superseded by a LATER,
 * genuinely clean self-review from the same identity (DRO-1.2 — mirrors
 * patch.md's Step 3a "Self-review superseded by a later clean self-review"
 * exclusion).
 *
 * review.md's Step 10/11 procedure always posts a *new* review object each
 * pass rather than rewriting a prior one's body, so a self-authored PR that
 * goes through N review rounds — each finding and fixing one real issue —
 * ends up with N-1 COMMENT-bodied self-reviews on the PR even after every
 * finding has been fixed. None of those qualifies for the clean-APPROVE
 * exclusion (their bodies read `Verdict: COMMENT`, not `Verdict: APPROVE`),
 * and the reply exclusion doesn't apply either (self-reviews aren't
 * "third-party," and this PR's convention never posts a PR-level author
 * reply) — so without this exclusion, `hasUnaddressedFindings` would return
 * true forever and a self-authored PR could never reach a clean verdict once
 * it has had more than one review round.
 *
 * Only a PRIOR self-review is superseded, and only when a later self-review
 * (matched by `submittedAt`, same `author.login` as `currentUser`) is itself
 * a clean verdict per `isCleanApproveBody` — a later self-review that is
 * itself non-clean (e.g. this round found a fresh issue) does not supersede
 * anything.
 */
export function isSupersededBySelfReview(
  review: Pick<ReviewNode, "author" | "submittedAt">,
  allReviews: ReviewNode[],
  currentUser: string,
): boolean {
  if (review.author.login !== currentUser) return false;

  const reviewedAt = new Date(review.submittedAt).getTime();
  return allReviews.some(
    (r) =>
      r.author.login === currentUser &&
      new Date(r.submittedAt).getTime() > reviewedAt &&
      isCleanApproveBody(r.body),
  );
}

/**
 * Returns true if the PR has unaddressed findings:
 * - At least one COMMENTED or CHANGES_REQUESTED review posted at the current HEAD
 * - AND (has a non-empty review body OR has at least one unresolved inline thread)
 *
 * A self-authored review is excluded when it is a clean APPROVE verdict (see
 * isSelfCleanApprove) or when it is superseded by a later, genuinely clean
 * self-review from the same identity (see isSupersededBySelfReview, DRO-1.2)
 * — a self-review with a real (non-APPROVE) verdict that is not later
 * superseded still counts as an unaddressed finding, same as any other
 * reviewer's.
 *
 * A review's non-empty body is also excluded when there are no unresolved
 * threads AND the PR author has replied after the review (see
 * isAddressedByAuthorReply, CPF-2.3) — the only way to mark a third-party
 * review's finding as addressed, since only the review's own author can edit
 * its body.
 */
export function hasUnaddressedFindings(
  data: PrReviewData,
  currentUser: string,
): boolean {
  const { headRefOid, reviews, reviewThreads, comments } = data;

  // Find qualifying reviews: state COMMENTED or CHANGES_REQUESTED at current HEAD,
  // excluding self-authored clean-APPROVE reviews and self-reviews superseded
  // by a later clean self-review (DRO-1.2).
  const qualifyingReviews = reviews.nodes.filter(
    (r) =>
      (r.state === "COMMENTED" || r.state === "CHANGES_REQUESTED") &&
      r.commit.oid === headRefOid &&
      !isSelfCleanApprove(r, currentUser) &&
      !isSupersededBySelfReview(r, reviews.nodes, currentUser),
  );

  if (qualifyingReviews.length === 0) return false;

  // Check for unresolved threads
  const unresolvedThreads = reviewThreads.nodes.filter((t) => !t.isResolved);

  if (unresolvedThreads.length > 0) return true;

  // No unresolved threads — check if any qualifying review has a non-empty
  // body that hasn't been addressed by a subsequent author reply.
  return qualifyingReviews.some(
    (r) =>
      r.body.trim().length > 0 &&
      !isAddressedByAuthorReply(r, comments.nodes, currentUser),
  );
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

type CliInput = PrReviewData & { currentUser: string };

function parseCliInput(raw: string): CliInput {
  const parsed = JSON.parse(raw) as Partial<CliInput>;
  if (typeof parsed.currentUser !== "string") {
    throw new Error('Input JSON must have a string "currentUser" field');
  }
  if (typeof parsed.headRefOid !== "string") {
    throw new Error('Input JSON must have a string "headRefOid" field');
  }
  if (!parsed.reviews || !Array.isArray(parsed.reviews.nodes)) {
    throw new Error(
      'Input JSON must have a "reviews" field shaped { nodes: [...] }',
    );
  }
  if (!parsed.reviewThreads || !Array.isArray(parsed.reviewThreads.nodes)) {
    throw new Error(
      'Input JSON must have a "reviewThreads" field shaped { nodes: [...] }',
    );
  }
  if (!parsed.comments || !Array.isArray(parsed.comments.nodes)) {
    throw new Error(
      'Input JSON must have a "comments" field shaped { nodes: [...] }',
    );
  }
  return {
    currentUser: parsed.currentUser,
    headRefOid: parsed.headRefOid,
    reviews: parsed.reviews,
    reviewThreads: parsed.reviewThreads,
    comments: parsed.comments,
  };
}

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  const input = parseCliInput(raw);

  const unaddressedFindings = hasUnaddressedFindings(
    {
      headRefOid: input.headRefOid,
      reviews: input.reviews,
      reviewThreads: input.reviewThreads,
      comments: input.comments,
    },
    input.currentUser,
  );

  console.log(JSON.stringify({ unaddressedFindings }));
}
