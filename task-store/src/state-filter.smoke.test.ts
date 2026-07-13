import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { Task } from "./index.ts";
import type {
  TaskListFilters,
  TaskListResult,
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
  listReadyResult?: Task[];
  listBlockedResult?: Task[];
  capturedListFilters?: TaskListFilters[];
  capturedListReadyArgs?: Array<string | undefined>;
  capturedListBlockedCalls?: number[];
  capturedListBlockedArgs?: Array<string | undefined>;
}): TaskServiceLike {
  return {
    async list(filters?: TaskListFilters) {
      if (opts.capturedListFilters && filters) {
        opts.capturedListFilters.push({ ...filters });
      }
      const tasks = (opts.listResult ?? []).map((t) => withBlockedBy(t));
      return {
        tasks,
        total: tasks.length,
        limit: filters?.limit ?? 50,
        offset: filters?.offset ?? 0,
      };
    },
    async listReady(agentId?: string) {
      if (opts.capturedListReadyArgs) opts.capturedListReadyArgs.push(agentId);
      return opts.listReadyResult ?? [];
    },
    async listBlocked(agentId?: string) {
      if (opts.capturedListBlockedCalls) opts.capturedListBlockedCalls.push(1);
      if (opts.capturedListBlockedArgs)
        opts.capturedListBlockedArgs.push(agentId);
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
    async bulk(_tasks) {
      return { inserted: 0, updated: 0, skipped: [] };
    },
    async distinct() {
      return { sessions: [], repos: [] };
    },
  };
}

function makeApp(taskService: TaskServiceLike) {
  return createTaskStoreApp({
    taskService,
    tokenService: fakeTokenService(),
  });
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${VALID_TOKEN}` };
}

function agentAuth(): Record<string, string> {
  return { Authorization: `Bearer ${AGENT_TOKEN}` };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /tasks state filter (smoke)", () => {
  // ─── state=open (unchanged) ──────────────────────────────────────────────────

  it("GET /tasks?state=open returns 200 with list shape", async () => {
    const taskService = fakeTaskService({
      listResult: [makeTask({ id: "t1", status: "pending" })],
    });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=open", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskListResult;
    expect(typeof body.total).toBe("number");
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("GET /tasks?state=open passes state=open to list()", async () => {
    const capturedListFilters: TaskListFilters[] = [];
    const taskService = fakeTaskService({ capturedListFilters });
    const app = makeApp(taskService);
    await app.request("/tasks?state=open", { headers: auth() });
    expect(capturedListFilters[0]?.state).toBe("open");
  });

  // ─── state=closed (unchanged) ────────────────────────────────────────────────

  it("GET /tasks?state=closed returns 200 with list shape", async () => {
    const taskService = fakeTaskService({
      listResult: [makeTask({ id: "t1", status: "done" })],
    });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=closed", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskListResult;
    expect(typeof body.total).toBe("number");
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("GET /tasks?state=closed passes state=closed to list()", async () => {
    const capturedListFilters: TaskListFilters[] = [];
    const taskService = fakeTaskService({ capturedListFilters });
    const app = makeApp(taskService);
    await app.request("/tasks?state=closed", { headers: auth() });
    expect(capturedListFilters[0]?.state).toBe("closed");
  });

  // ─── state=ready ─────────────────────────────────────────────────────────────

  it("GET /tasks?state=ready returns 200", async () => {
    const readyTask = makeTask({ id: "t1", status: "pending" });
    const taskService = fakeTaskService({ listReadyResult: [readyTask] });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=ready", { headers: auth() });
    expect(res.status).toBe(200);
  });

  it("GET /tasks?state=ready returns paginated list shape", async () => {
    const readyTask = makeTask({ id: "t1", status: "pending" });
    const taskService = fakeTaskService({ listReadyResult: [readyTask] });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=ready", { headers: auth() });
    const body = (await res.json()) as { tasks: Task[]; total: number };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(body.tasks[0].id).toBe("t1");
  });

  it("GET /tasks?state=ready delegates to listReady()", async () => {
    const capturedListReadyArgs: Array<string | undefined> = [];
    const taskService = fakeTaskService({ capturedListReadyArgs });
    const app = makeApp(taskService);
    await app.request("/tasks?state=ready", { headers: auth() });
    expect(capturedListReadyArgs).toHaveLength(1);
  });

  it("GET /tasks?state=ready returns tasks from listReady()", async () => {
    const readyTask1 = makeTask({ id: "t1", status: "pending" });
    const readyTask2 = makeTask({ id: "t2", status: "pending" });
    const taskService = fakeTaskService({
      listReadyResult: [readyTask1, readyTask2],
    });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=ready", { headers: auth() });
    const body = (await res.json()) as { tasks: Task[]; total: number };
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(body.total).toBe(2);
  });

  it("GET /tasks?state=ready returns empty tasks when no ready tasks", async () => {
    const taskService = fakeTaskService({ listReadyResult: [] });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=ready", { headers: auth() });
    const body = (await res.json()) as { tasks: Task[]; total: number };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  // ─── state=in_progress ───────────────────────────────────────────────────────

  it("GET /tasks?state=in_progress returns 200", async () => {
    const taskService = fakeTaskService({
      listResult: [makeTask({ id: "t1", status: "in_progress" })],
    });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=in_progress", {
      headers: auth(),
    });
    expect(res.status).toBe(200);
  });

  it("GET /tasks?state=in_progress returns paginated list shape", async () => {
    const taskService = fakeTaskService({
      listResult: [makeTask({ id: "t1", status: "in_progress" })],
    });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=in_progress", {
      headers: auth(),
    });
    const body = (await res.json()) as TaskListResult;
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("GET /tasks?state=in_progress passes state=in_progress to list()", async () => {
    const capturedListFilters: TaskListFilters[] = [];
    const taskService = fakeTaskService({ capturedListFilters });
    const app = makeApp(taskService);
    await app.request("/tasks?state=in_progress", { headers: auth() });
    expect(capturedListFilters[0]?.state).toBe("in_progress");
  });

  it("GET /tasks?state=in_progress returns tasks from the list service", async () => {
    const t1 = makeTask({ id: "t1", status: "in_progress" });
    const t2 = makeTask({ id: "t2", status: "pr_open" });
    const taskService = fakeTaskService({ listResult: [t1, t2] });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=in_progress", {
      headers: auth(),
    });
    const body = (await res.json()) as TaskListResult;
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  // ─── state=blocked ───────────────────────────────────────────────────────────

  it("GET /tasks?state=blocked returns 200", async () => {
    const taskService = fakeTaskService({
      listBlockedResult: [makeTask({ id: "t1", status: "blocked" })],
    });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=blocked", { headers: auth() });
    expect(res.status).toBe(200);
  });

  it("GET /tasks?state=blocked returns paginated list shape", async () => {
    const blockedTask = makeTask({ id: "t1", status: "blocked" });
    const taskService = fakeTaskService({ listBlockedResult: [blockedTask] });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=blocked", { headers: auth() });
    const body = (await res.json()) as { tasks: TaskWithBlockedBy[]; total: number };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("GET /tasks?state=blocked delegates to listBlocked()", async () => {
    const capturedListBlockedCalls: number[] = [];
    const taskService = fakeTaskService({ capturedListBlockedCalls });
    const app = makeApp(taskService);
    await app.request("/tasks?state=blocked", { headers: auth() });
    expect(capturedListBlockedCalls).toHaveLength(1);
  });

  it("GET /tasks?state=blocked returns tasks from listBlocked()", async () => {
    const b1 = makeTask({ id: "t1", status: "blocked" });
    const b2 = makeTask({ id: "t2", status: "pending" });
    const taskService = fakeTaskService({ listBlockedResult: [b1, b2] });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=blocked", { headers: auth() });
    const body = (await res.json()) as { tasks: TaskWithBlockedBy[]; total: number };
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(body.total).toBe(2);
  });

  it("GET /tasks?state=blocked returns empty tasks when no blocked tasks", async () => {
    const taskService = fakeTaskService({ listBlockedResult: [] });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=blocked", { headers: auth() });
    const body = (await res.json()) as { tasks: TaskWithBlockedBy[]; total: number };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("GET /tasks?state=blocked response includes blockedBy on each task", async () => {
    const blockedTask = makeTask({ id: "t1", status: "blocked" });
    const taskService = fakeTaskService({ listBlockedResult: [blockedTask] });
    const app = makeApp(taskService);
    const res = await app.request("/tasks?state=blocked", { headers: auth() });
    const body = (await res.json()) as { tasks: TaskWithBlockedBy[]; total: number };
    expect(Array.isArray(body.tasks[0].blockedBy)).toBe(true);
  });

  // ─── agent token scoping for state=blocked ────────────────────────────────

  it("GET /tasks?state=blocked passes agentId to listBlocked() for agent tokens", async () => {
    const capturedListBlockedArgs: Array<string | undefined> = [];
    const taskService = fakeTaskService({ capturedListBlockedArgs });
    const app = makeApp(taskService);
    await app.request("/tasks?state=blocked", { headers: agentAuth() });
    expect(capturedListBlockedArgs).toHaveLength(1);
    expect(capturedListBlockedArgs[0]).toBe(AGENT_ID);
  });

  it("GET /tasks?state=blocked passes undefined agentId to listBlocked() for admin tokens", async () => {
    const capturedListBlockedArgs: Array<string | undefined> = [];
    const taskService = fakeTaskService({ capturedListBlockedArgs });
    const app = makeApp(taskService);
    await app.request("/tasks?state=blocked", { headers: auth() });
    expect(capturedListBlockedArgs).toHaveLength(1);
    expect(capturedListBlockedArgs[0]).toBeUndefined();
  });
});
