#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-review.ts
 *
 * Pre-check for the review cron.
 *
 * Queries GitHub for open PRs across the configured repo. Uses state/reviews.json
 * to deduplicate by headRefOid (lastReviewedCommit field) so already-reviewed
 * commits are not re-triggered.
 *
 * Skips own PRs when allow_self_review is false (read from policy at startup).
 * Skips terminal entries (status: "cleaned" | "merged").
 *
 * Exit 0 + one-line prompt → at least one PR needs review
 * Exit 1 + no output       → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-review.ts
 */

import type { ReviewEntry } from "./check-helpers.ts";
import {
  getCurrentUser,
  ghJson,
  parseAllowSelfReview,
  readAllowSelfReview,
  readReviews,
  resolveRepos,
  resolveWorkspacePath,
} from "./check-helpers.ts";

export { parseAllowSelfReview } from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PrInfo {
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  headRefOid: string;
}

export interface CommitInfo {
  sha: string;
  parents: Array<{ sha: string }>;
}

interface Deps {
  getCurrentUser: () => string;
  isSelfReviewAllowed: boolean;
  listOpenPrs: (repo: string) => Promise<PrInfo[]>;
  readReviews: () => ReviewEntry[];
  listPrCommits: (prNumber: number) => Promise<CommitInfo[]>;
}

// ─── Terminal statuses ────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["cleaned", "merged"]);

// ─── Merge-only detection ─────────────────────────────────────────────────────

/**
 * Returns true if all commits since lastReviewedCommit are merge commits
 * (parents.length >= 2). Returns false on any error, if the anchor commit is
 * not found, or if there are no commits after the anchor.
 */
export async function isMergeOnlyUpdate(
  prNumber: number,
  lastReviewedCommit: string,
  deps: Pick<Deps, "listPrCommits">,
): Promise<boolean> {
  try {
    const commits = await deps.listPrCommits(prNumber);
    const anchorIndex = commits.findIndex((c) => c.sha === lastReviewedCommit);
    if (anchorIndex === -1) return false;
    const subsequent = commits.slice(anchorIndex + 1);
    if (subsequent.length === 0) return false;
    return subsequent.every((c) => c.parents.length >= 2);
  } catch {
    return false;
  }
}

// ─── Core logic ───────────────────────────────────────────────────────────────

interface RunResult {
  exit: 0 | 1;
  output: string;
}

export async function run(deps: Deps): Promise<RunResult> {
  const currentUser = await deps.getCurrentUser();
  const reviews = deps.readReviews();

  // Build a lookup from PR number → review entry
  const reviewByPr = new Map<number, ReviewEntry>();
  for (const entry of reviews) {
    reviewByPr.set(entry.pr, entry);
  }

  // We don't know the repo here without a context — use a placeholder for tests.
  // In production, the deps.listOpenPrs is called with the resolved repo.
  const prs = await deps.listOpenPrs("default");

  for (const pr of prs) {
    if (!deps.isSelfReviewAllowed && pr.author.login === currentUser) continue;

    const entry = reviewByPr.get(pr.number);

    // No entry → eligible
    if (!entry) {
      return {
        exit: 0,
        output: "Review open PRs and post findings via /shipwright:review",
      };
    }

    // Terminal status → skip regardless
    if (entry.status && TERMINAL_STATUSES.has(entry.status)) continue;

    // Has entry — check if lastReviewedCommit matches current headRefOid
    if (!entry.lastReviewedCommit) {
      // Never reviewed → eligible
      return {
        exit: 0,
        output: "Review open PRs and post findings via /shipwright:review",
      };
    }

    if (entry.lastReviewedCommit !== pr.headRefOid) {
      // New commits since last review — check if they are all merge commits
      const mergeOnly = await isMergeOnlyUpdate(
        pr.number,
        entry.lastReviewedCommit,
        deps,
      );
      if (mergeOnly) continue; // skip: only merge-from-main activity, no real work
      return {
        exit: 0,
        output: "Review open PRs and post findings via /shipwright:review",
      };
    }

    // lastReviewedCommit matches → already reviewed at this HEAD, skip
  }

  return { exit: 1, output: "" };
}

// ─── Production deps ──────────────────────────────────────────────────────────

async function buildProductionDeps(): Promise<Deps> {
  const workspacePath = resolveWorkspacePath();
  const repos = resolveRepos(workspacePath);
  const orgRepo = repos[0] ?? "app-vitals/shipwright";

  return {
    getCurrentUser,
    isSelfReviewAllowed: readAllowSelfReview(workspacePath),
    listOpenPrs: async (_repo: string) => {
      return ghJson<PrInfo[]>([
        "pr",
        "list",
        "--state",
        "open",
        "--repo",
        orgRepo,
        "--json",
        "number,title,author,headRefName,headRefOid",
      ]);
    },
    readReviews: () => readReviews(workspacePath),
    listPrCommits: async (prNumber: number) => {
      return ghJson<CommitInfo[]>([
        "api",
        `repos/${orgRepo}/pulls/${prNumber}/commits`,
        "--paginate",
      ]);
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
