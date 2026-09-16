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
import {
  buildPrdTaskQuery,
  type CheckPlanDeps,
  getPlanCandidates,
} from "./check-plan.ts";
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
    getPrdTasks: async (): Promise<Task[]> => planTasks,
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
  // buildPrdTaskQuery()'s task-store query carries no hitl
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

// ─── Task-store query shape (TKD-1.1) ─────────────────────────────────────────

/**
 * Mirrors how the task-store evaluates a list query: TaskService.list()
 * (`task-store/src/task-service.ts`) assigns every supplied filter onto a
 * single Prisma `where` object, so a row is returned only if it satisfies
 * EVERY param — a strict AND, never an OR. Query params arrive as strings, so
 * each row field is compared stringified.
 */
function matchesQuery(
  query: URLSearchParams,
  row: Record<string, unknown>,
): boolean {
  return [...query.entries()].every(
    ([key, value]) => String(row[key]) === value,
  );
}

describe("buildPrdTaskQuery", () => {
  test("asks the task store for still-pending PRD tasks", () => {
    const query = buildPrdTaskQuery();
    expect(query.get("autonomousPlanSession")).toBe("true");
    expect(query.get("status")).toBe("pending");
  });

  // The agent and the task-store deploy independently, and the task-store
  // ignores query params it doesn't recognize instead of rejecting them. On a
  // task-store that predates TKD-1.1, a kind-only query would silently widen
  // to `?status=pending` — every pending task becomes a plan candidate and
  // ordinary dev tasks get dispatched as `/shipwright:plan-session
  // --autonomous`. The legacy flag is what keeps the pool narrow on both old
  // and new stores.
  test("sends the legacy autonomousPlanSession flag, not kind, for the transition window", () => {
    expect(buildPrdTaskQuery().has("kind")).toBe(false);
  });

  test("sends no filter beyond the legacy flag and status", () => {
    expect([...buildPrdTaskQuery().keys()].sort()).toEqual([
      "autonomousPlanSession",
      "status",
    ]);
  });

  // The regression this shape exists to prevent: sending `kind=prd` alongside
  // the legacy flag ANDs the two, and the mid-rollout divergence row (an old
  // task-store pod wrote `autonomousPlanSession: true` while `kind` stayed at
  // the migration's `dev` default) fails the `kind` conjunct. task-store's
  // ready.ts already excludes that row from the dev-task pool via an OR, so an
  // AND-ed plan query would leave it invisible to BOTH providers forever.
  test("still selects the mid-rollout divergence row (kind='dev' + legacy flag true)", () => {
    expect(
      matchesQuery(buildPrdTaskQuery(), {
        kind: "dev",
        autonomousPlanSession: true,
        status: "pending",
      }),
    ).toBe(true);
  });

  test("selects an ordinary PRD row whose kind and legacy flag agree", () => {
    expect(
      matchesQuery(buildPrdTaskQuery(), {
        kind: "prd",
        autonomousPlanSession: true,
        status: "pending",
      }),
    ).toBe(true);
  });

  test("does not select an ordinary pending dev task", () => {
    expect(
      matchesQuery(buildPrdTaskQuery(), {
        kind: "dev",
        autonomousPlanSession: false,
        status: "pending",
      }),
    ).toBe(false);
  });

  test("does not select a PRD task that is no longer pending", () => {
    expect(
      matchesQuery(buildPrdTaskQuery(), {
        kind: "prd",
        autonomousPlanSession: true,
        status: "in_progress",
      }),
    ).toBe(false);
  });
});
