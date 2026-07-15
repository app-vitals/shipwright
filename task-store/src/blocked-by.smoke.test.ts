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
import type {
  TaskListFilters,
  TaskListResult,
  TaskServiceLike,
  TaskWithBlockedBy,
} from "./task-service.ts";
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
      return (opts.listBlockedResult ?? []).map((t) =>
        withBlockedBy(t, allTasks),
      );
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
      return { inserted: 0, updated: 0, skipped: [] };
    },
    async distinct(_agentId?) {
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("blockedBy field on API responses (smoke)", () => {
  // Fine-grained hitl/dependency permutations are covered by
  // blocked-by.unit.test.ts against computeBlockedBy directly. These smoke
  // tests only confirm the field is wired through each HTTP route.

  it("GET /tasks/:id includes blockedBy on the response", async () => {
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
    expect(Array.isArray(body.blockedBy)).toBe(true);
    expect(body.blockedBy).toContainEqual({ type: "hitl" });
  });

  it("GET /tasks list response includes blockedBy on each task", async () => {
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
    expect(Array.isArray(body.tasks[0].blockedBy)).toBe(true);
    expect(body.tasks[0].blockedBy).toContainEqual({ type: "hitl" });
  });
});
