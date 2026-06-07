/**
 * agent/src/agent-plugins.ts
 * AgentPluginService — CRUD for Claude Code plugins per agent.
 *
 * Each plugin is identified by its package name (e.g. "@shipwright/plugin").
 * The unique constraint on [agentId, name] prevents duplicates; add() uses
 * upsert so re-adding an existing plugin updates its version and re-enables it.
 */

import type { PrismaClient } from "../prisma/client/index.js";
import { NotFoundError } from "./errors.ts";

export interface AgentPlugin {
  id: string;
  agentId: string;
  name: string;
  version: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class AgentPluginService {
  constructor(private prisma: PrismaClient) {}

  /**
   * List all plugins for a given agent, ordered by createdAt.
   */
  async list(agentId: string): Promise<AgentPlugin[]> {
    return this.prisma.agentPlugin.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Add a plugin for the given agent.
   * Uses upsert so re-adding an existing plugin updates its version and re-enables it.
   */
  async add(
    agentId: string,
    name: string,
    version?: string | null,
  ): Promise<AgentPlugin> {
    return this.prisma.agentPlugin.upsert({
      where: { agentId_name: { agentId, name } },
      create: { agentId, name, version: version ?? null, enabled: true },
      update: { version: version ?? null, enabled: true },
    });
  }

  /**
   * Remove a plugin. Verifies agentId ownership before deleting.
   * Throws NotFoundError if the pluginId doesn't exist or belongs to a different agent.
   */
  async remove(agentId: string, pluginId: string): Promise<void> {
    const existing = await this.prisma.agentPlugin.findUnique({
      where: { id: pluginId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`plugin ${pluginId} not found`);
    }

    await this.prisma.agentPlugin.delete({ where: { id: pluginId } });
  }
}
