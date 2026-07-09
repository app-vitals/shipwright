/**
 * admin/src/agent-cron-run-stats.integration.test.ts
 * Integration tests for AgentCronRunStatsService — cron-run token aggregation.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentCronRunStatsService } from "./agent-cron-run-stats.ts";
import { AgentCronRunService } from "./agent-cron-runs.ts";
import { FixedClock } from "./clock.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

const FIXED_NOW = new Date("2026-01-15T12:00:00Z");

async function createAgent(
  prisma: PrismaClient,
  name = "Test Agent",
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name } });
  return agent.id;
}

async function createCron(
  cronJobService: AgentCronJobService,
  agentId: string,
  name?: string,
): Promise<string> {
  const job = await cronJobService.create(agentId, {
    schedule: "0 9 * * *",
    prompt: "Test prompt",
    silent: true,
    name,
  });
  return job.id;
}

/**
 * Seed token usage for a run by inserting an AgentCronRunModelBreakdown row.
 *
 * Since AgentCronRun no longer stores token columns directly, all token data
 * flows through the breakdown table. This mirrors what the agents-api PATCH
 * handler does when it receives a modelBreakdown payload.
 */
async function seedTokens(
  prisma: PrismaClient,
  runId: string,
  tokens: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheCreation?: number;
    model?: string;
    costUsd?: number;
  },
): Promise<void> {
  await prisma.agentCronRunModelBreakdown.create({
    data: {
      cronRunId: runId,
      model: tokens.model ?? "legacy-unattributed",
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead ?? 0,
      cacheCreationTokens: tokens.cacheCreation ?? 0,
      costUsd: tokens.costUsd ?? 0,
    },
  });
}

