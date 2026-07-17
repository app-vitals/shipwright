/**
 * agent/src/agent-work-queue.ts
 * AgentWorkQueueService — push/read for an agent's latest work-queue snapshot.
 *
 * One row per agent (AgentWorkQueueSnapshot.agentId is @unique). push()
 * upserts the single row for that agent, overwriting any prior snapshot —
 * there is no history, only the latest state.
 */

import type {
  AgentWorkQueueSnapshot,
  PrismaClient,
} from "../prisma/client/index.js";

export type { AgentWorkQueueSnapshot };

export interface PushWorkQueueSnapshotInput {
  computedAt: Date;
  items: unknown;
}

export class AgentWorkQueueService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Upsert the single work-queue snapshot row for the given agent, overwriting
   * any prior snapshot.
   */
  async push(
    agentId: string,
    input: PushWorkQueueSnapshotInput,
  ): Promise<AgentWorkQueueSnapshot> {
    return this.prisma.agentWorkQueueSnapshot.upsert({
      where: { agentId },
      create: {
        agentId,
        computedAt: input.computedAt,
        items: input.items as never,
      },
      update: {
        computedAt: input.computedAt,
        items: input.items as never,
      },
    });
  }

  /**
   * Get the latest work-queue snapshot for the given agent, or null if the
   * agent has never pushed one.
   */
  async get(agentId: string): Promise<AgentWorkQueueSnapshot | null> {
    return this.prisma.agentWorkQueueSnapshot.findUnique({
      where: { agentId },
    });
  }
}
