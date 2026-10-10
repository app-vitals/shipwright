/**
 * admin/src/dev-task-adherence.integration.test.ts
 * Integration test for DevTaskAdherenceService against the admin data layer.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentCronRunService } from "./agent-cron-runs.ts";
import { FixedClock } from "./clock.ts";
import { DevTaskAdherenceService } from "./dev-task-adherence.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("DevTaskAdherenceService (integration)", () => {
  let prisma: PrismaClient;
  let cronJobService: AgentCronJobService;
  let runService: AgentCronRunService;
  let service: DevTaskAdherenceService;

  beforeEach(async () => {
    prisma = createAdminPrismaClient(TEST_DB as string);
    await prisma.agentCronRunSkillUsage.deleteMany();
    await prisma.agentCronRunModelBreakdown.deleteMany();
    await prisma.agentCronRun.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    cronJobService = new AgentCronJobService(
      prisma,
      FixedClock(new Date("2026-01-15T12:00:00Z")),
    );
    runService = new AgentCronRunService(prisma);
    service = new DevTaskAdherenceService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  async function seedRun(
    agentId: string,
    cronId: string,
    phaseId: string,
    opts: {
      itemId: string;
      startedAt: string;
      skipped?: boolean;
      usage: { name: string; invocations: number }[];
    },
  ): Promise<void> {
    const run = await runService.create(cronId, agentId, {
      startedAt: new Date(opts.startedAt),
      skipped: opts.skipped ?? false,
      phaseId,
      itemId: opts.itemId,
    });
    for (const u of opts.usage) {
      await prisma.agentCronRunSkillUsage.create({
        data: {
          cronRunId: run.id,
          kind: "agent",
          name: u.name,
          invocations: u.invocations,
        },
      });
    }
  }

  it("flags skipped-dispatch runs, passes adherent runs, ignores other phases and skipped runs", async () => {
    const agent = await prisma.agent.create({ data: { name: "A" } });
    const mk = (name: string) =>
      cronJobService.create(agent.id, {
        schedule: "0 9 * * *",
        prompt: "p",
        silent: true,
        name,
      });
    const loop = await mk("shipwright-loop");
    const devTask = await mk("shipwright-dev-task");
    const review = await mk("shipwright-review");

    await seedRun(agent.id, loop.id, devTask.id, {
      itemId: "VRW-1.1",
      startedAt: "2026-01-10T09:00:00Z",
      usage: [{ name: "shipwright:researcher", invocations: 1 }],
    });
    await seedRun(agent.id, loop.id, devTask.id, {
      itemId: "OK-1.1",
      startedAt: "2026-01-11T09:00:00Z",
      usage: [
        { name: "general-purpose", invocations: 2 },
        { name: "shipwright:docs-refresher", invocations: 1 },
      ],
    });
    // Excluded: wrong phase, skipped tick, outside window.
    await seedRun(agent.id, loop.id, review.id, {
      itemId: "R-1",
      startedAt: "2026-01-11T10:00:00Z",
      usage: [],
    });
    await seedRun(agent.id, loop.id, devTask.id, {
      itemId: "SK-1",
      startedAt: "2026-01-11T11:00:00Z",
      skipped: true,
      usage: [],
    });
    await seedRun(agent.id, loop.id, devTask.id, {
      itemId: "OLD-1",
      startedAt: "2025-12-01T09:00:00Z",
      usage: [],
    });

    const report = await service.report(
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
    );

    expect(report.runs.map((r) => r.itemId)).toEqual(["VRW-1.1", "OK-1.1"]);
    const [bad, good] = report.runs;
    expect(bad?.adherent).toBe(false);
    expect(bad?.missingSteps).toEqual(
      expect.arrayContaining(["5", "6.5", "8.5"]),
    );
    expect(good?.adherent).toBe(true);
    expect(report.overall.runs).toBe(2);
    expect(report.overall.adherentRuns).toBe(1);
    expect(
      report.overall.steps.find((s) => s.stepNumber === "5")?.rate,
    ).toBe(0.5);
    expect(report.disclaimer).toContain("started, not that it was done well");
  });
});
