/**
 * admin/src/agent-deletion.integration.test.ts
 * Integration tests for deleteAgentFully() against a real PostgreSQL DB.
 *
 * Unlike agent-deletion.unit.test.ts (fully-mocked Prisma double), this suite
 * passes a REAL PrismaClient for the DB-touching parts of the orchestration —
 * proving the Agent row and every child row actually cascade-delete together
 * (or don't, on failure) against the real schema's `onDelete: Cascade` FKs.
 * The non-DB dependencies (provisioner/taskStore/chatService/slack/decrypt)
 * are hand-written no-op stubs — they are not the thing under test here.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import {
  type DeleteAgentFullyDeps,
  deleteAgentFully,
} from "./agent-deletion.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
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

/**
 * Populate one row in every child model that carries (directly or
 * transitively) an agentId FK, so a single "full-fixture" agent exercises the
 * entire cascade — including the two-hop Agent → AgentCronJob → AgentCronRun
 * path.
 */
async function seedFullFixture(
  prisma: PrismaClient,
  agentId: string,
): Promise<void> {
  await prisma.agentEnv.create({
    data: { agentId, key: "GH_TOKEN", value: "encrypted-value", secret: true },
  });
  await prisma.agentToken.create({
    data: { agentId, token: "a".repeat(64), label: "CI Token" },
  });
  const cronJob = await prisma.agentCronJob.create({
    data: {
      agentId,
      schedule: "0 9 * * *",
      prompt: "Good morning",
      channel: "C123456",
    },
  });
  await prisma.agentCronRun.create({
    data: {
      cronId: cronJob.id,
      agentId,
      startedAt: new Date(),
      completedAt: new Date(),
      skipped: false,
      outcome: "success",
    },
  });
  await prisma.agentTool.create({
    data: { agentId, pattern: "Read" },
  });
  await prisma.agentPlugin.create({
    data: { agentId, name: "@shipwright/plugin" },
  });
  await prisma.agentMember.create({
    data: { agentId, email: "member@example.com" },
  });
  await prisma.agentChatTokenUsageDailyByModel.create({
    data: {
      agentId,
      date: "2026-07-14",
      model: "claude-sonnet-4-5",
      inputTokens: 100,
      outputTokens: 50,
    },
  });
}

interface FixtureCounts {
  agent: number;
  agentEnv: number;
  agentToken: number;
  agentCronJob: number;
  agentCronRun: number;
  agentTool: number;
  agentPlugin: number;
  agentMember: number;
  agentChatTokenUsageDailyByModel: number;
}

async function countFixtureRows(
  prisma: PrismaClient,
  agentId: string,
): Promise<FixtureCounts> {
  const where = { where: { agentId } };
  return {
    agent: (await prisma.agent.findUnique({ where: { id: agentId } })) ? 1 : 0,
    agentEnv: await prisma.agentEnv.count(where),
    agentToken: await prisma.agentToken.count(where),
    agentCronJob: await prisma.agentCronJob.count(where),
    agentCronRun: await prisma.agentCronRun.count(where),
    agentTool: await prisma.agentTool.count(where),
    agentPlugin: await prisma.agentPlugin.count(where),
    agentMember: await prisma.agentMember.count(where),
    agentChatTokenUsageDailyByModel:
      await prisma.agentChatTokenUsageDailyByModel.count(where),
  };
}

const ALL_ZERO: FixtureCounts = {
  agent: 0,
  agentEnv: 0,
  agentToken: 0,
  agentCronJob: 0,
  agentCronRun: 0,
  agentTool: 0,
  agentPlugin: 0,
  agentMember: 0,
  agentChatTokenUsageDailyByModel: 0,
};

const ALL_ONE: FixtureCounts = {
  agent: 1,
  agentEnv: 1,
  agentToken: 1,
  agentCronJob: 1,
  agentCronRun: 1,
  agentTool: 1,
  agentPlugin: 1,
  agentMember: 1,
  agentChatTokenUsageDailyByModel: 1,
};

/** Hand-written no-op stub deps — everything succeeds. Not the thing under test. */
function makeSucceedingDeps(prisma: PrismaClient): DeleteAgentFullyDeps {
  return {
    prisma,
    provisioner: {
      deprovision: async () => {
        // no-op: real k8s deprovision is out of scope for this DB-cascade test
      },
    },
    taskStore: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {
        // no-op
      },
    },
    chatService: {
      listTokensForAgent: async () => [],
      revokeToken: async () => {
        // no-op
      },
      deleteThreadsForAgent: async () => ({ deleted: 0 }),
    },
    slack: {
      deleteApp: async () => {
        // no-op
      },
    },
    decrypt: (value) => value,
  };
}

