import { describe, expect, it } from "bun:test";
import { computeBlockedBy } from "./blocked-by.ts";
import type { ReadyTaskLike } from "./ready.ts";
import { CLOSED_STATUSES, OPEN_STATUSES } from "./statuses.ts";
import type { TaskListFilters } from "./task-service.ts";

// ─── Minimal in-memory stub matching only the logic under test ────────────────

interface MinimalTask extends ReadyTaskLike {
  title: string;
  assignee?: string | null;
}

function makeMinimalTask(overrides: Partial<MinimalTask> = {}): MinimalTask {
  return {
    id: "task-1",
    title: "A task",
    status: "pending",
    branch: null,
    dependencies: [],
    pr: null,
    hitl: null,
    hitlNotifiedAt: null,
    assignee: null,
    ...overrides,
  };
}

function listBlockedLogic(
  allTasks: MinimalTask[],
): (MinimalTask & { blockedBy: ReturnType<typeof computeBlockedBy> })[] {
  return allTasks
    .filter((t) => {
      if (t.status === "blocked") return true;
      if (t.status === "pending") {
        const blockedBy = computeBlockedBy(t, allTasks);
        return blockedBy.length > 0;
      }
      return false;
    })
    .map((t) => ({ ...t, blockedBy: computeBlockedBy(t, allTasks) }));
}

function applyStateFilter(
  tasks: MinimalTask[],
  filters: TaskListFilters,
): MinimalTask[] {
  if (filters.status) {
    return tasks.filter((t) => t.status === filters.status);
  }
  if (filters.state === "open") {
    const open = new Set<string>(OPEN_STATUSES);
    return tasks.filter((t) => open.has(t.status));
  }
  if (filters.state === "closed") {
    const closed = new Set<string>(CLOSED_STATUSES);
    return tasks.filter((t) => closed.has(t.status));
  }
  if (filters.state === "in_progress") {
    const inProgressStatuses = new Set(["in_progress", "pr_open", "approved"]);
    return tasks.filter((t) => inProgressStatuses.has(t.status));
  }
  // state=ready and state=blocked are handled separately in TaskService (not via filter)
  return tasks;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TaskService state filter logic (unit)", () => {
  // ─── state=open (unchanged) ─────────────────────────────────────────────────

  it("state=open returns tasks with open statuses", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "in_progress" }),
      makeMinimalTask({ id: "t3", status: "done" }),
      makeMinimalTask({ id: "t4", status: "merged" }),
    ];
    const result = applyStateFilter(tasks, { state: "open" });
    expect(result.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("state=open includes all OPEN_STATUSES: pending, in_progress, pr_open, approved, blocked", () => {
    const tasks = OPEN_STATUSES.map((s) =>
      makeMinimalTask({ id: `t-${s}`, status: s }),
    );
    const result = applyStateFilter(tasks, { state: "open" });
    expect(result).toHaveLength(OPEN_STATUSES.length);
  });

  // ─── state=closed (unchanged) ───────────────────────────────────────────────

  it("state=closed returns tasks with closed statuses", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "done" }),
      makeMinimalTask({ id: "t3", status: "merged" }),
      makeMinimalTask({ id: "t4", status: "cancelled" }),
    ];
    const result = applyStateFilter(tasks, { state: "closed" });
    expect(result.map((t) => t.id)).toEqual(["t2", "t3", "t4"]);
  });

  it("state=closed includes all CLOSED_STATUSES: merged, done, deploying, deployed, cancelled", () => {
    const tasks = CLOSED_STATUSES.map((s) =>
      makeMinimalTask({ id: `t-${s}`, status: s }),
    );
    const result = applyStateFilter(tasks, { state: "closed" });
    expect(result).toHaveLength(CLOSED_STATUSES.length);
  });

  // ─── state=in_progress ──────────────────────────────────────────────────────

  it("state=in_progress returns tasks with status in_progress", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "in_progress" }),
      makeMinimalTask({ id: "t3", status: "done" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result.map((t) => t.id)).toEqual(["t2"]);
  });

  it("state=in_progress returns tasks with status pr_open", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "pr_open" }),
      makeMinimalTask({ id: "t3", status: "merged" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result.map((t) => t.id)).toEqual(["t2"]);
  });

  it("state=in_progress returns tasks with status approved", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "approved" }),
      makeMinimalTask({ id: "t3", status: "blocked" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result.map((t) => t.id)).toEqual(["t2"]);
  });

  it("state=in_progress returns all three statuses: in_progress, pr_open, approved", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "in_progress" }),
      makeMinimalTask({ id: "t2", status: "pr_open" }),
      makeMinimalTask({ id: "t3", status: "approved" }),
      makeMinimalTask({ id: "t4", status: "pending" }),
      makeMinimalTask({ id: "t5", status: "done" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("state=in_progress returns empty array when no matching tasks", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "pending" }),
      makeMinimalTask({ id: "t2", status: "done" }),
    ];
    const result = applyStateFilter(tasks, { state: "in_progress" });
    expect(result).toHaveLength(0);
  });
});

