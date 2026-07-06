#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-dependabot-triage.ts
 *
 * Pre-check for the dependabot-triage cron.
 *
 * Mirrors the triage-dependabot-prs skill's own Step 3 ("Discover open
 * Dependabot PRs"): for each repo, list open Dependabot-authored PRs and
 * diff them against the non-terminal entries in
 * state/dependabot-reviews.json. If every open PR already has a matching
 * pending/staged/posted entry, there is nothing new to triage.
 *
 * Exit 0 + one-line prompt → at least one open Dependabot PR needs triage
 * Exit 1 + no output       → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-dependabot-triage.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ghJson,
  resolveAllRepos,
  resolveWorkspacePath,
} from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PrInfo {
  number: number;
  title: string;
  headRefName: string;
}

export type TriageStatus =
  | "pending"
  | "staged"
  | "posted"
  | "merged"
  | "closed";

export interface StateEntry {
  pr: number;
  repo: string;
  org: string;
  title: string;
  branch: string;
  status: TriageStatus;
  firstSeen: string;
  lastTriagedAt: string | null;
  recommendation: string | null;
  stagedFile: string | null;
  postedAt: string | null;
  mergedAt: string | null;
}

export interface Deps {
  resolveRepos: () => string[];
  listOpenDependabotPrs: (repo: string) => Promise<PrInfo[]>;
  readState: () => StateEntry[];
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

const NON_TERMINAL_STATUSES: readonly TriageStatus[] = [
  "pending",
  "staged",
  "posted",
];

function isNonTerminal(status: TriageStatus): boolean {
  return (NON_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * A PR is already triaged if the state has an entry for the same repo + PR
 * number with a non-terminal status. A terminal entry (merged/closed) does
 * not count — a new Dependabot PR reopening the same number after a prior
 * one was merged/closed still needs triage.
 */
function isAlreadyTriaged(
  repo: string,
  prNumber: number,
  state: StateEntry[],
): boolean {
  // repo passed in is "org/repo" (matching resolveAllRepos); state entries
  // store org and repo separately, so compare against "org/repo".
  return state.some(
    (entry) =>
      `${entry.org}/${entry.repo}` === repo &&
      entry.pr === prNumber &&
      isNonTerminal(entry.status),
  );
}

const NEEDS_TRIAGE_OUTPUT =
  "Open Dependabot PRs need triage — run /shipwright:triage-dependabot-prs";

export async function run(deps: Deps): Promise<RunResult> {
  const repos = deps.resolveRepos();
  const state = deps.readState();

  for (const repo of repos) {
    let prs: PrInfo[];
    try {
      prs = await deps.listOpenDependabotPrs(repo);
    } catch {
      // gh CLI failure — unknown state, err permissive per the Precheck
      // Contract rather than silently skipping this repo.
      return { exit: 0, output: NEEDS_TRIAGE_OUTPUT };
    }

    for (const pr of prs) {
      if (!isAlreadyTriaged(repo, pr.number, state)) {
        return { exit: 0, output: NEEDS_TRIAGE_OUTPUT };
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
    listOpenDependabotPrs: async (repo: string) => {
      return ghJson<PrInfo[]>([
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
    },
    readState: (): StateEntry[] => {
      const statePath = join(workspacePath, "state", "dependabot-reviews.json");
      if (!existsSync(statePath)) return [];
      try {
        const data = JSON.parse(readFileSync(statePath, "utf-8")) as unknown;
        return Array.isArray(data) ? (data as StateEntry[]) : [];
      } catch {
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
