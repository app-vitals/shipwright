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
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import type { Prisma, PrismaClient, Task } from "./index.ts";
import { buildRepoOrgWhere } from "./lib/repo-org-filter.ts";
import { resolveReadyTasks } from "./ready.ts";
import { CLOSED_STATUSES, OPEN_STATUSES } from "./statuses.ts";

// Re-export so callers can import from task-service without reaching into blocked-by.
export type { BlockedByEntry };
export { CLOSED_STATUSES, OPEN_STATUSES };

/**
 * Skip-count auto-block threshold: once a task's skipCount reaches this
 * value, recordSkip() also sets status:'blocked' + blockedReason so the loop
 * orchestrator stops re-selecting it. Mirrors SPIN_DETECTION_THRESHOLD in
 * agent/src/loop-orchestrator.ts:179 — duplicated here (not imported) since
 * agent/ and task-store/ are separate deployables.
 */
const SKIP_BLOCK_THRESHOLD = 3;

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
  if (!matchesRepoOrg(task, filters.repo, filters.org)) return false;
  return true;
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
 * Deliberately excludes status/state/hitl/requiresHumanApproval/limit/
 * offset/sort/updatedSince/agentScope: the ready/blocked sets' status/hitl
 * semantics are structural (see ready.ts / listBlocked()'s doc comment),
 * pagination/sort don't apply to these whole-graph convenience endpoints
 * (see docs/task-store.md), and agentId/repos scoping already has its own
 * dedicated parameters mirroring the pre-existing signatures.
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
  requiresHumanApproval?: boolean;
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
}

/** Paginated list result from TaskService.list. */
export interface TaskListResult {
  tasks: TaskWithBlockedBy[];
  total: number;
  limit: number;
  offset: number;
}

/** The subset of TaskService the routes depend on. */
export interface TaskServiceLike {
  list(filters?: TaskListFilters): Promise<TaskListResult>;
  listReady(
    agentId?: string,
    repos?: string[],
    filters?: TaskListPostFilters,
  ): Promise<Task[]>;
  listBlocked(
    agentId?: string,
    repos?: string[],
    sort?: "asc" | "desc",
    filters?: TaskListPostFilters,
  ): Promise<TaskWithBlockedBy[]>;
  distinct(
    agentId?: string,
    scopeRepos?: string[],
  ): Promise<{ sessions: string[]; repos: string[]; orgs: string[] }>;
  get(id: string): Promise<TaskWithBlockedBy | null>;
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
  recordSkip(id: string): Promise<Task>;
  resetSkip(id: string): Promise<Task>;
}

