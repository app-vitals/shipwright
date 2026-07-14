/**
 * agent/src/loop-jobs-ref.unit.test.ts
 *
 * Unit tests for createJobsRef() — pure logic, no I/O.
 */

import { describe, expect, it } from "bun:test";
import { createJobsRef } from "./loop-jobs-ref.ts";

interface TestJob {
  id: string;
  enabled: boolean;
}

describe("createJobsRef", () => {
  it("initial get() before any set() returns an empty/safe default", () => {
    const ref = createJobsRef<TestJob>();
    expect(ref.get()).toEqual([]);
  });

  it("returns the most recently set jobs list regardless of how many times set() was called", () => {
    const ref = createJobsRef<TestJob>();
    const first = [{ id: "a", enabled: true }];
    const second = [{ id: "b", enabled: false }];
    const third = [
      { id: "c", enabled: true },
      { id: "d", enabled: false },
    ];

    ref.set(first);
    expect(ref.get()).toBe(first);

    ref.set(second);
    expect(ref.get()).toBe(second);

    ref.set(third);
    expect(ref.get()).toEqual(third);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createJobsRef<TestJob>();
    const refB = createJobsRef<TestJob>();

    refA.set([{ id: "a", enabled: true }]);

    expect(refA.get()).toEqual([{ id: "a", enabled: true }]);
    expect(refB.get()).toEqual([]);
  });

  it("set() with an empty array is reflected by the next get()", () => {
    const ref = createJobsRef<TestJob>();
    ref.set([{ id: "a", enabled: true }]);
    expect(ref.get()).toHaveLength(1);

    ref.set([]);
    expect(ref.get()).toEqual([]);
  });
});
