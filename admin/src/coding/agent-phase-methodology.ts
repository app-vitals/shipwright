/**
 * agent/src/agent-phase-methodology.ts
 * AgentPhaseMethodologyService — CRUD for per-phase subagent-type overrides.
 *
 * Each row records which subagent type (e.g. a custom Specialty name) should
 * handle one pipeline phase — prd, plan-session, review, patch, deploy, or
 * dev-task — for a given agent, overriding that phase's default methodology.
 * A row with `subagentType: null` (or the absence of a row) means "use the
 * default". The unique constraint on [agentId, phase] makes upsert()
 * idempotent — one override row per phase per agent — mirroring
 * AgentToolService.add() and AgentPluginService.add()'s upsert pattern.
 *
 * The six valid phase values are enforced by the caller (agents-api.ts's Zod
 * `PhaseParamSchema`) — this service accepts any string, mirroring how
 * AgentTool's `pattern` field is unconstrained at the service/DB layer.
 */

import { BadRequestError } from "@app-vitals/agent-admin/errors";
import type {
  AgentPhaseMethodology,
  PrismaClient,
} from "@app-vitals/agent-admin/prisma/client/client.ts";
import type { PrismaTransactionClient } from "@app-vitals/agent-admin/prisma-tx";

export type { AgentPhaseMethodology };

/** Phase that accepts a comma-separated list of subagent types. */
export const MULTI_SUBAGENT_PHASE = "review";
/** Maximum entries in a comma-separated subagent list (after de-duplication). */
export const MAX_SUBAGENTS = 5;

/**
 * Normalize a `subagentType` value for a phase. `null` and single values
 * (no comma) pass through unchanged. A comma-separated list is accepted only
 * for the `review` phase: entries are trimmed, duplicates dropped (first
 * occurrence wins), empty entries rejected, and the result capped at
 * MAX_SUBAGENTS. Throws BadRequestError on violation.
 */
export function normalizeSubagentList(
  phase: string,
  subagentType: string | null,
): string | null {
  if (subagentType === null || !subagentType.includes(",")) {
    return subagentType;
  }
  if (phase !== MULTI_SUBAGENT_PHASE) {
    throw new BadRequestError(
      `subagentType may be a comma-separated list only for the ${MULTI_SUBAGENT_PHASE} phase`,
    );
  }
  const entries = subagentType.split(",").map((e) => e.trim());
  if (entries.some((e) => e === "")) {
    throw new BadRequestError(
      "subagentType list must not contain empty entries",
    );
  }
  const unique = [...new Set(entries)];
  if (unique.length > MAX_SUBAGENTS) {
    throw new BadRequestError(
      `subagentType list may contain at most ${MAX_SUBAGENTS} entries`,
    );
  }
  return unique.join(",");
}

export class AgentPhaseMethodologyService {
  constructor(private prisma: PrismaClient) {}

  /**
   * List all phase-methodology overrides for a given agent, ordered by phase.
   */
  async list(agentId: string): Promise<AgentPhaseMethodology[]> {
    return this.prisma.agentPhaseMethodology.findMany({
      where: { agentId },
      orderBy: { phase: "asc" },
    });
  }

  /**
   * Upsert the subagentType override for one phase.
   * `subagentType` may be a comma-separated list (max 5) for the `review`
   * phase only — see normalizeSubagentList(). Passing `null` clears the override — the row is kept with
   * a null value (rather than deleted), mirroring AgentPluginService.add()'s
   * `version: null` "use the default" convention.
   *
   * @param client - defaults to `this.prisma`; pass the `tx` argument from a
   *   caller's `prisma.$transaction(async (tx) => ...)` to make this write
   *   participate in that transaction.
   */
  async upsert(
    agentId: string,
    phase: string,
    subagentType: string | null,
    client: PrismaTransactionClient = this.prisma,
  ): Promise<AgentPhaseMethodology> {
    const normalized = normalizeSubagentList(phase, subagentType);
    return client.agentPhaseMethodology.upsert({
      where: { agentId_phase: { agentId, phase } },
      create: { agentId, phase, subagentType: normalized },
      update: { subagentType: normalized },
    });
  }
}
