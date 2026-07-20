/**
 * task-store/src/routes/tasks.openapi.smoke.test.ts
 *
 * TDD smoke test for TSM-1.2: verify that createTasksRoutes returns an
 * OpenAPIHono app and that all endpoints continue to work after the migration.
 *
 * Tests written BEFORE the implementation to drive the conversion.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "bun:test";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { ApiError, BadRequestError } from "../errors.ts";
import type { Task } from "../index.ts";
import type { TaskServiceLike } from "../task-service.ts";
import { createTasksRoutes } from "./tasks.ts";

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
    deployingAt: null,
    deployedAt: null,
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
    simplifyTotal: null,
    simplifyDry: null,
    simplifyDeadCode: null,
    simplifyNaming: null,
    simplifyComplexity: null,
    simplifyConsistency: null,
    coverageDelta: null,
    effortLevel: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

function withBlockedBy(task: Task) {
  return { ...task, blockedBy: [] };
}

function fakeTaskService(
  opts: {
    tasks?: Task[];
    onList?: (filters: unknown) => void;
    onBulk?: (tasks: unknown) => void;
  } = {},
): TaskServiceLike {
  const tasks = opts.tasks ?? [];
  return {
    async list(filters) {
      opts.onList?.(filters);
      return {
        tasks: tasks.map(withBlockedBy),
        total: tasks.length,
        limit: 50,
        offset: 0,
      };
    },
    async listReady() {
      return tasks;
    },
    async listBlocked() {
      return tasks.map(withBlockedBy);
    },
    async get(id: string) {
      const t = tasks.find((t) => t.id === id);
      return t ? withBlockedBy(t) : null;
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
    async bulk(data) {
      opts.onBulk?.(data);
      return { inserted: 0, updated: 0, skipped: [] };
    },
    async distinct() {
      return { sessions: [], repos: [] };
    },
  };
}

/** Build a typed parent app that injects the given auth context (agentId, repos). */
function makeParent(
  app: OpenAPIHono<TaskStoreAuthEnv>,
  agentId: string | null,
  repos: string[] | null,
) {
  const parent = new OpenAPIHono<TaskStoreAuthEnv>();
  parent.use("*", async (c, next) => {
    c.set("agentId", agentId);
    c.set("repos", repos);
    await next();
  });
  parent.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.message }, err.statusCode as 400);
    }
    return c.json({ error: "internal error" }, 500);
  });
  parent.route("/", app);
  return parent;
}

/** Build a typed parent app that injects admin context (agentId=null, repos=null). */
function makeAdminParent(app: OpenAPIHono<TaskStoreAuthEnv>) {
  return makeParent(app, null, null);
}

/** Build a typed parent app that injects agent-token context (agentId set, scoped repos). */
function makeAgentParent(
  app: OpenAPIHono<TaskStoreAuthEnv>,
  agentId: string,
  repos: string[] | null = [],
) {
  return makeParent(app, agentId, repos);
}

