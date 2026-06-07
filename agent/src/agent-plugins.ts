/**
 * agent/src/agent-plugins.ts
 * AgentPluginService — CRUD for Claude Code plugins per agent.
 *
 * Each plugin is identified by its package name (e.g. "@shipwright/plugin").
 * The unique constraint on [agentId, name] prevents duplicates; add() uses
 * upsert so re-adding an existing plugin updates its version and re-enables it.
 */

import type { AgentPlugin, PrismaClient } from "../prisma/client/index.js";
import { NotFoundError } from "./errors.ts";

export type { AgentPlugin };

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
   * Update a plugin's version or enabled state.
   * Throws NotFoundError if the pluginId doesn't exist or belongs to a different agent.
   */
  async update(
    agentId: string,
    pluginId: string,
    fields: { version?: string | null; enabled?: boolean },
  ): Promise<AgentPlugin> {
    const existing = await this.prisma.agentPlugin.findUnique({
      where: { id: pluginId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`plugin ${pluginId} not found`);
    }

    return this.prisma.agentPlugin.update({
      where: { id: pluginId },
      data: fields,
    });
  }

  /**
   * Remove a plugin by ID. Verifies agentId ownership before deleting.
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

  /**
   * Remove a plugin by name. Verifies agentId ownership before deleting.
   * Throws NotFoundError if no plugin with that name exists for the agent.
   */
  async removeByName(agentId: string, name: string): Promise<void> {
    const existing = await this.prisma.agentPlugin.findUnique({
      where: { agentId_name: { agentId, name } },
    });

    if (!existing) {
      throw new NotFoundError(`plugin ${name} not found`);
    }

    await this.prisma.agentPlugin.delete({ where: { id: existing.id } });
  }
}