export class TaskService implements TaskServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

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
    if (filters.requiresHumanApproval !== undefined)
      where.requiresHumanApproval = filters.requiresHumanApproval;
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

    const tasks: TaskWithBlockedBy[] = pageTasks.map((t: Task) => ({
      ...t,
      blockedBy: computeBlockedBy(t, allTasks),
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
  ): Promise<Task[]> {
    // Load all tasks so dependency resolution sees the full graph, then filter
    // the result set to the caller's agent if one is specified.
    const tasks = await this.prisma.task.findMany({
      orderBy: { createdAt: "asc" },
    });
    const ready = await resolveReadyTasks(
      tasks,
      async () => false,
      () => this.clock.now(),
    );
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
    return filters
      ? scoped.filter((t) => matchesTaskFilters(t, filters))
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
  ): Promise<TaskWithBlockedBy[]> {
    const allTasks = await this.prisma.task.findMany({
      orderBy: { createdAt: sort ?? "asc" },
    });
    const useRepoScope =
      agentId !== undefined && repos !== undefined && repos.length > 0;
    const closedStatuses = new Set<string>(CLOSED_STATUSES);
    return allTasks
      .map((t: Task) => ({ ...t, blockedBy: computeBlockedBy(t, allTasks) }))
      .filter((t: TaskWithBlockedBy) => {
        if (agentId) {
          const ownedByAssignee = t.assignee === agentId;
          const inRepoScope =
            useRepoScope && t.repo !== null && repos?.includes(t.repo);
          if (!ownedByAssignee && !inRepoScope) return false;
        }
        if (filters && !matchesTaskFilters(t, filters)) return false;
        if (t.status === "blocked") return true;
        if (closedStatuses.has(t.status)) return false;
        return t.blockedBy.length > 0;
      });
  }

  async distinct(
    agentId?: string,
    scopeRepos?: string[],
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

  async get(id: string): Promise<TaskWithBlockedBy | null> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) return null;
    // Scope the dependency lookup to only the IDs this task depends on —
    // avoids a full-table scan when GET /tasks/:id is called frequently.
    const allTasks = task.dependencies?.length
      ? await this.prisma.task.findMany({
          where: { id: { in: task.dependencies } },
        })
      : [];
    return { ...task, blockedBy: computeBlockedBy(task, allTasks) };
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  async create(data: Prisma.TaskCreateInput): Promise<Task> {
    return this.prisma.task.create({ data });
  }

  async bulk(
    tasks: Prisma.TaskCreateInput[],
  ): Promise<{ inserted: number; updated: number; skipped: string[] }> {
    let inserted = 0;
    const skipped: string[] = [];
    for (const task of tasks) {
      try {
        await this.prisma.task.create({ data: task });
        inserted++;
      } catch (err: unknown) {
        // P2002 = unique constraint violation (id already exists) — skip, but
        // record the id so callers can see which tasks collided instead of
        // this being silently swallowed.
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === "P2002"
        ) {
          if (typeof task.id === "string") skipped.push(task.id);
          continue;
        }
        throw err;
      }
    }
    return { inserted, updated: 0, skipped };
  }

  async update(id: string, data: Prisma.TaskUpdateInput): Promise<Task> {
    try {
      return await this.prisma.task.update({ where: { id }, data });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.prisma.task.delete({ where: { id } });
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
   */
  async claim(id: string, claimedBy: string): Promise<Task> {
    const now = this.clock.now().toISOString();
    const affected = await this.prisma.$executeRaw`
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
      const existing = await this.prisma.task.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError("task not found");
      throw new ConflictError("task is already claimed");
    }

    return this.requireTask(id);
  }

  /** Touch heartbeatAt for liveness. Errors if the task is missing. */
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
      return await this.prisma.task.update({
        where: { id },
        data: { status: "done", completedAt: now },
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /** Mark a task failed (status=blocked + reason). */
  async fail(id: string, reason?: string): Promise<Task> {
    const now = this.clock.now().toISOString();
    try {
      return await this.prisma.task.update({
        where: { id },
        data: {
          status: "blocked",
          blockedAt: now,
          ...(reason ? { blockedReason: reason } : {}),
        },
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /** Unclaim a task — reset claim fields and return it to pending. */
  async release(id: string): Promise<Task> {
    try {
      return await this.prisma.task.update({
        where: { id },
        data: {
          status: "pending",
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
        },
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /**
   * Record a skip: atomically increments skipCount and sets lastSkippedAt.
   * When the new skipCount crosses SKIP_BLOCK_THRESHOLD (3), also sets
   * status:'blocked' + a descriptive blockedReason in the same update —
   * mirrors fail()'s status=blocked+reason pattern above. Every call
   * increments regardless of current count (not a guard), and re-checks the
   * threshold each time in case a prior resetSkip() brought the count back
   * down.
   */
  async recordSkip(id: string): Promise<Task> {
    const now = this.clock.now().toISOString();
    try {
      const updated = await this.prisma.task.update({
        where: { id },
        data: { skipCount: { increment: 1 }, lastSkippedAt: now },
      });
      if (updated.skipCount >= SKIP_BLOCK_THRESHOLD) {
        return await this.prisma.task.update({
          where: { id },
          data: {
            status: "blocked",
            blockedReason: `Auto-blocked after ${updated.skipCount} consecutive skips (dispatched but found nothing to do)`,
          },
        });
      }
      return updated;
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  /** Reset skip tracking — sets skipCount back to 0 and lastSkippedAt to null. */
  async resetSkip(id: string): Promise<Task> {
    try {
      return await this.prisma.task.update({
        where: { id },
        data: { skipCount: 0, lastSkippedAt: null },
      });
    } catch (err: unknown) {
      throw this.translateNotFound(err, "task not found");
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async requireTask(id: string): Promise<Task> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new NotFoundError("task not found");
    return task;
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
