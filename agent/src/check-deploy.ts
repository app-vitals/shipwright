/**
 * agent/src/check-deploy.ts
 *
 * Native, directly-importable equivalent of
 * plugins/shipwright/scripts/check-deploy.ts — candidate provider for the
 * deploy phase.
 *
 * Unlike the plugin script (a boolean gate that exits 0/1 for a cron
 * precheck), this function collects and returns the FULL SET of open PRs
 * that are approved (or self-approved per policy) with green CI as
 * WorkPrCandidate[], tagged phase: "deploy". It does not early-return after
 * the first match — the selector needs the whole candidate set to pick the
 * globally-oldest ready item.
 *
 * Mirrors check-deploy.ts's approval + CI-green + busy-repo-skip + bundle-
 * completeness logic. Does NOT include the crash-recovery reconciliation
 * side effects (reconcileStalePrOpenTasks / cleanupStaleIssues) as part of
 * candidate collection — those remain the plugin script's / orchestrator's
 * concern; callers that want them can still invoke them via injected deps
 * before calling this function if needed.
 */

import {
  candidateId,
  createPrRecordQuery,
  createTaskStatusQuery,
  getCurrentUser,
  isCleanApproveBody,
  readAllowSelfReview,
  resolveAllRepos,
  resolveWorkspacePath,
  splitOrgRepo,
} from "./check-helpers.ts";
import type { TaskStatus } from "./check-helpers.ts";
import type { WorkPrCandidate } from "./work-selector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GhPr {
  number: number;
  headRefOid: string;
  headRefName: string;
  author: { login: string };
  reviewDecision: string | null;
  createdAt?: string;
  mergeStateStatus: string | null;
}

export interface GhReview {
  author: { login: string };
  body: string;
  state: string;
}

export interface CiRun {
  status: string;
  conclusion: string | null;
}

export interface WorkflowRun {
  name: string;
  status: string;
  createdAt?: string;
}

export interface PrRecord {
  readyForDeployAt?: string | null;
  claimedBy?: string | null;
}

export interface CheckDeployDeps {
  getCurrentUser: () => string;
  isSelfReviewAllowed: boolean;
  repos: string[];
  listOpenPrs: (repo: string) => Promise<GhPr[]>;
  fetchCiRuns: (org: string, repo: string, headSha: string) => Promise<CiRun[]>;
  fetchPrReviews: (
    org: string,
    repo: string,
    pr: number,
  ) => Promise<GhReview[]>;
  fetchActiveDeployRuns: (org: string, repo: string) => Promise<WorkflowRun[]>;
  // Returns the current time as an ISO string. Injected for testability.
  clock?: () => string;
  // Bundle completeness gate: returns false if any bundle-mate task on the branch
  // is still pending/in_progress/blocked. PR is skipped when it returns false.
  isBundleComplete?: (branch: string) => Promise<boolean>;
  // Task-store PR record lookup, used only to source the age field.
  queryPrRecord?: (repo: string, prNumber: number) => Promise<PrRecord | null>;
  // Task status lookup for the linked task (if any). Returns the task's
  // status, or null if no linked task is found (fail-open — a PR with no
  // task yet is not disqualified). Throws on lookup failure (network error,
  // non-2xx, malformed response) — deploy candidacy fails CLOSED on that
  // signal, since "unknown" must not be treated as "confirmed ready". This
  // deliberately does NOT mirror queryPrRecord's fail-open posture, which
  // only affects a non-gating ordering field.
  queryTaskStatus?: (
    repo: string,
    prNumber: number,
  ) => Promise<{ status: TaskStatus; addedAt?: string } | null>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isCiGreen(runs: CiRun[]): boolean {
  return runs.some(
    (run) => run.status === "completed" && run.conclusion === "success",
  );
}

// Queued runs older than 1 hour are treated as stuck/ghost runs and ignored.
const STALE_QUEUED_RUN_MS = 60 * 60 * 1000;

function isActiveRun(run: WorkflowRun, now: string): boolean {
  if (run.status === "in_progress") return true;
  if (run.status === "queued") {
    if (!run.createdAt) return true; // no timestamp → conservative, treat as active
    const ageMs = new Date(now).getTime() - new Date(run.createdAt).getTime();
    return ageMs < STALE_QUEUED_RUN_MS;
  }
  return false;
}

function hasSelfApproveReview(reviews: GhReview[], userLogin: string): boolean {
  return reviews.some(
    (r) => r.author.login === userLogin && isCleanApproveBody(r.body),
  );
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Collect all open PRs ready to deploy (approved or self-approved with green
 * CI, in a non-busy repo, with a complete bundle) as WorkPrCandidate[] tagged
 * phase: "deploy".
 */
export async function getDeployCandidates(
  deps: CheckDeployDeps,
): Promise<WorkPrCandidate[]> {
  // Deploying guard: a repo with an active Deploy workflow run is skipped, but
  // that must not block PRs in other, independent repos. Queued runs older
  // than 1 hour are treated as stuck/ghost and ignored.
  const now = deps.clock ? deps.clock() : new Date().toISOString();
  const busyRepos = new Set<string>();
  for (const repo of deps.repos) {
    const [org, repoName] = splitOrgRepo(repo);
    try {
      const activeRuns = await deps.fetchActiveDeployRuns(org, repoName);
      if (activeRuns.some((r) => isActiveRun(r, now))) {
        busyRepos.add(repo);
      }
    } catch (err) {
      process.stderr.write(
        `[check-deploy] deploying guard check failed for ${repo}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      // proceed rather than block deploys
    }
  }

  const currentUser = await deps.getCurrentUser();
  const candidates: WorkPrCandidate[] = [];

  for (const repo of deps.repos) {
    if (busyRepos.has(repo)) continue;

    const [org, repoName] = splitOrgRepo(repo);

    let openPrs: GhPr[];
    try {
      openPrs = await deps.listOpenPrs(repo);
    } catch (err) {
      process.stderr.write(
        `check-deploy: gh query failed for repo ${repo}: ${String(err)}\n`,
      );
      continue;
    }

    for (const pr of openPrs) {
      try {
        let approved = false;

        if (pr.reviewDecision === "APPROVED") {
          approved = true;
        } else if (
          deps.isSelfReviewAllowed &&
          pr.author.login === currentUser
        ) {
          const reviews = await deps.fetchPrReviews(org, repoName, pr.number);
          if (hasSelfApproveReview(reviews, currentUser)) {
            approved = true;
          }
        }

        if (!approved) continue;

        // Hard authorship filter: only deploy PRs authored by the current user
        if (pr.author.login !== currentUser) continue;

        const ciRuns = await deps.fetchCiRuns(org, repoName, pr.headRefOid);
        if (!isCiGreen(ciRuns)) continue;

        // Skip DIRTY (merge-conflicted, unmergeable) PRs
        if (pr.mergeStateStatus === "DIRTY") continue;

        // Skip PRs whose linked task is blocked. A confirmed empty result (no
        // linked task) is not disqualifying, but a lookup FAILURE fails
        // CLOSED — deploy is consequential enough that "unknown" must not be
        // treated as "confirmed ready".
        let linkedTask: { status: TaskStatus; addedAt?: string } | null = null;
        if (deps.queryTaskStatus) {
          try {
            linkedTask = await deps.queryTaskStatus(repo, pr.number);
          } catch (err) {
            process.stderr.write(
              `check-deploy: task-status lookup failed for PR ${pr.number}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            continue;
          }
          if (linkedTask?.status === "blocked") continue;
        }

        if (deps.isBundleComplete) {
          const bundleComplete = await deps
            .isBundleComplete(pr.headRefName)
            .catch(() => true);
          if (!bundleComplete) continue;
        }

        let record: PrRecord | null = null;
        if (deps.queryPrRecord) {
          try {
            record = await deps.queryPrRecord(repo, pr.number);
          } catch {
            // Query failed → fall back to PR createdAt below.
          }
        }

        candidates.push({
          id: candidateId(repo, pr.number),
          age: linkedTask?.addedAt ?? pr.createdAt ?? "",
          claimedBy: record?.claimedBy ?? null,
          phase: "deploy",
        });
      } catch (err) {
        process.stderr.write(
          `check-deploy: gh query failed for PR ${pr.number}: ${String(err)}\n`,
        );
      }
    }
  }

