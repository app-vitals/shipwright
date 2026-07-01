/**
 * admin/src/agent-chat-tokens.integration.test.ts
 * Integration tests for AgentChatTokenService — upsertDailyByModel.
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
    await prisma.agentChatTokenUsageDailyByModel.deleteMany();
    await prisma.agentCronRun.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentChatTokenService(prisma);
  });

  // ─── upsertDailyByModel: create ─────────────────────────────────────────────

  it("upsertDailyByModel() creates a new record for a fresh (agentId, date, model) tuple", async () => {
    const agentId = await createAgent(prisma);
    const date = "2026-01-15";
    const model = "claude-sonnet-4-5";

    const row = await service.upsertDailyByModel(agentId, date, model, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      costUsd: 0.0012,
    });

    expect(row.agentId).toBe(agentId);
    expect(row.date).toBe(date);
    expect(row.model).toBe(model);
    expect(row.inputTokens).toBe(100);
    expect(row.outputTokens).toBe(50);
    expect(row.cacheReadTokens).toBe(10);
    expect(row.cacheCreationTokens).toBe(5);
    expect(row.costUsd).toBeCloseTo(0.0012);
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  // ─── upsertDailyByModel: accumulate ─────────────────────────────────────────

  it("upsertDailyByModel() with same agentId+date+model accumulates totals", async () => {
    const agentId = await createAgent(prisma);
    const date = "2026-01-15";
    const model = "claude-sonnet-4-5";

    await service.upsertDailyByModel(agentId, date, model, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      costUsd: 0.001,
    });

    const row = await service.upsertDailyByModel(agentId, date, model, {
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

  // ─── upsertDailyByModel: different models are independent ────────────────────

  it("upsertDailyByModel() for different models on same (agentId, date) creates separate records", async () => {
    const agentId = await createAgent(prisma);
    const date = "2026-01-15";

    await service.upsertDailyByModel(agentId, date, "claude-sonnet-4-5", {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.001,
    });
    await service.upsertDailyByModel(agentId, date, "claude-haiku-3-5", {
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.002,
    });

    const records = await prisma.agentChatTokenUsageDailyByModel.findMany({
      where: { agentId, date },
      orderBy: { model: "asc" },
    });

    expect(records).toHaveLength(2);
    expect(records[0].model).toBe("claude-haiku-3-5");
    expect(records[0].inputTokens).toBe(200);
    expect(records[1].model).toBe("claude-sonnet-4-5");
    expect(records[1].inputTokens).toBe(100);
  });

  // ─── upsertDailyByModel: concurrent ──────────────────────────────────────────

  it("two concurrent upsertDailyByModel() calls for same (agentId, date, model) accumulate atomically", async () => {
    const agentId = await createAgent(prisma);
    const date = "2026-06-25";
    const model = "claude-sonnet-4-5";

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

    await Promise.all([
      service.upsertDailyByModel(agentId, date, model, tokens1),
      service.upsertDailyByModel(agentId, date, model, tokens2),
    ]);

    const final = await prisma.agentChatTokenUsageDailyByModel.findUnique({
      where: { agentId_date_model: { agentId, date, model } },
    });

    expect(final).not.toBeNull();
    expect(final?.inputTokens).toBe(tokens1.inputTokens + tokens2.inputTokens);
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

  // ─── upsertDailyByModel: 404 when agentId doesn't exist ──────────────────────

  it("upsertDailyByModel() throws NotFoundError when agentId does not exist", async () => {
    await expect(
      service.upsertDailyByModel(
        "nonexistent-agent-id",
        "2026-01-15",
        "claude-sonnet-4-5",
        {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheCreationTokens: 5,
          costUsd: 0.001,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ─── queryStats ───────────────────────────────────────────────────────────────

  describe("queryStats()", () => {
    // Seed: 2 agents × 3 dates × 2 models each
    const DATE_A = "2026-01-10";
    const DATE_B = "2026-01-11";
    const DATE_C = "2026-01-12";
    const MODEL_S = "claude-sonnet-4-5";
    const MODEL_H = "claude-haiku-3-5";

    let agent1Id: string;
    let agent2Id: string;

    beforeEach(async () => {
      agent1Id = await createAgent(prisma, "Agent One");
      agent2Id = await createAgent(prisma, "Agent Two");

      // agent1 rows — model Sonnet on DATE_A, model Haiku on DATE_B, both models on DATE_C
      await service.upsertDailyByModel(agent1Id, DATE_A, MODEL_S, {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
      });
      await service.upsertDailyByModel(agent1Id, DATE_B, MODEL_H, {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        costUsd: 0.002,
      });
      await service.upsertDailyByModel(agent1Id, DATE_C, MODEL_S, {
        inputTokens: 150,
        outputTokens: 75,
        cacheReadTokens: 15,
        cacheCreationTokens: 7,
        costUsd: 0.0015,
      });
      await service.upsertDailyByModel(agent1Id, DATE_C, MODEL_H, {
        inputTokens: 150,
        outputTokens: 75,
        cacheReadTokens: 15,
        cacheCreationTokens: 8,
        costUsd: 0.0015,
      });

      // agent2 rows — Sonnet only on all 3 dates
      await service.upsertDailyByModel(agent2Id, DATE_A, MODEL_S, {
        inputTokens: 400,
        outputTokens: 200,
        cacheReadTokens: 40,
        cacheCreationTokens: 20,
        costUsd: 0.004,
      });
      await service.upsertDailyByModel(agent2Id, DATE_B, MODEL_S, {
        inputTokens: 500,
        outputTokens: 250,
        cacheReadTokens: 50,
        cacheCreationTokens: 25,
        costUsd: 0.005,
      });
      await service.upsertDailyByModel(agent2Id, DATE_C, MODEL_S, {
        inputTokens: 600,
        outputTokens: 300,
        cacheReadTokens: 60,
        cacheCreationTokens: 30,
        costUsd: 0.006,
      });
    });

    it("totals sums across all rows (both agents, all dates, all models)", async () => {
      const stats = await service.queryStats();

      // agent1 Sonnet DATE_A: 100, Haiku DATE_B: 200, Sonnet DATE_C: 150, Haiku DATE_C: 150
      // agent2 Sonnet DATE_A: 400, Sonnet DATE_B: 500, Sonnet DATE_C: 600
      // Total input: 100+200+150+150+400+500+600 = 2100
      expect(stats.totals.input).toBe(2100);
      // Total output: 50+100+75+75+200+250+300 = 1050
      expect(stats.totals.output).toBe(1050);
      // Total cacheRead: 10+20+15+15+40+50+60 = 210
      expect(stats.totals.cacheRead).toBe(210);
      // Total cacheCreation: 5+10+7+8+20+25+30 = 105
      expect(stats.totals.cacheCreation).toBe(105);
      // total = 2100+1050+210+105 = 3465
      expect(stats.totals.total).toBe(3465);
      // costUsd: 0.001+0.002+0.0015+0.0015+0.004+0.005+0.006 = 0.021
      expect(stats.totals.costUsd).toBeCloseTo(0.021);
    });

    it("byAgent groups per agent with correct sums across models", async () => {
      const stats = await service.queryStats();

      expect(stats.byAgent).toHaveLength(2);

      const byId: Record<string, (typeof stats.byAgent)[0]> = {};
      for (const entry of stats.byAgent) {
        byId[entry.key] = entry;
      }

      expect(byId[agent1Id]).toBeDefined();
      expect(byId[agent2Id]).toBeDefined();

      // agent1: 100+200+150+150 = 600 input
      expect(byId[agent1Id].input).toBe(600);
      expect(byId[agent1Id].output).toBe(300);

      // agent2: 400+500+600 = 1500 input
      expect(byId[agent2Id].input).toBe(1500);
      expect(byId[agent2Id].output).toBe(750);
    });

    it("byModel groups per (agentId, model) pair with correct sums", async () => {
      const stats = await service.queryStats();

      // agent1 Sonnet: 100+150=250 input
      // agent1 Haiku: 200+150=350 input
      // agent2 Sonnet: 400+500+600=1500 input
      expect(stats.byModel).toBeDefined();
      expect(stats.byModel.length).toBeGreaterThanOrEqual(3);

      const byKey: Record<string, (typeof stats.byModel)[0]> = {};
      for (const entry of stats.byModel) {
        byKey[`${entry.key1}:${entry.key2}`] = entry;
      }

      expect(byKey[`${agent1Id}:${MODEL_S}`]).toBeDefined();
      expect(byKey[`${agent1Id}:${MODEL_S}`].input).toBe(250);

      expect(byKey[`${agent1Id}:${MODEL_H}`]).toBeDefined();
      expect(byKey[`${agent1Id}:${MODEL_H}`].input).toBe(350);

      expect(byKey[`${agent2Id}:${MODEL_S}`]).toBeDefined();
      expect(byKey[`${agent2Id}:${MODEL_S}`].input).toBe(1500);
    });

    it("daily buckets per date with correct sums across agents and models", async () => {
      const stats = await service.queryStats();

      expect(stats.daily).toHaveLength(3);

      const sorted = [...stats.daily].sort((a, b) =>
        a.period.localeCompare(b.period),
      );

      expect(sorted[0].period).toBe(DATE_A);
      // DATE_A: agent1 Sonnet 100 + agent2 Sonnet 400 = 500
      expect(sorted[0].input).toBe(500);

      expect(sorted[1].period).toBe(DATE_B);
      // DATE_B: agent1 Haiku 200 + agent2 Sonnet 500 = 700
      expect(sorted[1].input).toBe(700);

      expect(sorted[2].period).toBe(DATE_C);
      // DATE_C: agent1 Sonnet 150 + agent1 Haiku 150 + agent2 Sonnet 600 = 900
      expect(sorted[2].input).toBe(900);
    });

    it("from/to filter restricts to date range (inclusive start, inclusive end)", async () => {
      const stats = await service.queryStats(DATE_B, DATE_C);

      expect(stats.daily).toHaveLength(2);

      const periods = stats.daily.map((d) => d.period).sort();
      expect(periods).toEqual([DATE_B, DATE_C]);

      // DATE_B: 200+500=700, DATE_C: 150+150+600=900 → total 1600
      expect(stats.totals.input).toBe(1600);
    });

    it("returns zero totals and empty arrays when no rows exist", async () => {
      await prisma.agentChatTokenUsageDailyByModel.deleteMany();

      const stats = await service.queryStats();

      expect(stats.totals.input).toBe(0);
      expect(stats.totals.output).toBe(0);
      expect(stats.totals.total).toBe(0);
      expect(stats.byAgent).toHaveLength(0);
      expect(stats.byModel).toHaveLength(0);
      expect(stats.daily).toHaveLength(0);
    });
  });
});
