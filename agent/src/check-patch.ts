/**
 * agent/src/check-patch.ts
 *
 * Native, directly-importable equivalent of
 * plugins/shipwright/scripts/check-patch.ts — candidate provider for the
 * patch phase.
 *
 * Unlike the plugin script (a boolean gate that exits 0/1 for a cron
 * precheck), this function collects and returns the FULL SET of own open PRs
 * with unaddressed review findings, failing CI, or a real merge conflict as
 * WorkPrCandidate[], tagged phase: "patch". It does not early-return after
 * the first match — the selector needs the whole candidate set to pick the
 * globally-oldest ready item.
 *
 * Does NOT read state/reviews.json — all data comes from GitHub directly. The
 * task-store /prs record is consulted for qualification — a record with
 * claimedBy set means another agent currently holds the claim on this PR and
 * it is excluded (see the explicit claimedBy check below, mirroring
 * check-review.ts). age is populated from the linked task's createdAt (via
 * queryTaskStatus, LPF-3.2), falling back to the PR's GitHub createdAt when
 * no task is linked or the lookup fails — readyForPatchAt is a necessarily-
 * recent phase-readiness stamp, not the work item's true origination age,
 * and is no longer used for age sourcing (it remains in PrRecord solely for
 * queryPrRecord's other historical callers). Unlike check-deploy.ts's
 * queryTaskStatus usage, a lookup failure here is NOT gating — it is only
 * ever consumed for its createdAt field, so a thrown error just falls back
 * to pr.createdAt rather than disqualifying the PR.
 */

import { agentReposRef } from "./agent-repos-ref.ts";
import type { CommitInfo, LinkedTaskInfo } from "./check-helpers.ts";
import {
  candidateId,
  createBundleCompleteQuery,
  createPrRecordQuery,
  createTaskStatusQuery,
  isMergeOnlyUpdate,
  isPrRecordBlockedForDispatch,
  isTaskBlockedForDispatch,
  mapReposTolerant,
  resolveAllRepos,
  resolveWorkspacePath,
  splitOrgRepo,
} from "./check-helpers.ts";
import {
  hasUnaddressedFindings,
  isAddressedByAuthorReply,
  isSelfCleanApprove,
} from "../../plugins/shipwright/scripts/compute-unaddressed-findings.ts";
import type { WorkPrCandidate } from "./work-selector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OwnPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  repo: string;
  createdAt?: string;
}

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
       * Optional (RVG-2.1): only check-review.ts's fetchPrReviews query
       * requests createdAt on thread comments (needed to detect a fresh
       * author reply posted inline on a review thread). check-patch.ts's and
       * pr-state-reconciler.ts's own queries don't request it and don't read
       * thread-comment authorship/freshness — left undefined there, which
       * is fine since neither consumer touches this field.
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

export interface PrReviewData {
  headRefOid: string;
  reviews: { nodes: ReviewNode[] };
  reviewThreads: { nodes: ReviewThread[] };
  comments: { nodes: IssueCommentNode[] };
  /**
   * Task-store ledger findings (PFL-5.3), threaded in from the PR record
   * already fetched via queryPrRecord — fetchPrReviews's GraphQL query has
   * no ledger access of its own. Optional/undefined when no record exists
   * yet or the query failed; hasUnaddressedFindings/hasMergeOnlyStaleFindings
   * both default an absent value to `[]`.
   */
  findings?: PrFinding[];
}

export interface CiCheckStatus {
  hasFailing: boolean;
  /**
   * True when this PR's latest run for some workflow is `cancelled`, with no
   * newer run for that same workflow since (PCC-1.1) — e.g. a job that hit
   * `timeout-minutes` and was reported by GitHub's API as `cancelled` rather
   * than `timed_out`. Distinct from `hasFailing` — not mutually exclusive
   * with it, since a different workflow can genuinely fail at the same time.
   * A PR qualifying solely through this field is still a valid patch
   * candidate (see getPatchCandidates below) so patch.md's rerun-first
   * branch (Step 6b.8) gets a chance to resolve it before ever escalating to
   * the CI-fix subagent.
   *
   * Optional (defaults to false when absent) so existing fixtures/deps that
   * predate PCC-1.1 and only ever set `hasFailing` keep compiling and
   * behaving exactly as before — this field is purely additive.
   */
  hasCancelled?: boolean;
  /**
   * The `id` of the qualifying cancelled run (needed for `gh run rerun
   * {run_id}` in patch.md's Step 6b.8), when `hasCancelled` is true. When
   * multiple workflows qualify, the highest `run_number` wins — arbitrary
   * but deterministic, since patch.md only needs one run id to attempt a
   * rerun. `undefined` when `hasCancelled` is false.
   */
  cancelledRunId?: number;
}

