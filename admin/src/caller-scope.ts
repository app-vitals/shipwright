/**
 * admin/src/caller-scope.ts
 *
 * Single resolver for "which agents may this caller see/act on" (SSP-2.1),
 * shared by the admin UI (assertAgentAccess, resolveAccessibleAgents), the
 * session-visibility helpers and the JSON API auth middleware.
 *
 * Resolved per request from the caller's email — the account is deliberately
 * NOT stored in the session JWT, so membership changes take effect
 * immediately. Account membership contributes agents only when the self-serve
 * flag is on; with it off the scope is exactly the AgentMember-only scope.
 */

import type { AccountService } from "./accounts.ts";
import type { AgentMemberService } from "./agent-members.ts";

export type CallerScope =
  | { kind: "all" }
  | { kind: "scoped"; accountId: string | null; agentIds: string[] };

export interface CallerScopeInput {
  email: string;
  isAdmin: boolean;
  flagEnabled: boolean;
}

/** I/O boundary of the resolver — injected so the logic stays unit-testable. */
export interface CallerScopeDeps {
  /** Account the email belongs to, or null. */
  getAccountIdByEmail(email: string): Promise<string | null>;
  /** Ids of every agent whose accountId matches. */
  listAgentIdsByAccount(accountId: string): Promise<string[]>;
  /** Ids of agents the email holds an AgentMember row for. */
  listMemberAgentIds(email: string): Promise<string[]>;
}

export async function resolveCallerScope(
  input: CallerScopeInput,
  deps: CallerScopeDeps,
): Promise<CallerScope> {
  if (input.isAdmin) return { kind: "all" };
  const email = input.email.toLowerCase();

  const accountId = input.flagEnabled
    ? await deps.getAccountIdByEmail(email)
    : null;
  const [accountAgentIds, memberAgentIds] = await Promise.all([
    accountId ? deps.listAgentIdsByAccount(accountId) : [],
    deps.listMemberAgentIds(email),
  ]);
  return {
    kind: "scoped",
    accountId,
    agentIds: [...new Set([...accountAgentIds, ...memberAgentIds])],
  };
}

export function scopeIncludesAgent(
  scope: CallerScope,
  agentId: string,
): boolean {
  return scope.kind === "all" || scope.agentIds.includes(agentId);
}

/**
 * How a caller may read the admin UI's task-store views — Tasks, PRs and
 * Sessions (SSP-6.8). Platform admins see every account; an account user
 * (self-serve flag on, so the resolver produced an accountId) sees exactly
 * their account, filtered server-side via the task-store's `?accountId=`;
 * anyone else keeps today's admin-only gate.
 */
export type TaskStoreViewScope =
  | { kind: "all" }
  | { kind: "account"; accountId: string; agentIds: string[] }
  | { kind: "none" };

export function taskStoreViewScope(scope: CallerScope): TaskStoreViewScope {
  if (scope.kind === "all") return { kind: "all" };
  if (scope.accountId === null) return { kind: "none" };
  return {
    kind: "account",
    accountId: scope.accountId,
    agentIds: scope.agentIds,
  };
}

/** Per-request resolver with the flag already bound. */
export type CallerScopeResolver = (
  email: string,
  isAdmin: boolean,
) => Promise<CallerScope>;

export function createCallerScopeResolver(
  deps: CallerScopeDeps,
  flagEnabled: boolean,
): CallerScopeResolver {
  return (email, isAdmin) =>
    resolveCallerScope({ email, isAdmin, flagEnabled }, deps);
}

/** Wire the resolver's I/O to the real services. */
export function callerScopeDepsFromServices(services: {
  accountService: Pick<AccountService, "getByMemberEmail" | "listAgentIds">;
  agentMemberService: Pick<AgentMemberService, "listByEmail">;
}): CallerScopeDeps {
  return {
    getAccountIdByEmail: async (email) =>
      (await services.accountService.getByMemberEmail(email))?.id ?? null,
    listAgentIdsByAccount: (accountId) =>
      services.accountService.listAgentIds(accountId),
    listMemberAgentIds: async (email) =>
      (await services.agentMemberService.listByEmail(email)).map(
        (m) => m.agentId,
      ),
  };
}

/** Flag-off resolver backed only by AgentMember rows (today's behavior). */
export function memberOnlyCallerScopeResolver(
  agentMemberService: Pick<AgentMemberService, "listByEmail">,
): CallerScopeResolver {
  return createCallerScopeResolver(
    {
      getAccountIdByEmail: async () => null,
      listAgentIdsByAccount: async () => [],
      listMemberAgentIds: async (email) =>
        (await agentMemberService.listByEmail(email)).map((m) => m.agentId),
    },
    false,
  );
}