describeOrSkip("deleteAgentFully (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    // FK-safe order: children before parents.
    await prisma.agentCronRun.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agentChatTokenUsageDailyByModel.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("deletes the Agent row and cascades every child row on full success", async () => {
    const agentId = await createAgent(prisma);
    await seedFullFixture(prisma, agentId);

    // Sanity: the fixture is fully seeded before we call the function under test.
    expect(await countFixtureRows(prisma, agentId)).toEqual(ALL_ONE);

    const deps = makeSucceedingDeps(prisma);
    const result = await deleteAgentFully(agentId, deps, {
      xoxpToken: "xoxp-user",
    });

    expect(result.agentDeleted).toBe(true);
    expect(result.failed).toEqual([]);

    // Every row for this agentId — including the transitively-cascaded
    // AgentCronRun via AgentCronJob — must now be gone.
    expect(await countFixtureRows(prisma, agentId)).toEqual(ALL_ZERO);
  });

  it("does not delete the Agent row (or cascade anything) if an automatable step fails", async () => {
    const agentId = await createAgent(prisma);
    await seedFullFixture(prisma, agentId);

    expect(await countFixtureRows(prisma, agentId)).toEqual(ALL_ONE);

    const deps = makeSucceedingDeps(prisma);
    deps.provisioner = {
      deprovision: async () => {
        throw new Error("k8s deprovision failed");
      },
    };

    const result = await deleteAgentFully(agentId, deps, {
      xoxpToken: "xoxp-user",
    });

    expect(result.agentDeleted).toBe(false);
    expect(result.failed).toEqual([
      { step: "k8s", error: "k8s deprovision failed" },
    ]);

    // Nothing was cascaded: the Agent row is deliberately left in place, and
    // so is every child row — proving the row-deleted-last rollback-safety
    // guarantee holds against a real DB, not just the in-memory unit double.
    expect(await countFixtureRows(prisma, agentId)).toEqual(ALL_ONE);
  });

  it("cascades AgentCronRun via its parent AgentCronJob on success, but leaves it intact on failure", async () => {
    // Targeted check on the trickiest FK path — the two-hop
    // Agent -> AgentCronJob -> AgentCronRun cascade — in isolation from the
    // rest of the fixture.
    const successAgentId = await createAgent(prisma, "Cascade Success Agent");
    const successCron = await prisma.agentCronJob.create({
      data: {
        agentId: successAgentId,
        schedule: "0 9 * * *",
        prompt: "Good morning",
        channel: "C1",
      },
    });
    const successRun = await prisma.agentCronRun.create({
      data: {
        cronId: successCron.id,
        agentId: successAgentId,
        startedAt: new Date(),
        completedAt: new Date(),
        skipped: false,
        outcome: "success",
      },
    });

    const successResult = await deleteAgentFully(
      successAgentId,
      makeSucceedingDeps(prisma),
    );
    expect(successResult.agentDeleted).toBe(true);
    expect(
      await prisma.agentCronRun.findUnique({ where: { id: successRun.id } }),
    ).toBeNull();
    expect(
      await prisma.agentCronJob.findUnique({ where: { id: successCron.id } }),
    ).toBeNull();

    const failAgentId = await createAgent(prisma, "Cascade Failure Agent");
    const failCron = await prisma.agentCronJob.create({
      data: {
        agentId: failAgentId,
        schedule: "0 9 * * *",
        prompt: "Good morning",
        channel: "C1",
      },
    });
    const failRun = await prisma.agentCronRun.create({
      data: {
        cronId: failCron.id,
        agentId: failAgentId,
        startedAt: new Date(),
        completedAt: new Date(),
        skipped: false,
        outcome: "success",
      },
    });

    const deps = makeSucceedingDeps(prisma);
    deps.provisioner = {
      deprovision: async () => {
        throw new Error("k8s deprovision failed");
      },
    };
    const failResult = await deleteAgentFully(failAgentId, deps);
    expect(failResult.agentDeleted).toBe(false);
    expect(
      await prisma.agentCronRun.findUnique({ where: { id: failRun.id } }),
    ).not.toBeNull();
    expect(
      await prisma.agentCronJob.findUnique({ where: { id: failCron.id } }),
    ).not.toBeNull();
  });
});
