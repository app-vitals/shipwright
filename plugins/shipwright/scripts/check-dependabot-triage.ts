#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-dependabot-triage.ts
 *
 * Pre-check for the dependabot-triage cron.
 *
 * Lifts the triage-dependabot-prs skill's own Step 3 ("Discover open
 * Dependabot PRs") into a cheap, side-effect-free precheck: for each repo,
 * list open Dependabot-authored PRs and diff them against the non-terminal
 * entries in state/dependabot-reviews.json. A PR is "untriaged" when no
 * entry in that file matches it by (pr number, repo) with a non-terminal
 * status — mirroring the skill's own dedup logic exactly.
 *
 * Non-terminal statuses: "pending", "staged", "posted".
 * Terminal statuses: "merged", "closed".
 *
 * Exit 0 + one-line prompt → at least one open Dependabot PR is untriaged
 * Exit 1 + no output       → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-dependabot-triage.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ghJson, resolveAllRepos, resolveWorkspacePath } from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DependabotPr {
  number: number;
  title: string;
  headRefName: string;
}

export interface DependabotReviewEntry {
  pr: number;
  repo: string;
  org: string;
  title: string;
  branch: string;
  status: "pending" | "staged" | "posted" | "merged" | "closed";
  firstSeen: string | null;
  lastTriagedAt: string | null;
  recommendation: string | null;
  stagedFile: string | null;
  postedAt: string | null;
  mergedAt: string | null;
}

export interface Deps {
  resolveRepos: () => string[];
  listDependabotPrs: (repo: string) => Promise<DependabotPr[]>;
  readTriageState: () => DependabotReviewEntry[];
}

// ─── Core logic ───────────────────────────────────────────────────────────────

interface RunResult {
  exit: 0 | 1;
  output: string;
}

const TERMINAL_STATUSES = new Set(["merged", "closed"]);

/**
 * True when the state file already has a non-terminal entry for this exact
 * (pr number, repo short-name) pair — matching the skill's own "not already
 * present in state with a non-terminal status" dedup check.
 */
function isAlreadyTriaged(
  pr: DependabotPr,
  repoShortName: string,
  state: DependabotReviewEntry[],
): boolean {
  return state.some(
    (entry) =>
      entry.pr === pr.number &&
      entry.repo === repoShortName &&
      !TERMINAL_STATUSES.has(entry.status),
  );
}

export async function run(deps: Deps): Promise<RunResult> {
  const state = deps.readTriageState();
  const repos = deps.resolveRepos();

  for (const repo of repos) {
    const repoShortName = repo.includes("/") ? repo.split("/", 2)[1] : repo;
    const prs = await deps.listDependabotPrs(repo);

    for (const pr of prs) {
      if (!isAlreadyTriaged(pr, repoShortName, state)) {
        return {
          exit: 0,
          output:
            "Open Dependabot PRs need triage — run /shipwright:triage-dependabot-prs",
        };
      }
    }
  }

  return { exit: 1, output: "" };
}

// ─── Production deps ──────────────────────────────────────────────────────────

export function buildProductionDeps(): Deps {
  const workspacePath = resolveWorkspacePath();

  return {
    resolveRepos: () => resolveAllRepos(workspacePath),
    listDependabotPrs: async (repo: string) => {
      try {
        return ghJson<DependabotPr[]>([
          "pr",
          "list",
          "--repo",
          repo,
          "--author",
          "app/dependabot",
          "--state",
          "open",
          "--json",
          "number,title,headRefName",
        ]);
      } catch (err) {
        process.stderr.write(
          `check-dependabot-triage: gh pr list failed for ${repo}: ${String(err)}\n`,
        );
        return [];
      }
    },
    readTriageState: () => {
      const statePath = join(workspacePath, "state", "dependabot-reviews.json");
      if (!existsSync(statePath)) return [];
      try {
        return JSON.parse(
          readFileSync(statePath, "utf-8"),
        ) as DependabotReviewEntry[];
      } catch (err) {
        process.stderr.write(
          `check-dependabot-triage: failed to read/parse ${statePath}: ${String(err)}\n`,
        );
        return [];
      }
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const deps = buildProductionDeps();
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
