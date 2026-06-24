/**
 * task-store/src/blocked-by.unit.test.ts
 *
 * Unit tests for the computeBlockedBy() pure helper.
 * No I/O — pure logic only.
 */

import { describe, expect, it } from "bun:test";
import { computeBlockedBy } from "./blocked-by.ts";
import type { ReadyTaskLike } from "./ready.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ReadyTaskLike> = {}): ReadyTaskLike {
  return {
    id: "task-1",
    status: "pending",
    branch: null,
    dependencies: [],
    pr: null,
    hitl: null,
    hitlNotifiedAt: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeBlockedBy", () => {
  it("returns empty array when task has no HITL and no dependencies", () => {
    const task = makeTask({ id: "t1" });
    const result = computeBlockedBy(task, [task]);
    expect(result).toEqual([]);
  });

  it("returns empty array when HITL is false and no dependencies", () => {
    const task = makeTask({ id: "t1", hitl: false });
    const result = computeBlockedBy(task, [task]);
    expect(result).toEqual([]);
  });

  it("includes hitl block when hitl=true and hitlNotifiedAt is null", () => {
    const task = makeTask({ id: "t1", hitl: true, hitlNotifiedAt: null });
    const result = computeBlockedBy(task, [task]);
    expect(result).toEqual([{ type: "hitl" }]);
  });

  it("includes { type: 'hitl', notified: true } when hitl=true and hitlNotifiedAt is set", () => {
    const task = makeTask({
      id: "t1",
      hitl: true,
      hitlNotifiedAt: "2026-06-24T10:00:00.000Z",
    });
    const result = computeBlockedBy(task, [task]);
    expect(result).toEqual([{ type: "hitl", notified: true }]);
  });

  it("includes dep block for dependency in non-terminal status (pending)", () => {
    const dep = makeTask({ id: "dep-1", status: "pending" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([
      { type: "dependency", id: "dep-1", status: "pending" },
    ]);
  });

  it("includes dep block for dependency in non-terminal status (in_progress)", () => {
    const dep = makeTask({ id: "dep-1", status: "in_progress" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([
      { type: "dependency", id: "dep-1", status: "in_progress" },
    ]);
  });

  it("returns empty array when dependency is in terminal status (merged)", () => {
    const dep = makeTask({ id: "dep-1", status: "merged" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([]);
  });

  it("returns empty array when dependency is in terminal status (done)", () => {
    const dep = makeTask({ id: "dep-1", status: "done" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([]);
  });

  it("returns empty array when dependency is in terminal status (deploying)", () => {
    const dep = makeTask({ id: "dep-1", status: "deploying" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([]);
  });

  it("returns empty array when dependency is in terminal status (deployed)", () => {
    const dep = makeTask({ id: "dep-1", status: "deployed" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([]);
  });

  it("returns empty array when dependency is in terminal status (cancelled)", () => {
    const dep = makeTask({ id: "dep-1", status: "cancelled" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([]);
  });

  it("returns empty array when same-branch dep has pr_open status (bundled)", () => {
    const dep = makeTask({
      id: "dep-1",
      status: "pr_open",
      branch: "feat/shared",
    });
    const task = makeTask({
      id: "t1",
      dependencies: ["dep-1"],
      branch: "feat/shared",
    });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([]);
  });

  it("returns empty array when same-branch dep has approved status (bundled)", () => {
    const dep = makeTask({
      id: "dep-1",
      status: "approved",
      branch: "feat/shared",
    });
    const task = makeTask({
      id: "t1",
      dependencies: ["dep-1"],
      branch: "feat/shared",
    });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([]);
  });

  it("includes dep block when cross-branch dep has pr_open status (not satisfied)", () => {
    const dep = makeTask({
      id: "dep-1",
      status: "pr_open",
      branch: "feat/other",
      pr: 42,
    });
    const task = makeTask({
      id: "t1",
      dependencies: ["dep-1"],
      branch: "feat/main",
    });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([
      { type: "dependency", id: "dep-1", status: "pr_open" },
    ]);
  });

  it("includes dep block for dep with approved status on different branch", () => {
    const dep = makeTask({
      id: "dep-1",
      status: "approved",
      branch: "feat/other",
    });
    const task = makeTask({
      id: "t1",
      dependencies: ["dep-1"],
      branch: "feat/main",
    });
    const result = computeBlockedBy(task, [task, dep]);
    expect(result).toEqual([
      { type: "dependency", id: "dep-1", status: "approved" },
    ]);
  });

  it("includes dep block when dep is missing from allTasks", () => {
    const task = makeTask({ id: "t1", dependencies: ["missing-dep"] });
    const result = computeBlockedBy(task, [task]);
    expect(result).toEqual([
      { type: "dependency", id: "missing-dep", status: "unknown" },
    ]);
  });

  it("accumulates multiple blocks: hitl + multiple unsatisfied deps", () => {
    const dep1 = makeTask({ id: "dep-1", status: "in_progress" });
    const dep2 = makeTask({ id: "dep-2", status: "pending" });
    const task = makeTask({
      id: "t1",
      hitl: true,
      hitlNotifiedAt: null,
      dependencies: ["dep-1", "dep-2"],
    });
    const result = computeBlockedBy(task, [task, dep1, dep2]);
    expect(result).toEqual([
      { type: "hitl" },
      { type: "dependency", id: "dep-1", status: "in_progress" },
      { type: "dependency", id: "dep-2", status: "pending" },
    ]);
  });

  it("handles mixed deps: one satisfied, one not", () => {
    const satisfied = makeTask({ id: "dep-done", status: "done" });
    const blocking = makeTask({ id: "dep-pending", status: "pending" });
    const task = makeTask({
      id: "t1",
      dependencies: ["dep-done", "dep-pending"],
    });
    const result = computeBlockedBy(task, [task, satisfied, blocking]);
    expect(result).toEqual([
      { type: "dependency", id: "dep-pending", status: "pending" },
    ]);
  });
});
