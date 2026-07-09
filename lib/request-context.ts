/**
 * Represents an authenticated request caller, shared across services that
 * resolve caller identity in auth middleware (admin, task-store, metrics).
 *
 * scope === "*" → unrestricted/admin (all clients/agents)
 * scope === "<id>" → scoped to a single identity (clientId, agentId, etc.)
 */
export interface Caller {
  name: string;
  scope: string; // "*" or a scoped identity such as a clientId/agentId
}

/**
 * Produce a stable, readable label for a caller, suitable for log lines.
 * Returns "anonymous" when no caller is present (e.g. unauthenticated or
 * not-yet-resolved requests).
 */
export function callerLabel(caller?: Caller): string {
  if (!caller) return "anonymous";
  return `${caller.name} (${caller.scope})`;
}
