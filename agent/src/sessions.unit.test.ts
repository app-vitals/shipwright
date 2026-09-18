/**
 * Unit tests for the periodic session-store prune wiring in agent/src/sessions.ts.
 *
 * Pure logic over an injected store double and an injected setInterval — no file
 * I/O and no real timers, so this is a unit test (the file-backed store itself is
 * covered in sessions.integration.test.ts).
 *
 * Regression context (DTW-1.3 review): before this wiring, `prune()` had zero
 * production call sites, so entries only ever expired lazily on `get()` — which
 * never happens for a per-dispatch `dev-task:{id}:{nonce}` key that is written
 * once and never read again.
 */

import { describe, expect, test } from "bun:test";
import {
  SESSION_PRUNE_INTERVAL_MS,
  pruneSessionsOnce,
  startSessionPruner,
} from "./sessions.ts";

describe("pruneSessionsOnce", () => {
  test("returns the store's pruned count", async () => {
    const store = { prune: async () => 3 };
    expect(await pruneSessionsOnce(store, "sessions.json")).toBe(3);
  });

  test("swallows a prune failure and reports 0 — housekeeping never crashes a caller", async () => {
    const store = {
      prune: async () => {
        throw new Error("file unreadable");
      },
    };
    expect(await pruneSessionsOnce(store, "sessions.json")).toBe(0);
  });
});

describe("startSessionPruner", () => {
  test("sweeps once immediately and schedules a repeat on the default interval", async () => {
    let pruneCalls = 0;
    const store = {
      prune: async () => {
        pruneCalls += 1;
        return 1;
      },
    };
    const scheduled: Array<{ fn: () => void; ms: number }> = [];

    startSessionPruner(store, "sessions.json", {
      setIntervalFn: (fn, ms) => {
        scheduled.push({ fn, ms });
        return 0;
      },
    });

    // The startup sweep clears whatever a previous (possibly killed) process
    // stranded, without waiting a full interval.
    expect(pruneCalls).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(SESSION_PRUNE_INTERVAL_MS);

    // ...and each timer fire is another sweep.
    scheduled[0]?.fn();
    expect(pruneCalls).toBe(2);
  });

  test("honors an explicit interval", () => {
    const store = { prune: async () => 0 };
    const intervals: number[] = [];
    startSessionPruner(store, "sessions.json", {
      intervalMs: 1234,
      setIntervalFn: (_fn, ms) => {
        intervals.push(ms);
        return 0;
      },
    });
    expect(intervals).toEqual([1234]);
  });

  test("a throwing store does not propagate out of the scheduled sweep", () => {
    const store = {
      prune: async () => {
        throw new Error("boom");
      },
    };
    const scheduled: Array<() => void> = [];
    startSessionPruner(store, "sessions.json", {
      setIntervalFn: (fn) => {
        scheduled.push(fn);
        return 0;
      },
    });
    expect(() => scheduled[0]?.()).not.toThrow();
  });
});
