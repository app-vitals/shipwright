/**
 * Tests for plugins/shipwright/scripts/store.ts
 *
 * This is a types-only file — no runtime behavior. Tests verify:
 * 1. Task objects can be constructed with all required + optional fields
 * 2. TaskStore can be implemented (mock implementation below)
 * 3. QueryFilters covers the documented fields
 * 4. dep_satisfied semantics are expressible using only the Task type
 */

import { describe, expect, test } from "bun:test";
import type {
  QueryFilters,
  Task,
  TaskStore,
  TaskStoreConfig,
} from "./store.ts";
import { resolveReadyTasks } from "./store.ts";

// ─── dep_satisfied helper (pure — uses only Task type) ───────────────────────
//
// A dependency is satisfied when:
//   - dep.status is "merged" → satisfied
//   - dep.status is "done" (legacy) → satisfied
//   - dep.status is "cancelled" → satisfied (work is moot; downstream unblocks)
//   - dep shares the same branch as the candidate AND dep.status is
//     "pr_open" | "approved" | "merged" → satisfied
//
function depSatisfied(dep: Task, candidateBranch: string | undefined): boolean {
  if (dep.status === "merged" || dep.status === "done" || dep.status === "cancelled") return true;
  if (
    dep.branch &&
    dep.branch === candidateBranch &&
    (dep.status === "pr_open" || dep.status === "approved")
  ) {
    return true;
  }
  return false;
}

function isReady(task: Task, tasksById: Map<string, Task>): boolean {
  if (task.status !== "pending") return false;
  for (const depId of task.dependencies ?? []) {
    const dep = tasksById.get(depId);
    if (!dep) return false;
    if (!depSatisfied(dep, task.branch)) return false;
  }
  return true;
}

// ─── Mock TaskStore implementation ───────────────────────────────────────────

class MockTaskStore implements TaskStore {
  private store: Task[] = [];

  async query(filters: QueryFilters): Promise<Task[]> {
    return this.store.filter((t) => {
      if (filters.status !== undefined && t.status !== filters.status)
        return false;
      if (filters.session !== undefined && t.session !== filters.session)
        return false;
      if (filters.id !== undefined && t.id !== filters.id) return false;
      if (filters.pr !== undefined && t.pr !== filters.pr) return false;
      if (filters.assignee !== undefined && t.assignee !== filters.assignee)
        return false;
      if (filters.ready === true) {
        const byId = new Map(this.store.map((x) => [x.id, x]));
        return isReady(t, byId);
      }
      return true;
    });
  }

  async append(tasks: Task[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    let updated = 0;
    for (const task of tasks) {
      const idx = this.store.findIndex((t) => t.id === task.id);
      if (idx >= 0) {
        this.store[idx] = { ...this.store[idx], ...task };
        updated++;
      } else {
        this.store.push(task);
        inserted++;
      }
    }
    return { inserted, updated };
  }

  async update(id: string, fields: Partial<Task>): Promise<Task> {
    const idx = this.store.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`task not found: ${id}`);
    this.store[idx] = { ...this.store[idx], ...fields };
    return this.store[idx];
  }

  async setup(): Promise<void> {
    // no-op for mock
  }

  async resolveRepo(): Promise<string> {
    return "acme/example-repo";
  }

  async resolveRepos(): Promise<string[]> {
    return ["acme/example-repo"];
  }

  async cleanup(): Promise<{
    closed: number;
    milestonesClosed: number;
    plansClosed: number;
  }> {
    return { closed: 0, milestonesClosed: 0, plansClosed: 0 };
  }
}

// ─── Task construction ────────────────────────────────────────────────────────

