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

  // ─── queryStats ───────────────────────────────────────────────────────────────

  describe("queryStats()", () => {
    // Seed: 2 agents × 3 dates
    // agent1: dates 2026-01-10, 2026-01-11, 2026-01-12
    // agent2: dates 2026-01-10, 2026-01-11, 2026-01-12
    const DATE_A = "2026-01-10";
    const DATE_B = "2026-01-11";
    const DATE_C = "2026-01-12";

    let agent1Id: string;
    let agent2Id: string;

    beforeEach(async () => {
      agent1Id = await createAgent(prisma, "Agent One");
      agent2Id = await createAgent(prisma, "Agent Two");

      // agent1 rows
      await service.upsertDaily(agent1Id, DATE_A, {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
      });
      await service.upsertDaily(agent1Id, DATE_B, {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        costUsd: 0.002,
      });
      await service.upsertDaily(agent1Id, DATE_C, {
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 30,
        cacheCreationTokens: 15,
        costUsd: 0.003,
      });

      // agent2 rows
      await service.upsertDaily(agent2Id, DATE_A, {
        inputTokens: 400,
        outputTokens: 200,
        cacheReadTokens: 40,
        cacheCreationTokens: 20,
        costUsd: 0.004,
      });
      await service.upsertDaily(agent2Id, DATE_B, {
        inputTokens: 500,
        outputTokens: 250,
        cacheReadTokens: 50,
        cacheCreationTokens: 25,
        costUsd: 0.005,
      });
      await service.upsertDaily(agent2Id, DATE_C, {
        inputTokens: 600,
        outputTokens: 300,
        cacheReadTokens: 60,
        cacheCreationTokens: 30,
        costUsd: 0.006,
      });
    });

    it("totals sums across all 6 rows (2 agents × 3 dates)", async () => {
      const stats = await service.queryStats();

      // Total input: 100+200+300 (agent1) + 400+500+600 (agent2) = 2100
      expect(stats.totals.input).toBe(2100);
      // Total output: 50+100+150 + 200+250+300 = 1050
      expect(stats.totals.output).toBe(1050);
      // Total cacheRead: 10+20+30 + 40+50+60 = 210
      expect(stats.totals.cacheRead).toBe(210);
      // Total cacheCreation: 5+10+15 + 20+25+30 = 105
      expect(stats.totals.cacheCreation).toBe(105);
      // total = 2100+1050+210+105 = 3465
      expect(stats.totals.total).toBe(3465);
      // costUsd should be present and close to 0.021
      expect(stats.totals.costUsd).toBeCloseTo(0.021);
    });

    it("byAgent groups per agent with correct sums", async () => {
      const stats = await service.queryStats();

      expect(stats.byAgent).toHaveLength(2);

      const sorted = [...stats.byAgent].sort((a, b) =>
        a.key.localeCompare(b.key),
      );

      // Find each agent by key
      const byId: Record<string, (typeof sorted)[0]> = {};
      for (const entry of stats.byAgent) {
        byId[entry.key] = entry;
      }

      expect(byId[agent1Id]).toBeDefined();
      expect(byId[agent2Id]).toBeDefined();

      // agent1: 100+200+300=600 input
      expect(byId[agent1Id].input).toBe(600);
      expect(byId[agent1Id].output).toBe(300);

      // agent2: 400+500+600=1500 input
      expect(byId[agent2Id].input).toBe(1500);
      expect(byId[agent2Id].output).toBe(750);
    });

    it("daily buckets per date with correct sums", async () => {
      const stats = await service.queryStats();

      expect(stats.daily).toHaveLength(3);

      // Sort by period ascending
      const sorted = [...stats.daily].sort((a, b) =>
        a.period.localeCompare(b.period),
      );

      expect(sorted[0].period).toBe(DATE_A);
      // DATE_A: agent1(100+50+10+5) + agent2(400+200+40+20) = 825 total
      expect(sorted[0].input).toBe(500); // 100+400
      expect(sorted[0].output).toBe(250); // 50+200

      expect(sorted[1].period).toBe(DATE_B);
      expect(sorted[1].input).toBe(700); // 200+500

      expect(sorted[2].period).toBe(DATE_C);
      expect(sorted[2].input).toBe(900); // 300+600
    });

    it("from/to filter restricts to date range (inclusive start, inclusive end)", async () => {
      // Only DATE_B and DATE_C
      const stats = await service.queryStats(DATE_B, DATE_C);

      // Should include only DATE_B and DATE_C rows
      expect(stats.daily).toHaveLength(2);

      const periods = stats.daily.map((d) => d.period).sort();
      expect(periods).toEqual([DATE_B, DATE_C]);

      // Totals should only include DATE_B and DATE_C
      // agent1 DATE_B: 200 input, agent1 DATE_C: 300, agent2 DATE_B: 500, agent2 DATE_C: 600 → 1600
      expect(stats.totals.input).toBe(1600);
    });

    it("returns zero totals and empty arrays when no rows exist", async () => {
      // Clear all rows
      await prisma.agentChatTokenUsageDaily.deleteMany();

      const stats = await service.queryStats();

      expect(stats.totals.input).toBe(0);
      expect(stats.totals.output).toBe(0);
      expect(stats.totals.total).toBe(0);
      expect(stats.byAgent).toHaveLength(0);
      expect(stats.daily).toHaveLength(0);
    });
  });
});