export interface MergeStatusInfo {
  isDirty: boolean;
}

/**
 * Minimal local mirror of task-store's PrFinding shape
 * (task-store/src/openapi-schemas.ts) — mirrors check-review.ts's identical
 * local mirror type (PFL-3.1) rather than importing it, since agent/src has
 * no dependency on the task-store package.
 */
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

export interface PrRecord {
  readyForPatchAt?: string | null;
  claimedBy?: string | null;
  blocked?: boolean | null;
  /**
   * Ledger findings for this PR (PFL-1.2's POST /prs/:id/findings). Already
   * present on the task-store /prs record returned by queryPrRecord below —
   * only newly declared here (PFL-5.3) so this file's local PrRecord
   * interface carries it through, mirroring check-review.ts's identical
   * field. Without this, `isResolvedByLedger` (PFL-3.2) is dead code at this
   * call site: hasUnaddressedFindings would never see any ledger entries
   * regardless of what's actually in the task store.
   */
  findings?: PrFinding[];
}

export interface CheckPatchDeps {
  listOwnOpenPrs: (repo: string) => Promise<OwnPr[]>;
  fetchPrReviews: (
    org: string,
    repo: string,
    pr: number,
  ) => Promise<PrReviewData>;
  fetchCiStatus: (
    org: string,
    repo: string,
    pr: number,
    sha: string,
  ) => Promise<CiCheckStatus>;
  fetchMergeStatus: (
    org: string,
    repo: string,
    pr: number,
  ) => Promise<MergeStatusInfo>;
  listPrCommits: (prNumber: number, repo?: string) => Promise<CommitInfo[]>;
  getCurrentUser: () => Promise<string>;
  /**
   * Task-store PR record lookup, used both to gate qualification (a record
   * with claimedBy set means another agent currently holds the claim on this
   * PR — see the explicit claimedBy check below, mirroring check-review.ts)
   * and to source the age field (readyForPatchAt) when present. Queried
   * WITHOUT `ready=true` so a `null` result unambiguously means "no record
   * exists yet" (e.g. review skipped claim() for a self-authored PR under
   * allow_self_review: false) rather than conflating it with "claimed" — the
   * task-store's `ready=true` filter maps to `claimedBy IS NULL` server-side,
   * which would collapse both cases into the same empty result.
   */
  queryPrRecord?: (repo: string, prNumber: number) => Promise<PrRecord | null>;
  /**
   * Returns the agent's currently configured repo scope (org/repo strings).
   * Called at the top of every getPatchCandidates() invocation — not once at
   * deps-build time — so a repo present in the local clone list (and
   * therefore returned by listOwnOpenPrs) but absent from this call's result
   * is excluded from candidates, and a later scope change is picked up on the
   * very next call.
   */
  getScopedRepos: () => string[];
  /**
   * True once the agent's repo scope has been successfully synced at least
   * once. When false (e.g. a persistent 404 on the agent's config bundle —
   * see index.ts's syncConfig), getPatchCandidates() fails open and does not
   * filter by scope at all, matching pre-scoping behavior — otherwise a
   * config-sync outage would silently exclude every repo from patch
   * candidacy, indistinguishable from "no work found".
   */
  hasScopeSynced: () => boolean;
  // Task status lookup for the linked task (if any), used PURELY to source
  // the age field via its createdAt — unlike check-deploy.ts, this is never
  // used as a gating/disqualifying check here. A thrown error is treated the
  // same as "no linked task" (age falls back to pr.createdAt); it must not
  // disqualify an otherwise-eligible PR from patch candidacy.
  queryTaskStatus?: (
    repo: string,
    prNumber: number,
  ) => Promise<LinkedTaskInfo | null>;
  /**
   * Bundle completeness gate: returns false if any bundle-mate task on the branch
   * is still pending/in_progress/blocked. PR is skipped when it returns false.
   */
  isBundleComplete?: (branch: string) => Promise<boolean>;
}

