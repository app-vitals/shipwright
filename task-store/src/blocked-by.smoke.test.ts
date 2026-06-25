/**
 * task-store/src/blocked-by.smoke.test.ts
 *
 * Smoke tests verifying that blockedBy is present on both
 * GET /tasks/:id and GET /tasks (list) responses.
 *
 * No real socket, no real DB — services are injected as in-memory fakes.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { computeBlockedBy } from "./blocked-by.ts";
import type { Task } from "./index.ts";
import type { TaskListFilters, TaskListResult, TaskServiceLike, TaskWithBlockedBy } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

const VALID_TOKEN = "valid-token";

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
      return raw === VALID_TOKEN ? { id: "tok-1", agentId: null } : null;
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

/** Attach blockedBy to a Task using the real computeBlockedBy helper. */
function withBlockedBy(task: Task, allTasks: Task[]): TaskWithBlockedBy {
  return { ...task, blockedBy: computeBlockedBy(task, allTasks) };
}

/** Task service fake that returns configured tasks for get/list. */
function fakeTaskService(
  opts: {
    getResult?: Task | null;
    listResult?: Task[];
    listReadyResult?: Task[];
    listBlockedResult?: Task[];
    allTasks?: Task[];
  } = {},
): TaskServiceLike {
  const allTasks = opts.allTasks ?? [];
  return {
    async list(filters?: TaskListFilters) {
      const tasks = opts.listResult ?? allTasks;
      const tasksWithBlockedBy = tasks.map((t) => withBlockedBy(t, allTasks));
      return {
        tasks: tasksWithBlockedBy,
        total: tasks.length,
        limit: filters?.limit ?? 50,
        offset: filters?.offset ?? 0,
      };
    },
    async listReady() {
      return opts.listReadyResult ?? [];
    },
    async listBlocked() {
      return (opts.listBlockedResult ?? []).map((t) => withBlockedBy(t, allTasks));
    },
    async get(id: string) {
      if ("getResult" in opts) {
        if (!opts.getResult) return null;
        return withBlockedBy(opts.getResult, allTasks);
      }
      const found = allTasks.find((t) => t.id === id) ?? makeTask({ id });
      return withBlockedBy(found, allTasks);
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
      return { inserted: 0, updated: 0 };
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("blockedBy field on API responses (smoke)", () => {
  // ─── GET /tasks/:id ─────────────────────────────────────────────────────────

  it("GET /tasks/:id includes blockedBy array on a simple pending task", async () => {
    const task = makeTask({ id: "t1", status: "pending" });
    const app = makeApp(fakeTaskService({ getResult: task }));
    const res = await app.request("/tasks/t1", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskWithBlockedBy;
    expect(Array.isArray(body.blockedBy)).toBe(true);
    expect(body.blockedBy).toEqual([]);
  });

  it("GET /tasks/:id includes { type: 'hitl' } when hitl=true and hitlNotifiedAt=null", async () => {
    const task = makeTask({
      id: "t1",
      status: "pending",
      hitl: true,
      hitlNotifiedAt: null,
    });
    const app = makeApp(fakeTaskService({ getResult: task }));
    const res = await app.request("/tasks/t1", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskWithBlockedBy;
    expect(body.blockedBy).toContainEqual({ type: "hitl" });
  });

  it("GET /tasks/:id includes { type: 'hitl', notified: true } when hitl=true and hitlNotifiedAt is set", async () => {
    const task = makeTask({
      id: "t1",
      status: "pending",
      hitl: true,
      hitlNotifiedAt: "2026-06-24T10:00:00.000Z",
    });
    const app = makeApp(fakeTaskService({ getResult: task }));
    const res = await app.request("/tasks/t1", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskWithBlockedBy;
    expect(body.blockedBy).toEqual([{ type: "hitl", notified: true }]);
  });

  it("GET /tasks/:id includes dep block when dep is in non-terminal status", async () => {
    const dep = makeTask({ id: "dep-1", status: "in_progress" });
    const task = makeTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    // allTasks includes both so get() can look up the dep
    const app = makeApp(fakeTaskService({ getResult: task, allTasks: [task, dep] }));
    const res = await app.request("/tasks/t1", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskWithBlockedBy;
    expect(body.blockedBy).toContainEqual({
      type: "dependency",
      id: "dep-1",
      status: "in_progress",
    });
  });

  it("GET /tasks/:id blockedBy is empty when all deps are satisfied (done)", async () => {
    const dep = makeTask({ id: "dep-1", status: "done" });
    const task = makeTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    const app = makeApp(fakeTaskService({ getResult: task, allTasks: [task, dep] }));
    const res = await app.request("/tasks/t1", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskWithBlockedBy;
    expect(body.blockedBy).toEqual([]);
  });

  // ─── GET /tasks (list) ──────────────────────────────────────────────────────

  it("GET /tasks list response includes blockedBy on each task", async () => {
    const task = makeTask({ id: "t1", status: "pending" });
    const app = makeApp(fakeTaskService({ listResult: [task] }));
    const res = await app.request("/tasks", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: TaskWithBlockedBy[]; total: number; limit: number; offset: number };
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks).toHaveLength(1);
    expect(Array.isArray(body.tasks[0].blockedBy)).toBe(true);
  });

  it("GET /tasks list response shape is { tasks, total, limit, offset }", async () => {
    const task = makeTask({ id: "t1", status: "pending" });
    const app = makeApp(fakeTaskService({ listResult: [task] }));
    const res = await app.request("/tasks", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: TaskWithBlockedBy[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(typeof body.total).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.offset).toBe("number");
  });

  it("GET /tasks list returns hitl block on tasks with hitl=true and hitlNotifiedAt=null", async () => {
    const task = makeTask({
      id: "t1",
      status: "pending",
      hitl: true,
      hitlNotifiedAt: null,
    });
    const app = makeApp(fakeTaskService({ listResult: [task] }));
    const res = await app.request("/tasks", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: TaskWithBlockedBy[] };
    expect(body.tasks[0].blockedBy).toContainEqual({ type: "hitl" });
  });

  it("GET /tasks list returns empty blockedBy for tasks with no blocks", async () => {
    const task = makeTask({
      id: "t1",
      status: "pending",
      hitl: false,
      dependencies: [],
    });
    const app = makeApp(fakeTaskService({ listResult: [task] }));
    const res = await app.request("/tasks", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: TaskWithBlockedBy[] };
    expect(body.tasks[0].blockedBy).toEqual([]);
  });
});
