/**
 * admin/src/agent-chat-tokens.ts
 * AgentChatTokenService — daily rollup for Slack/chat session token usage.
 *
 * upsertDaily() uses a single atomic SQL INSERT ... ON CONFLICT ... DO UPDATE
 * so concurrent callers accumulate tokens without any read-modify-write race.
 */

import { randomBytes } from "node:crypto";
import type { AgentChatTokenUsageDaily, PrismaClient } from "../prisma/client/index.js";
import { NotFoundError } from "./errors.ts";

export type { AgentChatTokenUsageDaily };

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
   * Atomically upsert daily token usage for an agent.
   *
   * On first call for a given (agentId, date) pair: inserts a new row.
   * On subsequent calls: increments each field with the provided values.
   *
   * Uses a raw SQL INSERT ... ON CONFLICT ... DO UPDATE so that concurrent
   * callers accumulate tokens without a read-modify-write race.
   *
   * Throws NotFoundError when the agentId does not reference an existing agent.
   */
  async upsertDaily(
    agentId: string,
    date: string,
    tokens: DailyTokenInput,
  ): Promise<AgentChatTokenUsageDaily> {
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
    const rows = await this.prisma.$queryRaw<AgentChatTokenUsageDaily[]>`
      INSERT INTO "AgentChatTokenUsageDaily"
        (id, "agentId", date, "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "costUsd", "createdAt", "updatedAt")
      VALUES
        (${newId}, ${agentId}, ${date}, ${tokens.inputTokens}, ${tokens.outputTokens}, ${tokens.cacheReadTokens}, ${tokens.cacheCreationTokens}, ${tokens.costUsd}, now(), now())
      ON CONFLICT ("agentId", date) DO UPDATE SET
        "inputTokens"         = "AgentChatTokenUsageDaily"."inputTokens"         + EXCLUDED."inputTokens",
        "outputTokens"        = "AgentChatTokenUsageDaily"."outputTokens"        + EXCLUDED."outputTokens",
        "cacheReadTokens"     = "AgentChatTokenUsageDaily"."cacheReadTokens"     + EXCLUDED."cacheReadTokens",
        "cacheCreationTokens" = "AgentChatTokenUsageDaily"."cacheCreationTokens" + EXCLUDED."cacheCreationTokens",
        "costUsd"             = "AgentChatTokenUsageDaily"."costUsd"             + EXCLUDED."costUsd",
        "updatedAt"           = now()
      RETURNING *
    `;

    return rows[0];
  }
}
