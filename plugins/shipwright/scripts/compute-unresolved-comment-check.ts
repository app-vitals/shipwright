#!/usr/bin/env bun
// Mechanical unresolved-comment-check computation gate (UCC-1.1).
//
// Extracts review.md's Step 5 "#### Unresolved Comment Check" freehand
// judgment — whether a human is already mid-conversation on a PR and the
// review pass should be deferred rather than talking over them — into a
// pure, exported function plus a CLI entrypoint, mirroring
// compute-review-verdict.ts's (DRO-1.1) and compute-unaddressed-findings.ts's
// (PVD-1.1) CLI pattern.
//
// Unlike its siblings, Step 5's check ran earlier in the pipeline as
// freehand prose, and its "substantive unresolved comment" definition never
// excluded a review/comment/thread the PR author had already replied to and
// addressed — a case Step 9.5's compute-unaddressed-findings.ts already
// handles correctly via its exported isAddressedByAuthorReply/
// isThreadAddressedByAuthorReply helpers. Because Step 5 runs earlier and
// stops the pipeline (responds [silent] and defers) on a match, its wrong
// answer won even when the later, correct, mechanized Step 9.5 gate would
// say the finding was resolved. This module reuses those two helpers
// directly — do not duplicate their logic.
//
// CLI:
//   bun run plugins/shipwright/scripts/compute-unresolved-comment-check.ts '{"currentUser":"the-agent","headRefOid":"abc123","lastPushDate":"2026-05-26T09:00:00Z","reviews":{"nodes":[...]},"comments":{"nodes":[...]},"reviewThreads":{"nodes":[...]}}'
// or pipe the same JSON blob via stdin. `lastReviewedCommit` and `prAuthor`
// are both optional. `prAuthor` defaults to `currentUser` when absent, same
// as compute-unaddressed-findings.ts's RAS-1.1 convention.

import {
  type IssueCommentNode,
  type ReviewNode,
  type ReviewThread,
  isAddressedByAuthorReply,
  isThreadAddressedByAuthorReply,
} from "./compute-unaddressed-findings.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { IssueCommentNode, ReviewNode, ReviewThread };

export interface UnresolvedCommentCheckInput {
  currentUser: string;
  /**
   * The PR's actual author login (RAS-1.1 convention, mirrored from
   * compute-unaddressed-findings.ts). Optional — defaults to `currentUser`
   * when absent. Only the PR author's replies count as "addressing" a
   * review/comment/thread.
   */
  prAuthor?: string;
  headRefOid: string;
  /**
   * The `reviewedCommitSha` recorded on the task-store PR record from the
   * most recent prior review pass, if any. When set AND different from
   * `headRefOid`, the head has moved since the last review — the check is
   * skipped entirely and this always returns
   * `{ hasSubstantiveUnresolvedFeedback: false }` (re-review unconditionally,
   * new commits override any unresolved-thread skip condition). Absent for
   * first reviews.
   */
  lastReviewedCommit?: string | null;
  /**
   * ISO-8601 timestamp of the most recent commit push to this PR at the
   * current head. Used for the recency-vs-last-push check: a top-level
   * comment posted before this timestamp is treated as already superseded by
   * a later push, not as unresolved feedback blocking this review pass.
   */
  lastPushDate: string;
  reviews: { nodes: ReviewNode[] };
  comments: { nodes: IssueCommentNode[] };
  reviewThreads: { nodes: ReviewThread[] };
}

export interface UnresolvedCommentCheckResult {
  hasSubstantiveUnresolvedFeedback: boolean;
}

// ─── Bot/CI exclusion ───────────────────────────────────────────────────────
//
// Mirrors review.md's existing prose rule ("Author login does not contain
// `[bot]` and is not a known CI account"). No canonical "known CI account"
// list exists elsewhere in this repo (plugins/shipwright is a separate,
// repo-agnostic package from agent/src — see plugins/shipwright/CLAUDE.md),
// so this is a small, local, conservative set of common CI service account
// logins that do not carry a `[bot]` suffix.

const KNOWN_CI_ACCOUNTS = new Set([
  "github-actions",
  "dependabot",
  "dependabot-preview",
  "renovate",
]);

function isBotOrCiAuthor(login: string): boolean {
  return login.includes("[bot]") || KNOWN_CI_ACCOUNTS.has(login);
}

// ─── Trivial-acknowledgement exclusion ─────────────────────────────────────
//
// Mirrors review.md's existing prose rule ("Body is not a trivial
// acknowledgement: not 'LGTM', '+1', 'thanks', 'approved', or emoji-only").
// Exact (case-insensitive, trimmed) match against the four literal phrases,
// plus a separate emoji-only check — a comment containing one of these
// phrases amid other substantive text (e.g. "Thanks, but this still needs a
// fix") is NOT trivial.

const TRIVIAL_ACK_BODIES = new Set(["lgtm", "+1", "thanks", "approved"]);

function isTrivialAcknowledgement(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return true;
  if (TRIVIAL_ACK_BODIES.has(trimmed.toLowerCase())) return true;

  // Emoji-only: no letters or digits present anywhere in the body (allows
  // for emoji, punctuation, and whitespace only).
  return !/[\p{L}\p{N}]/u.test(trimmed);
}

// ─── computeUnresolvedCommentCheck ──────────────────────────────────────────

