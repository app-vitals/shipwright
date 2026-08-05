/**
 * task-store/src/ready.unit.test.ts
 *
 * Direct unit tests for the resolveReadyTasks() dependency-satisfaction logic.
 * No I/O — pure logic only. isPrMerged is injected as a plain async function
 * (dependency injection, not a global/module mock).
 */

import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import { describe, expect, it } from "bun:test";
import { type ReadyTaskLike, resolveReadyTasks } from "./ready.ts";

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
    claimedAt: null,
    heartbeatAt: null,
    ...overrides,
  };
}

const FIXED_NOW = new Date("2026-08-05T00:00:00.000Z");
const fixedNow = () => FIXED_NOW;

/** isPrMerged stub that always throws — use when the test asserts it must
 * never be called (e.g. dep.pr is null so the check should short-circuit). */
const isPrMergedShouldNotBeCalled = async (): Promise<boolean> => {
  throw new Error("isPrMerged should not have been called");
};

const isPrMergedAlwaysFalse = async (): Promise<boolean> => false;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("resolveReadyTasks", () => {
  it("excludes a task whose status is not pending", async () => {
    const task = makeTask({ id: "t1", status: "in_progress" });
    const result = await resolveReadyTasks([task], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([]);
  });

  it("excludes a task with hitl === true even if otherwise ready", async () => {
    const task = makeTask({ id: "t1", hitl: true });
    const result = await resolveReadyTasks([task], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([]);
  });

  it("includes a pending task with no dependencies", async () => {
    const task = makeTask({ id: "t1" });
    const result = await resolveReadyTasks([task], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([task]);
  });

  it("excludes a task when a dependency ID does not resolve to a known task", async () => {
    const task = makeTask({ id: "t1", dependencies: ["missing-dep"] });
    const result = await resolveReadyTasks([task], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([]);
  });

  it("includes a task when dependency status is merged (terminal)", async () => {
    const dep = makeTask({ id: "dep-1", status: "merged" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([task]);
  });

  it("includes a task when dependency status is done (terminal)", async () => {
    const dep = makeTask({ id: "dep-1", status: "done" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([task]);
  });

  it("includes a task when dependency status is deploying (terminal)", async () => {
    const dep = makeTask({ id: "dep-1", status: "deploying" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([task]);
  });

  it("includes a task when dependency status is deployed (terminal)", async () => {
    const dep = makeTask({ id: "dep-1", status: "deployed" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([task]);
  });

  it("includes a task when dependency status is cancelled (terminal)", async () => {
    const dep = makeTask({ id: "dep-1", status: "cancelled" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([task]);
  });

  it("includes a task when same-branch dependency has pr_open status (bundled)", async () => {
    const dep = makeTask({ id: "dep-1", status: "pr_open", branch: "feat/shared" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"], branch: "feat/shared" });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([task]);
  });

  it("includes a task when same-branch dependency has approved status (bundled)", async () => {
    const dep = makeTask({ id: "dep-1", status: "approved", branch: "feat/shared" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"], branch: "feat/shared" });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([task]);
  });

  it("excludes a task when same-branch dependency has a non-satisfying status (pending)", async () => {
    // dep-1 is itself "pending" with no deps of its own, so it resolves as
    // ready independently — assert on t1's exclusion specifically, not on
    // the full result set being empty.
    const dep = makeTask({ id: "dep-1", status: "pending", branch: "feat/shared" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"], branch: "feat/shared" });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result.map((t) => t.id)).not.toContain("t1");
  });

  it("includes a task when cross-branch pr_open dependency's PR is merged", async () => {
    const dep = makeTask({ id: "dep-1", status: "pr_open", branch: "feat/other", pr: 42 });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"], branch: "feat/main" });
    const isPrMerged = async (prNumber: number) => {
      expect(prNumber).toBe(42);
      return true;
    };
    const result = await resolveReadyTasks([task, dep], isPrMerged);
    expect(result).toEqual([task]);
  });

  it("excludes a task when cross-branch pr_open dependency's PR is not merged", async () => {
    const dep = makeTask({ id: "dep-1", status: "pr_open", branch: "feat/other", pr: 42 });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"], branch: "feat/main" });
    const result = await resolveReadyTasks([task, dep], isPrMergedAlwaysFalse);
    expect(result).toEqual([]);
  });

  it("excludes a task when pr_open dependency has no pr set, without calling isPrMerged", async () => {
    const dep = makeTask({ id: "dep-1", status: "pr_open", branch: "feat/other", pr: null });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"], branch: "feat/main" });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([]);
  });

  it("excludes a task when dependency has an arbitrary non-satisfying status", async () => {
    const dep = makeTask({ id: "dep-1", status: "blocked" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1"] });
    const result = await resolveReadyTasks([task, dep], isPrMergedShouldNotBeCalled);
    expect(result).toEqual([]);
  });

  it("returns only the ready tasks from a mixed input array, preserving original order", async () => {
    const readyTask1 = makeTask({ id: "ready-1" });
    const notPending = makeTask({ id: "not-pending", status: "in_progress" });
    const hitlBlocked = makeTask({ id: "hitl-blocked", hitl: true });
    const readyTask2 = makeTask({ id: "ready-2" });
    const unsatisfiedDep = makeTask({
      id: "unsatisfied",
      dependencies: ["missing"],
    });

    const tasks = [readyTask1, notPending, hitlBlocked, readyTask2, unsatisfiedDep];
    const result = await resolveReadyTasks(tasks, isPrMergedShouldNotBeCalled);

    expect(result).toEqual([readyTask1, readyTask2]);
  });

  it("excludes a task when it has multiple dependencies and only one is unsatisfied", async () => {
    // dep-pending is itself "pending" with no deps of its own, so it resolves
    // as ready independently — assert on t1's exclusion specifically, not on
    // the full result set being empty.
    const satisfiedDep = makeTask({ id: "dep-done", status: "done" });
    const unsatisfiedDep = makeTask({ id: "dep-pending", status: "pending" });
    const task = makeTask({
      id: "t1",
      dependencies: ["dep-done", "dep-pending"],
    });
    const result = await resolveReadyTasks(
      [task, satisfiedDep, unsatisfiedDep],
      isPrMergedShouldNotBeCalled,
    );
    expect(result.map((t) => t.id)).not.toContain("t1");
  });

  it("includes a task when it has multiple dependencies and all are satisfied", async () => {
    const dep1 = makeTask({ id: "dep-1", status: "done" });
    const dep2 = makeTask({ id: "dep-2", status: "merged" });
    const task = makeTask({ id: "t1", dependencies: ["dep-1", "dep-2"] });
    const result = await resolveReadyTasks(
      [task, dep1, dep2],
      isPrMergedShouldNotBeCalled,
    );
    expect(result).toEqual([task]);
  });

  describe("same-branch exclusivity", () => {
    it("excludes a pending task when a fresh in_progress sibling shares its branch (heartbeatAt)", async () => {
      const sibling = makeTask({
        id: "sibling",
        status: "in_progress",
        branch: "feat/shared",
        heartbeatAt: new Date(FIXED_NOW.getTime() - 1_000).toISOString(),
      });
      const task = makeTask({ id: "t1", branch: "feat/shared" });
      const result = await resolveReadyTasks(
        [task, sibling],
        isPrMergedShouldNotBeCalled,
        fixedNow,
      );
      expect(result).toEqual([]);
    });

    it("excludes a pending task when a fresh in_progress sibling shares its branch (claimedAt, no heartbeatAt)", async () => {
      const sibling = makeTask({
        id: "sibling",
        status: "in_progress",
        branch: "feat/shared",
        claimedAt: new Date(FIXED_NOW.getTime() - 1_000).toISOString(),
        heartbeatAt: null,
      });
      const task = makeTask({ id: "t1", branch: "feat/shared" });
      const result = await resolveReadyTasks(
        [task, sibling],
        isPrMergedShouldNotBeCalled,
        fixedNow,
      );
      expect(result).toEqual([]);
    });

    it("does not exclude a pending task when the in_progress sibling's claim is stale (older than DEFAULT_CLAIM_TTL_MS)", async () => {
      const sibling = makeTask({
        id: "sibling",
        status: "in_progress",
        branch: "feat/shared",
        heartbeatAt: new Date(
          FIXED_NOW.getTime() - DEFAULT_CLAIM_TTL_MS - 1_000,
        ).toISOString(),
      });
      const task = makeTask({ id: "t1", branch: "feat/shared" });
      const result = await resolveReadyTasks(
        [task, sibling],
        isPrMergedShouldNotBeCalled,
        fixedNow,
      );
      expect(result).toEqual([task]);
    });

    it("does not exclude a pending task when the in_progress sibling is on a different branch", async () => {
      const sibling = makeTask({
        id: "sibling",
        status: "in_progress",
        branch: "feat/other",
        heartbeatAt: new Date(FIXED_NOW.getTime() - 1_000).toISOString(),
      });
      const task = makeTask({ id: "t1", branch: "feat/shared" });
      const result = await resolveReadyTasks(
        [task, sibling],
        isPrMergedShouldNotBeCalled,
        fixedNow,
      );
      expect(result).toEqual([task]);
    });

    it("does not exclude a pending task with no branch set", async () => {
      const sibling = makeTask({
        id: "sibling",
        status: "in_progress",
        branch: null,
        heartbeatAt: new Date(FIXED_NOW.getTime() - 1_000).toISOString(),
      });
      const task = makeTask({ id: "t1", branch: null });
      const result = await resolveReadyTasks(
        [task, sibling],
        isPrMergedShouldNotBeCalled,
        fixedNow,
      );
      expect(result).toEqual([task]);
    });

    it("does not exclude a task from being blocked by itself when it happens to be in_progress-like in the list (self is skipped as a sibling)", async () => {
      // Only the task itself is present with a shared branch — since a task
      // can never be its own sibling, and this record is 'pending' (not
      // in_progress) anyway, it must be included.
      const task = makeTask({ id: "t1", branch: "feat/solo" });
      const result = await resolveReadyTasks(
        [task],
        isPrMergedShouldNotBeCalled,
        fixedNow,
      );
      expect(result).toEqual([task]);
    });

    it("uses the default now() when no now function is injected (production default, real time)", async () => {
      // No in_progress siblings at all — this exercises the default
      // `now: () => new Date()` parameter path without needing determinism.
      const task = makeTask({ id: "t1", branch: "feat/shared" });
      const result = await resolveReadyTasks([task], isPrMergedShouldNotBeCalled);
      expect(result).toEqual([task]);
    });
  });
});
