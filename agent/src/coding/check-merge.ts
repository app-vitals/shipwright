/**
 * agent/src/coding/check-merge.ts
 *
 * Candidate provider for the merge phase (MPD-1.3): collects the FULL SET of
 * open PRs that are approved (natively, or via a self-review APPROVE
 * comment), authored by the current user, CI-green, not DIRTY, whose linked
 * task is not blocked/hitl (fail closed on lookup failure), whose bundle is
 * complete, and that carry no claimedBy / PR-record blocked gate — tagged
 * phase: "merge".
 */

import { agentReposRef } from "@app-vitals/agent-runtime/agent-repos-ref";
import { isCiGreen } from "../../../plugins/shipwright/scripts/is-ci-green.ts";
import { canonicalLogin } from "../../../plugins/shipwright/scripts/login-identity.ts";
import type { LinkedTaskInfo } from "./check-helpers.ts";
import {
  candidateId,
  createBundleCompleteQuery,
  createPrRecordQuery,
  createTaskStatusQuery,
  formatTaskBlockedReason,
  getCurrentUser,
  hasSelfApproveReview,
  isPrRecordBlockedForDispatch,
  isTaskBlockedForDispatch,
  mapReposTolerant,
  ownerOfRepo,
  readAllowSelfReview,
  resolveAllRepos,
  resolveWorkspacePath,
  splitOrgRepo,
} from "./check-helpers.ts";
import type { WorkPrCandidate } from "./work-selector.ts";

// ─── Types ───