// ─── listBlocked logic ────────────────────────────────────────────────────────

describe("listBlocked logic (unit)", () => {
  it("returns tasks with status=blocked explicitly", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "blocked" }),
      makeMinimalTask({ id: "t2", status: "pending" }),
      makeMinimalTask({ id: "t3", status: "done" }),
    ];
    const result = listBlockedLogic(tasks);
    expect(result.map((t) => t.id)).toEqual(["t1"]);
    expect(result[0].blockedBy).toEqual([]);
  });

  it("returns pending tasks with an HITL gate (hitl=true, hitlNotifiedAt=null)", () => {
    const tasks = [
      makeMinimalTask({
        id: "t1",
        status: "pending",
        hitl: true,
        hitlNotifiedAt: null,
      }),
      makeMinimalTask({ id: "t2", status: "pending", hitl: false }),
    ];
    const result = listBlockedLogic(tasks);
    expect(result.map((t) => t.id)).toEqual(["t1"]);
    expect(result[0].blockedBy).toContainEqual({ type: "hitl" });
  });

  it("returns pending tasks blocked by HITL with notification already sent", () => {
    const tasks = [
      makeMinimalTask({
        id: "t1",
        status: "pending",
        hitl: true,
        hitlNotifiedAt: "2026-06-25T10:00:00.000Z",
      }),
      makeMinimalTask({ id: "t2", status: "pending" }),
    ];
    const result = listBlockedLogic(tasks);
    expect(result.map((t) => t.id)).toEqual(["t1"]);
    expect(result[0].blockedBy).toContainEqual({
      type: "hitl",
      notified: true,
    });
  });

  it("returns pending tasks with unsatisfied dependencies", () => {
    const dep = makeMinimalTask({ id: "dep-1", status: "in_progress" });
    const blocked = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    const ready = makeMinimalTask({ id: "t2", status: "pending" });
    const tasks = [dep, blocked, ready];
    const result = listBlockedLogic(tasks);
    expect(result.map((t) => t.id)).toEqual(["t1"]);
    expect(result[0].blockedBy).toContainEqual({
      type: "dependency",
      id: "dep-1",
      status: "in_progress",
    });
  });

  it("does not return pending tasks with all deps satisfied (done)", () => {
    const dep = makeMinimalTask({ id: "dep-1", status: "done" });
    const ready = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    const tasks = [dep, ready];
    const result = listBlockedLogic(tasks);
    expect(result).toHaveLength(0);
  });

  it("does not return non-pending tasks (in_progress, pr_open, etc.)", () => {
    const tasks = [
      makeMinimalTask({ id: "t1", status: "in_progress" }),
      makeMinimalTask({ id: "t2", status: "pr_open" }),
      makeMinimalTask({ id: "t3", status: "approved" }),
      makeMinimalTask({ id: "t4", status: "done" }),
    ];
    const result = listBlockedLogic(tasks);
    expect(result).toHaveLength(0);
  });

  it("returns both explicitly blocked and dep-blocked pending tasks together", () => {
    const dep = makeMinimalTask({ id: "dep-1", status: "pending" });
    const depBlocked = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    const explicitBlocked = makeMinimalTask({ id: "t2", status: "blocked" });
    const unblocked = makeMinimalTask({ id: "t3", status: "pending" });
    const tasks = [dep, depBlocked, explicitBlocked, unblocked];
    const result = listBlockedLogic(tasks);
    const ids = result.map((t) => t.id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t2");
    expect(ids).not.toContain("t3");
    expect(ids).not.toContain("dep-1");
  });

  it("does not return tasks with missing dep IDs if those are unknown → dep-blocked is included", () => {
    const t = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["missing-dep"],
    });
    const result = listBlockedLogic([t]);
    expect(result).toHaveLength(1);
    expect(result[0].blockedBy).toContainEqual({
      type: "dependency",
      id: "missing-dep",
      status: "unknown",
    });
  });

  it("blockedBy is computed and attached to results", () => {
    const dep = makeMinimalTask({ id: "dep-1", status: "in_progress" });
    const t = makeMinimalTask({
      id: "t1",
      status: "pending",
      dependencies: ["dep-1"],
    });
    const result = listBlockedLogic([dep, t]);
    expect(result[0]).toHaveProperty("blockedBy");
    expect(result[0].blockedBy).toEqual([
      { type: "dependency", id: "dep-1", status: "in_progress" },
    ]);
  });
});
