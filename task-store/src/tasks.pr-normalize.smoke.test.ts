/**
 * task-store/src/tasks.pr-normalize.smoke.test.ts
 *
 * Sentry VITALS-OS-5X: a PR URL in `pr` reached prisma.task.update (Task.pr is
 * Int?) and 500'd. `pr` is now normalized (integer / integer string / github PR
 * URL -> number) and anything else is a 400 naming the field.
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
  opts: {
    listResult?: Task[];
    capturedListFilters?: TaskListFilters[];
    captured?: unknown[];
  } = {},
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
      opts.captured?.push(data);
      return makeTask({ ...(data as Partial<Task>), id: "created-1" });
    },
    async update(id, data) {
      opts.captured?.push(data);
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

describe("pr normalization on PATCH/POST /tasks (smoke)", () => {
  const patch = (app: ReturnType<typeof makeApp>, pr: unknown) =>
    app.request("/tasks/task-1", {
      method: "PATCH",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ pr }),
    });

  it.each([
    [42, 42],
    ["42", 42],
    [" 42 ", 42],
    ["https://github.com/app-vitals/vitals-os/pull/6296", 6296],
    ["https://github.com/app-vitals/vitals-os/pull/6296/", 6296],
    [null, null],
  ])("PATCH pr=%p stores %p", async (input, expected) => {
    const captured: unknown[] = [];
    const res = await patch(makeApp(fakeTaskService({ captured })), input);
    expect(res.status).toBe(200);
    expect((captured[0] as { pr: unknown }).pr).toBe(expected);
  });

  it.each([
    "abc",
    "",
    "4.5",
    4.5,
    0,
    -3,
    "https://github.com/app-vitals/vitals-os/issues/6296",
    "https://example.com/a/b/pull/1",
    { n: 1 },
    true,
  ])("PATCH pr=%p returns 400 naming the field", async (input) => {
    const captured: unknown[] = [];
    const res = await patch(makeApp(fakeTaskService({ captured })), input);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("pr must be");
    expect(body.error).toContain("github.com");
    expect(captured).toHaveLength(0);
  });

  it("PATCH without pr leaves it untouched", async () => {
    const captured: unknown[] = [];
    const res = await makeApp(fakeTaskService({ captured })).request(
      "/tasks/task-1",
      {
        method: "PATCH",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ note: "x" }),
      },
    );
    expect(res.status).toBe(200);
    expect("pr" in (captured[0] as object)).toBe(false);
  });

  it("POST /tasks normalizes a PR URL and rejects garbage", async () => {
    const captured: unknown[] = [];
    const app = makeApp(fakeTaskService({ captured }));
    const post = (pr: unknown) =>
      app.request("/tasks", {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ title: "t", status: "pending", repo: null, pr }),
      });
    expect((await post("https://github.com/o/r/pull/7")).status).toBe(201);
    expect((captured[0] as { pr: unknown }).pr).toBe(7);
    expect((await post("abc")).status).toBe(400);
  });
});
