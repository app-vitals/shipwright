/**
 * agent/scripts/backfill-pr-origin.ts
 * CLI entry point for POB-1.1's one-off historical PR-origin backfill.
 *
 * Backfills `PullRequest.origin` for merged PRs from before origin-tracking
 * went live (POM-1.1/1.2, deployed 2026-09-16), across a configurable
 * trailing day window (default 90). Fetches each repo's merged-PR history
 * via the plain (non `--search`) `gh pr list`, classifies each PR via
 * pr-census.ts's `classifyPrOrigin()`, and POSTs the result to the existing
 * `POST /prs/census` task-store endpoint in <=200-entry chunks. See
 * agent/src/pr-origin-backfill.ts's module doc comment for the full
 * rationale (why plain `gh pr list` instead of `--search`, idempotency,
 * per-repo error isolation).
 *
 * Required env vars:
 *   SHIPWRIGHT_TASK_STORE_URL   — base URL of the Shipwright task-store service
 *   SHIPWRIGHT_TASK_STORE_TOKEN — bearer token for the task-store API
 *
 * Also requires a working `gh auth` session (the plain `gh pr list` calls
 * run as the locally authenticated GitHub CLI user).
 *
 * Usage:
 *   SHIPWRIGHT_TASK_STORE_URL=<url> SHIPWRIGHT_TASK_STORE_TOKEN=<token> \
 *     bun agent/scripts/backfill-pr-origin.ts [--repo org/repo ...] [--days N]
 *
 * Flags:
 *   --repo <org/repo>  Repeatable. When omitted entirely, falls back to the
 *                      comma-separated SHIPWRIGHT_AGENT_PR_BACKFILL_REPOS env
 *                      var (this agent's confirmed write-scope repo list —
 *                      deliberately NOT hardcoded here: this codebase is
 *                      MIT/public, and baking a specific operator's org/repo
 *                      names into committed source is exactly what
 *                      `task check-strings` exists to catch). At least one
 *                      repo must be supplied via one of the two.
 *   --days <N>         Trailing window size in days. Default 90. The cutoff
 *                      is computed from the current date at run time, never
 *                      hardcoded.
 *   --help             Print this usage and exit 0.
 *
 * Idempotent: safe to re-run (e.g. after a partial failure) — see the
 * module doc comment in agent/src/pr-origin-backfill.ts.
 */

import { ghJson } from "../src/check-helpers.ts";
import type { CensusEntry, CensusTaskRecord } from "../src/pr-census.ts";
import { type BackfillDeps, runBackfill } from "../src/pr-origin-backfill.ts";

const DEFAULT_DAYS = 90;
const DEFAULT_TASK_PAGE_LIMIT = 50;
const REPOS_ENV_VAR = "SHIPWRIGHT_AGENT_PR_BACKFILL_REPOS";

