/**
 * admin/src/session-scope.ts
 *
 * Pure, no-I/O helpers deciding which sessions a caller is allowed to see:
 *
 *   1. visibleAgentIdsFor(isAdmin, memberships) — resolves the caller's
 *      accessible-agent-ids scope: "all" for an admin, or the list of agent
 *      ids the caller has a membership row for (possibly empty).
 *
 *   2. isSessionVisible(session, scope) — given a session-like value and a
 *      VisibilityScope, decides whether that session is visible: always true
 *      under the "all" scope, otherwise true iff the session's agentIds or
 *      repos intersects the scope's.
 *
 * Deliberately does not accept an email string or call
 * AgentMemberService.listByEmail() itself, even though the brief describes
 * visibleAgentIdsFor in terms of an email lookup. Doing that I/O here would
 * make this module untestable with plain fixtures (AC4 requires unit tests
 * with no I/O boundary). Real callers — the session list page, detail page,
 * follow routes, and the sweeper (none built yet) — already have `isAdmin`
 * from their own auth context (see admin/src/api-auth.ts's
 * createAdminAuthMiddleware) and can call
 * `agentMemberService.listByEmail(email)` themselves before invoking this
 * pure function. This mirrors the established pattern in
 * admin/src/agent-work-queue-merge.ts, which similarly takes
 * already-resolved data rather than performing its own I/O.
 *
 * Also deliberately does not import Session (task-store/src/session-rollup.ts)
 * or AgentMember (admin/src/agent-members.ts) directly — those types are
 * owned elsewhere. Instead this module declares narrow local structural
 * interfaces containing only the fields it needs, so it stays decoupled and
 * trivially testable against plain object fixtures.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal session shape the visibility check needs — a subset of
 * SessionRollup (task-store/src/session-rollup.ts), whose `agentIds` and
 * `repos` fields are always arrays (never undefined), deduped, and possibly
 * empty.
 */
export interface SessionForVisibility {
  agentIds: string[];
  repos: string[];
}

/**
 * Minimal membership shape visibleAgentIdsFor needs — a subset of
 * AgentMember (admin/src/agent-members.ts).
 */
export interface MembershipForScope {
  agentId: string;
}

/**
 * Minimal task shape deriveSessionVisibilityFromTasks needs — a subset of
 * both admin-ui-pages.ts's TaskItem and task-store's Task row.
 */
export interface TaskForVisibility {
  assignee?: string | null;
  claimedBy?: string | null;
  repo?: string | null;
}

/**
 * The caller's accessible-agent-ids scope: "all" for an admin (bypasses
 * every check), or the specific list of agent ids a member belongs to
 * (possibly empty — a member with zero memberships resolves to []).
 */
export type AgentIdScope = "all" | string[];

/**
 * The full visibility scope consumed by isSessionVisible(): the caller's
 * accessible agent ids (or "all") plus the repos they can see. `repos` is
 * resolved by the caller from the accessible agents' own `repos[]` fields
 * (admin/prisma/schema.prisma's Agent model) — this module has no access to
 * Agent data and does not compute it. Shared by the session list page,
 * detail page, follow routes, and the sweeper so they all apply the same
 * visibility rule.
 */
export interface VisibilityScope {
  agentIds: AgentIdScope;
  repos: string[];
}

// ─── Scope resolution ───────────────────────────────────────────────────────

/**
 * Resolve the caller's accessible-agent-ids scope. An admin sees every
 * agent ("all"), regardless of what memberships were passed in. A non-admin
 * (member) sees exactly the agent ids they hold a membership row for — []
 * for a member with zero memberships (AC3), not an error.
 */
export function visibleAgentIdsFor(
  isAdmin: boolean,
  memberships: MembershipForScope[],
): AgentIdScope {
  if (isAdmin) return "all";
  return memberships.map((membership) => membership.agentId);
}

// ─── Derivation from a session's tasks ──────────────────────────────────────

/**
 * Derive a SessionForVisibility from a session's own task rows, for callers
 * that already have the tasks in hand and would otherwise have to refetch
 * the session rollup (e.g. the session detail route).
 *
 * Deliberately mirrors task-store/src/session-rollup.ts's rollup derivation
 * exactly — `claimedBy ?? assignee` (ONE agent id per task, `claimedBy`
 * wins) for agentIds, and `repo` for repos — so a locally-derived scope
 * check matches the one the list page performs against the task-store's own
 * rollup `agentIds`. Unioning both fields instead would produce a superset:
 * a task reassigned from agent-a to agent-b (`assignee: "agent-a"`,
 * `claimedBy: "agent-b"`) rolls up to `["agent-b"]`, so agent-a's members
 * must not retain access.
 */
export function deriveSessionVisibilityFromTasks(
  tasks: TaskForVisibility[],
): SessionForVisibility {
  return {
    agentIds: [
      ...new Set(
        tasks
          .map((t) => t.claimedBy ?? t.assignee ?? null)
          .filter((id): id is string => id != null),
      ),
    ],
    repos: [
      ...new Set(
        tasks.map((t) => t.repo ?? null).filter((r): r is string => r != null),
      ),
    ],
  };
}

// ─── Visibility check ───────────────────────────────────────────────────────

/**
 * Decide whether a session is visible under the given scope.
 *
 * - "all" scope (admin): always visible (AC1), regardless of the session's
 *   agentIds/repos.
 * - Member scope: visible iff the session's agentIds intersects the scope's
 *   agentIds, OR the session's repos intersects the scope's repos (AC2). A
 *   scope built from zero memberships has empty agentIds/repos, so every
 *   session is correctly invisible (AC3) — no throw, just false.
 */
export function isSessionVisible(
  session: SessionForVisibility,
  scope: VisibilityScope,
): boolean {
  if (scope.agentIds === "all") return true;

  return (
    intersects(session.agentIds, scope.agentIds) ||
    intersects(session.repos, scope.repos)
  );
}

function intersects(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(b);
  return a.some((value) => set.has(value));
}
