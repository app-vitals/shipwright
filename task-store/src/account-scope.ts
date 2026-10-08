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
