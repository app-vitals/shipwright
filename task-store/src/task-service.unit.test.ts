import { describe, expect, it } from "bun:test";
import { computeBlockedBy } from "./blocked-by.ts";
import { BadRequestError } from "./errors.ts";
import type { PrismaClient, Task } from "./index.ts";
import type { ReadyTaskLike } from "./ready.ts";
import { CLOSED_STATUSES, OPEN_STATUSES } from "./statuses.ts";
import { type TaskListFilters, TaskService } from "./task-service.ts";

// ─── Minimal in-memory stub matching only the logic under test ────────────────

interface MinimalTask extends ReadyTaskLike {
  title: string;
  assignee?: string | null;
}

function makeMinimalTask(overrides: Partial<MinimalTask> = {}): MinimalTask {
  return {
    id: "task-1",
    title: "A task",
    status: "pending",
    branch: null,
    dependencies: [],
    pr: null,
    hitl: null,
    blockedReason: null,
    assignee: null,
    ...overrides,
  };
}

function listBlockedLogic(
  allTasks: MinimalTask[],
): (MinimalTask & { blockedBy: ReturnType<typeof computeBlockedBy> })[] {
  const closed = new Set<string>(CLOSED_STATUSES);
  return allTasks
    .filter((t) => {
      if (t.status === "blocked") return true;
      if (closed.has(t.status)) return false;
      const blockedBy = computeBlockedBy(t, allTasks);
      return blockedBy.length > 0;
    })
    .map((t) => ({ ...t, blockedBy: computeBlockedBy(t, allTasks) }));
}

function applyStateFilter(
  tasks: MinimalTask[],
  filters: TaskListFilters,
): MinimalTask[] {
  if (filters.status) {
    return tasks.filter((t) => t.status === filters.status);
  }
  if (filters.state === "open") {
    const open = new Set<string>(OPEN_STATUSES);
    return tasks.filter((t) => open.has(t.status));
  }
  if (filters.state === "closed") {
    const closed = new Set<string>(CLOSED_STATUSES);
    return tasks.filter((t) => closed.has(t.status));
  }
  if (filters.state === "in_progress") {
    const inProgressStatuses = new Set(["in_progress", "pr_open", "approved"]);
    return tasks.filter((t) => inProgressStatuses.has(t.status));
  }
  // state=ready and state=blocked are handled separately in TaskService (not via filter)
  return tasks;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TaskService state filter logic (unit)", () => {
  // ─── state=open (unchanged) ─────────────────────────────────────────────────

  it("state=open returns tasks with open statuses", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "in_progress" }),
      makeMinimalTask({ id: "t3", status: "done" }),
      makeMinimalTask({ id: "t4", status: "merged" }),
    ];
    const result = applyStateFilter(tasks, { state: "open" });
    expect(result.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("state=open includes all OPEN_STATUSES: pending, in_progress, pr_open, approved, blocked", () => {
    const tasks = OPEN_STATUSES.map((s) =>
      makeMinimalTask({ id: `t-${s}`, status: s }),
    );
    const result = applyStateFilter(tasks, { state: "open" });
    expect(result).toHaveLength(OPEN_STATUSES.length);
  });

  // ─── state=closed (unchanged) ───────────────────────────────────────────────

  it("state=closed returns tasks with closed statuses", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "done" }),
      makeMinimalTask({ id: "t3", status: "merged" }),
      makeMinimalTask({ id: "t4", status: "cancelled" }),
    ];
    const result = applyStateFilter(tasks, { state: "closed" });
    expect(result.map((t) => t.id)).toEqual(["t2", "t3", "t4"]);
  });

  it("state=closed includes all CLOSED_STATUSES: merged, done, deploying, deployed, cancelled", () => {
    const tasks = CLOSED_STATUSES.map((s) =>
      makeMinimalTask({ id: `t-${s}`, status: s }),
    );
    const result = applyStateFilter(tasks, { state: "closed" });
    expect(result).toHaveLength(CLOSED_STATUSES.length);
  });

  // ─── state=in_progress ──────────────────────────────────────────────────────

  it("state=in_progress returns tasks with status in_progress", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "in_progress" }),
      makeMinimalTask({ id: "t3", status: "done" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result.map((t) => t.id)).toEqual(["t2"]);
  });

  it("state=in_progress returns tasks with status pr_open", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "pr_open" }),
      makeMinimalTask({ id: "t3", status: "merged" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result.map((t) => t.id)).toEqual(["t2"]);
  });

  it("state=in_progress returns tasks with status approved", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "approved" }),
      makeMinimalTask({ id: "t3", status: "blocked" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result.map((t) => t.id)).toEqual(["t2"]);
  });

  it("state=in_progress returns all three statuses: in_progress, pr_open, approved", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "in_progress" }),
      makeMinimalTask({ id: "t2", status: "pr_open" }),
      makeMinimalTask({ id: "t3", status: "approved" }),
      makeMinimalTask({ id: "t4", status: "pending" }),
      makeMinimalTask({ id: "t5", status: "done" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("state=in_progress returns empty array when no matching tasks", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "done" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result).toHaveLength(0);
  });
});