// ─── CI status (dedup stale reruns — CPC-1.1, PCC-1.1) ────────────────────────

/**
 * Reduces a list of Actions API run entries to the latest run per workflow
 * (highest run_number per workflow_id).
 *
 * The GitHub Actions API returns one entry per *run*, not per workflow — a
 * rerun of a failed/cancelled workflow appears as an additional entry with
 * the same workflow_id and a higher run_number, alongside the original
 * entry. Evaluating every historical run at a SHA (rather than just the
 * latest per workflow) produces a false positive when an older run
 * failed/was cancelled but a newer rerun succeeded. This mirrors how `gh pr
 * checks` already reports only the latest run per check. Shared by both
 * `hasFailingCi` and `findCancelledRuns` below so the dedup semantics never
 * drift between the two checks.
 */
function latestRunPerWorkflow<
  T extends { workflow_id: number; run_number: number },
>(runs: T[]): T[] {
  const latestByWorkflow = new Map<number, T>();
  for (const run of runs) {
    const current = latestByWorkflow.get(run.workflow_id);
    if (!current || run.run_number > current.run_number) {
      latestByWorkflow.set(run.workflow_id, run);
    }
  }
  return [...latestByWorkflow.values()];
}

/**
 * Returns true if any workflow's latest run (highest run_number per
 * workflow_id) failed or timed out.
 */
