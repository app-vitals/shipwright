/**
 * admin/src/session-scope.unit.test.ts
 *
 * Unit tests for the pure session-visibility helpers in session-scope.ts.
 * No I/O — pure logic only, over fixture Session/scope objects.
 */

import { describe, expect, it } from "bun:test";
import {
  isSessionVisible,
  type MembershipForScope,
  type SessionForVisibility,
  type VisibilityScope,
  visibleAgentIdsFor,
} from "./session-scope.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(
  overrides: Partial<SessionForVisibility> = {},
): SessionForVisibility {
  return {
    agentIds: [],
    repos: [],
    ...overrides,
  };
}

function makeMembership(
  overrides: Partial<MembershipForScope> = {},
): MembershipForScope {
  return {
    agentId: "agent-1",
    ...overrides,
  };
}

function makeScope(overrides: Partial<VisibilityScope> = {}): VisibilityScope {
  return {
    agentIds: [],
    repos: [],
    ...overrides,
  };
}

// ─── visibleAgentIdsFor ─────────────────────────────────────────────────────

describe("visibleAgentIdsFor", () => {
  it("returns the 'all' sentinel when isAdmin is true, regardless of memberships passed", () => {
    expect(visibleAgentIdsFor(true, [])).toBe("all");
    expect(
      visibleAgentIdsFor(true, [
        makeMembership({ agentId: "agent-a" }),
        makeMembership({ agentId: "agent-b" }),
      ]),
    ).toBe("all");
  });

  it("returns the agent ids resolved from memberships when isAdmin is false", () => {
    const result = visibleAgentIdsFor(false, [
      makeMembership({ agentId: "agent-a" }),
      makeMembership({ agentId: "agent-b" }),
    ]);
    expect(result).toEqual(["agent-a", "agent-b"]);
  });

  it("returns an empty array (not an error) for a member with zero memberships", () => {
    expect(visibleAgentIdsFor(false, [])).toEqual([]);
  });
});

// ─── isSessionVisible ───────────────────────────────────────────────────────

describe("isSessionVisible", () => {
  it("AC1: admin scope sees a session with empty agentIds/repos", () => {
    const session = makeSession({ agentIds: [], repos: [] });
    const scope = makeScope({ agentIds: "all" });
    expect(isSessionVisible(session, scope)).toBe(true);
  });

  it("AC1: admin scope sees a session with populated but unrelated agentIds/repos", () => {
    const session = makeSession({
      agentIds: ["agent-x", "agent-y"],
      repos: ["org/repo-x"],
    });
    const scope = makeScope({ agentIds: "all" });
    expect(isSessionVisible(session, scope)).toBe(true);
  });

  it("AC2: member scope sees a session when agentIds intersects", () => {
    const session = makeSession({ agentIds: ["agent-a"], repos: [] });
    const scope = makeScope({ agentIds: ["agent-a", "agent-b"], repos: [] });
    expect(isSessionVisible(session, scope)).toBe(true);
  });

  it("AC2: member scope sees a session via repos intersection even when agentIds does not intersect", () => {
    const session = makeSession({
      agentIds: ["agent-z"],
      repos: ["org/repo-1"],
    });
    const scope = makeScope({
      agentIds: ["agent-a", "agent-b"],
      repos: ["org/repo-1"],
    });
    expect(isSessionVisible(session, scope)).toBe(true);
  });

  it("AC2: member scope does NOT see a session when neither agentIds nor repos intersects", () => {
    const session = makeSession({
      agentIds: ["agent-z"],
      repos: ["org/repo-9"],
    });
    const scope = makeScope({
      agentIds: ["agent-a", "agent-b"],
      repos: ["org/repo-1"],
    });
    expect(isSessionVisible(session, scope)).toBe(false);
  });

  it("AC3: member with zero memberships (empty scope) sees nothing, not an error", () => {
    const scope = makeScope({
      agentIds: visibleAgentIdsFor(false, []),
      repos: [],
    });
    expect(isSessionVisible(makeSession({ agentIds: [], repos: [] }), scope)).toBe(
      false,
    );
    expect(
      isSessionVisible(
        makeSession({ agentIds: ["agent-a"], repos: ["org/repo-1"] }),
        scope,
      ),
    ).toBe(false);
  });

  it("returns false for a session with empty agentIds/repos under a non-empty member scope", () => {
    const session = makeSession({ agentIds: [], repos: [] });
    const scope = makeScope({ agentIds: ["agent-a"], repos: ["org/repo-1"] });
    expect(isSessionVisible(session, scope)).toBe(false);
  });
});