// ─── listBlocked logic ────────────────────────────────────────────────────────

describe("listBlocked logic (unit)", () => {
  it("returns tasks with status=blocked explicitly", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "blocked" }),
      makeMinimalTask({ id: "t2", status: "pending" }),
      makeMinimalTask({ id: "t3", status: "done" }),
    ];
    const result = listBlockedLogic(tasks);
    expect(result.map((t) => t.id)).toEqual(["t1"]);
    expect(result[0].blockedBy).toEqual([{ type: "blocked", reason: null }]);
  });

  it("returns pending tasks with an HITL gate (hitl=true)", () => {
    const tasks = [
      makeMinimalTask({
        id: "t1",
        status: "pending",
        hitl: true,
      }),
      makeMinimalTask({ id: "t2", status: "pending", hitl: false }),
    ];
    const result = listBlockedLogic(tasks);
    expect(result.map((t) => t.id)).toEqual(["t1"]);
    expect(result[0].blockedBy).toContainEqual({ type: "hitl" });
  });

  it("returns pending tasks with unsatisfied dependencies", () => {
    const dep = makeMinimalTask({ id: "dep-1", status: "in_progress" });
    const blocked = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    const ready = makeMinimalTask({ id: "t2", status: "pending" });
    const tasks = [dep, blocked, ready];
    const result = listBlockedLogic(tasks);
    expect(result.map((t) => t.id)).toEqual(["t1"]);
    expect(result[0].blockedBy).toContainEqual({
      type: "dependency",
      id: "dep-1",
      status: "in_progress",
    });
  });

  it("does not return pending tasks with all deps satisfied (done)", () => {
    const dep = makeMinimalTask({ id: "dep-1", status: "done" });
    const ready = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    const tasks = [dep, ready];
    const result = listBlockedLogic(tasks);
    expect(result).toHaveLength(0);
  });

  it("returns non-pending open-status tasks (in_progress, pr_open, approved) with a hitl gate or unresolved dependency", () => {
    const tasks = [
      makeMinimalTask({
        id: "t1",
        status: "in_progress",
        hitl: true,
      }),
      makeMinimalTask({
        id: "t2",
        status: "pr_open",
        hitl: true,
      }),
      makeMinimalTask({
        id: "t3",
        status: "approved",
        dependencies: ["dep-1"],
      }),
      makeMinimalTask({ id: "dep-1", status: "in_progress" }),
    ];
    const result = listBlockedLogic(tasks);
    const ids = result.map((t) => t.id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
    expect(ids).toContain("t3");
    expect(ids).not.toContain("dep-1");
  });

  it("does not return non-pending open-status tasks with no blockedBy (in_progress, pr_open, approved)", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "in_progress" }),
      makeMinimalTask({ id: "t2", status: "pr_open" }),
      makeMinimalTask({ id: "t3", status: "approved" }),
    ];
    const result = listBlockedLogic(tasks);
    expect(result).toHaveLength(0);
  });

  it("does not return closed-status tasks even with a non-empty blockedBy (hitl gate)", () => {
    const tasks = [
      makeMinimalTask({
        id: "t1",
        status: "merged",
        hitl: true,
      }),
      makeMinimalTask({
        id: "t2",
        status: "done",
        hitl: true,
      }),
      makeMinimalTask({
        id: "t3",
        status: "deploying",
        hitl: true,
      }),
      makeMinimalTask({
        id: "t4",
        status: "deployed",
        hitl: true,
      }),
      makeMinimalTask({
        id: "t5",
        status: "cancelled",
        hitl: true,
      }),
    ];
    const result = listBlockedLogic(tasks);
    expect(result).toHaveLength(0);
  });

  it("returns both explicitly blocked and dep-blocked pending tasks together", () => {
    const dep = makeMinimalTask({ id: "dep-1", status: "pending" });
    const depBlocked = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    const explicitBlocked = makeMinimalTask({ id: "t2", status: "blocked" });
    const unblocked = makeMinimalTask({ id: "t3", status: "pending" });
    const tasks = [dep, depBlocked, explicitBlocked, unblocked];
    const result = listBlockedLogic(tasks);
    const ids = result.map((t) => t.id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
    expect(ids).not.toContain("t3");
    expect(ids).not.toContain("dep-1");
  });

  it("does not return tasks with missing dep IDs if those are unknown → dep-blocked is included", () => {
    const t = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["missing-dep"],
    });
    const result = listBlockedLogic([t]);
    expect(result).toHaveLength(1);
    expect(result[0].blockedBy).toContainEqual({
      type: "dependency",
      id: "missing-dep",
      status: "unknown",
    });
  });

  it("blockedBy is computed and attached to results", () => {
    const dep = makeMinimalTask({ id: "dep-1", status: "in_progress" });
    const t = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    const result = listBlockedLogic([dep, t]);
    expect(result[0]).toHaveProperty("blockedBy");
    expect(result[0].blockedBy).toEqual([
      { type: "dependency", id: "dep-1", status: "in_progress" },
    ]);
  });
});

