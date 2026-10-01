/**
 * agent/src/allow-self-review-ref.unit.test.ts
 *
 * Unit tests for createAllowSelfReviewRef() — pure logic, no I/O.
 * Mirrors agent-trial-expiry-ref.unit.test.ts's coverage pattern.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  allowSelfReviewRef,
  createAllowSelfReviewRef,
} from "./allow-self-review-ref.ts";

describe("createAllowSelfReviewRef", () => {
  it("initial get() before any set() returns false (fail-open default)", () => {
    const ref = createAllowSelfReviewRef();
    expect(ref.get()).toBe(false);
  });

  it("hasSynced() is false before any set() call", () => {
    const ref = createAllowSelfReviewRef();
    expect(ref.hasSynced()).toBe(false);
  });

  it("hasSynced() becomes true after the first set(), even if set to false", () => {
    const ref = createAllowSelfReviewRef();
    ref.set(false);
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toBe(false);
  });

  it("hasSynced() stays true after subsequent set() calls, regardless of value", () => {
    const ref = createAllowSelfReviewRef();
    ref.set(true);
    expect(ref.hasSynced()).toBe(true);

    ref.set(false);
    expect(ref.hasSynced()).toBe(true);
  });

  it("returns the most recently set value regardless of how many times set() was called", () => {
    const ref = createAllowSelfReviewRef();
    ref.set(true);
    expect(ref.get()).toBe(true);

    ref.set(false);
    expect(ref.get()).toBe(false);

    ref.set(true);
    expect(ref.get()).toBe(true);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createAllowSelfReviewRef();
    const refB = createAllowSelfReviewRef();

    refA.set(true);

    expect(refA.get()).toBe(true);
    expect(refB.get()).toBe(false);
    expect(refA.hasSynced()).toBe(true);
    expect(refB.hasSynced()).toBe(false);
  });
});

describe("allowSelfReviewRef (process-wide singleton)", () => {
  afterEach(() => {
    allowSelfReviewRef.set(false);
  });

  it("is a working ref that reflects set() through get(), independent of createAllowSelfReviewRef() instances", () => {
    const independent = createAllowSelfReviewRef();
    independent.set(true);

    allowSelfReviewRef.set(true);
    expect(allowSelfReviewRef.get()).toBe(true);

    independent.set(false);
    expect(allowSelfReviewRef.get()).toBe(true);
  });
});
