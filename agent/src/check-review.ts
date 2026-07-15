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
 * age is populated from the task-store record's readyForReviewAt when
 * available, falling back to the PR's GitHub createdAt when no record exists
 * yet — a missing record must not throw.
 */

import {
  candidateId,
  createPrRecordQuery,
  getCurrentUser,
  readAllowSelfReview,
  resolveAllRepos,
  resolveWorkspacePath,
} from "./check-helpers.ts";
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
  reviewState: string;
  readyForReviewAt?: string | null;
  claimedBy?: string | null;
}

export interface CheckReviewDeps {
  getCurrentUser: () => string;
  isSelfReviewAllowed: boolean;
  listOpenPrs: (repo: string) => Promise<PrInfo[]>;
  queryPrRecord: (repo: string, prNumber: number) => Promise<PrRecord | null>;
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

  const prs = await deps.listOpenPrs("default");
  const candidates: WorkPrCandidate[] = [];

  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (pr.author.login === "app/dependabot") continue;
    if (pr.labels?.some((l) => l.name === "automated")) continue;
    if (!deps.isSelfReviewAllowed && pr.author.login === currentUser) continue;

    let record: PrRecord | null = null;
    try {
      record = await deps.queryPrRecord(pr.repo ?? "", pr.number);
    } catch {
      // Query failed → treat as eligible (no dedup)
    }

    // No record → eligible
    if (!record) {
      candidates.push({
        id: candidateId(pr.repo ?? "unknown", pr.number),
        age: pr.createdAt ?? "",
        phase: "review",
      });
      continue;
    }

    // A record with claimedBy set means another agent is currently mid-review
    // on this PR (POST /prs/claim already called) — never re-add as a
    // candidate, regardless of what the commitSha/reviewState check below
    // would otherwise say (this is NOT queried with ready=true, since a
    // missing record here must stay distinguishable from "no record yet").
    if (record.claimedBy != null) continue;

    // commitSha matches and reviewState is not pending → already reviewed at this HEAD, skip
    if (record.commitSha === pr.headRefOid && record.reviewState !== "pending") {
      continue;
    }

    // Different SHA or pending → eligible
    candidates.push({
      id: candidateId(pr.repo ?? "unknown", pr.number),
      age: record.readyForReviewAt ?? pr.createdAt ?? "",
      phase: "review",
    });
  }

  return candidates;
}

// ─── Production deps ──────────────────────────────────────────────────────────

export async function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => T;
  fetchFn?: typeof fetch;
}): Promise<CheckReviewDeps> {
  const workspacePath = resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);
  const { ghJson: ghJsonFn } = opts;

  return {
    getCurrentUser,
    isSelfReviewAllowed: readAllowSelfReview(workspacePath),
    listOpenPrs: async (_repo: string) => {
      const allPrs: PrInfo[] = [];
      for (const repo of allRepos) {
        const repoPrs = ghJsonFn<PrInfo[]>([
          "pr",
          "list",
          "--state",
          "open",
          "--repo",
          repo,
          "--json",
          "number,title,author,headRefName,headRefOid,isDraft,labels,createdAt",
        ]);
        allPrs.push(...repoPrs.map((pr) => ({ ...pr, repo })));
      }
      return allPrs;
    },
    queryPrRecord: createPrRecordQuery<PrRecord>({ fetchFn: opts.fetchFn }),
  };
}