// ─── TaskService.listBlocked() sort ─────────────────────────────────────────

describe("TaskService.listBlocked() sort (unit)", () => {
  /**
   * Prisma double for listBlocked(): captures the findMany args (in
   * particular orderBy) passed by the service, mirroring the
   * PullRequestService.list() sort unit test pattern
   * (pull-request-service.unit.test.ts). Returns tasks in the order given
   * regardless of orderBy — real ordering is Postgres's job; this double
   * only lets us assert the service *requests* the right orderBy and that
   * the array order it's fed survives listBlocked()'s .map()/.filter().
   */
  function makeListBlockedPrismaDouble(tasks: Task[]) {
    const findManyCalls: Array<{ orderBy?: unknown }> = [];

    const prisma = {
      task: {
        findMany(args: { orderBy?: unknown } = {}) {
          findManyCalls.push(args);
          return Promise.resolve(tasks);
        },
      },
      _findManyCalls: findManyCalls,
    };

    return prisma as unknown as PrismaClient & {
      _findManyCalls: Array<{ orderBy?: unknown }>;
    };
  }

  function makeBlockedTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-1",
      title: "A task",
      status: "blocked",
      source: null,
      session: null,
      repo: null,
      description: null,
      acceptanceCriteria: [],
      layer: null,
      branch: null,
      dependencies: [],
      pr: null,
      hours: null,
      addedAt: null,
      startedAt: null,
      prCreatedAt: null,
      mergedAt: null,
      blockedAt: null,
      blockedReason: null,
      note: null,
      type: null,
      priority: null,
      cancelledAt: null,
      completedAt: null,
      deployingAt: null,
      ciFixAttempts: null,
      mergeCommit: null,
      prUrl: null,
      assignee: null,
      issue: null,
      model: null,
      complexity: null,
      hitl: null,
      claimedBy: null,
      agentHint: null,
      claimedAt: null,
      heartbeatAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    } as Task;
  }

  it("listBlocked({ sort: 'desc' }) requests orderBy: { createdAt: 'desc' } from Prisma", async () => {
    const prisma = makeListBlockedPrismaDouble([]);
    const service = new TaskService(prisma);

    await service.listBlocked(undefined, undefined, "desc");

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(prisma._findManyCalls[0].orderBy).toEqual({ createdAt: "desc" });
  });

  it("listBlocked() with no sort defaults to orderBy: { createdAt: 'asc' } (current behavior)", async () => {
    const prisma = makeListBlockedPrismaDouble([]);
    const service = new TaskService(prisma);

    await service.listBlocked();

    expect(prisma._findManyCalls).toHaveLength(1);
    expect(prisma._findManyCalls[0].orderBy).toEqual({ createdAt: "asc" });
  });

  it("listBlocked({ sort: 'desc' }) returns tasks ordered by createdAt descending", async () => {
    // Simulate Postgres honoring orderBy: desc — the double returns tasks
    // pre-sorted newest-first, proving order survives listBlocked()'s
    // subsequent .map()/.filter() calls (both preserve array order in JS).
    const oldest = makeBlockedTask({
      id: "t-oldest",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const middle = makeBlockedTask({
      id: "t-middle",
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    const newest = makeBlockedTask({
      id: "t-newest",
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });
    const prisma = makeListBlockedPrismaDouble([newest, middle, oldest]);
    const service = new TaskService(prisma);

    const result = await service.listBlocked(undefined, undefined, "desc");

    expect(result.map((t) => t.id)).toEqual([
      "t-newest",
      "t-middle",
      "t-oldest",
    ]);
  });
});

// ─── TaskService.bulk() ─────────────────────────────────────────────────────

describe("TaskService.bulk (unit)", () => {
  it("collects skipped IDs for tasks that collide with a P2002 unique constraint error", async () => {
    const created: string[] = [];
    const fakePrisma = {
      task: {
        create: async ({
          data,
        }: {
          data: { id?: string };
        }) => {
          if (data.id === "dup-task") {
            throw { code: "P2002" };
          }
          created.push(data.id as string);
          return { ...data };
        },
      },
    } as unknown as PrismaClient;

    const service = new TaskService(fakePrisma);
    const result = await service.bulk([
      { id: "dup-task", title: "Duplicate", status: "pending" } as never,
      { id: "new-task", title: "New task", status: "pending" } as never,
    ]);

    expect(result.inserted).toBe(1);
    expect(result.skipped).toEqual(["dup-task"]);
    expect(created).toEqual(["new-task"]);
  });
});

// ─── TaskService.list() updatedSince/repo where clause ─────────────────────

describe("TaskService.list() updatedSince/repo where clause", () => {
  /**
   * Prisma double for list(): captures the findMany args (in particular
   * where) passed by the service, mirroring the
   * $transaction([findMany, count, findMany]) shape list() actually issues
   * (the second findMany loads the full task graph for computeBlockedBy).
   */
  function makeListPrismaDouble() {
    const findManyCalls: Array<{ where?: unknown }> = [];

    const prisma = {
      task: {
        findMany(args: { where?: unknown } = {}) {
          findManyCalls.push(args);
          return Promise.resolve([]);
        },
        count() {
          return Promise.resolve(0);
        },
      },
      $transaction(ops: Promise<unknown>[]) {
        return Promise.all(ops);
      },
      _findManyCalls: findManyCalls,
    };

    return prisma as unknown as PrismaClient & {
      _findManyCalls: Array<{ where?: unknown }>;
    };
  }

  it("list({ updatedSince }) sets where.updatedAt = { gte: new Date(updatedSince) }", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);
    const updatedSince = "2026-07-01T00:00:00.000Z";

    await service.list({ updatedSince });

    // First findMany call is the paginated query with the where clause.
    const where = prisma._findManyCalls[0].where as
      | { updatedAt?: { gte: Date } }
      | undefined;
    expect(where?.updatedAt).toEqual({ gte: new Date(updatedSince) });
  });

  it("list({}) omits where.updatedAt entirely (preserves current unfiltered behavior)", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);

    await service.list({});

    const where = prisma._findManyCalls[0].where as
      | { updatedAt?: unknown }
      | undefined;
    expect(where?.updatedAt).toBeUndefined();
  });

  it("list({ repo, updatedSince }) applies both filters together in where", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);
    const updatedSince = "2026-07-01T00:00:00.000Z";

    await service.list({ repo: "org/repo", updatedSince });

    const where = prisma._findManyCalls[0].where as
      | { repo?: string; updatedAt?: { gte: Date } }
      | undefined;
    expect(where?.repo).toBe("org/repo");
    expect(where?.updatedAt).toEqual({ gte: new Date(updatedSince) });
  });

  it("list({ updatedSince: 'not-a-date' }) throws BadRequestError instead of passing Invalid Date to Prisma", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);

    await expect(service.list({ updatedSince: "not-a-date" })).rejects.toThrow(
      BadRequestError,
    );
  });

  it("list({ hitl: true }) sets where.hitl = true", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);

    await service.list({ hitl: true });

    const where = prisma._findManyCalls[0].where as
      | { hitl?: boolean }
      | undefined;
    expect(where?.hitl).toBe(true);
  });

  it("list({ hitl: false }) sets where.hitl = false", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);

    await service.list({ hitl: false });

    const where = prisma._findManyCalls[0].where as
      | { hitl?: boolean }
      | undefined;
    expect(where?.hitl).toBe(false);
  });

  it("list({}) omits where.hitl entirely (preserves current unfiltered behavior)", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);

    await service.list({});

    const where = prisma._findManyCalls[0].where as
      | { hitl?: boolean }
      | undefined;
    expect(where?.hitl).toBeUndefined();
  });

  it("list({ repo: ['org/a', 'org/b'] }) sets where.repo = { in: [...] } matching both", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);

    await service.list({ repo: ["org/a", "org/b"] });

    const where = prisma._findManyCalls[0].where as
      | { repo?: { in: string[] } }
      | undefined;
    expect(where?.repo).toEqual({ in: ["org/a", "org/b"] });
  });

  it("list({ org: 'app-vitals' }) sets where.repo = { startsWith: 'app-vitals/' } via an OR clause", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);

    await service.list({ org: "app-vitals" });

    const where = prisma._findManyCalls[0].where as
      | { OR?: Array<{ repo: { startsWith: string } }> }
      | undefined;
    expect(where?.OR).toEqual([{ repo: { startsWith: "app-vitals/" } }]);
  });

  it("list({ org: ['app-vitals', 'acme'] }) sets where.repo OR startsWith clauses for both orgs", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);

    await service.list({ org: ["app-vitals", "acme"] });

    const where = prisma._findManyCalls[0].where as
      | { OR?: Array<{ repo: { startsWith: string } }> }
      | undefined;
    expect(where?.OR).toEqual([
      { repo: { startsWith: "app-vitals/" } },
      { repo: { startsWith: "acme/" } },
    ]);
  });

  it("list({ agentScope, org }) combines agentScope's OR and org's OR under AND instead of clobbering either", async () => {
    const prisma = makeListPrismaDouble();
    const service = new TaskService(prisma);

    await service.list({
      agentScope: { agentId: "agent-1", repos: ["acme/repo"] },
      org: "app-vitals",
    });

    const where = prisma._findManyCalls[0].where as
      | {
          OR?: unknown;
          AND?: Array<{ OR: unknown }>;
        }
      | undefined;
    // agentScope's OR must not be silently dropped by the org filter's OR.
    expect(where?.OR).toBeUndefined();
    expect(where?.AND).toEqual([
      {
        OR: [{ assignee: "agent-1" }, { repo: { in: ["acme/repo"] } }],
      },
      { OR: [{ repo: { startsWith: "app-vitals/" } }] },
    ]);
  });
});

