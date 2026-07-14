/**
 * agent/src/check-dev-task.unit.test.ts
 *
 * Unit tests for getDevTaskCandidates() — native port of
 * plugins/shipwright/scripts/check-dev-task.ts's qualification logic.
 *
 * Ported from plugins/shipwright/scripts/check-dev-task.unit.test.ts, adjusted to
 * assert on the returned WorkTaskCandidate[] array instead of {exit, output}.
 * HITL-notification cases from the plugin test are intentionally not ported —
 * HITL notification isn't a work candidate for the selector and is out of
 * scope for this native port (see check-dev-task.ts's module doc).
 */

import { describe, expect, test } from "bun:test";
import {
  type CheckDevTaskDeps,
  getDevTaskCandidates,
} from "./check-dev-task.ts";
import type { Task } from "./check-helpers.ts";
import { FixedClock } from "./clock.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MY_AGENT_ID = "agent-mine";
const OTHER_AGENT_ID = "agent-other";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "SWC-1.1",
    title: "Test task",
    status: "pending",
    repo: "acme/example-repo",
    assignee: MY_AGENT_ID,
    addedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

interface MakeDepsOptions {
  readyTasks?: Task[];
  inProgressTasks?: Task[];
  resetCalls?: string[];
  stampCalls?: string[];
  clock?: CheckDevTaskDeps["clock"];
  agentId?: string;
}

