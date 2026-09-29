/**
 * agent/src/agent-policy-backfill.ts
 *
 * APM-1.1 — one-off backfill core for the 6 agent-policy DB fields
 * (autoPostReviews, allowSelfReview, minConfidence, maxFindings,
 * cleanupMergedWorktrees, cleanupAfterDays) added to Agent as flat scalar
 * columns. Every existing row already carries the documented DEFAULT value
 * from the migration itself (`admin/prisma/migrations/
 * 20260929120000_add_agent_policy_fields`) — this module's job is narrower:
 * given one already-provisioned agent's OWN state/agent-policy.md content
 * (which only ever lives on that agent's own pod filesystem — see
 * scripts/agent-workspace-pull.ts's doc comment on why there is no
 * remote-fetch mechanism for it today), overwrite that agent's DB row with
 * its real, possibly-non-default values.
 *
 * Lives in agent/src (not admin/src) despite writing to the admin database:
 * admin/package.json has no dependency on @shipwright/agent, but
 * agent/package.json DOES depend on @shipwright/admin (workspace:*) — so
 * admin/src importing check-helpers.ts's parse functions from agent/src
 * would be a reversed, undeclared cross-package dependency, and would form a
 * cycle given agent already depends on admin. Living here instead lets this
 * module reuse check-helpers.ts's 6 parse functions directly (same package)
 * while still reaching the admin Prisma client via the `@shipwright/admin`
 * package export (agent/scripts/backfill-agent-policy.ts is the thin CLI
 * that wires in the real `createAdminPrismaClient`).
 *
 * Mirrors pr-origin-backfill.ts's shape: a pure parse function, a
 * per-item apply function that never throws (errors are caught and returned
 * in the result, not thrown), and a same-shaped multi-item runner so one
 * agent's failure can't stop the rest of an operator-supplied batch.
 */

import {
  parseAllowSelfReview,
  parseAutoPostReviews,
  parseCleanupAfterDays,
  parseCleanupMergedWorktrees,
  parseMaxFindings,
  parseMinConfidence,
} from "./check-helpers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentPolicyFields {
  autoPostReviews: boolean;
  allowSelfReview: boolean;
  minConfidence: number;
  maxFindings: number;
  cleanupMergedWorktrees: boolean;
  cleanupAfterDays: number;
}

export interface AgentPolicyBackfillDeps {
  /** Writes the 6 fields onto one Agent row (`prisma.agent.update` in production). */
  updateAgentPolicy: (
    agentId: string,
    fields: AgentPolicyFields,
  ) => Promise<void>;
}

/** Per-agent result of `backfillAgentPolicy()` — printed by the CLI as a human-readable summary. */
export interface AgentPolicyBackfillResult {
  agentId: string;
  /**
   * The parsed fields, always populated once parsing has run (parsing itself
   * never throws — each underlying check-helpers.ts parser falls back to its
   * own documented default on a missing/unparseable field). Reported even
   * when `error` is set, so an operator can see what *would* have been
   * written had the DB write not failed.
   */
  fields: AgentPolicyFields;
  error: string | null;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Composes the 6 check-helpers.ts policy parsers against one
 * state/agent-policy.md file's raw content. Pure — never throws; every
 * underlying parser already defaults on a missing/unparseable field.
 */
export function parseAgentPolicyFields(content: string): AgentPolicyFields {
  return {
    autoPostReviews: parseAutoPostReviews(content),
    allowSelfReview: parseAllowSelfReview(content),
    minConfidence: parseMinConfidence(content),
    maxFindings: parseMaxFindings(content),
    cleanupMergedWorktrees: parseCleanupMergedWorktrees(content),
    cleanupAfterDays: parseCleanupAfterDays(content),
  };
}

/**
 * Parses one agent's policy file content and writes the result onto its
 * Agent row via the injected `updateAgentPolicy` dep. Never throws: a
 * failure from `updateAgentPolicy` (missing agent, DB unreachable, etc.) is
 * caught and surfaced via `result.error` so a multi-agent CLI run
 * (`runAgentPolicyBackfill`) can continue past it.
 */
export async function backfillAgentPolicy(
  deps: AgentPolicyBackfillDeps,
  agentId: string,
  policyFileContent: string,
): Promise<AgentPolicyBackfillResult> {
  const fields = parseAgentPolicyFields(policyFileContent);
  try {
    await deps.updateAgentPolicy(agentId, fields);
    return { agentId, fields, error: null };
  } catch (err) {
    return {
      agentId,
      fields,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Runs `backfillAgentPolicy()` over every `{ agentId, content }` pair in
 * order, collecting one result per agent. One agent's failure — already
 * caught and turned into `result.error` by `backfillAgentPolicy()` — never
 * stops the remaining agents in the batch.
 */
export async function runAgentPolicyBackfill(
  deps: AgentPolicyBackfillDeps,
  items: Array<{ agentId: string; content: string }>,
): Promise<AgentPolicyBackfillResult[]> {
  const results: AgentPolicyBackfillResult[] = [];
  for (const item of items) {
    results.push(await backfillAgentPolicy(deps, item.agentId, item.content));
  }
  return results;
}
