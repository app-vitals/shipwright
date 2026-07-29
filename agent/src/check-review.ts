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

import { agentAuthorAllowlistRef } from "./agent-author-allowlist-ref.ts";
import type { AgentAuthorAllowlistRef } from "./agent-author-allowlist-ref.ts";
import { agentReposRef } from "./agent-repos-ref.ts";
import {
  candidateId,
  classifyReviewState,
  createBundleCompleteQuery,
  createPrRecordQuery,
  createTaskStatusQuery,
  getCurrentUser,
  ghGraphql as ghGraphqlDefault,
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
  hitl?: boolean | null;
  staged?: boolean;
}

export interface CheckReviewDeps {
  getCurrentUser: () => Promise<string>;
  isSelfReviewAllowed: boolean;
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
   * config field (via agentAuthorAllowlistRef) — an empty allowlist means
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
  fetchPrReviews: (org: string, repo: string, pr: number) => Promise<PrReviewData>;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

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
    if (pr.isDraft) continue;
    if (pr.author.login === "app/dependabot") continue;
    if (pr.labels?.some((l) => l.name === "automated")) continue;
    if (!deps.isSelfReviewAllowed && pr.author.login === currentUser) continue;
    if (deps.isAuthorAllowed && !deps.isAuthorAllowed(pr.author.login))
      continue;

    let record: PrRecord | null = null;
    try {
      record = await deps.queryPrRecord(pr.repo ?? "", pr.number);
    } catch {
      // Query failed → treat as eligible (no dedup)
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
    try {
      const [org, repoName] = splitOrgRepo(pr.repo ?? "");
      const reviewData = await deps.fetchPrReviews(org, repoName, pr.number);
      if (classifyReviewState(reviewData) !== null) continue;
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

    // Skip PRs whose linked task is hitl:true or status:"blocked" — a human
    // has already been escalated to (or the task is otherwise blocked) and
    // needs to act before review tries again (CBD-2.2, PRB-2.3).
    if (isTaskBlockedForDispatch(linkedTask)) continue;

    if (deps.isBundleComplete) {
      const bundleComplete = await deps
        .isBundleComplete(pr.headRefName)
        .catch(() => true);
      if (!bundleComplete) continue;
    }

    const age = linkedTask?.createdAt ?? pr.createdAt ?? "";

    // No record → eligible
    if (!record) {
      candidates.push({
        id: candidateId(pr.repo ?? "unknown", pr.number),
        age,
        phase: "review",
        title: pr.title,
        commitSha: pr.headRefOid,
      });
      continue;
    }

    // A record with claimedBy set means another agent is currently mid-review
    // on this PR (POST /prs/claim already called) — never re-add as a
    // candidate, regardless of what the commitSha/reviewState check below
    // would otherwise say (this is NOT queried with ready=true, since a
    // missing record here must stay distinguishable from "no record yet").
    if (record.claimedBy != null) continue;

    // A PR-record with hitl:true means a human has already been escalated to
    // on this PR — applies independently of whether a task is linked
    // (PRB-2.3, PRB-3.1: patch.md Step 5a.7's second-round-disagreement
    // escalation writes hitl:true directly on the PR record when there's no
    // linked task to flag).
    if (isPrRecordBlockedForDispatch(record)) continue;

    // commitSha matches and reviewState is not pending → already reviewed at this HEAD, skip
    if (
      record.commitSha === pr.headRefOid &&
      record.reviewState !== "pending"
    ) {
      continue;
    }

    // reviewedCommitSha matches and a review is already staged → skip
    // regardless of reviewState. reviewState can read "pending" for a staged
    // record due to a drift window (a race between staging and the
    // reviewState write landing, reconciler lag, etc. — CHU-2.5, #1769) so
    // this check must not depend on reviewState being trustworthy. A staged
    // record at a DIFFERENT reviewedCommitSha (author pushed since staging)
    // stays eligible, matching review.md's stale-staged-review re-review
    // path. Deliberately reads reviewedCommitSha, NOT commitSha (RCS-1.3):
    // commitSha is shared bookkeeping also advanced by
    // PullRequestService.patch() (e.g. after a CI-fix cycle) independent of
    // whether the PR was actually re-reviewed at that new head — keying this
    // guard on commitSha let such a bump silently mask a stale, never-
    // re-reviewed staged review as still current.
    if (record.staged === true && record.reviewedCommitSha === pr.headRefOid) {
      continue;
    }

    // Different SHA or pending → eligible
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
   * When omitted, defaults to a closure reading agentAuthorAllowlistRef live,
   * so allowlist changes from config-sync take effect on the next call
   * without rebuilding deps.
   */
  isAuthorAllowed?: (login: string) => boolean;
  /**
   * Optional override for which AgentAuthorAllowlistRef instance the default
   * isAuthorAllowed closure reads from. Defaults to the process-wide
   * agentAuthorAllowlistRef singleton. Exists so tests can inject a fresh,
   * independent ref (e.g. via createAgentAuthorAllowlistRef()) to exercise
   * the true "never synced" (hasSynced() === false) state, which the
   * singleton — shared across the whole test file — cannot represent once
   * any other test has called .set() on it. Mirrors the fetchFn injection
   * pattern used elsewhere in this file (e.g. createPrRecordQuery).
   */
  authorAllowlistRef?: AgentAuthorAllowlistRef;
}): Promise<CheckReviewDeps> {
  const workspacePath = resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);
  const { ghJson: ghJsonFn } = opts;
  const ghGraphqlFn = opts.ghGraphql ?? ghGraphqlDefault;
  const authorAllowlistRef = opts.authorAllowlistRef ?? agentAuthorAllowlistRef;

  return {
    getCurrentUser,
    isSelfReviewAllowed: readAllowSelfReview(workspacePath),
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
          "number,title,author,headRefName,headRefOid,isDraft,labels,createdAt",
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
          comments(first: 1) {
            nodes {
              author { login }
              body
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
