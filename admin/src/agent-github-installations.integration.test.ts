/**
 * admin/src/agent-github-installations.integration.test.ts
 * Integration tests for AgentGitHubInstallationsService — push/get.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { PrismaClient } from "../prisma/client/client.ts";
import { AgentGitHubInstallationsService } from "./agent-github-installations.ts";
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

describeOrSkip("AgentGitHubInstallationsService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentGitHubInstallationsService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentGitHubInstallationsSnapshot.deleteMany();
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentChatTokenUsageDailyByModel.deleteMany();
    await prisma.agentCronRun.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentGitHubInstallationsService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("push() creates a snapshot and get() reads it back", async () => {
    const agentId = await createAgent(prisma);
    const reportedAt = new Date("2026-01-15T12:00:00.000Z");
    const installations = [
      { owner: "app-vitals", installationId: 1, state: "active" },
    ];

    const written = await service.push(agentId, { reportedAt, installations });
    expect(written.agentId).toBe(agentId);
    expect(written.installations).toEqual(installations);

    const read = await service.get(agentId);
    expect(read?.id).toBe(written.id);
    expect(read?.reportedAt).toEqual(reportedAt);
  });

  it("get() returns null when nothing has been pushed", async () => {
    const agentId = await createAgent(prisma);
    expect(await service.get(agentId)).toBeNull();
  });

  it("a second push replaces the first, removing a dropped installation", async () => {
    const agentId = await createAgent(prisma);
    const first = await service.push(agentId, {
      reportedAt: new Date("2026-01-15T12:00:00.000Z"),
      installations: [
        { owner: "a", installationId: 1, state: "active" },
        { owner: "b", installationId: 2, state: "active" },
      ],
    });
    const second = await service.push(agentId, {
      reportedAt: new Date("2026-01-16T12:00:00.000Z"),
      installations: [{ owner: "a", installationId: 1, state: "active" }],
    });

    expect(second.id).toBe(first.id);
    const read = await service.get(agentId);
    expect(read?.installations).toEqual([
      { owner: "a", installationId: 1, state: "active" },
    ]);
    expect(
      await prisma.agentGitHubInstallationsSnapshot.count({
        where: { agentId },
      }),
    ).toBe(1);
  });

  it("the snapshot row is deleted when the agent is deleted", async () => {
    const agentId = await createAgent(prisma);
    await service.push(agentId, {
      reportedAt: new Date(),
      installations: [],
    });

    await prisma.agent.delete({ where: { id: agentId } });

    expect(
      await prisma.agentGitHubInstallationsSnapshot.count({
        where: { agentId },
      }),
    ).toBe(0);
  });
});
