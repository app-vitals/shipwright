/**
 * agent/src/agent-author-allowlist-ref.unit.test.ts
 *
 * Unit tests for createAgentAuthorAllowlistRef() — pure logic, no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  agentAuthorAllowlistRef,
  createAgentAuthorAllowlistRef,
} from "./agent-author-allowlist-ref.ts";

describe("createAgentAuthorAllowlistRef", () => {
  it("initial get() before any set() returns an empty/safe default", () => {
    const ref = createAgentAuthorAllowlistRef();
    expect(ref.get()).toEqual([]);
  });

  it("hasSynced() is false before any set() call", () => {
    const ref = createAgentAuthorAllowlistRef();
    expect(ref.hasSynced()).toBe(false);
  });

  it("hasSynced() becomes true after the first set(), even if set to an empty list", () => {
    const ref = createAgentAuthorAllowlistRef();
    ref.set([]);
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toEqual([]);
  });

  it("hasSynced() stays true after subsequent set() calls, regardless of value", () => {
    const ref = createAgentAuthorAllowlistRef();
    ref.set(["alice"]);
    expect(ref.hasSynced()).toBe(true);

    ref.set([]);
    expect(ref.hasSynced()).toBe(true);
  });

  it("returns the most recently set allowlist regardless of how many times set() was called", () => {
    const ref = createAgentAuthorAllowlistRef();
    const first = ["alice"];
    const second = ["bob"];
    const third = ["carol", "dave"];

    ref.set(first);
    expect(ref.get()).toBe(first);

    ref.set(second);
    expect(ref.get()).toBe(second);

    ref.set(third);
    expect(ref.get()).toEqual(third);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createAgentAuthorAllowlistRef();
    const refB = createAgentAuthorAllowlistRef();

    refA.set(["alice"]);

    expect(refA.get()).toEqual(["alice"]);
    expect(refB.get()).toEqual([]);
    expect(refA.hasSynced()).toBe(true);
    expect(refB.hasSynced()).toBe(false);
  });

  it("set() with an empty array is reflected by the next get()", () => {
    const ref = createAgentAuthorAllowlistRef();
    ref.set(["alice"]);
    expect(ref.get()).toHaveLength(1);

    ref.set([]);
    expect(ref.get()).toEqual([]);
  });
});

describe("agentAuthorAllowlistRef (process-wide singleton)", () => {
  it("is a working ref that reflects set() through get(), independent of createAgentAuthorAllowlistRef() instances", () => {
    const independent = createAgentAuthorAllowlistRef();
    independent.set(["should-not-leak"]);

    agentAuthorAllowlistRef.set(["alice"]);
    expect(agentAuthorAllowlistRef.get()).toEqual(["alice"]);
    expect(independent.get()).toEqual(["should-not-leak"]);
  });
});