export interface GhPr {
  number: number;
  title?: string;
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

// A single entry from `gh api repos/{org}/{repo}/actions/runs?head_sha=...`
// (Actions:Read scope — works on every repo/token combo, unlike the GitHub
// Checks-permission-gated `statusCheckRollup` field, which fine-grained PATs
// cannot be granted on private repos). No name filter is applied when
// fetching — a workflow can be named anything (e.g. "pr-title-lint", not
// just "ci"), so every run for the head SHA is evaluated.
export interface CiRun {
  name: string;
  status: string;
  conclusion: string | null;
  createdAt?: string;
  // CIG-1.2: carried through from the Actions API so this run can be
  // deduped by CIG-1.1's shared isCiGreen() classifier — which dedups by
  // workflow_id + run_number rather than by name + createdAt.
  workflow_id: number;
  run_number: number;
}

export interface PrRecord {
  claimedBy?: string | null;
  blocked?: boolean | null;
}

export interface CheckMergeDeps {
  getCurrentUser: (owner: string) => Promise<string>;
  /**
   * Whether self-review is allowed (the `allow_self_review` policy field,
   * synced DB ref -> hardcoded default, APM-1.4). A getter, invoked
   * fresh on every getMergeCandidates() call — not evaluated once at
   * buildProductionDeps() time — so a DB-side edit takes
   * effect on the very next call without requiring an agent process restart
   * (PLR-1.1). Mirrors this file's own getScopedRepos live-read pattern.
   * Async because the DB tier is a live config-sync ref
   * (~60s staleness) rather than a synchronous file read.
   * buildProductionDeps() wires this as `() =>
   * readAllowSelfReview(workspacePath)` (check-helpers.ts).
   */
  isSelfReviewAllowed: () => Promise<boolean>;
  /**
   * Local clone list, resolved fresh on every getMergeCandidates() call so a
   * repo cloned after buildProductionDeps() is picked up without a restart.
   */
  getRepos: () => string[];
  listOpenPrs: (repo: string) => Promise<GhPr[]>;
  fetchPrReviews: (
    org: string,
    repo: string,
    pr: number,
  ) => Promise<GhReview[]>;
  // Fetches ALL workflow runs for the PR's head SHA (Actions:Read scope, no
  // GitHub Checks permission needed — works on public and private repos with
  // a fine-grained PAT, unlike the abandoned statusCheckRollup approach).
  // Deliberately unfiltered by workflow name — the shared isCiGreen()
  // classifier (CIG-1.1) dedups by workflow_id and requires every
  // workflow's latest run to be green.
  fetchCiRuns: (org: string, repo: string, headSha: string) => Promise<CiRun[]>;
  // Bundle completeness gate: returns false if any bundle-mate task on the branch
  // is still pending/in_progress/blocked. PR is skipped when it returns false.
  isBundleComplete?: (branch: string) => Promise<boolean>;
  // Task-store PR record lookup, used both to gate qualification (a record
  // with claimedBy set means another agent currently holds the claim on this
  // PR — see the explicit claimedBy check below, mirroring check-review.ts)
  // and to source the age field, though `age` below is actually sourced from
  // queryTaskStatus's linkedTask.createdAt instead — there is no ready-at field
  // used for age ordering. Queried WITHOUT `ready=true` so a `null` result
  // unambiguously means "no record exists yet" (e.g. review skipped claim()
  // for a self-authored PR under allow_self_review: false) rather than
  // conflating it with "claimed" — the task-store's `ready=true` filter maps
  // to `claimedBy IS NULL` server-side, which would collapse both cases into
  // the same empty result.
  queryPrRecord?: (repo: string, prNumber: number) => Promise<PrRecord | null>;
  // Task status lookup for the linked task (if any). Returns the task's
  // status, or null if no linked task is found (fail-open — a PR with no
  // task yet is not disqualified). Throws on lookup failure (network error,
  // non-2xx, malformed response) — merge candidacy fails CLOSED on that
  // signal, since "unknown" must not be treated as "confirmed ready". This
  // deliberately does NOT mirror queryPrRecord's fail-open posture, which
  // only affects a non-gating ordering field.
  queryTaskStatus?: (
    repo: string,
    prNumber: number,
  ) => Promise<LinkedTaskInfo | null>;
  /**
   * Returns the agent's currently configured repo scope (org/repo strings).
   * Called at the top of every getMergeCandidates() invocation — not once at
   * deps-build time — so a repo present in `repos` (the local clone list) but
   * absent from this call's result is excluded from candidates, and a later
   * scope change is picked up on the very next call.
   */
  getScopedRepos: () => string[];
}

/**
 * Collect all open PRs ready to merge as WorkPrCandidate[] tagged
 * phase: "merge".
 */
export async function getMergeCandidates(
  deps: CheckMergeDeps,
): Promise<WorkPrCandidate[]> {
  const scopedRepos = new Set(deps.getScopedRepos());
  const repos = deps.getRepos().filter((repo) => scopedRepos.has(repo));

  const candidates: WorkPrCandidate[] = [];
  if (repos.length === 0) return candidates;

  const currentUser = await deps.getCurrentUser(ownerOfRepo(repos[0]));
  const openPrs = await mapReposTolerant<GhPr & { repo: string }>(
    repos,
    "check-merge",
    async (repo) => {
      const prs = await deps.listOpenPrs(repo);
      return prs.map((pr) => ({ ...pr, repo }));
    },
  );

  for (const pr of openPrs) {
    const repo = pr.repo;
    const [org, repoName] = splitOrgRepo(repo);

    try {
      let approved = false;
      if (pr.reviewDecision === "APPROVED") {
        approved = true;
      } else if (
        (await deps.isSelfReviewAllowed()) &&
        canonicalLogin(pr.author.login) === canonicalLogin(currentUser)
      ) {
        const reviews = await deps.fetchPrReviews(org, repoName, pr.number);
        approved = hasSelfApproveReview(reviews, currentUser);
      }
      if (!approved) continue;

      if (canonicalLogin(pr.author.login) !== canonicalLogin(currentUser))
        continue;

      const ciRuns = await deps.fetchCiRuns(org, repoName, pr.headRefOid);
      if (!isCiGreen(ciRuns)) continue;

      if (pr.mergeStateStatus === "DIRTY") continue;

      // Linked task blocked / hitl — a lookup FAILURE fails CLOSED.
      let linkedTask: LinkedTaskInfo | null = null;
      if (deps.queryTaskStatus) {
        try {
          linkedTask = await deps.queryTaskStatus(repo, pr.number);
        } catch (err) {
          process.stderr.write(
            `check-merge: task-status lookup failed for PR ${pr.number}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
          continue;
        }
        if (isTaskBlockedForDispatch(linkedTask)) {
          console.log(
            `[check-merge] ${JSON.stringify({ repo, pr: pr.number, check: "task-blocked", hitl: linkedTask?.hitl, taskStatus: linkedTask?.status, taskIds: (linkedTask?.blockingTasks ?? []).map((t) => t.id), skipReason: formatTaskBlockedReason(linkedTask) })}`,
          );
          continue;
        }
      }

      if (deps.isBundleComplete) {
        const bundleComplete = await deps
          .isBundleComplete(pr.headRefName)
          .catch(() => true);
        if (!bundleComplete) continue;
      }

      if (deps.queryPrRecord) {
        let record: PrRecord | null = null;
        try {
          record = await deps.queryPrRecord(repo, pr.number);
        } catch {
          // fail open — a transient task-store error must not exclude an
          // otherwise-qualifying PR.
        }
        if (record?.claimedBy != null) continue;
        if (isPrRecordBlockedForDispatch(record)) continue;
      }

      candidates.push({
        id: candidateId(repo, pr.number),
        age: linkedTask?.createdAt ?? pr.createdAt ?? "",
        phase: "merge",
        title: pr.title,
        authorLogin: pr.author.login,
        headRefName: pr.headRefName,
        commitSha: pr.headRefOid,
      });
    } catch (err) {
      process.stderr.write(
        `check-merge: gh query failed for PR ${pr.number}: ${String(err)}\n`,
      );
    }
  }

  return candidates;
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface GhPrListJson {
  number: number;
  title?: string;
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
    workflow_id: number;
    run_number: number;
  }>;
}

export async function buildProductionDeps(opts: {
  ghJson: <T>(args: string[], owner: string) => Promise<T>;
  fetchFn?: typeof fetch;
  getScopedRepos?: () => string[];
}): Promise<CheckMergeDeps> {
  const workspacePath = resolveWorkspacePath();
  const { ghJson } = opts;

  return {
    getCurrentUser,
    isSelfReviewAllowed: () => readAllowSelfReview(workspacePath),
    getRepos: () => resolveAllRepos(workspacePath),
    getScopedRepos: opts.getScopedRepos ?? agentReposRef.get,
    listOpenPrs: async (repo: string) => {
      return await ghJson<GhPrListJson[]>(
        [
          "pr",
          "list",
          "--state",
          "open",
          "--repo",
          repo,
          "--json",
          "number,title,headRefOid,headRefName,author,reviewDecision,createdAt,mergeStateStatus",
        ],
        ownerOfRepo(repo),
      );
    },
    fetchCiRuns: async (org: string, repo: string, headSha: string) => {
      try {
        const data = await ghJson<GhWorkflowRunsJson>(
          ["api", `repos/${org}/${repo}/actions/runs?head_sha=${headSha}`],
          org,
        );
        return data.workflow_runs.map((r) => ({
          name: r.name,
          status: r.status,
          conclusion: r.conclusion,
          createdAt: r.created_at,
          workflow_id: r.workflow_id,
          run_number: r.run_number,
        }));
      } catch (err) {
        process.stderr.write(
          `check-merge: actions/runs query failed for ${org}/${repo} sha ${headSha}: ${String(err)}\n`,
        );
        return [];
      }
    },
    fetchPrReviews: async (org: string, repo: string, pr: number) => {
      const data = await ghJson<GhPrReviewsJson>(
        [
          "pr",
          "view",
          String(pr),
          "--repo",
          `${org}/${repo}`,
          "--json",
          "reviews",
        ],
        org,
      );
      return data.reviews;
    },
    isBundleComplete: createBundleCompleteQuery({ fetchFn: opts.fetchFn }),
    queryPrRecord: createPrRecordQuery<PrRecord>({ fetchFn: opts.fetchFn }),
    queryTaskStatus: createTaskStatusQuery({ fetchFn: opts.fetchFn }),
  };
}
