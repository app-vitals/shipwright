/**
 * admin/src/agent-github-installations.ts
 * AgentGitHubInstallationsService — push/read for an agent's latest reported
 * GitHub App installations.
 *
 * One row per agent (AgentGitHubInstallationsSnapshot.agentId is @unique).
 * push() upserts the single row, replacing the installations list wholesale —
 * an installation absent from the latest push is gone.
 */

import type {
  AgentGitHubInstallationsSnapshot,
  Prisma,
  PrismaClient,
} from "../prisma/client/client.ts";

export type { AgentGitHubInstallationsSnapshot };

export interface PushGitHubInstallationsInput {
  reportedAt: Date;
  installations: Prisma.InputJsonValue;
}

export class AgentGitHubInstallationsService {
  constructor(private prisma: PrismaClient) {}

  /** Upsert the single snapshot row for the agent (replace-all). */
  async push(
    agentId: string,
    input: PushGitHubInstallationsInput,
  ): Promise<AgentGitHubInstallationsSnapshot> {
    return this.prisma.agentGitHubInstallationsSnapshot.upsert({
      where: { agentId },
      create: {
        agentId,
        reportedAt: input.reportedAt,
        installations: input.installations,
      },
      update: {
        reportedAt: input.reportedAt,
        installations: input.installations,
      },
    });
  }

  /** Latest snapshot for the agent, or null if never reported. */
  async get(agentId: string): Promise<AgentGitHubInstallationsSnapshot | null> {
    return this.prisma.agentGitHubInstallationsSnapshot.findUnique({
      where: { agentId },
    });
  }
}
