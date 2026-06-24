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

import { type Clock, SystemClock } from "./clock.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type { Prisma, PrismaClient, Task } from "./index.ts";
import { resolveReadyTasks } from "./ready.ts";

/** Filters accepted by TaskService.list. */
export interface TaskListFilters {
  status?: string;
  session?: string;
  assignee?: string;
  claimedBy?: string;
  pr?: number;
  branch?: string;
}

/** The subset of TaskService the routes depend on. */
export interface TaskServiceLike {
  list(filters?: TaskListFilters): Promise<Task[]>;
  listReady(agentId?: string): Promise<Task[]>;
  get(id: string): Promise<Task | null>;
  create(data: Prisma.TaskCreateInput): Promise<Task>;
  bulk(
    tasks: Prisma.TaskCreateInput[],
  ): Promise<{ inserted: number; updated: number }>;
  update(id: string, data: Prisma.TaskUpdateInput): Promise<Task>;
  remove(id: string): Promise<void>;
  claim(id: string, claimedBy: string): Promise<Task>;
  heartbeat(id: string): Promise<Task>;
  complete(id: string): Promise<Task>;
  fail(id: string, reason?: string): Promise<Task>;
  release(id: string): Promise<Task>;
}

export class TaskService implements TaskServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  // ─── Reads ─────────────────────────────────────────────────────────────────

  async list(filters: TaskListFilters = {}): Promise<Task[]> {
    const where: Prisma.TaskWhereInput = {};
    if (filters.status) where.status = filters.status as Task["status"];
    if (filters.session) where.session = filters.session;
    if (filters.assignee) where.assignee = filters.assignee;
    if (filters.claimedBy) where.claimedBy = filters.claimedBy;
    if (filters.pr !== undefined) where.pr = filters.pr;
    if (filters.branch !== undefined) where.branch = filters.branch;
    return this.prisma.task.findMany({
      where,
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Ready tasks: status === "pending" AND all dependency IDs resolve to tasks
   * with a satisfied status. Ports resolveReadyTasks from store.ts.
   *
   * The task-store has no GitHub access, so cross-branch pr_open deps are never
   * treated as merged (isPrMerged resolves to false).
   */
  async listReady(agentId?: string): Promise<Task[]> {
    // Load all tasks so dependency resolution sees the full graph, then filter
    // the result set to the caller's agent if one is specified.
    const tasks = await this.prisma.task.findMany();
    const ready = await resolveReadyTasks(tasks, async () => false);
    if (agentId) return ready.filter((t) => t.assignee === agentId);
    return ready;
  }

  async get(id: string): Promise<Task | null> {
    return this.prisma.task.findUnique({ where: { id } });
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  async create(data: Prisma.TaskCreateInput): Promise<Task> {
    return this.prisma.task.create({ data });
  }

  async bulk(
    tasks: Prisma.TaskCreateInput[],
  ): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    for (const task of tasks) {
      try {
        await this.prisma.task.create({ data: task });
        inserted++;
      } catch (err: unknown) {
        // P2002 = unique constraint violation (id already exists) — skip silently
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === "P2002"
        ) {
          continue;
        }
        throw err;
      }
    }
    return { inserted, updated: 0 };
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
   * Single conditional UPDATE — `WHERE id = $1 AND status = 'pending'`. If 0 rows
   * are affected the task is either missing or already claimed: distinguish the
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
      WHERE id = ${id} AND status = 'pending'
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
