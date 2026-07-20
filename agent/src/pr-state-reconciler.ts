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
 *
 * CHU-2.2 extends this module with a second, causally distinct step:
 * `reconcileReviewState()` self-heals task-store reviewState:"pending"
 * records that are actually terminal on GitHub. Unlike the state/mergedAt
 * drift above (a crash/hang case), this drift comes from an out-of-band
 * reviewer — a review posted directly to GitHub by an identity not wired
 * into any code path that writes to the task-store — so a stuck-pending
 * record would otherwise re-trigger check-review.ts's eligibility gate
 * (agent/src/check-review.ts) forever, spawning a full review sub-agent
 * every time even though nothing is left to review. It shares this file's
 * repo-iteration/page-until-partial/continue-on-error scaffolding and reuses
 * the SAME setInterval tick in agent/src/index.ts — not a second timer.
 *
 * DSR-2.1 adds a fourth pass, `reconcileDeployingTasks()`: self-heals
 * task-store Tasks left status:"deploying" forever when their deploy
 * actually succeeded. The deploying→deployed PATCH is the last step of the
 * /shipwright:deploy command (an agent action, not a workflow step) —
 * promote.yml has no task-store write of its own — so an interrupted agent
 * session strands the task even though the code shipped normally on GitHub.
 * This is the same class of bug DSR-1.1 fixed one status earlier (an
 * agent-owned status write that silently doesn't happen), just at the next
 * transition in the lifecycle. Registered as its own independent call in
 * agent/src/index.ts's reconciler tick (the `reconcileReviewState`
 * precedent), NOT nested inside `reconcilePrState` like
 * `reconcilePrOpenTasks`/`reconcileOrphanedTasks` are.
 *
 * CHU-2.4 extends `reconcileReviewState()` with the mirror-image healing
 * direction of CHU-2.2's pending→terminal pass above: a record stuck at
 * reviewState:"posted" whose review(s) are no longer at the current head
 * commit at all (a new commit landed since the posted verdict, but nothing
 * reset reviewState back to pending — confirmed live on
 * app-vitals/shipwright#1814) gets PATCHed back to "pending" so
 * check-review.ts's dedup guard (`commitSha === headRefOid && reviewState
 * !== "pending" -> skip`) stops trapping the PR out of every phase's
 * candidate set. Runs as a second per-repo pass inside the same
 * `reconcileReviewState()` function — no new setInterval tick.
 */

import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import {
  createPrRecordQuery,
  isCleanApproveBody,
  resolveAllRepos,
  resolveWorkspacePath,
  splitOrgRepo,
} from "./check-helpers.ts";
import type { PrReviewData } from "./check-patch.ts";
import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape of a task-store PullRequest record this reconciler needs. */
export interface PrStateRecord {
  id: string;
  repo: string;
  prNumber: number;
  state: string;
  /** Present when this record was fetched for the taskId-backfill lookup; absent/undefined elsewhere. */
  taskId?: string | null;
  /** Merge commit SHA. */
  commitSha?: string | null;
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
  /** Merge timestamp; read by the deploying→deployed pass (DSR-2.1) to gate against a stale promote run. */
  mergedAt?: string | null;
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
  /** List one page of task-store Tasks with status "pr_open" (DSR-1.1). */
  listPrOpenTasks: (
    limit: number,
    offset: number,
  ) => Promise<PrOpenTaskRecord[]>;
  /** PATCH a task-store Task's fields (DSR-1.1). */
  updateTaskStatus: (
    id: string,
    fields: Record<string, unknown>,
  ) => Promise<void>;
  /** Branch-fallback PR lookup (`gh pr list --head <branch> --state merged`) for tasks with no `pr` number set (DSR-1.1). */
  ghListMergedPrsForBranch: (
    repo: string,
    branch: string,
  ) => Promise<Array<{ number: number }>>;
  /**
   * List every task-store Task with status "pending" or "in_progress" that
   * has a `branch` set and no `pr` linked (TCR-1.2). The `PrOpenTaskRecord`
   * shape is reused as-is — no new record type needed. Unlike
   * `listPrOpenTasks` (a single status, paged one page at a time by the
   * module-level `listAllPrOpenTasks` loop), this dep's contract is to
   * already page BOTH the "pending" and "in_progress" queries to completion
   * internally and return the fully-merged, filtered result — because a
   * single (limit, offset) pair can't address two independently-paginated
   * upstream queries being unioned together. See `buildProductionDeps`'s
   * implementation below for the two independent pagination loops.
   */
  listOrphanCandidateTasks: () => Promise<PrOpenTaskRecord[]>;
  /**
   * Branch lookup for a real, currently-OPEN PR (`gh pr list --head <branch>
   * --state open`) — the TCR-1.2 counterpart to `ghListMergedPrsForBranch`
   * above, but for OPEN PRs, and additionally returning `createdAt` since
   * the orphan pass needs the PR's actual creation time for `prCreatedAt`
   * (unlike the merged-task branch-fallback path, this pass has no `now()`
   * fallback requirement).
   */
  ghListOpenPrsForBranch: (
    repo: string,
    branch: string,
  ) => Promise<Array<{ number: number; createdAt: string }>>;
  /** Look up a task-store PullRequest record by repo+prNumber, for the taskId backfill (DSR-1.1). */
  findPrRecordByRepoAndPrNumber: (
    repo: string,
    prNumber: number,
  ) => Promise<PrStateRecord | null>;
  /** Injected clock — mergedAt fallback when GitHub doesn't report one (DSR-1.1). */
  now: () => string;
  /**
   * Returns the agent's currently-configured repo scope (WL-4.2's live
   * agent-repos-ref.ts), read fresh on every reconcilePrState() call — not
   * closed over at buildProductionDeps time — so a scope change takes effect
   * on the very next tick. `repos` above is the local-clone filesystem scan
   * (built once); this filter is intersected with it at call time so a repo
   * cloned locally for reference but absent from this list never gets
   * reconciled (see WL-4.4). This scope-filtering is new as of WL-4.4 —
   * check-deploy.ts/check-review.ts/check-patch.ts do not yet apply
   * equivalent filtering and still call resolveAllRepos() unscoped.
   */
  getScopedRepos: () => string[];
  /** List one page of task-store Tasks with status "deploying" (DSR-2.1). */
  listDeployingTasks: (
    limit: number,
    offset: number,
  ) => Promise<PrOpenTaskRecord[]>;
  /** List the newest workflow runs for a given workflow name, newest-first (DSR-2.1). */
  ghListWorkflowRuns: (
    repo: string,
    workflow: string,
    limit: number,
  ) => Promise<
    Array<{ createdAt: string; conclusion: string | null; id: number }>
  >;
}

/** Minimal shape of a task-store PullRequest record reviewState reconciliation needs. */
export interface PrReviewStateRecord {
  id: string;
  repo: string;
  prNumber: number;
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
}

export interface PrReviewStateReconcilerDeps {
  repos: string[];
  /** Page size for listing reviewState:"pending" records; defaults to the task-store's own default (50). */
  pageLimit?: number;
  /** Injected time source — never call Date.now()/new Date() directly. */
  clock: Clock;
  /** Claim freshness window in ms; defaults to 2_100_000 (mirrors SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS's own default). */
  claimTtlMs?: number;
  /** List one page of state:"open" && reviewState:"pending" PR records for a repo. */
  listPendingReviewRecords: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrReviewStateRecord[]>;
  /**
   * List one page of state:"open" && reviewState:"posted" PR records for a
   * repo (CHU-2.4) — mirrors `listPendingReviewRecords`'s exact signature,
   * paged the same way, but for the mirror-image healing direction: a
   * posted verdict that's gone stale because a new commit landed with no
   * review targeting it yet.
   */
  listPostedReviewRecords: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrReviewStateRecord[]>;
  /** Fetch head commit + reviews + review threads for a single PR. Throws on lookup failure. */
  fetchPrReviews: (
    org: string,
    repo: string,
    prNumber: number,
  ) => Promise<PrReviewData>;
  /** PATCH a task-store PR record's fields. */
  patchPrRecord: (id: string, fields: Record<string, unknown>) => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_LIMIT = 50;

/** Map GitHub's uppercase PR state to the task-store's lowercase PrState enum. */
function mapGhStateToPrState(
  state: GhPrView["state"],
): "merged" | "closed" | null {
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
 * List every task-store Task with status "pr_open" (DSR-1.1), paging through
 * the task-store's default 50-record page until a page returns fewer than
 * `limit` records — same loop shape as `listAllOpenRecords` above (TCR-1.2
 * follow-up: this dep was previously unpaginated).
 */
async function listAllPrOpenTasks(
  deps: PrStateReconcilerDeps,
): Promise<PrOpenTaskRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const tasks: PrOpenTaskRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await deps.listPrOpenTasks(limit, offset);
    tasks.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return tasks;
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
function resolveTaskRepo(
  deps: PrStateReconcilerDeps,
  task: PrOpenTaskRecord,
): string | undefined {
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
export async function reconcilePrOpenTasks(
  deps: PrStateReconcilerDeps,
): Promise<void> {
  let tasks: PrOpenTaskRecord[];
  try {
    tasks = await listAllPrOpenTasks(deps);
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

/**
 * Reconcile one orphaned pending/in_progress task against live GitHub state
 * (TCR-1.2 — closes the gap behind 5+ documented recurrences: LCT-3.1,
 * CHU-2.2, PSF-2.1, ADS-1.2, TS-web-hitl-filter/PR#1789, where a dev-task
 * session pushes a commit and opens a real PR on GitHub but gets interrupted
 * before the final task-store PATCH to status:"pr_open" — leaving the task
 * stuck at pending/in_progress forever with an orphaned, never-linked PR).
 *
 * Causally, this pass runs FIRST in the chain: it heals pending/in_progress
 * → pr_open drift, i.e. it's what gets a task INTO the state the existing
 * `reconcilePrOpenTasks` pass above then watches for merges/closes on
 * (pr_open → merged drift). A task only ever needs this pass once, before it
 * would ever reach the existing one.
 *
 * `deps.listOrphanCandidateTasks()` is defined to only return
 * pending/in_progress tasks with a branch set and no pr linked — a task
 * already at pr_open is never returned by a correct implementation, so no
 * extra status filtering happens here (matches every other list* dep in this
 * file: filtering is the dep's contract, not this function's job).
 */
async function reconcileOrphanedTask(
  deps: PrStateReconcilerDeps,
  task: PrOpenTaskRecord,
): Promise<void> {
  const taskRepo = resolveTaskRepo(deps, task);
  if (!taskRepo) return; // no repo to resolve against — skip defensively

  if (!task.branch) return; // shouldn't happen given the dep contract, but defend anyway

  const open = await deps.ghListOpenPrsForBranch(taskRepo, task.branch);
  const first = open[0];
  if (!first) return; // no open PR found for this branch yet — no-op

  await deps.updateTaskStatus(task.id, {
    status: "pr_open",
    pr: first.number,
    prCreatedAt: first.createdAt,
  });
}

/**
 * Scan every orphan-candidate task (pending/in_progress, branch set, no pr
 * linked), resolve a real open PR on GitHub for its branch, and PATCH the
 * task to pr_open when one is found (TCR-1.2). A single per-task failure is
 * logged and does not abort reconciliation of the rest of the batch —
 * mirrors `reconcilePrOpenTasks`'s own per-task error isolation above.
 */
export async function reconcileOrphanedTasks(
  deps: PrStateReconcilerDeps,
): Promise<void> {
  let tasks: PrOpenTaskRecord[];
  try {
    tasks = await deps.listOrphanCandidateTasks();
  } catch (err) {
    console.error(
      "[pr-state-reconciler] failed to list orphan-candidate tasks:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  for (const task of tasks) {
    try {
      await reconcileOrphanedTask(deps, task);
    } catch (err) {
      console.error(
        `[pr-state-reconciler] failed to reconcile orphan-candidate task ${task.id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/** Number of newest workflow runs to fetch per lookup, matching check-deploy.ts's `fetchCiRuns` `per_page=20` convention (DSR-2.1). */
const PROMOTE_RUNS_LOOKUP_LIMIT = 20;

/** Workflow name to look up for the deploying→deployed pass (DSR-2.1). */
const PROMOTE_WORKFLOW_NAME = "Promote to Prod";

/**
 * List every task-store Task with status "deploying" (DSR-2.1), paging
 * through the task-store's default 50-record page until a page returns
 * fewer than `limit` records — same loop shape as `listAllPrOpenTasks`/
 * `listAllOpenRecords` elsewhere in this file.
 */
async function listAllDeployingTasks(
  deps: PrStateReconcilerDeps,
): Promise<PrOpenTaskRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const tasks: PrOpenTaskRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await deps.listDeployingTasks(limit, offset);
    tasks.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return tasks;
}

/**
 * Reconcile one deploying task against live GitHub workflow-run state
 * (DSR-2.1). The deploying→deployed PATCH is normally the last step of the
 * /shipwright:deploy command (an agent action) — promote.yml itself has no
 * task-store write — so an interrupted agent session strands the task even
 * though the code shipped normally. PATCHes to status:"deployed" only when
 * a SUCCESSFUL "Promote to Prod" run's createdAt is strictly after the
 * task's mergedAt; deployedAt is always that run's createdAt, NEVER
 * `now()` — there is no clock fallback for this pass, unlike
 * `reconcilePrOpenTask`'s `deps.now()` fallback, because a reconcile-time
 * stamp would silently inflate every cycle-time metric it touches.
 */
async function reconcileDeployingTask(
  deps: PrStateReconcilerDeps,
  task: PrOpenTaskRecord,
): Promise<void> {
  const taskRepo = resolveTaskRepo(deps, task);
  if (!taskRepo) return; // no repo to resolve against — skip defensively

  if (!task.mergedAt) {
    console.error(
      `[pr-state-reconciler] deploying task ${task.id} has no mergedAt — skipping rather than guessing`,
    );
    return;
  }

  const runs = await deps.ghListWorkflowRuns(
    taskRepo,
    PROMOTE_WORKFLOW_NAME,
    PROMOTE_RUNS_LOOKUP_LIMIT,
  );
  const latestSuccess = runs.find((r) => r.conclusion === "success");
  if (!latestSuccess) return; // no successful promote run — leave untouched

  const mergedAtMs = new Date(task.mergedAt).getTime();
  const runCreatedAtMs = new Date(latestSuccess.createdAt).getTime();
  if (!(runCreatedAtMs > mergedAtMs)) return; // not strictly after mergedAt — leave untouched

  await deps.updateTaskStatus(task.id, {
    status: "deployed",
    deployedAt: latestSuccess.createdAt,
  });
}

/**
 * Scan every deploying task, resolve the latest successful "Promote to
 * Prod" workflow run for its repo, and PATCH the task to deployed when that
 * run's createdAt confirms the deploy actually happened after the merge
 * (DSR-2.1). A single per-task failure is logged and does not abort
 * reconciliation of the rest of the batch — mirrors
 * `reconcilePrOpenTasks`/`reconcileOrphanedTasks`'s own per-task error
 * isolation above.
 */
export async function reconcileDeployingTasks(
  deps: PrStateReconcilerDeps,
): Promise<void> {
  let tasks: PrOpenTaskRecord[];
  try {
    tasks = await listAllDeployingTasks(deps);
  } catch (err) {
    console.error(
      "[pr-state-reconciler] failed to list deploying tasks:",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  for (const task of tasks) {
    try {
      await reconcileDeployingTask(deps, task);
    } catch (err) {
      console.error(
        `[pr-state-reconciler] failed to reconcile deploying task ${task.id}:`,
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
 * of the batch. Then runs the pr_open-task reconciliation pass (DSR-1.1) and
 * the orphaned pending/in_progress-task reconciliation pass (TCR-1.2) so
 * agent/src/index.ts's single call site doesn't need to change.
 */
export async function reconcilePrState(
  deps: PrStateReconcilerDeps,
): Promise<void> {
  const scopedReposSet = new Set(deps.getScopedRepos());
  const scopedRepos = deps.repos.filter((repo) => scopedReposSet.has(repo));

  for (const repo of scopedRepos) {
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
  await reconcileOrphanedTasks(deps);
}

// ─── reconcileReviewState ───────────────────────────────────────────────────────

/** Filter a PR's reviews down to only those submitted at the current head commit. */
function reviewsAtHeadCommit(data: PrReviewData): PrReviewData["reviews"]["nodes"] {
  const { headRefOid, reviews } = data;
  return reviews.nodes.filter((r) => r.commit.oid === headRefOid);
}

/**
 * CHU-2.4: does ANY review at all exist at the PR's current head commit?
 * Extracted out of `classifyReviewState`'s existing `reviewsAtHead.length ===
 * 0` check so the posted-scan pass can distinguish this specific null case
 * ("nothing at head at all" — a posted verdict has gone stale because a new
 * commit landed with no review yet targeting it) from the OTHER null case
 * `classifyReviewState` returns (a genuine unresolved finding at head, which
 * must leave a posted record untouched). `classifyReviewState`'s own
 * existing behavior/signature is unchanged — it still returns null for both
 * cases, exactly as before.
 */
function hasAnyReviewAtHead(data: PrReviewData): boolean {
  return reviewsAtHeadCommit(data).length > 0;
}

/**
 * Classify a PR's review state from live GitHub review data. Mirrors the
 * SHAPE of check-patch.ts's private `hasUnaddressedFindings` filtering
 * (reviews-at-head, unresolved-threads-or-non-empty-body) but keyed on
 * `isCleanApproveBody` for the approve/non-finding split instead of
 * self-authorship — this reconciler exists specifically to catch an
 * OUT-OF-BAND reviewer, so ANY author's clean-approve-shaped COMMENTED
 * review counts, not just self-authored ones.
 *
 * Genuine findings are checked FIRST, independent of whether an approve also
 * exists at head — an approve from one reviewer must never mask an unresolved
 * thread or non-empty finding body left by a different reviewer's
 * COMMENTED/CHANGES_REQUESTED review at the same head commit (mirrors
 * `hasUnaddressedFindings`'s filtering order in check-patch.ts).
 *
 * Returns:
 *   - "approved" — a real APPROVED review, or a clean-approve-shaped
 *     COMMENTED review, at the current head commit, AND no genuine
 *     unaddressed finding from any other review at the same head commit.
 *   - "posted" — a terminal (no unresolved threads, no qualifying non-empty
 *     finding body) non-approve review at the current head commit.
 *   - null — no review at all at the current head commit, OR a genuine
 *     unaddressed finding at the current head commit. Both cases must leave
 *     the record completely untouched.
 */
function classifyReviewState(data: PrReviewData): "approved" | "posted" | null {
  const { reviewThreads } = data;
  const reviewsAtHead = reviewsAtHeadCommit(data);
  if (reviewsAtHead.length === 0) return null; // nothing at head — untouched

  const qualifyingReviews = reviewsAtHead.filter(
    (r) =>
      (r.state === "COMMENTED" || r.state === "CHANGES_REQUESTED") &&
      !isCleanApproveBody(r.body),
  );

  if (qualifyingReviews.length > 0) {
    const unresolvedThreads = reviewThreads.nodes.filter((t) => !t.isResolved);
    if (unresolvedThreads.length > 0) return null; // genuine finding — untouched

    const hasFindingBody = qualifyingReviews.some(
      (r) => r.body.trim().length > 0,
    );
    if (hasFindingBody) return null; // genuine finding — untouched
  }

  const hasApprove = reviewsAtHead.some(
    (r) =>
      r.state === "APPROVED" ||
      (r.state === "COMMENTED" && isCleanApproveBody(r.body)),
  );
  if (hasApprove) return "approved";

  return "posted"; // terminal, non-approve, no finding
}

/**
 * A record is "actively claimed" (skip it — never overwrite a live claim's
 * reviewState) when `claimedBy` is set AND its freshness timestamp
 * (`heartbeatAt`, falling back to `claimedAt` when null) is within the claim
 * TTL window of `clock.now()`. If `claimedBy` is null, or both timestamps
 * are null, the record is NOT actively claimed.
 */
function isActivelyClaimed(
  record: PrReviewStateRecord,
  clock: Clock,
  claimTtlMs: number,
): boolean {
  if (!record.claimedBy) return false;
  const freshnessTimestamp = record.heartbeatAt ?? record.claimedAt;
  if (!freshnessTimestamp) return false;
  const cutoff = clock.now().getTime() - claimTtlMs;
  return new Date(freshnessTimestamp).getTime() >= cutoff;
}

/**
 * List every record a paginated per-repo list-fn returns for a repo, paging
 * through the task-store's default 50-record page until a page returns
 * fewer than `limit` records. Shared pagination-until-partial-page loop for
 * both the reviewState:"pending" scan (`listPendingReviewRecords`) and the
 * reviewState:"posted" scan (`listPostedReviewRecords`, CHU-2.4) — the loop
 * body is identical, only the underlying dep function differs.
 */
async function listAllReviewRecords(
  deps: PrReviewStateReconcilerDeps,
  repo: string,
  listFn: (
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrReviewStateRecord[]>,
): Promise<PrReviewStateRecord[]> {
  const limit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const records: PrReviewStateRecord[] = [];
  let offset = 0;

  for (;;) {
    const page = await listFn(repo, limit, offset);
    records.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }

  return records;
}

/**
 * Reconcile a single reviewState:"pending" record against live GitHub
 * review data. Skips actively-claimed records without any GitHub call.
 * Issues a PATCH only when GitHub shows a terminal review at the PR's
 * current head commit — a genuine unaddressed finding, a stale-commit-only
 * review, or no review at all are all left completely untouched.
 */
async function reconcileReviewStateRecord(
  deps: PrReviewStateReconcilerDeps,
  record: PrReviewStateRecord,
): Promise<void> {
  // deps.claimTtlMs is NOT left unwired here: buildReviewStateProductionDeps
  // (below) reads process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS itself and
  // sets it on the returned deps object, so index.ts's bare
  // buildReviewStateReconcilerDeps({ ghGraphql }) call site still gets the
  // env var end-to-end — confirmed by this factory's own unit tests below.
  const claimTtlMs = deps.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  if (isActivelyClaimed(record, deps.clock, claimTtlMs)) return; // live claim — never overwrite

  const [org, repoName] = splitOrgRepo(record.repo);
  const reviewData = await deps.fetchPrReviews(org, repoName, record.prNumber);
  const newReviewState = classifyReviewState(reviewData);
  if (newReviewState === null) return; // nothing terminal at head — no-op

  await deps.patchPrRecord(record.id, { reviewState: newReviewState });
}

/**
 * Reconcile a single reviewState:"posted" record against live GitHub review
 * data (CHU-2.4 — the mirror-image direction of
 * `reconcileReviewStateRecord` above). Skips actively-claimed records
 * without any GitHub call, same as the pending-scan guard.
 *
 * Unlike the pending-scan reconciler, this does NOT use
 * `classifyReviewState()`'s return value directly — that function collapses
 * "nothing at head at all" and "a genuine finding exists at head" into the
 * same `null`, which is the right no-op for a *pending* record but wrong
 * for a *posted* one. Here the two cases must be told apart:
 *
 *   - NO review at all at the current head commit (confirmed live on
 *     app-vitals/shipwright#1814: a new commit landed one commit past every
 *     review on file) means the posted verdict is stale — PATCH back to
 *     "pending" so check-review.ts re-selects the PR for a fresh review.
 *   - Anything else (a genuine unresolved finding at head, a still-terminal
 *     review, or a still-approved review) leaves the record completely
 *     untouched — there's nothing to heal.
 */
async function reconcilePostedReviewStateRecord(
  deps: PrReviewStateReconcilerDeps,
  record: PrReviewStateRecord,
): Promise<void> {
  const claimTtlMs = deps.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  if (isActivelyClaimed(record, deps.clock, claimTtlMs)) return; // live claim — never overwrite

  const [org, repoName] = splitOrgRepo(record.repo);
  const reviewData = await deps.fetchPrReviews(org, repoName, record.prNumber);
  if (hasAnyReviewAtHead(reviewData)) return; // something at head (finding or terminal) — untouched

  await deps.patchPrRecord(record.id, { reviewState: "pending" });
}

/**
 * Scan every repo's reviewState:"pending" PR records, compare each against
 * live GitHub review data, and PATCH only the ones that have gone terminal
 * at the current head commit (an out-of-band reviewer posted an APPROVED or
 * clean-approve-shaped/terminal review directly to GitHub). Then runs the
 * mirror-image reviewState:"posted" scan (CHU-2.4): a posted verdict whose
 * review(s) are no longer at the current head commit at all (a new commit
 * landed since the posted verdict, but nothing reset reviewState back to
 * pending) gets PATCHed back to "pending" so check-review.ts's dedup guard
 * (`commitSha === headRefOid && reviewState !== "pending" -> skip`) stops
 * trapping the PR out of every phase's candidate set. A single per-record
 * failure (claim check aside) is logged and does not abort reconciliation
 * of the rest of the batch, for either scan.
 */
export async function reconcileReviewState(
  deps: PrReviewStateReconcilerDeps,
): Promise<void> {
  for (const repo of deps.repos) {
    let records: PrReviewStateRecord[];
    try {
      records = await listAllReviewRecords(
        deps,
        repo,
        deps.listPendingReviewRecords,
      );
    } catch (err) {
      console.error(
        `[pr-state-reconciler:review] failed to list pending-review PRs for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    for (const record of records) {
      try {
        await reconcileReviewStateRecord(deps, record);
      } catch (err) {
        console.error(
          `[pr-state-reconciler:review] failed to reconcile ${repo}#${record.prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  for (const repo of deps.repos) {
    let postedRecords: PrReviewStateRecord[];
    try {
      postedRecords = await listAllReviewRecords(
        deps,
        repo,
        deps.listPostedReviewRecords,
      );
    } catch (err) {
      console.error(
        `[pr-state-reconciler:review] failed to list posted-review PRs for ${repo}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }

    for (const record of postedRecords) {
      try {
        await reconcilePostedReviewStateRecord(deps, record);
      } catch (err) {
        console.error(
          `[pr-state-reconciler:review] failed to reconcile posted ${repo}#${record.prNumber}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}

// ─── Production deps ──────────────────────────────────────────────────────────

interface PrListResponseJson {
  prs: PrStateRecord[];
  total: number;
  limit: number;
  offset: number;
}

interface PrReviewListResponseJson {
  prs: PrReviewStateRecord[];
  total: number;
  limit: number;
  offset: number;
}

interface ReviewGraphqlResponse {
  data: {
    repository: {
      pullRequest: PrReviewData;
    };
  };
}

/** Shared PATCH-fetch helper for both production-deps factories in this file. */
function makePatchPrRecord(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  doFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): (id: string, fields: Record<string, unknown>) => Promise<void> {
  const { baseUrl, headers, doFetch } = opts;
  return async (id: string, fields: Record<string, unknown>) => {
    const res = await doFetch(`${baseUrl}/prs/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      throw new Error(`task-store PATCH /prs/${id} → ${res.status}`);
    }
  };
}

/** GET /tasks response shape — mirrors createTaskStoreClient's own legacy-bare-array tolerance. */
interface TaskListResponseJson {
  tasks: PrOpenTaskRecord[];
}

/**
 * Shared GET /tasks?status=<status>&limit=<limit>&offset=<offset> helper for
 * both `listPrOpenTasks` and `listOrphanCandidateTasks` (TCR-1.2) — the
 * task-store's GET /tasks only accepts one status value at a time (no
 * comma-separated multi-status support), so `listOrphanCandidateTasks` below
 * issues two of these paginated calls (one per status) and merges the
 * results client-side. `limit`/`offset` are passed straight through, same as
 * `listOpenPrRecords`'s own GET /prs helper, so the module-level
 * `listAllPrOpenTasks`/`listAllOrphanCandidateTasks` pagination loops above
 * can page each status to completion instead of only ever seeing the
 * task-store's default first page.
 */
function makeListTasksByStatus(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  doFetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): (
  status: string,
  limit: number,
  offset: number,
) => Promise<PrOpenTaskRecord[]> {
  const { baseUrl, headers, doFetch } = opts;
  return async (status: string, limit: number, offset: number) => {
    const params = new URLSearchParams({
      status,
      limit: String(limit),
      offset: String(offset),
    });
    const res = await doFetch(`${baseUrl}/tasks?${params}`, { headers });
    if (!res.ok) {
      throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    // Same legacy-bare-array tolerance as createTaskStoreClient's query().
    if (Array.isArray(data)) return data as PrOpenTaskRecord[];
    return (data as TaskListResponseJson).tasks;
  };
}

export function buildProductionDeps(opts: {
  ghJson: <T>(args: string[]) => Promise<T>;
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getScopedRepos: () => string[];
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
  const listTasksByStatus = makeListTasksByStatus({
    baseUrl,
    headers,
    doFetch,
  });

  /**
   * Page a single status query to completion (TCR-1.2) — same loop shape as
   * `listAllOpenRecords`/`listAllPendingReviewRecords` elsewhere in this
   * file, but over `listTasksByStatus` instead of a per-repo dep. Used by
   * `listOrphanCandidateTasks` below to fully page both "pending" and
   * "in_progress" before merging, since a single (limit, offset) pair can't
   * address two independently-paginated queries being unioned together.
   */
  const listAllTasksByStatus = async (
    status: string,
  ): Promise<PrOpenTaskRecord[]> => {
    const limit = DEFAULT_PAGE_LIMIT;
    const tasks: PrOpenTaskRecord[] = [];
    let offset = 0;

    for (;;) {
      const page = await listTasksByStatus(status, limit, offset);
      tasks.push(...page);
      if (page.length < limit) break;
      offset += limit;
    }

    return tasks;
  };

  return {
    repos,
    getScopedRepos: opts.getScopedRepos,
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
    patchPrRecord: makePatchPrRecord({ baseUrl, headers, doFetch }),
    ghViewPr: async (repo: string, prNumber: number) => {
      return await ghJson<GhPrView>([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "state,mergedAt",
      ]);
    },
    listPrOpenTasks: (limit: number, offset: number) =>
      listTasksByStatus("pr_open", limit, offset),
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
      return await ghJson<Array<{ number: number }>>([
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
    // TCR-1.2: the task-store's GET /tasks only accepts one status value at
    // a time and has no server-side "has a branch AND no pr" filter, so this
    // pages each status to completion (via listAllTasksByStatus — fixes a
    // live truncation bug where the default 50-record page was silently
    // dropping candidates once pending+in_progress volume exceeded 50:
    // verified live, `GET /tasks?status=pending` had `total: 62`) and
    // filters the merged result client-side.
    listOrphanCandidateTasks: async () => {
      const [pending, inProgress] = await Promise.all([
        listAllTasksByStatus("pending"),
        listAllTasksByStatus("in_progress"),
      ]);
      return [...pending, ...inProgress].filter(
        (task) => !!task.branch && !task.pr,
      );
    },
    ghListOpenPrsForBranch: async (repo: string, branch: string) => {
      return await ghJson<Array<{ number: number; createdAt: string }>>([
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "open",
        "--repo",
        repo,
        "--json",
        "number,createdAt",
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
    listDeployingTasks: (limit: number, offset: number) =>
      listTasksByStatus("deploying", limit, offset),
    // Server-side scoped by workflow (fixes a live bug: a client-side-filtered
    // `actions/runs?per_page=N` repo-wide fetch can miss the target workflow
    // entirely when unrelated workflows are noisy — confirmed live in
    // production, e.g. bursts of "Bump Shipwright Chart" runs pushing a real
    // "Promote to Prod" run outside a top-20 window). GitHub's workflow-scoped
    // runs endpoint (`actions/workflows/{workflow_id_or_file_name}/runs`)
    // requires a numeric workflow id or the workflow file's basename — NOT
    // its display `name:` — so this first resolves `workflow` (a display
    // name, e.g. "Promote to Prod") to its numeric id via the "list repo
    // workflows" endpoint, then queries that workflow's runs directly. This
    // genuinely mirrors check-deploy.ts's fetchActiveDeployRuns/fetchCiRuns
    // precedent, which also filter server-side (`status=`/`head_sha=`), not
    // just newest-first ordering as the removed comment claimed.
    ghListWorkflowRuns: async (
      repo: string,
      workflow: string,
      limit: number,
    ) => {
      const [org, repoName] = splitOrgRepo(repo);
      const workflowsData = await ghJson<{
        workflows: Array<{ id: number; name: string }>;
      }>(["api", `repos/${org}/${repoName}/actions/workflows?per_page=100`]);
      const match = workflowsData.workflows.find((w) => w.name === workflow);
      if (!match) return []; // no such workflow configured for this repo — nothing to reconcile against

      const data = await ghJson<{
        workflow_runs: Array<{
          status: string;
          conclusion: string | null;
          created_at: string;
          id?: number;
        }>;
      }>([
        "api",
        `repos/${org}/${repoName}/actions/workflows/${match.id}/runs?per_page=${limit}`,
      ]);
      return data.workflow_runs.map((r) => ({
        createdAt: r.created_at,
        conclusion: r.conclusion,
        id: r.id ?? 0,
      }));
    },
  };
}

/**
 * Production deps for `reconcileReviewState()`. Kept as a distinctly-named
 * factory (not a `buildProductionDeps` overload) since its query shape
 * (`state=open&reviewState=pending`) and GitHub call (GraphQL review fetch)
 * are unrelated to `reconcilePrState()`'s (`state=open` list + `gh pr view`).
 */
export function buildReviewStateProductionDeps(opts: {
  ghGraphql: <T>(query: string) => Promise<T>;
  fetchFn?: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  clock?: Clock;
}): PrReviewStateReconcilerDeps {
  const workspacePath = resolveWorkspacePath();
  const repos = resolveAllRepos(workspacePath);
  const { ghGraphql } = opts;

  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };
  const doFetch = opts.fetchFn ?? fetch;

  /**
   * Shared GET /prs?repo=<repo>&state=open&reviewState=<reviewState> helper
   * for both the pending scan and the posted scan (CHU-2.4) — identical
   * request shape, only the `reviewState` query value differs.
   */
  const listReviewRecordsByState = (
    reviewState: "pending" | "posted",
  ): ((
    repo: string,
    limit: number,
    offset: number,
  ) => Promise<PrReviewStateRecord[]>) => {
    return async (repo: string, limit: number, offset: number) => {
      const params = new URLSearchParams({
        repo,
        state: "open",
        reviewState,
        limit: String(limit),
        offset: String(offset),
      });
      const res = await doFetch(`${baseUrl}/prs?${params}`, { headers });
      if (!res.ok) {
        throw new Error(`task-store GET /prs?${params} → ${res.status}`);
      }
      const data = (await res.json()) as PrReviewListResponseJson;
      return data.prs;
    };
  };

  return {
    repos,
    clock: opts.clock ?? SystemClock(),
    claimTtlMs: Number(
      process.env.SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS ?? DEFAULT_CLAIM_TTL_MS,
    ),
    listPendingReviewRecords: listReviewRecordsByState("pending"),
    listPostedReviewRecords: listReviewRecordsByState("posted"),
    patchPrRecord: makePatchPrRecord({ baseUrl, headers, doFetch }),
    fetchPrReviews: async (org: string, repo: string, pr: number) => {
      const query = `{
  repository(owner: "${org}", name: "${repo}") {
    pullRequest(number: ${pr}) {
      headRefOid
      reviews(first: 50) {
        nodes {
          author { login }
          state
          submittedAt
          commit { oid }
          body
        }
      }
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 1) {
            nodes {
              author { login }
              body
            }
          }
        }
      }
      comments(last: 50) {
        nodes {
          author { login }
          body
          createdAt
        }
      }
    }
  }
}`;
      const response = await ghGraphql<ReviewGraphqlResponse>(query);
      return response.data.repository.pullRequest;
    },
  };
}
