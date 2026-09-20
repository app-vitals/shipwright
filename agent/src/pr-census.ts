/**
 * agent/src/pr-census.ts
 *
 * POM-4.1 — repo-wide merged-PR origin census sweep. Reinstates visibility
 * into merged PRs the pipeline never claims at all (a human merging their own
 * PR without ever invoking /shipwright:review, or a dependency-bot PR merged
 * without shipwright touching it) — WITHOUT the GitHub-label approach that
 * was rejected. `reconcilePrState`'s task-row match already correctly
 * identifies shipwright's own PRs (see pr-state-reconciler.ts); the label was
 * never load-bearing for that, only for the "everything else" bucket this
 * pass now fills in.
 *
 * Consumes the already-existing POM-1.1 task-store endpoints
 * (task-store/src/routes/prs.ts's `censusRoute`/`censusCursorRoute`) rather
 * than building new ones:
 *
 *   - `GET /prs/census/cursor?repo=X` returns `{ cursor }` — the max
 *     `mergedAt` (ISO string) among rows for `repo` whose `origin` is
 *     non-null, or `null` when no such row exists yet.
 *   - `POST /prs/census` batch-upserts `{ repo, prNumber, origin, ... }`
 *     entries, at most `MAX_CENSUS_ENTRIES` (200) per call.
 *
 * Per scoped repo, each tick:
 *   1. Read the cursor. `null` (first run for this repo) means: don't walk
 *      full history — full backfill is a separate, explicitly out-of-scope
 *      concern (a cancelled task covered it) — so this tick just issues zero
 *      `gh`/`ghJson` calls and zero census entries for that repo. There is
 *      nothing to "write" to initialize the cursor: it's *derived*
 *      server-side from existing PullRequest rows with a non-null origin, so
 *      the very next tick after the first shipwright-origin PR lands will
 *      naturally see a non-null cursor.
 *   2. Otherwise, one `gh pr list --state merged --search
 *      "merged:>=<cursor>"` call (GitHub's Search API, 30 req/min — distinct
 *      from the general 5000/hr REST limit) via the injected `ghJson`.
 *   3. Fetch the repo's task-store tasks with a non-null `pr` field (one
 *      `GET /tasks?repo=X` call, filtered client-side — mirrors this file's
 *      sibling reconcilers' list-then-filter pattern rather than requiring a
 *      new task-store query param).
 *   4. Classify each merged PR via `classifyPrOrigin()`.
 *   5. POST the classified batch, chunked to `MAX_CENSUS_ENTRIES`, ascending
 *      by `mergedAt`, only when non-empty.
 *
 * A per-repo failure (cursor fetch, `gh` call, task list, or POST) is caught,
 * logged, and does NOT stop the other scoped repos in the same tick — same
 * continue-on-error shape as `pr-state-reconciler.ts`'s per-repo passes.
 *
 * Wired into agent/src/index.ts's existing PR-state-reconciler setInterval
 * tick as a fifth independent try/catch pass — NOT a new timer/process. See
 * that file's Step 5b doc comment for the full multi-pass rationale.
 *
 * Out of scope, deliberately not built here: full historical backfill (a
 * separately cancelled task), and the canary-revert-PR gap (a separate,
 * already-discussed, accepted gap tracked elsewhere).
 */

import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Mirrors task-store/prisma/schema.prisma's `PrOrigin` enum — deliberately a
 * local literal union rather than an import: agent/src has no existing
 * dependency on task-store's Prisma-generated types (pr-state-reconciler.ts
 * doesn't import them either), so this pass follows the same convention. */
export type PrOrigin =
  | "ci"
  | "dependency_bot"
  | "shipwright"
  | "human"
  | "unknown";

/** Input to the pure classifier — the fields it needs from one `gh pr list`
 * result plus a pre-resolved "does a task-store row exist for this PR"
 * boolean (the caller, `runPrCensus`, resolves that lookup so this function
 * stays pure and independently testable). */
export interface ClassifyPrOriginInput {
  authorLogin: string | null | undefined;
  headRefName: string | null | undefined;
  hasTaskRowMatch: boolean;
}

