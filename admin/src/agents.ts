/**
 * agent/src/agents.ts
 * AgentService — CRUD/read access to the Agent model.
 *
 * Mirrors the sibling *Service modules (AgentEnvService, AgentTokenService,
 * etc.) so route handlers never call prisma.agent.* directly.
 */

import type { PrismaClient } from "../prisma/client/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateAgentInput {
  name: string;
  slackId?: string | null;
  selfHosted?: boolean;
}

export interface AgentRecord {
  id: string;
  name: string;
  slackId: string | null;
  selfHosted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentSummary {
  id: string;
  name: string;
  selfHosted: boolean;
}

export interface AgentDetail {
  id: string;
  name: string;
  slackId: string | null;
  selfHosted: boolean;
  repos: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateSelfHostedInput {
  /**
   * Optional to mirror Prisma's generated AgentUpdateInput shape (undefined
   * means "leave unchanged"); callers such as PATCH /agents/:id currently
   * always pass a value since selfHosted is treated as required at the route
   * level, but the type stays permissive to match the underlying data layer.
   */
  selfHosted?: boolean;
  repos?: string[];
}

export interface AgentIdAndRepos {
  id: string;
  repos: string[];
}

// ─── Select shapes ────────────────────────────────────────────────────────────

const SUMMARY_SELECT = { id: true, name: true, selfHosted: true } as const;

const DETAIL_SELECT = {
  id: true,
  name: true,
  slackId: true,
  selfHosted: true,
  repos: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ─── Service ──────────────────────────────────────────────────────────────────

export class AgentService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create a new agent row.
   */
  async create(input: CreateAgentInput): Promise<AgentRecord> {
    return this.prisma.agent.create({
      data: {
        name: input.name,
        slackId: input.slackId ?? null,
        selfHosted: input.selfHosted ?? false,
      },
    });
  }

  /**
   * Delete an agent row by id. Used as the provisioning-failure rollback path
   * on create(), and (out of scope here) internally by deleteAgentFully().
   */
  async delete(id: string): Promise<void> {
    await this.prisma.agent.delete({ where: { id } });
  }

  /**
   * List all agents (id + name + selfHosted), ordered by name asc.
   */
  async list(): Promise<AgentSummary[]> {
    return this.prisma.agent.findMany({
      select: SUMMARY_SELECT,
      orderBy: { name: "asc" },
    });
  }

  /**
   * Get {id, name, selfHosted} for a single agent. Returns null if not found.
   */
  async getSummary(id: string): Promise<AgentSummary | null> {
    return this.prisma.agent.findUnique({
      where: { id },
      select: SUMMARY_SELECT,
    });
  }

  /**
   * Get the full agent record (incl. repos/timestamps). Returns null if not found.
   */
  async getDetail(id: string): Promise<AgentDetail | null> {
    return this.prisma.agent.findUnique({
      where: { id },
      select: DETAIL_SELECT,
    });
  }

  /**
   * Returns whether an agent with the given id exists.
   */
  async exists(id: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      select: { id: true },
    });
    return agent !== null;
  }

  /**
   * Update selfHosted (and optionally repos) for an agent. Returns the full
   * updated record.
   */
  async updateSelfHosted(
    id: string,
    input: UpdateSelfHostedInput,
  ): Promise<AgentDetail> {
    return this.prisma.agent.update({
      where: { id },
      data: {
        selfHosted: input.selfHosted,
        ...(input.repos !== undefined ? { repos: input.repos } : {}),
      },
      select: DETAIL_SELECT,
    });
  }

  /**
   * Get {id, repos} for a single agent — used by the runtime config/crons
   * routes. Returns null if not found.
   */
  async getById(id: string): Promise<AgentIdAndRepos | null> {
    return this.prisma.agent.findUnique({
      where: { id },
      select: { id: true, repos: true },
    });
  }
}
