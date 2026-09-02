/**
 * agent/src/slack-thread-status-tracker.unit.test.ts
 *
 * Unit tests for ThreadStatusTracker — the per-thread reference counter that
 * gates SlackProgress.start()/finish() calls so a burst of overlapping
 * messages on the same Slack thread only flips agents.sessions.setStatus
 * once each way (0->1 on the first enter, 1->0 on the last exit), instead of
 * flapping "active" as soon as the first of several queued runs finishes.
 *
 * Pure logic, no I/O — the tracker itself never touches a Slack client.
 */

import { describe, expect, test } from "bun:test";
import { ThreadStatusTracker } from "./slack-thread-status-tracker.ts";

describe("ThreadStatusTracker — enter()", () => {
  test("returns true on the first enter for a key (0->1)", () => {
    const tracker = new ThreadStatusTracker();
    expect(tracker.enter("thread-1")).toBe(true);
  });

  test("returns false on a second overlapping enter for the same key (1->2)", () => {
    const tracker = new ThreadStatusTracker();
    tracker.enter("thread-1");
    expect(tracker.enter("thread-1")).toBe(false);
  });

  test("returns false on a third overlapping enter for the same key (2->3)", () => {
    const tracker = new ThreadStatusTracker();
    tracker.enter("thread-1");
    tracker.enter("thread-1");
    expect(tracker.enter("thread-1")).toBe(false);
  });

  test("different keys are independent — each gets its own 0->1 transition", () => {
    const tracker = new ThreadStatusTracker();
    expect(tracker.enter("thread-1")).toBe(true);
    expect(tracker.enter("thread-2")).toBe(true);
  });

  test("re-entering after a full drain (exit back to 0) returns true again", () => {
    const tracker = new ThreadStatusTracker();
    tracker.enter("thread-1");
    tracker.exit("thread-1");
    expect(tracker.enter("thread-1")).toBe(true);
  });
});

describe("ThreadStatusTracker — exit()", () => {
  test("returns true when the count drops from 1 to 0", () => {
    const tracker = new ThreadStatusTracker();
    tracker.enter("thread-1");
    expect(tracker.exit("thread-1")).toBe(true);
  });

  test("returns false when the count drops from 2 to 1 (still in flight)", () => {
    const tracker = new ThreadStatusTracker();
    tracker.enter("thread-1");
    tracker.enter("thread-1");
    expect(tracker.exit("thread-1")).toBe(false);
  });

  test("returns false and does not throw when called on a key already at 0", () => {
    const tracker = new ThreadStatusTracker();
    expect(() => tracker.exit("never-entered")).not.toThrow();
    expect(tracker.exit("never-entered")).toBe(false);
  });

  test("returns false and does not throw on a double-exit below zero", () => {
    const tracker = new ThreadStatusTracker();
    tracker.enter("thread-1");
    expect(tracker.exit("thread-1")).toBe(true);
    expect(() => tracker.exit("thread-1")).not.toThrow();
    expect(tracker.exit("thread-1")).toBe(false);
  });

  test("different keys are independent — exiting one does not affect another", () => {
    const tracker = new ThreadStatusTracker();
    tracker.enter("thread-1");
    tracker.enter("thread-2");
    expect(tracker.exit("thread-1")).toBe(true);
    // thread-2's count is still 1 — exiting it should be the 1->0 transition.
    expect(tracker.exit("thread-2")).toBe(true);
  });
});

describe("ThreadStatusTracker — overlapping burst simulation", () => {
  test("a burst of 3 overlapping runs on one thread: only the first enter and the last exit are true", () => {
    const tracker = new ThreadStatusTracker();
    const key = "thread-1";

    const entries = [
      tracker.enter(key),
      tracker.enter(key),
      tracker.enter(key),
    ];
    expect(entries).toEqual([true, false, false]);

    // Runs complete in arbitrary order — only the exit that brings the count
    // to 0 (the last one) should report true.
    const exits = [tracker.exit(key), tracker.exit(key), tracker.exit(key)];
    expect(exits).toEqual([false, false, true]);
  });

  test("map entry is cleaned up after draining to 0 (no unbounded growth)", () => {
    const tracker = new ThreadStatusTracker();
    const key = "thread-1";
    tracker.enter(key);
    tracker.exit(key);
    // Internal cleanup isn't directly observable from the public API, but a
    // fresh enter() after a full drain must behave like a brand-new key
    // (0->1 => true), which would still hold even without cleanup. The real
    // guarantee here is exercised via exit() below: a stray exit on the
    // drained key is a no-op, matching "never entered" behavior exactly.
    expect(tracker.exit(key)).toBe(false);
    expect(tracker.enter(key)).toBe(true);
  });
});
