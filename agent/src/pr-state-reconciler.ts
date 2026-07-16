/**
 * agent/src/pr-state-reconciler.ts
 *
 * PR state reconciler — self-heals task-store PullRequest records left
 * state:"open" after an untracked merge/close (a session crashed or hung
 * AFTER the real work happened on GitHub but BEFORE the completion PATCH
 * ran). Mirrors task-store's own StaleClaimReaper pattern (batch-scan +
 * per-item resolve + defensive continue-on-error) — see
 * task-store/src/stale-claim-reaper.ts — but lives in agent/src since it
 * needs GitHub read access, which agent/src/check-helpers.ts already
 * provides (ghJson, resolveAllRepos, splitOrgRepo, createTaskStoreClient).
 *
 * Unlike the claim reaper (crash backstop for the *claim* fields only), this
 * reconciles the *business state* (state/mergedAt) against GitHub reality,
 * closing the gap CHU-1.x left: check-deploy.ts/check-review.ts/check-patch.ts
 * only ever scan GitHub's *open* PR list, so a merged/closed PR silently
 * drops out of view before its task-store record gets corrected.
 *
 * This is a pure background interval (agent/src/index.ts), not a Claude
 * session and not folded into the loop-orchestrator's per-tick candidate
 * collection — purely mechanical field sync, no judgment required, and
 * running it every tick would multiply gh API calls unnecessarily.
 *
 * Usage: register via setInterval(() => void reconciler.reconcile(), <ms>)
 * with a 30-60 minute interval — see agent/src/index.ts.
 */

import { createPrRecordQuery, resolveAllRepos, resolveWorkspacePath } from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape of a task-store PullRequest record this reconciler needs. */
export interface PrStateRecord {
  id: string;
  repo: string;
  prNumber: number;
  state: string;
  /** Present when this record was fetched for the taskId-backfill lookup; absent/undefined elsewhere. */
  taskId?: string | null;
}

/** Result of `gh pr view <n> --json state,mergedAt`. */
export interface GhPrView {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
}

/** Minimal shape of a task-store Task this reconciler needs for the pr_open pass (DSR-1.1). */
export interface PrOpenTaskRecord {
  id: string;
  repo?: string;
  pr?: number;
  branch?: string;
}

export interface PrStateReconcilerDeps {
  repos: string[];
  /** Page size for listing state:"open" records; defaults to the task-store's own default (50). */
  pageLimit?: number;
  /** List one page of state:"open" PR records for a repo. */
  listOpenPrRecords: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrStateRecord[]>;
  /** PATCH a task-store PR record's fields. */
  patchPrRecord: (id: string, fields: Record<string, unknown>) => Promise<void>;
  /** Fetch live GitHub state for a single PR. Throws on lookup failure. */
  ghViewPr: (repo: string, prNumber: number) => Promise<GhPrView>;
  /** List every task-store Task with status "pr_open" (DSR-1.1). */
  listPrOpenTasks: () => Promise<PrOpenTaskRecord[]>;
  /** PATCH a task-store Task's fields (DSR-1.1). */
  updateTaskStatus: (id: string, fields: Record<string, unknown>) => Promise<void>;
  /** Branch-fallback PR lookup (`gh pr list --head <branch> --state merged`) for tasks with no `pr` number set (DSR-1.1). */
  ghListMergedPrsForBranch: (
    repo: string,
    branch: string,
  ) => Promise<Array<{ number: number }>>;
  /** Look up a task-store PullRequest record by repo+prNumber, for the taskId backfill (DSR-1.1). */
  findPrRecordByRepoAndPrNumber: (
    repo: string,
    prNumber: number,
  ) => Promise<PrStateRecord | null>;
  /** Injected clock — mergedAt fallback when GitHub doesn't report one (DSR-1.1). */
  now: () => string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_LIMIT = 50;

/** Map GitHub's uppercase PR state to the task-store's lowercase PrState enum. */
function mapGhStateToPrState(state: GhPrView["state"]): "merged" | "closed" | null {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return null; // still OPEN on GitHub — nothing to reconcile
}

/**
 * List every state:"open" PR record for a repo, paging through the
 * task-store's default 50-record page until a page returns fewer than
 * `limit` records.
 */
async function listAllOpenRecords(
  deps: PrStateReconcilerDeps,
  repo: string,
): Promise<PrStateRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const records: PrStateRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await deps.listOpenPrRecords(repo, limit, offset);
    records.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return records;
}

