/**
 * agent/src/agent-phase-methodology.integration.test.ts
 * Integration tests for AgentPhaseMethodologyService against a real
 * PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentPhaseMethodologyService } from "./agent-phase-methodology.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

async function createAgent(
  prisma: PrismaClient,
  name = "Test Agent",
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name } });
  return agent.id;
}

describeOrSkip("AgentPhaseMethodologyService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentPhaseMethodologyService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentPhaseMethodology.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentPhaseMethodologyService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("list() returns an empty array for an agent with no overrides", async () => {
    const agentId = await createAgent(prisma);
    const rows = await service.list(agentId);
    expect(rows).toEqual([]);
  });

  it("upsert() creates a new phase-methodology override", async () => {
    const agentId = await createAgent(prisma);
    const row = await service.upsert(
      agentId,
      "review",
      "shipwright:code-reviewer",
    );
    expect(row.agentId).toBe(agentId);
    expect(row.phase).toBe("review");
    expect(row.subagentType).toBe("shipwright:code-reviewer");
  });

  it("upsert() updates the subagentType for an existing phase (idempotent on [agentId, phase])", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, "review", "shipwright:code-reviewer");
    const updated = await service.upsert(agentId, "review", "claude");
    expect(updated.subagentType).toBe("claude");

    const rows = await service.list(agentId);
    expect(rows).toHaveLength(1);
  });

  it("upsert() with subagentType: null clears a previously set override", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, "deploy", "shipwright:code-reviewer");
    const cleared = await service.upsert(agentId, "deploy", null);
    expect(cleared.subagentType).toBeNull();
  });

  it("list() returns all overrides for a given agent ordered by phase, scoped to that agent", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    await service.upsert(agentId1, "review", "reviewer-a");
    await service.upsert(agentId1, "deploy", "deployer-a");
    await service.upsert(agentId2, "review", "reviewer-b");

    const rows1 = await service.list(agentId1);
    expect(rows1).toHaveLength(2);
    expect(rows1.map((r) => r.phase)).toEqual(["deploy", "review"]);

    const rows2 = await service.list(agentId2);
    expect(rows2).toHaveLength(1);
    expect(rows2[0]?.subagentType).toBe("reviewer-b");
  });

  it("upsert() allows the same phase for two different agents independently", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    await service.upsert(agentId1, "patch", "patcher-a");
    await service.upsert(agentId2, "patch", "patcher-b");

    const rows1 = await service.list(agentId1);
    const rows2 = await service.list(agentId2);
    expect(rows1).toHaveLength(1);
    expect(rows1[0]?.subagentType).toBe("patcher-a");
    expect(rows2).toHaveLength(1);
    expect(rows2[0]?.subagentType).toBe("patcher-b");
  });
});
