import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { Task } from "./index.ts";
import type { SessionServiceLike } from "./session-service.ts";
import { TASK_COLUMNS } from "./statuses.ts";
import type {
  TaskListFilters,
  TaskServiceLike,
  TaskWithBlockedBy,
} from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

const VALID_TOKEN = "valid-token";
const AGENT_TOKEN = "agent-token";
const AGENT_ID = "agent-1";

function fakeTokenService(): TokenServiceLike {
  return {
    async create(label?: string) {
      return {
        token: {
          id: "tok-1",
          token: "hash",
          label: label ?? null,
          agentId: null,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw",
      };
    },
    async validate(raw: string) {
      if (raw === VALID_TOKEN) return { id: "tok-1", agentId: null };
      if (raw === AGENT_TOKEN) return { id: "tok-2", agentId: AGENT_ID };
      return null;
    },
    async revoke() {
      return null;
    },
    async list() {
      return [];
    },
    async update() {
      return null;
    },
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
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
    ciFixAttempts: null,
    mergeCommit: null,
    prUrl: null,
    assignee: null,
    issue: null,
    model: null,
    complexity: null,
    hitl: null,
    hitlNotifiedAt: null,
    claimedBy: null,
    agentHint: null,
    claimedAt: null,
    heartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

function withBlockedBy(
  task: Task,
  blockedBy: TaskWithBlockedBy["blockedBy"] = [],
): TaskWithBlockedBy {
  return { ...task, blockedBy };
}

function fakeTaskService(opts: {
  listResult?: Task[];
  listNextCursor?: string | null;

  listReadyResult?: Task[];
  listBlockedResult?: Task[];
  capturedListFilters?: TaskListFilters[];
  capturedListReadyArgs?: Array<string | undefined>;
  capturedListBlockedCalls?: number[];
  capturedListBlockedArgs?: Array<string | undefined>;
  capturedListBlockedSortArgs?: Array<"asc" | "desc" | undefined>;
  capturedListBlockedFilters?: Array<Record<string, unknown> | undefined>;
}): TaskServiceLike {
  return {
    async markMergedByPr() {
      return { updated: [], unchanged: [], skipped: [] };
    },
    async list(filters?: TaskListFilters) {
      if (opts.capturedListFilters && filters) {
        opts.capturedListFilters.push({ ...filters });
      }
      const tasks = (opts.listResult ?? []).map((t) => withBlockedBy(t));
      return {
        tasks,
        total: tasks.length,
        limit: filters?.limit ?? 50,
        nextCursor: opts.listNextCursor,
      };
    },
    async listReady(agentId?: string) {
      if (opts.capturedListReadyArgs) opts.capturedListReadyArgs.push(agentId);
      return opts.listReadyResult ?? [];
    },
    async listBlocked(
      agentId?: string,
      _repos?: string[],
      sort?: "asc" | "desc",
      filters?: Record<string, unknown>,
    ) {
      if (opts.capturedListBlockedCalls) opts.capturedListBlockedCalls.push(1);
      if (opts.capturedListBlockedArgs)
        opts.capturedListBlockedArgs.push(agentId);
      if (opts.capturedListBlockedSortArgs)
        opts.capturedListBlockedSortArgs.push(sort);
      if (opts.capturedListBlockedFilters)
        opts.capturedListBlockedFilters.push(filters);
      return (opts.listBlockedResult ?? []).map((t) => withBlockedBy(t));
    },
    async get(id: string) {
      return withBlockedBy(makeTask({ id }));
    },
    async create(data) {
      return makeTask({ ...(data as Partial<Task>), id: "created-1" });
    },
    async update(id, data) {
      return makeTask({ ...(data as Partial<Task>), id });
    },
    async remove() {
      return;
    },
    async claim(id: string, claimedBy: string) {
      return makeTask({ id, status: "in_progress", claimedBy });
    },
    async heartbeat(id: string) {
      return makeTask({ id, status: "in_progress" });
    },
    async complete(id: string) {
      return makeTask({ id, status: "done" });
    },
    async fail(id: string) {
      return makeTask({ id, status: "blocked" });
    },
    async release(id: string) {
      return makeTask({ id, status: "pending" });
    },
    async recordSkip(id: string) {
      return makeTask({ id, skipCount: 1 });
    },
    async resetSkip(id: string) {
      return makeTask({ id, skipCount: 0 });
    },
    async unblock(id: string) {
      return makeTask({ id, status: "pending" });
    },
    async bulk(_tasks) {
      return { inserted: 0, updated: 0, skipped: [] };
    },
    async distinct() {
      return { sessions: [], repos: [], orgs: [] };
    },
    async getEvents() {
      return { events: [], total: 0 };
    },
  };
}

/** No-op SessionService double — session routes aren't under test here. */
function fakeSessionService(): SessionServiceLike {
  return {
    async list() {
      return { sessions: [], total: 0, limit: 50 };
    },
    async get() {
      return null;
    },
    async update() {
      throw new Error("not implemented");
    },
    async acquirePlanningLock() {
      throw new Error("not implemented");
    },
    async releasePlanningLock() {
      throw new Error("not implemented");
    },
  };
}

function makeApp(taskService: TaskServiceLike) {
  return createTaskStoreApp({
    taskService,
    tokenService: fakeTokenService(),
    sessionService: fakeSessionService(),
  });
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${VALID_TOKEN}` };
}

function agentAuth(): Record<string, string> {
  return { Authorization: `Bearer ${AGENT_TOKEN}` };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /tasks?column= (smoke)", () => {
  it("forwards a valid ?column to list()", async () => {
    for (const column of TASK_COLUMNS) {
      const capturedListFilters: TaskListFilters[] = [];
      const app = makeApp(fakeTaskService({ capturedListFilters }));
      const res = await app.request(`/tasks?column=${column}`, {
        headers: auth(),
      });
      expect(res.status).toBe(200);
      expect(capturedListFilters[0]?.column).toBe(column);
    }
  });

  it("omits column from list() when the param is absent", async () => {
    const capturedListFilters: TaskListFilters[] = [];
    const app = makeApp(fakeTaskService({ capturedListFilters }));
    await app.request("/tasks", { headers: auth() });
    expect(capturedListFilters[0]?.column).toBeUndefined();
  });

  it("an unknown column is a 400 and never reaches list()", async () => {
    const capturedListFilters: TaskListFilters[] = [];
    const app = makeApp(fakeTaskService({ capturedListFilters }));
    for (const bad of ["bogus", "done", "claimed", "blocked_hitl", ""]) {
      const res = await app.request(`/tasks?column=${bad}`, {
        headers: auth(),
      });
      expect(res.status).toBe(400);
    }
    expect(capturedListFilters).toHaveLength(0);
  });

  it("composes with limit and cursor", async () => {
    const capturedListFilters: TaskListFilters[] = [];
    const app = makeApp(fakeTaskService({ capturedListFilters }));
    await app.request("/tasks?column=queued&limit=2&cursor=opaque", {
      headers: agentAuth(),
    });
    expect(capturedListFilters[0]).toMatchObject({
      column: "queued",
      limit: 2,
      cursor: "opaque",
    });
  });
});
