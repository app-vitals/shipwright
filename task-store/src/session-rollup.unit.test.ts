/**
 * task-store/src/session-rollup.unit.test.ts
 *
 * Unit tests for the computeSessionRollup() pure helper.
 * No I/O — pure logic only. Time is injected via FixedClock.
 */

import { describe, expect, it } from "bun:test";
import { FixedClock } from "./clock.ts";
import {
  type SessionRollupTaskLike,
  computeSessionRollup,
} from "./session-rollup.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTask(
  overrides: Partial<SessionRollupTaskLike> = {},
): SessionRollupTaskLike {
  return {
    id: "task-1",
    status: "pending",
    branch: null,
    dependencies: [],
    pr: null,
    hitl: null,
    blockedReason: null,
    repo: "app-vitals/shipwright",
    assignee: null,
    claimedBy: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const clock = FixedClock(new Date("2026-09-11T00:00:00.000Z"));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("computeSessionRollup", () => {
  it("returns state 'waiting' with a hitl waitingTasks entry when hitl=true and dependencies are satisfied", () => {
    const dep = makeTask({ id: "dep-1", status: "done" });
    const task = makeTask({
      id: "t1",
      hitl: true,
      dependencies: ["dep-1"],
      updatedAt: "2026-09-05T00:00:00.000Z",
    });
    const result = computeSessionRollup([task, dep], new Set(), clock);
    expect(result.state).toBe("waiting");
    expect(result.waitingTasks).toEqual([{ id: "t1", kind: "hitl" }]);
  });

  it("returns state 'active' (no waitingTasks) when hitl=true but has an unmet dependency", () => {
    const dep = makeTask({ id: "dep-1", status: "pending" });
    const task = makeTask({ id: "t1", hitl: true, dependencies: ["dep-1"] });
    const result = computeSessionRollup([task, dep], new Set(), clock);
    expect(result.state).toBe("active");
    expect(result.waitingTasks).toEqual([]);
  });

  it("returns state 'waiting' with a pr_blocked waitingTasks entry when task.pr is in prBlockedSet", () => {
    const task = makeTask({ id: "t1", pr: 42 });
    const result = computeSessionRollup([task], new Set([42]), clock);
    expect(result.state).toBe("waiting");
    expect(result.waitingTasks).toEqual([{ id: "t1", kind: "pr_blocked" }]);
  });

  it("does not report pr_blocked when task.pr is set but not present in prBlockedSet", () => {
    const task = makeTask({ id: "t1", pr: 42, status: "in_progress" });
    const result = computeSessionRollup([task], new Set([99]), clock);
    expect(result.state).toBe("active");
    expect(result.waitingTasks).toEqual([]);
  });

  it("reports archived: true via the optional session param, alongside computed state", () => {
    const task = makeTask({ id: "t1", status: "in_progress" });
    const result = computeSessionRollup([task], new Set(), clock, {
      archivedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(result.archived).toBe(true);
    expect(result.state).toBe("active");
  });

  it("reports archived: false when no session param is passed", () => {
    const task = makeTask({ id: "t1" });
    const result = computeSessionRollup([task], new Set(), clock);
    expect(result.archived).toBe(false);
  });

  it("reports archived: false when session param has a null archivedAt", () => {
    const task = makeTask({ id: "t1" });
    const result = computeSessionRollup([task], new Set(), clock, {
      archivedAt: null,
    });
    expect(result.archived).toBe(false);
  });

  it("returns state 'empty' with zeroed counts and null timestamps for an empty task list", () => {
    const result = computeSessionRollup([], new Set(), clock);
    expect(result.state).toBe("empty");
    expect(result.counts).toEqual({ total: 0, open: 0, closed: 0 });
    expect(result.lastActivityAt).toBeNull();
    expect(result.waitingSince).toBeNull();
    expect(result.agentIds).toEqual([]);
    expect(result.repos).toEqual([]);
    expect(result.waitingTasks).toEqual([]);
    expect(result.archived).toBe(false);
  });

  it("combines an empty task list with archived: true", () => {
    const result = computeSessionRollup([], new Set(), clock, {
      archivedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(result.state).toBe("empty");
    expect(result.archived).toBe(true);
  });

  it("returns state 'closed' when every task has a terminal status", () => {
    const t1 = makeTask({ id: "t1", status: "merged" });
    const t2 = makeTask({ id: "t2", status: "done" });
    const result = computeSessionRollup([t1, t2], new Set(), clock);
    expect(result.state).toBe("closed");
    expect(result.waitingTasks).toEqual([]);
  });

  it("returns state 'waiting' with a blocked waitingTasks entry when status='blocked'", () => {
    const task = makeTask({
      id: "t1",
      status: "blocked",
      blockedReason: "waiting on infra",
    });
    const result = computeSessionRollup([task], new Set(), clock);
    expect(result.state).toBe("waiting");
    expect(result.waitingTasks).toEqual([{ id: "t1", kind: "blocked" }]);
  });

  it("returns state 'active' for a mix of open non-waiting tasks", () => {
    const t1 = makeTask({ id: "t1", status: "in_progress" });
    const t2 = makeTask({ id: "t2", status: "pr_open" });
    const result = computeSessionRollup([t1, t2], new Set(), clock);
    expect(result.state).toBe("active");
    expect(result.waitingTasks).toEqual([]);
  });

  describe("counts", () => {
    it("computes total/open/closed counts across the task list", () => {
      const t1 = makeTask({ id: "t1", status: "in_progress" });
      const t2 = makeTask({ id: "t2", status: "merged" });
      const t3 = makeTask({ id: "t3", status: "done" });
      const result = computeSessionRollup([t1, t2, t3], new Set(), clock);
      expect(result.counts).toEqual({ total: 3, open: 1, closed: 2 });
    });
  });

  describe("agentIds and repos", () => {
    it("collects distinct non-null agent identifiers, preferring claimedBy over assignee", () => {
      const t1 = makeTask({
        id: "t1",
        claimedBy: "agent-a",
        assignee: "agent-x",
      });
      const t2 = makeTask({ id: "t2", claimedBy: null, assignee: "agent-b" });
      const t3 = makeTask({ id: "t3", claimedBy: "agent-a", assignee: null });
      const t4 = makeTask({ id: "t4", claimedBy: null, assignee: null });
      const result = computeSessionRollup([t1, t2, t3, t4], new Set(), clock);
      expect(result.agentIds.slice().sort()).toEqual(["agent-a", "agent-b"]);
    });

    it("collects distinct non-null repos", () => {
      const t1 = makeTask({ id: "t1", repo: "org/repo-a" });
      const t2 = makeTask({ id: "t2", repo: "org/repo-b" });
      const t3 = makeTask({ id: "t3", repo: "org/repo-a" });
      const t4 = makeTask({ id: "t4", repo: null });
      const result = computeSessionRollup([t1, t2, t3, t4], new Set(), clock);
      expect(result.repos.slice().sort()).toEqual(["org/repo-a", "org/repo-b"]);
    });
  });

  describe("lastActivityAt", () => {
    it("is the max updatedAt across all tasks regardless of state", () => {
      const t1 = makeTask({
        id: "t1",
        status: "merged",
        updatedAt: "2026-09-01T00:00:00.000Z",
      });
      const t2 = makeTask({
        id: "t2",
        status: "done",
        updatedAt: "2026-09-05T00:00:00.000Z",
      });
      const result = computeSessionRollup([t1, t2], new Set(), clock);
      expect(result.lastActivityAt).toBe("2026-09-05T00:00:00.000Z");
    });
  });

  describe("waitingSince", () => {
    it("is the earliest updatedAt among currently-waiting tasks", () => {
      const t1 = makeTask({
        id: "t1",
        status: "blocked",
        updatedAt: "2026-09-05T00:00:00.000Z",
      });
      const t2 = makeTask({
        id: "t2",
        status: "blocked",
        updatedAt: "2026-09-02T00:00:00.000Z",
      });
      const t3 = makeTask({
        id: "t3",
        status: "in_progress",
        updatedAt: "2026-09-09T00:00:00.000Z",
      });
      const result = computeSessionRollup([t1, t2, t3], new Set(), clock);
      expect(result.state).toBe("waiting");
      expect(result.waitingSince).toBe("2026-09-02T00:00:00.000Z");
    });

    it("is null when state is not 'waiting'", () => {
      const t1 = makeTask({ id: "t1", status: "in_progress" });
      const result = computeSessionRollup([t1], new Set(), clock);
      expect(result.waitingSince).toBeNull();
    });
  });

  describe("waiting kind precedence", () => {
    it("reports 'blocked' rather than 'hitl' when a task is both status='blocked' and hitl=true with satisfied deps", () => {
      const task = makeTask({
        id: "t1",
        status: "blocked",
        hitl: true,
        blockedReason: "manual gate",
      });
      const result = computeSessionRollup([task], new Set(), clock);
      expect(result.waitingTasks).toEqual([{ id: "t1", kind: "blocked" }]);
    });

    it("reports 'blocked' rather than 'pr_blocked' when both apply", () => {
      const task = makeTask({ id: "t1", status: "blocked", pr: 7 });
      const result = computeSessionRollup([task], new Set([7]), clock);
      expect(result.waitingTasks).toEqual([{ id: "t1", kind: "blocked" }]);
    });

    it("reports 'pr_blocked' rather than 'hitl' when both apply and dependencies are satisfied", () => {
      const task = makeTask({ id: "t1", hitl: true, pr: 7 });
      const result = computeSessionRollup([task], new Set([7]), clock);
      expect(result.waitingTasks).toEqual([{ id: "t1", kind: "pr_blocked" }]);
    });
  });

  describe("dependency-only waits", () => {
    it("does not count a task whose only blocked-by reason is an unsatisfied dependency", () => {
      const dep = makeTask({ id: "dep-1", status: "pending" });
      const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
      const result = computeSessionRollup([task, dep], new Set(), clock);
      expect(result.waitingTasks.map((w) => w.id)).not.toContain("t1");
      expect(result.state).toBe("active");
    });
  });
});
