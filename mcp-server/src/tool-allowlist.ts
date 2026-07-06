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
 *   tasks_fail, tasks_release
 * - Destructive ops: tasks_delete
 * - Token-management routes: tokens_list, tokens_create, tokens_update, tokens_delete
 * - PR lifecycle ops: prs_claim, prs_claim_next, prs_heartbeat, prs_complete,
 *   prs_patch, prs_release
 */
export const EXCLUDED_TOOLS: readonly string[] = [
  // tasks: pipeline-internal lifecycle
  "tasks_claim",
  "tasks_heartbeat",
  "tasks_complete",
  "tasks_fail",
  "tasks_release",
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
] as const;

/**
 * Filter a generated tool list down to the agreed public surface.
 * Allowed tools: tasks_list, tasks_create, tasks_bulk, tasks_distinct,
 * tasks_get, tasks_update, prs_list, prs_get, prs_update (9 total).
 */
export function allowedTools(tools: GeneratedTool[]): GeneratedTool[] {
  const excluded = new Set<string>(EXCLUDED_TOOLS);
  return tools.filter((tool) => !excluded.has(tool.name));
}
