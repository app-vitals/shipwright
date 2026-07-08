/**
 * agent/src/work-selector.unit.test.ts
 *
 * Unit tests for the selectNextWorkItem() pure helper.
 * No I/O — pure logic only.
 */

import { describe, expect, it } from "bun:test";
import {
  selectNextWorkItem,
  type WorkPrCandidate,
  type WorkTaskCandidate,
} from "./work-selector.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<WorkTaskCandidate> = {}): WorkTaskCandidate {
  return {
    id: "task-1",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    branch: null,
    dependencies: [],
    ...overrides,
  };
}

function makePr(overrides: Partial<WorkPrCandidate> = {}): WorkPrCandidate {
  return {
    id: "pr-1",
    age: "2026-01-01T00:00:00.000Z",
    claimedBy: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("selectNextWorkItem", () => {
  it("returns null when both lists are empty", () => {
    expect(selectNextWorkItem([], [])).toBeNull();
  });

  it("returns the oldest task when only tasks are ready", () => {
    const older = makeTask({ id: "t-older", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = makeTask({ id: "t-newer", createdAt: "2026-01-02T00:00:00.000Z" });
    const result = selectNextWorkItem([newer, older], []);
    expect(result).toEqual({ type: "task", task: older });
  });

  it("returns the oldest PR when only PRs are ready", () => {
    const older = makePr({ id: "pr-older", age: "2026-01-01T00:00:00.000Z" });
    const newer = makePr({ id: "pr-newer", age: "2026-01-02T00:00:00.000Z" });
    const result = selectNextWorkItem([], [newer, older]);
    expect(result).toEqual({ type: "pr", pr: older });
  });

  it("picks the oldest item across both entity types — strict FIFO, no phase bias", () => {
    const task = makeTask({ id: "t1", createdAt: "2026-01-02T00:00:00.000Z" });
    const olderPr = makePr({ id: "pr1", age: "2026-01-01T00:00:00.000Z" });
    const result = selectNextWorkItem([task], [olderPr]);
    expect(result).toEqual({ type: "pr", pr: olderPr });
  });

  it("picks the older task over a newer PR", () => {
    const olderTask = makeTask({ id: "t1", createdAt: "2026-01-01T00:00:00.000Z" });
    const newerPr = makePr({ id: "pr1", age: "2026-01-02T00:00:00.000Z" });
    const result = selectNextWorkItem([olderTask], [newerPr]);
    expect(result).toEqual({ type: "task", task: olderTask });
  });

  it("excludes a task blocked by an unsatisfied dependency", () => {
    const dep = makeTask({ id: "dep-1", status: "in_progress" });
    const blocked = makeTask({
      id: "t-blocked",
      createdAt: "2026-01-01T00:00:00.000Z",
      dependencies: ["dep-1"],
    });
    const unblocked = makeTask({
      id: "t-unblocked",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const result = selectNextWorkItem([dep, blocked, unblocked], []);
    expect(result).toEqual({ type: "task", task: unblocked });
  });

  it("treats a task with a dependency in a terminal status as unblocked", () => {
    const dep = makeTask({ id: "dep-1", status: "merged" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = selectNextWorkItem([dep, task], []);
    expect(result).toEqual({ type: "task", task });
  });

  it("treats a same-branch pr_open/approved dependency as unblocked (bundled)", () => {
    const dep = makeTask({ id: "dep-1", status: "pr_open", branch: "feat/shared" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"], branch: "feat/shared" });
    const result = selectNextWorkItem([dep, task], []);
    expect(result).toEqual({ type: "task", task });
  });

  it("treats a cross-branch pr_open dependency as still blocked", () => {
    const dep = makeTask({ id: "dep-1", status: "pr_open", branch: "feat/other" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"], branch: "feat/main" });
    const result = selectNextWorkItem([dep, task], []);
    expect(result).toBeNull();
  });

  it("excludes a task whose dependency is missing from the candidate list", () => {
    const task = makeTask({ id: "t1", dependencies: ["missing-dep"] });
    const result = selectNextWorkItem([task], []);
    expect(result).toBeNull();
  });

  it("excludes an already-claimed PR", () => {
    const claimed = makePr({
      id: "pr-claimed",
      age: "2026-01-01T00:00:00.000Z",
      claimedBy: "agent-x",
    });
    const unclaimed = makePr({
      id: "pr-unclaimed",
      age: "2026-01-02T00:00:00.000Z",
      claimedBy: null,
    });
    const result = selectNextWorkItem([], [claimed, unclaimed]);
    expect(result).toEqual({ type: "pr", pr: unclaimed });
  });

  it("returns null when every candidate is blocked or claimed", () => {
    const dep = makeTask({ id: "dep-1", status: "in_progress" });
    const blockedTask = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const claimedPr = makePr({ id: "pr1", claimedBy: "agent-x" });
    const result = selectNextWorkItem([dep, blockedTask], [claimedPr]);
    expect(result).toBeNull();
  });

  it("selects strictly by age across a larger mixed fixture set", () => {
    const t1 = makeTask({ id: "t1", createdAt: "2026-03-01T00:00:00.000Z" });
    const t2 = makeTask({ id: "t2", createdAt: "2026-01-15T00:00:00.000Z" });
    const pr1 = makePr({ id: "pr1", age: "2026-02-01T00:00:00.000Z" });
    const pr2 = makePr({ id: "pr2", age: "2026-01-10T00:00:00.000Z", claimedBy: "agent-y" });
    const result = selectNextWorkItem([t1, t2], [pr1, pr2]);
    expect(result).toEqual({ type: "task", task: t2 });
  });
});