describe("Task type", () => {
  test("can construct a minimal pending task", () => {
    const task: Task = {
      id: "TSR-1.1",
      title: "Adapter interface + canonical Task type",
      status: "pending",
    };
    expect(task.id).toBe("TSR-1.1");
    expect(task.status).toBe("pending");
  });

  test("can construct a fully-specified task with all known fields", () => {
    const task: Task = {
      id: "TSR-1.1",
      source: "shipwright",
      session: "tsr-session",
      repo: "example-repo",
      title: "Adapter interface",
      description: "Types-only file",
      acceptanceCriteria: ["compiles clean", "biome passes"],
      layer: "Shared",
      branch: "feat/tsr-1-1",
      dependencies: ["TSR-0.1"],
      status: "pr_open",
      pr: 999,
      hours: 2,
      addedAt: "2026-05-26T00:00:00Z",
      startedAt: "2026-05-26T01:00:00Z",
      prCreatedAt: "2026-05-26T02:00:00Z",
      mergedAt: "2026-05-26T03:00:00Z",
      blockedAt: "2026-05-26T00:30:00Z",
      blockedReason: "waiting on dep",
      note: "some note",
      type: "feature",
      priority: "high",
      size: "S",
      file: "state/todos.json",
      cancelledAt: "2026-05-26T04:00:00Z",
      completedAt: "2026-05-26T05:00:00Z",
      ciFixAttempts: 2,
      mergeCommit: "abc123",
      prNumber: 999,
      prOpenedAt: "2026-05-26T02:00:00Z",
      prUrl: "https://github.com/acme/example-repo/pull/999",
    };

    expect(task.id).toBe("TSR-1.1");
    expect(task.acceptanceCriteria).toHaveLength(2);
    expect(task.dependencies).toContain("TSR-0.1");
    expect(task.ciFixAttempts).toBe(2);
  });

  test("all status values are assignable", () => {
    const statuses: Task["status"][] = [
      "pending",
      "in_progress",
      "pr_open",
      "approved",
      "merged",
      "done",
      "blocked",
      "cancelled",
    ];
    for (const s of statuses) {
      const t: Task = { id: "x", title: "x", status: s };
      expect(t.status).toBe(s);
    }
  });
});

// ─── QueryFilters ─────────────────────────────────────────────────────────────

describe("QueryFilters type", () => {
  test("can construct empty filters", () => {
    const f: QueryFilters = {};
    expect(f).toEqual({});
  });

  test("can construct filters with all fields", () => {
    const f: QueryFilters = {
      ready: true,
      status: "pending",
      session: "my-session",
      id: "TSR-1.1",
      pr: 42,
    };
    expect(f.ready).toBe(true);
    expect(f.pr).toBe(42);
  });
});

// ─── TaskStoreConfig ──────────────────────────────────────────────────────────

describe("TaskStoreConfig type", () => {
  test("json backend config is valid", () => {
    const cfg: TaskStoreConfig = { taskStore: "json" };
    expect(cfg.taskStore).toBe("json");
  });

  test("github backend config is valid", () => {
    const cfg: TaskStoreConfig = {
      taskStore: "github",
      github: {
        owner: "app-vitals",
        repo: "example-repo",
      },
    };
    expect(cfg.taskStore).toBe("github");
    expect(cfg.github?.owner).toBe("app-vitals");
  });

  test("github config with only owner and repo", () => {
    const cfg: TaskStoreConfig = {
      taskStore: "github",
      github: {
        owner: "danmcaulay",
        repo: "my-repo",
      },
    };
    expect(cfg.github?.repo).toBe("my-repo");
  });

  test("jira backend config is valid with required fields", () => {
    const cfg: TaskStoreConfig = {
      taskStore: "jira",
      jira: {
        baseUrl: "https://example.atlassian.net",
        projectKey: "SHIP",
      },
    };
    expect(cfg.taskStore).toBe("jira");
    expect(cfg.jira?.baseUrl).toBe("https://example.atlassian.net");
    expect(cfg.jira?.projectKey).toBe("SHIP");
  });

  test("jira backend config accepts optional readyJql and statusMap", () => {
    const cfg: TaskStoreConfig = {
      taskStore: "jira",
      jira: {
        baseUrl: "https://example.atlassian.net",
        projectKey: "SHIP",
        readyJql: 'status = "Ready for Dev"',
        statusMap: { "In Progress": "in_progress", Done: "merged" },
      },
    };
    expect(cfg.jira?.readyJql).toBe('status = "Ready for Dev"');
    expect(cfg.jira?.statusMap?.Done).toBe("merged");
  });

  test("jira backend config without optional fields is valid", () => {
    const cfg: TaskStoreConfig = {
      taskStore: "jira",
      jira: {
        baseUrl: "https://acme.atlassian.net",
        projectKey: "ACME",
      },
    };
    expect(cfg.jira?.readyJql).toBeUndefined();
    expect(cfg.jira?.statusMap).toBeUndefined();
  });
});

// ─── TaskStore interface (via MockTaskStore) ──────────────────────────────────

