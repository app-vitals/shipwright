/**
 * admin/src/agent-cron-runs.ts
 * AgentCronRunService — create and list AgentCronRun records.
 *
 * Each run records one cron invocation: whether it was skipped (pre-check
 * returned false), the outcome, and any error.
 */

import type {
  AgentCronRun,
  Prisma,
  PrismaClient,
} from "../prisma/client/index.js";
import { NotFoundError } from "./errors.ts";

export type { AgentCronRun };

/** An AgentCronRun with its per-model token/cost breakdown rows attached. */
export type AgentCronRunWithModelBreakdown = Prisma.AgentCronRunGetPayload<{
  include: { modelBreakdown: true };
}>;

/**
 * An AgentCronRun with its per-model token/cost breakdown rows and its
 * owning cron's id/name/schedule attached — used by cross-cron listings
 * (e.g. listForAgent) so callers don't need N+1 cron lookups.
 */
export type AgentCronRunWithCron = Prisma.AgentCronRunGetPayload<{
  include: {
    modelBreakdown: true;
    cron: { select: { id: true; name: true; schedule: true } };
  };
}>;

export interface CreateAgentCronRunInput {
  startedAt: Date;
  completedAt?: Date | null;
  skipped?: boolean;
  skipReason?: string | null;
  outcome?: string | null;
  error?: string | null;
  /** Pipeline phase this run served (dev-task/review/patch/deploy). Null for legacy five-job crons. */
  phase?: string | null;
}

export interface ModelBreakdownEntry {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
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
  modelBreakdown?: ModelBreakdownEntry[];
}

export interface ListAgentCronRunsOptions {
  limit?: number;
  offset?: number;
}

export interface AgentCronRunList {
  items: AgentCronRunWithModelBreakdown[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListForAgentOptions {
  /** Narrow to a single cron. Still scoped to agentId — a cronId belonging
   * to a different agent yields an empty result, not an error. */
  cronId?: string;
  /**
   * "skipped" filters WHERE skipped = true regardless of the outcome column
   * (mirrors the cronRunOutcomeLabel display convention: skipped is a
   * boolean flag, not an outcome column value). Any other value filters
   * WHERE skipped = false AND outcome = value. Omitted means no filter.
   */
  outcome?: string;
  limit?: number;
  offset?: number;
}

export interface AgentCronRunListForAgent {
  items: AgentCronRunWithCron[];
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
        phase: input.phase ?? null,
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
  ): Promise<AgentCronRunWithModelBreakdown> {
    const run = await this.prisma.agentCronRun.findUnique({
      where: { id: runId },
    });
    if (!run || run.agentId !== agentId) {
      throw new NotFoundError(`cron run ${runId} not found`);
    }
    if (run.cronId !== cronId) {
      throw new NotFoundError(`cron run ${runId} not found`);
    }

    // The top-level token fields (inputTokens/outputTokens/…) are still accepted
    // on the input for backward compatibility with older agent builds, but they
    // are no longer persisted: those columns were dropped and all token
    // accounting now flows through AgentCronRunModelBreakdown (see modelBreakdown
    // below). We simply ignore them here.
    // TODO(CTT-cleanup): remove top-level token field acceptance once all agent
    // builds send modelBreakdown only (see agent/src/cron-handler.ts's
    // buildTokenPayload()).
    const runData = {
      ...(input.completedAt !== undefined && {
        completedAt: input.completedAt,
      }),
      ...(input.outcome !== undefined && { outcome: input.outcome }),
      ...(input.error !== undefined && { error: input.error }),
      ...(input.skipped !== undefined && { skipped: input.skipped }),
      ...(input.skipReason !== undefined && { skipReason: input.skipReason }),
    };

    if (input.modelBreakdown && input.modelBreakdown.length > 0) {
      // Wrap the run update and all breakdown upserts in a single transaction
      // so the two writes are atomic — partial breakdown rows are never visible.
      // The run update (with its modelBreakdown include) must be the LAST
      // statement in the array: Prisma's array-form $transaction issues
      // statements in order, so an earlier include would return breakdown
      // rows as they stood before this call's upserts ran.
      const results = await this.prisma.$transaction([
        ...input.modelBreakdown.map((entry) =>
          this.prisma.agentCronRunModelBreakdown.upsert({
            where: {
              cronRunId_model: { cronRunId: runId, model: entry.model },
            },
            create: {
              cronRunId: runId,
              model: entry.model,
              inputTokens: entry.inputTokens,
              outputTokens: entry.outputTokens,
              cacheReadTokens: entry.cacheReadTokens,
              cacheCreationTokens: entry.cacheCreationTokens,
              costUsd: entry.costUsd,
            },
            update: {
              inputTokens: entry.inputTokens,
              outputTokens: entry.outputTokens,
              cacheReadTokens: entry.cacheReadTokens,
              cacheCreationTokens: entry.cacheCreationTokens,
              costUsd: entry.costUsd,
            },
          }),
        ),
        this.prisma.agentCronRun.update({
          where: { id: runId },
          data: runData,
          include: { modelBreakdown: true },
        }),
      ]);
      const updatedRun = results[
        input.modelBreakdown.length
      ] as AgentCronRunWithModelBreakdown;
      return updatedRun;
    }

    return this.prisma.agentCronRun.update({
      where: { id: runId },
      data: runData,
      include: { modelBreakdown: true },
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
        include: { modelBreakdown: true },
      }),
      this.prisma.agentCronRun.count({
        where: { cronId, agentId },
      }),
    ]);

    return { items, total, limit, offset };
  }

  /**
   * List all runs for an agent across every cron it owns, sorted descending
   * by startedAt. Unlike `.list()`, this method is agent-scoped by
   * construction and does not validate a specific cronId's ownership — if
   * opts.cronId is given but belongs to a different agent, the WHERE clause
   * (agentId AND cronId) simply matches no rows.
   * Defaults to limit=20, offset=0.
   */
  async listForAgent(
    agentId: string,
    opts?: ListForAgentOptions,
  ): Promise<AgentCronRunListForAgent> {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;

    const where: Prisma.AgentCronRunWhereInput = { agentId };
    if (opts?.cronId) {
      where.cronId = opts.cronId;
    }
    if (opts?.outcome === "skipped") {
      where.skipped = true;
    } else if (opts?.outcome !== undefined) {
      where.skipped = false;
      where.outcome = opts.outcome;
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.agentCronRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          modelBreakdown: true,
          cron: { select: { id: true, name: true, schedule: true } },
        },
      }),
      this.prisma.agentCronRun.count({ where }),
    ]);

    return { items, total, limit, offset };
  }
}
