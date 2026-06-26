/**
 * admin/src/agent-chat-tokens.integration.test.ts
 * Integration tests for AgentChatTokenService — upsertDaily.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentChatTokenService } from "./agent-chat-tokens.ts";
import { NotFoundError } from "./errors.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

async function createAgent(
  prisma: PrismaClient,
  name = "Test Agent",
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name } });
  return agent.id;
}

describeOrSkip("AgentChatTokenService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentChatTokenService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentChatTokenUsageDaily.deleteMany();
    await prisma.agentCronRun.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentChatTokenService(prisma);
  });

  // ─── upsertDaily: create ────────────────────────────────────────────────────

  it("upsertDaily() creates a new record for a fresh (agentId, date) pair", async () => {
    const agentId = await createAgent(prisma);
    const date = "2026-01-15";

    const row = await service.upsertDaily(agentId, date, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      costUsd: 0.0012,
    });

    expect(row.agentId).toBe(agentId);
    expect(row.date).toBe(date);
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(50);
    expect(row.cacheReadTokens).toBe(10);
    expect(row.cacheCreationTokens).toBe(5);
    expect(row.costUsd).toBeCloseTo(0.0012);
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  // ─── upsertDaily: accumulate ─────────────────────────────────────────────────

  it("upsertDaily() with same agentId+date accumulates totals (does not overwrite)", async () => {
    const agentId = await createAgent(prisma);
    const date = "2026-01-15";

    await service.upsertDaily(agentId, date, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      costUsd: 0.001,
    });

    const row = await service.upsertDaily(agentId, date, {
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      costUsd: 0.002,
    });

    expect(row.inputTokens).toBe(300);
    expect(row.outputTokens).toBe(150);
    expect(row.cacheReadTokens).toBe(30);
    expect(row.cacheCreationTokens).toBe(15);
    expect(row.costUsd).toBeCloseTo(0.003);
  });

  // ─── upsertDaily: concurrent ─────────────────────────────────────────────────

  it("two concurrent upsertDaily() calls for same (agentId, date) accumulate atomically", async () => {
    const agentId = await createAgent(prisma);
    const date = "2026-06-25";

    const tokens1 = {
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 25,
      costUsd: 0.0025,
    };
    const tokens2 = {
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 30,
      cacheCreationTokens: 15,
      costUsd: 0.0015,
    };

    // Run both concurrently
    await Promise.all([
      service.upsertDaily(agentId, date, tokens1),
      service.upsertDaily(agentId, date, tokens2),
    ]);

    // Fetch the final row from DB directly
    const final = await prisma.agentChatTokenUsageDaily.findUnique({
      where: { agentId_date: { agentId, date } },
    });

    expect(final).not.toBeNull();
    expect(final?.inputTokens).toBe(
      tokens1.inputTokens + tokens2.inputTokens,
    );
    expect(final?.outputTokens).toBe(
      tokens1.outputTokens + tokens2.outputTokens,
    );
    expect(final?.cacheReadTokens).toBe(
      tokens1.cacheReadTokens + tokens2.cacheReadTokens,
    );
    expect(final?.cacheCreationTokens).toBe(
      tokens1.cacheCreationTokens + tokens2.cacheCreationTokens,
    );
    expect(final?.costUsd).toBeCloseTo(tokens1.costUsd + tokens2.costUsd);
  });

  // ─── upsertDaily: 404 when agentId doesn't exist ─────────────────────────────

  it("upsertDaily() throws NotFoundError when agentId does not exist", async () => {
    await expect(
      service.upsertDaily("nonexistent-agent-id", "2026-01-15", {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ─── upsertDaily: different dates for same agent are independent ──────────────

  it("upsertDaily() for different dates on the same agent creates separate records", async () => {
    const agentId = await createAgent(prisma);

    await service.upsertDaily(agentId, "2026-01-15", {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.001,
    });
    await service.upsertDaily(agentId, "2026-01-16", {
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.002,
    });

    const records = await prisma.agentChatTokenUsageDaily.findMany({
      where: { agentId },
      orderBy: { date: "asc" },
    });

    expect(records).toHaveLength(2);
    expect(records[0].date).toBe("2026-01-15");
    expect(records[0].inputTokens).toBe(100);
    expect(records[1].date).toBe("2026-01-16");
    expect(records[1].inputTokens).toBe(200);
  });
});
