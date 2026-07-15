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
 * Does NOT read state/reviews.json — all data comes from GitHub directly, and
 * the task-store /prs record is only consulted for the age (readyForPatchAt)
 * field, not for qualification.
 */

import type { CommitInfo } from "./check-helpers.ts";
import {
  candidateId,
  createPrRecordQuery,
  isCleanApproveBody,
  isMergeOnlyUpdate,
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

export interface PrReviewData {
  headRefOid: string;
  reviews: { nodes: ReviewNode[] };
  reviewThreads: { nodes: ReviewThread[] };
}

export interface CiCheckStatus {
  hasFailing: boolean;
}

export interface MergeStatusInfo {
  isDirty: boolean;
}

export interface PrRecord {
  readyForPatchAt?: string | null;
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
  getCurrentUser: () => string;
  /**
   * Task-store PR record lookup, queried with `ready=true` in production
   * (LPF-2.2) so a resolved `null` doubles as a claim gate — by patch phase a
   * record should always exist, so `null` means "currently claimed", not "no
   * record yet". Also sources the age field (readyForPatchAt) when present.
   */
  queryPrRecord?: (repo: string, prNumber: number) => Promise<PrRecord | null>;
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
 * Returns true if the PR has unaddressed findings:
 * - At least one COMMENTED or CHANGES_REQUESTED review posted at the current HEAD
 * - AND (has a non-empty review body OR has at least one unresolved inline thread)
 *
 * A self-authored review is excluded only when it is a clean APPROVE verdict
 * (see isSelfCleanApprove) — a self-review with a real (non-APPROVE) verdict
 * still counts as an unaddressed finding, same as any other reviewer's.
 */
function hasUnaddressedFindings(
  data: PrReviewData,
  currentUser: string,
): boolean {
  const { headRefOid, reviews, reviewThreads } = data;

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

  // No unresolved threads — check if any qualifying review has a non-empty body
  return qualifyingReviews.some((r) => r.body.trim().length > 0);
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
 */
async function hasMergeOnlyStaleFindings(
  prNumber: number,
  data: PrReviewData,
  deps: Pick<CheckPatchDeps, "listPrCommits">,
  repo: string | undefined,
  currentUser: string,
): Promise<boolean> {
  const { headRefOid, reviews, reviewThreads } = data;

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
    staleReviews.some((r) => r.body.trim().length > 0);

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

  const prs = await deps.listOwnOpenPrs("default");
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
        // Query failed → treated the same as a ready=true-filtered "claimed"
        // result below (createPrRecordQuery's production implementation
        // never actually throws, but a caught error here must not silently
        // add a possibly-claimed PR as a candidate).
      }
      // queryPrRecord IS configured but returned null — by patch phase a
      // task-store record should always exist (review always claims first),
      // so a ready=true-filtered null means "currently claimed". Skip.
      if (!record) continue;
    }

    candidates.push({
      id: candidateId(pr.repo, pr.number),
      age: record?.readyForPatchAt ?? pr.createdAt ?? "",
      phase: "patch",
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
      };
    };
  };
}

export async function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => T;
  ghGraphql: <T>(query: string) => T;
  getCurrentUser: () => string;
  fetchFn?: typeof fetch;
}): Promise<CheckPatchDeps> {
  const workspacePath = resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);
  const { ghJson, ghGraphql, getCurrentUser: getUser } = opts;

  return {
    listOwnOpenPrs: async (_repo: string) => {
      const user = await getUser();
      const allPrs: (GhPrListItem & { repo: string })[] = [];
      for (const repo of allRepos) {
        const items = ghJson<GhPrListItem[]>([
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
        allPrs.push(...items.map((item) => ({ ...item, repo })));
      }
      return allPrs;
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
    }
  }
}`;
      const response = ghGraphql<GraphqlResponse>(query);
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
        const data = ghJson<ApiResponse>([
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
        const data = ghJson<{ mergeStateStatus: string }>([
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
      return ghJson<CommitInfo[]>([
        "api",
        `repos/${targetRepo}/pulls/${prNumber}/commits`,
        "--paginate",
      ]);
    },
    getCurrentUser: getUser,
    queryPrRecord: createPrRecordQuery<PrRecord>({
      fetchFn: opts.fetchFn,
      ready: true,
    }),
  };
}
