/**
 * agent/src/check-review.ts
 *
 * Native, directly-importable equivalent of
 * plugins/shipwright/scripts/check-review.ts — candidate provider for the
 * review phase.
 *
 * Unlike the plugin script (a boolean gate that exits 0/1 for a cron
 * precheck), this function collects and returns the FULL SET of open PRs
 * with unreviewed commits as WorkPrCandidate[], tagged phase: "review". It
 * does not early-return after the first match — the selector needs the whole
 * candidate set to pick the globally-oldest ready item.
 *
 * Dedup uses the task-store PR record (commitSha + reviewState), same as the
 * plugin: a missing record means the PR has not been reviewed yet and is
 * eligible; a query failure is also treated as eligible (graceful
 * degradation, matching the plugin's "err permissive" precheck philosophy).
 *
 * RVD-1.1 adds a second, independent dedup signal against LIVE GitHub review
 * data (via classifyReviewState(), promoted to check-helpers.ts from
 * pr-state-reconciler.ts) — the task-store record alone can't see a review
 * posted by an agent running against a DIFFERENT task-store instance, since
 * that agent never wrote a record here. This check is identity-agnostic (any
 * author's terminal review at the PR's current head commit counts) and
 * applies regardless of what the task-store record says. Same fail-open
 * philosophy: a fetchPrReviews failure is treated as eligible.
 *
 * age is populated from the linked task's createdAt (via queryTaskStatus,
 * LPF-3.2), falling back to the PR's GitHub createdAt when no task is linked
 * or the lookup fails — readyForReviewAt is a necessarily-recent
 * phase-readiness stamp, not the work item's true origination age, and is no
 * longer used for age sourcing (it remains in PrRecord solely for
 * queryPrRecord's other historical callers). Unlike check-deploy.ts's
 * queryTaskStatus usage, a lookup failure here is NOT gating — it is only
 * ever consumed for its createdAt field, so a thrown error just falls back to
 * pr.createdAt rather than disqualifying the PR.
 */

import { reviewAuthorAllowlistRef } from "./review-author-allowlist-ref.ts";
import type { ReviewAuthorAllowlistRef } from "./review-author-allowlist-ref.ts";
import { agentReposRef } from "./agent-repos-ref.ts";
import {
  candidateId,
  classifyReviewState,
  createBundleCompleteQuery,
  createPrRecordQuery,
  createTaskStatusQuery,
  getCurrentUser,
  ghGraphql as ghGraphqlDefault,
  hasAnyReviewAtHead,
  isPrRecordBlockedForDispatch,
  isTaskBlockedForDispatch,
  mapReposTolerant,
  readAllowSelfReview,
  resolveAllRepos,
  resolveWorkspacePath,
  splitOrgRepo,
} from "./check-helpers.ts";
import type { LinkedTaskInfo } from "./check-helpers.ts";
import type { PrReviewData } from "./check-patch.ts";
import type { WorkPrCandidate } from "./work-selector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

// ─── PFL-3.1: ledger-timestamp candidacy trigger ──────────────────────────────
//
// Minimal local mirror of task-store's PrFinding shape
// (task-store/src/openapi-schemas.ts) — only `at` is consumed here, but the
// full shape is mirrored (rather than an ad-hoc `{ at: string }`) to match
// this file's existing local-mirror-type convention (see PrRecord.reviewedAt
// above). Not imported from task-store: agent/src has no dependency on it.
export interface PrFinding {
  id: string;
  prRecordId: string;
  ref: string;
  disposition: "resolved" | "superseded" | "rejected";
  source: "review" | "patch";
  evidence: string;
  at: string;
  createdAt: string;
}

export interface PrInfo {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  headRefOid: string;
  repo?: string;
  isDraft: boolean;
  labels?: { name: string }[];
  createdAt?: string;
  reviewRequests?: { login?: string }[];
}

