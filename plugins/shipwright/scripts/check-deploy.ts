#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-deploy.ts
 *
 * Pre-check for the deploy cron.
 *
 * Lists open PRs across configured repos via GitHub. For each, checks:
 * 1. Approval: GitHub reviewDecision == "APPROVED" OR author is current user,
 *    allow_self_review is true in agent-policy.md, and author has a review
 *    with "APPROVE" in the body.
 * 2. CI: at least one CI run with conclusion == "success" for the PR's HEAD SHA
 *
 * Exit 0 + one-line prompt → at least one PR is ready to deploy
 * Exit 1 + no output       → nothing to do
 */

import {
  getCurrentUser,
  ghJson,
  readAllowSelfReview,
  resolveAllRepos,
  resolveWorkspacePath,
} from "./check-helpers.ts";
import { createTaskStore, loadConfig } from "./create-task-store.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GhPr {
  number: number;
  headRefOid: string;
  headRefName: string;
  author: { login: string };
  reviewDecision: string | null;
}

interface GhReview {
  author: { login: string };
  body: string;
  state: string;
}

interface CiRun {
  status: string;
  conclusion: string | null;
}

interface WorkflowRun {
  name: string;
  status: string;
  createdAt?: string;
}

interface Deps {
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
  // Crash-recovery: flip pr_open tasks whose PRs have already merged to merged.
  reconcileStalePrOpenTasks?: () => Promise<void>;
  // Belt-and-suspenders: close open issues that have terminal status labels.
  cleanupStaleIssues?: () => Promise<void>;
  // Returns true when all tasks on the branch are pr_open or beyond (or no tasks exist).
  // When absent, the gate is skipped and the PR proceeds.
  isBundleComplete?: (headRefName: string) => Promise<boolean>;
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
    (r) =>
      r.author.login === userLogin &&
      // Strip leading markdown bold markers (**) before checking — the review
      // skill posts "**APPROVE**" but the body must still be treated as APPROVE.
      r.body.trimStart().replace(/^\*+/, "").startsWith("APPROVE"),
  );
}

// ─── Core logic ───────────────────────────────────────────────────────────────

interface RunResult {
  exit: 0 | 1;
  output: string;
  candidate: { pr: number; org: string; repo: string } | null;
}

