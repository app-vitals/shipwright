/**
 * agent/src/agent-tools.ts
 * AgentToolService — CRUD for allowed tool patterns per agent.
 *
 * Each pattern grants an agent permission to use a specific tool (e.g. "Read",
 * "Bash", "Write"). The unique constraint on [agentId, pattern] prevents
 * duplicates; add() uses upsert so it re-enables a previously disabled pattern.
 */

import type { AgentTool, PrismaClient } from "../prisma/client/index.js";
import { NotFoundError } from "./errors.ts";

export type { AgentTool };

export class AgentToolService {
  constructor(private prisma: PrismaClient) {}

  /**
   * List all tool patterns for a given agent, ordered by createdAt.
   */
  async list(agentId: string): Promise<AgentTool[]> {
    return this.prisma.agentTool.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Add a tool pattern for the given agent.
   * Uses upsert so re-adding a disabled pattern re-enables it.
   */
  async add(agentId: string, pattern: string): Promise<AgentTool> {
    return this.prisma.agentTool.upsert({
      where: { agentId_pattern: { agentId, pattern } },
      create: { agentId, pattern, enabled: true },
      update: { enabled: true },
    });
  }

  /**
   * Delete a tool pattern. Verifies agentId ownership before deleting.
   * Throws NotFoundError if the toolId doesn't exist or belongs to a different agent.
   */
  async remove(agentId: string, toolId: string): Promise<void> {
    const existing = await this.prisma.agentTool.findUnique({
      where: { id: toolId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`tool ${toolId} not found`);
    }

    await this.prisma.agentTool.delete({ where: { id: toolId } });
  }

  /**
   * Enable or disable a tool pattern.
   * Throws NotFoundError if the toolId doesn't exist or belongs to a different agent.
   */
  async toggle(
    agentId: string,
    toolId: string,
    enabled: boolean,
  ): Promise<AgentTool> {
    const existing = await this.prisma.agentTool.findUnique({
      where: { id: toolId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`tool ${toolId} not found`);
    }

    return this.prisma.agentTool.update({
      where: { id: toolId },
      data: { enabled },
    });
  }

  /**
   * Update the pattern string for a tool.
   * Verifies agentId ownership before updating.
   * Throws NotFoundError if the toolId doesn't exist or belongs to a different agent.
   */
  async updatePattern(
    agentId: string,
    toolId: string,
    pattern: string,
  ): Promise<AgentTool> {
    const existing = await this.prisma.agentTool.findUnique({
      where: { id: toolId },
    });

    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`tool ${toolId} not found`);
    }

    return this.prisma.agentTool.update({
      where: { id: toolId },
      data: { pattern },
    });
  }
}
