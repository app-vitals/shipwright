import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { Task } from "./index.ts";
import type {
  TaskListFilters,
  TaskListResult,
  TaskServiceLike,
  TaskWithBlockedBy,
} from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";
const AGENT_ID = "agent-1";

// ─── Fakes ────────────────────────────────────────────────────────────────────

function fakeAdminTokenService(): TokenServiceLike {
  return {
    async create(label?: string, agentId?: string) {
      return {
        token: {
          id: "tok-admin",
          token: "hash",
          label: label ?? null,
          agentId: agentId ?? null,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw",
      };
    },
    async validate(raw: string) {
      return raw === ADMIN_TOKEN ? { id: "tok-admin", agentId: null } : null;
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

/** Builds an agent token service where the agent is scoped to the given repos. */
function fakeAgentTokenService(scopedRepos: string[]): TokenServiceLike {
  return {
    async create(label?: string, agentId?: string) {
      return {
        token: {
          id: "tok-agent",
          token: "hash",
          label: label ?? null,
          agentId: agentId ?? AGENT_ID,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw",
      };
    },
    async validate(raw: string) {
      return raw === AGENT_TOKEN
        ? { id: "tok-agent", agentId: AGENT_ID }
        : null;
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
    assignee: AGENT_ID,
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

function fakeTaskService(
  opts: {
    getResult?: Task | null;
  } = {},
): TaskServiceLike {
  return {
    async list(_filters?: TaskListFilters): Promise<TaskListResult> {
      return { tasks: [], total: 0, limit: 50, offset: 0 };
    },
    async listReady() {
      return [];
    },
    async listBlocked() {
      return [];
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
    async distinct(
      _agentId?: string,
    ): Promise<{ sessions: string[]; repos: string[] }> {
      return Promise.resolve({ sessions: [], repos: [] });
    },
  };
}

function adminAuth(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

function agentAuth(): Record<string, string> {
  return { Authorization: `Bearer ${AGENT_TOKEN}` };
}

/** Build app with admin token and optional scope resolver for the agent token. */
function makeAdminApp(deps: { taskService?: TaskServiceLike } = {}) {
  return createTaskStoreApp({
    taskService: deps.taskService ?? fakeTaskService(),
    tokenService: fakeAdminTokenService(),
  });
}

/** Build app with agent token scoped to the given repos. */
function makeAgentApp(
  scopedRepos: string[],
  deps: { taskService?: TaskServiceLike } = {},
) {
  const tokenService = fakeAgentTokenService(scopedRepos);
  return createTaskStoreApp({
    taskService: deps.taskService ?? fakeTaskService(),
    tokenService,
    // Scope resolver returns the repos the agent was configured with.
    scopeResolver: async (_agentId: string) => scopedRepos,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("org/repo format validation — POST /tokens", () => {
  // repos field is not yet persisted (no TaskToken.repos column) — it is
  // silently ignored. Validation is deferred until persistence lands.

  it("silently ignores repos field with invalid format and returns 201", async () => {
    const app = makeAdminApp();
    const res = await app.request("/tokens", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        label: "ci",
        agentId: "agent-1",
        repos: ["myrepo"],
      }),
    });
    expect(res.status).toBe(201);
  });

  it("silently ignores repos field with valid org/repo format and returns 201", async () => {
    const app = makeAdminApp();
    const res = await app.request("/tokens", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        label: "ci",
        agentId: "agent-1",
        repos: ["example-org/my-service"],
      }),
    });
    expect(res.status).toBe(201);
  });

  it("accepts requests without a repos field", async () => {
    const app = makeAdminApp();
    const res = await app.request("/tokens", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ label: "no-repos" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("org/repo format validation — POST /tasks", () => {
  it("rejects repo without a slash with 400", async () => {
    const app = makeAdminApp();
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ title: "T", status: "pending", repo: "myrepo" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts valid org/repo format for admin token → 201", async () => {
    const app = makeAdminApp();
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        title: "T",
        status: "pending",
        repo: "example-org/my-service",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("accepts POST /tasks without a repo field → 201 (no validation triggered)", async () => {
    const app = makeAgentApp(["example-org/my-service"]);
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...agentAuth(), "content-type": "application/json" },
      body: JSON.stringify({ title: "T", status: "pending" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("org/repo scope validation — POST /tasks (agent tokens)", () => {
  it("rejects repo outside agent scope with 400", async () => {
    // Agent is scoped to 'app-vitals/shipwright', tries to create task for 'example-org/my-service'
    const app = makeAgentApp(["app-vitals/shipwright"]);
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...agentAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        title: "T",
        status: "pending",
        repo: "example-org/my-service",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts repo within agent scope → 201", async () => {
    const app = makeAgentApp(["example-org/my-service"]);
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...agentAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        title: "T",
        status: "pending",
        repo: "example-org/my-service",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("admin token bypasses scope check but still gets format validation → 400 on bad format", async () => {
    const app = makeAdminApp();
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ title: "T", status: "pending", repo: "no-slash" }),
    });
    expect(res.status).toBe(400);
  });

  it("admin token with valid org/repo bypasses scope check → 201", async () => {
    // Admin token has no scope — any valid org/repo is allowed
    const app = makeAdminApp();
    const res = await app.request("/tasks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        title: "T",
        status: "pending",
        repo: "example-org/my-service",
      }),
    });
    expect(res.status).toBe(201);
  });
});

describe("org/repo validation — POST /tasks/bulk", () => {
  it("rejects bulk payload with an invalid repo format → 400", async () => {
    const app = makeAdminApp();
    const res = await app.request("/tasks/bulk", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify([
        { title: "T1", status: "pending", repo: "example-org/my-service" },
        { title: "T2", status: "pending", repo: "bad-repo" },
      ]),
    });
    expect(res.status).toBe(400);
  });

  it("accepts bulk payload with all valid repos → 200", async () => {
    const app = makeAdminApp();
    const res = await app.request("/tasks/bulk", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify([
        { title: "T1", status: "pending", repo: "example-org/my-service" },
        { title: "T2", status: "pending", repo: "app-vitals/shipwright" },
      ]),
    });
    expect(res.status).toBe(200);
  });

  it("skips validation for tasks with null repo in bulk", async () => {
    const app = makeAdminApp();
    const res = await app.request("/tasks/bulk", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify([
        { title: "T1", status: "pending", repo: null },
        { title: "T2", status: "pending" },
      ]),
    });
    expect(res.status).toBe(200);
  });

  it("agent token rejects bulk task with repo outside scope → 400", async () => {
    const app = makeAgentApp(["app-vitals/shipwright"]);
    const res = await app.request("/tasks/bulk", {
      method: "POST",
      headers: { ...agentAuth(), "content-type": "application/json" },
      body: JSON.stringify([
        { title: "T1", status: "pending", repo: "example-org/my-service" },
      ]),
    });
    expect(res.status).toBe(400);
  });
});

describe("org/repo validation — PATCH /tasks/:id", () => {
  it("rejects patch with invalid repo format → 400", async () => {
    const app = makeAdminApp({
      taskService: fakeTaskService({
        getResult: makeTask({ id: "task-1", assignee: null }),
      }),
    });
    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ repo: "no-slash" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts patch with valid repo format → 200", async () => {
    const app = makeAdminApp({
      taskService: fakeTaskService({
        getResult: makeTask({ id: "task-1", assignee: null }),
      }),
    });
    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({ repo: "example-org/my-service" }),
    });
    expect(res.status).toBe(200);
  });

  it("agent token rejects patch with repo outside scope → 400", async () => {
    const app = makeAgentApp(["app-vitals/shipwright"], {
      taskService: fakeTaskService({
        getResult: makeTask({ id: "task-1", assignee: AGENT_ID }),
      }),
    });
    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: { ...agentAuth(), "content-type": "application/json" },
      body: JSON.stringify({ repo: "example-org/my-service" }),
    });
    expect(res.status).toBe(400);
  });

  it("agent token accepts patch with repo within scope → 200", async () => {
    const app = makeAgentApp(["example-org/my-service"], {
      taskService: fakeTaskService({
        getResult: makeTask({ id: "task-1", assignee: AGENT_ID }),
      }),
    });
    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: { ...agentAuth(), "content-type": "application/json" },
      body: JSON.stringify({ repo: "example-org/my-service" }),
    });
    expect(res.status).toBe(200);
  });
});
