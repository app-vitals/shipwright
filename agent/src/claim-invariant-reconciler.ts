/**
 * agent/src/claim-invariant-reconciler.ts
 *
 * Claim-invariant self-heal pass (TCS-4.1) — scans status:"pending"
 * task-store records in the agent's repo scope for a non-null `claimedBy`
 * (the exact AGH-3.4 shape: a pending task should never carry a claim) and
 * self-heals via `POST /tasks/:id/release`.
 *
 * This is an independent safety net alongside TCS-2.1's DB constraint on the
 * same invariant — it catches anything that bypasses that constraint, e.g. a
 * raw migration or an out-of-band write. Unlike pr-state-reconciler.ts, this
 * pass makes NO GitHub calls at all — it's pure task-store HTTP — so it
 * doesn't need that file's GhPrView/ghJson machinery.
 *
 * Shape mirrors worktree-reaper.ts: an injected-deps interface, a pure
 * `reconcileClaimInvariant(deps)` core function, per-item try/catch error
 * isolation (console.error) so one bad record/repo can't abort the rest of
 * the batch, and a `buildProductionDeps()` factory wiring real task-store
 * HTTP calls at the bottom.
 *
 * Wired into agent/src/index.ts's PR-state-reconciler setInterval as a
 * fourth, independent try/catch pass on the same tick — see the Step 5b doc
 * comment in index.ts for the full rationale.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The minimal shape this pass needs from a task-store Task record. The
 * task-store's live response includes many more fields (see
 * `check-helpers.ts`'s narrower `Task` interface, which doesn't declare
 * `claimedBy` at all) — this pass only cares about `id` and `claimedBy`.
 */
export interface PendingTaskRecord {
  id: string;
  claimedBy: string | null;
}

export interface ClaimInvariantReconcilerDeps {
  /**
   * Returns the agent's currently-configured repo scope, read fresh on
   * every reconcileClaimInvariant() call — mirrors
   * WorktreeReaperDeps.getScopedRepos's own live-read semantics, so a scope
   * change is picked up on the very next pass instead of being frozen at
   * first-tick memoization time.
   */
  getScopedRepos: () => string[];
  /** Page size for listPendingTasks pagination. Defaults to DEFAULT_PAGE_LIMIT when omitted. */
  pageLimit?: number;
  /** GET /tasks?status=pending&repo=<repo>&limit=<limit>&offset=<offset> — one page. */
  listPendingTasks: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PendingTaskRecord[]>;
  /** POST /tasks/:id/release — unclaims a task back to pending. */
  releaseTask: (id: string) => Promise<void>;
}

/**
 * Per-pass record-outcome tally, mirroring pr-state-reconciler.ts's
 * `PassSummary` — evaluated/patched/errored only (no `skippedClaimed`: this
 * pass has no claim-freshness concept, it's a binary null-vs-non-null
 * check, matching reconcilePrState's own always-0 skippedClaimed for
 * schema-consistency precedent rather than declaring an unused field here).
 */
interface PassSummary {
  /** Records fetched and considered by this pass (a per-repo list-call failure does NOT add to this — the would-be count is unknown). */
  evaluated: number;
  /** Records that were successfully released. */
  patched: number;
  /** Per-record release failures PLUS per-repo list-call failures (each list failure counts as 1, representing the failed call itself). */
  errored: number;
}

function newPassSummary(): PassSummary {
  return { evaluated: 0, patched: 0, errored: 0 };
}

/** Logs one summary line for a completed pass. */
function logPassSummary(summary: PassSummary): void {
  console.log(
    `[claim-invariant-reconciler] pass summary: evaluated=${summary.evaluated} patched=${summary.patched} errored=${summary.errored}`,
  );
}

// ─── Core logic ───────────────────────────────────────────────────────────────

const DEFAULT_PAGE_LIMIT = 50;

