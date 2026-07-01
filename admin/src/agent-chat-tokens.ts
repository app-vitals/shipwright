/**
 * admin/src/agent-chat-tokens.ts
 * AgentChatTokenService — daily rollup for Slack/chat session token usage per model.
 *
 * upsertDailyByModel() uses a single atomic SQL INSERT ... ON CONFLICT ... DO UPDATE
 * so concurrent callers accumulate tokens without any read-modify-write race.
 *
 * queryStats() aggregates AgentChatTokenUsageDailyByModel into four dimensions:
 * totals, byAgent, byModel (key1=agentId, key2=model), and daily.
 * Totals and byAgent are computed by summing across model rows.
 */

import { randomBytes } from "node:crypto";
import type {
  AgentChatTokenUsageDailyByModel,
  PrismaClient,
} from "../prisma/client/index.js";
import { NotFoundError } from "./errors.ts";

export type { AgentChatTokenUsageDailyByModel };

// ─── Stats types (mirrored from metrics/src/lib/admin-metrics-client.ts) ─────
// These types are defined here to keep admin self-contained (rootDir constraint).
// The shapes must stay in sync with ChatTokenStats in admin-metrics-client.ts.

export interface TokenAggregate {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
  costUsd?: number;
}

export interface KeyedTokenAggregate extends TokenAggregate {
  key: string;
}

export interface DoubleKeyedTokenAggregate extends TokenAggregate {
  key1: string;
  key2: string;
}

export interface DailyTokenAggregate extends TokenAggregate {
  period: string;
}

export interface ChatTokenStats {
  totals: TokenAggregate;
  byAgent: KeyedTokenAggregate[];
  byModel: DoubleKeyedTokenAggregate[];
  daily: DailyTokenAggregate[];
}

export interface DailyTokenInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export class AgentChatTokenService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Atomically upsert daily token usage for an agent per model.
   *
   * On first call for a given (agentId, date, model) tuple: inserts a new row.
   * On subsequent calls: increments each field with the provided values.
   *
   * Uses a raw SQL INSERT ... ON CONFLICT ... DO UPDATE so that concurrent
   * callers accumulate tokens without a read-modify-write race.
   *
   * Throws NotFoundError when the agentId does not reference an existing agent.
   */
  async upsertDailyByModel(
    agentId: string,
    date: string,
    model: string,
    tokens: DailyTokenInput,
  ): Promise<AgentChatTokenUsageDailyByModel> {
    // Check agent existence upfront to surface a clean 404.
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });
    if (!agent) {
      throw new NotFoundError(`agent ${agentId} not found`);
    }

    const newId = randomBytes(12).toString("base64url");

    // Atomic upsert: INSERT on first call, accumulate on conflict.
    // Using $queryRaw with RETURNING so we get the updated row back in one round-trip.
    const rows = await this.prisma.$queryRaw<AgentChatTokenUsageDailyByModel[]>`
      INSERT INTO "AgentChatTokenUsageDailyByModel"
        (id, "agentId", date, model, "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd", "createdAt", "updatedAt")
      VALUES
        (${newId}, ${agentId}, ${date}, ${model}, ${tokens.inputTokens}, ${tokens.outputTokens}, ${tokens.cacheReadTokens}, ${tokens.cacheCreationTokens}, ${tokens.costUsd}, now(), now())
      ON CONFLICT ("agentId", date, model) DO UPDATE SET
        "inputTokens"         = "AgentChatTokenUsageDailyByModel"."inputTokens"         + EXCLUDED."inputTokens",
        "outputTokens"        = "AgentChatTokenUsageDailyByModel"."outputTokens"        + EXCLUDED."outputTokens",
        "cacheReadTokens"     = "AgentChatTokenUsageDailyByModel"."cacheReadTokens"     + EXCLUDED."cacheReadTokens",
        "cacheCreationTokens" = "AgentChatTokenUsageDailyByModel"."cacheCreationTokens" + EXCLUDED."cacheCreationTokens",
        "costUsd"             = "AgentChatTokenUsageDailyByModel"."costUsd"             + EXCLUDED."costUsd",
        "updatedAt"           = now()
      RETURNING *
    `;

    return rows[0];
  }

  /**
   * Aggregate daily chat token usage into four dimensions.
   *
   * Totals, byAgent, and daily are computed by summing across model rows.
   * byModel groups by (agentId, model) — key1=agentId, key2=model.
   *
   * @param from  YYYY-MM-DD — if provided, only rows with date >= from
   * @param to    YYYY-MM-DD — if provided, only rows with date <= to
   */
  async queryStats(from?: string, to?: string): Promise<ChatTokenStats> {
    const dateFilter = this.buildDateFilter(from, to);

    const [aggregateResult, byAgentRows, byModelRows, dailyRows] =
      await Promise.all([
        this.prisma.agentChatTokenUsageDailyByModel.aggregate({
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: true,
            costUsd: true,
          },
          where: dateFilter,
        }),
        this.prisma.agentChatTokenUsageDailyByModel.groupBy({
          by: ["agentId"],
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: true,
            costUsd: true,
          },
          where: dateFilter,
          orderBy: { agentId: "asc" },
        }),
        this.prisma.agentChatTokenUsageDailyByModel.groupBy({
          by: ["agentId", "model"],
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: true,
            costUsd: true,
          },
          where: dateFilter,
          orderBy: [{ agentId: "asc" }, { model: "asc" }],
        }),
        this.prisma.agentChatTokenUsageDailyByModel.groupBy({
          by: ["date"],
          _sum: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: true,
            costUsd: true,
          },
          where: dateFilter,
          orderBy: { date: "asc" },
        }),
      ]);

    const totals = this.toAggregate(aggregateResult._sum);

    const byAgent: KeyedTokenAggregate[] = byAgentRows.map((row) => ({
      ...this.toAggregate(row._sum),
      key: row.agentId,
    }));

    const byModel: DoubleKeyedTokenAggregate[] = byModelRows.map((row) => ({
      ...this.toAggregate(row._sum),
      key1: row.agentId,
      key2: row.model,
    }));

    const daily: DailyTokenAggregate[] = dailyRows.map((row) => ({
      ...this.toAggregate(row._sum),
      period: row.date,
    }));

    return { totals, byAgent, byModel, daily };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildDateFilter(
    from?: string,
    to?: string,
  ): { date?: { gte?: string; lte?: string } } {
    if (!from && !to) return {};
    const dateClause: { gte?: string; lte?: string } = {};
    if (from) dateClause.gte = from;
    if (to) dateClause.lte = to;
    return { date: dateClause };
  }

  private toAggregate(sum: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    costUsd?: number | null;
  }): TokenAggregate {
    const input = sum.inputTokens ?? 0;
    const output = sum.outputTokens ?? 0;
    const cacheRead = sum.cacheReadTokens ?? 0;
    const cacheCreation = sum.cacheCreationTokens ?? 0;
    const result: TokenAggregate = {
      input,
      output,
      cacheRead,
      cacheCreation,
      total: input + output + cacheRead + cacheCreation,
    };
    if (sum.costUsd !== null && sum.costUsd !== undefined) {
      result.costUsd = sum.costUsd;
    }
    return result;
  }
}
