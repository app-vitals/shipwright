/**
 * task-store/src/task-service.ts
 * TaskService — CRUD plus atomic claim / liveness operations for tasks.
 *
 * The claim is atomic via a single conditional UPDATE (raw SQL). Concurrent
 * claimers race on the same `WHERE status='pending'` predicate; Postgres
 * serializes the row update, so exactly one UPDATE affects a row and the rest
 * affect zero — those throw ConflictError(409).
 *
 * Timestamp fields that originate from the store.ts interface (claimedAt,
 * heartbeatAt, completedAt, etc.) are stored as ISO strings to match the
 * application contract; only createdAt/updatedAt are DateTime columns.
 */

import { type BlockedByEntry, computeBlockedBy } from "./blocked-by.ts";
import { type Clock, SystemClock } from "./clock.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  WebhookDeliveryError,
} from "./errors.ts";
import type {
  Prisma,
  PrismaClient,
  Task,
  TaskEvent,
  TaskKind,
} from "./index.ts";
import { buildRepoOrgWhere } from "./lib/repo-org-filter.ts";
import {
  type PrOriginStamper,
  PullRequestService,
} from "./pull-request-service.ts";
import { resolveReadyTasks } from "./ready.ts";
import { SessionService } from "./session-service.ts";
import { CLOSED_STATUSES, OPEN_STATUSES } from "./statuses.ts";
import { writeTaskEvents } from "./task-transition-diff.ts";
import type { WebhookDispatcher } from "./webhook-dispatcher.ts";

/**
 * The Prisma client surface shared by the top-level client and a
 * $transaction callback's `tx`. recordTaskTransition() accepts this so it
 * can run against either — the write path always hands it the same `tx`
 * that performed the source update, keeping the event insert(s) atomic with
 * it. Mirrors PrismaTxClient in pull-request-service.ts.
 */
type PrismaTxClient = Pick<Prisma.TransactionClient, "task" | "taskEvent">;

// Re-export so callers can import from task-service without reaching into blocked-by.
export type { BlockedByEntry };
export { CLOSED_STATUSES, OPEN_STATUSES };

/**
 * Skip-count auto-block threshold: once a task's skipCount reaches this
 * value, recordSkip() also sets status:'blocked' + hitl:true + blockedReason
 * so the loop orchestrator stops re-selecting it. Mirrors
 * SPIN_DETECTION_THRESHOLD in agent/src/loop-orchestrator.ts:179 —
 * duplicated here (not imported) since agent/ and task-store/ are separate
 * deployables.
 */
const SKIP_BLOCK_THRESHOLD = 3;

/** The subset of a skip-trackable record's state computeSkipStreak() reads. */
export interface SkipStreakState {
  skipCount: number;
  lastSkipReason: string | null;
}

/** computeSkipStreak()'s result: the next skipCount/lastSkipReason to write, plus whether this crossing trips the auto-block. */
export interface SkipStreakResult {
  /**
   * The *projected* post-write skipCount — i.e. what the column will hold if
   * no concurrent skip interleaves. Used for the threshold check and the
   * blockedReason message only; callers must write `skipCountUpdate` (not
   * this) to the column.
   */
  skipCount: number;
  /**
   * The Prisma update value callers must write to the `skipCount` column: the
   * atomic `{ increment: 1 }` when the streak continues, and the literal `1`
   * when a new streak starts.
   *
   * Writing a literal computed `skipCount` on the increment branch would
   * reintroduce a lost-update race: under Postgres's default Read Committed
   * isolation two concurrent skips on the same record can both read the same
   * prior skipCount and the second write silently clobbers the first,
   * undercounting the streak and delaying the auto-block. `{ increment: 1 }`
   * compiles to SQL `"skipCount" = "skipCount" + 1`, which the DB serializes
   * per row. Mirrors PullRequestService.patch()'s consecutiveCiFailureCount
   * handling. The reset branch is a plain assignment, so a literal is correct
   * (and required) there.
   */
  skipCountUpdate: { increment: number } | number;
  lastSkipReason: string;
  blocked: boolean;
  /** Descriptive message naming the consecutive count and reason; null unless `blocked`. */
  blockedReason: string | null;
}

/**
 * SRB-1.1: pure, reason-aware skip-streak computation shared by
 * TaskService.recordSkip() and StaleClaimReaper.reap() (with reason
 * "stale_claim_timeout") so both apply identical semantics rather than
 * duplicating the increment/reset/threshold logic.
 *
 * When `reason` matches `current.lastSkipReason`, the streak continues:
 * skipCount increments by 1. When it differs — including when
 * `current.lastSkipReason` is null (no prior streak) — a new streak starts:
 * skipCount resets to 1. Either way, crossing SKIP_BLOCK_THRESHOLD (3) sets
 * `blocked:true` with a `blockedReason` naming the consecutive count and the
 * reason. A reset (skipCount back down to 1) never trips the threshold, even
 * if the prior streak's count was at/above it — matches
 * PullRequestService.patch()'s consecutiveCiFailureCount pattern.
 *
 * The increment branch returns `skipCountUpdate: { increment: 1 }` rather than
 * the literal projected `skipCount`, so the column write stays atomic at the
 * DB level and concurrent same-record skips can't lost-update each other (see
 * `SkipStreakResult.skipCountUpdate`). `skipCount` is still returned for the
 * threshold decision and the blockedReason text — those are inherently
 * read-derived, exactly as in PullRequestService.patch().
 */
export function computeSkipStreak(
  current: SkipStreakState,
  reason: string,
): SkipStreakResult {
  const continued = current.lastSkipReason === reason;
  const skipCount = continued ? current.skipCount + 1 : 1;
  const blocked = skipCount >= SKIP_BLOCK_THRESHOLD;
  return {
    skipCount,
    skipCountUpdate: continued ? { increment: 1 } : 1,
    lastSkipReason: reason,
    blocked,
    blockedReason: blocked
      ? `Auto-blocked after ${skipCount} consecutive skips for reason: ${reason}`
      : null,
  };
}

/**
 * Explicit interactive-transaction `timeout` for every write path that now
 * dispatches an outbound `task.write` webhook from inside its transaction
 * (TSW-1.2: create/update/claim/complete/fail/release/recordSkip/resetSkip).
 *
 * Prisma's default interactive-transaction `timeout` is 5000ms — the same as
 * the dispatcher's own default request timeout (`DEFAULT_WEBHOOK_TIMEOUT_MS`
 * in main.ts) — and Prisma's clock starts when the transaction *opens*, not
 * when the webhook call starts. Because the dispatcher runs after this
 * transaction's own findUnique/update/recordTaskTransition queries have
 * already spent part of that budget, a slow-but-not-yet-failing receiver
 * would trip Prisma's transaction timeout *before* the dispatcher's own
 * `AbortSignal.timeout()` fired. Prisma then throws its own
 * transaction-already-closed error, which is neither a `WebhookDeliveryError`
 * nor any other `ApiError`, so `translateNotFound()` (P2025-only) passes it
 * through and app.ts's `onError` answers a generic 500 instead of the
 * documented 502.
 *
 * Setting the transaction budget well above the webhook timeout keeps the
 * dispatcher's own AbortSignal the first clock to fire, so a slow receiver
 * always surfaces as `WebhookDeliveryError` → 502 with the transaction rolled
 * back, exactly as documented. main.ts warns at startup when a configured
 * `SHIPWRIGHT_TASK_STORE_WEBHOOK_TIMEOUT_MS` erodes that headroom (see
 * `checkWebhookTimeoutBuffer`).
 *
 * `maxWait` is deliberately left at Prisma's 2000ms default: it bounds
 * acquiring a pool connection *before* the transaction opens, which the
 * webhook call happens after and therefore cannot affect.
 */
