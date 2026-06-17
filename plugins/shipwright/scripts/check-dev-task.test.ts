/**
 * plugins/shipwright/scripts/check-dev-task.test.ts
 *
 * Unit tests for check-dev-task.ts
 *
 * Design: the script exports a `run(deps)` function that accepts injected
 * dependencies. Tests inject a stub `getReadyTasks` that returns whatever the
 * mock store would return — dep-satisfaction logic is tested in store.unit.test.ts.
 *
 * Import note: Clock is imported from ./clock.ts (vendored local copy) and
 * FixedClock is imported from ./test-helpers/doubles.ts (local inlined copy).
 * Precheck scripts run from the installed plugin cache at
 * ~/.claude/plugins/cache/<owner>/shipwright/<version>/scripts/ where
 * cross-package paths do not exist. Both local copies keep the plugin
 * self-contained and runnable from any location.
 */

import { describe, expect, test } from "bun:test";
import { run } from "./check-dev-task.ts";
import type { Clock } from "./clock.ts";
import type { Task } from "./store.ts";
import { FixedClock } from "./test-helpers/doubles.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "SWC-1.1",
    title: "Test task",
    status: "pending",
    repo: "acme/example-repo",
    ...overrides,
  };
}

interface MakeDepsOptions {
  readyTasks?: Task[];
  inProgressTasks?: Task[];
  hitlPendingTasks?: Task[];
  resetCalls?: string[];
  stampCalls?: string[];
  clock?: Clock;
}

