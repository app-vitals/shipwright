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

import { getCurrentUser, readAllowSelfReview, resolveAllRepos, resolveWorkspacePath } from "./check-helpers.ts";
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function candidateId(repo: string | undefined, prNumber: number): string {
  return `${repo ?? "unknown"}#${prNumber}`;
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
        id: candidateId(pr.repo, pr.number),
        age: pr.createdAt ?? "",
        claimedBy: null,
        phase: "review",
      });
      continue;
    }

    // commitSha matches and reviewState is not pending → already reviewed at this HEAD, skip
    if (record.commitSha === pr.headRefOid && record.reviewState !== "pending") {
      continue;
    }

    // Different SHA or pending → eligible
    candidates.push({
      id: candidateId(pr.repo, pr.number),
      age: record.readyForReviewAt ?? pr.createdAt ?? "",
      claimedBy: record.claimedBy ?? null,
      phase: "review",
    });
  }

  return candidates;
}

// ─── Production deps ──────────────────────────────────────────────────────────

export async function buildProductionDeps(opts?: {
  ghJson: <T>(args: string[]) => T;
  fetchFn?: typeof fetch;
}): Promise<CheckReviewDeps> {
  const workspacePath = resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const doFetch = opts?.fetchFn ?? fetch;
  const ghJsonFn = opts?.ghJson;

  return {
    getCurrentUser,
    isSelfReviewAllowed: readAllowSelfReview(workspacePath),
    listOpenPrs: async (_repo: string) => {
      if (!ghJsonFn) return [];
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
    queryPrRecord: async (
      repo: string,
      prNumber: number,
    ): Promise<PrRecord | null> => {
      if (!taskStoreUrl || !taskStoreToken) return null;
      try {
        const baseUrl = taskStoreUrl.replace(/\/$/, "");
        const params = new URLSearchParams({
          repo,
          prNumber: String(prNumber),
        });
        const res = await doFetch(`${baseUrl}/prs?${params}`, {
          headers: {
            Authorization: `Bearer ${taskStoreToken}`,
            "Content-Type": "application/json",
          },
        });
        if (!res.ok) return null;
        const data = (await res.json()) as unknown;
        let prs: PrRecord[] = [];
        if (Array.isArray(data)) {
          prs = data as PrRecord[];
        } else if (
          data !== null &&
          typeof data === "object" &&
          Array.isArray((data as Record<string, unknown>).prs)
        ) {
          prs = (data as Record<string, unknown>).prs as PrRecord[];
        }
        return prs[0] ?? null;
      } catch {
        return null;
      }
    },
  };
}