describe("createTasksRoutes — OpenAPIHono migration (TSM-1.2)", () => {
  it("returns an OpenAPIHono instance", () => {
    const app = createTasksRoutes(fakeTaskService());
    expect(app).toBeInstanceOf(OpenAPIHono);
  });

  it("GET / returns 200 with { tasks, total } shape", async () => {
    const task = makeTask({ id: "t-1" });
    const app = createTasksRoutes(fakeTaskService({ tasks: [task] }));
    const parent = makeAdminParent(app);

    const res = await parent.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Task[]; total: number };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("GET /:id returns 200 with task shape", async () => {
    const task = makeTask({ id: "t-1", assignee: null });
    const app = createTasksRoutes(fakeTaskService({ tasks: [task] }));
    const parent = makeAdminParent(app);

    const res = await parent.request("/t-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.id).toBe("t-1");
  });

  it("GET /:id returns 404 when task not found", async () => {
    const app = createTasksRoutes(fakeTaskService());
    const parent = makeAdminParent(app);

    const res = await parent.request("/nonexistent");
    expect(res.status).toBe(404);
  });

  it("GET /?sort=desc passes sort: 'desc' through to taskService.list()", async () => {
    const task = makeTask({ id: "t-1" });
    let receivedFilters: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onList: (filters) => {
          receivedFilters = filters;
        },
      }),
    );
    const parent = makeAdminParent(app);

    const res = await parent.request("/?sort=desc");
    expect(res.status).toBe(200);
    expect((receivedFilters as { sort?: string }).sort).toBe("desc");
  });

  it("GET / with no sort param passes sort: undefined through to taskService.list() (existing behavior)", async () => {
    const task = makeTask({ id: "t-1" });
    let receivedFilters: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onList: (filters) => {
          receivedFilters = filters;
        },
      }),
    );
    const parent = makeAdminParent(app);

    const res = await parent.request("/");
    expect(res.status).toBe(200);
    expect((receivedFilters as { sort?: string }).sort).toBeUndefined();
  });

  it("GET /?sort=asc passes sort: undefined through to taskService.list() (falls through to default ascending)", async () => {
    const task = makeTask({ id: "t-1" });
    let receivedFilters: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onList: (filters) => {
          receivedFilters = filters;
        },
      }),
    );
    const parent = makeAdminParent(app);

    const res = await parent.request("/?sort=asc");
    expect(res.status).toBe(200);
    expect((receivedFilters as { sort?: string }).sort).toBeUndefined();
  });

  it("GET /?updatedSince=<iso> passes updatedSince through to taskService.list()", async () => {
    const task = makeTask({ id: "t-1" });
    let receivedFilters: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onList: (filters) => {
          receivedFilters = filters;
        },
      }),
    );
    const parent = makeAdminParent(app);

    const updatedSince = "2026-07-01T00:00:00.000Z";
    const res = await parent.request(`/?updatedSince=${updatedSince}`);
    expect(res.status).toBe(200);
    expect((receivedFilters as { updatedSince?: string }).updatedSince).toBe(
      updatedSince,
    );
  });

  it("GET / with no updatedSince param passes updatedSince: undefined through to taskService.list() (existing behavior)", async () => {
    const task = makeTask({ id: "t-1" });
    let receivedFilters: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onList: (filters) => {
          receivedFilters = filters;
        },
      }),
    );
    const parent = makeAdminParent(app);

    const res = await parent.request("/");
    expect(res.status).toBe(200);
    expect(
      (receivedFilters as { updatedSince?: string }).updatedSince,
    ).toBeUndefined();
  });

  it("GET /?updatedSince=not-a-date surfaces the service's BadRequestError as a 400 (not a 500)", async () => {
    const app = createTasksRoutes(
      fakeTaskService({
        onList: () => {
          throw new BadRequestError(
            "updatedSince 'not-a-date' is not a valid ISO timestamp",
          );
        },
      }),
    );
    const parent = makeAdminParent(app);

    const res = await parent.request("/?updatedSince=not-a-date");
    expect(res.status).toBe(400);
  });

  it("GET /?hitl=true passes hitl: true through to taskService.list()", async () => {
    const task = makeTask({ id: "t-1", hitl: true });
    let receivedFilters: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onList: (filters) => {
          receivedFilters = filters;
        },
      }),
    );
    const parent = makeAdminParent(app);

    const res = await parent.request("/?hitl=true");
    expect(res.status).toBe(200);
    expect((receivedFilters as { hitl?: boolean }).hitl).toBe(true);
  });

  it("GET /?hitl=false passes hitl: false through to taskService.list()", async () => {
    const task = makeTask({ id: "t-1", hitl: false });
    let receivedFilters: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onList: (filters) => {
          receivedFilters = filters;
        },
      }),
    );
    const parent = makeAdminParent(app);

    const res = await parent.request("/?hitl=false");
    expect(res.status).toBe(200);
    expect((receivedFilters as { hitl?: boolean }).hitl).toBe(false);
  });

  it("GET / with no hitl param passes hitl: undefined through to taskService.list() (existing behavior)", async () => {
    const task = makeTask({ id: "t-1" });
    let receivedFilters: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onList: (filters) => {
          receivedFilters = filters;
        },
      }),
    );
    const parent = makeAdminParent(app);

    const res = await parent.request("/");
    expect(res.status).toBe(200);
    expect((receivedFilters as { hitl?: boolean }).hitl).toBeUndefined();
  });

  it("GET /?hitl=garbage rejects with a 400 (invalid enum value, mirrors ?ready= behavior)", async () => {
    const app = createTasksRoutes(fakeTaskService());
    const parent = makeAdminParent(app);

    const res = await parent.request("/?hitl=garbage");
    expect(res.status).toBe(400);
  });

  it("GET /distinct returns 200 with { sessions, repos } shape", async () => {
    const app = createTasksRoutes(fakeTaskService());
    const parent = makeAdminParent(app);

    const res = await parent.request("/distinct");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: string[]; repos: string[] };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(Array.isArray(body.repos)).toBe(true);
  });
});

describe("POST / (create) — agent-token default assignee (UTA-1.1)", () => {
  it("agent token, no assignee in body -> created task has assignee: null (unassigned pool task)", async () => {
    const app = createTasksRoutes(fakeTaskService());
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "New task",
        status: "pending",
        repo: null,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.assignee).toBeNull();
  });

  it("agent token, explicit assignee in body -> honored, not overwritten to caller's own agentId", async () => {
    const app = createTasksRoutes(fakeTaskService());
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "New task",
        status: "pending",
        repo: null,
        assignee: "some-other-agent",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.assignee).toBe("some-other-agent");
  });
});

describe("POST /bulk — agent-token default assignee (UTA-1.1)", () => {
  it("agent token, tasks with no assignee field -> assignee stays unset/null per task", async () => {
    let received: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        onBulk: (tasks) => {
          received = tasks;
        },
      }),
    );
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { title: "Task A", status: "pending", repo: null },
        { title: "Task B", status: "pending", repo: null },
      ]),
    });
    expect(res.status).toBe(200);
    const tasks = received as Record<string, unknown>[];
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t.assignee).toBeUndefined();
    }
  });

  it("agent token, explicit assignee per task -> honored, not overwritten", async () => {
    let received: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        onBulk: (tasks) => {
          received = tasks;
        },
      }),
    );
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          title: "Task A",
          status: "pending",
          repo: null,
          assignee: "some-other-agent",
        },
        { title: "Task B", status: "pending", repo: null, assignee: "agent-1" },
      ]),
    });
    expect(res.status).toBe(200);
    const tasks = received as Record<string, unknown>[];
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.assignee).toBe("some-other-agent");
    expect(tasks[1]?.assignee).toBe("agent-1");
  });
});
