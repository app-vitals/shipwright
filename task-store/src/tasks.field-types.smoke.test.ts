/**
 * task-store/src/tasks.field-types.smoke.test.ts
 *
 * POST /tasks, POST /tasks/bulk and PATCH /tasks/:id reject mistyped
 * non-string Task columns with a 400 naming the field (Sentry VITALS-OS-6K).
 * Before, `complexity: "S"` (schema: Int?) reached prisma.task.create() and
 * surfaced as a raw 500.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { Task } from "./index.ts";
import type { SessionServiceLike } from "./session-service.ts";
import type { TaskListFilters, TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

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
      if (raw === VALID_TOKEN) return { id: "tok-1", agentId: null };
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

function fakeTaskService(
  opts: { listResult?: Task[]; capturedListFilters?: TaskListFilters[] } = {},
): TaskServiceLike {
  return {
    async list(filters?: TaskListFilters) {
      if (opts.capturedListFilters && filters) {
        opts.capturedListFilters.push({ ...filters });
      }
      const tasks = (opts.listResult ?? []).map((t) => ({
        ...t,
        blockedBy: [],
      }));
      return {
        tasks,
        total: tasks.length,
        limit: filters?.limit ?? 50,
        offset: filters?.offset ?? 0,
      };
    },
    async listReady() {
      return [];
    },
    async listBlocked() {
      return [];
    },
    async get(id: string) {
      return { ...makeTask({ id }), blockedBy: [] };
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
      return { sessions: [], total: 0, limit: 50, offset: 0 };
    },
    async get() {
      return null;
    },
    async update() {
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

function patch(app: ReturnType<typeof makeApp>, payload: unknown) {
  return app.request("/tasks/task-1", {
    method: "PATCH",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function send(
  app: ReturnType<typeof makeApp>,
  path: string,
  method: string,
  payload: unknown,
) {
  return app.request(path, {
    method,
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const base = { title: "T", status: "pending", repo: null };

describe("task field type validation (smoke)", () => {
  it('POST /tasks returns 400 naming `complexity` for "S"', async () => {
    const res = await send(makeApp(fakeTaskService()), "/tasks", "POST", {
      ...base,
      complexity: "S",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("'complexity'");
  });

  it("POST /tasks/bulk returns 400 naming `complexity` for any item", async () => {
    const res = await send(makeApp(fakeTaskService()), "/tasks/bulk", "POST", [
      base,
      { ...base, complexity: "S" },
    ]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("'complexity'");
  });

  it("PATCH returns 400 for a non-integer int field", async () => {
    const res = await send(
      makeApp(fakeTaskService()),
      "/tasks/task-1",
      "PATCH",
      {
        ciFixAttempts: 1.5,
      },
    );
    expect(res.status).toBe(400);
  });

  it("rejects wrong boolean, float and array types", async () => {
    const app = makeApp(fakeTaskService());
    for (const bad of [
      { hitl: "yes" },
      { hours: "2" },
      { dependencies: "a" },
      { acceptanceCriteria: [1] },
    ]) {
      const res = await send(app, "/tasks", "POST", { ...base, ...bad });
      expect(res.status).toBe(400);
    }
  });

  it("accepts correctly typed and null values", async () => {
    const app = makeApp(fakeTaskService());
    const res = await send(app, "/tasks", "POST", {
      ...base,
      complexity: 3,
      hours: 1.5,
      hitl: false,
      dependencies: ["a"],
    });
    expect(res.status).toBe(201);
    const nulls = await send(app, "/tasks", "POST", {
      ...base,
      complexity: null,
      hitl: null,
    });
    expect(nulls.status).toBe(201);
  });
});
