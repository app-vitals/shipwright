/**
 * admin/src/coding/shipwright-loop-jobs.integration.test.ts
 * Integration tests for ShipwrightLoopJobService against a real PostgreSQL DB
 * (relocated from agent-cron-jobs.integration.test.ts, AEP-3.2).
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../../prisma/client/client.ts";
import { AgentCronJobService } from "../agent-cron-jobs.ts";
import { createAdminPrismaClient } from "../prisma-client.ts";
import { ShipwrightLoopJobService } from "./shipwright-loop-jobs.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

async function createAgent(
  prisma: PrismaClient,
  name = "Test Agent",
  typeName = "coding",
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name, typeName } });
  return agent.id;
}

describeOrSkip("ShipwrightLoopJobService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentCronJobService;
  let loopJobs: ShipwrightLoopJobService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentCronJobService(prisma);
    loopJobs = new ShipwrightLoopJobService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── listShipwrightLoopJobs ─────────────────────────────────────────────────

  it("listShipwrightLoopJobs() returns each requested agent's shipwright-loop row in one query, omitting agents with no such row", async () => {
    const withLoopAgentId = await createAgent(prisma, "Has Loop Agent");
    const noLoopAgentId = await createAgent(prisma, "No Loop Agent");
    await service.create(withLoopAgentId, {
      schedule: "0 9 * * *",
      prompt: "/shipwright:dev-task",
      channel: "C1",
      enabled: true,
      name: "shipwright-loop",
    });
    // A differently-named cron on the no-loop agent should not be mistaken
    // for its shipwright-loop row.
    await service.create(noLoopAgentId, {
      schedule: "0 9 * * *",
      prompt: "some other prompt",
      channel: "C2",
      enabled: true,
      name: "shipwright-dev-task",
    });

    const rows = await loopJobs.listShipwrightLoopJobs([
      withLoopAgentId,
      noLoopAgentId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe(withLoopAgentId);
    expect(rows[0]?.name).toBe("shipwright-loop");
  });

  it("listShipwrightLoopJobs() returns [] for an empty agent id list", async () => {
    expect(await loopJobs.listShipwrightLoopJobs([])).toEqual([]);
  });
});
