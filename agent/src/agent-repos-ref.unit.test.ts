/**
 * agent/src/agent-repos-ref.unit.test.ts
 *
 * Unit tests for createAgentReposRef() — pure logic, no I/O.
 */

import { describe, expect, it } from "bun:test";
import { agentReposRef, createAgentReposRef } from "./agent-repos-ref.ts";

describe("createAgentReposRef", () => {
  it("initial get() before any set() returns an empty/safe default", () => {
    const ref = createAgentReposRef();
    expect(ref.get()).toEqual([]);
  });

  it("returns the most recently set repos list regardless of how many times set() was called", () => {
    const ref = createAgentReposRef();
    const first = ["org/repo-a"];
    const second = ["org/repo-b"];
    const third = ["org/repo-c", "org/repo-d"];

    ref.set(first);
    expect(ref.get()).toBe(first);

    ref.set(second);
    expect(ref.get()).toBe(second);

    ref.set(third);
    expect(ref.get()).toEqual(third);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createAgentReposRef();
    const refB = createAgentReposRef();

    refA.set(["org/repo-a"]);

    expect(refA.get()).toEqual(["org/repo-a"]);
    expect(refB.get()).toEqual([]);
  });

  it("set() with an empty array is reflected by the next get()", () => {
    const ref = createAgentReposRef();
    ref.set(["org/repo-a"]);
    expect(ref.get()).toHaveLength(1);

    ref.set([]);
    expect(ref.get()).toEqual([]);
  });
});

describe("agentReposRef (process-wide singleton)", () => {
  it("is a working ref that reflects set() through get(), independent of createAgentReposRef() instances", () => {
    const independent = createAgentReposRef();
    independent.set(["org/should-not-leak"]);

    agentReposRef.set(["org/scoped-repo"]);
    expect(agentReposRef.get()).toEqual(["org/scoped-repo"]);
    expect(independent.get()).toEqual(["org/should-not-leak"]);
  });
});
