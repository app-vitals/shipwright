/**
 * task-store/src/tasks.execution-fields.smoke.test.ts
 *
 * Smoke test for execution data columns on the Task model.
 * Tests PATCH /tasks/:id with all execution fields + metadata, then GET to verify round-trip.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { Task } from "./index.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

const ADMIN_TOKEN = "admin-token";

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

function adminAuth(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
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
    // Execution data fields
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

function fakeTaskService(storedTasks: Map<string, Task> = new Map()): TaskServiceLike {
  return {
    async list() {
      return { tasks: [], total: 0, limit: 50, offset: 0 };
    },
    async listReady() {
      return [];
    },
    async listBlocked() {
      return [];
    },
    async get(id: string) {
      const task = storedTasks.get(id);
      return task ? withBlockedBy(task) : null;
    },
    async create(data) {
      const id = `created-${Date.now()}`;
      const newTask = makeTask({ ...(data as Partial<Task>), id });
      storedTasks.set(id, newTask);
      return newTask;
    },
    async update(id, data) {
      const existing = storedTasks.get(id);
      if (!existing) throw new Error("Task not found");
      const updated = { ...existing, ...(data as Partial<Task>) };
      storedTasks.set(id, updated);
      return updated;
    },
    async remove() {
      return;
    },
    async claim(id: string, claimedBy: string) {
      const existing = storedTasks.get(id);
      if (!existing) throw new Error("Task not found");
      const updated = { ...existing, status: "in_progress" as const, claimedBy };
      storedTasks.set(id, updated);
      return updated;
    },
    async heartbeat(id: string) {
      const existing = storedTasks.get(id);
      if (!existing) throw new Error("Task not found");
      const updated = { ...existing, status: "in_progress" as const };
      storedTasks.set(id, updated);
      return updated;
    },
    async complete(id: string) {
      const existing = storedTasks.get(id);
      if (!existing) throw new Error("Task not found");
      const updated = { ...existing, status: "done" as const };
      storedTasks.set(id, updated);
      return updated;
    },
    async fail(id: string) {
      const existing = storedTasks.get(id);
      if (!existing) throw new Error("Task not found");
      const updated = { ...existing, status: "blocked" as const };
      storedTasks.set(id, updated);
      return updated;
    },
    async release(id: string) {
      const existing = storedTasks.get(id);
      if (!existing) throw new Error("Task not found");
      const updated = { ...existing, status: "pending" as const };
      storedTasks.set(id, updated);
      return updated;
    },
    async bulk(_tasks) {
      return { inserted: 0, updated: 0 };
    },
    async distinct(): Promise<{ sessions: string[]; repos: string[] }> {
      return Promise.resolve({ sessions: [], repos: [] });
    },
  };
}

describe("Execution data columns — PATCH and GET round-trip", () => {
  it("PATCHes a task with all execution fields + metadata, then GETs and verifies round-trip", async () => {
    const storedTasks = new Map<string, Task>();
    const taskService = fakeTaskService(storedTasks);

    const app = createTaskStoreApp({
      taskService,
      tokenService: fakeAdminTokenService(),
    });

    // 1. Create a task
    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        title: "Test execution fields",
        status: "pending",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Task;
    expect(created.id).toBeDefined();

    // 2. PATCH with all execution fields + metadata
    const executionData = {
      simplifyTotal: 5,
      simplifyDry: 1,
      simplifyDeadCode: 1,
      simplifyNaming: 1,
      simplifyComplexity: 1,
      simplifyConsistency: 1,
      coverageDelta: 2.5,
      effortLevel: "medium",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 100,
      cacheCreationTokens: 50,
      costUsd: 0.015,
      metadata: {
        model: "claude-opus",
        timestamp: "2026-06-25T10:00:00Z",
        custom: { field: "value" },
      },
    };

    const patchRes = await app.request(`/tasks/${created.id}`, {
      method: "PATCH",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify(executionData),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as Task;

    // Verify PATCH returned the updated fields
    expect(patched.simplifyTotal).toBe(5);
    expect(patched.simplifyDry).toBe(1);
    expect(patched.simplifyDeadCode).toBe(1);
    expect(patched.simplifyNaming).toBe(1);
    expect(patched.simplifyComplexity).toBe(1);
    expect(patched.simplifyConsistency).toBe(1);
    expect(patched.coverageDelta).toBe(2.5);
    expect(patched.effortLevel).toBe("medium");
    expect(patched.inputTokens).toBe(1000);
    expect(patched.outputTokens).toBe(500);
    expect(patched.cacheReadTokens).toBe(100);
    expect(patched.cacheCreationTokens).toBe(50);
    expect(patched.costUsd).toBe(0.015);
    expect(patched.metadata).toEqual(executionData.metadata);

    // 3. GET the task and verify all fields round-trip
    const getRes = await app.request(`/tasks/${created.id}`, {
      method: "GET",
      headers: adminAuth(),
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as Task;

    expect(fetched.simplifyTotal).toBe(5);
    expect(fetched.simplifyDry).toBe(1);
    expect(fetched.simplifyDeadCode).toBe(1);
    expect(fetched.simplifyNaming).toBe(1);
    expect(fetched.simplifyComplexity).toBe(1);
    expect(fetched.simplifyConsistency).toBe(1);
    expect(fetched.coverageDelta).toBe(2.5);
    expect(fetched.effortLevel).toBe("medium");
    expect(fetched.inputTokens).toBe(1000);
    expect(fetched.outputTokens).toBe(500);
    expect(fetched.cacheReadTokens).toBe(100);
    expect(fetched.cacheCreationTokens).toBe(50);
    expect(fetched.costUsd).toBe(0.015);
    expect(fetched.metadata).toEqual(executionData.metadata);
  });

  it("existing tasks with null values for new fields are unaffected", async () => {
    const storedTasks = new Map<string, Task>();
    const taskService = fakeTaskService(storedTasks);

    const app = createTaskStoreApp({
      taskService,
      tokenService: fakeAdminTokenService(),
    });

    // Create a task without execution fields (all null)
    const createRes = await app.request("/tasks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        title: "Existing task",
        status: "pending",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Task;

    // GET and verify null values
    const getRes = await app.request(`/tasks/${created.id}`, {
      method: "GET",
      headers: adminAuth(),
    });
    expect(getRes.status).toBe(200);
    const fetched = (await getRes.json()) as Task;

    expect(fetched.simplifyTotal).toBeNull();
    expect(fetched.simplifyDry).toBeNull();
    expect(fetched.coverageDelta).toBeNull();
    expect(fetched.effortLevel).toBeNull();
    expect(fetched.inputTokens).toBeNull();
    expect(fetched.metadata).toBeNull();
  });
});
