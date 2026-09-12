/**
 * agent/src/check-plan.unit.test.ts
 *
 * Unit tests for getPlanCandidates() — the PDR-4.1 candidate provider for the
 * autonomous plan-session phase. Mirrors check-dev-task.unit.test.ts's shape
 * (injected deps, assertions on the returned WorkTaskCandidate[]), with the
 * plan-specific additions: candidates are tagged `phase: "plan"` and carry the
 * task's `repo`/`session`, since the dispatched command is
 * `/shipwright:plan-session {repo} {session} --autonomous {id}` rather than
 * dev-task's bare `{id}`.
 */

import { describe, expect, test } from "bun:test";
import type { Task } from "./check-helpers.ts";
import { type CheckPlanDeps, getPlanCandidates } from "./check-plan.ts";
import { FixedClock } from "./clock.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MY_AGENT_ID = "agent-mine";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "PDR-1",
    title: "Plan the autonomous dispatch phase",
    status: "pending",
    repo: "acme/example-repo",
    session: "autonomous-dispatch",
    assignee: MY_AGENT_ID,
    createdAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

interface MakeDepsOptions {
  planTasks?: Task[];
  clock?: CheckPlanDeps["clock"];
  agentId?: string;
}

function makeDeps(options: MakeDepsOptions = {}): CheckPlanDeps {
  const planTasks = options.planTasks ?? [];
  const clock = options.clock ?? FixedClock(new Date("2026-05-31T16:00:00Z"));
  const agentId = options.agentId ?? MY_AGENT_ID;

  return {
    getAutonomousPlanTasks: async (): Promise<Task[]> => planTasks,
    clock,
    agentId,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getPlanCandidates", () => {
  test("returns empty array when store returns no flagged pending tasks", async () => {
    const result = await getPlanCandidates(makeDeps({ planTasks: [] }));
    expect(result).toEqual([]);
  });

  test("returns a single candidate when store returns one flagged pending task", async () => {
    const result = await getPlanCandidates(
      makeDeps({ planTasks: [makeTask()] }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "PDR-1",
      title: "Plan the autonomous dispatch phase",
      createdAt: "2026-05-01T00:00:00.000Z",
      phase: "plan",
      repo: "acme/example-repo",
      session: "autonomous-dispatch",
    });
  });

  test('tags every candidate phase: "plan" so the selector routes it to /shipwright:plan-session', async () => {
    const result = await getPlanCandidates(
      makeDeps({
        planTasks: [makeTask({ id: "PDR-1" }), makeTask({ id: "PDR-2" })],
      }),
    );
    expect(result.map((c) => c.phase)).toEqual(["plan", "plan"]);
  });

  test("returns all candidates when store returns multiple flagged tasks (no early return)", async () => {
    const t1 = makeTask({ id: "PDR-1" });
    const t2 = makeTask({ id: "PDR-2", title: "Second PRD" });
    const result = await getPlanCandidates(makeDeps({ planTasks: [t1, t2] }));
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(["PDR-1", "PDR-2"]);
    expect(result.map((t) => t.title)).toEqual([
      "Plan the autonomous dispatch phase",
      "Second PRD",
    ]);
  });

  test("defaults a missing createdAt to the empty string (oldest-first FIFO sorts it first)", async () => {
    const result = await getPlanCandidates(
      makeDeps({ planTasks: [makeTask({ createdAt: undefined })] }),
    );
    expect(result[0]?.createdAt).toBe("");
  });

  test("drops a task with no repo — the dispatched command needs both repo and session", async () => {
    const result = await getPlanCandidates(
      makeDeps({
        planTasks: [
          makeTask({ id: "PDR-1", repo: undefined }),
          makeTask({ id: "PDR-2" }),
        ],
      }),
    );
    expect(result.map((t) => t.id)).toEqual(["PDR-2"]);
  });

  test("drops a task with no session", async () => {
    const result = await getPlanCandidates(
      makeDeps({
        planTasks: [
          makeTask({ id: "PDR-1", session: undefined }),
          makeTask({ id: "PDR-2" }),
        ],
      }),
    );
    expect(result.map((t) => t.id)).toEqual(["PDR-2"]);
  });

  test("drops a task whose repo/session are present but blank", async () => {
    const result = await getPlanCandidates(
      makeDeps({
        planTasks: [
          makeTask({ id: "PDR-1", repo: "   " }),
          makeTask({ id: "PDR-2", session: "" }),
        ],
      }),
    );
    expect(result).toEqual([]);
  });

  // ─── Human-escalation gate ─────────────────────────────────────────────────
  // The `?autonomousPlanSession=true&status=pending` query carries no hitl
  // filter (Task.hitl is nullable, so `?hitl=false` would drop the entire
  // NULL-hitl queue), so the gate lives in the mapper via
  // isTaskBlockedForDispatch — matching check-review/check-patch/check-deploy.

  test("drops a hitl:true task — a human-escalated task is never autonomously dispatched", async () => {
    const result = await getPlanCandidates(
      makeDeps({
        planTasks: [
          makeTask({ id: "PDR-1", hitl: true }),
          makeTask({ id: "PDR-2" }),
        ],
      }),
    );
    expect(result.map((t) => t.id)).toEqual(["PDR-2"]);
  });

  test("keeps a hitl:false task and a task with no hitl field at all", async () => {
    const result = await getPlanCandidates(
      makeDeps({
        planTasks: [
          makeTask({ id: "PDR-1", hitl: false }),
          makeTask({ id: "PDR-2", hitl: undefined }),
        ],
      }),
    );
    expect(result.map((t) => t.id)).toEqual(["PDR-1", "PDR-2"]);
  });

  test('drops a status:"blocked" task (defense in depth — the query already filters to pending)', async () => {
    const result = await getPlanCandidates(
      makeDeps({
        planTasks: [
          makeTask({ id: "PDR-1", status: "blocked" }),
          makeTask({ id: "PDR-2" }),
        ],
      }),
    );
    expect(result.map((t) => t.id)).toEqual(["PDR-2"]);
  });
});
