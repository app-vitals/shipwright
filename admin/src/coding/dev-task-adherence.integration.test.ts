/**
 * admin/src/coding/dev-task-adherence.integration.test.ts
 * Integration test for DevTaskAdherenceService against the admin data layer.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentCronJobService } from "@app-vitals/agent-admin/agent-cron-jobs";
import { AgentCronRunService } from "@app-vitals/agent-admin/agent-cron-runs";
import { FixedClock } from "@app-vitals/agent-admin/clock";
import type { PrismaClient } from "@app-vitals/agent-admin/prisma/client/client.ts";
import { createAdminPrismaClient } from "@app-vitals/agent-admin/prisma-client";
import { DevTaskAdherenceService } from "./dev-task-adherence.ts";

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
      itemId: string | null;
      commandVariant?: string;
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
      commandVariant: opts.commandVariant,
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

    // Silent tick: non-skipped, no work item. Excluded from rates.
    await seedRun(agent.id, loop.id, devTask.id, {
      itemId: null,
      commandVariant: "alternate",
      startedAt: "2026-01-12T09:00:00Z",
      usage: [],
    });

    const report = await service.report(
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
    );

    expect(report.runs.map((r) => r.itemId)).toEqual([
      "VRW-1.1",
      "OK-1.1",
      null,
    ]);
    expect(report.counts).toEqual({
      totalRuns: 3,
      taskBearingRuns: 2,
      silentTicks: 1,
      mixedTasks: 0,
    });
    const [bad, good] = report.runs;
    expect(bad?.adherent).toBe(false);
    expect(bad?.missingSteps).toEqual(
      expect.arrayContaining(["5", "6.5", "8.5"]),
    );
    expect(good?.adherent).toBe(true);
    expect(report.overall.runs).toBe(2);
    expect(report.overall.adherentRuns).toBe(1);
    expect(report.overall.steps.find((s) => s.stepNumber === "5")?.rate).toBe(
      0.5,
    );
    expect(report.disclaimer).toContain("started, not that it was done well");
  });

  it("counts a stalled-then-resumed item once with combined dispatches (SPL-2.8)", async () => {
    const agent = await prisma.agent.create({ data: { name: "A" } });
    const cron = await cronJobService.create(agent.id, {
      schedule: "0 9 * * *",
      prompt: "p",
      silent: true,
      name: "shipwright-dev-task",
    });
    await seedRun(agent.id, cron.id, cron.id, {
      itemId: "SPL-2.8",
      startedAt: "2026-01-10T09:00:00Z",
      usage: [{ name: "shipwright:researcher", invocations: 1 }],
    });
    await seedRun(agent.id, cron.id, cron.id, {
      itemId: "SPL-2.8",
      startedAt: "2026-01-10T11:00:00Z",
      usage: [{ name: "general-purpose", invocations: 2 }],
    });
    const report = await service.report();
    expect(report.counts.taskBearingRuns).toBe(1);
    expect(
      report.runs[0]?.steps.find((s) => s.stepNumber === "5")?.status,
    ).toBe("ran");
  });
  it("scores patch runs by phase: shipwright-patch cron only, grouped by commandVariant (DTA-9.2)", async () => {
    const agent = await prisma.agent.create({ data: { name: "A" } });
    const mk = (name: string) =>
      cronJobService.create(agent.id, {
        schedule: "0 9 * * *",
        prompt: "p",
        silent: true,
        name,
      });
    const loop = await mk("shipwright-loop");
    const patch = await mk("shipwright-patch");
    const devTask = await mk("shipwright-dev-task");

    // 20 task-bearing patch runs, one with a fix dispatch (5%).
    for (let i = 0; i < 20; i++) {
      await seedRun(agent.id, loop.id, patch.id, {
        itemId: `o/r#${i + 1}`,
        commandVariant: i % 2 ? "alternate" : "default",
        startedAt: `2026-01-10T${String(i).padStart(2, "0")}:00:00Z`,
        usage: i === 4 ? [{ name: "general-purpose", invocations: 1 }] : [],
      });
    }
    // Resumed run: dispatch lives on the earlier row; counted once.
    await seedRun(agent.id, loop.id, patch.id, {
      itemId: "o/r#21",
      startedAt: "2026-01-11T01:00:00Z",
      usage: [{ name: "general-purpose", invocations: 1 }],
    });
    await seedRun(agent.id, loop.id, patch.id, {
      itemId: "o/r#21",
      startedAt: "2026-01-11T02:00:00Z",
      usage: [],
    });
    // Silent tick, other phase, skipped: excluded from rates / the query.
    await seedRun(agent.id, loop.id, patch.id, {
      itemId: null,
      startedAt: "2026-01-11T03:00:00Z",
      usage: [],
    });
    await seedRun(agent.id, loop.id, devTask.id, {
      itemId: "DT-1",
      startedAt: "2026-01-11T04:00:00Z",
      usage: [{ name: "general-purpose", invocations: 1 }],
    });
    await seedRun(agent.id, loop.id, patch.id, {
      itemId: "o/r#99",
      skipped: true,
      startedAt: "2026-01-11T05:00:00Z",
      usage: [],
    });

    const report = await service.report(
      "2026-01-01T00:00:00Z",
      "2026-02-01T00:00:00Z",
      undefined,
      "patch",
    );
    expect(report.command).toBe("patch");
    expect(report.counts).toEqual({
      totalRuns: 22,
      taskBearingRuns: 21,
      silentTicks: 1,
      mixedTasks: 0,
      mixedPrs: 0,
    });
    const five = (s: {
      steps: { stepNumber: string; ran: number; skipped: number }[];
    }) => s.steps.find((x) => x.stepNumber === "5b");
    expect(five(report.overall)).toMatchObject({ ran: 2, skipped: 19 });
    expect(report.byCommandVariant.map((c) => c.commandVariant)).toEqual([
      "alternate",
      "default",
      null,
    ]);
    // Default selector is still dev-task, unchanged.
    const dev = await service.report();
    expect("command" in dev).toBe(false);
    expect(dev.runs.map((r) => r.itemId)).toEqual(["DT-1"]);
  });
});
