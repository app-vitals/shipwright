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
// either of two exclusions:
//   1. isAddressedByAuthorReply (CPF-2.3) — a third-party review addressed by a
//      subsequent PR-author reply. Scoped to the real PR author via `prAuthor`
//      (RAS-1.1), which defaults to `currentUser` when absent.
//   2. isResolvedByLedger (PFL-3.2) — a review whose ref has a matching
//      task-store ledger entry (source: "review") with disposition "resolved"
//      or "superseded". This is NOT gated on self-authorship — ledger entries
//      are written by the code-reviewer subagent independent of whose review
//      is being resolved, so this exclusion applies to third-party reviews
//      too.
//
// (PFL-4.1 removed the three inference-based exclusions this gate used to also
// apply — isSelfCleanApprove/CPF-2.1, isSupersededBySelfReview/DRO-1.2, and
// isResolvedByPriorFindingsStatus/PVD-1.3 — once production ledger data
// confirmed isResolvedByLedger covers every case they caught. isSelfCleanApprove
// and isSupersededBySelfReview remain exported: review.md's Step 5.5 still calls
// them directly to decide what to durably write to the ledger in the first
// place (PFL-2.1), and agent/src/check-patch.ts's hasMergeOnlyStaleFindings
// still uses isSelfCleanApprove for its own, unrelated staleness check.
// isResolvedByPriorFindingsStatus had no other caller and is fully removed.)
//
// Separately, an individual unresolved inline thread is excluded from the
// unresolved-threads check by a third exclusion:
//   3. isThreadAddressedByAuthorReply (URT-1.1) — a thread whose own comments
//      contain a reply from `prAuthor` posted after the thread's first
//      (flagging) comment. Unlike exclusions 1-2, this is scoped to a single
//      thread's own timestamps rather than any review — there is no
//      review<->thread correlation available in the current GraphQL schema
//      (see patch.md's own admission of the same gap), so this exclusion
//      cannot reuse isAddressedByAuthorReply's review-level comparison.
//
// CLI:
//   bun run plugins/shipwright/scripts/compute-unaddressed-findings.ts '{"currentUser":"the-agent","headRefOid":"abc123","reviews":{"nodes":[...]},"reviewThreads":{"nodes":[...]},"comments":{"nodes":[...]},"priorFindingsStatus":[...],"findings":[...],"prAuthor":"pr-author-login"}'
// or pipe the same JSON blob via stdin. `priorFindingsStatus` and `findings`
// are both optional and default to [] when absent. `prAuthor` is optional and
// defaults to `currentUser` when absent (RAS-1.1) — pass it explicitly when
// `currentUser` is not the PR's author (e.g. review.md's Step 9.5, which
// gates verdicts on any PR the bot reviews, including third-party PRs).

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
  comments: {
    nodes: Array<{
      author: { login: string };
      body: string;
      /**
       * Optional (mirrors agent/src/check-patch.ts's RVG-2.1 precedent):
       * only callers that fetch multiple thread comments with `createdAt`
       * (review.md's Step 5.5, widened for URT-1.1) can populate this.
       * Callers whose GraphQL query doesn't request it — or that only fetch
       * a single (first) comment — leave it undefined, which
       * isThreadAddressedByAuthorReply treats as "not addressed" (the
       * default, pre-existing behavior), never throwing.
       */
      createdAt?: string;
    }>;
  };
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

/**
 * One durable, task-store-backed ledger entry for a PR finding (PFL-3.2).
 * Mirrors the fields this module needs from task-store/src/openapi-schemas.ts's
 * `PrFindingSchema` (duplicated here, not imported — see this file's header
 * comment for the rationale). Written by the code-reviewer subagent
 * (`source: "review"`) or the patch pipeline (`source: "patch"`) when a
 * finding's disposition is settled — as opposed to `priorFindingsStatus[]`,
 * which is an ephemeral, single-pass attestation scoped to the CURRENT review
 * invocation only, the ledger persists across passes in the task store.
 */
