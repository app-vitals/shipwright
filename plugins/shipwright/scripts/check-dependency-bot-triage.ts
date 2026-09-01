#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-dependency-bot-triage.ts
 *
 * Pre-check for the dependency-bot-triage cron.
 *
 * Lifts the triage-dependency-bot-prs skill's own Step 3 ("Discover open
 * Dependabot PRs") into a cheap, side-effect-free precheck: for each repo,
 * list open PRs authored by either app/dependabot or app/renovate and diff
 * them against the non-terminal entries in state/dependency-bot-reviews.json.
 * A PR is "untriaged" when no entry in that file matches it by (pr number,
 * repo) with a non-terminal status, OR when a matching non-terminal entry's
 * triagedCommitSha no longer matches the PR's live head SHA (new commits
 * pushed since the last triage pass) — mirroring the main review pipeline's
 * reviewedCommitSha-vs-headRefOid staleness check.
 *
 * Non-terminal statuses: "pending", "staged", "posted".
 * Terminal statuses: "merged", "closed".
 *
 * Exit 0 + one-line prompt → at least one open PR is untriaged or stale
 * Exit 1 + no output       → nothing to do
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-dependency-bot-triage.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ghJson,
  resolveAllRepos,
  resolveWorkspacePath,
} from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DependencyBotPr {
  number: number;
  title: string;
  headRefName: string;
  headRefOid: string;
}

export interface DependencyBotReviewEntry {
  pr: number;
  repo: string;
  org: string;
  title: string;
  branch: string;
  status: "pending" | "staged" | "posted" | "merged" | "closed";
  bot: "dependabot" | "renovate";
  triagedCommitSha: string | null;
  firstSeen: string | null;
  lastTriagedAt: string | null;
  recommendation: string | null;
  stagedFile: string | null;
  postedAt: string | null;
  mergedAt: string | null;
}

export interface Deps {
  resolveRepos: () => string[];
  listDependencyBotPrs: (repo: string) => Promise<DependencyBotPr[]>;
  readTriageState: () => DependencyBotReviewEntry[];
}

// ─── Core logic ───────────────────────────────────────────────────────────────

interface RunResult {
  exit: 0 | 1;
  output: string;
}

const TERMINAL_STATUSES = new Set(["merged", "closed"]);

/**
 * True when the state file already has a non-terminal, up-to-date entry for
 * this exact (pr number, repo short-name) pair — matching the skill's own
 * "not already present in state with a non-terminal status" dedup check.
 *
 * Terminal-status entries (merged/closed) never count as "already
 * triaged" — unchanged from prior behavior: a state entry left over from a
 * previous merge/close doesn't suppress re-flagging a PR that has since
 * reopened or been recreated with the same number.
 *
 * Beyond the non-terminal status match, the entry's triagedCommitSha must
 * also match the PR's live head SHA — a non-terminal entry recorded against
 * an older commit means the PR has moved since it was last triaged and
 * needs to be re-flagged (mirrors the main review pipeline's
 * reviewedCommitSha-vs-headRefOid staleness check).
 */
function isAlreadyTriaged(
  pr: DependencyBotPr,
  repoShortName: string,
  state: DependencyBotReviewEntry[],
): boolean {
  return state.some(
    (entry) =>
      entry.pr === pr.number &&
      entry.repo === repoShortName &&
      !TERMINAL_STATUSES.has(entry.status) &&
      entry.triagedCommitSha === pr.headRefOid,
  );
}

export async function run(deps: Deps): Promise<RunResult> {
  const state = deps.readTriageState();
  const repos = deps.resolveRepos();

  for (const repo of repos) {
    const repoShortName = repo.includes("/") ? repo.split("/", 2)[1] : repo;
    const prs = await deps.listDependencyBotPrs(repo);

    for (const pr of prs) {
      if (!isAlreadyTriaged(pr, repoShortName, state)) {
        return {
          exit: 0,
          output:
            "Open dependency-bot PRs need triage — run /shipwright:triage-dependency-bot-prs",
        };
      }
    }
  }

  return { exit: 1, output: "" };
}

// ─── Production deps ──────────────────────────────────────────────────────────

const DEPENDENCY_BOT_AUTHORS: Array<DependencyBotReviewEntry["bot"]> = [
  "dependabot",
  "renovate",
];

export function buildProductionDeps(): Deps {
  const workspacePath = resolveWorkspacePath();

  return {
    resolveRepos: () => resolveAllRepos(workspacePath),
    listDependencyBotPrs: async (repo: string) => {
      const merged = new Map<number, DependencyBotPr>();
      for (const bot of DEPENDENCY_BOT_AUTHORS) {
        try {
          const prs = ghJson<DependencyBotPr[]>([
            "pr",
            "list",
            "--repo",
            repo,
            "--author",
            `app/${bot}`,
            "--state",
            "open",
            "--json",
            "number,title,headRefName,headRefOid",
          ]);
          for (const pr of prs) {
            // Defensive dedup by PR number — a PR has exactly one author so
            // the two author-filtered queries should never overlap, but
            // guard against double-counting regardless.
            if (!merged.has(pr.number)) merged.set(pr.number, pr);
          }
        } catch (err) {
          process.stderr.write(
            `check-dependency-bot-triage: gh pr list failed for ${repo} (author app/${bot}): ${String(err)}\n`,
          );
        }
      }
      return [...merged.values()];
    },
    readTriageState: () => {
      const statePath = join(
        workspacePath,
        "state",
        "dependency-bot-reviews.json",
      );
      if (!existsSync(statePath)) return [];
      try {
        return JSON.parse(
          readFileSync(statePath, "utf-8"),
        ) as DependencyBotReviewEntry[];
      } catch (err) {
        process.stderr.write(
          `check-dependency-bot-triage: failed to read/parse ${statePath}: ${String(err)}\n`,
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