export const WEBHOOK_TX_TIMEOUT_MS = 10_000;

/**
 * The options object handed to each dispatching `$transaction` call. Shared
 * so all eight write paths stay on one value — a per-call literal would let
 * them drift apart silently.
 */
const WEBHOOK_TX_OPTIONS = { timeout: WEBHOOK_TX_TIMEOUT_MS } as const;

/**
 * Per-task budget added on top of `WEBHOOK_TX_TIMEOUT_MS` for `bulk()`.
 *
 * The eight single-item write paths above each do a bounded amount of work
 * (one or two queries plus the dispatcher call), so one fixed budget fits
 * them all. `bulk()` does not: since TSW-1.3 it runs N creates + N session
 * upserts inside ONE transaction before the dispatcher is even called, so
 * its work scales with `tasks.length` while the fixed budget would not.
 * Left fixed, a large-enough batch would blow the 10s budget and surface as
 * a raw Prisma transaction-timeout error — which is neither a
 * `WebhookDeliveryError` nor any other `ApiError`, so app.ts's `onError`
 * would answer a generic 500 instead of the documented 409/502.
 *
 * 100ms per task is heavy overprovisioning against a measured create +
 * upsert pair (single-digit ms on a healthy Postgres), so the batch's own
 * inserts can't be what exhausts the budget; the `WEBHOOK_TX_TIMEOUT_MS`
 * floor still covers the dispatcher round-trip exactly as before, keeping
 * the dispatcher's own AbortSignal the first clock to fire.
 */
export const BULK_TX_PER_TASK_TIMEOUT_MS = 100;

/**
 * Hard cap on tasks per `bulk()` call. Bounds the worst-case transaction
 * budget (and therefore how long one call can hold a pool connection) at
 * `WEBHOOK_TX_TIMEOUT_MS + MAX_BULK_TASKS * BULK_TX_PER_TASK_TIMEOUT_MS` —
 * without it, `bulkTxTimeoutMs()` would scale without limit. Sized well
 * above any real caller: the plan/entropy/error/security/consolidation-fix
 * skills that POST /tasks/bulk file tens of tasks per call, not hundreds.
 * Over the cap is a caller error, so it's a clean 400 rather than a
 * transaction left to time out.
 */
export const MAX_BULK_TASKS = 500;

/**
 * Transaction budget for a `bulk()` call of `taskCount` tasks: the shared
 * single-item floor plus a per-task allowance. Exported for the
 * timeout-conformance tests.
 */
export function bulkTxTimeoutMs(taskCount: number): number {
  return (
    WEBHOOK_TX_TIMEOUT_MS + Math.max(0, taskCount) * BULK_TX_PER_TASK_TIMEOUT_MS
  );
}

/**
 * Parses an `updatedSince` filter value into a Date, matching the
 * BadRequestError(400) pattern used for `repo`/`prNumber` validation
 * elsewhere in the request stack rather than letting an unparseable value
 * surface as an Invalid Date that Prisma throws on (caught only by the
 * generic 500 handler).
 */
function parseUpdatedSince(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(
      `updatedSince '${value}' is not a valid ISO timestamp`,
    );
  }
  return date;
}

/**
 * In-memory equivalent of buildRepoOrgWhere's repo/org matching, evaluated
 * against a single already-resolved Task rather than built as a Prisma
 * where-clause fragment. Semantics are intentionally identical:
 *   - repo (string): exact match against task.repo
 *   - repo (string[]): true if task.repo is any of the listed repos
 *   - org (string | string[]): true if task.repo starts with "<org>/" for
 *     any of the listed orgs
 *   - repo AND org both present: both must match (AND, not OR)
 *   - neither present: true (no restriction)
 * Empty arrays are treated the same as absent, matching buildRepoOrgWhere.
 */
function matchesRepoOrg(
  task: { repo: string | null },
  repo: string | string[] | undefined,
  org: string | string[] | undefined,
): boolean {
  if (typeof repo === "string") {
    if (task.repo !== repo) return false;
  } else if (repo && repo.length > 0) {
    if (task.repo === null || !repo.includes(task.repo)) return false;
  }

  if (org) {
    const orgs = typeof org === "string" ? [org] : org;
    if (orgs.length > 0) {
      if (task.repo === null) return false;
      const repoValue = task.repo;
      if (!orgs.some((o) => repoValue.startsWith(`${o}/`))) return false;
    }
  }

  return true;
}

/**
 * When an agent token has no repo scope (repos undefined/empty), a
 * caller-supplied `assignee` filter must not AND-narrow on top of the
 * agentId match — doing so would silently produce an always-empty result
 * whenever the caller passes an assignee that differs from the token's own
 * agentId, instead of falling back to the token's own tasks (see
 * planning/task-store-ready-filters/PLAN.md's "assignee's combination with
 * agentId/repos scoping" section). Strips `assignee` from the filters object
 * in that case; leaves filters untouched when repos is present/non-empty
 * (repo-scoped AND-narrowing still applies) or when agentId is absent
 * (admin token — assignee applies as a standalone filter).
 */
function effectiveFilters(
  agentId: string | undefined,
  repos: string[] | undefined,
  filters: TaskListPostFilters | undefined,
): TaskListPostFilters | undefined {
  if (!filters) return filters;
  if (agentId && (repos === undefined || repos.length === 0)) {
    const { assignee: _assignee, ...rest } = filters;
    return rest;
  }
  return filters;
}

/**
 * Post-filter predicate shared by TaskService.listReady() and
 * TaskService.listBlocked() — see TaskListPostFilters' doc comment for why
 * this is applied after dependency resolution instead of being folded into
 * the initial findMany(). Every set field is AND'd together; undefined/
 * absent fields impose no restriction.
 */
function matchesTaskFilters(task: Task, filters: TaskListPostFilters): boolean {
  if (filters.session !== undefined && task.session !== filters.session)
    return false;
  if (filters.source !== undefined && task.source !== filters.source)
    return false;
  if (filters.claimedBy !== undefined && task.claimedBy !== filters.claimedBy)
    return false;
  if (filters.pr !== undefined && task.pr !== filters.pr) return false;
  if (filters.branch !== undefined && task.branch !== filters.branch)
    return false;
  if (filters.assignee !== undefined && task.assignee !== filters.assignee)
    return false;
  if (filters.hitl !== undefined && task.hitl !== filters.hitl) return false;
  if (filters.kind !== undefined && task.kind !== filters.kind) return false;
  if (!matchesRepoOrg(task, filters.repo, filters.org)) return false;
  return true;
}