export function hasFailingCi(
  runs: {
    workflow_id: number;
    run_number: number;
    conclusion: string | null;
  }[],
): boolean {
  return latestRunPerWorkflow(runs).some(
    (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
  );
}

/**
 * Returns the qualifying run(s) — one per workflow, at most — whose LATEST
 * run (highest run_number per workflow_id) has conclusion "cancelled", with
 * no newer run for that workflow since (PCC-1.1). "Latest" already implies
 * "no newer run since" once the per-workflow dedup below has run — mirrors
 * hasFailingCi's dedup exactly (via the shared latestRunPerWorkflow helper)
 * but is evaluated independently: a run that's cancelled is not treated as
 * failure-equivalent by hasFailingCi, and a run that's failure/timed_out is
 * not counted here — the two checks are not mutually exclusive (a PR can
 * have one workflow genuinely fail and a different workflow's latest run be
 * cancelled at the same time).
 *
 * Returns the full run objects (not just a boolean) so callers can recover
 * the qualifying run's `id` for `gh run rerun {run_id}` (patch.md Step
 * 6b.8) — the boolean-only shape of hasFailingCi doesn't carry enough
 * information for that follow-up action.
 */
export function findCancelledRuns<
  T extends {
    workflow_id: number;
    run_number: number;
    conclusion: string | null;
  },
>(runs: T[]): T[] {
  return latestRunPerWorkflow(runs).filter((r) => r.conclusion === "cancelled");
}

// ─── Staleness check (mirrors patch.md Step 3b) ───────────────────────────────
//
// isSelfCleanApprove, isAddressedByAuthorReply, isSupersededBySelfReview, and
// hasUnaddressedFindings were extracted to
// plugins/shipwright/scripts/compute-unaddressed-findings.ts (PVD-1.1) —
// mirroring compute-review-verdict.ts's structure (DRO-1.1) so
// review.md's Step 9.5 can invoke the same definition mechanically via a CLI
// instead of freehand-replicating it in prose. Only hasMergeOnlyStaleFindings
// below (which is NOT part of that extraction) remains here, importing back
// the two helpers it still needs.

// ─── Merge-only stale findings ────────────────────────────────────────────────

/**
 * Returns true if the PR has unaddressed review findings at a stale commit and
 * all commits since that review are merge commits. Mirrors check-review's
 * merge-only skip: a branch updated only via merge-from-main hasn't had real
 * author activity, so findings from the pre-merge review are still valid.
 *
 * A self-authored review is excluded only when it is a clean APPROVE verdict
 * (see isSelfCleanApprove) — a self-review with a real (non-APPROVE) verdict
 * still counts as a stale finding.
 *
 * A stale review's non-empty body is also excluded when there are no
 * unresolved threads AND the PR author has replied after the review (see
 * isAddressedByAuthorReply, CPF-2.3).
 */
async function hasMergeOnlyStaleFindings(
  prNumber: number,
  data: PrReviewData,
  deps: Pick<CheckPatchDeps, "listPrCommits">,
  repo: string | undefined,
  currentUser: string,
): Promise<boolean> {
  const { headRefOid, reviews, reviewThreads, comments } = data;

  const staleReviews = reviews.nodes.filter(
    (r) =>
      (r.state === "COMMENTED" || r.state === "CHANGES_REQUESTED") &&
      r.commit.oid !== headRefOid &&
      !isSelfCleanApprove(r, currentUser),
  );

  if (staleReviews.length === 0) return false;

  const unresolvedThreads = reviewThreads.nodes.filter((t) => !t.isResolved);
  const hasFindings =
    unresolvedThreads.length > 0 ||
    staleReviews.some(
      (r) =>
        r.body.trim().length > 0 &&
        !isAddressedByAuthorReply(r, comments.nodes, currentUser),
    );

  if (!hasFindings) return false;

  // Anchor on the most recent stale review commit
  const anchorCommit = [...staleReviews].sort(
    (a, b) =>
      new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
  )[0].commit.oid;

  return isMergeOnlyUpdate(prNumber, anchorCommit, deps, repo);
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Collect all own open PRs that need patch attention (unaddressed findings,
 * failing CI, or a real merge conflict) as WorkPrCandidate[] tagged
 * phase: "patch".
 */
export async function getPatchCandidates(
  deps: CheckPatchDeps,
): Promise<WorkPrCandidate[]> {
  const currentUser = await deps.getCurrentUser();

  // Fail open when scope has never synced (e.g. a persistent config-bundle
  // 404) — filtering by an unpopulated scope would silently drop every repo
  // from candidacy, a failure mode that didn't exist before scoping.
  const scopeSynced = deps.hasScopeSynced();
  const scopedRepos = new Set(deps.getScopedRepos());
  const allOwnPrs = await deps.listOwnOpenPrs("default");
  const prs = scopeSynced
    ? allOwnPrs.filter((pr) => scopedRepos.has(pr.repo))
    : allOwnPrs;
  if (prs.length === 0) return [];

  const candidates: WorkPrCandidate[] = [];

  for (const pr of prs) {
    const [org, repo] = splitOrgRepo(pr.repo);

    // Fetch the task-store PR record FIRST (PFL-5.3), before deciding
    // needsPatch — mirrors check-review.ts's own ordering. Needed early (not
    // just for the claimedBy/blocked gate further down) so `record.findings`
    // can be threaded into `reviewData` below: without this, isResolvedByLedger
    // (PFL-3.2) is dead code in hasUnaddressedFindings/hasMergeOnlyStaleFindings
    // at this call site, regardless of what's actually in the task-store ledger.
    let record: PrRecord | null = null;
    if (deps.queryPrRecord) {
      try {
        record = await deps.queryPrRecord(pr.repo, pr.number);
      } catch {
        // Query failed → fall back to PR createdAt below (fail open — a
        // transient task-store error must not silently exclude an
        // otherwise-qualifying PR from patch candidacy).
      }
      // A record with claimedBy set means another agent currently holds the
      // claim on this PR — skip. A null record (no record was ever created,
      // e.g. review skipped claim() for a self-authored PR under
      // allow_self_review: false, or the query failed above) must NOT be
      // treated as claimed — only an explicit claimedBy gates candidacy,
      // mirroring check-review.ts.
      if (record?.claimedBy != null) continue;

      // Skip PRs whose task-store PR record is blocked:true — a human has
      // already been escalated to at the PR-record level (independent of
      // any linked task) and needs to act before patch tries again (PRB-2.2,
      // PRB-3.1: patch.md Step 5a.7's second-round-disagreement escalation
      // writes blocked:true directly on the PR record when there's no linked
      // task to flag — via the shared isPrRecordBlockedForDispatch helper).
      // Uses the same fetched `record` above — no new network call.
      if (isPrRecordBlockedForDispatch(record)) continue;
    }

    let needsPatch = false;

    // Only a real merge conflict (DIRTY) needs patch attention. A branch
    // that's merely behind main is not patch-worthy — main is only merged
    // into a branch to resolve a conflict.
    const mergeStatus = await deps.fetchMergeStatus(org, repo, pr.number);
    if (mergeStatus.isDirty) {
      needsPatch = true;
    }

    if (!needsPatch) {
      const fetchedReviewData = await deps.fetchPrReviews(org, repo, pr.number);
      // Thread the task-store ledger findings (PFL-5.3) into the reviewData
      // passed to hasUnaddressedFindings/hasMergeOnlyStaleFindings, so
      // isResolvedByLedger has real data to check against — fetchPrReviews's
      // GraphQL query has no ledger access of its own.
      const reviewData: PrReviewData = {
        ...fetchedReviewData,
        findings: record?.findings,
      };
      if (hasUnaddressedFindings(reviewData, currentUser)) {
        needsPatch = true;
      } else if (
        await hasMergeOnlyStaleFindings(
          pr.number,
          reviewData,
          deps,
          pr.repo,
          currentUser,
        )
      ) {
        // If findings exist at a stale commit but all new commits are
        // merges, the findings are still valid — only a merge-from-main
        // landed, not real author work.
        needsPatch = true;
      } else {
        const ciStatus = await deps.fetchCiStatus(
          org,
          repo,
          pr.number,
          pr.headRefOid,
        );
        // A PR qualifying solely via hasCancelled (no genuine failure) is
        // still a valid patch candidate (PCC-1.1) — patch.md's Step 6b.8
        // rerun-first branch is what actually resolves it, but candidacy
        // itself is decided here per the Candidate Selection Contract.
        if (ciStatus.hasFailing || ciStatus.hasCancelled) {
          needsPatch = true;
        }
      }
    }

    if (!needsPatch) continue;

    // Task-store task lookup, used to source the age field from the linked
    // task's createdAt (LPF-3.2) and to gate on hitl/blocked status
    // (CBD-2.2, PRB-2.2). A thrown error is treated as "no linked task" so a
    // lookup failure never disqualifies an otherwise-eligible PR from patch
    // candidacy — unlike check-deploy.ts, which fails closed, patch
    // re-dispatch is not consequential enough to block on an unreachable
    // task-store.
    let linkedTask: LinkedTaskInfo | null = null;
    if (deps.queryTaskStatus) {
      try {
        linkedTask = await deps.queryTaskStatus(pr.repo, pr.number);
      } catch {
        linkedTask = null;
      }
    }

    // Skip PRs whose linked task is hitl:true or status:"blocked" — a human
    // has already been escalated to (hitl) or the task itself is blocked,
    // and either way needs a human look before patch tries again (CBD-2.2,
    // PRB-2.2 via the shared isTaskBlockedForDispatch helper: without this
    // gate, an escalated/blocked PR whose CI stays red for the same
    // already-known reason gets re-selected as a candidate on every drain
    // tick, indefinitely, until a human clears the flag).
    if (isTaskBlockedForDispatch(linkedTask)) continue;

    if (deps.isBundleComplete) {
      const bundleComplete = await deps
        .isBundleComplete(pr.headRefName)
        .catch(() => true);
      if (!bundleComplete) continue;
    }

    candidates.push({
      id: candidateId(pr.repo, pr.number),
      age: linkedTask?.createdAt ?? pr.createdAt ?? "",
      phase: "patch",
      title: pr.title,
      commitSha: pr.headRefOid,
    });
  }

  return candidates;
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface GhPrListItem {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  createdAt?: string;
}

interface GraphqlResponse {
  data: {
    repository: {
      pullRequest: {
        headRefOid: string;
        reviews: { nodes: ReviewNode[] };
        reviewThreads: { nodes: ReviewThread[] };
        comments: { nodes: IssueCommentNode[] };
      };
    };
  };
}

export async function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => Promise<T>;
  ghGraphql: <T>(query: string) => Promise<T>;
  getCurrentUser: () => Promise<string>;
  fetchFn?: typeof fetch;
  getScopedRepos?: () => string[];
  hasScopeSynced?: () => boolean;
}): Promise<CheckPatchDeps> {
  const workspacePath = resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);
  const { ghJson, ghGraphql, getCurrentUser: getUser } = opts;

  return {
    getScopedRepos: opts.getScopedRepos ?? agentReposRef.get,
    hasScopeSynced: opts.hasScopeSynced ?? agentReposRef.hasSynced,
    listOwnOpenPrs: async (_repo: string) => {
      const user = await getUser();
      return mapReposTolerant(allRepos, "check-patch", async (repo) => {
        const items = await ghJson<GhPrListItem[]>([
          "pr",
          "list",
          "--state",
          "open",
          "--repo",
          repo,
          "--author",
          user,
          "--json",
          "number,title,headRefName,headRefOid,createdAt",
        ]);
        return items.map((item) => ({ ...item, repo }));
      });
    },
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
      const response = await ghGraphql<GraphqlResponse>(query);
      return response.data.repository.pullRequest;
    },
    fetchCiStatus: async (
      org: string,
      repo: string,
      pr: number,
      sha: string,
    ) => {
      type ApiResponse = {
        workflow_runs: {
          id: number;
          status: string;
          conclusion: string | null;
          workflow_id: number;
          run_number: number;
        }[];
      };
      try {
        const data = await ghJson<ApiResponse>([
          "api",
          `repos/${org}/${repo}/actions/runs?head_sha=${sha}`,
        ]);
        const hasFailing = hasFailingCi(data.workflow_runs);
        const cancelledRuns = findCancelledRuns(data.workflow_runs);
        // Highest run_number wins when more than one workflow's latest run
        // is cancelled — arbitrary but deterministic, since patch.md's Step
        // 6b.8 only needs one run id to attempt a rerun.
        const cancelledRunId = cancelledRuns.sort(
          (a, b) => b.run_number - a.run_number,
        )[0]?.id;
        return {
          hasFailing,
          hasCancelled: cancelledRuns.length > 0,
          ...(cancelledRunId !== undefined ? { cancelledRunId } : {}),
        };
      } catch (err) {
        process.stderr.write(
          `check-patch: actions/runs query failed for PR ${pr} sha ${sha}: ${String(err)}\n`,
        );
        return { hasFailing: false, hasCancelled: false };
      }
    },
    fetchMergeStatus: async (org: string, repo: string, pr: number) => {
      try {
        const data = await ghJson<{ mergeStateStatus: string }>([
          "pr",
          "view",
          String(pr),
          "--repo",
          `${org}/${repo}`,
          "--json",
          "mergeStateStatus",
        ]);
        return {
          isDirty: data.mergeStateStatus === "DIRTY",
        };
      } catch (err) {
        process.stderr.write(
          `check-patch: gh merge status query failed for PR ${pr}: ${String(err)}\n`,
        );
        return { isDirty: false };
      }
    },
    listPrCommits: async (prNumber: number, repo?: string) => {
      const targetRepo = repo ?? allRepos[0];
      return await ghJson<CommitInfo[]>([
        "api",
        `repos/${targetRepo}/pulls/${prNumber}/commits`,
        "--paginate",
      ]);
    },
    getCurrentUser: getUser,
    queryPrRecord: createPrRecordQuery<PrRecord>({ fetchFn: opts.fetchFn }),
    queryTaskStatus: createTaskStatusQuery({ fetchFn: opts.fetchFn }),
    isBundleComplete: createBundleCompleteQuery({ fetchFn: opts.fetchFn }),
  };
}
