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

export interface PatchAgentCronRunInput {
  completedAt?: Date | null;
  outcome?: string | null;
  error?: string | null;
  skipped?: boolean;
  skipReason?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
  model?: string | null;
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
   * Update an existing run record with completion data and/or token fields.
   * Validates that the runId exists, belongs to agentId, and belongs to cronId.
   * Throws NotFoundError if the run doesn't exist, is not owned by agentId, or
   * does not belong to the given cronId (prevents cross-cron access).
   */
  async patch(
    runId: string,
    agentId: string,
    cronId: string,
    input: PatchAgentCronRunInput,
  ): Promise<AgentCronRun> {
    const run = await this.prisma.agentCronRun.findUnique({
      where: { id: runId },
    });
    if (!run || run.agentId !== agentId) {
      throw new NotFoundError(`cron run ${runId} not found`);
    }
    if (run.cronId !== cronId) {
      throw new NotFoundError(`cron run ${runId} not found`);
    }

    return this.prisma.agentCronRun.update({
      where: { id: runId },
      data: {
        ...(input.completedAt !== undefined && {
          completedAt: input.completedAt,
        }),
        ...(input.outcome !== undefined && { outcome: input.outcome }),
        ...(input.error !== undefined && { error: input.error }),
        ...(input.skipped !== undefined && { skipped: input.skipped }),
        ...(input.skipReason !== undefined && { skipReason: input.skipReason }),
        ...(input.inputTokens !== undefined && {
          inputTokens: input.inputTokens,
        }),
        ...(input.outputTokens !== undefined && {
          outputTokens: input.outputTokens,
        }),
        ...(input.cacheReadTokens !== undefined && {
          cacheReadTokens: input.cacheReadTokens,
        }),
        ...(input.cacheCreationTokens !== undefined && {
          cacheCreationTokens: input.cacheCreationTokens,
        }),
        ...(input.costUsd !== undefined && { costUsd: input.costUsd }),
        ...(input.model !== undefined && { model: input.model }),
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
