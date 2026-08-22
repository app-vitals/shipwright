/**
 * agent/src/agent-slack-membership-ref.unit.test.ts
 *
 * Unit tests for createAgentSlackMembershipRef() — pure logic, no I/O.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  agentSlackMembershipRef,
  createAgentSlackMembershipRef,
  resolveSlackMembership,
} from "./agent-slack-membership-ref.ts";

describe("createAgentSlackMembershipRef", () => {
  it("initial get() before any set() returns the fail-open default", () => {
    const ref = createAgentSlackMembershipRef();
    expect(ref.get()).toEqual({ restrict: false, emails: [] });
  });

  it("hasSynced() is false before any set() call", () => {
    const ref = createAgentSlackMembershipRef();
    expect(ref.hasSynced()).toBe(false);
  });

  it("hasSynced() becomes true after the first set(), even if set to empty state", () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: false, emails: [] });
    expect(ref.hasSynced()).toBe(true);
    expect(ref.get()).toEqual({ restrict: false, emails: [] });
  });

  it("hasSynced() stays true after subsequent set() calls, regardless of value", () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: true, emails: ["alice@example.com"] });
    expect(ref.hasSynced()).toBe(true);

    ref.set({ restrict: false, emails: [] });
    expect(ref.hasSynced()).toBe(true);
  });

  it("returns the most recently set membership config regardless of how many times set() was called", () => {
    const ref = createAgentSlackMembershipRef();
    const first = { restrict: false, emails: [] };
    const second = { restrict: true, emails: ["alice@example.com"] };
    const third = { restrict: true, emails: ["bob@example.com", "carol@example.com"] };

    ref.set(first);
    expect(ref.get()).toBe(first);

    ref.set(second);
    expect(ref.get()).toBe(second);

    ref.set(third);
    expect(ref.get()).toEqual(third);
  });

  it("multiple independent ref instances don't share state", () => {
    const refA = createAgentSlackMembershipRef();
    const refB = createAgentSlackMembershipRef();

    refA.set({ restrict: true, emails: ["alice@example.com"] });

    expect(refA.get()).toEqual({
      restrict: true,
      emails: ["alice@example.com"],
    });
    expect(refB.get()).toEqual({ restrict: false, emails: [] });
    expect(refA.hasSynced()).toBe(true);
    expect(refB.hasSynced()).toBe(false);
  });

  it("set() with restrict:true and emails is reflected by the next get()", () => {
    const ref = createAgentSlackMembershipRef();
    ref.set({ restrict: false, emails: [] });
    expect(ref.get()).toEqual({ restrict: false, emails: [] });

    ref.set({
      restrict: true,
      emails: ["alice@example.com", "bob@example.com"],
    });
    expect(ref.get()).toEqual({
      restrict: true,
      emails: ["alice@example.com", "bob@example.com"],
    });
  });
});

describe("agentSlackMembershipRef (process-wide singleton)", () => {
  afterEach(() => {
    agentSlackMembershipRef.set({ restrict: false, emails: [] });
  });

  it("is a working ref that reflects set() through get(), independent of createAgentSlackMembershipRef() instances", () => {
    const independent = createAgentSlackMembershipRef();
    independent.set({
      restrict: true,
      emails: ["should-not-leak@example.com"],
    });

    agentSlackMembershipRef.set({
      restrict: true,
      emails: ["alice@example.com"],
    });
    expect(agentSlackMembershipRef.get()).toEqual({
      restrict: true,
      emails: ["alice@example.com"],
    });
    expect(independent.get()).toEqual({
      restrict: true,
      emails: ["should-not-leak@example.com"],
    });
  });
});

describe("resolveSlackMembership", () => {
  // Regression coverage: the live config-bundle API may return null/undefined
  // for these fields even though AgentConfigResponse types them as
  // non-nullable. resolveSlackMembership must default to a fail-open state
  // (restrict: false, emails: []) to protect every downstream consumer.

  it("defaults a null restrictSlackToMembers to false", () => {
    expect(
      resolveSlackMembership(null as unknown as boolean, ["alice@example.com"]),
    ).toEqual({
      restrict: false,
      emails: ["alice@example.com"],
    });
  });

  it("defaults an undefined restrictSlackToMembers to false", () => {
    expect(
      resolveSlackMembership(undefined as unknown as boolean, [
        "alice@example.com",
      ]),
    ).toEqual({
      restrict: false,
      emails: ["alice@example.com"],
    });
  });

  it("defaults a null memberEmails to an empty array", () => {
    expect(resolveSlackMembership(true, null as unknown as string[])).toEqual(
      {
        restrict: true,
        emails: [],
      },
    );
  });

  it("defaults an undefined memberEmails to an empty array", () => {
    expect(
      resolveSlackMembership(true, undefined as unknown as string[]),
    ).toEqual({
      restrict: true,
      emails: [],
    });
  });

  it("defaults both null restrictSlackToMembers and null memberEmails to fail-open state", () => {
    expect(
      resolveSlackMembership(
        null as unknown as boolean,
        null as unknown as string[],
      ),
    ).toEqual({
      restrict: false,
      emails: [],
    });
  });

  it("syncing a null restrictSlackToMembers into the ref does not throw and leaves restrict as false", () => {
    const ref = createAgentSlackMembershipRef();
    const result = resolveSlackMembership(
      null as unknown as boolean,
      ["alice@example.com"],
    );

    expect(() => ref.set(result)).not.toThrow();
    expect(ref.get()).toEqual({
      restrict: false,
      emails: ["alice@example.com"],
    });
  });

  it("passes through a real restrictSlackToMembers and memberEmails array unchanged (no behavior change for real values)", () => {
    const emails = ["alice@example.com", "bob@example.com"];
    const result = resolveSlackMembership(true, emails);
    expect(result).toEqual({
      restrict: true,
      emails: emails,
    });
    // Verify emails array is the same reference (not copied)
    expect(result.emails).toBe(emails);
  });

  it("passes through an already-empty memberEmails array unchanged", () => {
    const config = { restrict: false, emails: [] };
    const result = resolveSlackMembership(config.restrict, config.emails);
    expect(result).toEqual(config);
  });
});