export interface PrRecord {
  commitSha?: string | null;
  /**
   * The review pipeline's exclusive commit-tracking field (RCS-1.2),
   * written by review.md, separate from the shared commitSha field also
   * advanced by PullRequestService.patch()/claim()/deploy for their own
   * multi-phase bookkeeping. The staged-review guard below reads this field
   * — not commitSha — so that patch()'s unrelated commitSha bumps (e.g.
   * after a CI-fix cycle) can never masquerade as "already reviewed at this
   * head" for a staged, never-re-reviewed review (RCS-1.3).
   */
  reviewedCommitSha?: string | null;
  reviewState: string;
  readyForReviewAt?: string | null;
  claimedBy?: string | null;
  blocked?: boolean | null;
  staged?: boolean;
  /**
   * Timestamp of the last review pass written by review.md, used as the
   * watermark for the author-reply retrigger check below (RVG-1.1) — a PR
   * author comment with createdAt after this value is a fresh, not-yet-
   * consumed confirmation reply. Already present on the task-store /prs
   * record (see task-store/src/pull-request-service.ts and
   * openapi-schemas.ts); only newly declared here so this file's local
   * PrRecord interface carries it through createPrRecordQuery's generic JSON
   * parse.
   */
  reviewedAt?: string | null;
  /**
   * Ledger findings for this PR (PFL-1.2's POST /prs/:id/findings, written
   * for both review-authored findings and PFL-2.2's patch-rebuttal
   * entries). Already present on the task-store /prs record (see
   * task-store/src/openapi-schemas.ts's PrFinding); only newly declared
   * here so this file's local PrRecord interface carries it through
   * createPrRecordQuery's generic JSON parse — see the ledger-timestamp
   * trigger (PFL-3.1) in traceReviewCandidacyDecision below.
   */
  findings?: PrFinding[];
}

// ─── RCT-1.1: fresh non-agent comment detection ───────────────────────────────
//
// Broadens the original RFR-1.1/RVG-2.1 "fresh author reply" signal from
// "a comment authored by pr.author.login" to "a comment authored by anyone
// other than the reviewing agent's own identity". A third-party reviewer's
// plain PR comment (not a formal GitHub review submission) previously never
// tripped the exception, so a PR with an already-terminal review never got
// re-reviewed even when a reviewer left substantive follow-up feedback as a
// comment rather than a review. Excluding currentUser (rather than requiring
// equality with pr.author.login) means a comment from the PR author, a
// third-party reviewer, or anyone else now counts — except the reviewing
// agent's own comments, which must never count (otherwise the agent's own
// replies would cause it to endlessly re-trigger review on its own PR).
//
// Checks both top-level PR conversation comments AND inline review-thread
// replies (RVG-2.1) — GitHub represents an inline thread reply as its own
// zero-body PullRequestReview record stamped to head, counted by
// hasAnyReviewAtHead() as "a review at head" like any other, so without this
// OR the one signal meant to override that skip never fires when the reply
// was posted inline instead of as a new top-level comment. createdAt is
// optional on thread comments (only this file's fetchPrReviews query
// requests it), so a missing value is treated as not-fresh rather than
// throwing.
export function hasFreshNonAgentComment(
  reviewData: PrReviewData | undefined,
  currentUser: string,
  reviewedAtMs: number,
): boolean {
  const hasFreshTopLevelReply =
    reviewData?.comments.nodes.some(
      (c) =>
        c.author.login !== currentUser &&
        new Date(c.createdAt).getTime() > reviewedAtMs,
    ) ?? false;
  const hasFreshThreadReply =
    reviewData?.reviewThreads.nodes.some((t) =>
      t.comments.nodes.some(
        (c) =>
          c.author.login !== currentUser &&
          c.createdAt !== undefined &&
          new Date(c.createdAt).getTime() > reviewedAtMs,
      ),
    ) ?? false;
  return hasFreshTopLevelReply || hasFreshThreadReply;
}

// ─── RCO-1.3: review-candidacy tracing ────────────────────────────────────────
//
// Structured trace of WHY a PR was or wasn't a review candidate — added after
// an incident (ok-wow/ok-wow-agency#66, stuck ~4h) where diagnosing a
// silently-skipped PR required hours of indirect Sentry log archaeology
// instead of a direct search. `check: "eligible"` means none of the
// exclusion checks below fired; every other variant names the specific
// check that excluded the PR plus the field values that drove the decision,
// so a single log line answers "why wasn't this PR a candidate" without
// reconstructing state from multiple call sites.
//
// Deliberately exported (not a private helper) so RCO-1.4's diagnostic
// script can call the same classification logic directly instead of
// re-deriving it — see traceReviewCandidacyDecision below.
export type ReviewCandidacyTrace =
  | { check: "eligible" }
  | { check: "draft" }
  | { check: "excluded-bot-author"; author: string }
  | { check: "automated-label" }
  | { check: "self-review"; currentUser: string; isRequestedReviewer: boolean }
  | {
      check: "not-allowlisted";
      author: string;
      isRequestedReviewer: boolean;
      /**
       * The live authorAllowlistRef value at decision time (AAL-3.2),
       * included so a repeat of the ok-wow/ok-wow-ai#1919 mystery — two
       * review cycles somehow completing despite a non-allowlisted author,
       * before this exact check later (correctly) started firing on every
       * subsequent commit — is diagnosable from a single Sentry log line
       * instead of hours of indirect archaeology.
       */
      authorAllowlistRef: string[];
    }
  | {
      check: "already-reviewed-live";
      classifiedState: "approved" | "posted" | null;
      hasFreshAuthorReply: boolean;
    }
  | { check: "task-blocked"; hitl?: boolean; taskStatus?: string }
  | { check: "bundle-incomplete"; branch: string }
  | { check: "claimed"; claimedBy: string }
  | { check: "pr-record-blocked" }
  | {
      check: "already-reviewed-terminal";
      reviewedCommitSha?: string | null;
      headRefOid: string;
      reviewState: string;
    }
  | { check: "staged"; reviewedCommitSha?: string | null; headRefOid: string };

