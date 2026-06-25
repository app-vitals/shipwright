/**
 * admin/src/agent-cron-runs.ts
 * AgentCronRunService — create and list AgentCronRun records.
 *
 * Each run records one cron invocation: whether it was skipped (pre-check
 * returned false), the outcome, and any error.
 */

import type { AgentCronRun, PrismaClient } from "../prisma/client/index.js";
import { NotFoundError } from "./errors.ts";

export type { AgentCronRun };

export interface CreateAgentCronRunInput {
  startedAt: Date;
  completedAt?: Date | null;
  skipped?: boolean;
  skipReason?: string | null;
  outcome?: string | null;
  error?: string | null;
}

export interface ListAgentCronRunsOptions {
  limit?: number;
  offset?: number;
}

export interface AgentCronRunList {
  items: AgentCronRun[];
  total: number;
  limit: number;
  offset: number;
}

export class AgentCronRunService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Create a new run record for a cron job.
   * Validates that the cronId exists and belongs to agentId.
   * Throws NotFoundError if the cronId doesn't exist or is not owned by agentId.
   */
  async create(
    cronId: string,
    agentId: string,
    input: CreateAgentCronRunInput,
  ): Promise<AgentCronRun> {
    // Validate ownership
    const job = await this.prisma.agentCronJob.findUnique({
      where: { id: cronId },
    });
    if (!job || job.agentId !== agentId) {
      throw new NotFoundError(`cron job ${cronId} not found`);
    }

    return this.prisma.agentCronRun.create({
      data: {
        cronId,
        agentId,
        startedAt: input.startedAt,
        completedAt: input.completedAt ?? null,
        skipped: input.skipped ?? false,
        skipReason: input.skipReason ?? null,
        outcome: input.outcome ?? null,
        error: input.error ?? null,
      },
    });
  }

  /**
   * List all runs for a cron job, sorted descending by startedAt.
   * Validates that the cronId exists and belongs to agentId.
   * Throws NotFoundError if the cronId doesn't exist or is not owned by agentId.
   * Defaults to limit=20, offset=0.
   */
  async list(
    cronId: string,
    agentId: string,
    opts?: ListAgentCronRunsOptions,
  ): Promise<AgentCronRunList> {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;

    // Validate ownership
    const job = await this.prisma.agentCronJob.findUnique({
      where: { id: cronId },
    });
    if (!job || job.agentId !== agentId) {
      throw new NotFoundError(`cron job ${cronId} not found`);
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.agentCronRun.findMany({
        where: { cronId, agentId },
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.agentCronRun.count({
        where: { cronId, agentId },
      }),
    ]);

    return { items, total, limit, offset };
  }
}