export interface PrFinding {
  id: string;
  prRecordId: string;
  /** Matches `reviewRef(review)` (or a `file:line` ref for inline findings). */
  ref: string;
  disposition: "resolved" | "superseded" | "rejected";
  /** Which pipeline stage recorded this disposition. */
  source: "review" | "patch";
  evidence: string;
  at: string;
  createdAt: string;
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
  /**
   * Durable task-store ledger entries for this PR (PFL-3.2). Optional —
   * defaults to `[]` when absent, so all existing callers that never build
   * this field keep their current behavior exactly.
   */
  findings?: PrFinding[];
  /**
   * The PR's actual author login, used by `isAddressedByAuthorReply` (CPF-2.3)
   * to recognize a reply as addressing a finding (RAS-1.1). Optional —
   * defaults to `currentUser` when absent, preserving check-patch.ts's own-PR
   * call sites exactly (there, `currentUser` IS the PR author, since `patch`
   * only ever acts on the authenticated user's own open PRs). review.md's
   * Step 9.5 reuses this same function to gate review verdicts on ANY PR the
   * bot reviews, including third-party PRs — there, `currentUser` is the
   * reviewer, not the author, so `prAuthor` must be passed explicitly with
   * the PR's real `author.login` for the reply exclusion to mean anything
   * (root-caused from the ok-wow-agency PR #80 incident, where a third-party
   * PR author's reply never matched `currentUser` and forced the verdict to
   * COMMENT despite zero remaining findings).
   */
  prAuthor?: string;
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
 *
 * PFL-4.1 removed this as a `hasUnaddressedFindings` exclusion — production
 * ledger data confirmed `isResolvedByLedger` (PFL-3.2) covers every case it
 * caught there. Still exported and still called directly by review.md's Step
 * 5.5 (PFL-2.1) to decide which prior self-reviews to durably record as
 * `resolved` in the findings ledger in the first place, and by
 * agent/src/check-patch.ts's `hasMergeOnlyStaleFindings` for its own,
 * unrelated stale-review check.
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
 *
 * `prAuthor` is the PR's actual author login — NOT necessarily `currentUser`
 * (RAS-1.1). check-patch.ts's own-PR call sites pass `currentUser` here
 * (correct there, since `currentUser` IS the PR author), but review.md's
 * Step 9.5 gates verdicts on any PR the bot reviews, including third-party
 * PRs where `currentUser` is the reviewer, not the author — only the PR's
 * actual author can "address" a finding via reply.
 */
export function isAddressedByAuthorReply(
  review: Pick<ReviewNode, "submittedAt">,
  comments: IssueCommentNode[],
  prAuthor: string,
): boolean {
  const reviewedAt = new Date(review.submittedAt).getTime();
  return comments.some(
    (c) =>
      c.author.login === prAuthor &&
      new Date(c.createdAt).getTime() > reviewedAt,
  );
}

/**
 * Returns true when a single inline review thread has been addressed by a
 * subsequent PR-author reply posted within that same thread (URT-1.1).
 *
 * Mirrors isAddressedByAuthorReply (CPF-2.3) above, but scoped to a single
 * thread's own comments rather than a review's `submittedAt` — there is no
 * review<->thread correlation available in the current GraphQL schema (a
 * thread is not linked back to the specific review that raised it), so this
 * predicate compares each thread's own first (flagging) comment's
 * `createdAt` against any LATER comment authored by `prAuthor` in that same
 * thread. A thread with fewer than two comments, or whose comments lack
 * `createdAt` (a caller that didn't fetch it, or only fetched the first
 * comment — the pre-URT-1.1 shape), never matches — this is the
 * regression-safe default: missing timing data means "not addressed",
 * preserving the current behavior exactly for every existing caller.
 */
export function isThreadAddressedByAuthorReply(
  thread: Pick<ReviewThread, "comments">,
  prAuthor: string,
): boolean {
  const [first, ...rest] = thread.comments.nodes;
  if (!first || first.createdAt === undefined) return false;

  const flaggedAt = new Date(first.createdAt).getTime();
  return rest.some(
    (c) =>
      c.author.login === prAuthor &&
      c.createdAt !== undefined &&
      new Date(c.createdAt).getTime() > flaggedAt,
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
 *
 * PFL-4.1 removed this as a `hasUnaddressedFindings` exclusion — production
 * ledger data confirmed `isResolvedByLedger` (PFL-3.2) covers every case it
 * caught there. Still exported and still called directly by review.md's Step
 * 5.5 (PFL-2.1) to decide which prior self-reviews to durably record as
 * `superseded` in the findings ledger in the first place.
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
 * match a durable findings-ledger entry's `ref` (PFL-3.2), or a
 * `priorFindingsStatus[]` attestation's `ref` (PVD-1.2), back to the specific
 * review it addresses.
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
 * Returns true when a durable task-store ledger entry exists for `ref` with
 * `source: "review"` and a disposition of `"resolved"` or `"superseded"`
 * (PFL-3.2 — one of two exclusions, alongside isAddressedByAuthorReply/CPF-2.3).
 *
 * This predicate is deliberately NOT gated on self-authorship: ledger entries
 * are written by the code-reviewer subagent (`source: "review"`) independent
 * of whose review is being resolved, so a third-party review's finding can be
 * excluded here too — the caller does not need to (and should not) filter
 * `findings` by review author before calling this. `source: "patch"` entries
 * never exclude — only the review pipeline's own dispositions count for this
 * gate. A `"rejected"` disposition also never excludes, since the finding was
 * disputed rather than fixed or superseded.
 */
export function isResolvedByLedger(
  ref: string,
  findings: PrFinding[],
): boolean {
  return findings.some(
    (f) =>
      f.ref === ref &&
      f.source === "review" &&
      (f.disposition === "resolved" || f.disposition === "superseded"),
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
 * its body. The PR author's identity for this check is `data.prAuthor`,
 * defaulting to `currentUser` when absent (RAS-1.1) — preserving
 * check-patch.ts's own-PR behavior exactly, while letting review.md's
 * Step 9.5 pass the PR's real author for third-party PRs the bot reviews.
 *
 * ANY qualifying review (self-authored or third-party) is also excluded when
 * a durable task-store ledger entry marks its ref resolved or superseded (see
 * isResolvedByLedger, PFL-3.2) — not gated on self-authorship, since ledger
 * entries are written by the code-reviewer subagent independent of whose
 * review is being resolved.
 *
 * Separately, an unresolved inline thread (isResolved == false) is excluded
 * from the unresolved-threads check when the PR author has replied within
 * that same thread after its first (flagging) comment (see
 * isThreadAddressedByAuthorReply, URT-1.1) — this is scoped to the thread's
 * own comments rather than any review, since no review<->thread correlation
 * is available in the current GraphQL schema: a thread can only be judged
 * against its own timestamps, not the review that (may have) raised it.
 *
 * PFL-4.1 removed `isSelfCleanApprove`/`isSupersededBySelfReview` as
 * exclusions here, on the premise that `isResolvedByLedger` alone covers
 * every case they caught once review.md's Step 5.5 durably records those same
 * judgments to the ledger. That premise breaks for a PR whose only review
 * ever posted is a clean self-approve: Step 5.5 only writes a ledger entry
 * for a *prior* review, evaluated at the start of a *subsequent* review pass
 * — and a PR with nothing new to review (headRefOid unchanged, reviewState
 * already posted) never gets a subsequent pass from check-review.ts's own
 * candidacy gate. No subsequent pass means Step 5.5 never runs, so no ledger
 * entry is ever written, and `isResolvedByLedger` stays false for that review
 * forever (PFL-5.1). Restored here as fallback exclusions alongside
 * `isResolvedByLedger`, not instead of it — a PR that does get re-reviewed
 * and does have a matching ledger entry is unaffected either way.
 */
export function hasUnaddressedFindings(
  data: PrReviewData,
  currentUser: string,
): boolean {
  const { headRefOid, reviews, reviewThreads, comments } = data;
  const findings = data.findings ?? [];
  const prAuthor = data.prAuthor ?? currentUser;

  // Find qualifying reviews: state COMMENTED or CHANGES_REQUESTED at current
  // HEAD, excluding self-authored clean-APPROVE reviews (CPF-2.1), self-reviews
  // superseded by a later clean self-review (DRO-1.2), and reviews
  // resolved/superseded per the task-store ledger (PFL-3.2).
  const qualifyingReviews = reviews.nodes.filter(
    (r) =>
      (r.state === "COMMENTED" || r.state === "CHANGES_REQUESTED") &&
      r.commit.oid === headRefOid &&
      !isSelfCleanApprove(r, currentUser) &&
      !isSupersededBySelfReview(r, reviews.nodes, currentUser) &&
      !isResolvedByLedger(reviewRef(r), findings),
  );

  if (qualifyingReviews.length === 0) return false;

  // Check for unresolved threads, excluding ones the PR author has already
  // replied to and addressed within the thread itself (URT-1.1).
  const unresolvedThreads = reviewThreads.nodes.filter(
    (t) => !t.isResolved && !isThreadAddressedByAuthorReply(t, prAuthor),
  );

  if (unresolvedThreads.length > 0) return true;

  // No unresolved threads — check if any qualifying review has a non-empty
  // body that hasn't been addressed by a subsequent author reply.
  return qualifyingReviews.some(
    (r) =>
      r.body.trim().length > 0 &&
      !isAddressedByAuthorReply(r, comments.nodes, prAuthor),
  );
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

export type CliInput = PrReviewData & { currentUser: string };

export function parseCliInput(raw: string): CliInput {
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
  // findings is optional (PFL-3.2) — absent when no task-store ledger entries
  // exist yet for this PR. When present it must be an array; individual
  // entries are trusted as shaped by the task-store's PrFinding record, same
  // as priorFindingsStatus entries above.
  if (parsed.findings !== undefined && !Array.isArray(parsed.findings)) {
    throw new Error(
      'Input JSON "findings" field, when present, must be an array',
    );
  }
  // prAuthor is optional (RAS-1.1) — absent for callers (e.g. check-patch.ts's
  // own-PR scope, via agent/src, not this CLI) that don't need to distinguish
  // the PR author from currentUser. When present it must be a string;
  // hasUnaddressedFindings defaults it to currentUser when absent.
  if (parsed.prAuthor !== undefined && typeof parsed.prAuthor !== "string") {
    throw new Error(
      'Input JSON "prAuthor" field, when present, must be a string',
    );
  }
  return {
    currentUser: parsed.currentUser,
    headRefOid: parsed.headRefOid,
    reviews: parsed.reviews,
    reviewThreads: parsed.reviewThreads,
    comments: parsed.comments,
    priorFindingsStatus: parsed.priorFindingsStatus ?? [],
    findings: parsed.findings ?? [],
    prAuthor: parsed.prAuthor,
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
      findings: input.findings,
      prAuthor: input.prAuthor,
    },
    input.currentUser,
  );

  console.log(JSON.stringify({ unaddressedFindings }));
}