/**
 * Returns whether this PR has substantive unresolved feedback from a human
 * that this review pass should defer to rather than talk over (review.md's
 * Step 5 "Unresolved Comment Check").
 *
 * Head-moved override: when `lastReviewedCommit` is set and differs from
 * `headRefOid`, the check is skipped entirely — new commits from the author
 * unconditionally override all unresolved-feedback skip conditions.
 *
 * Otherwise, `hasSubstantiveUnresolvedFeedback` is true when ANY of:
 * - A `CHANGES_REQUESTED` review from a non-`currentUser`, non-bot/CI
 *   reviewer at the current `headRefOid` (no commits pushed since that
 *   review), unless the PR author has since replied to it
 *   (`isAddressedByAuthorReply`).
 * - A substantive top-level comment — non-bot/CI author, not the PR author,
 *   not a trivial acknowledgement, posted after `lastPushDate` (no commits
 *   pushed since that comment) — unless the PR author has since replied to
 *   it (`isAddressedByAuthorReply`, keyed on the comment's own `createdAt`
 *   rather than a review's `submittedAt`).
 * - An unresolved inline review thread (`isResolved === false`) whose first
 *   comment's author is not `currentUser`, not the PR author, and not a
 *   bot/CI account —
 *   gated on `isResolved`, not recency, since that is the authoritative
 *   "still needs a response" signal for inline threads — unless the PR
 *   author has since replied within that same thread
 *   (`isThreadAddressedByAuthorReply`).
 */
export function computeUnresolvedCommentCheck(
  input: UnresolvedCommentCheckInput,
): UnresolvedCommentCheckResult {
  const { currentUser, headRefOid, lastReviewedCommit, lastPushDate } = input;
  const prAuthor = input.prAuthor ?? currentUser;

  if (lastReviewedCommit && headRefOid !== lastReviewedCommit) {
    return { hasSubstantiveUnresolvedFeedback: false };
  }

  const lastPushAt = new Date(lastPushDate).getTime();

  const hasUnresolvedChangesRequestedReview = input.reviews.nodes.some(
    (r) =>
      r.state === "CHANGES_REQUESTED" &&
      r.author.login !== currentUser &&
      !isBotOrCiAuthor(r.author.login) &&
      r.commit.oid === headRefOid &&
      !isAddressedByAuthorReply(r, input.comments.nodes, prAuthor),
  );

  const hasSubstantiveUnresolvedComment = input.comments.nodes.some(
    (c) =>
      c.author.login !== currentUser &&
      c.author.login !== prAuthor &&
      !isBotOrCiAuthor(c.author.login) &&
      !isTrivialAcknowledgement(c.body) &&
      new Date(c.createdAt).getTime() > lastPushAt &&
      !isAddressedByAuthorReply(
        { submittedAt: c.createdAt },
        input.comments.nodes,
        prAuthor,
      ),
  );

  const hasUnresolvedThread = input.reviewThreads.nodes.some((t) => {
    const first = t.comments.nodes[0];
    if (!first) return false;
    return (
      !t.isResolved &&
      first.author.login !== currentUser &&
      first.author.login !== prAuthor &&
      !isBotOrCiAuthor(first.author.login) &&
      !isThreadAddressedByAuthorReply(t, prAuthor)
    );
  });

  return {
    hasSubstantiveUnresolvedFeedback:
      hasUnresolvedChangesRequestedReview ||
      hasSubstantiveUnresolvedComment ||
      hasUnresolvedThread,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

export type CliInput = UnresolvedCommentCheckInput;

export function parseCliInput(raw: string): CliInput {
  const parsed = JSON.parse(raw) as Partial<CliInput>;
  if (typeof parsed.currentUser !== "string") {
    throw new Error('Input JSON must have a string "currentUser" field');
  }
  if (typeof parsed.headRefOid !== "string") {
    throw new Error('Input JSON must have a string "headRefOid" field');
  }
  if (typeof parsed.lastPushDate !== "string") {
    throw new Error('Input JSON must have a string "lastPushDate" field');
  }
  if (!parsed.reviews || !Array.isArray(parsed.reviews.nodes)) {
    throw new Error(
      'Input JSON must have a "reviews" field shaped { nodes: [...] }',
    );
  }
  if (!parsed.comments || !Array.isArray(parsed.comments.nodes)) {
    throw new Error(
      'Input JSON must have a "comments" field shaped { nodes: [...] }',
    );
  }
  if (!parsed.reviewThreads || !Array.isArray(parsed.reviewThreads.nodes)) {
    throw new Error(
      'Input JSON must have a "reviewThreads" field shaped { nodes: [...] }',
    );
  }
  if (
    parsed.lastReviewedCommit !== undefined &&
    parsed.lastReviewedCommit !== null &&
    typeof parsed.lastReviewedCommit !== "string"
  ) {
    throw new Error(
      'Input JSON "lastReviewedCommit" field, when present, must be a string',
    );
  }
  if (parsed.prAuthor !== undefined && typeof parsed.prAuthor !== "string") {
    throw new Error(
      'Input JSON "prAuthor" field, when present, must be a string',
    );
  }
  return {
    currentUser: parsed.currentUser,
    headRefOid: parsed.headRefOid,
    lastPushDate: parsed.lastPushDate,
    reviews: parsed.reviews,
    comments: parsed.comments,
    reviewThreads: parsed.reviewThreads,
    lastReviewedCommit: parsed.lastReviewedCommit,
    prAuthor: parsed.prAuthor,
  };
}

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  const input = parseCliInput(raw);

  const result = computeUnresolvedCommentCheck(input);
  console.log(JSON.stringify(result));
}
