/**
 * task-store/src/task-transition-diff.unit.test.ts
 *
 * Unit tests for the pure diff-computation behind the Task audit trail
 * (TCS-1.1). No I/O — hand-built Task states, table-driven cases. Mirrors
 * pr-transition-diff.unit.test.ts's structure.
 */

import { describe, expect, test } from "bun:test";
import type { Task } from "./index.ts";
import { computeTaskTransitionDiff } from "./task-transition-diff.ts";

/** Build a minimal Task-shaped object; overrides fill in the fields under test. */
function task(overrides: Partial<Task> = {}): Task {
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
    skipCount: 0,
    lastSkippedAt: null,
    claimedBy: null,
    agentHint: null,
    claimedAt: null,
    heartbeatAt: null,
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
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Task;
}

describe("computeTaskTransitionDiff()", () => {
  test("null before (create path) → no events", () => {
    expect(
      computeTaskTransitionDiff(null, task({ claimedBy: "agent-a" })),
    ).toEqual([]);
  });

  test("identical states → no events", () => {
    const before = task({ claimedBy: "agent-a", status: "in_progress" });
    const after = task({ claimedBy: "agent-a", status: "in_progress" });
    expect(computeTaskTransitionDiff(before, after)).toEqual([]);
  });

  test("heartbeatAt-only change → no events", () => {
    const before = task({ heartbeatAt: "2026-01-01T00:00:00.000Z" });
    const after = task({ heartbeatAt: "2026-01-02T00:00:00.000Z" });
    expect(computeTaskTransitionDiff(before, after)).toEqual([]);
  });

  test("multiple real field changes → one entry each", () => {
    const before = task({
      status: "pending",
      claimedBy: null,
      startedAt: null,
    });
    const after = task({
      status: "in_progress",
      claimedBy: "agent-a",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    const changes = computeTaskTransitionDiff(before, after);
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));

    expect(changes).toHaveLength(3);
    expect(byField.status).toEqual({
      field: "status",
      oldValue: "pending",
      newValue: "in_progress",
    });
    expect(byField.claimedBy).toEqual({
      field: "claimedBy",
      oldValue: null,
      newValue: "agent-a",
    });
    expect(byField.startedAt).toEqual({
      field: "startedAt",
      oldValue: null,
      newValue: "2026-01-01T00:00:00.000Z",
    });
  });

  test("real field change + incidental heartbeatAt change → only the real field's entry", () => {
    const before = task({
      status: "pending",
      heartbeatAt: "2026-01-01T00:00:00.000Z",
    });
    const after = task({
      status: "in_progress",
      heartbeatAt: "2026-01-02T00:00:00.000Z",
    });

    const changes = computeTaskTransitionDiff(before, after);
    expect(changes).toEqual([
      { field: "status", oldValue: "pending", newValue: "in_progress" },
    ]);
  });

  test("null → value transition records oldValue null", () => {
    const changes = computeTaskTransitionDiff(
      task({ blockedReason: null }),
      task({ blockedReason: "auto-blocked after 3 skips" }),
    );
    expect(changes).toEqual([
      {
        field: "blockedReason",
        oldValue: null,
        newValue: "auto-blocked after 3 skips",
      },
    ]);
  });

  test("value → null transition records newValue null", () => {
    const changes = computeTaskTransitionDiff(
      task({ claimedBy: "agent-a" }),
      task({ claimedBy: null }),
    );
    expect(changes).toEqual([
      { field: "claimedBy", oldValue: "agent-a", newValue: null },
    ]);
  });

  test("numeric and boolean fields are stringified", () => {
    const changes = computeTaskTransitionDiff(
      task({ skipCount: 0, hitl: false }),
      task({ skipCount: 1, hitl: true }),
    );
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));
    expect(byField.skipCount).toEqual({
      field: "skipCount",
      oldValue: "0",
      newValue: "1",
    });
    expect(byField.hitl).toEqual({
      field: "hitl",
      oldValue: "false",
      newValue: "true",
    });
  });

  test("system columns (createdAt/updatedAt/id) are never diffed", () => {
    const before = task();
    const after = task({
      id: "task-2",
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      updatedAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(computeTaskTransitionDiff(before, after)).toEqual([]);
  });

  test("array/relation fields (acceptanceCriteria/dependencies) are never diffed", () => {
    const before = task({ acceptanceCriteria: [], dependencies: [] });
    const after = task({
      acceptanceCriteria: ["a criterion"],
      dependencies: ["task-0"],
    });
    expect(computeTaskTransitionDiff(before, after)).toEqual([]);
  });

  test("execution-metrics fields (e.g. costUsd, simplifyTotal) are audited", () => {
    const before = task({ costUsd: null, simplifyTotal: null });
    const after = task({ costUsd: 1.23, simplifyTotal: 5 });

    const changes = computeTaskTransitionDiff(before, after);
    const byField = Object.fromEntries(changes.map((c) => [c.field, c]));

    expect(changes).toHaveLength(2);
    expect(byField.costUsd).toEqual({
      field: "costUsd",
      oldValue: null,
      newValue: "1.23",
    });
    expect(byField.simplifyTotal).toEqual({
      field: "simplifyTotal",
      oldValue: null,
      newValue: "5",
    });
  });
});