// ─── TaskService.list() blockedBy dependency lookup scoping ────────────────

describe("TaskService.list() blockedBy dependency lookup scoping", () => {
  /**
   * Prisma double that serves a fixed page of tasks plus a dependency task
   * that is NOT part of the returned page — proving the dependency lookup
   * is scoped by dependency IDs (mirroring get()'s pattern), not by
   * page-membership and not an unconditional whole-table scan.
   */
  function makePagedPrismaDouble(pageTasks: Task[], depTask: Task) {
    const findManyCalls: Array<{ where?: { id?: { in: string[] } } }> = [];

    const prisma = {
      task: {
        findMany(args: { where?: { id?: { in: string[] } } } = {}) {
          findManyCalls.push(args);
          // The paginated page-query call has no id-based where clause.
          if (!args.where?.id) {
            return Promise.resolve(pageTasks);
          }
          // Scoped dependency lookup: only return tasks whose id is requested.
          const ids = new Set(args.where.id.in);
          return Promise.resolve(
            [...pageTasks, depTask].filter((t) => ids.has(t.id)),
          );
        },
        count() {
          return Promise.resolve(pageTasks.length);
        },
      },
      $transaction(ops: Array<Promise<unknown> | unknown>) {
        // Support both the legacy array-of-promises shape and a
        // fn-based transaction, since the implementation may split the
        // dependency lookup out of the transaction entirely.
        return Promise.all(
          ops.map((op) => (typeof op === "function" ? op(prisma) : op)),
        );
      },
      _findManyCalls: findManyCalls,
    };

    return prisma as unknown as PrismaClient & {
      _findManyCalls: Array<{ where?: { id?: { in: string[] } } }>;
    };
  }

  function makeFullTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-1",
      title: "A task",
      status: "pending",
      source: null,
      session: null,
      repo: null,
      description: null,
      acceptanceCriteria: [],
      layer: null,
      branch: null,
      dependencies: [],
      pr: null,
      hours: null,
      addedAt: null,
      startedAt: null,
      prCreatedAt: null,
      mergedAt: null,
      blockedAt: null,
      blockedReason: null,
      note: null,
      type: null,
      priority: null,
      cancelledAt: null,
      completedAt: null,
      deployingAt: null,
      ciFixAttempts: null,
      mergeCommit: null,
      prUrl: null,
      assignee: null,
      issue: null,
      model: null,
      complexity: null,
      hitl: null,
      claimedBy: null,
      agentHint: null,
      claimedAt: null,
      heartbeatAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as Task;
  }

  it("resolves a dependency referenced by a page task even though the dependency itself is not part of the page", async () => {
    // dep-1 is intentionally NOT included in pageTasks — a naive query that
    // filtered/matched dependency resolution against the returned page (as
    // opposed to a real `where: { id: { in: depIds } }` lookup) would fail
    // to resolve it, leaving the dependency block "unknown" instead of the
    // real (satisfied) status.
    const depTask = makeFullTask({ id: "dep-1", status: "done" });
    const pageTask = makeFullTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });

    const prisma = makePagedPrismaDouble([pageTask], depTask);
    const service = new TaskService(prisma);

    const result = await service.list({});

    expect(result.tasks).toHaveLength(1);
    // dep-1 is "done" (terminal) so it should be resolved as satisfied —
    // not "unknown", which is what would happen if the lookup were scoped
    // incorrectly (e.g. to the page only) and never found dep-1.
    expect(result.tasks[0].blockedBy).toEqual([]);
  });

  it("scopes the dependency findMany call to id IN (deduped depIds) — no unconditional whole-table findMany remains", async () => {
    const depTask = makeFullTask({ id: "dep-1", status: "in_progress" });
    const pageTaskA = makeFullTask({
      id: "t1",
      dependencies: ["dep-1"],
    });
    const pageTaskB = makeFullTask({
      id: "t2",
      dependencies: ["dep-1"], // shared dep — must be deduped
    });

    const prisma = makePagedPrismaDouble([pageTaskA, pageTaskB], depTask);
    const service = new TaskService(prisma);

    await service.list({});

    // Every findMany call beyond the initial page query must carry a scoped
    // `where: { id: { in: [...] } }` clause — no bare findMany() (which
    // would show up as a call with no `where.id`) beyond the page query.
    const nonPageCalls = prisma._findManyCalls.filter(
      (call) => call.where?.id === undefined,
    );
    // Exactly one unconditioned findMany call is allowed: the page query
    // itself (`where` may be `{}` from empty filters, but never targets
    // dependency resolution without an id filter).
    expect(nonPageCalls.length).toBeLessThanOrEqual(1);

    const depCall = prisma._findManyCalls.find((call) => call.where?.id);
    expect(depCall?.where?.id?.in).toEqual(["dep-1"]);
  });

  it("does not call findMany for dependency resolution when no page task has dependencies", async () => {
    const pageTask = makeFullTask({ id: "t1", dependencies: [] });
    const prisma = makePagedPrismaDouble(
      [pageTask],
      makeFullTask({ id: "unused" }),
    );
    const service = new TaskService(prisma);

    await service.list({});

    const depCalls = prisma._findManyCalls.filter((call) => call.where?.id);
    expect(depCalls).toHaveLength(0);
  });
});