/**
 * Reconcile a single PR record against live GitHub state. Issues a PATCH
 * only when GitHub reports MERGED or CLOSED while the record still says
 * "open" — records still OPEN on GitHub are left completely untouched.
 */
async function reconcileRecord(
  deps: PrStateReconcilerDeps,
  record: PrStateRecord,
): Promise<void> {
  const ghState = await deps.ghViewPr(record.repo, record.prNumber);
  const newState = mapGhStateToPrState(ghState.state);
  if (newState === null) return; // still open on GitHub — no-op

  // claimedBy/claimedAt/heartbeatAt aren't in routes/prs.ts's PATCH
  // allowlist, so including them here is documentation-of-intent rather than
  // a functional requirement — the actual clearing happens server-side in
  // PullRequestService.update()'s state === "merged" || "closed" special
  // case (mirrors CHU-1.3's pattern). `phase` IS allowlisted and is included
  // here for defense-in-depth alongside the server-side clear.
  const fields: Record<string, unknown> = {
    state: newState,
    claimedBy: null,
    claimedAt: null,
    heartbeatAt: null,
    phase: null,
  };
  if (newState === "merged" && ghState.mergedAt) {
    fields.mergedAt = ghState.mergedAt;
  }

  await deps.patchPrRecord(record.id, fields);
}

/**
 * Resolve the repo to check a pr_open task against, mirroring the legacy
 * check-deploy.ts reconcileStalePrOpenTasks fallback: a task's own `repo`
 * field wins when it's already "org/repo" shaped, otherwise fall back to
 * the first configured repo. Returns undefined when neither is available
 * (bare repo name + no configured repos) — callers must skip defensively
 * rather than guess.
 */
function resolveTaskRepo(deps: PrStateReconcilerDeps, task: PrOpenTaskRecord): string | undefined {
  if (task.repo?.includes("/")) return task.repo;
  return deps.repos[0];
}

/**
 * Reconcile one pr_open task against live GitHub state (DSR-1.1 —
 * ports check-deploy.ts's reconcileStalePrOpenTasks two-path logic into the
 * ongoing background sweep instead of a one-shot precheck script).
 *
 * Direct path (task.pr set): reuse the same ghViewPr dep the PR-record pass
 * above already calls, so a real GitHub mergedAt is used when available
 * (falling back to the injected clock only when GitHub didn't report one —
 * unlike the legacy script, which always used `now`).
 *
 * Branch-fallback path (no task.pr, task.branch set): `gh pr list --head
 * <branch> --state merged` only returns the PR number, never a mergedAt, so
 * this path always uses the injected clock — matching the legacy script.
 *
 * Either path, once a merge is confirmed, also backfills the task-store
 * PullRequest record's taskId when that record exists and its taskId is
 * still null — closing the gap where only review.md ever wrote it.
 */
async function reconcilePrOpenTask(
  deps: PrStateReconcilerDeps,
  task: PrOpenTaskRecord,
): Promise<void> {
  const taskRepo = resolveTaskRepo(deps, task);
  if (!taskRepo) return; // no repo to resolve against — skip defensively

  let prNumber: number;
  let mergedAt: string;
  let backfillPr: number | undefined; // only set on the branch path, matching the legacy PATCH shape

  if (task.pr) {
    const ghState = await deps.ghViewPr(taskRepo, task.pr);
    if (ghState.state !== "MERGED") return; // still open/closed on GitHub — no-op
    prNumber = task.pr;
    mergedAt = ghState.mergedAt ?? deps.now();
  } else if (task.branch) {
    const merged = await deps.ghListMergedPrsForBranch(taskRepo, task.branch);
    const first = merged[0];
    if (!first) return; // no merged PR found for this branch yet
    prNumber = first.number;
    backfillPr = first.number;
    mergedAt = deps.now();
  } else {
    return; // neither path resolvable — nothing to do
  }

  await deps.updateTaskStatus(task.id, {
    status: "merged",
    ...(backfillPr !== undefined ? { pr: backfillPr } : {}),
    mergedAt,
  });

  const prRecord = await deps.findPrRecordByRepoAndPrNumber(taskRepo, prNumber);
  if (prRecord && !prRecord.taskId) {
    await deps.patchPrRecord(prRecord.id, { taskId: task.id });
  }
}