describe("TaskStore interface", () => {
  test("query returns all tasks when filters are empty", async () => {
    const adapter = new MockTaskStore();
    await adapter.append([
      { id: "T-1", title: "Task 1", status: "pending" },
      { id: "T-2", title: "Task 2", status: "in_progress" },
    ]);
    const results = await adapter.query({});
    expect(results).toHaveLength(2);
  });

  test("query filters by status", async () => {
    const adapter = new MockTaskStore();
    await adapter.append([
      { id: "T-1", title: "Task 1", status: "pending" },
      { id: "T-2", title: "Task 2", status: "in_progress" },
    ]);
    const results = await adapter.query({ status: "pending" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("T-1");
  });

  test("query filters by id", async () => {
    const adapter = new MockTaskStore();
    await adapter.append([
      { id: "T-1", title: "Task 1", status: "pending" },
      { id: "T-2", title: "Task 2", status: "pending" },
    ]);
    const results = await adapter.query({ id: "T-2" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("T-2");
  });

  test("query filters by pr number", async () => {
    const adapter = new MockTaskStore();
    await adapter.append([
      { id: "T-1", title: "Task 1", status: "pr_open", pr: 42 },
      { id: "T-2", title: "Task 2", status: "pending" },
    ]);
    const results = await adapter.query({ pr: 42 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("T-1");
  });

  test("append inserts new tasks", async () => {
    const adapter = new MockTaskStore();
    const result = await adapter.append([
      { id: "T-1", title: "Task 1", status: "pending" },
    ]);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
  });

  test("append updates existing tasks", async () => {
    const adapter = new MockTaskStore();
    await adapter.append([
      { id: "T-1", title: "Old title", status: "pending" },
    ]);
    const result = await adapter.append([
      { id: "T-1", title: "New title", status: "pending" },
    ]);
    expect(result.updated).toBe(1);
    const all = await adapter.query({});
    expect(all[0].title).toBe("New title");
  });

  test("update writes specific fields", async () => {
    const adapter = new MockTaskStore();
    await adapter.append([{ id: "T-1", title: "Task 1", status: "pending" }]);
    const updated = await adapter.update("T-1", { status: "in_progress" });
    expect(updated.status).toBe("in_progress");
  });

  test("update throws for unknown id", async () => {
    const adapter = new MockTaskStore();
    await expect(adapter.update("NOPE", { status: "merged" })).rejects.toThrow(
      "task not found: NOPE",
    );
  });

  test("setup resolves without error", async () => {
    const adapter = new MockTaskStore();
    await expect(adapter.setup()).resolves.toBeUndefined();
  });

  test("resolveRepo returns a string", async () => {
    const adapter = new MockTaskStore();
    const repo = await adapter.resolveRepo();
    expect(typeof repo).toBe("string");
    expect(repo).toContain("/");
  });
});

// ─── dep_satisfied semantics ──────────────────────────────────────────────────

describe("dep_satisfied semantics (pure — uses only Task type)", () => {
  test("dep with status=merged is satisfied", () => {
    const dep: Task = { id: "D-1", title: "Dep", status: "merged" };
    expect(depSatisfied(dep, "feat/any")).toBe(true);
  });

  test("dep with status=done is satisfied (legacy)", () => {
    const dep: Task = { id: "D-1", title: "Dep", status: "done" };
    expect(depSatisfied(dep, "feat/any")).toBe(true);
  });

  test("dep with status=cancelled is satisfied (downstream unblocks)", () => {
    const dep: Task = { id: "D-1", title: "Dep", status: "cancelled" };
    expect(depSatisfied(dep, "feat/any")).toBe(true);
  });

  test("dep with status=in_progress on different branch is NOT satisfied", () => {
    const dep: Task = {
      id: "D-1",
      title: "Dep",
      status: "in_progress",
      branch: "feat/dep-branch",
    };
    expect(depSatisfied(dep, "feat/candidate-branch")).toBe(false);
  });

  test("dep with status=pr_open on SAME branch is satisfied", () => {
    const dep: Task = {
      id: "D-1",
      title: "Dep",
      status: "pr_open",
      branch: "feat/shared",
    };
    expect(depSatisfied(dep, "feat/shared")).toBe(true);
  });

  test("dep with status=approved on SAME branch is satisfied", () => {
    const dep: Task = {
      id: "D-1",
      title: "Dep",
      status: "approved",
      branch: "feat/shared",
    };
    expect(depSatisfied(dep, "feat/shared")).toBe(true);
  });

  test("dep with status=pending on SAME branch is NOT satisfied", () => {
    const dep: Task = {
      id: "D-1",
      title: "Dep",
      status: "pending",
      branch: "feat/shared",
    };
    expect(depSatisfied(dep, "feat/shared")).toBe(false);
  });

  test("dep with no branch, non-terminal status is NOT satisfied", () => {
    const dep: Task = { id: "D-1", title: "Dep", status: "pr_open" };
    expect(depSatisfied(dep, "feat/candidate")).toBe(false);
  });

  test("isReady: pending task with no deps is ready", () => {
    const task: Task = {
      id: "T-1",
      title: "T",
      status: "pending",
      dependencies: [],
    };
    expect(isReady(task, new Map())).toBe(true);
  });

  test("isReady: non-pending task is never ready", () => {
    const task: Task = { id: "T-1", title: "T", status: "in_progress" };
    expect(isReady(task, new Map())).toBe(false);
  });

  test("isReady: pending task with unknown dep is NOT ready (conservative)", () => {
    const task: Task = {
      id: "T-1",
      title: "T",
      status: "pending",
      dependencies: ["D-UNKNOWN"],
    };
    expect(isReady(task, new Map())).toBe(false);
  });

  test("isReady: pending task with merged dep is ready", () => {
    const dep: Task = { id: "D-1", title: "Dep", status: "merged" };
    const task: Task = {
      id: "T-1",
      title: "T",
      status: "pending",
      dependencies: ["D-1"],
      branch: "feat/t-1",
    };
    const byId = new Map([["D-1", dep]]);
    expect(isReady(task, byId)).toBe(true);
  });
});

// ─── TaskStatus includes deployed ────────────────────────────────────────────

describe("TaskStatus includes deployed", () => {
  test("deployed is a valid TaskStatus value", () => {
    const task: Task = { id: "D-1", title: "Dep", status: "deployed" };
    expect(task.status).toBe("deployed");
  });

  test("all status values include deployed", () => {
    const statuses: Task["status"][] = [
      "pending",
      "in_progress",
      "pr_open",
      "approved",
      "merged",
      "done",
      "deployed",
      "blocked",
      "cancelled",
    ];
    for (const s of statuses) {
      const t: Task = { id: "x", title: "x", status: s };
      expect(t.status).toBe(s);
    }
  });
});

// ─── Task.assignee field ──────────────────────────────────────────────────────

describe("Task assignee field", () => {
  test("Task interface accepts assignee field", () => {
    const task: Task = {
      id: "TSR-1.1",
      title: "Assignee task",
      status: "pending",
      assignee: "octocat",
    };
    expect(task.assignee).toBe("octocat");
  });

  test("Task interface works without assignee field", () => {
    const task: Task = {
      id: "TSR-1.2",
      title: "No assignee task",
      status: "pending",
    };
    expect(task.assignee).toBeUndefined();
  });
});

// ─── QueryFilters.assignee field ─────────────────────────────────────────────

describe("QueryFilters assignee field", () => {
  test("QueryFilters accepts assignee field", () => {
    const f: QueryFilters = { assignee: "alice" };
    expect(f.assignee).toBe("alice");
  });

  test("QueryFilters works without assignee field", () => {
    const f: QueryFilters = { status: "pending" };
    expect(f.assignee).toBeUndefined();
  });

  test("MockTaskStore filters by assignee", async () => {
    const adapter = new MockTaskStore();
    await adapter.append([
      { id: "T-1", title: "Alice task", status: "pending", assignee: "alice" },
      { id: "T-2", title: "Bob task", status: "pending", assignee: "bob" },
    ]);
    const results = await adapter.query({ assignee: "alice" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("T-1");
  });
});

// ─── TaskStatus includes deploying ───────────────────────────────────────────

describe("TaskStatus includes deploying", () => {
  test("deploying is a valid TaskStatus value", () => {
    const task: Task = { id: "D-1", title: "Dep", status: "deploying" };
    expect(task.status).toBe("deploying");
  });

  test("Task interface accepts deployingAt field", () => {
    const task: Task = {
      id: "D-1",
      title: "Dep",
      status: "deploying",
      deployingAt: "2026-05-28T13:30:00.000Z",
    };
    expect(task.deployingAt).toBe("2026-05-28T13:30:00.000Z");
  });

  test("all status values include deploying", () => {
    const statuses: Task["status"][] = [
      "pending",
      "in_progress",
      "pr_open",
      "approved",
      "merged",
      "done",
      "deployed",
      "deploying",
      "blocked",
      "cancelled",
    ];
    for (const s of statuses) {
      const t: Task = { id: "x", title: "x", status: s };
      expect(t.status).toBe(s);
    }
  });
});

// ─── resolveReadyTasks ────────────────────────────────────────────────────────

describe("resolveReadyTasks", () => {
  test("returns pending tasks with no deps", async () => {
    const tasks: Task[] = [
      { id: "T-1", title: "No deps", status: "pending", dependencies: [] },
      { id: "T-2", title: "In progress", status: "in_progress" },
    ];
    const ready = await resolveReadyTasks(tasks, async () => false);
    expect(ready.map((t) => t.id)).toEqual(["T-1"]);
  });

  test("deployed dep satisfies dependency", async () => {
    const tasks: Task[] = [
      { id: "D-1", title: "Dep", status: "deployed" },
      {
        id: "T-1",
        title: "Task",
        status: "pending",
        dependencies: ["D-1"],
      },
    ];
    const ready = await resolveReadyTasks(tasks, async () => false);
    expect(ready.map((t) => t.id)).toContain("T-1");
  });

  test("merged dep satisfies dependency", async () => {
    const tasks: Task[] = [
      { id: "D-1", title: "Dep", status: "merged" },
      { id: "T-1", title: "Task", status: "pending", dependencies: ["D-1"] },
    ];
    const ready = await resolveReadyTasks(tasks, async () => false);
    expect(ready.map((t) => t.id)).toContain("T-1");
  });

  test("done dep satisfies dependency (legacy)", async () => {
    const tasks: Task[] = [
      { id: "D-1", title: "Dep", status: "done" },
      { id: "T-1", title: "Task", status: "pending", dependencies: ["D-1"] },
    ];
    const ready = await resolveReadyTasks(tasks, async () => false);
    expect(ready.map((t) => t.id)).toContain("T-1");
  });

  test("same-branch pr_open dep satisfies dependency", async () => {
    const branch = "feat/shared";
    const tasks: Task[] = [
      { id: "D-1", title: "Dep", status: "pr_open", branch },
      {
        id: "T-1",
        title: "Task",
        status: "pending",
        branch,
        dependencies: ["D-1"],
      },
    ];
    const ready = await resolveReadyTasks(tasks, async () => false);
    expect(ready.map((t) => t.id)).toContain("T-1");
  });

  test("cross-branch pr_open dep calls isPrMerged", async () => {
    const isPrMergedCalls: number[] = [];
    const tasks: Task[] = [
      {
        id: "D-1",
        title: "Dep",
        status: "pr_open",
        branch: "feat/dep",
        pr: 42,
      },
      {
        id: "T-1",
        title: "Task",
        status: "pending",
        branch: "feat/task",
        dependencies: ["D-1"],
      },
    ];
    await resolveReadyTasks(tasks, async (prNumber) => {
      isPrMergedCalls.push(prNumber);
      return false;
    });
    expect(isPrMergedCalls).toContain(42);
  });

  test("cross-branch pr_open dep with merged PR satisfies dependency", async () => {
    const tasks: Task[] = [
      {
        id: "D-1",
        title: "Dep",
        status: "pr_open",
        branch: "feat/dep",
        pr: 42,
      },
      {
        id: "T-1",
        title: "Task",
        status: "pending",
        branch: "feat/task",
        dependencies: ["D-1"],
      },
    ];
    const ready = await resolveReadyTasks(tasks, async () => true);
    expect(ready.map((t) => t.id)).toContain("T-1");
  });

  test("cross-branch pr_open dep with unmerged PR does NOT satisfy dependency", async () => {
    const tasks: Task[] = [
      {
        id: "D-1",
        title: "Dep",
        status: "pr_open",
        branch: "feat/dep",
        pr: 42,
      },
      {
        id: "T-1",
        title: "Task",
        status: "pending",
        branch: "feat/task",
        dependencies: ["D-1"],
      },
    ];
    const ready = await resolveReadyTasks(tasks, async () => false);
    expect(ready.map((t) => t.id)).not.toContain("T-1");
  });

  test("cancelled dep satisfies dependency", async () => {
    const tasks: Task[] = [
      { id: "D-1", title: "Dep", status: "cancelled" },
      { id: "T-1", title: "Task", status: "pending", dependencies: ["D-1"] },
    ];
    const ready = await resolveReadyTasks(tasks, async () => false);
    expect(ready.map((t) => t.id)).toContain("T-1");
  });

  test("unknown dep ID — NOT ready (conservative)", async () => {
    const tasks: Task[] = [
      {
        id: "T-1",
        title: "Task",
        status: "pending",
        dependencies: ["UNKNOWN"],
      },
    ];
    const ready = await resolveReadyTasks(tasks, async () => false);
    expect(ready).toHaveLength(0);
  });
});
