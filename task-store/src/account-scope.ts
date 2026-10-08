/**
 * task-store/src/account-scope.ts
 * Shared helper for reading the caller's account scope off the request context.
 *
 * Agent tokens are pinned to the `accountId` resolved by the auth middleware;
 * a client-supplied `?accountId=` is ignored for them. Admin tokens are
 * unrestricted (null) unless they pass `?accountId=` to narrow to one account.
 *
 * Returns:
 *   null   = unrestricted (admin token, no ?accountId=)
 *   string = restrict to this account (NO_ACCESS_ACCOUNT_ID matches no rows)
 */

import { DEFAULT_ACCOUNT_ID } from "@shipwright/lib/default-account";
import type { Context } from "hono";
import type { TaskStoreAuthEnv } from "./auth.ts";

export function resolveAccountScope(
  c: Context<TaskStoreAuthEnv>,
): string | null {
  const callerAccountId = c.get("accountId");
  if (callerAccountId !== null) return callerAccountId;
  const requested = c.req.query("accountId");
  return requested ? requested : null;
}

/**
 * The account a write should stamp on rows it creates (SSP-6.3): the agent
 * token's resolved account, or for an admin token its `?accountId=` (falling
 * back to DEFAULT_ACCOUNT_ID — never null).
 */
export function resolveWriteAccountId(c: Context<TaskStoreAuthEnv>): string {
  return resolveAccountScope(c) ?? DEFAULT_ACCOUNT_ID;
}
