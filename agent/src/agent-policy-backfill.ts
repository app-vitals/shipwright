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
 * module reuse the 6 parse functions defined below
 * while still reaching the admin Prisma client via the `@shipwright/admin`
 * package export (agent/scripts/backfill-agent-policy.ts is the thin CLI
 * that wires in the real `createAdminPrismaClient`).
 *
 * Mirrors pr-origin-backfill.ts's shape: a pure parse function, a
 * per-item apply function that never throws (errors are caught and returned
 * in the result, not thrown), and a same-shaped multi-item runner so one
 * agent's failure can't stop the rest of an operator-supplied batch.
 */

// ─── Policy parsers ───────────────────────────────────────────────────────────
//
// Moved here from check-helpers.ts (ARD-1.1) now that the runtime no longer
// reads state/agent-policy.md; only the one-shot backfill still parses it.
// ARD-1.2 deletes them together with this module.

export function parseAllowSelfReview(content: string): boolean {
  const match = content.match(
    /`?\*{0,2}\ballow_self_review\b\*{0,2}`?\s*[:|]\s*\*{0,2}(true|false)\b/i,
  );
  return match?.[1] === "true"; // default false if missing/unparseable
}

/**
 * APM-1.1: parses the `auto_post_reviews` policy field, mirroring
 * `parseCleanupMergedWorktrees`'s default-true shape (rather than
 * `parseAllowSelfReview`'s default-false shape) — `true` is the documented
 * default in `state/agent-policy.md`, so any missing/unparseable value falls
 * back to `true`.
 */
export function parseAutoPostReviews(content: string): boolean {
  const match = content.match(
    /`?\*{0,2}\bauto_post_reviews\b\*{0,2}`?\s*[:|]\s*\*{0,2}(true|false)\b/i,
  );
  return match?.[1] !== "false"; // default true if missing
}

/**
 * APM-1.1: parses the `min_confidence` policy field, mirroring
 * `parseCleanupAfterDays`'s numeric-capture shape with a 75 default (the
 * documented default in `state/agent-policy.md`).
 */
export function parseMinConfidence(content: string): number {
  const match = content.match(
    /`?\*{0,2}\bmin_confidence\b\*{0,2}`?\s*[:|]\s*\*{0,2}(\d+)\b/i,
  );
  if (!match) return 75; // default 75 if missing
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? 75 : parsed;
}

/**
 * APM-1.1: parses the `max_findings` policy field, mirroring
 * `parseCleanupAfterDays`'s numeric-capture shape with a 5 default (the
 * documented default in `state/agent-policy.md`).
 */
export function parseMaxFindings(content: string): number {
  const match = content.match(
    /`?\*{0,2}\bmax_findings\b\*{0,2}`?\s*[:|]\s*\*{0,2}(\d+)\b/i,
  );
  if (!match) return 5; // default 5 if missing
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? 5 : parsed;
}

export function parseCleanupMergedWorktrees(content: string): boolean {
  const match = content.match(
    /`?\*{0,2}\bcleanup_merged_worktrees\b\*{0,2}`?\s*[:|]\s*\*{0,2}(true|false)\b/i,
  );
  return match?.[1] !== "false"; // default true if missing
}

export function parseCleanupAfterDays(content: string): number {
  const match = content.match(
    /`?\*{0,2}\bcleanup_after_days\b\*{0,2}`?\s*[:|]\s*\*{0,2}(\d+)\b/i,
  );
  if (!match) return 14; // default 14 if missing
  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? 14 : parsed;
}

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
   * never throws — each underlying parser falls back to its
   * own documented default on a missing/unparseable field). Reported even
   * when `error` is set, so an operator can see what *would* have been
   * written had the DB write not failed.
   */
  fields: AgentPolicyFields;
  error: string | null;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Composes the 6 policy parsers above against one
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