/**
 * Classify the "later" exclusion checks — the ones that depend on state
 * already fetched from live GitHub/task-store data (the task-store PR
 * record, live review data via fetchPrReviews, the linked task, and
 * bundle-completeness) — into a single ReviewCandidacyTrace (RCO-1.3).
 *
 * Deliberately does NOT cover the earlier, cheap in-memory checks (draft,
 * dependabot, automated-label, self-review, not-allowlisted) — those don't
 * need any I/O-derived state and getReviewCandidates traces them inline at
 * their own `continue` points instead. This function exists specifically
 * for the checks a standalone diagnostic script (RCO-1.4) would otherwise
 * have to fetch-once-and-reclassify itself; keeping the classification here
 * means that script calls this exact function rather than re-deriving the
 * same conditions.
 *
 * Mirrors getReviewCandidates' own exclusion order exactly: live-review
 * dedup, then task-blocked, then bundle-incomplete, then claimed, then
 * pr-record-blocked, then terminal-skip, then staged. Pure — no I/O, no
 * side effects — so it is trivially unit-testable and reusable.
 */
export function traceReviewCandidacyDecision(args: {
  pr: PrInfo;
  record: PrRecord | null;
  reviewData: PrReviewData | undefined;
  hasFreshAuthorReply: boolean;
  linkedTask: LinkedTaskInfo | null;
  isBundleComplete: boolean | undefined;
}): ReviewCandidacyTrace {
  const {
    pr,
    record,
    reviewData,
    hasFreshAuthorReply,
    linkedTask,
    isBundleComplete,
  } = args;

  // PFL-3.1: a ledger finding (PFL-1.2's POST /prs/:id/findings) newer than
  // the last review pass is a bypass of BOTH exclusion checks below — the
  // live-GitHub review dedup immediately following this block, and the
  // terminal-skip check further down — alongside hasFreshAuthorReply.
  // Hoisted to the very top of the function, ahead of the live-review
  // dedup's early return, because that return fires (and `continue`s the
  // caller's loop) before a lower placement would ever be reached in the
  // exact scenario PFL-3.1 targets: a review already live at the PR's
  // current head commit, no fresh author reply, but a fresh ledger finding
  // recorded since. Computed against `record` via optional chaining since
  // this now runs before the `!record` null check below. Mirrors the
  // `new Date(record?.reviewedAt ?? 0)` epoch-0 fallback pattern used for
  // reviewedAtMs elsewhere in this file, and uses the same strict `>`
  // inequality as hasFreshAuthorReply's own freshness check (a finding
  // stamped exactly at reviewedAt does not count).
  //
  // PFL-3.3: scoped to source: "patch" findings only — source: "review"
  // findings are excluded from the freshness comparison entirely, even when
  // their `at` postdates reviewedAt. Every source: "review" ledger write
  // (review.md's PFL-2.1 self-review judgments and prior-findings
  // attestations) is a retrospective disposition about an OLDER review,
  // computed and POSTed within the same pass that stamps reviewedAt; by
  // review.md's own ordering rule that POST must complete before that same
  // pass's Step 11b. So a source: "review" finding ever postdating
  // reviewedAt can only reflect an ordering violation within that pass —
  // never genuine new information (the PR #89/#107 race, documented in
  // review.md). Only source: "patch" (PFL-2.2's rejected-finding writes from
  // a later patch/rebuttal cycle) represents information genuinely new since
  // the last review.
  const reviewedAtMs = new Date(record?.reviewedAt ?? 0).getTime();
  const hasFreshLedgerFinding =
    record?.findings?.some(
      (f) => f.source === "patch" && new Date(f.at).getTime() > reviewedAtMs,
    ) ?? false;

  // Live-GitHub review dedup (RVD-1.1, widened by RVD-2.1) —
  // identity-agnostic: ANY review at the PR's current head commit excludes
  // it from candidacy, independent of the task-store record. Deliberately
  // broader than classifyReviewState() !== null: that helper returns null
  // for two situations that look identical to this caller — "no review at
  // head at all" (still eligible) and "a review exists but has a genuine
  // unaddressed finding" (must NOT be re-selected for another review pass;
  // review.md's own RVD-1.2 dispatch-time check already defers on it, so
  // treating it as candidate here just wastes a tick reselecting a PR that
  // will bounce right back). hasAnyReviewAtHead() disambiguates the two,
  // matching review.md's RVD-1.2 rule exactly: any review at head + no
  // fresh author reply and no fresh ledger finding (PFL-3.1) -> excluded,
  // regardless of finding content.
  if (reviewData) {
    if (
      hasAnyReviewAtHead(reviewData) &&
      !hasFreshAuthorReply &&
      !hasFreshLedgerFinding
    ) {
      return {
        check: "already-reviewed-live",
        classifiedState: classifyReviewState(reviewData),
        hasFreshAuthorReply,
      };
    }
  }

  // hitl/blocked linked task (CBD-2.2, PRB-2.3).
  if (isTaskBlockedForDispatch(linkedTask)) {
    return {
      check: "task-blocked",
      hitl: linkedTask?.hitl,
      taskStatus: linkedTask?.status,
    };
  }

  // Bundle completeness gate (RBG-1.1).
  if (isBundleComplete === false) {
    return { check: "bundle-incomplete", branch: pr.headRefName };
  }

  if (!record) return { check: "eligible" };

  // Claimed by another agent replica (LPF-2.2).
  if (record.claimedBy != null) {
    return { check: "claimed", claimedBy: record.claimedBy };
  }

  // Human-escalated PR record (PRB-2.3, PRB-3.1).
  if (isPrRecordBlockedForDispatch(record)) {
    return { check: "pr-record-blocked" };
  }

  // Terminal-skip (RCO-1.2): reviewedCommitSha matches head and reviewState
  // is not pending, unless the author has a fresh reply (RVG-1.1) or a fresh
  // ledger finding has been recorded since the last review (PFL-3.1).
  if (
    record.reviewedCommitSha === pr.headRefOid &&
    record.reviewState !== "pending" &&
    !hasFreshAuthorReply &&
    !hasFreshLedgerFinding
  ) {
    return {
      check: "already-reviewed-terminal",
      reviewedCommitSha: record.reviewedCommitSha,
      headRefOid: pr.headRefOid,
      reviewState: record.reviewState,
    };
  }

  // Staged review (RCS-1.3), independent of reviewState.
  if (record.staged === true && record.reviewedCommitSha === pr.headRefOid) {
    return {
      check: "staged",
      reviewedCommitSha: record.reviewedCommitSha,
      headRefOid: pr.headRefOid,
    };
  }

  return { check: "eligible" };
}

