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
import { ApiError } from "../errors.ts";
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

function fakeTaskService(opts: { tasks?: Task[] } = {}): TaskServiceLike {
  const tasks = opts.tasks ?? [];
  return {
    async list() {
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
    async bulk() {
      return { inserted: 0, updated: 0, skipped: [] };
    },
    async distinct() {
      return { sessions: [], repos: [] };
    },
  };
}

/** Build a typed parent app that injects admin context (agentId=null, repos=null). */
function makeAdminParent(app: OpenAPIHono<TaskStoreAuthEnv>) {
  const parent = new OpenAPIHono<TaskStoreAuthEnv>();
  parent.use("*", async (c, next) => {
    c.set("agentId", null);
    c.set("repos", null);
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