/**
 * Scan every pr_open task, resolve its linked PR (directly via task.pr, or
 * via the branch fallback), and PATCH the task to merged when GitHub
 * confirms the PR is actually merged. A single per-task failure is logged
 * and does not abort reconciliation of the rest of the batch — mirrors
 * reconcilePrState's own per-record error isolation above.
 */
export async function reconcilePrOpenTasks(deps: PrStateReconcilerDeps): Promise<void> {
  let tasks: PrOpenTaskRecord[];
  try {
    tasks = await deps.listPrOpenTasks();
  } catch (err) {
    console.error(
      "[pr-state-reconciler] failed to list pr_open tasks:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  for (const task of tasks) {
    try {
      await reconcilePrOpenTask(deps, task);
    } catch (err) {
      console.error(
        `[pr-state-reconciler] failed to reconcile pr_open task ${task.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Scan every repo's state:"open" PR records, compare each against live
 * GitHub state, and PATCH only the ones that disagree (GitHub shows
 * MERGED/CLOSED but the record still says "open"). A single per-PR gh
 * lookup failure is logged and does not abort reconciliation of the rest
 * of the batch. Then runs the pr_open-task reconciliation pass (DSR-1.1) so
 * agent/src/index.ts's single call site doesn't need to change.
 */
export async function reconcilePrState(deps: PrStateReconcilerDeps): Promise<void> {
  for (const repo of deps.repos) {
    let records: PrStateRecord[];
    try {
      records = await listAllOpenRecords(deps, repo);
    } catch (err) {
      console.error(
        `[pr-state-reconciler] failed to list open PRs for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    for (const record of records) {
      try {
        await reconcileRecord(deps, record);
      } catch (err) {
        console.error(
          `[pr-state-reconciler] failed to reconcile ${repo}#${record.prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  await reconcilePrOpenTasks(deps);
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface PrListResponseJson {
  prs: PrStateRecord[];
  total: number;
  limit: number;
  offset: number;
}

/** GET /tasks response shape — mirrors createTaskStoreClient's own legacy-bare-array tolerance. */
interface TaskListResponseJson {
  tasks: PrOpenTaskRecord[];
}

export function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => T;
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): PrStateReconcilerDeps {
  const workspacePath = resolveWorkspacePath();
  const repos = resolveAllRepos(workspacePath);
  const { ghJson } = opts;

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };
  const doFetch = opts.fetchFn ?? fetch;

  return {
    repos,
    listOpenPrRecords: async (repo: string, limit: number, offset: number) => {
      const params = new URLSearchParams({
        repo,
        state: "open",
        limit: String(limit),
        offset: String(offset),
      });
      const res = await doFetch(`${baseUrl}/prs?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /prs?${params} → ${res.status}`);
      }
      const data = (await res.json()) as PrListResponseJson;
      return data.prs;
    },
    patchPrRecord: async (id: string, fields: Record<string, unknown>) => {
      const res = await doFetch(`${baseUrl}/prs/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        throw new Error(`task-store PATCH /prs/${id} → ${res.status}`);
      }
    },
    ghViewPr: async (repo: string, prNumber: number) => {
      return ghJson<GhPrView>([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "state,mergedAt",
      ]);
    },
    listPrOpenTasks: async () => {
      const params = new URLSearchParams({ status: "pr_open" });
      const res = await doFetch(`${baseUrl}/tasks?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      // Same legacy-bare-array tolerance as createTaskStoreClient's query().
      if (Array.isArray(data)) return data as PrOpenTaskRecord[];
      return (data as TaskListResponseJson).tasks;
    },
    updateTaskStatus: async (id: string, fields: Record<string, unknown>) => {
      const res = await doFetch(`${baseUrl}/tasks/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(fields),
      });
      if (!res.ok) {
        throw new Error(`task-store PATCH /tasks/${id} → ${res.status}`);
      }
    },
    ghListMergedPrsForBranch: async (repo: string, branch: string) => {
      return ghJson<Array<{ number: number }>>([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "merged",
        "--repo",
        repo,
        "--json",
        "number",
      ]);
    },
    // createPrRecordQuery (check-helpers.ts) already implements exactly this
    // repo+prNumber lookup and, unlike this file's own listOpenPrRecords/
    // patchPrRecord, never throws — it resolves to null on missing config or
    // any fetch error, which matches the "a PR record may simply not exist
    // yet" semantics the taskId backfill needs.
    findPrRecordByRepoAndPrNumber: createPrRecordQuery<PrStateRecord>({
      fetchFn: opts.fetchFn,
    }),
    now: () => new Date().toISOString(),
  };
}