// ─── TaskService.distinct() orgs derivation ────────────────────────────────

describe("TaskService.distinct() orgs field (unit)", () => {
  function makeDistinctPrismaDouble(
    rows: Array<{ session: string | null; repo: string | null }>,
  ) {
    const prisma = {
      task: {
        findMany() {
          return Promise.resolve(rows);
        },
      },
    };
    return prisma as unknown as PrismaClient;
  }

  it("derives orgs from the first segment of each distinct repo, deduped and sorted", async () => {
    const prisma = makeDistinctPrismaDouble([
      { session: "s1", repo: "app-vitals/shipwright" },
      { session: "s2", repo: "app-vitals/other-repo" },
      { session: "s3", repo: "acme-inc/backend-api" },
    ]);
    const service = new TaskService(prisma);

    const result = await service.distinct();

    expect(result.repos).toEqual([
      "acme-inc/backend-api",
      "app-vitals/other-repo",
      "app-vitals/shipwright",
    ]);
    expect(result.orgs).toEqual(["acme-inc", "app-vitals"]);
  });

  it("returns an empty orgs array when there are no repos", async () => {
    const prisma = makeDistinctPrismaDouble([{ session: "s1", repo: null }]);
    const service = new TaskService(prisma);

    const result = await service.distinct();

    expect(result.repos).toEqual([]);
    expect(result.orgs).toEqual([]);
  });
});