describeOrSkip("AgentCronRunStatsService (integration)", () => {
  let prisma: PrismaClient;
  let cronJobService: AgentCronJobService;
  let runService: AgentCronRunService;
  let statsService: AgentCronRunStatsService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentCronRunModelBreakdown.deleteMany();
    await prisma.agentCronRun.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    cronJobService = new AgentCronJobService(prisma, FixedClock(FIXED_NOW));
    runService = new AgentCronRunService(prisma);
    statsService = new AgentCronRunStatsService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── totals ──────────────────────────────────────────────────────────────────

  it("query() aggregates totals correctly across multiple runs", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    const run2 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: false,
    });

    await seedTokens(prisma, run1.id, {
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheCreation: 5,
    });
    await seedTokens(prisma, run2.id, {
      input: 200,
      output: 100,
      cacheRead: 20,
      cacheCreation: 10,
    });

    const stats = await statsService.query();

    expect(stats.totals.input).toBe(300);
    expect(stats.totals.output).toBe(150);
    expect(stats.totals.cacheRead).toBe(30);
    expect(stats.totals.cacheCreation).toBe(15);
    expect(stats.totals.total).toBe(300 + 150 + 30 + 15);
    // Breakdown rows exist (with costUsd 0), so the SUM resolves to 0 rather
    // than NULL — cost is present and zero, not undefined.
    expect(stats.totals.costUsd).toBe(0);
  });

  it("query() excludes skipped runs from totals", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    await seedTokens(prisma, run1.id, { input: 100, output: 50 });

    // Skipped run with tokens — must be excluded
    await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: true,
      skipReason: "pre-check returned false",
    });

    const stats = await statsService.query();

    expect(stats.totals.input).toBe(100);
    expect(stats.totals.output).toBe(50);
    expect(stats.totals.total).toBe(150);
  });

  it("query() returns zero totals when no runs exist", async () => {
    const stats = await statsService.query();

    expect(stats.totals.input).toBe(0);
    expect(stats.totals.output).toBe(0);
    expect(stats.totals.cacheRead).toBe(0);
    expect(stats.totals.cacheCreation).toBe(0);
    expect(stats.totals.total).toBe(0);
  });

  // ─── byAgent ─────────────────────────────────────────────────────────────────

  it("query() groups byAgent correctly across 2 agents", async () => {
    const agentId1 = await createAgent(prisma, "Agent Alpha");
    const agentId2 = await createAgent(prisma, "Agent Beta");
    const cronId1 = await createCron(cronJobService, agentId1);
    const cronId2 = await createCron(cronJobService, agentId2);

    const run1 = await runService.create(cronId1, agentId1, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    const run2 = await runService.create(cronId2, agentId2, {
      startedAt: new Date("2026-01-10T10:00:00Z"),
      skipped: false,
    });

    await seedTokens(prisma, run1.id, { input: 100, output: 50 });
    await seedTokens(prisma, run2.id, { input: 300, output: 150 });

    const stats = await statsService.query();

    expect(stats.byAgent).toHaveLength(2);

    const a1 = stats.byAgent.find((a) => a.key === agentId1);
    const a2 = stats.byAgent.find((a) => a.key === agentId2);

    expect(a1).toBeDefined();
    expect(a1?.input).toBe(100);
    expect(a1?.output).toBe(50);

    expect(a2).toBeDefined();
    expect(a2?.input).toBe(300);
    expect(a2?.output).toBe(150);
  });

  it("query() byAgent excludes skipped runs", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    await seedTokens(prisma, run1.id, { input: 50, output: 25 });

    // Skipped run — excluded
    await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: true,
    });

    const stats = await statsService.query();

    expect(stats.byAgent).toHaveLength(1);
    expect(stats.byAgent[0].key).toBe(agentId);
    expect(stats.byAgent[0].input).toBe(50);
  });

  // ─── byCron ──────────────────────────────────────────────────────────────────

  it("byCron uses cron name (key2) when AgentCronJob.name is set", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId, "morning-brief");

    const run = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    await seedTokens(prisma, run.id, { input: 100, output: 50 });

    const stats = await statsService.query();

    expect(stats.byCron).toHaveLength(1);
    expect(stats.byCron[0].key1).toBe(agentId);
    expect(stats.byCron[0].key2).toBe("morning-brief");
    expect(stats.byCron[0].input).toBe(100);
  });

  it("byCron falls back to cronId when AgentCronJob.name is null", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId); // no name

    const run = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    await seedTokens(prisma, run.id, { input: 80, output: 40 });

    const stats = await statsService.query();

    expect(stats.byCron).toHaveLength(1);
    expect(stats.byCron[0].key2).toBe(cronId);
  });

  it("byCron excludes skipped runs", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId, "review-cron");

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    await seedTokens(prisma, run1.id, { input: 60, output: 30 });

    // Skipped run — excluded
    await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: true,
    });

    const stats = await statsService.query();

    expect(stats.byCron).toHaveLength(1);
    expect(stats.byCron[0].input).toBe(60);
  });

  // ─── byModel ─────────────────────────────────────────────────────────────────

  it("query() groups byModel correctly across 2 models", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    const run2 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: false,
    });

    await prisma.agentCronRunModelBreakdown.create({
      data: {
        cronRunId: run1.id,
        model: "claude-sonnet-4-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
    });
    await prisma.agentCronRunModelBreakdown.create({
      data: {
        cronRunId: run2.id,
        model: "claude-opus-4-5",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
    });

    const stats = await statsService.query();

    expect(stats.byModel).toHaveLength(2);

    const sonnet = stats.byModel.find((m) => m.key2 === "claude-sonnet-4-5");
    const opus = stats.byModel.find((m) => m.key2 === "claude-opus-4-5");

    expect(sonnet).toBeDefined();
    expect(sonnet?.key1).toBe(agentId);
    expect(sonnet?.input).toBe(100);

    expect(opus).toBeDefined();
    expect(opus?.key1).toBe(agentId);
    expect(opus?.input).toBe(200);
  });

  it("query() excludes runs without breakdown rows from all token sums", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    // Run without any breakdown rows — now the sole source of token data is
    // AgentCronRunModelBreakdown, so a run with no breakdown contributes zero
    // to every aggregation and never appears in byModel.
    await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });

    // Run with a breakdown row — contributes to totals and byModel.
    const run2 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: false,
    });
    await prisma.agentCronRunModelBreakdown.create({
      data: {
        cronRunId: run2.id,
        model: "claude-sonnet-4-5",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
      },
    });

    const stats = await statsService.query();

    // Totals come only from the run with a breakdown row.
    expect(stats.totals.input).toBe(200);
    // byModel only includes the run with breakdown rows.
    expect(stats.byModel).toHaveLength(1);
    expect(stats.byModel[0].key2).toBe("claude-sonnet-4-5");
    expect(stats.byModel[0].input).toBe(200);
  });

  // ─── daily ───────────────────────────────────────────────────────────────────

  it("query() groups runs into daily buckets by startedAt date", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    const run2 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T15:00:00Z"),
      skipped: false,
    });
    const run3 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: false,
    });

    await seedTokens(prisma, run1.id, { input: 100, output: 50 });
    await seedTokens(prisma, run2.id, { input: 150, output: 75 });
    await seedTokens(prisma, run3.id, { input: 200, output: 100 });

    const stats = await statsService.query();

    expect(stats.daily).toHaveLength(2);

    const day1 = stats.daily.find((d) => d.period === "2026-01-10");
    const day2 = stats.daily.find((d) => d.period === "2026-01-11");

    expect(day1).toBeDefined();
    expect(day1?.input).toBe(250); // 100 + 150
    expect(day1?.output).toBe(125); // 50 + 75

    expect(day2).toBeDefined();
    expect(day2?.input).toBe(200);
    expect(day2?.output).toBe(100);
  });

  it("query() daily excludes skipped runs", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    await seedTokens(prisma, run1.id, { input: 100, output: 50 });

    // Skipped run on same day — excluded
    await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T10:00:00Z"),
      skipped: true,
    });

    const stats = await statsService.query();

    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0].period).toBe("2026-01-10");
    expect(stats.daily[0].input).toBe(100);
  });

  // ─── from/to filtering ───────────────────────────────────────────────────────

  it("query(from, to) filters runs by startedAt", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-05T09:00:00Z"),
      skipped: false,
    });
    const run2 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    const run3 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-20T09:00:00Z"),
      skipped: false,
    });

    await seedTokens(prisma, run1.id, { input: 10, output: 5 });
    await seedTokens(prisma, run2.id, { input: 100, output: 50 });
    await seedTokens(prisma, run3.id, { input: 1000, output: 500 });

    // Only include run2
    const stats = await statsService.query(
      "2026-01-08T00:00:00Z",
      "2026-01-15T00:00:00Z",
    );

    expect(stats.totals.input).toBe(100);
    expect(stats.totals.output).toBe(50);
    expect(stats.daily).toHaveLength(1);
    expect(stats.daily[0].period).toBe("2026-01-10");
  });

  it("query(from) without to includes all runs from that date", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-05T09:00:00Z"),
      skipped: false,
    });
    const run2 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });

    await seedTokens(prisma, run1.id, { input: 10, output: 5 });
    await seedTokens(prisma, run2.id, { input: 100, output: 50 });

    const stats = await statsService.query("2026-01-08T00:00:00Z");

    // Only run2 is in range
    expect(stats.totals.input).toBe(100);
  });

  // ─── byModel with breakdown rows ─────────────────────────────────────────────

  it("byModel uses breakdown rows when present, splitting tokens across models", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    // Run with breakdown rows: one run used both sonnet and haiku
    const run = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    // Write breakdown rows directly (simulating what agents-api PATCH handler does)
    await prisma.agentCronRunModelBreakdown.createMany({
      data: [
        {
          cronRunId: run.id,
          model: "claude-sonnet-4-5",
          inputTokens: 200,
          outputTokens: 100,
          cacheReadTokens: 8,
          cacheCreationTokens: 4,
          costUsd: 0.002,
        },
        {
          cronRunId: run.id,
          model: "claude-haiku-4-5",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 2,
          cacheCreationTokens: 1,
          costUsd: 0.001,
        },
      ],
    });

    const stats = await statsService.query();

    // totals must not double-count tokens from the multi-model run
    expect(stats.totals.input).toBe(300);
    expect(stats.totals.output).toBe(150);

    // byModel should show 2 entries (from breakdown), not 1 (from dominant model)
    expect(stats.byModel).toHaveLength(2);

    const sonnet = stats.byModel.find((m) => m.key2 === "claude-sonnet-4-5");
    const haiku = stats.byModel.find((m) => m.key2 === "claude-haiku-4-5");

    expect(sonnet).toBeDefined();
    expect(sonnet?.key1).toBe(agentId);
    expect(sonnet?.input).toBe(200);
    expect(sonnet?.output).toBe(100);

    expect(haiku).toBeDefined();
    expect(haiku?.key1).toBe(agentId);
    expect(haiku?.input).toBe(100);
    expect(haiku?.output).toBe(50);
  });

  // ─── byCronModel ─────────────────────────────────────────────────────────────

  it("query() includes byCronModel breakdown by agentId:cronName and model", async () => {
    const agentId1 = await createAgent(prisma, "Agent One");
    const agentId2 = await createAgent(prisma, "Agent Two");
    const cronId1 = await createCron(cronJobService, agentId1, "morning-brief");
    const cronId2 = await createCron(cronJobService, agentId2, "review-cron");

    // Run A: agent1/cron1 with sonnet breakdown
    const runA = await runService.create(cronId1, agentId1, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    await prisma.agentCronRunModelBreakdown.create({
      data: {
        cronRunId: runA.id,
        model: "claude-sonnet-4-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.001,
      },
    });

    // Run B: agent1/cron1 again with haiku breakdown (same cron, different model)
    const runB = await runService.create(cronId1, agentId1, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: false,
    });
    await prisma.agentCronRunModelBreakdown.create({
      data: {
        cronRunId: runB.id,
        model: "claude-haiku-4-5",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.0005,
      },
    });

    // Run C: agent2/cron2 with opus breakdown
    const runC = await runService.create(cronId2, agentId2, {
      startedAt: new Date("2026-01-10T10:00:00Z"),
      skipped: false,
    });
    await prisma.agentCronRunModelBreakdown.create({
      data: {
        cronRunId: runC.id,
        model: "claude-opus-4-5",
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.003,
      },
    });

    const stats = await statsService.query();

    // byCronModel keys: key1 = "agentId:cronName", key2 = model
    expect(stats.byCronModel).toHaveLength(3);

    const key1A = `${agentId1}:morning-brief`;
    const key1C = `${agentId2}:review-cron`;

    const sonnetRow = stats.byCronModel.find(
      (r) => r.key1 === key1A && r.key2 === "claude-sonnet-4-5",
    );
    expect(sonnetRow).toBeDefined();
    expect(sonnetRow?.input).toBe(100);
    expect(sonnetRow?.output).toBe(50);

    const haikuRow = stats.byCronModel.find(
      (r) => r.key1 === key1A && r.key2 === "claude-haiku-4-5",
    );
    expect(haikuRow).toBeDefined();
    expect(haikuRow?.input).toBe(200);
    expect(haikuRow?.output).toBe(100);

    const opusRow = stats.byCronModel.find(
      (r) => r.key1 === key1C && r.key2 === "claude-opus-4-5",
    );
    expect(opusRow).toBeDefined();
    expect(opusRow?.input).toBe(300);
    expect(opusRow?.output).toBe(150);
  });

  // ─── 3+ runs across 2 agents and 2 crons (acceptance test) ──────────────────

  it("seed 3+ runs across 2 agents and 2 crons; each dimension aggregates correctly; skipped excluded", async () => {
    const agentId1 = await createAgent(prisma, "Agent One");
    const agentId2 = await createAgent(prisma, "Agent Two");
    const cronId1 = await createCron(cronJobService, agentId1, "cron-alpha");
    const cronId2 = await createCron(cronJobService, agentId2, "cron-beta");

    // Run A: agent1, cron1, sonnet model
    const runA = await runService.create(cronId1, agentId1, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    await prisma.agentCronRunModelBreakdown.create({
      data: {
        cronRunId: runA.id,
        model: "claude-sonnet-4-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costUsd: 0.001,
      },
    });

    // Run B: agent2, cron2, opus model
    const runB = await runService.create(cronId2, agentId2, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: false,
    });
    await prisma.agentCronRunModelBreakdown.create({
      data: {
        cronRunId: runB.id,
        model: "claude-opus-4-5",
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        costUsd: 0.002,
      },
    });

    // Run C: agent1, cron1, sonnet model (second run same cron)
    const runC = await runService.create(cronId1, agentId1, {
      startedAt: new Date("2026-01-12T09:00:00Z"),
      skipped: false,
    });
    await prisma.agentCronRunModelBreakdown.create({
      data: {
        cronRunId: runC.id,
        model: "claude-sonnet-4-5",
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 30,
        cacheCreationTokens: 15,
        costUsd: 0.003,
      },
    });

    // Skipped run (should be excluded from everything)
    await runService.create(cronId1, agentId1, {
      startedAt: new Date("2026-01-12T10:00:00Z"),
      skipped: true,
      skipReason: "pre-check false",
    });

    const stats = await statsService.query();

    // totals: runs A+B+C only (skipped excluded)
    expect(stats.totals.input).toBe(600);
    expect(stats.totals.output).toBe(300);
    expect(stats.totals.cacheRead).toBe(60);
    expect(stats.totals.cacheCreation).toBe(30);
    expect(stats.totals.total).toBe(600 + 300 + 60 + 30);
    // costUsd is aggregated from breakdown rows via LEFT JOIN
    expect(stats.totals.costUsd).toBeCloseTo(0.001 + 0.002 + 0.003);

    // byAgent: 2 entries
    expect(stats.byAgent).toHaveLength(2);
    expect(stats.byAgent.find((a) => a.key === agentId1)?.input).toBe(400); // runA + runC
    expect(stats.byAgent.find((a) => a.key === agentId2)?.input).toBe(200); // runB

    // byCron: 2 entries with names
    expect(stats.byCron).toHaveLength(2);
    const cAlpha = stats.byCron.find((c) => c.key2 === "cron-alpha");
    const cBeta = stats.byCron.find((c) => c.key2 === "cron-beta");
    expect(cAlpha).toBeDefined();
    expect(cAlpha?.key1).toBe(agentId1);
    expect(cAlpha?.input).toBe(400); // runA + runC
    expect(cBeta).toBeDefined();
    expect(cBeta?.key1).toBe(agentId2);
    expect(cBeta?.input).toBe(200);

    // byModel: 2 entries
    expect(stats.byModel).toHaveLength(2);
    expect(
      stats.byModel.find((m) => m.key2 === "claude-sonnet-4-5")?.input,
    ).toBe(400); // runA + runC
    expect(stats.byModel.find((m) => m.key2 === "claude-opus-4-5")?.input).toBe(
      200,
    );

    // daily: 3 days
    expect(stats.daily).toHaveLength(3);
    expect(stats.daily.find((d) => d.period === "2026-01-10")?.input).toBe(100);
    expect(stats.daily.find((d) => d.period === "2026-01-11")?.input).toBe(200);
    expect(stats.daily.find((d) => d.period === "2026-01-12")?.input).toBe(300); // only runC; skipped run excluded

    // byCronModel: 2 entries — agentId1:cron-alpha × sonnet, agentId2:cron-beta × opus
    // key1 = agentId:cronName, key2 = model
    expect(stats.byCronModel).toHaveLength(2);
    const byCMSonnet = stats.byCronModel.find(
      (m) =>
        m.key1 === `${agentId1}:cron-alpha` && m.key2 === "claude-sonnet-4-5",
    );
    const byCMOpus = stats.byCronModel.find(
      (m) => m.key1 === `${agentId2}:cron-beta` && m.key2 === "claude-opus-4-5",
    );
    expect(byCMSonnet).toBeDefined();
    expect(byCMSonnet?.input).toBe(400); // runA(100) + runC(300)
    expect(byCMSonnet?.costUsd).toBeCloseTo(0.001 + 0.003);
    expect(byCMOpus).toBeDefined();
    expect(byCMOpus?.input).toBe(200); // runB only
    expect(byCMOpus?.costUsd).toBeCloseTo(0.002);
  });

  // ─── byPhase ─────────────────────────────────────────────────────────────────

  it("query() groups byPhase correctly across runs with different phases", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
      phase: "dev-task",
    });
    const run2 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: false,
      phase: "review",
    });

    await seedTokens(prisma, run1.id, { input: 100, output: 50 });
    await seedTokens(prisma, run2.id, { input: 200, output: 100 });

    const stats = await statsService.query();

    expect(stats.byPhase).toHaveLength(2);

    const devTask = stats.byPhase.find((p) => p.key === "dev-task");
    const review = stats.byPhase.find((p) => p.key === "review");

    expect(devTask).toBeDefined();
    expect(devTask?.input).toBe(100);
    expect(devTask?.output).toBe(50);

    expect(review).toBeDefined();
    expect(review?.input).toBe(200);
    expect(review?.output).toBe(100);
  });

  it("query() byPhase excludes runs with a null phase (legacy runs)", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    // Legacy run — no phase set
    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
    });
    await seedTokens(prisma, run1.id, { input: 100, output: 50 });

    // Phase-tagged run
    const run2 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: false,
      phase: "deploy",
    });
    await seedTokens(prisma, run2.id, { input: 200, output: 100 });

    const stats = await statsService.query();

    // byPhase only surfaces runs with a non-null phase
    expect(stats.byPhase).toHaveLength(1);
    expect(stats.byPhase[0].key).toBe("deploy");
    expect(stats.byPhase[0].input).toBe(200);

    // totals still reflect both runs — phase grouping is additive, not exclusionary
    expect(stats.totals.input).toBe(300);
  });

  it("query() byPhase excludes skipped runs", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run1 = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-10T09:00:00Z"),
      skipped: false,
      phase: "patch",
    });
    await seedTokens(prisma, run1.id, { input: 60, output: 30 });

    // Skipped run with a phase — excluded
    await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-11T09:00:00Z"),
      skipped: true,
      phase: "patch",
    });

    const stats = await statsService.query();

    expect(stats.byPhase).toHaveLength(1);
    expect(stats.byPhase[0].input).toBe(60);
  });

  // ─── backfilled legacy rows ──────────────────────────────────────────────────

  it("surfaces a backfilled legacy run (model=legacy-unattributed, cost=0) in all dimensions", async () => {
    // Simulates the state after the consolidation migration backfills a
    // pre-2026-07-01 run whose token counts lived in the now-dropped
    // AgentCronRun columns. The migration inserts a single breakdown row with
    // model = 'legacy-unattributed' and costUsd = 0.
    const agentId = await createAgent(prisma, "Legacy Agent");
    const cronId = await createCron(cronJobService, agentId, "legacy-cron");

    const run = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-06-15T09:00:00Z"),
      skipped: false,
    });
    await seedTokens(prisma, run.id, {
      input: 500,
      output: 250,
      cacheRead: 40,
      cacheCreation: 20,
      model: "legacy-unattributed",
      costUsd: 0,
    });

    const stats = await statsService.query();

    // totals reflect the backfilled token counts
    expect(stats.totals.input).toBe(500);
    expect(stats.totals.output).toBe(250);
    expect(stats.totals.cacheRead).toBe(40);
    expect(stats.totals.cacheCreation).toBe(20);
    expect(stats.totals.total).toBe(500 + 250 + 40 + 20);
    // cost is $0 for backfilled legacy rows
    expect(stats.totals.costUsd).toBe(0);

    // byModel surfaces the placeholder model name
    expect(stats.byModel).toHaveLength(1);
    expect(stats.byModel[0].key1).toBe(agentId);
    expect(stats.byModel[0].key2).toBe("legacy-unattributed");
    expect(stats.byModel[0].input).toBe(500);
    expect(stats.byModel[0].costUsd).toBe(0);

    // byCronModel too
    expect(stats.byCronModel).toHaveLength(1);
    expect(stats.byCronModel[0].key1).toBe(`${agentId}:legacy-cron`);
    expect(stats.byCronModel[0].key2).toBe("legacy-unattributed");
    expect(stats.byCronModel[0].input).toBe(500);
  });
});