export async function run(deps: Deps): Promise<RunResult> {
  // Crash-recovery: flip pr_open tasks whose PRs have already merged. Runs before
  // the deploying guard so stale tasks are cleaned up even when a deploy is in flight.
  try {
    await deps.reconcileStalePrOpenTasks?.();
  } catch (err) {
    process.stderr.write(
      `[check-deploy] pr_open reconcile failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Belt-and-suspenders: close any open issues with terminal status labels.
  try {
    await deps.cleanupStaleIssues?.();
  } catch (err) {
    process.stderr.write(
      `[check-deploy] issue cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Deploying guard: bail out if any configured repo has an active Deploy workflow run.
  // Queued runs older than 1 hour are treated as stuck/ghost and skipped.
  const now = deps.clock ? deps.clock() : new Date().toISOString();
  for (const repo of deps.repos) {
    const [org, repoName] = repo.includes("/")
      ? (repo.split("/", 2) as [string, string])
      : (["app-vitals", repo] as [string, string]);
    try {
      const activeRuns = await deps.fetchActiveDeployRuns(org, repoName);
      if (activeRuns.some((r) => isActiveRun(r, now))) {
        return { exit: 1, output: "", candidate: null };
      }
    } catch (err) {
      process.stderr.write(
        `[check-deploy] deploying guard check failed for ${repo}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      // proceed rather than block deploys
    }
  }

  const currentUser = await deps.getCurrentUser();

  for (const repo of deps.repos) {
    const [org, repoName] = repo.includes("/")
      ? (repo.split("/", 2) as [string, string])
      : (["app-vitals", repo] as [string, string]);

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

        if (deps.isBundleComplete) {
          const bundleComplete = await deps.isBundleComplete(pr.headRefName);
          if (!bundleComplete) continue;
        }

        return {
          exit: 0,
          output: "Deploy ready PRs via /shipwright:deploy",
          candidate: { pr: pr.number, org, repo: repoName },
        };
      } catch (err) {
        process.stderr.write(
          `check-deploy: gh query failed for PR ${pr.number}: ${String(err)}\n`,
        );
      }
    }
  }

  return { exit: 1, output: "", candidate: null };
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface GhPrListJson {
  number: number;
  headRefOid: string;
  headRefName: string;
  author: { login: string };
  reviewDecision: string | null;
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

async function buildProductionDeps(): Promise<Deps> {
  const workspacePath = resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);
  const clock = () => new Date().toISOString();

  return {
    getCurrentUser,
    isSelfReviewAllowed: readAllowSelfReview(workspacePath),
    repos: allRepos,
    clock,
    fetchActiveDeployRuns: async (org: string, repo: string) => {
      const [inProgress, queued] = await Promise.all([
        ghJson<GhWorkflowRunsJson>([
          "api",
          `repos/${org}/${repo}/actions/runs?status=in_progress&per_page=10`,
        ]),
        ghJson<GhWorkflowRunsJson>([
          "api",
          `repos/${org}/${repo}/actions/runs?status=queued&per_page=10`,
        ]),
      ]);
      return [...inProgress.workflow_runs, ...queued.workflow_runs]
        .filter((r) => r.name === "Deploy")
        .map((r) => ({ name: r.name, status: r.status, createdAt: r.created_at }));
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
        "number,headRefOid,headRefName,author,reviewDecision",
      ]);
    },
    fetchPrReviews: async (org: string, repo: string, pr: number) => {
      const data = await ghJson<GhPrReviewsJson>([
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
      const data = await ghJson<GhWorkflowRunsJson>([
        "api",
        `repos/${org}/${repo}/actions/runs?head_sha=${headSha}&per_page=20`,
      ]);
      return data.workflow_runs
        .filter((r) => r.name === "CI")
        .map((r) => ({ status: r.status, conclusion: r.conclusion }));
    },
    reconcileStalePrOpenTasks: async () => {
      const { config } = loadConfig();
      const store = createTaskStore(config);
      const prOpenTasks = await store.query({ status: "pr_open" });
      if (prOpenTasks.length === 0) return;

      const now = clock();
      const defaultRepo = allRepos[0] ?? "app-vitals/shipwright";

      for (const task of prOpenTasks) {
        if (!task.id) continue;
        const taskRepo = task.repo?.includes("/") ? task.repo : defaultRepo;

        if (task.pr) {
          // Happy path: task has a PR number, check it directly.
          try {
            const prData = await ghJson<{ state: string }>([
              "pr",
              "view",
              String(task.pr),
              "--repo",
              taskRepo,
              "--json",
              "state",
            ]);
            if (prData.state === "MERGED") {
              await store.update(task.id, { status: "merged", mergedAt: now });
              process.stderr.write(
                `[check-deploy] reconciled task ${task.id} (PR #${task.pr}) → merged\n`,
              );
            }
          } catch (e) {
            process.stderr.write(
              `[check-deploy] reconcile PR #${task.pr} failed — ${String(e)}\n`,
            );
          }
        } else if (task.branch) {
          // Fallback: task has no PR number — look up by head branch.
          try {
            const merged = await ghJson<Array<{ number: number }>>([
              "pr",
              "list",
              "--head",
              task.branch,
              "--state",
              "merged",
              "--repo",
              taskRepo,
              "--json",
              "number",
            ]);
            const first = merged[0];
            if (first !== undefined) {
              await store.update(task.id, {
                status: "merged",
                pr: first.number,
                mergedAt: now,
              });
              process.stderr.write(
                `[check-deploy] reconciled task ${task.id} (branch ${task.branch}, PR #${first.number}) → merged\n`,
              );
            }
          } catch (e) {
            process.stderr.write(
              `[check-deploy] reconcile branch ${task.branch} failed — ${String(e)}\n`,
            );
          }
        }
      }
    },
    cleanupStaleIssues: async () => {
      const { config } = loadConfig();
      const store = createTaskStore(config);
      const { closed, milestonesClosed, plansClosed } = await store.cleanup();
      if (closed > 0 || milestonesClosed > 0 || plansClosed > 0) {
        process.stderr.write(
          `[check-deploy] cleanup: closed ${closed} issue(s), ${plansClosed} plan(s), ${milestonesClosed} milestone(s)\n`,
        );
      }
    },
    isBundleComplete: async (headBranch: string) => {
      const { config } = loadConfig();
      const store = createTaskStore(config);
      const branchTasks = await store.query({ branch: headBranch });
      if (branchTasks.length === 0) return true;
      const incomplete = ["pending", "in_progress", "blocked"];
      return !branchTasks.some((t) => incomplete.includes(t.status ?? ""));
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const jsonMode = process.argv.includes("--json");
  const deps = await buildProductionDeps();
  const result = await run(deps);
  if (result.exit === 0) {
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(result.candidate)}\n`);
    } else {
      process.stdout.write(`${result.output}\n`);
    }
  }
  process.exit(result.exit);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(2);
  });
}
