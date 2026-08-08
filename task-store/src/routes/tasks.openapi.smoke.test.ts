/**
 * task-store/src/routes/tasks.openapi.smoke.test.ts
 *
 * TDD smoke test for TSM-1.2: verify that createTasksRoutes returns an
 * OpenAPIHono app and that all endpoints continue to work after the migration.
 *
 * Tests written BEFORE the implementation to drive the conversion.
 */

import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
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
    onUpdate?: (id: string, data: unknown) => void;
    onCreate?: (data: unknown) => void;
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
      opts.onCreate?.(data);
      return makeTask({ ...(data as Partial<Task>), id: "created-1" });
    },
    async update(id, data) {
      opts.onUpdate?.(id, data);
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
    async bulk(data) {
      opts.onBulk?.(data);
      return { inserted: 0, updated: 0, skipped: [] };
    },
    async distinct() {
      return { sessions: [], repos: [], orgs: [] };
    },
  };
}

/** Build a typed parent app that injects the given auth context (agentId, repos, scopeDegraded). */
function makeParent(
  app: OpenAPIHono<TaskStoreAuthEnv>,
  agentId: string | null,
  repos: string[] | null,
  scopeDegraded = false,
) {
  const parent = new OpenAPIHono<TaskStoreAuthEnv>();
  parent.use("*", async (c, next) => {
    c.set("agentId", agentId);
    c.set("repos", repos);
    c.set("scopeDegraded", scopeDegraded);
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
function makeAdminParent(
  app: OpenAPIHono<TaskStoreAuthEnv>,
  scopeDegraded = false,
) {
  return makeParent(app, null, null, scopeDegraded);
}

/** Build a typed parent app that injects agent-token context (agentId set, scoped repos). */
function makeAgentParent(
  app: OpenAPIHono<TaskStoreAuthEnv>,
  agentId: string,
  repos: string[] | null = [],
  scopeDegraded = false,
) {
  return makeParent(app, agentId, repos, scopeDegraded);
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

  it("GET / includes scopeDegraded: true in the response body when the scope resolver failed upstream", async () => {
    const task = makeTask({ id: "t-1" });
    const app = createTasksRoutes(fakeTaskService({ tasks: [task] }));
    const parent = makeAdminParent(app, true);

    const res = await parent.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: Task[];
      total: number;
      scopeDegraded: boolean;
    };
    expect(body.scopeDegraded).toBe(true);
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

  it("GET /?source=entropy-fix passes source through to taskService.list()", async () => {
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

    const res = await parent.request("/?source=entropy-fix");
    expect(res.status).toBe(200);
    expect((receivedFilters as { source?: string }).source).toBe("entropy-fix");
  });

  it("GET / with no source param passes source: undefined through to taskService.list() (existing behavior)", async () => {
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
    expect((receivedFilters as { source?: string }).source).toBeUndefined();
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

  it("GET /distinct returns 200 with an orgs array included alongside sessions/repos", async () => {
    const app = createTasksRoutes(fakeTaskService());
    const parent = makeAdminParent(app);

    const res = await parent.request("/distinct");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: string[];
      repos: string[];
      orgs: string[];
    };
    expect(Array.isArray(body.orgs)).toBe(true);
  });

  it("GET /?repo=org/a passes repo: ['org/a'] (single-value, array-wrapped) through to taskService.list()", async () => {
    const task = makeTask({ id: "t-1", repo: "org/a" });
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

    const res = await parent.request("/?repo=org/a");
    expect(res.status).toBe(200);
    expect((receivedFilters as { repo?: unknown }).repo).toEqual(["org/a"]);
  });

  it("GET /?repo=org/a&repo=org/b passes repo: ['org/a', 'org/b'] through to taskService.list() (multi-value repo)", async () => {
    const taskA = makeTask({ id: "t-1", repo: "org/a" });
    const taskB = makeTask({ id: "t-2", repo: "org/b" });
    let receivedFilters: unknown;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [taskA, taskB],
        onList: (filters) => {
          receivedFilters = filters;
        },
      }),
    );
    const parent = makeAdminParent(app);

    const res = await parent.request("/?repo=org/a&repo=org/b");
    expect(res.status).toBe(200);
    expect((receivedFilters as { repo?: unknown }).repo).toEqual([
      "org/a",
      "org/b",
    ]);
    const body = (await res.json()) as { tasks: Task[]; total: number };
    expect(body.tasks).toHaveLength(2);
  });

  it("GET /?org=app-vitals passes org: ['app-vitals'] through to taskService.list()", async () => {
    const task = makeTask({ id: "t-1", repo: "app-vitals/shipwright" });
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

    const res = await parent.request("/?org=app-vitals");
    expect(res.status).toBe(200);
    expect((receivedFilters as { org?: unknown }).org).toEqual(["app-vitals"]);
    const body = (await res.json()) as { tasks: Task[]; total: number };
    expect(body.tasks).toHaveLength(1);
  });

  it("GET / with no repo or org param passes repo: undefined, org: undefined through to taskService.list() (existing behavior)", async () => {
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
    expect((receivedFilters as { repo?: unknown }).repo).toBeUndefined();
    expect((receivedFilters as { org?: unknown }).org).toBeUndefined();
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

describe("PATCH /:id — lifecycle field guard (TPL-1.1)", () => {
  it("agent token + claimedBy in body -> 400", async () => {
    const task = makeTask({ id: "t-1", assignee: "agent-1" });
    const app = createTasksRoutes(fakeTaskService({ tasks: [task] }));
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/t-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimedBy: "agent-2" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("/claim");
    expect(body.error).toContain("/release");
  });

  it("agent token + claimedAt in body -> 400", async () => {
    const task = makeTask({ id: "t-1", assignee: "agent-1" });
    const app = createTasksRoutes(fakeTaskService({ tasks: [task] }));
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/t-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimedAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(400);
  });

  it("agent token + heartbeatAt in body -> 400", async () => {
    const task = makeTask({ id: "t-1", assignee: "agent-1" });
    const app = createTasksRoutes(fakeTaskService({ tasks: [task] }));
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/t-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heartbeatAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(400);
  });

  it("agent token + status: 'pending' in body -> 400", async () => {
    const task = makeTask({ id: "t-1", assignee: "agent-1" });
    const app = createTasksRoutes(fakeTaskService({ tasks: [task] }));
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/t-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "pending" }),
    });
    expect(res.status).toBe(400);
  });

  it("agent token + status: 'blocked' (control case) -> 200, unaffected", async () => {
    const task = makeTask({ id: "t-1", assignee: "agent-1" });
    const app = createTasksRoutes(fakeTaskService({ tasks: [task] }));
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/t-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "blocked" }),
    });
    expect(res.status).toBe(200);
  });

  it("admin token + claimedBy in body -> 200 (admin bypass confirmed)", async () => {
    const task = makeTask({ id: "t-1", assignee: "agent-1" });
    const app = createTasksRoutes(fakeTaskService({ tasks: [task] }));
    const parent = makeAdminParent(app);

    const res = await parent.request("/t-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimedBy: "agent-2" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /:id — blocked/requiresHumanApproval split (HSR-1.6)", () => {
  it("accepts 'requiresHumanApproval' and passes it through to the service update", async () => {
    const task = makeTask({ id: "t-1", assignee: "agent-1" });
    let received: Record<string, unknown> | undefined;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onUpdate: (_id, data) => {
          received = data as Record<string, unknown>;
        },
      }),
    );
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/t-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requiresHumanApproval: true }),
    });
    expect(res.status).toBe(200);
    expect(received?.requiresHumanApproval).toBe(true);
  });

  it("does not 500 when 'hitlNotifiedAt' is sent, and never forwards it to the service update", async () => {
    const task = makeTask({ id: "t-1", assignee: "agent-1" });
    let received: Record<string, unknown> | undefined;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onUpdate: (_id, data) => {
          received = data as Record<string, unknown>;
        },
      }),
    );
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/t-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "still writable",
        hitlNotifiedAt: new Date().toISOString(),
      }),
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    expect(received).toBeDefined();
    expect("hitlNotifiedAt" in (received ?? {})).toBe(false);
  });

  it("leaves 'hitl' writable (Task.hitl is unchanged)", async () => {
    const task = makeTask({ id: "t-1", assignee: "agent-1" });
    let received: Record<string, unknown> | undefined;
    const app = createTasksRoutes(
      fakeTaskService({
        tasks: [task],
        onUpdate: (_id, data) => {
          received = data as Record<string, unknown>;
        },
      }),
    );
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/t-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hitl: true }),
    });
    expect(res.status).toBe(200);
    expect(received?.hitl).toBe(true);
  });
});

describe("POST / and POST /bulk — strip removed 'hitlNotifiedAt' field (HSR-1.1 follow-up)", () => {
  it("POST / does not 500 when 'hitlNotifiedAt' is sent, and never forwards it to the service create", async () => {
    let received: Record<string, unknown> | undefined;
    const app = createTasksRoutes(
      fakeTaskService({
        onCreate: (data) => {
          received = data as Record<string, unknown>;
        },
      }),
    );
    const parent = makeAgentParent(app, "agent-1");

    const res = await parent.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "New task",
        status: "pending",
        repo: null,
        hitlNotifiedAt: new Date().toISOString(),
      }),
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(201);
    expect(received).toBeDefined();
    expect("hitlNotifiedAt" in (received ?? {})).toBe(false);
  });

  it("POST /bulk does not 500 when a task has 'hitlNotifiedAt', and never forwards it to the service bulk", async () => {
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
          hitlNotifiedAt: new Date().toISOString(),
        },
      ]),
    });
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(200);
    const tasks = received as Record<string, unknown>[];
    expect(tasks).toHaveLength(1);
    expect("hitlNotifiedAt" in (tasks[0] ?? {})).toBe(false);
  });
});