const USAGE = `Usage: SHIPWRIGHT_TASK_STORE_URL=<url> SHIPWRIGHT_TASK_STORE_TOKEN=<token> bun backfill-pr-origin.ts [--repo org/repo ...] [--days N]

Required env vars:
  SHIPWRIGHT_TASK_STORE_URL   — base URL of the Shipwright task-store service
  SHIPWRIGHT_TASK_STORE_TOKEN — bearer token for the task-store API

Also requires a working \`gh auth\` session.

Flags:
  --repo <org/repo>  Repeatable, e.g. --repo your-org/repo-a --repo your-org/repo-b.
                     When omitted entirely, falls back to the comma-separated
                     ${REPOS_ENV_VAR} env var. At least one repo must be
                     supplied via one of the two.
  --days <N>         Trailing window size in days (default ${DEFAULT_DAYS}). Cutoff is
                     computed from the current date at run time.
  --help             Print this usage and exit 0.

Exit codes:
  0 — completed with zero per-repo errors
  1 — completed with at least one per-repo error (see the printed report)`;

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Error: required environment variable ${name} is not set\n`);
    console.error(USAGE);
    process.exit(1);
  }
  return val;
}

/** Parses SHIPWRIGHT_AGENT_PR_BACKFILL_REPOS as a comma-separated repo list, dropping blanks (e.g. from a trailing comma). */
function reposFromEnv(): string[] {
  const raw = process.env[REPOS_ENV_VAR] ?? "";
  return raw
    .split(",")
    .map((repo) => repo.trim())
    .filter((repo) => repo.length > 0);
}

function parseArgs(argv: string[]): { repos: string[]; days: number } {
  const repos: string[] = [];
  let days = DEFAULT_DAYS;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo") {
      const val = argv[++i];
      if (!val) {
        console.error("Error: --repo requires a value (org/repo)\n");
        console.error(USAGE);
        process.exit(1);
      }
      repos.push(val);
    } else if (arg === "--days") {
      const val = argv[++i];
      const parsed = val ? Number(val) : Number.NaN;
      if (!val || Number.isNaN(parsed) || parsed <= 0) {
        console.error("Error: --days requires a positive number\n");
        console.error(USAGE);
        process.exit(1);
      }
      days = parsed;
    }
  }

  const resolvedRepos = repos.length > 0 ? repos : reposFromEnv();
  if (resolvedRepos.length === 0) {
    console.error(
      `Error: no repos given — pass at least one --repo or set ${REPOS_ENV_VAR}\n`,
    );
    console.error(USAGE);
    process.exit(1);
  }

  return { repos: resolvedRepos, days };
}

const { repos, days } = parseArgs(process.argv.slice(2));

const taskStoreUrl = requireEnv("SHIPWRIGHT_TASK_STORE_URL");
const taskStoreToken = requireEnv("SHIPWRIGHT_TASK_STORE_TOKEN");

const cutoffIso = new Date(
  Date.now() - days * 24 * 60 * 60 * 1000,
).toISOString();

const baseUrl = taskStoreUrl.replace(/\/$/, "");
const headers = {
  Authorization: `Bearer ${taskStoreToken}`,
  "Content-Type": "application/json",
};

// Mirrors pr-census.ts's buildProductionDeps() task-store HTTP pattern
// (fetch-based, paginated task listing, array-body POST) — kept inline here
// rather than factored into src/ since this script is its sole caller.
const deps: BackfillDeps = {
  ghJson,
  listTasksWithPr: async (repo: string) => {
    const limit = DEFAULT_TASK_PAGE_LIMIT;
    const tasks: CensusTaskRecord[] = [];
    let offset = 0;

    for (;;) {
      const params = new URLSearchParams({
        repo,
        limit: String(limit),
        offset: String(offset),
      });
      const res = await fetch(`${baseUrl}/tasks?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      const page = Array.isArray(data)
        ? (data as CensusTaskRecord[])
        : (data as { tasks: CensusTaskRecord[] }).tasks;
      tasks.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }

    return tasks.filter((task) => task.pr !== null && task.pr !== undefined);
  },
  postCensusBatch: async (repo: string, entries: CensusEntry[]) => {
    const res = await fetch(`${baseUrl}/prs/census`, {
      method: "POST",
      headers,
      body: JSON.stringify(entries),
    });
    if (!res.ok) {
      throw new Error(
        `task-store POST /prs/census for ${repo} → ${res.status}`,
      );
    }
  },
};

console.log(
  `Backfilling PR origin for ${repos.length} repo(s), cutoff ${cutoffIso} (last ${days} days)...\n`,
);

const summaries = await runBackfill(deps, repos, cutoffIso);

let hadErrors = false;
for (const summary of summaries) {
  console.log(`── ${summary.repo} ──`);
  console.log(`  fetched:        ${summary.fetchedCount}`);
  console.log(`  in-window:      ${summary.inWindowCount}`);
  console.log(`  origin:         ${JSON.stringify(summary.originBreakdown)}`);
  console.log(`  batches posted: ${summary.batchesPosted}`);
  if (summary.error) {
    hadErrors = true;
    console.log(`  ERROR: ${summary.error}`);
  }
  console.log();
}

if (hadErrors) {
  console.error("Completed with per-repo errors — see the report above.");
  process.exit(1);
}

console.log("Backfill complete.");