/**
 * True when `accountId` restricts a query to one account (SSP-6.5). Any
 * string counts — including NO_ACCESS_ACCOUNT_ID (""), which deliberately
 * matches no rows. null/undefined = unrestricted (admin token).
 */
function isAccountScoped(
  accountId: string | null | undefined,
): accountId is string {
  return typeof accountId === "string";
}

/** Keeps only the rows in `accountId` — dependencies never cross accounts. */
function sameAccount(tasks: Task[], accountId: string): Task[] {
  return tasks.filter((t) => t.accountId === accountId);
}

/**
 * Partitions tasks by accountId, preserving each partition's input order, so
 * an unrestricted (admin) whole-table load still resolves every dependency
 * graph within a single account.
 */
function groupByAccount(tasks: Task[]): Map<string, Task[]> {
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    const group = groups.get(t.accountId);
    if (group) group.push(t);
    else groups.set(t.accountId, [t]);
  }
  return groups;
}

/** P2002 = Prisma unique-constraint violation (here: Task.id already exists). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

/** A Task augmented with a computed blockedBy array. */
export type TaskWithBlockedBy = Task & { blockedBy: BlockedByEntry[] };

/**
 * Filters shared by TaskService.listReady() and TaskService.listBlocked(),
 * applied as an in-memory post-filter over the already-resolved
 * ready/blocked array (see listReady()/listBlocked() below) — never folded
 * into the initial findMany(), since both dependency resolution and
 * computeBlockedBy need the complete task graph (a filtered-out task may
 * still be a dependency of an in-scope task, and must still contribute a
 * blockedBy entry for it).
 *
 * Deliberately excludes status/state/limit/offset/sort/updatedSince/
 * agentScope: the ready/blocked sets' status semantics are structural (see
 * ready.ts / listBlocked()'s doc comment) — status/state itself is never a
 * user-settable narrowing filter here, since it's what defines the ready/
 * blocked set in the first place. Pagination/sort don't apply to these
 * whole-graph convenience endpoints (see docs/task-store.md), and
 * agentId/repos scoping already has its own dedicated parameters mirroring
 * the pre-existing signatures.
 *
 * `hitl` IS included, unlike the structural fields above: computeBlockedBy()
 * already sets a {type:"hitl"} blockedBy entry whenever task.hitl === true
 * (blocked-by.ts:66-68), so narrowing the already-resolved ready/blocked set
 * by task.hitl is a plain equality AND-filter — the same shape as the other
 * fields below (session/source/claimedBy/pr/branch/assignee), not a
 * structural change to which tasks are considered ready/blocked in the
 * first place.
 */
export interface TaskListPostFilters {
  session?: string;
  source?: string;
  /** Array-any-match, mirrors buildRepoOrgWhere's `{ repo: { in: repos } }`. */
  repo?: string | string[];
  /** startsWith "<org>/" match, mirrors buildRepoOrgWhere's OR clause. Combines with `repo` via AND. */
  org?: string | string[];
  claimedBy?: string;
  pr?: number;
  branch?: string;
  assignee?: string;
  hitl?: boolean;
  /** TaskKind narrowing (TKD-1.1). Note `kind: "prd"` always yields an empty
   * ready set — ready.ts excludes that slice structurally. */
  kind?: TaskKind;
}

/** Filters accepted by TaskService.list. */
export interface TaskListFilters {
  status?: string;
  /** High-level lifecycle filter: "open" | "closed" | "in_progress". */
  state?: "open" | "closed" | "in_progress";
  source?: string;
  session?: string;
  /**
   * Repo filter. A single string preserves the original exact-match
   * behavior (`where.repo = repo`, unchanged for back-compat); an array
   * matches any repo in the list (`where.repo = { in: repos }` via
   * buildRepoOrgWhere).
   */
  repo?: string | string[];
  /**
   * Org filter — matches any repo whose `org/repo` string starts with
   * `"<org>/"`. Combines with `repo` (both narrow the same AND-scoped
   * result) via buildRepoOrgWhere.
   */
  org?: string | string[];
  assignee?: string;
  claimedBy?: string;
  pr?: number;
  branch?: string;
  hitl?: boolean;
  /** TaskKind narrowing (TKD-1.1) — `?kind=dev` / `?kind=prd`. */
  kind?: TaskKind;
  limit?: number;
  offset?: number;
  /** Order results by createdAt. Defaults to "asc" (existing behavior). */
  sort?: "asc" | "desc";
  /**
   * ISO timestamp. Only return tasks with updatedAt >= this value. A
   * conservative pre-filter (not a precise sync anchor) — see
   * planning/task-store-date-filtering/PLAN.md for the root-cause/design
   * rationale. Omitting it preserves current (unfiltered) behavior.
   */
  updatedSince?: string;
  /**
   * Repo-scoped visibility for agent tokens.
   * When set, replaces the simple `assignee` filter with an OR clause:
   *   - tasks explicitly assigned to this agent, OR
   *   - any pool task whose repo is in the agent's scope (regardless of assignee)
   * A separate `?repo=X` filter still applies as an additional AND condition.
   */
  agentScope?: { agentId: string; repos: string[] };
  /**
   * Account (tenant) scope (SSP-6.5). A string restricts the result to rows
   * with that accountId; null/undefined is unrestricted (admin token without
   * `?accountId=`). Applied as an AND condition on top of every other
   * filter, including agentScope.
   */
  accountId?: string | null;
}

/** Paginated list result from TaskService.list. */
export interface TaskListResult {
  tasks: TaskWithBlockedBy[];
  total: number;
  limit: number;
  offset: number;
}

/** Result from TaskService.getEvents. */
export interface GetTaskEventsResult {
  events: TaskEvent[];
  total: number;
}