/**
 * List every status:"pending" task record for a repo, paging through the
 * task-store's default page size until a page returns fewer than `limit`
 * records — same loop shape as pr-state-reconciler.ts's
 * `listAllOpenRecords`/`fetchPrOpenTasksBatch`.
 */
async function listAllPendingTasks(
  deps: ClaimInvariantReconcilerDeps,
  repo: string,
): Promise<PendingTaskRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const tasks: PendingTaskRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await deps.listPendingTasks(repo, limit, offset);
    tasks.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return tasks;
}

/**
 * Scan status:"pending" task-store records across every scoped repo for a
 * non-null `claimedBy` and release each violation back to unclaimed.
 *
 * A per-repo `listPendingTasks` failure is caught, logged, counted as 1
 * `errored`, and does NOT abort the other scoped repos — mirrors
 * `reconcilePrState`'s per-repo list-call error isolation. A per-task
 * `releaseTask` failure is likewise caught, logged, counted as 1 `errored`,
 * and does not abort the rest of the batch — same per-item isolation as
 * `reconcilePrState`'s per-record loop.
 */
export async function reconcileClaimInvariant(
  deps: ClaimInvariantReconcilerDeps,
): Promise<void> {
  const summary = newPassSummary();
  const scopedRepos = deps.getScopedRepos();

  for (const repo of scopedRepos) {
    let tasks: PendingTaskRecord[];
    try {
      tasks = await listAllPendingTasks(deps, repo);
    } catch (err) {
      console.error(
        `[claim-invariant-reconciler] failed to list pending tasks for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      summary.errored += 1;
      continue;
    }

    for (const task of tasks) {
      summary.evaluated += 1;
      if (!task.claimedBy) continue; // invariant holds — nothing to heal

      try {
        await deps.releaseTask(task.id);
        summary.patched += 1;
      } catch (err) {
        console.error(
          `[claim-invariant-reconciler] failed to release task ${task.id}:`,
          err instanceof Error ? err.message : String(err),
        );
        summary.errored += 1;
      }
    }
  }

  logPassSummary(summary);
}

// ─── Production deps ──────────────────────────────────────────────────────────

/** GET /tasks response shape — tolerates both the modern `{tasks:[...]}` and legacy bare-array shapes. */
interface TaskListResponseJson {
  tasks: PendingTaskRecord[];
}

/**
 * Production deps for `reconcileClaimInvariant()`. Reads
 * SHIPWRIGHT_TASK_STORE_URL/SHIPWRIGHT_TASK_STORE_TOKEN from process.env and
 * issues real task-store HTTP calls — same baseUrl/headers/doFetch pattern
 * as pr-state-reconciler.ts's `buildProductionDeps()`.
 */
export function buildProductionDeps(opts: {
  getScopedRepos: () => string[];
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  pageLimit?: number;
}): ClaimInvariantReconcilerDeps {
  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };
  const doFetch = opts.fetchFn ?? fetch;

  return {
    getScopedRepos: opts.getScopedRepos,
    ...(opts.pageLimit !== undefined ? { pageLimit: opts.pageLimit } : {}),
    listPendingTasks: async (repo: string, limit: number, offset: number) => {
      const params = new URLSearchParams({
        status: "pending",
        repo,
        limit: String(limit),
        offset: String(offset),
      });
      const res = await doFetch(`${baseUrl}/tasks?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      // Legacy bare-array tolerance, same as pr-state-reconciler.ts's
      // makeListTasksByStatus/createTaskStoreClient handling.
      if (Array.isArray(data)) return data as PendingTaskRecord[];
      return (data as TaskListResponseJson).tasks;
    },
    releaseTask: async (id: string) => {
      const res = await doFetch(`${baseUrl}/tasks/${id}/release`, {
        method: "POST",
        headers,
        body: "{}",
      });
      if (!res.ok) {
        throw new Error(`task-store POST /tasks/${id}/release → ${res.status}`);
      }
    },
  };
}
