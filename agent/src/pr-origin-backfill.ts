/**
 * agent/src/pr-origin-backfill.ts
 *
 * POB-1.1 — one-off historical backfill for `PullRequest.origin` on merged
 * PRs that predate POM-1.1/1.2's origin-tracking cutover (deployed
 * 2026-09-16). pr-census.ts's incremental sweep only classifies PRs merged
 * on/after a repo's cursor, which is derived from already-classified rows —
 * so anything merged before origin-tracking went live is invisible to it.
 * This module holds the pure filtering/classification logic for a separate,
 * explicit one-time pass over each repo's merged-PR history within a
 * configurable day window (default 90). agent/scripts/backfill-pr-origin.ts
 * is the thin CLI entry point that wires in real `gh`/task-store I/O.
 *
 * Deliberately fetches via the PLAIN (non `--search`) `gh pr list --state
 * merged --limit <cap> --json ... --repo <repo>` form rather than
 * pr-census.ts's `--search "merged:>=<cursor>"` incremental form: GitHub's
 * Search API caps results at 1000, and even a single 90-day window exceeds
 * 1000 merged PRs for the busiest app-vitals repos. The plain REST-backed
 * listing has no such cap, at the cost of fetching (and client-side
 * filtering) more history per call than strictly needed.
 *
 * Reuses pr-census.ts's `classifyPrOrigin()`/`buildCensusEntry()` as-is
 * rather than duplicating the `GhCensusPr` -> `CensusEntry` assembly — this
 * pass's classification rules must stay identical to the live incremental
 * sweep's, and any future change to that precedence table should apply here
 * automatically.
 *
 * Idempotent by construction: `POST /prs/census`'s upsert is
 * first-write-wins (see task-store/src/routes/prs.ts's `stampOrigin()`), so
 * re-running this script after a partial or failed run cannot corrupt
 * already-classified rows — entries for PRs classified by a prior run are
 * simply re-posted no-ops.
 *
 * Per-repo failures (the `gh` call, the task-store task list, or any POST
 * chunk) are caught inside `runBackfillForRepo()` and surfaced as a
 * `RepoBackfillSummary.error` string rather than thrown, so the multi-repo
 * orchestrator (`runBackfill()`) can't have one repo's failure stop the
 * others — mirrors pr-census.ts's `runPrCensus()` continue-on-error shape,
 * but returns structured summaries (for the CLI to print) instead of only
 * logging to console.error.
 */

import {
  buildCensusEntry,
  CENSUS_CHUNK_SIZE,
  type CensusEntry,
  type CensusTaskRecord,
  type GhCensusPr,
  type PrOrigin,
} from "./pr-census.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BackfillDeps {
  /** `gh` CLI wrapper (agent/src/check-helpers.ts's `ghJson` in production) — issues the one plain `gh pr list --state merged` call per repo. */
  ghJson: <T>(args: string[]) => Promise<T>;
  /** All task-store tasks for a repo with a non-null `pr` field. */
  listTasksWithPr: (repo: string) => Promise<CensusTaskRecord[]>;
  /** POST /prs/census with one chunk (<= CENSUS_CHUNK_SIZE) of classified entries for a repo. */
  postCensusBatch: (repo: string, entries: CensusEntry[]) => Promise<void>;
}

