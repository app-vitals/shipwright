/**
 * admin/src/session-scope.unit.test.ts
 *
 * Unit tests for the pure session-visibility helpers in session-scope.ts.
 * No I/O — pure logic only, over fixture Session/scope objects.
 */

import { describe, expect, it } from "bun:test";
import {
  deriveSessionVisibilityFromTasks,
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
    expect(
      isSessionVisible(makeSession({ agentIds: [], repos: [] }), scope),
    ).toBe(false);
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

// ─── deriveSessionVisibilityFromTasks ───────────────────────────────────────

describe("deriveSessionVisibilityFromTasks", () => {
  it("uses `claimedBy ?? assignee` precedence — a reassigned task yields only claimedBy", () => {
    // Mirrors task-store/src/session-rollup.ts: one agent id per task,
    // claimedBy wins. Unioning both fields would leave the stale assignee in
    // scope and let their members see a session the list page hides.
    expect(
      deriveSessionVisibilityFromTasks([
        { assignee: "agent-a", claimedBy: "agent-b", repo: "org/repo-1" },
      ]),
    ).toEqual({ agentIds: ["agent-b"], repos: ["org/repo-1"] });
  });

  it("falls back to assignee when claimedBy is null/undefined", () => {
    expect(
      deriveSessionVisibilityFromTasks([
        { assignee: "agent-a", claimedBy: null },
        { assignee: "agent-c" },
      ]),
    ).toEqual({ agentIds: ["agent-a", "agent-c"], repos: [] });
  });

  it("dedupes agent ids and repos across tasks and drops null/undefined values", () => {
    expect(
      deriveSessionVisibilityFromTasks([
        { assignee: "agent-a", repo: "org/repo-1" },
        { claimedBy: "agent-a", repo: "org/repo-1" },
        { assignee: null, claimedBy: null, repo: null },
        { claimedBy: "agent-b", repo: "org/repo-2" },
      ]),
    ).toEqual({
      agentIds: ["agent-a", "agent-b"],
      repos: ["org/repo-1", "org/repo-2"],
    });
  });

  it("returns empty arrays for an empty task list", () => {
    expect(deriveSessionVisibilityFromTasks([])).toEqual({
      agentIds: [],
      repos: [],
    });
  });

  it("the derived shape composes with isSessionVisible", () => {
    const derived = deriveSessionVisibilityFromTasks([
      { assignee: "agent-a", claimedBy: "agent-b", repo: "org/repo-1" },
    ]);
    expect(
      isSessionVisible(derived, makeScope({ agentIds: ["agent-b"] })),
    ).toBe(true);
    expect(
      isSessionVisible(derived, makeScope({ agentIds: ["agent-a"] })),
    ).toBe(false);
  });
});
