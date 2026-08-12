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
// A qualifying review is excluded from counting as an unaddressed finding by
// any of four exclusions:
//   1. isSelfCleanApprove (CPF-2.1) — a self-authored clean-APPROVE review.
//   2. isAddressedByAuthorReply (CPF-2.3) — a third-party review addressed by a
//      subsequent PR-author reply.
//   3. isSupersededBySelfReview (DRO-1.2) — an earlier self-review superseded by
//      a later, genuinely clean self-review.
//   4. isResolvedByPriorFindingsStatus (PVD-1.3) — a prior self-authored review
//      attested resolved (with evidence) by the CURRENT pass's structured
//      priorFindingsStatus[]; breaks the review-verdict deadlock where a
//      self-authored COMMENT finding could never be superseded. Each entry is
//      judged independently (Option B) — no coupling to other findings in the
//      pass.
//
// CLI:
//   bun run plugins/shipwright/scripts/compute-unaddressed-findings.ts '{"currentUser":"the-agent","headRefOid":"abc123","reviews":{"nodes":[...]},"reviewThreads":{"nodes":[...]},"comments":{"nodes":[...]},"priorFindingsStatus":[...]}'
// or pipe the same JSON blob via stdin. `priorFindingsStatus` is optional and
// defaults to [] when absent.

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

/**
 * One per-finding resolution attestation from the CURRENT review pass (PVD-1.2's
 * structured subagent output — see `agents/code-reviewer.md`'s Output Format
 * section and review.md's Step 5.5 "Prior Qualifying Reviews for Subagent
 * Attestation"). The code-reviewer subagent is asked, for each prior qualifying
 * CURRENT_USER review, whether the issue that review originally described is
 * still present in the current diff; it returns one entry per prior review:
 *
 * - `ref`     — the canonical identifier of the prior review this entry
 *               addresses, matching `reviewRef(review)` (full commit oid +
 *               submittedAt, so the match is mechanical, not fuzzy).
 * - `resolved`— whether the originally-described issue is now fixed.
 * - `evidence`— a `file:line` reference or diff excerpt proving the fix (when
 *               `resolved`) or explaining why the issue persists (when not).
 *               Required in both cases; an empty/whitespace `evidence` is
 *               treated as no attestation for exclusion purposes (PVD-1.3).
 */
export interface PriorFindingStatus {
  ref: string;
  resolved: boolean;
  evidence: string;
}