/**
 * Branch-name pattern for chart/plugin-version bump PRs opened by
 * shipwright's own automation but authored under a non-"github-actions[bot]"
 * identity in some deployments — matched independently of `authorLogin` so
 * either signal alone is enough to classify as `ci`.
 */
const CI_BRANCH_PATTERN = /^chore\/(chart|plugin-version)-v/;

/**
 * Pure origin classifier — first match wins, NO label arm (the
 * GitHub-label approach was explicitly rejected; task-row match already
 * covers shipwright's own PRs without it). Precedence:
 *
 *   shipwright -> ci -> dependency_bot -> human -> unknown
 *
 * A task-row match (a direct DB join) is checked first and takes precedence
 * over an author login or branch name that would otherwise say `ci` or
 * `dependency_bot` — a task-store row is a more trustworthy signal than
 * inferring origin from author login/branch name, which could theoretically
 * collide (e.g. a bot re-authoring a shipwright-tracked PR). `unknown` is
 * reached only when `authorLogin` is missing/null AND nothing else matched.
 */
export function classifyPrOrigin(input: ClassifyPrOriginInput): PrOrigin {
  const { authorLogin, headRefName, hasTaskRowMatch } = input;

  if (hasTaskRowMatch) return "shipwright";

  if (
    authorLogin === "github-actions[bot]" ||
    (headRefName !== null &&
      headRefName !== undefined &&
      CI_BRANCH_PATTERN.test(headRefName))
  ) {
    return "ci";
  }

  if (authorLogin === "renovate[bot]" || authorLogin === "dependabot[bot]") {
    return "dependency_bot";
  }

  if (authorLogin) return "human";

  return "unknown";
}

/** Shape of one `gh pr list --json number,title,author,headRefName,createdAt,mergedAt` result. */
export interface GhCensusPr {
  number: number;
  title: string | null;
  author: { login: string | null } | null;
  headRefName: string | null;
  createdAt: string | null;
  mergedAt: string | null;
}

/** Minimal task-store Task shape this pass needs — just enough to test for a `(repo, pr)` match. */
export interface CensusTaskRecord {
  pr?: number | null;
}

/** One entry of a `POST /prs/census` batch (mirrors task-store's `CensusEntry` schema). */
export interface CensusEntry {
  repo: string;
  prNumber: number;
  origin: PrOrigin;
  authorLogin: string | null;
  headRef: string | null;
  title: string | null;
  state: "merged";
  mergedAt: string | null;
  prCreatedAt: string | null;
}

