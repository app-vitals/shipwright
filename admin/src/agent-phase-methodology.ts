/**
 * agent/src/agent-phase-methodology.ts
 * AgentPhaseMethodologyService — CRUD for per-phase subagent-type overrides.
 *
 * Each row records which subagent type (e.g. a custom Agent Type name) should
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

import type {
  AgentPhaseMethodology,
  PrismaClient,
} from "../prisma/client/client.ts";
import type { PrismaTransactionClient } from "./prisma-tx.ts";

export type { AgentPhaseMethodology };

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
   * Passing `subagentType: null` clears the override — the row is kept with
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
    return client.agentPhaseMethodology.upsert({
      where: { agentId_phase: { agentId, phase } },
      create: { agentId, phase, subagentType },
      update: { subagentType },
    });
  }
}
