/**
 * tool-allowlist.ts
 * Curates the full generated MCP tool set down to the agreed public surface:
 * reads plus ordinary field edits (create/update task, update PR fields).
 *
 * Pipeline-internal lifecycle ops (claim/heartbeat/complete/fail/release) and
 * all token-management routes are excluded. The filter lives here — outside the
 * generated file — so that regenerating generated-tools.ts never inadvertently
 * re-exposes excluded ops.
 */

import type { GeneratedTool } from "./generated-tools.ts";

/**
 * Tools excluded from the public MCP surface.
 *
 * Excluded categories:
 * - Pipeline-internal lifecycle ops: tasks_claim, tasks_heartbeat, tasks_complete,
 *   tasks_fail, tasks_release, tasks_skip, tasks_reset
 * - Destructive ops: tasks_delete
 * - Token-management routes: tokens_list, tokens_create, tokens_update, tokens_delete
 * - PR lifecycle ops: prs_claim, prs_claim_next, prs_heartbeat, prs_complete,
 *   prs_patch, prs_release, prs_skip, prs_reset
 * - Audit-trail / finding routes: tasks_events, prs_events, prs_findings
 *
 * Note this is a deny-list: a newly generated tool is exposed unless it is
 * named here. `tasks_events`, `prs_events` and `prs_findings` were surfaced
 * when PTL-3.1 regenerated generated-tools.ts (the committed file had drifted
 * behind openapi.json), and are excluded to keep the public surface at the
 * agreed 9 tools — `prs_findings` is a write op in the same
 * pipeline-internal category as the lifecycle routes above, and the two
 * `*_events` routes are audit-trail internals. Widening the public MCP
 * surface is a deliberate decision, not a side effect of regeneration.
 *
 * SESH-2.2 decision (regeneration that added GET /sessions and
 * GET /sessions/{slug} to task-store/openapi.json): `sessions_list` and
 * `sessions_get` are deliberately NOT added here — they stay on the public
 * surface, bringing it to 11 tools. Reasoning: both are read-only GETs, and
 * task-store/src/routes/sessions.ts always builds an `agentScope` for any
 * token with a non-null `agentId` (an empty `repos` list degrades to
 * assignee-only visibility inside SessionService's `hasQualifyingTask()`
 * rather than to unrestricted access — fail-safe-restrictive, not
 * fail-open). That's the same shape as the already-public `tasks_list` /
 * `tasks_get` / `prs_list` / `prs_get` (agent-token-scoped reads), not the
 * shape of what's excluded above: `prs_findings` is a write op, and
 * `tasks_events` / `prs_events` are audit-trail internals unrelated to
 * per-agent scoping. This is a considered inclusion, not an omission.
 */
export const EXCLUDED_TOOLS: readonly string[] = [
  // tasks: pipeline-internal lifecycle
  "tasks_claim",
  "tasks_heartbeat",
  "tasks_complete",
  "tasks_fail",
  "tasks_release",
  "tasks_skip",
  "tasks_reset",
  // tasks: destructive
  "tasks_delete",
  // tokens: all token-management
  "tokens_list",
  "tokens_create",
  "tokens_update",
  "tokens_delete",
  // prs: pipeline-internal lifecycle
  "prs_claim",
  "prs_claim_next",
  "prs_heartbeat",
  "prs_complete",
  "prs_patch",
  "prs_release",
  "prs_skip",
  "prs_reset",
  // audit-trail reads + the findings write op
  "tasks_events",
  "prs_events",
  "prs_findings",
] as const;

/**
 * Filter a generated tool list down to the agreed public surface.
 * Allowed tools: tasks_list, tasks_create, tasks_bulk, tasks_distinct,
 * tasks_get, tasks_update, prs_list, prs_get, prs_update, sessions_list,
 * sessions_get (11 total).
 */
export function allowedTools(tools: GeneratedTool[]): GeneratedTool[] {
  const excluded = new Set<string>(EXCLUDED_TOOLS);
  return tools.filter((tool) => !excluded.has(tool.name));
}