// Deps stub: injects dependencies returning the given tasks
function makeDeps(options: MakeDepsOptions | Task[] = {}) {
  // Support legacy array shorthand for backward compat with existing tests
  const opts: MakeDepsOptions = Array.isArray(options)
    ? { readyTasks: options }
    : options;

  const readyTasks = opts.readyTasks ?? [];
  const inProgressTasks = opts.inProgressTasks ?? [];
  const hitlPendingTasks = opts.hitlPendingTasks ?? [];
  const resetCalls = opts.resetCalls ?? [];
  const clock = opts.clock ?? FixedClock("2026-05-31T16:00:00Z");

  return {
    getReadyTasks: async (): Promise<Task[]> => readyTasks,
    getInProgressTasks: async (): Promise<Task[]> => inProgressTasks,
    getHitlPendingTasks: async (): Promise<Task[]> => hitlPendingTasks,
    resetTask: async (id: string): Promise<Task> => {
      resetCalls.push(id);
      return makeTask({ id, status: "pending" });
    },
    stampTask: async (id: string, startedAt: string): Promise<Task> => {
      if (opts.stampCalls) opts.stampCalls.push(id);
      return makeTask({ id, startedAt });
    },
    clock,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("check-dev-task", () => {
  test("exits 1 (no output) when store returns no ready tasks", async () => {
    const result = await run(makeDeps([]));
    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 0 with prompt when store returns one ready task", async () => {
    const result = await run(makeDeps([makeTask()]));
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
    expect(result.output.length).toBeGreaterThan(0);
  });

  test("exits 0 with prompt when store returns multiple ready tasks", async () => {
    const result = await run(
      makeDeps([makeTask(), makeTask({ id: "SWC-1.2", title: "Second task" })]),
    );
    expect(result.exit).toBe(0);
    expect(result.output).toBeTruthy();
  });

  test("prompt mentions dev-task", async () => {
    const result = await run(makeDeps([makeTask()]));
    expect(result.exit).toBe(0);
    expect(result.output.toLowerCase()).toContain("dev-task");
  });

  test("prompt does not reference state/todos.json", async () => {
    const result = await run(makeDeps([makeTask()]));
    expect(result.exit).toBe(0);
    expect(result.output).not.toContain("state/todos.json");
  });

  test("prompt references the task store", async () => {
    const result = await run(makeDeps([makeTask()]));
    expect(result.output.toLowerCase()).toContain("task store");
  });

  // ─── Stale in_progress guard ──────────────────────────────────────────────

  test("resets in_progress task older than 4 hours to pending", async () => {
    const resetCalls: string[] = [];
    const clock = FixedClock("2026-05-31T16:00:00Z");
    // 4 hours and 1 second ago — just over the threshold
    const staleTask = makeTask({
      id: "SWC-2.1",
      status: "in_progress",
      startedAt: "2026-05-31T11:59:59Z",
    });

    await run(
      makeDeps({
        inProgressTasks: [staleTask],
        resetCalls,
        clock,
      }),
    );

    expect(resetCalls).toContain("SWC-2.1");
  });

  test("does not reset in_progress task newer than 4 hours", async () => {
    const resetCalls: string[] = [];
    const clock = FixedClock("2026-05-31T16:00:00Z");
    // 1 hour ago — well within the threshold
    const freshTask = makeTask({
      id: "SWC-2.2",
      status: "in_progress",
      startedAt: "2026-05-31T15:00:00Z",
    });

    await run(
      makeDeps({
        inProgressTasks: [freshTask],
        resetCalls,
        clock,
      }),
    );

    expect(resetCalls).not.toContain("SWC-2.2");
  });

  test("stamps in_progress task with no startedAt so it ages out naturally", async () => {
    const resetCalls: string[] = [];
    const stampCalls: string[] = [];
    const clock = FixedClock("2026-05-31T16:00:00Z");
    const taskWithoutStartedAt = makeTask({
      id: "SWC-2.3",
      status: "in_progress",
      // no startedAt — conservative: stamp now, reset 4 hours later
    });

    await run(
      makeDeps({
        inProgressTasks: [taskWithoutStartedAt],
        resetCalls,
        stampCalls,
        clock,
      }),
    );

    expect(stampCalls).toContain("SWC-2.3");
    expect(resetCalls).not.toContain("SWC-2.3");
  });

  test("returns ready tasks even when stale task was reset", async () => {
    const resetCalls: string[] = [];
    const clock = FixedClock("2026-05-31T16:00:00Z");
    const staleTask = makeTask({
      id: "SWC-2.4",
      status: "in_progress",
      startedAt: "2026-05-31T11:59:59Z",
    });
    const readyTask = makeTask({ id: "SWC-2.5" });

    const result = await run(
      makeDeps({
        inProgressTasks: [staleTask],
        readyTasks: [readyTask],
        resetCalls,
        clock,
      }),
    );

    expect(resetCalls).toContain("SWC-2.4");
    expect(result.exit).toBe(0);
  });

  test("exits 1 when only stale task existed and no ready tasks", async () => {
    const resetCalls: string[] = [];
    const clock = FixedClock("2026-05-31T16:00:00Z");
    const staleTask = makeTask({
      id: "SWC-2.6",
      status: "in_progress",
      startedAt: "2026-05-31T11:59:59Z",
    });

    const result = await run(
      makeDeps({
        inProgressTasks: [staleTask],
        readyTasks: [],
        resetCalls,
        clock,
      }),
    );

    expect(resetCalls).toContain("SWC-2.6");
    expect(result.exit).toBe(1);
  });

  // ─── HITL pending notification ────────────────────────────────────────────

  test("exits 0 with HITL notification when only HITL tasks pending (no ready work)", async () => {
    const hitlTask1 = makeTask({
      id: "HIT-3.1",
      title: "Review architecture decision",
      status: "pending",
      hitl: true,
    });
    const hitlTask2 = makeTask({
      id: "HIT-3.2",
      title: "Approve deployment plan",
      status: "pending",
      hitl: true,
    });

    const result = await run(
      makeDeps({
        readyTasks: [],
        hitlPendingTasks: [hitlTask1, hitlTask2],
      }),
    );

    expect(result.exit).toBe(0);
    expect(result.output).toContain("HIT-3.1");
    expect(result.output).toContain("HIT-3.2");
    expect(result.output).toContain("Review architecture decision");
    expect(result.output).toContain("Approve deployment plan");
  });

  test("exits 0 with standard dev-task prompt when both ready and HITL tasks exist", async () => {
    const regularTask = makeTask({ id: "SWC-4.1", title: "Regular task" });
    const hitlTask = makeTask({
      id: "HIT-4.1",
      title: "Human review needed",
      status: "pending",
      hitl: true,
    });

    const result = await run(
      makeDeps({
        readyTasks: [regularTask],
        hitlPendingTasks: [hitlTask],
      }),
    );

    expect(result.exit).toBe(0);
    expect(result.output.toLowerCase()).toContain("dev-task");
  });

  test("excludes HITL tasks with hitlNotifiedAt from notification", async () => {
    const hitlTaskWithNotifiedAt = makeTask({
      id: "HIT-5.1",
      title: "Already notified task",
      status: "pending",
      hitl: true,
      hitlNotifiedAt: "2026-06-17T10:00:00Z",
    });

    const result = await run(
      makeDeps({
        readyTasks: [],
        hitlPendingTasks: [hitlTaskWithNotifiedAt],
      }),
    );

    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });

  test("exits 1 when no ready tasks and no un-notified HITL tasks", async () => {
    const result = await run(
      makeDeps({
        readyTasks: [],
        hitlPendingTasks: [],
      }),
    );

    expect(result.exit).toBe(1);
    expect(result.output).toBe("");
  });
});
