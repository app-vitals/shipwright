/**
 * admin/src/agent-anthropic-identity.integration.test.ts
 * Integration tests for the PAI-1.1 owner / Anthropic identity columns on
 * Agent against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentAnthropicIdentityService } from "./agent-anthropic-identity.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { createAdminPrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createAdminPrismaClient(TEST_DB as string);
}

describeOrSkip("AgentAnthropicIdentityService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentAnthropicIdentityService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentPhaseMethodology.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentAnthropicIdentityService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("a newly created agent has null identity fields", async () => {
    const agent = await prisma.agent.create({ data: { name: "A" } });
    expect(await service.get(agent.id)).toEqual({
      ownerEmail: null,
      anthropicIdentityName: null,
      anthropicServiceAccountId: null,
      anthropicFederationRuleId: null,
      k8sServiceAccountName: null,
    });
  });

  it("set() round-trips and supports partial updates", async () => {
    const agent = await prisma.agent.create({ data: { name: "A" } });
    await service.set(agent.id, {
      ownerEmail: "o@example.com",
      anthropicIdentityName: "agent-a",
      anthropicServiceAccountId: "sa_1",
      anthropicFederationRuleId: "fr_1",
      k8sServiceAccountName: "agent-a-sa",
    });
    await service.set(agent.id, { ownerEmail: null });
    expect(await service.get(agent.id)).toEqual({
      ownerEmail: null,
      anthropicIdentityName: "agent-a",
      anthropicServiceAccountId: "sa_1",
      anthropicFederationRuleId: "fr_1",
      k8sServiceAccountName: "agent-a-sa",
    });
  });

  it("rejects a duplicate anthropicIdentityName with ConflictError", async () => {
    const a = await prisma.agent.create({ data: { name: "A" } });
    const b = await prisma.agent.create({ data: { name: "B" } });
    await service.set(a.id, { anthropicIdentityName: "dup" });
    await expect(
      service.set(b.id, { anthropicIdentityName: "dup" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("the unique index also rejects duplicates at the DB level", async () => {
    await prisma.agent.create({
      data: { name: "A", anthropicIdentityName: "dup" },
    });
    await expect(
      (async () =>
        prisma.agent.create({
          data: { name: "B", anthropicIdentityName: "dup" },
        }))(),
    ).rejects.toThrow();
  });

  it("set() throws NotFoundError for an unknown agent", async () => {
    await expect(
      service.set("missing", { ownerEmail: "x@example.com" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
