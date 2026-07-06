#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-review.ts
 *
 * Pre-check for the review cron.
 *
 * Queries GitHub for open PRs across the configured repo. Uses the PR table
 * (task-store /prs endpoint) to deduplicate by commitSha + reviewState so
 * already-reviewed commits are not re-triggered.
 *
 * Skips own PRs when allow_self_review is false (read from policy at startup).
 *
 * Exit 0 + one-line prompt → at least one PR needs review
 * Exit 1 + no output       → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-review.ts
 */

import {
  getCurrentUser,
  ghJson,
  parseAllowSelfReview,
  readAllowSelfReview,
  resolveAllRepos,
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
  repo?: string;
  isDraft: boolean;
}

interface PrRecord {
  commitSha?: string | null;
  reviewState: string;
}

interface Deps {
  getCurrentUser: () => string;
  isSelfReviewAllowed: boolean;
  listOpenPrs: (repo: string) => Promise<PrInfo[]>;
  queryPrRecord: (
    repo: string,
    prNumber: number,
  ) => Promise<PrRecord | null>;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

interface RunResult {
  exit: 0 | 1;
  output: string;
}

export async function run(deps: Deps): Promise<RunResult> {
  const currentUser = await deps.getCurrentUser();

  const prs = await deps.listOpenPrs("default");

  for (const pr of prs) {
    if (pr.isDraft) continue;
    if (pr.author.login === "app/dependabot") continue;
    if (!deps.isSelfReviewAllowed && pr.author.login === currentUser) continue;

    let record: PrRecord | null = null;
    try {
      record = await deps.queryPrRecord(pr.repo ?? "", pr.number);
    } catch {
      // Query failed → treat as eligible (no dedup)
    }

    // No record → eligible
    if (!record) {
      return {
        exit: 0,
        output: "Review open PRs and post findings via /shipwright:review",
      };
    }

    // commitSha matches and reviewState is not pending → already reviewed at this HEAD, skip
    if (record.commitSha === pr.headRefOid && record.reviewState !== "pending") {
      continue;
    }

    // Different SHA or pending → eligible
    return {
      exit: 0,
      output: "Review open PRs and post findings via /shipwright:review",
    };
  }

  return { exit: 1, output: "" };
}

// ─── Production deps ──────────────────────────────────────────────────────────

export async function buildProductionDeps(): Promise<Deps> {
  const workspacePath = resolveWorkspacePath();
  const allRepos = resolveAllRepos(workspacePath);

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();

  return {
    getCurrentUser,
    isSelfReviewAllowed: readAllowSelfReview(workspacePath),
    listOpenPrs: async (_repo: string) => {
      const allPrs: PrInfo[] = [];
      for (const repo of allRepos) {
        const repoPrs = ghJson<PrInfo[]>([
          "pr",
          "list",
          "--state",
          "open",
          "--repo",
          repo,
          "--json",
          "number,title,author,headRefName,headRefOid,isDraft",
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
        const res = await fetch(`${baseUrl}/prs?${params}`, {
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
