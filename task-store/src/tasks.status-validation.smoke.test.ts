/**
 * task-store/src/tasks.status-validation.smoke.test.ts
 *
 * Smoke coverage for GET /tasks?status= input validation (Sentry issue
 * 7603167547). Before this fix, an unvalidated ?status= value (e.g.
 * "claimed" — not a member of the Prisma TaskStatus enum) reached
 * taskService.list() unchecked; against the real Prisma-backed service this
 * throws PrismaClientValidationError, which is not an ApiError and falls
 * into the generic onError 500 branch. The fix validates ?status= against
 * the union of OPEN_STATUSES/CLOSED_STATUSES (task-store/src/statuses.ts)
 * before calling taskService.list(), returning 400 via BadRequestError for
 * anything outside that set — matching the "status is required" validation
 * precedent on POST /tasks.
 *
 * The fake TaskServiceLike below never throws on an invalid status (it has
 * no knowledge of Prisma's enum), so this test suite is only meaningful
 * against the route's own validation, not against fake behavior.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { Task } from "./index.ts";
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

function fakeTaskService(opts: {
  listResult?: Task[];
  capturedListFilters?: TaskListFilters[];
} = {}): TaskServiceLike {
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

function makeApp(taskService: TaskServiceLike) {
  return createTaskStoreApp({
    taskService,
    tokenService: fakeTokenService(),
  });
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${VALID_TOKEN}` };
}

describe("GET /tasks status validation (smoke)", () => {
  it("returns 400 (not 500) for a status value that is not in the TaskStatus enum ('claimed')", async () => {
    const app = makeApp(fakeTaskService());
    const res = await app.request("/tasks?status=claimed", {
      headers: auth(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("invalid status");
    expect(body.error).toContain("claimed");
  });

  it("returns 400 for another arbitrary non-enum status value", async () => {
    const app = makeApp(fakeTaskService());
    const res = await app.request("/tasks?status=bogus-status", {
      headers: auth(),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an empty ?status= value", async () => {
    const app = makeApp(fakeTaskService());
    const res = await app.request("/tasks?status=", { headers: auth() });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a valid status value with unexpected casing ('Pending')", async () => {
    const app = makeApp(fakeTaskService());
    const res = await app.request("/tasks?status=Pending", {
      headers: auth(),
    });
    expect(res.status).toBe(400);
  });

  it("still returns 200 for a valid TaskStatus enum value ('pending')", async () => {
    const capturedListFilters: TaskListFilters[] = [];
    const app = makeApp(fakeTaskService({ capturedListFilters }));
    const res = await app.request("/tasks?status=pending", {
      headers: auth(),
    });
    expect(res.status).toBe(200);
    expect(capturedListFilters[0]?.status).toBe("pending");
  });

  it("still returns 200 for each valid TaskStatus enum value", async () => {
    const validStatuses = [
      "pending",
      "in_progress",
      "pr_open",
      "approved",
      "merged",
      "done",
      "deploying",
      "deployed",
      "blocked",
      "cancelled",
    ];
    for (const status of validStatuses) {
      const app = makeApp(fakeTaskService());
      const res = await app.request(`/tasks?status=${status}`, {
        headers: auth(),
      });
      expect(res.status).toBe(200);
    }
  });

  it("still returns 200 when ?status= is omitted entirely (no filter applied)", async () => {
    const capturedListFilters: TaskListFilters[] = [];
    const app = makeApp(fakeTaskService({ capturedListFilters }));
    const res = await app.request("/tasks", { headers: auth() });
    expect(res.status).toBe(200);
    expect(capturedListFilters[0]?.status).toBeUndefined();
  });
});
