#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-patch.ts
 *
 * Pre-check for the patch cron.
 *
 * Scans own open PRs for unaddressed review findings, failing CI, or branches
 * behind/dirty main.
 *
 * Does NOT read state/reviews.json — all data comes from GitHub directly.
 *
 * Exit 0 + one-line prompt → at least one PR needs patch attention
 * Exit 1 + no output       → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-patch.ts
 */

import {
  getCurrentUser,
  ghGraphql,
  ghJson,
  ghRun,
  resolveRepos,
  resolveWorkspacePath,
} from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OwnPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
  repo: string;
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

interface CiCheckStatus {
  hasFailing: boolean;
}

interface MergeStatusInfo {
  isBehind: boolean;
  isDirty: boolean;
}

export interface Deps {
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
  ) => Promise<CiCheckStatus>;
  fetchMergeStatus: (
    org: string,
    repo: string,
    pr: number,
  ) => Promise<MergeStatusInfo>;
  updateBranch: (org: string, repo: string, pr: number) => Promise<void>;
}

// ─── Staleness check (mirrors patch.md Step 3b) ───────────────────────────────

/**
 * Returns true if the PR has unaddressed findings:
 * - At least one COMMENTED or CHANGES_REQUESTED review posted at the current HEAD
 * - AND (has a non-empty review body OR has at least one unresolved inline thread)
 */
function hasUnaddressedFindings(data: PrReviewData): boolean {
  const { headRefOid, reviews, reviewThreads } = data;

  // Find qualifying reviews: state COMMENTED or CHANGES_REQUESTED at current HEAD
  const qualifyingReviews = reviews.nodes.filter(
    (r) =>
      (r.state === "COMMENTED" || r.state === "CHANGES_REQUESTED") &&
      r.commit.oid === headRefOid,
  );

  if (qualifyingReviews.length === 0) return false;

  // Check for unresolved threads
  const unresolvedThreads = reviewThreads.nodes.filter((t) => !t.isResolved);

  if (unresolvedThreads.length > 0) return true;

  // No unresolved threads — check if any qualifying review has a non-empty body
  return qualifyingReviews.some((r) => r.body.trim().length > 0);
}

// ─── Core logic ───────────────────────────────────────────────────────────────

interface RunResult {
  exit: 0 | 1;
  output: string;
}

export async function run(deps: Deps): Promise<RunResult> {
  const prs = await deps.listOwnOpenPrs("default");
  if (prs.length === 0) return { exit: 1, output: "" };

  for (const pr of prs) {
    const [org, repo] = pr.repo.includes("/")
      ? pr.repo.split("/", 2)
      : ["app-vitals", pr.repo];

    // Update stale branches before checking other conditions. BEHIND-only PRs
    // get synced here and exit 1 — no Claude session needed.
    const mergeStatus = await deps.fetchMergeStatus(org, repo, pr.number);
    let updateFailed = false;
    if (mergeStatus.isBehind) {
      try {
        await deps.updateBranch(org, repo, pr.number);
      } catch (err) {
        process.stderr.write(
          `check-patch: update-branch failed for PR ${pr.number}: ${String(err)}\n`,
        );
        updateFailed = true;
      }
    }

    if (mergeStatus.isDirty || updateFailed) {
      return {
        exit: 0,
        output:
          "Fix BEHIND/conflict state on own open PRs via /shipwright:patch",
      };
    }

    const reviewData = await deps.fetchPrReviews(org, repo, pr.number);
    if (hasUnaddressedFindings(reviewData)) {
      return {
        exit: 0,
        output:
          "Fix unaddressed review findings on own open PRs via /shipwright:patch",
      };
    }

    const ciStatus = await deps.fetchCiStatus(org, repo, pr.number);
    if (ciStatus.hasFailing) {
      return {
        exit: 0,
        output: "Fix failing CI on own open PRs via /shipwright:patch",
      };
    }
  }

  return { exit: 1, output: "" };
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface GhPrListItem {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
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

export async function buildProductionDeps(): Promise<Deps> {
  const workspacePath = resolveWorkspacePath();
  const repos = resolveRepos(workspacePath);
  const orgRepo = repos[0] ?? "app-vitals/shipwright";

  return {
    listOwnOpenPrs: async (_repo: string) => {
      const user = await getCurrentUser();
      const items = ghJson<GhPrListItem[]>([
        "pr",
        "list",
        "--state",
        "open",
        "--repo",
        orgRepo,
        "--author",
        user,
        "--json",
        "number,title,headRefName,headRefOid",
      ]);
      return items.map((item) => ({ ...item, repo: orgRepo }));
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
    fetchCiStatus: async (_org: string, _repo: string, pr: number) => {
      type CheckItem = { state: string; conclusion: string | null };
      try {
        const checks = ghJson<CheckItem[]>([
          "pr",
          "checks",
          String(pr),
          "--repo",
          orgRepo,
          "--json",
          "name,state,conclusion",
        ]);
        const hasFailing = checks.some(
          (c) =>
            c.state === "FAILURE" ||
            c.conclusion === "failure" ||
            c.conclusion === "timed_out",
        );
        return { hasFailing };
      } catch (err) {
        process.stderr.write(
          `check-patch: gh checks query failed for PR ${pr}: ${String(err)}\n`,
        );
        return { hasFailing: false };
      }
    },
    fetchMergeStatus: async (_org: string, _repo: string, pr: number) => {
      try {
        const data = ghJson<{ mergeStateStatus: string }>([
          "pr",
          "view",
          String(pr),
          "--repo",
          orgRepo,
          "--json",
          "mergeStateStatus",
        ]);
        return {
          isBehind: data.mergeStateStatus === "BEHIND",
          isDirty: data.mergeStateStatus === "DIRTY",
        };
      } catch (err) {
        process.stderr.write(
          `check-patch: gh merge status query failed for PR ${pr}: ${String(err)}\n`,
        );
        return { isBehind: false, isDirty: false };
      }
    },
    updateBranch: async (_org: string, _repo: string, pr: number) => {
      ghRun(["pr", "update-branch", String(pr), "--repo", orgRepo]);
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const deps = await buildProductionDeps();
  const result = await run(deps);
  if (result.exit === 0) {
    process.stdout.write(`${result.output}\n`);
  }
  process.exit(result.exit);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(2);
  });
}
