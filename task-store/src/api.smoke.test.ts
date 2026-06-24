/**
 * task-store/src/api.smoke.test.ts
 *
 * Smoke tests for the task-store Hono app via in-process `app.request()`.
 * No real socket, no real DB — services are injected as in-memory fakes.
 *
 * Covers:
 *   - 401 when the Authorization header is missing
 *   - 401 when the bearer token is invalid / revoked
 *   - 404 for GET /tasks/:id when the task does not exist
 *   - 409 for POST /tasks/:id/claim when the task is already claimed
 *   - GET /health is unauthenticated
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import type { Task } from "./index.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

const VALID_TOKEN = "valid-token";
const AGENT_TOKEN = "agent-token";

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
  };
}

/** Token service that validates AGENT_TOKEN as a scoped agent-1 token. */
function fakeAgentTokenService(): TokenServiceLike {
  return {
    async create(label?: string) {
      return {
        token: {
          id: "tok-2",
          token: "hash",
          label: label ?? null,
          agentId: "agent-1",
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw",
      };
    },
    async validate(raw: string) {
      return raw === AGENT_TOKEN ? { id: "tok-2", agentId: "agent-1" } : null;
    },
    async revoke() {
      return null;
    },
    async list() {
      return [];
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

/** Minimal TaskService fake — only the methods exercised by smoke tests. */
function fakeTaskService(
  opts: {
    getResult?: Task | null;
    claimThrows?: Error;
  } = {},
): TaskServiceLike {
  return {
    async list() {
      return [];
    },
    async listReady() {
      return [];
    },
    async get(id: string) {
      if ("getResult" in opts) return opts.getResult ?? null;
      return makeTask({ id });
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
      if (opts.claimThrows) throw opts.claimThrows;
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

function makeApp(
  deps: {
    taskService?: TaskServiceLike;
    tokenService?: TokenServiceLike;
  } = {},
) {
  return createTaskStoreApp({
    taskService: deps.taskService ?? fakeTaskService(),
    tokenService: deps.tokenService ?? fakeTokenService(),
  });
}

function auth(token = VALID_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("task-store API (smoke)", () => {
  it("GET /health returns 200 without auth", async () => {
    const app = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const app = makeApp();
    const res = await app.request("/tasks");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the bearer token is invalid or revoked", async () => {
    const app = makeApp();
    const res = await app.request("/tasks", {
      headers: auth("bogus-token"),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the Authorization header is malformed", async () => {
    const app = makeApp();
    const res = await app.request("/tasks", {
      headers: { Authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 404 for GET /tasks/:id when the task does not exist", async () => {
    const app = makeApp({ taskService: fakeTaskService({ getResult: null }) });
    const res = await app.request("/tasks/missing", { headers: auth() });
    expect(res.status).toBe(404);
  });

  it("returns 200 for GET /tasks/:id when the task exists", async () => {
    const app = makeApp({
      taskService: fakeTaskService({ getResult: makeTask({ id: "task-1" }) }),
    });
    const res = await app.request("/tasks/task-1", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.id).toBe("task-1");
  });

  it("returns 409 for POST /tasks/:id/claim when already claimed", async () => {
    const app = makeApp({
      taskService: fakeTaskService({
        claimThrows: new ConflictError("already claimed"),
      }),
    });
    const res = await app.request("/tasks/task-1/claim", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ claimedBy: "agent-a" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 200 for a successful claim", async () => {
    const app = makeApp();
    const res = await app.request("/tasks/task-1/claim", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ claimedBy: "agent-a" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.status).toBe("in_progress");
    expect(body.claimedBy).toBe("agent-a");
  });

  it("maps NotFoundError from claim to 404", async () => {
    const app = makeApp({
      taskService: fakeTaskService({
        claimThrows: new NotFoundError("no such task"),
      }),
    });
    const res = await app.request("/tasks/nope/claim", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ claimedBy: "agent-a" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /tasks creates and returns 201", async () => {
    const app = makeApp();
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ title: "New", status: "pending" }),
    });
    expect(res.status).toBe(201);
  });

  it("POST /tasks rejects a body without a title (400)", async () => {
    const app = makeApp();
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ status: "pending" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /tokens returns the raw token once (201)", async () => {
    const app = makeApp();
    const res = await app.request("/tokens", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ label: "ci" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { rawToken: string };
    expect(body.rawToken).toBe("raw");
  });

  // ─── Agent token scoping ──────────────────────────────────────────────────

  it("POST /tasks with agent token forces assignee to the agent's ID", async () => {
    const app = makeApp({ tokenService: fakeAgentTokenService() });
    const res = await app.request("/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "New task", status: "pending" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Task;
    expect(body.assignee).toBe("agent-1");
  });

  it("GET /tasks/:id returns 403 when agent token tries to read a task owned by a different agent", async () => {
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      // Task is owned by agent-2, not agent-1.
      taskService: fakeTaskService({
        getResult: makeTask({ id: "task-1", assignee: "agent-2" }),
      }),
    });
    const res = await app.request("/tasks/task-1", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("POST /tokens returns 403 for an agent token (admin-only route)", async () => {
    const app = makeApp({ tokenService: fakeAgentTokenService() });
    const res = await app.request("/tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "ci" }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /tasks/:id returns 200 when agent token reads an unassigned task", async () => {
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      // Task has no assignee — should be accessible to any agent token.
      taskService: fakeTaskService({
        getResult: makeTask({ id: "task-1", assignee: null }),
      }),
    });
    const res = await app.request("/tasks/task-1", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("PATCH /tasks/:id with agent token pins assignee to the agent's ID", async () => {
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      // Task is owned by agent-1 (the token's agent).
      taskService: fakeTaskService({
        getResult: makeTask({ id: "task-1", assignee: "agent-1" }),
      }),
    });
    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      // Attempt to reassign to a different agent.
      body: JSON.stringify({ assignee: "agent-2", status: "in_progress" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    // Assignee must be pinned back to agent-1, not agent-2.
    expect(body.assignee).toBe("agent-1");
  });
});
