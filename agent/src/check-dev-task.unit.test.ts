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
 *
 * Stale in_progress reclaim is exclusively StaleClaimReaper's responsibility
 * (see task-store's own reaper unit tests) — this suite only covers the
 * ready-task-mapping behavior that remains in getDevTaskCandidates().
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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "SWC-1.1",
    title: "Test task",
    status: "pending",
    repo: "acme/example-repo",
    assignee: MY_AGENT_ID,
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

interface MakeDepsOptions {
  readyTasks?: Task[];
  clock?: CheckDevTaskDeps["clock"];
  agentId?: string;
}

function makeDeps(options: MakeDepsOptions = {}): CheckDevTaskDeps {
  const readyTasks = options.readyTasks ?? [];
  const clock = options.clock ?? FixedClock(new Date("2026-05-31T16:00:00Z"));
  const agentId = options.agentId ?? MY_AGENT_ID;

  return {
    getReadyTasks: async (): Promise<Task[]> => readyTasks,
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
      title: "Test task",
      createdAt: "2026-05-01T00:00:00.000Z",
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
    expect(result.map((t) => t.title)).toEqual(["Test task", "Second task"]);
  });
});
