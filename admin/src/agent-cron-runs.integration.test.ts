/**
 * admin/src/agent-cron-runs.integration.test.ts
 * Integration tests for AgentCronRunService — create/list run records.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentCronRunService } from "./agent-cron-runs.ts";
import { FixedClock } from "./clock.ts";
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

async function createCron(
  cronJobService: AgentCronJobService,
  agentId: string,
): Promise<string> {
  const job = await cronJobService.create(agentId, {
    schedule: "0 9 * * *",
    prompt: "Test prompt",
    silent: true,
  });
  return job.id;
}

// Fixed "now" for deterministic day-boundary tests: 2026-01-15T12:00:00Z
// setUTCHours(0,0,0,0) on this gives 2026-01-15T00:00:00.000Z
const FIXED_NOW = new Date("2026-01-15T12:00:00Z");

describeOrSkip("AgentCronRunService (integration)", () => {
  let prisma: PrismaClient;
  let cronJobService: AgentCronJobService;
  let runService: AgentCronRunService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentCronRun.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    cronJobService = new AgentCronJobService(prisma, FixedClock(FIXED_NOW));
    runService = new AgentCronRunService(prisma);
  });

  // ─── create ─────────────────────────────────────────────────────────────────

  it("create() creates a run record and returns 201 data", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);
    const startedAt = new Date();

    const run = await runService.create(cronId, agentId, {
      startedAt,
      skipped: false,
      outcome: "success",
    });

    expect(run.cronId).toBe(cronId);
    expect(run.agentId).toBe(agentId);
    expect(run.skipped).toBe(false);
    expect(run.outcome).toBe("success");
    expect(run.startedAt).toEqual(startedAt);
    expect(run.completedAt).toBeNull();
    expect(run.error).toBeNull();
    expect(run.skipReason).toBeNull();
  });

  it("create() supports optional completedAt, skipReason, error fields", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);
    const startedAt = new Date();
    const completedAt = new Date(startedAt.getTime() + 5000);

    const run = await runService.create(cronId, agentId, {
      startedAt,
      completedAt,
      skipped: true,
      skipReason: "pre-check returned false",
      error: null,
      outcome: null,
    });

    expect(run.completedAt).toEqual(completedAt);
    expect(run.skipped).toBe(true);
    expect(run.skipReason).toBe("pre-check returned false");
  });

  it("create() throws NotFoundError when cronId does not exist", async () => {
    const agentId = await createAgent(prisma);

    await expect(
      runService.create("nonexistent-cron-id", agentId, {
        startedAt: new Date(),
        skipped: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("create() throws NotFoundError when cronId belongs to a different agent", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    const cronId = await createCron(cronJobService, agentId1);

    await expect(
      runService.create(cronId, agentId2, {
        startedAt: new Date(),
        skipped: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ─── list ──────────────────────────────────────────────────────────────────

  it("list() returns runs sorted descending by startedAt", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const t1 = new Date("2026-01-01T08:00:00Z");
    const t2 = new Date("2026-01-02T08:00:00Z");
    const t3 = new Date("2026-01-03T08:00:00Z");

    await runService.create(cronId, agentId, { startedAt: t1, skipped: false });
    await runService.create(cronId, agentId, { startedAt: t2, skipped: false });
    await runService.create(cronId, agentId, { startedAt: t3, skipped: false });

    const { items, total } = await runService.list(cronId, agentId);

    expect(total).toBe(3);
    expect(items).toHaveLength(3);
    // Descending: t3, t2, t1
    expect(items[0].startedAt).toEqual(t3);
    expect(items[1].startedAt).toEqual(t2);
    expect(items[2].startedAt).toEqual(t1);
  });

  it("list() defaults to limit 20", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    // Create 25 runs
    for (let i = 0; i < 25; i++) {
      await runService.create(cronId, agentId, {
        startedAt: new Date(Date.now() + i * 1000),
        skipped: false,
      });
    }

    const { items, total } = await runService.list(cronId, agentId);
    expect(items).toHaveLength(20);
    expect(total).toBe(25);
  });

  it("list() supports custom limit and offset", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    for (let i = 0; i < 5; i++) {
      await runService.create(cronId, agentId, {
        startedAt: new Date(Date.now() + i * 1000),
        skipped: false,
      });
    }

    const { items, total } = await runService.list(cronId, agentId, {
      limit: 2,
      offset: 1,
    });
    expect(items).toHaveLength(2);
    expect(total).toBe(5);
  });

  it("list() throws NotFoundError when cronId belongs to a different agent", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    const cronId = await createCron(cronJobService, agentId1);

    await expect(runService.list(cronId, agentId2)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("list() returns modelBreakdown rows for a run with multiple models", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const run = await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-15T10:00:00Z"),
      skipped: false,
    });

    await runService.patch(run.id, agentId, cronId, {
      outcome: "success",
      modelBreakdown: [
        {
          model: "claude-sonnet-4-5",
          inputTokens: 200,
          outputTokens: 100,
          cacheReadTokens: 8,
          cacheCreationTokens: 4,
          costUsd: 0.002,
        },
        {
          model: "claude-haiku-4-5",
          inputTokens: 50,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.0005,
        },
      ],
    });

    const { items } = await runService.list(cronId, agentId);

    expect(items).toHaveLength(1);
    const breakdown = items[0].modelBreakdown;
    expect(breakdown).toHaveLength(2);
    const models = breakdown.map((b) => b.model).sort();
    expect(models).toEqual(["claude-haiku-4-5", "claude-sonnet-4-5"]);
    const sonnet = breakdown.find((b) => b.model === "claude-sonnet-4-5");
    expect(sonnet?.inputTokens).toBe(200);
    expect(sonnet?.outputTokens).toBe(100);
    expect(sonnet?.cacheReadTokens).toBe(8);
    expect(sonnet?.cacheCreationTokens).toBe(4);
    expect(sonnet?.costUsd).toBeCloseTo(0.002);
  });

  it("list() returns an empty modelBreakdown array for a run with no model breakdown rows", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    await runService.create(cronId, agentId, {
      startedAt: new Date("2026-01-15T10:00:00Z"),
      skipped: false,
    });

    const { items } = await runService.list(cronId, agentId);

    expect(items).toHaveLength(1);
    expect(items[0].modelBreakdown).toEqual([]);
  });

  // ─── patch ──────────────────────────────────────────────────────────────────

  it("patch() updates token fields and completion fields on a run", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);
    const startedAt = new Date("2026-01-15T10:00:00Z");
    const completedAt = new Date("2026-01-15T10:05:00Z");

    const run = await runService.create(cronId, agentId, {
      startedAt,
      skipped: false,
    });

    const updated = await runService.patch(run.id, agentId, cronId, {
      completedAt,
      outcome: "success",
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 89,
      cacheCreationTokens: 10,
    });

    expect(updated.id).toBe(run.id);
    expect(updated.completedAt).toEqual(completedAt);
    expect(updated.outcome).toBe("success");
    expect(updated.inputTokens).toBe(1234);
    expect(updated.outputTokens).toBe(567);
    expect(updated.cacheReadTokens).toBe(89);
    expect(updated.cacheCreationTokens).toBe(10);
  });

  it("patch() updates error and skipped fields", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);
    const startedAt = new Date("2026-01-15T10:00:00Z");

    const run = await runService.create(cronId, agentId, {
      startedAt,
      skipped: false,
    });

    const updated = await runService.patch(run.id, agentId, cronId, {
      completedAt: new Date("2026-01-15T10:01:00Z"),
      outcome: "error",
      error: "something went wrong",
    });

    expect(updated.outcome).toBe("error");
    expect(updated.error).toBe("something went wrong");
  });

  it("patch() throws NotFoundError when runId does not exist", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    await expect(
      runService.patch("nonexistent-run-id", agentId, cronId, {
        outcome: "success",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("patch() throws NotFoundError when runId belongs to a different agent", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    const cronId = await createCron(cronJobService, agentId1);

    const run = await runService.create(cronId, agentId1, {
      startedAt: new Date(),
      skipped: false,
    });

    await expect(
      runService.patch(run.id, agentId2, cronId, {
        outcome: "success",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("patch() throws NotFoundError when runId belongs to a different cron", async () => {
    const agentId = await createAgent(prisma);
    const cronId1 = await createCron(cronJobService, agentId);
    const cronId2 = await createCron(cronJobService, agentId);

    const run = await runService.create(cronId1, agentId, {
      startedAt: new Date(),
      skipped: false,
    });

    await expect(
      runService.patch(run.id, agentId, cronId2, {
        outcome: "success",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // ─── listWithRunSummary ─────────────────────────────────────────────────────

  it("listWithRunSummary() returns lastRun null when no runs exist", async () => {
    const agentId = await createAgent(prisma);
    await createCron(cronJobService, agentId);

    const jobs = await cronJobService.listWithRunSummary(agentId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].lastRun).toBeNull();
    expect(jobs[0].runCountToday).toBe(0);
  });

  it("listWithRunSummary() returns lastRun as the most recent run", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    const t1 = new Date("2026-01-01T06:00:00Z");
    const t2 = new Date("2026-01-01T08:00:00Z");

    await runService.create(cronId, agentId, {
      startedAt: t1,
      completedAt: new Date(t1.getTime() + 1000),
      skipped: false,
      outcome: "success",
    });
    await runService.create(cronId, agentId, {
      startedAt: t2,
      completedAt: new Date(t2.getTime() + 2000),
      skipped: false,
      outcome: "error",
    });

    const jobs = await cronJobService.listWithRunSummary(agentId);
    expect(jobs[0].lastRun).not.toBeNull();
    expect(jobs[0].lastRun?.startedAt).toEqual(t2);
    expect(jobs[0].lastRun?.outcome).toBe("error");
  });

  it("listWithRunSummary() counts runCountToday correctly", async () => {
    const agentId = await createAgent(prisma);
    const cronId = await createCron(cronJobService, agentId);

    // Derive midnight from the fixed clock so the boundary matches what the
    // service computes — avoids a narrow race when the real clock rolls over midnight.
    const todayMidnightUtc = new Date(FIXED_NOW);
    todayMidnightUtc.setUTCHours(0, 0, 0, 0);

    const yesterday = new Date(todayMidnightUtc.getTime() - 1000);
    const todayEarly = new Date(todayMidnightUtc.getTime() + 1000);
    const todayLate = new Date(todayMidnightUtc.getTime() + 3600_000);

    // 1 run yesterday (should not count)
    await runService.create(cronId, agentId, {
      startedAt: yesterday,
      skipped: false,
    });
    // 2 runs today
    await runService.create(cronId, agentId, {
      startedAt: todayEarly,
      skipped: false,
    });
    await runService.create(cronId, agentId, {
      startedAt: todayLate,
      skipped: false,
    });

    const jobs = await cronJobService.listWithRunSummary(agentId);
    expect(jobs[0].runCountToday).toBe(2);
  });
});
