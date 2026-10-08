/**
 * admin/src/account-agent-create.ts
 *
 * Shared rules for self-serve agent creation by account users (SSP-4.2),
 * used by both the admin UI form handler and the JSON API route so the two
 * cannot drift: account users always create "coding" agents stamped with
 * THEIR account (never a client-supplied one), and quota / account-status
 * failures surface as clear messages.
 */

import type { CallerScope } from "./caller-scope.ts";

/** The only agent type account users may create. */
export const SELF_SERVE_AGENT_TYPE = "coding";

/** Account the caller may create agents in, or null when they have none. */
export function accountIdFromScope(scope: CallerScope): string | null {
  return scope.kind === "scoped" ? scope.accountId : null;
}

/** Clear, user-facing messages for the account-specific createAgent() errors. */
export const ACCOUNT_CREATE_ERROR_MESSAGES = {
  quota_exceeded: "This account has reached its agent limit.",
  account_inactive: "This account is not active.",
} as const;

export function isAccountCreateErrorCode(
  code: string,
): code is keyof typeof ACCOUNT_CREATE_ERROR_MESSAGES {
  return code in ACCOUNT_CREATE_ERROR_MESSAGES;
}