export interface PrReviewData {
  headRefOid: string;
  reviews: { nodes: ReviewNode[] };
  reviewThreads: { nodes: ReviewThread[] };
  comments: { nodes: IssueCommentNode[] };
  /**
   * Structured per-finding resolution attestations from the current review
   * pass (PVD-1.3). Optional — defaults to `[]` when absent (e.g. a first-pass
   * review with no prior qualifying reviews to re-verify), so all existing
   * callers that never build this field keep their current behavior exactly.
   */
  priorFindingsStatus?: PriorFindingStatus[];
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
 * Derives a canonical, collision-resistant identifier for a review, used to
 * match a `priorFindingsStatus[]` entry's `ref` back to the specific review it
 * attests about (PVD-1.3).
 *
 * review.md's Step 5.5 prose loosely described `ref` as "the commit short SHA
 * plus submittedAt" — but a short SHA can collide, and leaving the exact format
 * to freehand prose invites drift between the runbook and this module (the same
 * class of drift PVD-1.1 exists to eliminate). This function pins the format
 * mechanically: the FULL commit oid (never truncated) plus the review's
 * `submittedAt`, joined by `@`. Two reviews can only share a ref if they were
 * posted at the same commit at the same instant — which GitHub does not permit
 * for a single author. Both review.md (Step 5.5 / Step 9.5) and this module
 * reference this function as the single source of truth for the ref format, so
 * the attestation match is mechanical, not fuzzy string comparison.
 */
export function reviewRef(
  review: Pick<ReviewNode, "commit" | "submittedAt">,
): string {
  return `${review.commit.oid}@${review.submittedAt}`;
}

/**
 * Returns true when a prior self-authored review has been attested as resolved
 * by the CURRENT review pass's structured `priorFindingsStatus[]` (PVD-1.3 —
 * the fourth exclusion, alongside isSelfCleanApprove/CPF-2.1,
 * isAddressedByAuthorReply/CPF-2.3, and isSupersededBySelfReview/DRO-1.2).
 *
 * This closes a structural deadlock confirmed live on a third-party PR where
 * CURRENT_USER is the reviewer (PR author != CURRENT_USER) and each review pass
 * posts a NEW review object rather than rewriting a prior one's body.
 * review.md's Step 10/11 always creates a new review per pass, and DRO-1.2's
 * isSupersededBySelfReview only excludes an earlier self-review when a LATER
 * self-review is ITSELF a clean "Verdict: APPROVE" body — but that later review
 * can only be clean if `hasUnaddressedFindings` was already false for its own
 * pass. So as long as an earlier self-authored review with a real finding still
 * qualifies, every subsequent pass's own review is forced to COMMENT too, so it
 * can never supersede the earlier one, so the earlier one never stops
 * qualifying: a circular deadlock. Once a single COMMENT-bodied self-authored
 * review with a real finding exists, the PR can never reach an automated
 * APPROVE again — even after the finding is fixed and every later pass finds
 * nothing new.
 *
 * This exclusion breaks that cycle by consuming PVD-1.2's per-finding
 * attestations: a prior qualifying CURRENT_USER review is excluded when the
 * current pass's `priorFindingsStatus[]` contains an entry (matched by
 * `reviewRef`) that marks it `resolved: true` with non-empty `evidence`.
 *
 * Guardrails, all deliberate:
 * - **Self-authored only.** Only CURRENT_USER's own prior reviews are
 *   self-attestable this way. A distinct third-party GitHub identity's review
 *   is never excluded here — the agent cannot unilaterally resolve someone
 *   else's review via its own subagent's word; that path stays governed by the
 *   CPF-2.3 author-reply exclusion.
 * - **Non-empty evidence required.** `resolved: true` with blank/whitespace
 *   evidence is treated as no attestation — the subagent must cite a concrete
 *   `file:line` or diff excerpt, matching code-reviewer.md's contract.
 * - **Per-finding independence (Option B).** Each entry is evaluated on its own;
 *   this predicate has no dependency on whether OTHER findings in the same pass
 *   are blocking. A fresh unrelated blocking finding elsewhere in the pass does
 *   not prevent an already-verified resolution from being excluded (that fresh
 *   finding still counts on its own via the normal qualifying-review path).
 */
export function isResolvedByPriorFindingsStatus(
  review: Pick<ReviewNode, "author" | "commit" | "submittedAt">,
  priorFindingsStatus: PriorFindingStatus[],
  currentUser: string,
): boolean {
  if (review.author.login !== currentUser) return false;

  const ref = reviewRef(review);
  return priorFindingsStatus.some(
    (s) => s.ref === ref && s.resolved && s.evidence.trim().length > 0,
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
 *
 * Finally, a prior self-authored review is excluded when the current pass's
 * `priorFindingsStatus[]` attests it resolved with evidence (see
 * isResolvedByPriorFindingsStatus, PVD-1.3) — the fourth exclusion, which
 * breaks the review-verdict deadlock where a self-authored COMMENT finding
 * could never be superseded and thus pinned the PR at COMMENT forever. Each
 * `priorFindingsStatus[]` entry is judged independently (Option B): a fresh
 * unrelated blocking finding in the same pass does not prevent an
 * already-verified resolution from being excluded.
 */
export function hasUnaddressedFindings(
  data: PrReviewData,
  currentUser: string,
): boolean {
  const { headRefOid, reviews, reviewThreads, comments } = data;
  const priorFindingsStatus = data.priorFindingsStatus ?? [];

  // Find qualifying reviews: state COMMENTED or CHANGES_REQUESTED at current HEAD,
  // excluding self-authored clean-APPROVE reviews (CPF-2.1), self-reviews
  // superseded by a later clean self-review (DRO-1.2), and prior self-reviews
  // attested resolved by the current pass's priorFindingsStatus[] (PVD-1.3).
  const qualifyingReviews = reviews.nodes.filter(
    (r) =>
      (r.state === "COMMENTED" || r.state === "CHANGES_REQUESTED") &&
      r.commit.oid === headRefOid &&
      !isSelfCleanApprove(r, currentUser) &&
      !isSupersededBySelfReview(r, reviews.nodes, currentUser) &&
      !isResolvedByPriorFindingsStatus(r, priorFindingsStatus, currentUser),
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
  // priorFindingsStatus is optional (PVD-1.3) — absent for first-pass reviews
  // with no prior qualifying reviews to re-verify. When present it must be an
  // array; individual entries are trusted as shaped by code-reviewer.md's
  // Output Format (the subagent contract), same as reviews/comments nodes.
  if (
    parsed.priorFindingsStatus !== undefined &&
    !Array.isArray(parsed.priorFindingsStatus)
  ) {
    throw new Error(
      'Input JSON "priorFindingsStatus" field, when present, must be an array',
    );
  }
  return {
    currentUser: parsed.currentUser,
    headRefOid: parsed.headRefOid,
    reviews: parsed.reviews,
    reviewThreads: parsed.reviewThreads,
    comments: parsed.comments,
    priorFindingsStatus: parsed.priorFindingsStatus ?? [],
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
      priorFindingsStatus: input.priorFindingsStatus,
    },
    input.currentUser,
  );

  console.log(JSON.stringify({ unaddressedFindings }));
}