function makeDeps(options: MakeDepsOptions = {}): CheckDevTaskDeps {
  const readyTasks = options.readyTasks ?? [];
  const inProgressTasks = options.inProgressTasks ?? [];
  const resetCalls = options.resetCalls ?? [];
  const clock = options.clock ?? FixedClock(new Date("2026-05-31T16:00:00Z"));
  const agentId = options.agentId ?? MY_AGENT_ID;

  return {
    getReadyTasks: async (): Promise<Task[]> => readyTasks,
    getInProgressTasks: async (): Promise<Task[]> => inProgressTasks,
    resetTask: async (id: string): Promise<Task> => {
      resetCalls.push(id);
      return makeTask({ id, status: "pending" });
    },
    stampTask: async (id: string, startedAt: string): Promise<Task> => {
      if (options.stampCalls) options.stampCalls.push(id);
      return makeTask({ id, startedAt });
    },
    clock,
    agentId,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getDevTaskCandidates", () => {
  test("returns empty array when store returns no ready tasks", async () => {
    const result = await getDevTaskCandidates(makeDeps({ readyTasks: [] }));
    expect(result).toEqual([]);
  });

  test("returns a single candidate when store returns one ready task", async () => {
    const task = makeTask();
    const result = await getDevTaskCandidates(makeDeps({ readyTasks: [task] }));
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "SWC-1.1",
      status: "pending",
      createdAt: "2026-05-01T00:00:00.000Z",
      branch: undefined,
      dependencies: undefined,
    });
  });

  test("returns all candidates when store returns multiple ready tasks (no early return)", async () => {
    const t1 = makeTask({ id: "SWC-1.1" });
    const t2 = makeTask({ id: "SWC-1.2", title: "Second task" });
    const result = await getDevTaskCandidates(
      makeDeps({ readyTasks: [t1, t2] }),
    );
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(["SWC-1.1", "SWC-1.2"]);
  });

  test("candidate carries branch and dependencies through", async () => {
    const task = makeTask({
      id: "SWC-1.3",
      branch: "feat/x",
      dependencies: ["SWC-1.0"],
    });
    const result = await getDevTaskCandidates(makeDeps({ readyTasks: [task] }));
    expect(result[0]).toMatchObject({
      branch: "feat/x",
      dependencies: ["SWC-1.0"],
    });
  });

  // ─── Stale in_progress guard ──────────────────────────────────────────────

  test("resets in_progress task older than 45 minutes to pending", async () => {
    const resetCalls: string[] = [];
    const clock = FixedClock(new Date("2026-05-31T16:00:00Z"));
    const staleTask = makeTask({
      id: "SWC-2.1",
      status: "in_progress",
      startedAt: "2026-05-31T15:14:59Z",
    });

    await getDevTaskCandidates(
      makeDeps({ inProgressTasks: [staleTask], resetCalls, clock }),
    );

    expect(resetCalls).toContain("SWC-2.1");
  });

  test("does not reset in_progress task newer than 45 minutes", async () => {
    const resetCalls: string[] = [];
    const clock = FixedClock(new Date("2026-05-31T16:00:00Z"));
    const freshTask = makeTask({
      id: "SWC-2.2",
      status: "in_progress",
      startedAt: "2026-05-31T15:20:00Z",
    });

    await getDevTaskCandidates(
      makeDeps({ inProgressTasks: [freshTask], resetCalls, clock }),
    );

    expect(resetCalls).not.toContain("SWC-2.2");
  });

  test("stamps in_progress task with no startedAt so it ages out naturally", async () => {
    const resetCalls: string[] = [];
    const stampCalls: string[] = [];
    const clock = FixedClock(new Date("2026-05-31T16:00:00Z"));
    const taskWithoutStartedAt = makeTask({
      id: "SWC-2.3",
      status: "in_progress",
    });

    await getDevTaskCandidates(
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
    const clock = FixedClock(new Date("2026-05-31T16:00:00Z"));
    const staleTask = makeTask({
      id: "SWC-2.4",
      status: "in_progress",
      startedAt: "2026-05-31T15:14:59Z",
    });
    const readyTask = makeTask({ id: "SWC-2.5" });

    const result = await getDevTaskCandidates(
      makeDeps({
        inProgressTasks: [staleTask],
        readyTasks: [readyTask],
        resetCalls,
        clock,
      }),
    );

    expect(resetCalls).toContain("SWC-2.4");
    expect(result.map((t) => t.id)).toEqual(["SWC-2.5"]);
  });

  test("returns empty array when only stale task existed and no ready tasks", async () => {
    const resetCalls: string[] = [];
    const clock = FixedClock(new Date("2026-05-31T16:00:00Z"));
    const staleTask = makeTask({
      id: "SWC-2.6",
      status: "in_progress",
      startedAt: "2026-05-31T15:14:59Z",
    });

    const result = await getDevTaskCandidates(
      makeDeps({
        inProgressTasks: [staleTask],
        readyTasks: [],
        resetCalls,
        clock,
      }),
    );

    expect(resetCalls).toContain("SWC-2.6");
    expect(result).toEqual([]);
  });

  // ─── Cross-agent assignee scoping ─────────────────────────────────────────

  test("does not reset a stale in_progress task assigned to a different agent", async () => {
    const resetCalls: string[] = [];
    const clock = FixedClock(new Date("2026-05-31T16:00:00Z"));
    const foreignStaleTask = makeTask({
      id: "OTH-1.1",
      status: "in_progress",
      startedAt: "2026-05-31T15:14:59Z",
      assignee: OTHER_AGENT_ID,
    });

    const result = await getDevTaskCandidates(
      makeDeps({
        inProgressTasks: [foreignStaleTask],
        readyTasks: [],
        resetCalls,
        clock,
        agentId: MY_AGENT_ID,
      }),
    );

    expect(resetCalls).not.toContain("OTH-1.1");
    expect(result).toEqual([]);
  });

  test("does not stamp startedAt on an in_progress task assigned to a different agent", async () => {
    const stampCalls: string[] = [];
    const clock = FixedClock(new Date("2026-05-31T16:00:00Z"));
    const foreignTask = makeTask({
      id: "OTH-1.2",
      status: "in_progress",
      assignee: OTHER_AGENT_ID,
    });

    await getDevTaskCandidates(
      makeDeps({
        inProgressTasks: [foreignTask],
        stampCalls,
        clock,
        agentId: MY_AGENT_ID,
      }),
    );

    expect(stampCalls).not.toContain("OTH-1.2");
  });

  test("still resets a stale in_progress task assigned to this agent alongside a foreign one", async () => {
    const resetCalls: string[] = [];
    const clock = FixedClock(new Date("2026-05-31T16:00:00Z"));
    const mineStale = makeTask({
      id: "SWC-3.1",
      status: "in_progress",
      startedAt: "2026-05-31T15:14:59Z",
      assignee: MY_AGENT_ID,
    });
    const foreignStale = makeTask({
      id: "OTH-1.3",
      status: "in_progress",
      startedAt: "2026-05-31T15:14:59Z",
      assignee: OTHER_AGENT_ID,
    });

    await getDevTaskCandidates(
      makeDeps({
        inProgressTasks: [mineStale, foreignStale],
        resetCalls,
        clock,
        agentId: MY_AGENT_ID,
      }),
    );

    expect(resetCalls).toContain("SWC-3.1");
    expect(resetCalls).not.toContain("OTH-1.3");
  });
});
