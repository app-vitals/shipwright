/**
 * agent/src/cleanup-after-days-ref.unit.test.ts
 *
 * Unit tests for createCleanupAfterDaysRef() — pure logic, no I/O.
 * Mirrors allow-self-review-ref.unit.test.ts's coverage pattern.
 *
 * Deliberately does NOT exercise the process-wide `cleanupAfterDaysRef`
 * singleton's set() here (unlike allow-self-review-ref.unit.test.ts) — once
 * set() is called, hasSynced() can never be un-set, so mutating the shared
 * singleton would permanently poison it for the rest of this bun test
 * process (this repo's test-isolation hard rule: "Bun shares the test
 * process, so leaked globals break sibling suites"). That would silently
 * break check-helpers.unit.test.ts's readCleanupAfterDays() "no injected
 * ref" tests, which rely on the singleton staying unsynced.
 * createCleanupAfterDaysRef() exercises identical get/hasSynced/set logic on
 * an independent instance, so coverage is unaffected.
 */

import { describe, expect, it } from "bun:test";
import { createCleanupAfterDaysRef } from "./cleanup-after-days-ref.ts";

describe("createCleanupAfterDaysRef", () => {
  it("initial get() before any set() returns 14 (matches the DB/file default)", () => {
    const ref = createCleanupAfterDaysRef();
    expect(ref.get()).toBe(14);
  });

  it("hasSynced() is false before any set() call", () => {
    const ref = createCleanupAfterDaysRef();
    expect(ref.hasSynced()).toBe(false);
  });

  it("hasSynced() becomes true after the first set(), even if set to the default value", () => {
    const ref = createCleanupAfterDaysRef();
    ref.set(14);
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toBe(14);
  });

  it("hasSynced() stays true after subsequent set() calls, regardless of value", () => {
    const ref = createCleanupAfterDaysRef();
    ref.set(30);
    expect(ref.hasSynced()).toBe(true);

    ref.set(7);
    expect(ref.hasSynced()).toBe(true);
  });

  it("returns the most recently set value regardless of how many times set() was called", () => {
    const ref = createCleanupAfterDaysRef();
    ref.set(30);
    expect(ref.get()).toBe(30);

    ref.set(7);
    expect(ref.get()).toBe(7);

    ref.set(21);
    expect(ref.get()).toBe(21);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createCleanupAfterDaysRef();
    const refB = createCleanupAfterDaysRef();

    refA.set(30);

    expect(refA.get()).toBe(30);
    expect(refB.get()).toBe(14);
    expect(refA.hasSynced()).toBe(true);
    expect(refB.hasSynced()).toBe(false);
  });
});
