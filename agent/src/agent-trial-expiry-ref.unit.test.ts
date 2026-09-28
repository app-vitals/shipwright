/**
 * agent/src/agent-trial-expiry-ref.unit.test.ts
 *
 * Unit tests for createAgentTrialExpiryRef() — pure logic, no I/O.
 * Mirrors agent-slack-membership-ref.unit.test.ts's coverage pattern.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  agentTrialExpiryRef,
  createAgentTrialExpiryRef,
} from "./agent-trial-expiry-ref.ts";

describe("createAgentTrialExpiryRef", () => {
  it("initial get() before any set() returns null (fail-open default)", () => {
    const ref = createAgentTrialExpiryRef();
    expect(ref.get()).toBeNull();
  });

  it("hasSynced() is false before any set() call", () => {
    const ref = createAgentTrialExpiryRef();
    expect(ref.hasSynced()).toBe(false);
  });

  it("hasSynced() becomes true after the first set(), even if set to null", () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(null);
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toBeNull();
  });

  it("hasSynced() stays true after subsequent set() calls, regardless of value", () => {
    const ref = createAgentTrialExpiryRef();
    ref.set(new Date("2026-01-01T00:00:00.000Z"));
    expect(ref.hasSynced()).toBe(true);

    ref.set(null);
    expect(ref.hasSynced()).toBe(true);
  });

  it("returns the most recently set trial-expiry date regardless of how many times set() was called", () => {
    const ref = createAgentTrialExpiryRef();
    const first = new Date("2026-01-01T00:00:00.000Z");
    const second = null;
    const third = new Date("2026-06-15T00:00:00.000Z");

    ref.set(first);
    expect(ref.get()).toBe(first);

    ref.set(second);
    expect(ref.get()).toBeNull();

    ref.set(third);
    expect(ref.get()).toBe(third);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createAgentTrialExpiryRef();
    const refB = createAgentTrialExpiryRef();

    refA.set(new Date("2026-01-01T00:00:00.000Z"));

    expect(refA.get()).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(refB.get()).toBeNull();
    expect(refA.hasSynced()).toBe(true);
    expect(refB.hasSynced()).toBe(false);
  });
});

describe("agentTrialExpiryRef (process-wide singleton)", () => {
  afterEach(() => {
    agentTrialExpiryRef.set(null);
  });

  it("is a working ref that reflects set() through get(), independent of createAgentTrialExpiryRef() instances", () => {
    const independent = createAgentTrialExpiryRef();
    independent.set(new Date("2099-01-01T00:00:00.000Z"));

    const expiry = new Date("2026-03-01T00:00:00.000Z");
    agentTrialExpiryRef.set(expiry);
    expect(agentTrialExpiryRef.get()).toEqual(expiry);
    expect(independent.get()).toEqual(new Date("2099-01-01T00:00:00.000Z"));
  });
});