/**
 * Emit one structured `[check-review]` log line for a skipped PR (RCO-1.3).
 * Only ever called for non-eligible traces — see getReviewCandidates' call
 * sites — so every logged line represents a real exclusion, not a candidate.
 */
function logSkippedCandidacy(
  pr: PrInfo,
  trace: Exclude<ReviewCandidacyTrace, { check: "eligible" }>,
): void {
  console.log(
    `[check-review] ${JSON.stringify({ repo: pr.repo, pr: pr.number, ...trace })}`,
  );
}

export interface CheckReviewDeps {
  getCurrentUser: () => Promise<string>;
  /**
   * Whether self-review is allowed (the `allow_self_review` policy field,
   * state/agent-policy.md). A getter, invoked fresh on every
   * getReviewCandidates() call — not evaluated once at buildProductionDeps()
   * time — so an edit to state/agent-policy.md takes effect on the very next
   * call without requiring an agent process restart (PLR-1.1). Mirrors this
   * file's own getScopedRepos/hasScopeSynced live-read pattern.
   * buildProductionDeps() wires this as `() =>
   * readAllowSelfReview(workspacePath)` (check-helpers.ts).
   */
  isSelfReviewAllowed: () => boolean;
  listOpenPrs: (repo: string) => Promise<PrInfo[]>;
  queryPrRecord: (repo: string, prNumber: number) => Promise<PrRecord | null>;
  /**
   * Returns the agent's currently configured repo scope (org/repo strings).
   * Called at the top of every getReviewCandidates() invocation — not once at
   * deps-build time — so a repo present in the local clone list (and
   * therefore returned by listOpenPrs) but absent from this call's result is
   * excluded from candidates, and a later scope change is picked up on the
   * very next call.
   */
  getScopedRepos: () => string[];
  /**
   * True once the agent's repo scope has been successfully synced at least
   * once. When false (e.g. a persistent 404 on the agent's config bundle —
   * see index.ts's syncConfig), getReviewCandidates() fails open and does
   * not filter by scope at all, matching pre-scoping behavior — otherwise a
   * config-sync outage would silently exclude every repo from review
   * candidacy, indistinguishable from "no work found".
   */
  hasScopeSynced: () => boolean;
  // Task status lookup for the linked task (if any), used PURELY to source
  // the age field via its createdAt — unlike check-deploy.ts, this is never
  // used as a gating/disqualifying check here. A thrown error is treated the
  // same as "no linked task" (age falls back to pr.createdAt); it must not
  // disqualify an otherwise-eligible PR from review candidacy.
  queryTaskStatus?: (
    repo: string,
    prNumber: number,
  ) => Promise<LinkedTaskInfo | null>;
  /**
   * Optional author allowlist hook. When set, getReviewCandidates() skips any
   * PR whose pr.author.login this returns false for. buildProductionDeps()
   * defaults this to a closure backed by the agent's synced authorAllowlist
   * config field (via reviewAuthorAllowlistRef) — an empty allowlist means
   * unfiltered. Callers can still pass an explicit override (e.g.
   * scripts/hitl.ts's SHIPWRIGHT_HITL_AUTHORS env var) to bypass the
   * ref-backed default entirely.
   */
  isAuthorAllowed?: (login: string) => boolean;
  // Bundle completeness gate: returns false if any bundle-mate task on the branch
  // is still pending/in_progress/blocked. PR is skipped when it returns false.
  isBundleComplete?: (branch: string) => Promise<boolean>;
  /**
   * Fetch head commit + reviews + review threads for a single PR (RVD-1.1).
   * Used to dedup against LIVE GitHub review data, independent of the
   * task-store PR record — a PR reviewed by an agent running against a
   * DIFFERENT task-store instance leaves no trace in this instance's record,
   * so the record-based dedup above can't see it. classifyReviewState()
   * (check-helpers.ts) is identity-agnostic: any author's terminal review at
   * the PR's current head commit counts, matching pr-state-reconciler.ts's
   * reconcileReviewState() semantics. A throw/rejection here is caught and
   * treated as "no terminal review at head" (fail open — PR stays eligible),
   * matching this function's existing permissive-on-error philosophy for
   * queryPrRecord failures above.
   */
  fetchPrReviews: (
    org: string,
    repo: string,
    pr: number,
  ) => Promise<PrReviewData>;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Bot-authored PRs unconditionally excluded from review candidacy —
 * dependency-bump bots that open PRs against the repo but are never
 * eligible reviewees (RNV-1.1 added app/renovate alongside the original
 * app/dependabot exclusion). Kept as a small list rather than a single
 * hardcoded string so a future bot author is a one-line addition here
 * instead of a second one-off comparison.
 */
const EXCLUDED_BOT_AUTHORS = ["app/dependabot", "app/renovate"];

/**
 * Collect all open PRs with unreviewed commits, across all repos returned by
 * listOpenPrs, as WorkPrCandidate[] tagged phase: "review".
 */
export async function getReviewCandidates(
  deps: CheckReviewDeps,
): Promise<WorkPrCandidate[]> {
  const currentUser = await deps.getCurrentUser();

  // Fail open when scope has never synced (e.g. a persistent config-bundle
  // 404) — filtering by an unpopulated scope would silently drop every repo
  // from candidacy, a failure mode that didn't exist before scoping.
  const scopeSynced = deps.hasScopeSynced();
  const scopedRepos = new Set(deps.getScopedRepos());
  const allPrs = await deps.listOpenPrs("default");
  const prs = scopeSynced
    ? allPrs.filter((pr) => scopedRepos.has(pr.repo ?? ""))
    : allPrs;
  const candidates: WorkPrCandidate[] = [];

  for (const pr of prs) {
    if (pr.isDraft) {
      logSkippedCandidacy(pr, { check: "draft" });
      continue;
    }
    if (EXCLUDED_BOT_AUTHORS.includes(pr.author.login)) {
      logSkippedCandidacy(pr, {
        check: "excluded-bot-author",
        author: pr.author.login,
      });
      continue;
    }
    if (pr.labels?.some((l) => l.name === "automated")) {
      logSkippedCandidacy(pr, { check: "automated-label" });
      continue;
    }

    // Requested-reviewer bypass (RRR-1.1, extended to the allowlist by
    // RRA-1.1) — an additive path layered on top of BOTH the self-review
    // exclusion AND the author-allowlist exclusion below: when the agent's
    // own GitHub identity is listed as a requested reviewer on this PR, it
    // stays eligible even if it would otherwise be excluded as self-authored
    // or as an allowlist-excluded author. For an already-allowlisted author
    // this bypass has no observable effect — isAuthorAllowed already
    // includes them unconditionally — so its only meaningful effect is for
    // non-allowlisted authors, which is the intended behavior: any
    // collaborator with repo write access can trigger an agent review by
    // explicitly requesting one via GitHub's "Request a reviewer" action,
    // even on a PR from an author the allowlist would otherwise exclude.
    // This is a known, accepted access-boundary loosening (confirmed with
    // the team), not an oversight — the same write access already required
    // to open a PR is sufficient to request the agent as a reviewer on it.
    // All other exclusions (draft, dependabot, automated label above; live-
    // review dedup, task-store dedup, hitl/blocked, bundle-incomplete below)
    // still apply unconditionally regardless of requested-reviewer status.
    const isRequestedReviewer =
      pr.reviewRequests?.some((r) => r.login === currentUser) ?? false;

    if (
      !deps.isSelfReviewAllowed() &&
      pr.author.login === currentUser &&
      !isRequestedReviewer
    ) {
      logSkippedCandidacy(pr, {
        check: "self-review",
        currentUser,
        isRequestedReviewer,
      });
      continue;
    }

    let record: PrRecord | null = null;
    let queryPrRecordFailed = false;
    try {
      record = await deps.queryPrRecord(pr.repo ?? "", pr.number);
    } catch {
      // Query failed → treat as eligible (no dedup). Tracked separately from
      // "no record" (see queryPrRecordFailed below) so a transient failure
      // can't be confused with a genuine absence of a PrRecord.
      queryPrRecordFailed = true;
    }

    // Author allowlist (HRA-1.1) — deliberately gated on `record == null`
    // (AAL-3.2): the allowlist gates INITIAL exposure to a repo's PRs, not
    // every subsequent commit on a PR that already cleared it once. Once a
    // PrRecord exists, the PR already passed this gate at least one prior
    // tick and entered the review pipeline (a human/agent reviewer already
    // engaged with it) — re-excluding it on a later commit from the same
    // (still non-allowlisted) author would silently and permanently drop an
    // actively-reviewed PR out of candidacy the moment its author pushes a
    // follow-up commit responding to review feedback (confirmed live on
    // ok-wow/ok-wow-ai#1919: two review cycles completed, then every
    // subsequent tick excluded on this check). This does not reopen the
    // self-request-defeat concern the isRequestedReviewer bypass above
    // exists to avoid: a non-allowlisted author still cannot manufacture an
    // initial PrRecord solo — reaching this record-exists branch still
    // requires having passed the allowlist gate (or the requested-reviewer
    // bypass) at least once, exactly as today. The live authorAllowlistRef
    // value is logged alongside the decision so a repeat of the ok-wow-ai#1919
    // mystery (how the first two cycles got through despite the allowlist)
    // is diagnosable from Sentry logs alone, without needing to reproduce.
    //
    // `queryPrRecordFailed` guards against conflating "queryPrRecord threw"
    // with "queryPrRecord returned null because no PrRecord exists yet" —
    // both leave `record == null`, but only the latter is a genuine "never
    // passed the gate" case that should grant the re-gate exception below. A
    // transient fetch failure must NOT grant that exception — doing so could
    // let an already-excluded, non-allowlisted author's PR slip through
    // undetected. Instead, on failure the allowlist check falls through to
    // normal isAuthorAllowed evaluation, matching pre-AAL-3.2 behavior
    // (queryPrRecord was fetched after the allowlist check and so never
    // influenced it) — this preserves the exact ok-wow-ai#1919 fix (a
    // genuinely existing record still bypasses re-gating) while not letting
    // a fetch failure masquerade as one.
    if (
      (record == null || queryPrRecordFailed) &&
      deps.isAuthorAllowed &&
      !deps.isAuthorAllowed(pr.author.login) &&
      !isRequestedReviewer
    ) {
      logSkippedCandidacy(pr, {
        check: "not-allowlisted",
        author: pr.author.login,
        isRequestedReviewer,
        authorAllowlistRef: reviewAuthorAllowlistRef.get(),
      });
      continue;
    }

    // Live-GitHub review dedup (RVD-1.1) — a second, independent signal from
    // the task-store record above: skip this PR when a terminal review
    // already exists at its CURRENT head commit on GitHub, regardless of
    // author and regardless of what the task-store record says (it may have
    // no record at all, e.g. an agent running against a different
    // task-store instance already reviewed it). Applied unconditionally
    // before the record-based eligibility checks below, since it excludes
    // rather than includes. A fetch failure is caught and treated as "no
    // terminal review" — fail open, matching queryPrRecord's own permissive-
    // on-error handling above.
    //
    // reviewData is hoisted (rather than scoped to this try block) so the
    // terminal-skip check further below (RVG-1.1) can reuse the same fetch
    // result to look for a fresh author reply, instead of issuing a second
    // fetchPrReviews call for the same PR. Stays undefined when the fetch
    // above failed — the RVG-1.1 check treats that the same as "no eligible
    // author comment found" (old skip behavior preserved).
    //
    // hasFreshAuthorReply (RFR-1.1, broadened by RCT-1.1 to
    // hasFreshNonAgentComment) is computed once here, right after reviewData
    // is fetched, and reused by BOTH this check and the RVG-1.1 check below.
    // It must be available here, not just at RVG-1.1: a clean/no-finding
    // review (classifyReviewState() returns "approved" or "posted", not
    // null — e.g. "no new issues found, posting as COMMENT only") makes THIS
    // check `continue` unconditionally, before control ever reaches
    // RVG-1.1's terminal-skip block further down — so without the exception
    // here too, RVG-1.1's own fresh-reply exception is unreachable for
    // exactly the case it exists to handle (confirmed live on PR #2456).
    //
    // RCT-1.1 broadens the identity filter from pr.author.login (the PR's
    // own author) to currentUser (the reviewing agent's own identity,
    // excluded rather than required) — a third-party reviewer's plain PR
    // comment, not just the PR author's, now counts as a fresh reply,
    // provided it isn't the reviewing agent's own comment. Uses
    // record?.reviewedAt as the watermark (record is already in scope from
    // the queryPrRecord call above); record may be null here (no task-store
    // record yet), in which case the `?? 0` epoch fallback makes any
    // non-agent comment count, mirroring RVG-1.1's existing null-safety.
    const reviewedAtMs = new Date(record?.reviewedAt ?? 0).getTime();
    let reviewData: PrReviewData | undefined;
    let hasFreshAuthorReply = false;
    try {
      const [org, repoName] = splitOrgRepo(pr.repo ?? "");
      reviewData = await deps.fetchPrReviews(org, repoName, pr.number);
      hasFreshAuthorReply = hasFreshNonAgentComment(
        reviewData,
        currentUser,
        reviewedAtMs,
      );
      // Live-GitHub review dedup (RVD-1.1) short-circuits right here, inside
      // the try block, before the task-store lookups below — traced via the
      // same traceReviewCandidacyDecision used for the later checks (RCO-1.3)
      // so this exclusion is classified identically whether it fires here or
      // there. isBundleComplete/linkedTask aren't known yet at this point in
      // the loop, so they're passed as their "not excluding" defaults —
      // traceReviewCandidacyDecision checks live-review dedup first and
      // returns before it would ever consult them.
      const liveReviewTrace = traceReviewCandidacyDecision({
        pr,
        record,
        reviewData,
        hasFreshAuthorReply,
        linkedTask: null,
        isBundleComplete: undefined,
      });
      if (liveReviewTrace.check === "already-reviewed-live") {
        logSkippedCandidacy(pr, liveReviewTrace);
        continue;
      }
    } catch {
      // Fetch failed → treat as "no terminal review" (no dedup)
    }

    // Task-store task lookup, used to source the age field from the linked
    // task's createdAt (LPF-3.2) and to gate on hitl (CBD-2.2). A thrown error
    // is treated as "no linked task" so a lookup failure never disqualifies
    // an otherwise-eligible PR from review candidacy.
    let linkedTask: LinkedTaskInfo | null = null;
    if (deps.queryTaskStatus) {
      try {
        linkedTask = await deps.queryTaskStatus(pr.repo ?? "", pr.number);
      } catch {
        linkedTask = null;
      }
    }

    let isBundleComplete: boolean | undefined;
    if (deps.isBundleComplete) {
      isBundleComplete = await deps
        .isBundleComplete(pr.headRefName)
        .catch(() => true);
    }

    const age = linkedTask?.createdAt ?? pr.createdAt ?? "";

    // Remaining exclusion checks (task-blocked, bundle-incomplete, claimed,
    // pr-record-blocked, already-reviewed-terminal (RCO-1.2), staged
    // (RCS-1.3)) are classified by the shared traceReviewCandidacyDecision —
    // see its doc comment for why this portion is factored out (RCO-1.3).
    const trace = traceReviewCandidacyDecision({
      pr,
      record,
      reviewData,
      hasFreshAuthorReply,
      linkedTask,
      isBundleComplete,
    });
    if (trace.check !== "eligible") {
      logSkippedCandidacy(pr, trace);
      continue;
    }

    candidates.push({
      id: candidateId(pr.repo ?? "unknown", pr.number),
      age,
      phase: "review",
      title: pr.title,
      commitSha: pr.headRefOid,
    });
  }

  return candidates;
}

// ─── Production deps ──────────────────────────────────────────────────────────

export async function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => Promise<T>;
  /**
   * Optional override for the GraphQL client backing fetchPrReviews
   * (RVD-1.1) — mirrors check-patch.ts's buildProductionDeps's required
   * ghGraphql param, but kept optional here (defaulting to check-helpers.ts's
   * shared ghGraphql) so existing callers/tests that only pass ghJson keep
   * working unchanged.
   */
  ghGraphql?: <T>(query: string) => Promise<T>;
  fetchFn?: typeof fetch;
  getScopedRepos?: () => string[];
  hasScopeSynced?: () => boolean;
  /**
   * Optional explicit override for the ref-backed author-allowlist default
   * (used by scripts/hitl.ts's SHIPWRIGHT_HITL_AUTHORS env var, and AAL-3.1).
   * When omitted, defaults to a closure reading reviewAuthorAllowlistRef live,
   * so allowlist changes from config-sync take effect on the next call
   * without rebuilding deps.
   */
  isAuthorAllowed?: (login: string) => boolean;
  /**
   * Optional override for which ReviewAuthorAllowlistRef instance the default
   * isAuthorAllowed closure reads from. Defaults to the process-wide
   * reviewAuthorAllowlistRef singleton. Exists so tests can inject a fresh,
   * independent ref (e.g. via createReviewAuthorAllowlistRef()) to exercise
   * the true "never synced" (hasSynced() === false) state, which the
   * singleton — shared across the whole test file — cannot represent once
   * any other test has called .set() on it. Mirrors the fetchFn injection
   * pattern used elsewhere in this file (e.g. createPrRecordQuery).
   */
  authorAllowlistRef?: ReviewAuthorAllowlistRef;
  /**
   * Optional override for the resolved workspace root, normally derived from
   * WORKSPACE_PATH/AGENT_HOME via resolveWorkspacePath(). Exists so tests that
   * only care about other deps (e.g. the isAuthorAllowed default, AAL-2.2 /
   * T-078) don't need AGENT_HOME/WORKSPACE_PATH set in the ambient
   * process.env — avoiding a shared-process test-isolation hazard where
   * another suite's temporary env mutation (e.g.
   * check-helpers.unit.test.ts's resolveWorkspacePath tests deleting
   * AGENT_HOME around their own assertions) could otherwise leak into these
   * tests since Bun runs all test files in one process. Defaults to
   * resolveWorkspacePath() when omitted, so production callers are
   * unaffected.
   */
  workspacePath?: string;
}): Promise<CheckReviewDeps> {
  const workspacePath = opts.workspacePath ?? resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);
  const { ghJson: ghJsonFn } = opts;
  const ghGraphqlFn = opts.ghGraphql ?? ghGraphqlDefault;
  const authorAllowlistRef = opts.authorAllowlistRef ?? reviewAuthorAllowlistRef;

  return {
    getCurrentUser,
    isSelfReviewAllowed: () => readAllowSelfReview(workspacePath),
    getScopedRepos: opts.getScopedRepos ?? agentReposRef.get,
    hasScopeSynced: opts.hasScopeSynced ?? agentReposRef.hasSynced,
    isAuthorAllowed:
      opts.isAuthorAllowed ??
      ((login: string) =>
        authorAllowlistRef.get().length === 0 ||
        authorAllowlistRef.get().includes(login)),
    listOpenPrs: async (_repo: string) => {
      return mapReposTolerant(allRepos, "check-review", async (repo) => {
        const repoPrs = await ghJsonFn<PrInfo[]>([
          "pr",
          "list",
          "--state",
          "open",
          "--repo",
          repo,
          "--json",
          "number,title,author,headRefName,headRefOid,isDraft,labels,createdAt,reviewRequests",
        ]);
        return repoPrs.map((pr) => ({ ...pr, repo }));
      });
    },
    queryPrRecord: createPrRecordQuery<PrRecord>({ fetchFn: opts.fetchFn }),
    queryTaskStatus: createTaskStatusQuery({ fetchFn: opts.fetchFn }),
    isBundleComplete: createBundleCompleteQuery({ fetchFn: opts.fetchFn }),
    fetchPrReviews: async (org: string, repo: string, pr: number) => {
      const query = `{
  repository(owner: "${org}", name: "${repo}") {
    pullRequest(number: ${pr}) {
      headRefOid
      reviews(first: 50) {
        nodes {
          author { login }
          state
          submittedAt
          commit { oid }
          body
        }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(last: 20) {
            nodes {
              author { login }
              body
              createdAt
            }
          }
        }
      }
      comments(last: 50) {
        nodes {
          author { login }
          body
          createdAt
        }
      }
    }
  }
}`;
      const response = await ghGraphqlFn<{
        data: { repository: { pullRequest: PrReviewData } };
      }>(query);
      return response.data.repository.pullRequest;
    },
  };
}
