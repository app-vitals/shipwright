/**
 * agent/src/agent-plugins.ts
 * AgentPluginService — CRUD for Claude Code plugins installed per agent.
 *
 * NOTE: This is a stub for SHE-3.1 compatibility. Full implementation ships in SHE-3.1.
 */

import type { AgentPlugin, PrismaClient } from "../prisma/client/index.js";

export type { AgentPlugin };

export class AgentPluginService {
  constructor(private prisma: PrismaClient) {}

  async list(agentId: string): Promise<AgentPlugin[]> {
    return this.prisma.agentPlugin.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
  }

  async add(
    agentId: string,
    name: string,
    version?: string | null,
  ): Promise<AgentPlugin> {
    return this.prisma.agentPlugin.upsert({
      where: { agentId_name: { agentId, name } },
      create: { agentId, name, version: version ?? null, enabled: true },
      update: { version: version ?? null },
    });
  }

  async remove(agentId: string, pluginId: string): Promise<void> {
    await this.prisma.agentPlugin.deleteMany({ where: { id: pluginId, agentId } });
  }

  async removeByName(agentId: string, name: string): Promise<void> {
    await this.prisma.agentPlugin.deleteMany({ where: { agentId, name } });
  }
}