/** Per-repo result of `runBackfillForRepo()` — printed by the CLI as a human-readable summary so a run's output is directly sanity-checkable, no separate verification tooling needed. */
export interface RepoBackfillSummary {
  repo: string;
  fetchedCount: number;
  inWindowCount: number;
  originBreakdown: Record<PrOrigin, number>;
  batchesPosted: number;
  error: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * `--limit` passed to the plain `gh pr list` call — deliberately generous:
 * even a 90-day window can exceed 1000 merged PRs for the busiest
 * app-vitals repos (the reason this module avoids the Search API's
 * 1000-result cap at all), so this just needs to comfortably exceed
 * realistic repo history rather than the specific window size.
 */
export const GH_PR_LIST_LIMIT = 5000;

// ─── Core logic ───────────────────────────────────────────────────────────────

function emptyOriginBreakdown(): Record<PrOrigin, number> {
  return { ci: 0, dependency_bot: 0, shipwright: 0, human: 0, unknown: 0 };
}

/**
 * Filter one repo's fetched merged-PR history to those merged on/after
 * `cutoffIso` (inclusive), classify each via `buildCensusEntry()` (which
 * itself delegates to `classifyPrOrigin()`), and sort the result ascending
 * by `mergedAt` — the same ordering pr-census.ts's `processRepoCensus()`
 * uses before chunking/POSTing, so batches land in a predictable order.
 *
 * A PR with a null `mergedAt` is excluded — shouldn't occur for
 * `--state merged` results in practice, but this guards against a `gh`
 * quirk rather than crashing on a string comparison against `null`.
 */
export function buildBackfillEntries(
  repo: string,
  prs: GhCensusPr[],
  cutoffIso: string,
  taskPrNumbers: Set<number>,
): CensusEntry[] {
  return prs
    .filter(
      (pr): pr is GhCensusPr & { mergedAt: string } =>
        pr.mergedAt !== null &&
        pr.mergedAt !== undefined &&
        pr.mergedAt >= cutoffIso,
    )
    .map((pr) => buildCensusEntry(repo, pr, taskPrNumbers))
    .sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? ""));
}

/**
 * Process one repo's full backfill: fetch its merged-PR history (plain,
 * non-`--search` `gh pr list`), fetch the repo's task-store tasks with a
 * non-null `pr` field, build+chunk+POST classified in-window entries, and
 * return a summary. Skips POSTing entirely when there are zero in-window
 * entries, matching pr-census.ts's "nothing new — zero POSTs" behavior.
 *
 * Never throws — a failure at any step (the `gh` call, the task list, or
 * any POST chunk) is caught and reported via `RepoBackfillSummary.error`,
 * along with whatever partial counts were already computed, isolating this
 * repo's failure from any others processed in the same `runBackfill()` call.
 */
export async function runBackfillForRepo(
  deps: BackfillDeps,
  repo: string,
  cutoffIso: string,
): Promise<RepoBackfillSummary> {
  let fetchedCount = 0;
  let inWindowCount = 0;
  const originBreakdown = emptyOriginBreakdown();
  let batchesPosted = 0;

  try {
    const prs = await deps.ghJson<GhCensusPr[]>([
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      String(GH_PR_LIST_LIMIT),
      "--json",
      "number,title,author,headRefName,createdAt,mergedAt",
      "--repo",
      repo,
    ]);
    fetchedCount = prs.length;

    const tasks = await deps.listTasksWithPr(repo);
    const taskPrNumbers = new Set(
      tasks
        .map((task) => task.pr)
        .filter((pr): pr is number => pr !== null && pr !== undefined),
    );

    const entries = buildBackfillEntries(repo, prs, cutoffIso, taskPrNumbers);
    inWindowCount = entries.length;
    for (const entry of entries) {
      originBreakdown[entry.origin] += 1;
    }

    for (let i = 0; i < entries.length; i += CENSUS_CHUNK_SIZE) {
      await deps.postCensusBatch(repo, entries.slice(i, i + CENSUS_CHUNK_SIZE));
      batchesPosted += 1;
    }

    return {
      repo,
      fetchedCount,
      inWindowCount,
      originBreakdown,
      batchesPosted,
      error: null,
    };
  } catch (err) {
    return {
      repo,
      fetchedCount,
      inWindowCount,
      originBreakdown,
      batchesPosted,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run the backfill across every given repo, in order, collecting one
 * summary per repo. A repo's failure — already caught and turned into
 * `summary.error` by `runBackfillForRepo()` — never stops the remaining
 * repos in the list, so a 403 on one out-of-scope repo can't block the
 * others from completing.
 */
export async function runBackfill(
  deps: BackfillDeps,
  repos: string[],
  cutoffIso: string,
): Promise<RepoBackfillSummary[]> {
  const summaries: RepoBackfillSummary[] = [];
  for (const repo of repos) {
    summaries.push(await runBackfillForRepo(deps, repo, cutoffIso));
  }
  return summaries;
}
