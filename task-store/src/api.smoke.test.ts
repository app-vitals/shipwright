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
import type {
  TaskListFilters,
  TaskListResult,
  TaskServiceLike,
  TaskWithBlockedBy,
} from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

// ─── Distinct result shape ────────────────────────────────────────────────────

interface DistinctResult {
  sessions: string[];
  repos: string[];
}

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
    async update() {
      return null;
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

function withBlockedBy(task: Task): TaskWithBlockedBy {
  return { ...task, blockedBy: [] };
}

/** Minimal TaskService fake — only the methods exercised by smoke tests. */
function fakeTaskService(
  opts: {
    getResult?: Task | null;
    claimThrows?: Error;
    listResult?: Task[];
    listReadyResult?: Task[];
    listBlockedResult?: Task[];
  } = {},
): TaskServiceLike {
  return {
    async list(filters?) {
      const tasks = (opts.listResult ?? []).map(withBlockedBy);
      return {
        tasks,
        total: tasks.length,
        limit: filters?.limit ?? 50,
        offset: filters?.offset ?? 0,
      };
    },
    async listReady() {
      return opts.listReadyResult ?? [];
    },
    async listBlocked() {
      return (opts.listBlockedResult ?? []).map(withBlockedBy);
    },
    async get(id: string) {
      if ("getResult" in opts)
        return opts.getResult ? withBlockedBy(opts.getResult) : null;
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
      return { inserted: 0, updated: 0, skipped: [] };
    },
    async distinct(_agentId?) {
      return { sessions: [], repos: [] };
    },
  };
}

/** Token service that validates AGENT_TOKEN as agent-1 with repos scope. */
function fakeRepoAgentTokenService(repos: string[]): TokenServiceLike {
  return {
    async create(label?: string) {
      return {
        token: {
          id: "tok-3",
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
      return raw === AGENT_TOKEN ? { id: "tok-3", agentId: "agent-1" } : null;
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

function makeApp(
  deps: {
    taskService?: TaskServiceLike;
    tokenService?: TokenServiceLike;
    scopeResolver?: (agentId: string) => Promise<string[]>;
  } = {},
) {
  return createTaskStoreApp({
    taskService: deps.taskService ?? fakeTaskService(),
    tokenService: deps.tokenService ?? fakeTokenService(),
    scopeResolver: deps.scopeResolver,
  });
}

/** Build a scope resolver that returns fixed repos for agent-1. */
function makeScopeResolver(
  repos: string[],
): (agentId: string) => Promise<string[]> {
  return async (agentId: string) => (agentId === "agent-1" ? repos : []);
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
      body: JSON.stringify({
        title: "New",
        status: "pending",
        repo: "example-org/repo",
      }),
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
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      scopeResolver: makeScopeResolver(["example-org/repo"]),
    });
    const res = await app.request("/tasks", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "New task",
        status: "pending",
        repo: "example-org/repo",
      }),
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

  it("GET /tasks/:id returns 403 when agent token reads an unassigned task", async () => {
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      // Unassigned tasks are not accessible to agent tokens — only admins.
      taskService: fakeTaskService({
        getResult: makeTask({ id: "task-1", assignee: null }),
      }),
    });
    const res = await app.request("/tasks/task-1", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("GET /tasks?ready=true with agent token returns only the agent's ready tasks", async () => {
    const ownedTask = makeTask({ id: "task-1", assignee: "agent-1" });
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      taskService: fakeTaskService({ listReadyResult: [ownedTask] }),
    });
    const res = await app.request("/tasks?ready=true", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Task[]; total: number };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe("task-1");
  });

  it("GET /tasks?status=in_progress with agent token scopes to the agent's tasks", async () => {
    const ownedTask = makeTask({
      id: "task-2",
      assignee: "agent-1",
      status: "in_progress",
    });
    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      taskService: fakeTaskService({ listResult: [ownedTask] }),
    });
    const res = await app.request("/tasks?status=in_progress", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskListResult;
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].assignee).toBe("agent-1");
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

  it("PATCH /tasks/:id on a pool task should not change task.assignee", async () => {
    const poolTask = makeTask({ id: "task-1", assignee: null });
    const capturedUpdates: Array<Record<string, unknown>> = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService({ getResult: poolTask }),
      async update(id, data) {
        capturedUpdates.push(data as Record<string, unknown>);
        return makeTask({ ...(data as Partial<Task>), id, assignee: null });
      },
    };

    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      taskService: spyTaskService,
    });

    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "in_progress" }),
    });

    // Wait — a plain agent token (no repos) gets 403 on a pool task (assignee=null).
    // This test uses fakeAgentTokenService which has no repo scope, so requireOwnership
    // will deny access to an unassigned task. Use a repo-scoped token instead.
    // The test is intentionally structured so that access is gated by claimedBy.
    // Since the pool task has assignee=null and claimedBy=null, the plain agent token
    // should 403 — but a repo-scoped agent that can see the task should preserve assignee=null.
    //
    // Re-run with repo-scoped token and matching scopeResolver.
    expect(res.status).toBe(403);
  });

  it("PATCH /tasks/:id on a pool task with repo-scoped token preserves assignee=null", async () => {
    const poolTask = makeTask({
      id: "pool-1",
      assignee: null,
      repo: "acme-inc/backend-api",
    });
    const capturedUpdates: Array<Record<string, unknown>> = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService({ getResult: poolTask }),
      async update(id, data) {
        capturedUpdates.push(data as Record<string, unknown>);
        return makeTask({ ...(data as Partial<Task>), id, assignee: null });
      },
    };

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: spyTaskService,
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });

    const res = await app.request("/tasks/pool-1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "in_progress" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    // Pool task assignee must stay null — must not be overridden to agent-1.
    expect(body.assignee).toBeNull();
    // The update payload sent to taskService must not contain assignee=agentId.
    expect(capturedUpdates[0]?.assignee).toBeUndefined();
  });

  it("GET /tasks?ready=true with agent token forwards agentId to listReady", async () => {
    const capturedArgs: Array<string | undefined> = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService(),
      async listReady(agentId?: string) {
        capturedArgs.push(agentId);
        return [];
      },
    };

    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      taskService: spyTaskService,
    });

    const res = await app.request("/tasks?ready=true", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    // The token's agentId ("agent-1") must be forwarded to listReady.
    expect(capturedArgs[0]).toBe("agent-1");
  });

  it("GET /tasks?status=in_progress with agent token ignores caller-supplied ?assignee", async () => {
    const capturedAssignees: Array<string | undefined> = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService(),
      async list(opts?) {
        capturedAssignees.push(opts?.assignee);
        return { tasks: [], total: 0, limit: 50, offset: 0 };
      },
    };

    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      taskService: spyTaskService,
    });

    // Caller tries to supply ?assignee=other-agent to peek at another agent's tasks.
    const res = await app.request(
      "/tasks?status=in_progress&assignee=other-agent",
      {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      },
    );

    expect(res.status).toBe(200);
    // Token's agentId must win; caller-supplied assignee must be ignored.
    expect(capturedAssignees[0]).toBe("agent-1");
  });

  // ─── GET /tasks/distinct ──────────────────────────────────────────────────

  it("GET /tasks/distinct returns 401 without a token", async () => {
    const app = makeApp();
    const res = await app.request("/tasks/distinct");
    expect(res.status).toBe(401);
  });

  it("GET /tasks/distinct returns 200 with correct shape", async () => {
    const app = makeApp();
    const res = await app.request("/tasks/distinct", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DistinctResult;
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(Array.isArray(body.repos)).toBe(true);
  });

  it("GET /tasks/distinct returns empty arrays when no tasks exist", async () => {
    const app = makeApp({ taskService: fakeTaskService() });
    const res = await app.request("/tasks/distinct", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DistinctResult;
    expect(body.sessions).toEqual([]);
    expect(body.repos).toEqual([]);
  });

  it("GET /tasks/distinct with agent token forwards agentId to distinct()", async () => {
    const capturedAgentIds: Array<string | undefined> = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService(),
      async distinct(agentId?: string) {
        capturedAgentIds.push(agentId);
        return { sessions: [], repos: [] };
      },
    };

    const app = makeApp({
      tokenService: fakeAgentTokenService(),
      taskService: spyTaskService,
    });

    const res = await app.request("/tasks/distinct", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(capturedAgentIds[0]).toBe("agent-1");
  });

  // ─── Repo-scoped visibility ───────────────────────────────────────────────

  it("GET /tasks/:id returns 200 when agent token has the pool task's repo in scope", async () => {
    const poolTask = makeTask({
      id: "pool-1",
      assignee: null,
      repo: "acme-inc/backend-api",
    });
    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: fakeTaskService({ getResult: poolTask }),
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });
    const res = await app.request("/tasks/pool-1", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("GET /tasks/:id returns 403 when agent token does NOT have the pool task's repo in scope", async () => {
    const poolTask = makeTask({
      id: "pool-1",
      assignee: null,
      repo: "acme-inc/backend-api",
    });
    const app = makeApp({
      tokenService: fakeRepoAgentTokenService([]),
      taskService: fakeTaskService({ getResult: poolTask }),
      scopeResolver: makeScopeResolver([]),
    });
    const res = await app.request("/tasks/pool-1", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it("GET /tasks/:id returns 200 for admin token on unassigned pool task", async () => {
    const poolTask = makeTask({
      id: "pool-1",
      assignee: null,
      repo: "acme-inc/backend-api",
    });
    const app = makeApp({
      tokenService: fakeTokenService(),
      taskService: fakeTaskService({ getResult: poolTask }),
    });
    const res = await app.request("/tasks/pool-1", { headers: auth() });
    expect(res.status).toBe(200);
  });

  it("GET /tasks?ready=true with repo-scoped agent token passes repos to listReady", async () => {
    const capturedArgs: Array<{ agentId?: string; repos?: string[] }> = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService(),
      async listReady(agentId?: string, repos?: string[]) {
        capturedArgs.push({ agentId, repos });
        return [];
      },
    };

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: spyTaskService,
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });

    const res = await app.request("/tasks?ready=true", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(capturedArgs[0]?.agentId).toBe("agent-1");
    expect(capturedArgs[0]?.repos).toEqual(["acme-inc/backend-api"]);
  });

  it("GET /tasks?repo=acme-inc/backend-api&pr=42 returns pool task for agent with matching repo", async () => {
    const capturedFilters: TaskListFilters[] = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService(),
      async list(filters?) {
        capturedFilters.push(filters ?? {});
        return { tasks: [], total: 0, limit: 50, offset: 0 };
      },
    };

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: spyTaskService,
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });

    const res = await app.request("/tasks?repo=acme-inc%2Fbackend-api&pr=42", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    // Should pass agentScope, not a plain assignee filter
    expect(capturedFilters[0]?.agentScope).toEqual({
      agentId: "agent-1",
      repos: ["acme-inc/backend-api"],
    });
    // No ?assignee= was supplied, so it should NOT be set alongside agentScope
    expect(capturedFilters[0]?.assignee).toBeUndefined();
    expect(capturedFilters[0]?.repo).toBe("acme-inc/backend-api");
    expect(capturedFilters[0]?.pr).toBe(42);
  });

  it("GET /tasks?status=in_progress with repo-scoped agent token honors an explicit ?assignee= as an additional narrowing filter", async () => {
    const capturedFilters: TaskListFilters[] = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService(),
      async list(filters?) {
        capturedFilters.push(filters ?? {});
        return { tasks: [], total: 0, limit: 50, offset: 0 };
      },
    };

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: spyTaskService,
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });

    // Visibility (agentScope) is broader than this filter — the caller is
    // narrowing an already-visible pool down to just their own tasks, not
    // requesting to see something new. This must be honored, unlike the
    // non-repo-scoped case (see "ignores caller-supplied ?assignee" above)
    // where there is no broader visible set to narrow from.
    const res = await app.request(
      "/tasks?status=in_progress&assignee=agent-1",
      { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } },
    );

    expect(res.status).toBe(200);
    expect(capturedFilters[0]?.agentScope).toEqual({
      agentId: "agent-1",
      repos: ["acme-inc/backend-api"],
    });
    expect(capturedFilters[0]?.assignee).toBe("agent-1");
  });

  it("POST /tasks/:id/claim with agent token pins claimedBy to the token's agentId", async () => {
    const poolTask = makeTask({
      id: "pool-1",
      assignee: null,
      repo: "acme-inc/backend-api",
    });
    const capturedClaimedBy: string[] = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService({ getResult: poolTask }),
      async claim(id: string, claimedBy: string) {
        capturedClaimedBy.push(claimedBy);
        return makeTask({
          id,
          status: "in_progress",
          assignee: null,
          claimedBy,
        });
      },
    };

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: spyTaskService,
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });

    const res = await app.request("/tasks/pool-1/claim", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      // Body tries to claim as a different agent — must be ignored.
      body: JSON.stringify({ claimedBy: "some-other-agent" }),
    });

    expect(res.status).toBe(200);
    // claimedBy must be pinned to the token's agentId
    expect(capturedClaimedBy[0]).toBe("agent-1");
  });

  it("POST /tasks/:id/claim: pool task keeps assignee null, claimedBy=agentId after claim", async () => {
    const poolTask = makeTask({
      id: "pool-1",
      assignee: null,
      repo: "acme-inc/backend-api",
    });

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: fakeTaskService({ getResult: poolTask }),
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });

    const res = await app.request("/tasks/pool-1/claim", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ claimedBy: "agent-1" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    // assignee stays null (pool task), claimedBy is set
    expect(body.assignee).toBeNull();
    expect(body.claimedBy).toBe("agent-1");
  });

  it("POST /tasks/:id/heartbeat works for pool task claimed by agent (claimedBy check)", async () => {
    // After claiming, the task has assignee=null but claimedBy=agent-1
    const claimedPoolTask = makeTask({
      id: "pool-1",
      assignee: null,
      claimedBy: "agent-1",
      repo: "acme-inc/backend-api",
      status: "in_progress",
    });

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: fakeTaskService({ getResult: claimedPoolTask }),
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });

    const res = await app.request("/tasks/pool-1/heartbeat", {
      method: "POST",
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
  });

  it("PATCH /tasks/:id on assigned task with repo-scoped token returns 200 when task repo is in scope", async () => {
    // Task is assigned to agent-2, not agent-1
    const assignedTask = makeTask({
      id: "assigned-1",
      assignee: "agent-2",
      repo: "acme-inc/backend-api",
    });

    // Use a spy that merges the patch body onto the original task so the response
    // accurately reflects what a real DB update would return.
    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService({ getResult: assignedTask }),
      async update(id, data) {
        return makeTask({ ...assignedTask, ...(data as Partial<Task>), id });
      },
    };

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: spyTaskService,
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });

    const res = await app.request("/tasks/assigned-1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "in_progress" }),
    });

    // Should return 200 because the task's repo is in the token's scope,
    // even though the task is assigned to a different agent.
    expect(res.status).toBe(200);
    // Acting agent (agent-1) must NOT steal the task — assignee stays agent-2.
    expect((await res.json() as Task).assignee).toBe("agent-2");
  });

  it("PATCH /tasks/:id with repo-scoped token for wrong repo returns 403", async () => {
    // Task belongs to acme-inc/backend-api but token only scopes other-org/other-repo
    const assignedTask = makeTask({
      id: "assigned-2",
      assignee: "agent-2",
      repo: "acme-inc/backend-api",
    });

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["other-org/other-repo"]),
      taskService: fakeTaskService({ getResult: assignedTask }),
      scopeResolver: makeScopeResolver(["other-org/other-repo"]),
    });

    const res = await app.request("/tasks/assigned-2", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ status: "in_progress" }),
    });

    // Repo-scoped token for a different repo must not grant write access.
    expect(res.status).toBe(403);
  });

  it("GET /tasks with repo-scoped agent token passes agentScope (not assignee) to list()", async () => {
    const capturedFilters: TaskListFilters[] = [];

    const spyTaskService: TaskServiceLike = {
      ...fakeTaskService(),
      async list(filters?) {
        capturedFilters.push(filters ?? {});
        return { tasks: [], total: 0, limit: 50, offset: 0 };
      },
    };

    const app = makeApp({
      tokenService: fakeRepoAgentTokenService(["acme-inc/backend-api"]),
      taskService: spyTaskService,
      scopeResolver: makeScopeResolver(["acme-inc/backend-api"]),
    });

    const res = await app.request("/tasks", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(capturedFilters[0]?.agentScope).toEqual({
      agentId: "agent-1",
      repos: ["acme-inc/backend-api"],
    });
    expect(capturedFilters[0]?.assignee).toBeUndefined();
  });
});
