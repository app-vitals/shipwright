/**
 * admin/src/coding/shipwright-loop-jobs.ts
 * Looks up agents' `shipwright-loop` cron rows — the coding loop's system
 * cron — for the merged fleet-wide Queue & Activity view. Moved out of
 * agent-cron-jobs.ts (AEP-3.2), which stays name-agnostic.
 */

import type { AgentCronJob, PrismaClient } from "../../prisma/client/client.ts";

export class ShipwrightLoopJobService {
  constructor(private readonly prisma: Pick<PrismaClient, "agentCronJob">) {}

  /**
   * Returns the `shipwright-loop` cron row for each of the given agents in
   * a single query — one row per agent that has one (an agent with no
   * shipwright-loop cron simply has no entry in the result). Used by the
   * merged fleet-wide queue-activity view to compute each agent's real
   * loopEnabled value (QAE-1.2) without an N+1 per-agent lookup.
   */
  async listShipwrightLoopJobs(agentIds: string[]): Promise<AgentCronJob[]> {
    if (agentIds.length === 0) return [];
    return this.prisma.agentCronJob.findMany({
      where: { agentId: { in: agentIds }, name: "shipwright-loop" },
    });
  }
}