  return candidates;
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface GhPrListJson {
  number: number;
  headRefOid: string;
  headRefName: string;
  author: { login: string };
  reviewDecision: string | null;
  createdAt?: string;
  mergeStateStatus: string | null;
}

interface GhPrReviewsJson {
  reviews: Array<{
    author: { login: string };
    body: string;
    state: string;
  }>;
}

interface GhWorkflowRunsJson {
  workflow_runs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    created_at: string;
  }>;
}

export async function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => T;
  fetchFn?: typeof fetch;
}): Promise<CheckDeployDeps> {
  const workspacePath = resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);
  const clock = () => new Date().toISOString();
  const { ghJson } = opts;

  return {
    getCurrentUser,
    isSelfReviewAllowed: readAllowSelfReview(workspacePath),
    repos: allRepos,
    clock,
    fetchActiveDeployRuns: async (org: string, repo: string) => {
      const inProgress = ghJson<GhWorkflowRunsJson>([
        "api",
        `repos/${org}/${repo}/actions/runs?status=in_progress&per_page=10`,
      ]);
      const queued = ghJson<GhWorkflowRunsJson>([
        "api",
        `repos/${org}/${repo}/actions/runs?status=queued&per_page=10`,
      ]);
      return [...inProgress.workflow_runs, ...queued.workflow_runs]
        .filter((r) => r.name === "Deploy")
        .map((r) => ({
          name: r.name,
          status: r.status,
          createdAt: r.created_at,
        }));
    },
    listOpenPrs: async (repo: string) => {
      return ghJson<GhPrListJson[]>([
        "pr",
        "list",
        "--state",
        "open",
        "--repo",
        repo,
        "--json",
        "number,headRefOid,headRefName,author,reviewDecision,createdAt,mergeStateStatus",
      ]);
    },
    fetchPrReviews: async (org: string, repo: string, pr: number) => {
      const data = ghJson<GhPrReviewsJson>([
        "pr",
        "view",
        String(pr),
        "--repo",
        `${org}/${repo}`,
        "--json",
        "reviews",
      ]);
      return data.reviews;
    },
    fetchCiRuns: async (org: string, repo: string, headSha: string) => {
      const data = ghJson<GhWorkflowRunsJson>([
        "api",
        `repos/${org}/${repo}/actions/runs?head_sha=${headSha}&per_page=20`,
      ]);
      return data.workflow_runs
        .filter((r) => r.name === "CI")
        .map((r) => ({ status: r.status, conclusion: r.conclusion }));
    },
    isBundleComplete: undefined,
    queryPrRecord: createPrRecordQuery<PrRecord>({ fetchFn: opts.fetchFn }),
    queryTaskStatus: createTaskStatusQuery({ fetchFn: opts.fetchFn }),
  };
}
