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
  isCleanApproveBody,
  isMergeOnlyUpdate,
  isPrRecordBlockedForDispatch,
  isTaskBlockedForDispatch,
  mapReposTolerant,
  resolveAllRepos,
  resolveWorkspacePath,
  splitOrgRepo,
} from "./check-helpers.ts";
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

export interface CiCheckStatus {
  hasFailing: boolean;
}

export interface MergeStatusInfo {
  isDirty: boolean;
}

export interface PrRecord {
  readyForPatchAt?: string | null;
  claimedBy?: string | null;
  hitl?: boolean | null;
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

// ─── CI status (dedup stale reruns — CPC-1.1) ─────────────────────────────────

/**
 * Returns true if any workflow's latest run (highest run_number per
 * workflow_id) failed or timed out.
 *
 * The GitHub Actions API returns one entry per *run*, not per workflow — a
 * rerun of a failed workflow appears as an additional entry with the same
 * workflow_id and a higher run_number, alongside the original failed entry.
 * Evaluating every historical run at a SHA (rather than just the latest per
 * workflow) produces a false positive when a failure was later rerun and
 * passed. This mirrors how `gh pr checks` already reports only the latest
 * run per check.
 */
export function hasFailingCi(
  runs: {
    workflow_id: number;
    run_number: number;
    conclusion: string | null;
  }[],
): boolean {
  const latestByWorkflow = new Map<number, (typeof runs)[number]>();
  for (const run of runs) {
    const current = latestByWorkflow.get(run.workflow_id);
    if (!current || run.run_number > current.run_number) {
      latestByWorkflow.set(run.workflow_id, run);
    }
  }

  return [...latestByWorkflow.values()].some(
    (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
  );
}

// ─── Staleness check (mirrors patch.md Step 3b) ───────────────────────────────

/**
 * True when a review is self-authored and is a clean APPROVE verdict (see
 * check-helpers.ts's isCleanApproveBody — leading `APPROVE` or a "Verdict:
 * APPROVE" label anywhere in the body, the agent's narrative self-review
 * convention, which ends a summary with the verdict rather than leading with
 * it — CPF-2.1).
 *
 * GitHub blocks self-APPROVE via the API, so the agent's own clean approvals
 * are always posted as COMMENTED — treating those as findings would create a
 * permanent false positive. A self-review with a real (non-APPROVE) verdict
 * (e.g. "Verdict: CHANGES_REQUESTED") is not matched here, so it still counts
 * as a finding.
 */
function isSelfCleanApprove(
  review: Pick<PrReviewData["reviews"]["nodes"][number], "author" | "body">,
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
function isAddressedByAuthorReply(
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
 * Returns true if the PR has unaddressed findings:
 * - At least one COMMENTED or CHANGES_REQUESTED review posted at the current HEAD
 * - AND (has a non-empty review body OR has at least one unresolved inline thread)
 *
 * A self-authored review is excluded only when it is a clean APPROVE verdict
 * (see isSelfCleanApprove) — a self-review with a real (non-APPROVE) verdict
 * still counts as an unaddressed finding, same as any other reviewer's.
 *
 * A review's non-empty body is also excluded when there are no unresolved
 * threads AND the PR author has replied after the review (see
 * isAddressedByAuthorReply, CPF-2.3) — the only way to mark a third-party
 * review's finding as addressed, since only the review's own author can edit
 * its body.
 */
function hasUnaddressedFindings(
  data: PrReviewData,
  currentUser: string,
): boolean {
  const { headRefOid, reviews, reviewThreads, comments } = data;

  // Find qualifying reviews: state COMMENTED or CHANGES_REQUESTED at current HEAD,
  // excluding self-authored clean-APPROVE reviews.
  const qualifyingReviews = reviews.nodes.filter(
    (r) =>
      (r.state === "COMMENTED" || r.state === "CHANGES_REQUESTED") &&
      r.commit.oid === headRefOid &&
      !isSelfCleanApprove(r, currentUser),
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

    let needsPatch = false;

    // Only a real merge conflict (DIRTY) needs patch attention. A branch
    // that's merely behind main is not patch-worthy — main is only merged
    // into a branch to resolve a conflict.
    const mergeStatus = await deps.fetchMergeStatus(org, repo, pr.number);
    if (mergeStatus.isDirty) {
      needsPatch = true;
    }

    if (!needsPatch) {
      const reviewData = await deps.fetchPrReviews(org, repo, pr.number);
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
        if (ciStatus.hasFailing) {
          needsPatch = true;
        }
      }
    }

    if (!needsPatch) continue;

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

      // Skip PRs whose task-store PR record is hitl:true — a human has
      // already been escalated to at the PR-record level (independent of
      // any linked task) and needs to act before patch tries again (PRB-2.2,
      // PRB-3.1: patch.md Step 5a.7's second-round-disagreement escalation
      // writes hitl:true directly on the PR record when there's no linked
      // task to flag — via the shared isPrRecordBlockedForDispatch helper).
      // Uses the same fetched `record` above — no new network call.
      if (isPrRecordBlockedForDispatch(record)) continue;
    }

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
        return { hasFailing };
      } catch (err) {
        process.stderr.write(
          `check-patch: actions/runs query failed for PR ${pr} sha ${sha}: ${String(err)}\n`,
        );
        return { hasFailing: false };
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
