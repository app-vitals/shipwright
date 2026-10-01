/**
 * agent/src/cleanup-merged-worktrees-ref.unit.test.ts
 *
 * Unit tests for createCleanupMergedWorktreesRef() — pure logic, no I/O.
 * Mirrors allow-self-review-ref.unit.test.ts's coverage pattern.
 *
 * Deliberately does NOT exercise the process-wide `cleanupMergedWorktreesRef`
 * singleton's set() here (unlike allow-self-review-ref.unit.test.ts) — once
 * set() is called, hasSynced() can never be un-set, so mutating the shared
 * singleton would permanently poison it for the rest of this bun test
 * process (this repo's test-isolation hard rule: "Bun shares the test
 * process, so leaked globals break sibling suites"). That would silently
 * break check-helpers.unit.test.ts's readCleanupMergedWorktrees()
 * "no injected ref" tests, which rely on the singleton staying unsynced.
 * createCleanupMergedWorktreesRef() exercises identical get/hasSynced/set
 * logic on an independent instance, so coverage is unaffected.
 */

import { describe, expect, it } from "bun:test";
import { createCleanupMergedWorktreesRef } from "./cleanup-merged-worktrees-ref.ts";

describe("createCleanupMergedWorktreesRef", () => {
  it("initial get() before any set() returns true (matches the DB/file default)", () => {
    const ref = createCleanupMergedWorktreesRef();
    expect(ref.get()).toBe(true);
  });

  it("hasSynced() is false before any set() call", () => {
    const ref = createCleanupMergedWorktreesRef();
    expect(ref.hasSynced()).toBe(false);
  });

  it("hasSynced() becomes true after the first set(), even if set to false", () => {
    const ref = createCleanupMergedWorktreesRef();
    ref.set(false);
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toBe(false);
  });

  it("hasSynced() stays true after subsequent set() calls, regardless of value", () => {
    const ref = createCleanupMergedWorktreesRef();
    ref.set(false);
    expect(ref.hasSynced()).toBe(true);

    ref.set(true);
    expect(ref.hasSynced()).toBe(true);
  });

  it("returns the most recently set value regardless of how many times set() was called", () => {
    const ref = createCleanupMergedWorktreesRef();
    ref.set(false);
    expect(ref.get()).toBe(false);

    ref.set(true);
    expect(ref.get()).toBe(true);

    ref.set(false);
    expect(ref.get()).toBe(false);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createCleanupMergedWorktreesRef();
    const refB = createCleanupMergedWorktreesRef();

    refA.set(false);

    expect(refA.get()).toBe(false);
    expect(refB.get()).toBe(true);
    expect(refA.hasSynced()).toBe(true);
    expect(refB.hasSynced()).toBe(false);
  });
});
