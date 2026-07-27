/**
 * agent/src/agent-author-allowlist-ref.unit.test.ts
 *
 * Unit tests for createAgentAuthorAllowlistRef() — pure logic, no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  agentAuthorAllowlistRef,
  createAgentAuthorAllowlistRef,
  resolveAuthorAllowlist,
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

describe("resolveAuthorAllowlist", () => {
  // Regression coverage for AAL-2.3: the live config-bundle API has been
  // observed returning authorAllowlist: null in production (Sentry issue
  // 7633628941), even though AgentConfigResponse types it as a non-nullable
  // string[]. syncConfig() must default this to [] before handing it to
  // agentAuthorAllowlistRef.set(), so downstream .length checks never throw.
  it("defaults a null authorAllowlist (as returned by the live config-bundle API) to []", () => {
    const bundle = { authorAllowlist: null } as unknown as {
      authorAllowlist: string[];
    };

    expect(resolveAuthorAllowlist(bundle.authorAllowlist)).toEqual([]);
  });

  it("defaults an undefined authorAllowlist to []", () => {
    expect(resolveAuthorAllowlist(undefined)).toEqual([]);
  });

  it("syncing a null authorAllowlist into the ref does not throw and leaves get() as []", () => {
    const ref = createAgentAuthorAllowlistRef();
    const bundle = { authorAllowlist: null } as unknown as {
      authorAllowlist: string[];
    };

    expect(() =>
      ref.set(resolveAuthorAllowlist(bundle.authorAllowlist)),
    ).not.toThrow();
    expect(ref.get()).toEqual([]);
    expect(ref.get().length).toBe(0);
  });

  it("passes through a real authorAllowlist array unchanged (no behavior change for real values)", () => {
    const real = ["alice", "bob"];
    expect(resolveAuthorAllowlist(real)).toBe(real);
    expect(resolveAuthorAllowlist(real)).toEqual(["alice", "bob"]);
  });

  it("passes through an already-empty authorAllowlist array unchanged", () => {
    expect(resolveAuthorAllowlist([])).toEqual([]);
  });
});