export interface PrCensusDeps {
  /**
   * Returns the agent's currently-configured repo scope, read fresh on
   * every runPrCensus() call — mirrors this codebase's other reconciler
   * passes' getScopedRepos live-read semantics.
   */
  getScopedRepos: () => string[];
  /** `gh` CLI wrapper (agent/src/check-helpers.ts's ghJson) — issues the one `gh pr list --search` call per repo per tick. */
  ghJson: <T>(args: string[]) => Promise<T>;
  /** GET /prs/census/cursor?repo=<repo> — returns the incremental search-window cursor, or null on a repo's first run. */
  getCensusCursor: (repo: string) => Promise<string | null>;
  /** All task-store tasks for a repo with a non-null `pr` field (client-side filtered by the production implementation). */
  listTasksWithPr: (repo: string) => Promise<CensusTaskRecord[]>;
  /** POST /prs/census with one chunk (<= MAX_CENSUS_ENTRIES) of classified entries for a repo. */
  postCensusBatch: (repo: string, entries: CensusEntry[]) => Promise<void>;
  /** Injected time source for the SHIPWRIGHT_AGENT_PR_CENSUS_INTERVAL_MS throttle — never call Date.now()/new Date() directly. */
  clock: Clock;
  /** SHIPWRIGHT_AGENT_PR_CENSUS_ENABLED, resolved once at deps-construction time. When false, runPrCensus short-circuits before any GitHub calls. */
  enabled: boolean;
  /** SHIPWRIGHT_AGENT_PR_CENSUS_INTERVAL_MS, resolved once at deps-construction time. Undefined means no separate throttle beyond the shared reconciler tick interval. */
  intervalMs?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Matches task-store's own MAX_CENSUS_ENTRIES (task-store/src/pull-request-service.ts) — kept as a literal here rather than importing across the service boundary, mirroring this file's other task-store-shape mirrors above. Exported so pr-origin-backfill.ts (POB-1.1's one-off historical backfill script) can chunk its own POST /prs/census calls identically instead of re-declaring the literal. */
export const CENSUS_CHUNK_SIZE = 200;

// ─── Throttle state ───────────────────────────────────────────────────────────

/**
 * Wall-clock time (epoch ms) of this pass's last completed tick, tracked as
 * module-level state — mirrors pr-state-reconciler.ts's `prOpenTasksCursor`
 * precedent: `buildProductionDeps()` is constructed once and reused for the
 * process lifetime (`prCensusDeps ??= ...` in agent/src/index.ts), so
 * in-process state here is safe and needs no persistence layer. `null` means
 * "never run yet" (or reset for tests) — the throttle never skips the very
 * first tick regardless of `intervalMs`.
 */
let lastRunAtMs: number | null = null;

/** Test-only reset for `lastRunAtMs` above, so each test starts from a known throttle state regardless of execution order. */
export function __resetPrCensusThrottleForTests(): void {
  lastRunAtMs = null;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Classify one `gh pr list` result against the repo's task-store tasks and
 * build its `POST /prs/census` entry. Exported so pr-origin-backfill.ts
 * (POB-1.1's one-off historical backfill script) can reuse this exact
 * GhCensusPr -> CensusEntry assembly instead of duplicating it.
 */
export function buildCensusEntry(
  repo: string,
  pr: GhCensusPr,
  taskPrNumbers: Set<number>,
): CensusEntry {
  const authorLogin = pr.author?.login ?? null;
  const origin = classifyPrOrigin({
    authorLogin,
    headRefName: pr.headRefName,
    hasTaskRowMatch: taskPrNumbers.has(pr.number),
  });

  return {
    repo,
    prNumber: pr.number,
    origin,
    authorLogin,
    headRef: pr.headRefName ?? null,
    title: pr.title ?? null,
    state: "merged",
    mergedAt: pr.mergedAt ?? null,
    prCreatedAt: pr.createdAt ?? null,
  };
}

/**
 * Process one scoped repo: resolve its cursor, fetch newly-merged PRs since
 * that cursor (skipping entirely when the cursor is null — see the module
 * doc comment), classify them against the repo's task-store tasks, and POST
 * the result in <=200-entry chunks ascending by `mergedAt`. Throws on any
 * failure — the caller (`runPrCensus`) isolates this per repo.
 */
async function processRepoCensus(
  deps: PrCensusDeps,
  repo: string,
): Promise<void> {
  const cursor = await deps.getCensusCursor(repo);
  if (cursor === null) {
    // First run for this repo — initialize the search window to "now" by
    // simply not walking any history. Nothing to write back: the cursor is
    // derived server-side from existing non-null-origin rows, so the next
    // tick after this repo's first census entry lands will see a real
    // cursor on its own.
    return;
  }

  const prs = await deps.ghJson<GhCensusPr[]>([
    "pr",
    "list",
    "--state",
    "merged",
    "--search",
    `merged:>=${cursor}`,
    "--json",
    "number,title,author,headRefName,createdAt,mergedAt",
    "--repo",
    repo,
  ]);

  if (prs.length === 0) return; // nothing new — zero POSTs

  const tasks = await deps.listTasksWithPr(repo);
  const taskPrNumbers = new Set(
    tasks
      .map((task) => task.pr)
      .filter((pr): pr is number => pr !== null && pr !== undefined),
  );

  const entries = prs
    .map((pr) => buildCensusEntry(repo, pr, taskPrNumbers))
    .sort((a, b) => (a.mergedAt ?? "").localeCompare(b.mergedAt ?? ""));

  for (let i = 0; i < entries.length; i += CENSUS_CHUNK_SIZE) {
    await deps.postCensusBatch(repo, entries.slice(i, i + CENSUS_CHUNK_SIZE));
  }
}

/**
 * Run one census sweep across every scoped repo. Short-circuits before any
 * GitHub calls when `deps.enabled` is false (SHIPWRIGHT_AGENT_PR_CENSUS_ENABLED=false),
 * and skips the entire tick (including the cursor/GitHub calls) when
 * `deps.intervalMs` is set and not enough wall-clock time has elapsed since
 * the last completed tick.
 *
 * A per-repo failure is caught, logged, and does not stop the remaining
 * scoped repos — mirrors pr-state-reconciler.ts/claim-invariant-reconciler.ts's
 * per-repo continue-on-error shape.
 */
export async function runPrCensus(deps: PrCensusDeps): Promise<void> {
  if (!deps.enabled) return;

  const nowMs = deps.clock.now().getTime();
  if (
    deps.intervalMs !== undefined &&
    lastRunAtMs !== null &&
    nowMs - lastRunAtMs < deps.intervalMs
  ) {
    return; // throttled — not enough time elapsed since the last completed tick
  }

  for (const repo of deps.getScopedRepos()) {
    try {
      await processRepoCensus(deps, repo);
    } catch (err) {
      console.error(
        `[pr-census] failed to process ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  lastRunAtMs = nowMs;
}

// ─── Production deps ──────────────────────────────────────────────────────────

/** GET /tasks response shape — tolerates both the modern `{tasks:[...]}` and legacy bare-array shapes, same tolerance this codebase's other list* deps apply. */
interface TaskListResponseJson {
  tasks: CensusTaskRecord[];
}

const DEFAULT_TASK_PAGE_LIMIT = 50;

/**
 * Production deps for `runPrCensus()`. Mirrors pr-state-reconciler.ts's
 * `buildProductionDeps()` (same baseUrl/headers/doFetch task-store HTTP
 * pattern, plus an injected `ghJson`) — see that file's factory for the
 * template this one follows.
 */
export function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => Promise<T>;
  getScopedRepos: () => string[];
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  clock?: Clock;
}): PrCensusDeps {
  const { ghJson } = opts;

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };
  const doFetch = opts.fetchFn ?? fetch;

  // Read once at deps-construction time, matching this codebase's other
  // env-var-read-once-at-buildProductionDeps-time conventions (e.g.
  // pr-state-reconciler.ts's claimTtlMs on buildReviewStateProductionDeps).
  const enabledRaw = (process.env.SHIPWRIGHT_AGENT_PR_CENSUS_ENABLED ?? "")
    .trim()
    .toLowerCase();
  const enabled = enabledRaw !== "false";

  const intervalMsRaw = process.env.SHIPWRIGHT_AGENT_PR_CENSUS_INTERVAL_MS;
  const intervalMs =
    intervalMsRaw !== undefined && intervalMsRaw.trim() !== ""
      ? Number(intervalMsRaw)
      : undefined;

  return {
    getScopedRepos: opts.getScopedRepos,
    ghJson,
    clock: opts.clock ?? SystemClock(),
    enabled,
    intervalMs,
    getCensusCursor: async (repo: string) => {
      const params = new URLSearchParams({ repo });
      const res = await doFetch(`${baseUrl}/prs/census/cursor?${params}`, {
        headers,
      });
      if (!res.ok) {
        throw new Error(
          `task-store GET /prs/census/cursor?${params} → ${res.status}`,
        );
      }
      const data = (await res.json()) as { cursor: string | null };
      return data.cursor;
    },
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
        const res = await doFetch(`${baseUrl}/tasks?${params}`, { headers });
        if (!res.ok) {
          throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
        }
        const data = (await res.json()) as unknown;
        const page = Array.isArray(data)
          ? (data as CensusTaskRecord[])
          : (data as TaskListResponseJson).tasks;
        tasks.push(...page);
        if (page.length < limit) break;
        offset += limit;
      }

      return tasks.filter((task) => task.pr !== null && task.pr !== undefined);
    },
    postCensusBatch: async (repo: string, entries: CensusEntry[]) => {
      const res = await doFetch(`${baseUrl}/prs/census`, {
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
}