/** The subset of TaskService the routes depend on. */
export interface TaskServiceLike {
  list(filters?: TaskListFilters): Promise<TaskListResult>;
  listReady(
    agentId?: string,
    repos?: string[],
    filters?: TaskListPostFilters,
    accountId?: string | null,
  ): Promise<Task[]>;
  listBlocked(
    agentId?: string,
    repos?: string[],
    sort?: "asc" | "desc",
    filters?: TaskListPostFilters,
    accountId?: string | null,
  ): Promise<TaskWithBlockedBy[]>;
  distinct(
    agentId?: string,
    scopeRepos?: string[],
    accountId?: string | null,
  ): Promise<{ sessions: string[]; repos: string[]; orgs: string[] }>;
  get(id: string, accountId?: string | null): Promise<TaskWithBlockedBy | null>;
  create(data: Prisma.TaskCreateInput): Promise<Task>;
  bulk(
    tasks: Prisma.TaskCreateInput[],
  ): Promise<{ inserted: number; updated: number; skipped: string[] }>;
  update(id: string, data: Prisma.TaskUpdateInput): Promise<Task>;
  remove(id: string): Promise<void>;
  claim(id: string, claimedBy: string): Promise<Task>;
  heartbeat(id: string): Promise<Task>;
  complete(id: string): Promise<Task>;
  fail(id: string, reason?: string): Promise<Task>;
  release(id: string): Promise<Task>;
  recordSkip(id: string, reason?: string): Promise<Task>;
  resetSkip(id: string): Promise<Task>;
  unblock(id: string): Promise<Task>;
  getEvents(
    id: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<GetTaskEventsResult>;
}

export class TaskService implements TaskServiceLike {
  private sessionService: SessionService;

  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
    // Injected outbound event dispatcher (TSW-1.1). Defaults to a no-op so
    // existing call sites (`new TaskService(prisma)` /
    // `new TaskService(prisma, clock)`) are unaffected. Not yet invoked from
    // any method here — wiring specific task-store events to fire it is
    // future work.
    private webhookDispatcher: WebhookDispatcher = async () => {},
    // POM-1.1: the origin-stamping dependency update() calls on a pr_open
    // transition. Defaults to a real PullRequestService built over the same
    // `prisma`/`clock` — mirrors SessionService's internally-constructed
    // pattern above, so every existing `new TaskService(prisma)` /
    // `new TaskService(prisma, clock)` call site is unaffected. Tests can
    // inject a minimal PrOriginStamper double instead of a full
    // PullRequestServiceLike fake.
    private pullRequestService: PrOriginStamper = new PullRequestService(
      prisma,
      clock,
    ),
  ) {
    this.sessionService = new SessionService(prisma, clock);
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async list(filters: TaskListFilters = {}): Promise<TaskListResult> {
    const where: Prisma.TaskWhereInput = {};
    if (filters.status) {
      // status takes precedence over state when both are provided
      where.status = filters.status as Task["status"];
    } else if (filters.state === "open") {
      where.status = { in: [...OPEN_STATUSES] };
    } else if (filters.state === "closed") {
      where.status = { in: [...CLOSED_STATUSES] };
    } else if (filters.state === "in_progress") {
      where.status = { in: ["in_progress", "pr_open", "approved"] };
    }
    if (filters.source) where.source = filters.source;
    if (filters.session) where.session = filters.session;
    if (filters.claimedBy) where.claimedBy = filters.claimedBy;
    if (filters.pr !== undefined) where.pr = filters.pr;
    if (filters.branch !== undefined) where.branch = filters.branch;
    if (filters.hitl !== undefined) where.hitl = filters.hitl;
    if (filters.kind !== undefined) where.kind = filters.kind;
    if (filters.updatedSince) {
      where.updatedAt = { gte: parseUpdatedSince(filters.updatedSince) };
    }

    if (filters.agentScope) {
      // Repo-scoped visibility: include tasks explicitly assigned to the agent,
      // OR any task whose repo is in the agent's scope (regardless of assignee).
      // Write access is still enforced separately via requireOwnership.
      where.OR = [
        { assignee: filters.agentScope.agentId },
        { repo: { in: filters.agentScope.repos } },
      ];
    }
    // A ?repo=X or ?assignee=X filter still applies as an additional AND
    // condition on top of agentScope's OR — narrowing an already-visible set
    // is always safe, even though widening it (peeking at an unscoped
    // assignee) is not.
    //
    // A single-string `repo` preserves the original exact-match shape
    // (`where.repo = "org/repo"`) for back-compat with existing callers/
    // tests. Anything else (an array, or an `org` filter) is routed through
    // buildRepoOrgWhere. That fragment can itself carry a top-level `OR` (org
    // matching is `repo: { startsWith }` OR'd across orgs) — spreading it
    // directly onto `where` would silently clobber agentScope's `where.OR`
    // if both are present, so in that case the two OR clauses are combined
    // under `where.AND` instead; otherwise the fragment is spread directly
    // onto `where`, matching the plain `{ repo: { in: [...] } }` /
    // `{ OR: [...] }` shape asserted by the unit tests.
    if (typeof filters.repo === "string") {
      where.repo = filters.repo;
    } else if (filters.repo || filters.org) {
      const repoOrgWhere = buildRepoOrgWhere({
        repos: filters.repo,
        orgs: typeof filters.org === "string" ? [filters.org] : filters.org,
      });
      if ("OR" in repoOrgWhere && where.OR) {
        where.AND = [{ OR: where.OR }, repoOrgWhere];
        where.OR = undefined;
      } else {
        Object.assign(where, repoOrgWhere);
      }
    }
    if (filters.assignee) where.assignee = filters.assignee;
    if (isAccountScoped(filters.accountId)) where.accountId = filters.accountId;

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    // pageTasks + total are the only two queries that share the `where`
    // filter, so batching them in a transaction is what actually mattered
    // here — the old third whole-table findMany() depended on nothing else
    // in the array and gained no consistency guarantee from sharing a
    // transaction with it (Postgres already gives each individual query its
    // own consistent snapshot). Splitting it out lets us compute depIds from
    // the real pageTasks result first, then scope the dependency lookup by
    // id — mirroring get()'s `where: { id: { in: task.dependencies } }`
    // pattern — instead of always pulling every row in the table.
    const [pageTasks, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        orderBy: { createdAt: filters.sort ?? "asc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.task.count({ where }),
    ]);

    const depIds = [
      ...new Set(pageTasks.flatMap((t: Task) => t.dependencies ?? [])),
    ];
    const allTasks = depIds.length
      ? await this.prisma.task.findMany({ where: { id: { in: depIds } } })
      : [];

    // Dependencies only ever resolve within the dependent's own account —
    // a same-id row in another account must never satisfy (or even
    // describe) the dependency (SSP-6.5).
    const tasks: TaskWithBlockedBy[] = pageTasks.map((t: Task) => ({
      ...t,
      blockedBy: computeBlockedBy(t, sameAccount(allTasks, t.accountId)),
    }));

    return { tasks, total, limit, offset };
  }

  /**
   * Ready tasks: status === "pending" AND all dependency IDs resolve to tasks
   * with a satisfied status. Ports resolveReadyTasks from store.ts.
   *
   * The task-store has no GitHub access, so cross-branch pr_open deps are never
   * treated as merged (isPrMerged resolves to false).
   *
   * When `repos` is provided (repo-scoped agent token), unassigned pool tasks
   * whose repo is in the repos list are also included.
   *
   * `filters` (session/source/repo/org/claimedBy/pr/branch/assignee) is
   * applied as an additional AND condition, strictly *after*
   * resolveReadyTasks() has resolved the graph — see TaskListPostFilters'
   * doc comment for why this can't be folded into the initial findMany().
   * repo/org matching mirrors buildRepoOrgWhere's semantics (array-any-match
   * for repo; startsWith "<org>/" for org; AND between the two), just
   * evaluated in-memory against already-resolved Task objects rather than
   * built as a Prisma where-clause.
   *
   * Tasks are returned in ascending createdAt order (oldest first) to ensure
   * deterministic selection regardless of insertion order.
   */
  async listReady(
    agentId?: string,
    repos?: string[],
    filters?: TaskListPostFilters,
    accountId?: string | null,
  ): Promise<Task[]> {
    // Load the caller's whole account graph (or every account, for an
    // unrestricted admin caller) so dependency resolution sees every task it
    // could depend on, then filter the result set to the caller's agent if
    // one is specified. The accountId filter is applied BEFORE resolution
    // (SSP-6.5) — and an unrestricted load is still resolved per account —
    // so one tenant's task ids can never satisfy another tenant's
    // dependencies or same-branch exclusivity check.
    const tasks = await this.prisma.task.findMany({
      where: isAccountScoped(accountId) ? { accountId } : {},
      orderBy: { createdAt: "asc" },
    });
    const readyIds = new Set<string>();
    for (const accountTasks of groupByAccount(tasks).values()) {
      const accountReady = await resolveReadyTasks(
        accountTasks,
        async () => false,
        () => this.clock.now(),
      );
      for (const t of accountReady) readyIds.add(t.id);
    }
    // Re-derive from `tasks` to keep the global ascending createdAt order.
    const ready = tasks.filter((t) => readyIds.has(t.id));
    const scoped = agentId
      ? ready.filter(
          (t) =>
            t.assignee === agentId ||
            (repos !== undefined &&
              t.assignee === null &&
              t.repo !== null &&
              repos.includes(t.repo)),
        )
      : ready;
    const effective = effectiveFilters(agentId, repos, filters);
    return effective
      ? scoped.filter((t) => matchesTaskFilters(t, effective))
      : scoped;
  }

  /**
   * Blocked tasks: status === "blocked" OR (status is open/non-terminal AND
   * blockedBy.length > 0).
   *
   * Captures explicitly blocked tasks, HITL-gated tasks, and dep-blocked tasks
   * at any non-terminal status (pending, in_progress, pr_open, approved) — not
   * just "pending". A task can be claimed and moved to in_progress/pr_open
   * while still hitl-gated (dispatch's resolveReadyTasks already excludes
   * hitl:true tasks regardless of status), so listBlocked must surface that
   * signal at any open status too, not silently drop it. Terminal statuses
   * (CLOSED_STATUSES) are always excluded even if blockedBy is non-empty.
   *
   * Loads the full task graph so computeBlockedBy can resolve all dependency IDs.
   *
   * Agent tokens are scoped to their own tasks: pass agentId to filter by assignee.
   *
   * `filters` (session/source/repo/org/claimedBy/pr/branch/assignee) is
   * applied as an additional AND condition, strictly *after* the full task
   * graph is loaded and computeBlockedBy has resolved it — see
   * TaskListPostFilters' doc comment for why this can't be folded into the
   * initial findMany(). repo/org matching mirrors buildRepoOrgWhere's
   * semantics (array-any-match for repo; startsWith "<org>/" for org; AND
   * between the two), just evaluated in-memory against already-resolved Task
   * objects rather than built as a Prisma where-clause.
   */
  async listBlocked(
    agentId?: string,
    repos?: string[],
    sort?: "asc" | "desc",
    filters?: TaskListPostFilters,
    accountId?: string | null,
  ): Promise<TaskWithBlockedBy[]> {
    // accountId narrows the graph BEFORE computeBlockedBy (SSP-6.5); an
    // unrestricted load still resolves each task within its own account.
    const allTasks = await this.prisma.task.findMany({
      where: isAccountScoped(accountId) ? { accountId } : {},
      orderBy: { createdAt: sort ?? "asc" },
    });
    const byAccount = groupByAccount(allTasks);
    const useRepoScope =
      agentId !== undefined && repos !== undefined && repos.length > 0;
    const closedStatuses = new Set<string>(CLOSED_STATUSES);
    const effective = effectiveFilters(agentId, repos, filters);
    return allTasks
      .map((t: Task) => ({
        ...t,
        blockedBy: computeBlockedBy(t, byAccount.get(t.accountId) ?? []),
      }))
      .filter((t: TaskWithBlockedBy) => {
        if (agentId) {
          const ownedByAssignee = t.assignee === agentId;
          const inRepoScope =
            useRepoScope && t.repo !== null && repos?.includes(t.repo);
          if (!ownedByAssignee && !inRepoScope) return false;
        }
        if (effective && !matchesTaskFilters(t, effective)) return false;
        if (t.status === "blocked") return true;
        if (closedStatuses.has(t.status)) return false;
        return t.blockedBy.length > 0;
      });
  }

  async distinct(
    agentId?: string,
    scopeRepos?: string[],
    accountId?: string | null,
  ): Promise<{ sessions: string[]; repos: string[]; orgs: string[] }> {
    const useRepoScope =
      agentId !== undefined &&
      scopeRepos !== undefined &&
      scopeRepos.length > 0;
    let where: Prisma.TaskWhereInput = {};
    if (agentId) {
      where = useRepoScope
        ? { OR: [{ assignee: agentId }, { repo: { in: scopeRepos } }] }
        : { assignee: agentId };
    }
    if (isAccountScoped(accountId)) where = { ...where, accountId };
    const rows = await this.prisma.task.findMany({
      where,
      select: { session: true, repo: true },
    });
    const sessions = [
      ...new Set(
        rows.map((r) => r.session).filter((s): s is string => s !== null),
      ),
    ]
      .sort()
      .slice(0, 100);
    const repos = [
      ...new Set(
        rows.map((r) => r.repo).filter((r): r is string => r !== null),
      ),
    ]
      .sort()
      .slice(0, 100);
    // Derived from the same (already-capped) repos list — the "org" segment
    // is whatever precedes the first `/` in each `org/repo` string. A repo
    // string with no `/` has no org segment and is skipped.
    const orgs = [
      ...new Set(
        repos
          .filter((r) => r.includes("/"))
          .map((r) => r.split("/", 1)[0] as string),
      ),
    ].sort();
    return { sessions, repos, orgs };
  }

  /**
   * `accountId` (SSP-6.5): when set, a task in any other account is reported
   * as missing (null → 404 at the route), never as forbidden, so its
   * existence isn't revealed. null/undefined = unrestricted (admin).
   */
  async get(
    id: string,
    accountId?: string | null,
  ): Promise<TaskWithBlockedBy | null> {
    // findUnique on the id PK plus a non-unique accountId filter (Prisma's
    // extended unique where) — a row in another account reads as missing.
    const task = await this.prisma.task.findUnique({
      where: isAccountScoped(accountId) ? { id, accountId } : { id },
    });
    if (!task) return null;
    // Scope the dependency lookup to only the IDs this task depends on —
    // avoids a full-table scan when GET /tasks/:id is called frequently.
    const allTasks = task.dependencies?.length
      ? await this.prisma.task.findMany({
          where: { id: { in: task.dependencies }, accountId: task.accountId },
        })
      : [];
    return { ...task, blockedBy: computeBlockedBy(task, allTasks) };
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /**
   * Wrapped in a $transaction so a non-blank `data.session` upserts the
   * corresponding Session row (create-if-missing, un-archive-on-write —
   * see SessionService.upsert()) atomically with the task create. A blank
   * session (null/undefined/whitespace-only) is a no-op for the Session
   * table, so this is functionally unchanged for callers not using session.
   */
  async create(data: Prisma.TaskCreateInput): Promise<Task> {
    return this.prisma.$transaction(async (tx) => {
      let task: Task;
      try {
        task = await tx.task.create({ data });
      } catch (err: unknown) {
        // Same P2002 → 409 translation as bulk() below (SSP-6.5): previously
        // an id collision here surfaced as an unhandled 500.
        if (isUniqueViolation(err)) {
          throw new ConflictError(`task '${data.id}' already exists`);
        }
        throw err;
      }
      await this.sessionService.upsert(tx, task.session);
      // Fires after the task row + its session upsert have both landed, still
      // inside this transaction — a thrown WebhookDeliveryError propagates
      // uncaught here, so Prisma rolls back the create (and the session
      // upsert) rather than leaving a task row an undelivered webhook never
      // announced.
      await this.webhookDispatcher("task.write", [task]);
      return task;
    }, WEBHOOK_TX_OPTIONS);
  }

  /**
   * TSW-1.3: the whole bulk call runs inside ONE $transaction — not one
   * $transaction per item (that was the pre-existing partial-success
   * behavior, which this replaces). Every task's create() + its Session
   * upsert are attempted in order; a P2002 collision on any single task
   * (translated to ConflictError below, mirroring
   * PullRequestService.claim()'s create-path P2002 handling) propagates
   * uncaught out of the transaction callback, so Prisma rolls back every
   * insert already made earlier in the same call — the whole batch is
   * all-or-nothing. There is no more partial-success/skip outcome: a
   * collision anywhere in the batch fails the entire call with 409, and the
   * caller is expected to fix the collision and retry the whole batch (the
   * skills that call this endpoint already treat a non-2xx response as
   * "log, stop, rerun is idempotent" — see TSW-1.3 planning notes).
   *
   * Once every task has been created successfully, the dispatcher is called
   * exactly once with the full array of created rows — mirrors create()'s
   * single-item `webhookDispatcher("task.write", [task])` call, just with
   * N rows instead of one. A thrown WebhookDeliveryError from that call also
   * propagates uncaught, rolling back the entire batch (same rollback-on-
   * throw contract as create()/update()/claim() above).
   *
   * Unlike the single-item write paths, this one does NOT use the shared
   * fixed `WEBHOOK_TX_OPTIONS`: the amount of work inside the transaction
   * now scales with `tasks.length`, so the budget scales with it too (see
   * `bulkTxTimeoutMs`), bounded by the `MAX_BULK_TASKS` cap enforced below.
   */
  async bulk(
    tasks: Prisma.TaskCreateInput[],
  ): Promise<{ inserted: number; updated: number; skipped: string[] }> {
    // Rejected before the transaction opens: an over-cap batch is a caller
    // error, and answering 400 up front is strictly better than opening a
    // transaction whose budget we've deliberately declined to extend that
    // far (which would time out into a generic 500 instead).
    if (tasks.length > MAX_BULK_TASKS) {
      throw new BadRequestError(
        `bulk insert accepts at most ${MAX_BULK_TASKS} tasks per call (received ${tasks.length}) — split the batch`,
      );
    }
    const createdRows = await this.prisma.$transaction(
      async (tx) => {
        const rows: Task[] = [];
        for (const task of tasks) {
          let created: Task;
          try {
            created = await tx.task.create({ data: task });
          } catch (err: unknown) {
            // P2002 = unique constraint violation (id already exists) —
            // translate to ConflictError so it propagates uncaught and rolls
            // back the whole transaction, rather than being swallowed/skipped.
            if (isUniqueViolation(err)) {
              throw new ConflictError(
                `task '${task.id}' already exists — bulk() is all-or-nothing, the whole batch was rolled back`,
              );
            }
            throw err;
          }
          await this.sessionService.upsert(tx, created.session);
          rows.push(created);
        }
        // Fires once for the whole batch, after every row has landed, still
        // inside this transaction — see JSDoc above.
        await this.webhookDispatcher("task.write", rows);
        return rows;
      },
      { timeout: bulkTxTimeoutMs(tasks.length) },
    );
    // skipped is always [] on success now — kept only for response-shape
    // backward compatibility (AC4); collisions hard-fail the whole batch via
    // ConflictError above instead of populating it.
    return { inserted: createdRows.length, updated: 0, skipped: [] };
  }

  async update(id: string, data: Prisma.TaskUpdateInput): Promise<Task> {
    // PATCH bodies are plain JSON (never Prisma's `{ set: value }` operation
    // wrapper form), so reading fields off `data` as a loose record is safe
    // here, mirroring how routes/tasks.ts already treats PATCH bodies.
    const patch = data as Record<string, unknown>;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.task.findUnique({ where: { id } });

        // POM-1.1: the resulting (status, pr, repo) after this PATCH is
        // applied — "resulting" merges an explicitly-supplied field with
        // whatever is already on the row (undefined in the PATCH means
        // "leave it as-is"; an explicit null is a real value).
        const resultingStatus =
          patch.status !== undefined ? patch.status : existing?.status;
        const resultingPr: number | null =
          patch.pr !== undefined
            ? (patch.pr as number | null)
            : (existing?.pr ?? null);
        const resultingRepo =
          patch.repo !== undefined
            ? (patch.repo as string | null)
            : (existing?.repo ?? null);

        // Closes the invariant PullRequestService.stampOrigin() below
        // depends on holding forever (not just by convention): a PATCH must
        // never leave status='pr_open' with pr null — neither newly
        // supplied in this PATCH nor already present on the row.
        if (resultingStatus === "pr_open" && resultingPr === null) {
          throw new BadRequestError(
            "status: 'pr_open' requires a non-null pr — supply pr in this PATCH or ensure the task already has one",
          );
        }

        const record = await tx.task.update({
          where: { id },
          data,
        });
        // update() has no single owning actor the way claim/release/recordSkip
        // do (a generic PATCH may be issued by any caller) — attribute to the
        // task's current claimant if one holds it, else "system". Mirrors
        // recordSkip()/resetSkip()'s ?? "system" fallback pattern in
        // pull-request-service.ts. A missing task is caught by update()'s own
        // P2025 below, translated to NotFoundError — no separate existence
        // check needed.
        await this.recordTaskTransition(
          tx,
          existing,
          record,
          "update",
          existing?.claimedBy ?? "system",
        );
        // Same rollback-on-throw contract as create() above: a
        // WebhookDeliveryError here propagates uncaught and Prisma rolls
        // back the update.
        await this.webhookDispatcher("task.write", [record]);

        // POM-1.1: TaskService.update() is the first of three stampOrigin()
        // call sites (POM-1.2 wires the third) — dev-task.md's initial
        // pr_open PATCH (status+pr both supplied) and unblock.md's
        // re-affirm-only PATCH (status alone, pr already on the row) both
        // send exactly the payload shape that triggers this: fires only
        // when THIS PATCH explicitly set status:'pr_open' (not on every
        // unrelated PATCH to an already-pr_open task), with a resolvable
        // non-null pr and repo, in the SAME transaction as the task write —
        // no separate API call from either command.
        if (
          patch.status === "pr_open" &&
          resultingPr !== null &&
          typeof resultingRepo === "string"
        ) {
          // SSP-6.3: the PR row belongs to the task's own account.
          await this.pullRequestService.stampOrigin(
            resultingRepo,
            resultingPr,
            { origin: "shipwright" },
            tx,
            record.accountId,
          );
        }

        return record;
      }, WEBHOOK_TX_OPTIONS);
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /**
   * Delete a task. TaskEvent's FK is ON DELETE RESTRICT (TCS-1.1) — a task
   * that has ever been claimed/updated/etc. has audit rows referencing it, so
   * its TaskEvent rows must be deleted first, in the same transaction, or the
   * delete would fail with a foreign-key violation. Unlike an incidental
   * cascade, this is the one call path that explicitly removes a task
   * (`DELETE /tasks/:id`), so deliberately wiping its audit trail here is the
   * caller's explicit intent, not an accidental side effect elsewhere.
   *
   * TSW-1.2: deliberately does NOT call webhookDispatcher — by the time this
   * transaction commits, the Task row is gone, so there's no surviving row
   * to send as `data: [task]`; a "this task was deleted" event is a
   * different, not-yet-specified event shape, not `task.write`.
   */
  async remove(id: string): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.taskEvent.deleteMany({ where: { taskId: id } }),
        this.prisma.task.delete({ where: { id } }),
      ]);
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  // ─── Claim / liveness ────────────────────────────────────────────────────────

  /**
   * Atomically claim a pending task.
   *
   * Single conditional UPDATE — `WHERE id = $1 AND status = 'pending' AND "claimedBy" IS NULL`.
   * If 0 rows are affected the task is either missing or already claimed: distinguish the
   * two with a follow-up read so callers get 404 vs 409.
   *
   * Wrapped in an interactive $transaction (rather than a bare $executeRaw)
   * so the before/after reads and the TaskEvent audit insert land atomically
   * with the conditional UPDATE — mirrors PullRequestService.claim()'s
   * pattern. The conditional UPDATE's WHERE-guard/conflict-detection
   * semantics are unchanged: Postgres, holding the row lock inside the
   * transaction, is still the sole arbiter of a concurrent claim, and a
   * losing writer still observes affected===0 and 404s/409s exactly as
   * before.
   */
  async claim(id: string, claimedBy: string): Promise<Task> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.task.findUnique({ where: { id } });

        const affected = await tx.$executeRaw`
          UPDATE "Task"
          SET status = 'in_progress',
              "claimedBy" = ${claimedBy},
              "claimedAt" = ${now},
              "heartbeatAt" = ${now},
              "startedAt" = COALESCE("startedAt", ${now}),
              "updatedAt" = now()
          WHERE id = ${id} AND status = 'pending' AND "claimedBy" IS NULL
        `;

        if (affected === 0) {
          if (!before) throw new NotFoundError("task not found");
          throw new ConflictError("task is already claimed");
        }

        const after = await tx.task.findUnique({ where: { id } });
        if (!after) throw new NotFoundError("task not found");

        await this.recordTaskTransition(tx, before, after, "claim", claimedBy);

        // Same rollback-on-throw contract as create()/update() above.
        await this.webhookDispatcher("task.write", [after]);

        return after;
      }, WEBHOOK_TX_OPTIONS);
    } catch (err: unknown) {
      if (
        err instanceof NotFoundError ||
        err instanceof ConflictError ||
        err instanceof WebhookDeliveryError
      ) {
        throw err;
      }
      // The Aug 29 500-on-reclaim didn't come from the documented
      // ConflictError/NotFoundError path above — log unexpected claim()
      // failures with enough context (task id + attempted claimedBy) to
      // diagnose a repeat instead of guessing at it.
      console.error(
        `[task-store] claim() failed unexpectedly for task ${id} (claimedBy: ${claimedBy}):`,
        err,
      );
      throw err;
    }
  }

  /**
   * Touch heartbeatAt for liveness. Errors if the task is missing.
   *
   * Deliberately writes NO audit event and stays outside a $transaction: a
   * bare heartbeat only ever changes heartbeatAt, which is excluded from the
   * audit trail (see computeTaskTransitionDiff), so recordTaskTransition()
   * would be a guaranteed no-op here. Skipping it entirely keeps this hot
   * liveness path a single cheap UPDATE. Mirrors
   * PullRequestService.heartbeat()'s identical rationale.
   *
   * TSW-1.2: deliberately does NOT call webhookDispatcher either, for the
   * same reason it's excluded from the TaskEvent audit trail above — it's
   * the hottest-volume write path in the service (every claimed task across
   * the whole agent fleet touches it on a tight interval) and a
   * heartbeatAt-only change is not an audit-worthy event for downstream
   * consumers to react to.
   */
  async heartbeat(id: string): Promise<Task> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.task.update({
        where: { id },
        data: { heartbeatAt: now },
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /** Mark a task done. */
  async complete(id: string): Promise<Task> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Capture the before-state up front — the actor is the current
        // claimant that completed the task. A missing task is caught by
        // update()'s own P2025 below, translated to NotFoundError.
        const before = await tx.task.findUnique({ where: { id } });
        const record = await tx.task.update({
          where: { id },
          data: { status: "done", completedAt: now },
        });
        await this.recordTaskTransition(
          tx,
          before,
          record,
          "complete",
          before?.claimedBy ?? "system",
        );
        // Same rollback-on-throw contract as create()/update()/claim() above.
        await this.webhookDispatcher("task.write", [record]);
        return record;
      }, WEBHOOK_TX_OPTIONS);
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /** Mark a task failed (status=blocked + reason). */
  async fail(id: string, reason?: string): Promise<Task> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.task.findUnique({ where: { id } });
        const record = await tx.task.update({
          where: { id },
          data: {
            status: "blocked",
            blockedAt: now,
            ...(reason ? { blockedReason: reason } : {}),
          },
        });
        await this.recordTaskTransition(
          tx,
          before,
          record,
          "fail",
          before?.claimedBy ?? "system",
        );
        // Same rollback-on-throw contract as create()/update()/claim() above.
        await this.webhookDispatcher("task.write", [record]);
        return record;
      }, WEBHOOK_TX_OPTIONS);
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /**
   * Unclaim a task — always clears claim fields (claimedBy/claimedAt/heartbeatAt).
   * status is reset to 'pending' only if it is 'in_progress'; a terminal status
   * is left untouched.
   */
  async release(id: string): Promise<Task> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.task.findUnique({ where: { id } });
        const updateData: Prisma.TaskUpdateInput = {
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
        };
        if (before?.status === "in_progress") {
          updateData.status = "pending";
        }
        const record = await tx.task.update({
          where: { id },
          data: updateData,
        });
        // Actor is whoever held the claim being given up.
        await this.recordTaskTransition(
          tx,
          before,
          record,
          "release",
          before?.claimedBy ?? "system",
        );
        // Same rollback-on-throw contract as create()/update()/claim() above.
        await this.webhookDispatcher("task.write", [record]);
        return record;
      }, WEBHOOK_TX_OPTIONS);
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /**
   * Record a skip: reason-aware streak update (SRB-1.1) via
   * computeSkipStreak(). When `reason` (defaults to "unspecified" — the
   * route also defaults it, this is a defense-in-depth fallback for direct
   * callers) matches the task's current lastSkipReason, skipCount
   * increments; when it differs (including from no prior reason), a new
   * streak starts at skipCount=1. Either way sets lastSkippedAt to now. When
   * the (possibly-reset) skipCount crosses SKIP_BLOCK_THRESHOLD (3), also
   * sets status:'blocked', hitl:true, and a blockedReason naming the
   * consecutive count and reason, in the same update — mirrors fail()'s
   * status=blocked+reason pattern above. Every call re-evaluates the streak
   * from the task's current state (not a guard), so a prior resetSkip() or a
   * reason change correctly restarts counting from 1.
   *
   * The column write uses `streak.skipCountUpdate` — Prisma's atomic
   * `{ increment: 1 }` on the continue branch, a literal `1` on the reset
   * branch — so two concurrent skips on the same task can't lost-update each
   * other under Read Committed. See `SkipStreakResult.skipCountUpdate`.
   */
  async recordSkip(id: string, reason?: string): Promise<Task> {
    const effectiveReason = reason ?? "unspecified";
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Snapshot before the update — both for the audit diff and to read
        // the current skipCount/lastSkipReason the streak computation needs.
        const before = await tx.task.findUnique({ where: { id } });
        if (!before) throw new NotFoundError("task not found");
        const streak = computeSkipStreak(
          {
            skipCount: before.skipCount,
            lastSkipReason: before.lastSkipReason,
          },
          effectiveReason,
        );
        const data: Prisma.TaskUpdateInput = {
          skipCount: streak.skipCountUpdate,
          lastSkippedAt: now,
          lastSkipReason: streak.lastSkipReason,
        };
        if (streak.blocked) {
          data.status = "blocked";
          data.hitl = true;
          data.blockedReason = streak.blockedReason;
        }
        const updated = await tx.task.update({ where: { id }, data });
        // Actor is the claim holder if any; recordSkip can fire on unclaimed
        // tasks (no actor in scope at the route), in which case attribute to
        // "system".
        await this.recordTaskTransition(
          tx,
          before,
          updated,
          "recordSkip",
          before?.claimedBy ?? "system",
        );
        // Same rollback-on-throw contract as create()/update()/claim() above.
        await this.webhookDispatcher("task.write", [updated]);
        return updated;
      }, WEBHOOK_TX_OPTIONS);
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /** Reset skip tracking — sets skipCount back to 0, lastSkippedAt/lastSkipReason back to null. */
  async resetSkip(id: string): Promise<Task> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.task.findUnique({ where: { id } });
        const record = await tx.task.update({
          where: { id },
          data: { skipCount: 0, lastSkippedAt: null, lastSkipReason: null },
        });
        await this.recordTaskTransition(
          tx,
          before,
          record,
          "resetSkip",
          before?.claimedBy ?? "system",
        );
        // Same rollback-on-throw contract as create()/update()/claim() above.
        await this.webhookDispatcher("task.write", [record]);
        return record;
      }, WEBHOOK_TX_OPTIONS);
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /**
   * Atomically unblock a blocked task, returning it to 'pending'.
   *
   * Single conditional UPDATE — `WHERE id = $1 AND status = 'blocked'` —
   * mirroring claim()'s pattern above. If 0 rows are affected the task is
   * either missing or not currently blocked: distinguish the two with a
   * follow-up read so callers get 404 vs 409, exactly like claim().
   *
   * Deliberately does NOT silently no-op on a non-blocked task the way
   * release()'s pre-atomic-guard behavior did (CRT-1.1): the whole point of
   * this endpoint is a hard 409 when the precondition isn't met, so a caller
   * can't mistake "nothing happened" for "task unblocked".
   *
   * On success, clears every field an agent's failed/blocked attempt could
   * have left behind — blockedReason/blockedAt, claimedBy/claimedAt/
   * heartbeatAt, and the skip-tracking triple (skipCount/lastSkippedAt/
   * lastSkipReason) — in the same statement that flips status back to
   * 'pending', so the row can
   * never land in an intermediate state that violates the DB-level
   * status='pending' iff claimedBy IS NULL invariant (see
   * task-claim-status-invariant.integration.test.ts).
   */
  async unblock(id: string): Promise<Task> {
    return await this.prisma.$transaction(async (tx) => {
      const before = await tx.task.findUnique({ where: { id } });

      const affected = await tx.$executeRaw`
        UPDATE "Task"
        SET status = 'pending',
            "blockedReason" = NULL,
            "blockedAt" = NULL,
            "claimedBy" = NULL,
            "claimedAt" = NULL,
            "heartbeatAt" = NULL,
            "skipCount" = 0,
            "lastSkippedAt" = NULL,
            "lastSkipReason" = NULL,
            "updatedAt" = now()
        WHERE id = ${id} AND status = 'blocked'
      `;

      if (affected === 0) {
        if (!before) throw new NotFoundError("task not found");
        throw new ConflictError("task is not currently blocked");
      }

      const after = await tx.task.findUnique({ where: { id } });
      if (!after) throw new NotFoundError("task not found");

      await this.recordTaskTransition(
        tx,
        before,
        after,
        "unblock",
        before?.claimedBy ?? "system",
      );

      // Same rollback-on-throw contract as create()/update()/claim() above.
      await this.webhookDispatcher("task.write", [after]);

      return after;
    }, WEBHOOK_TX_OPTIONS);
  }

  /**
   * Fetch a task's TaskEvent audit trail (TCS-1.2), ordered by `at` ascending
   * (oldest first) — uses the (taskId, at) index (TCS-1.1). Existence-checks
   * the task first (mirrors PullRequestService.getEvents()) so a missing task
   * surfaces as a clean NotFoundError rather than an empty result being
   * indistinguishable from "task exists but has zero events".
   */
  async getEvents(
    id: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<GetTaskEventsResult> {
    const existing = await this.prisma.task.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError("task not found");
    }

    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const [events, total] = await this.prisma.$transaction([
      this.prisma.taskEvent.findMany({
        where: { taskId: id },
        orderBy: { at: "asc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.taskEvent.count({ where: { taskId: id } }),
    ]);

    return { events, total };
  }

  /**
   * Write the audit trail for a single mutation: diff `before` vs `after` and
   * insert one TaskEvent row per changed, auditable field. Runs on the same
   * `tx` the source update ran on, so the event rows land atomically with the
   * field change (or not at all). Mirrors
   * PullRequestService.recordTransition() exactly. Delegates the actual
   * diff+write to the shared `writeTaskEvents` helper (also used by
   * StaleClaimReaper, TCS-1.3) so the two call sites can't drift.
   *
   * heartbeatAt-only changes produce zero rows (see
   * computeTaskTransitionDiff); a create-path `before === null` also produces
   * zero rows. Every row is stamped with the same `at` timestamp from the
   * injected Clock so an entire transition's rows share one instant, and
   * carries the `method` name and `actor` that drove the write for later
   * diagnostics.
   */
  private async recordTaskTransition(
    tx: PrismaTxClient,
    before: Task | null,
    after: Task,
    method: string,
    actor: string | null,
  ): Promise<void> {
    const at = this.clock.now().toISOString();
    await writeTaskEvents(tx, before, after, method, actor, at);
  }

  /** Map Prisma's P2025 (record not found) to a NotFoundError; re-throw the rest. */
  private translateNotFound(err: unknown, message: string): unknown {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "P2025"
    ) {
      return new NotFoundError(message);
    }
    return err;
  }
}
