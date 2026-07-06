/**
 * agent/src/agent-plugins.integration.test.ts
 * Integration tests for AgentPluginService against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentPluginService } from "./agent-plugins.ts";
import { NotFoundError } from "./errors.ts";

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

describeOrSkip("AgentPluginService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentPluginService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentPluginService(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("add() creates a new plugin", async () => {
    const agentId = await createAgent(prisma);
    const plugin = await service.add(agentId, "shipwright@shipwright");
    expect(plugin.agentId).toBe(agentId);
    expect(plugin.name).toBe("shipwright@shipwright");
    expect(plugin.version).toBeNull();
    expect(plugin.enabled).toBe(true);
  });

  it("add() accepts an optional version", async () => {
    const agentId = await createAgent(prisma);
    const plugin = await service.add(agentId, "shipwright@shipwright", "1.2.3");
    expect(plugin.version).toBe("1.2.3");
  });

  it("add() re-adding an existing plugin updates version and re-enables it (upsert)", async () => {
    const agentId = await createAgent(prisma);
    const plugin = await service.add(agentId, "shipwright@shipwright", "1.0.0");
    await service.remove(agentId, plugin.id);
    // After remove, re-adding creates a fresh row (unique constraint no longer occupied)
    const recreated = await service.add(
      agentId,
      "shipwright@shipwright",
      "2.0.0",
    );
    expect(recreated.version).toBe("2.0.0");
    expect(recreated.enabled).toBe(true);
  });

  it("add() upserts in place when called twice without removal", async () => {
    const agentId = await createAgent(prisma);
    const first = await service.add(agentId, "shipwright@shipwright", "1.0.0");
    const second = await service.add(agentId, "shipwright@shipwright", "2.0.0");
    expect(second.id).toBe(first.id);
    expect(second.version).toBe("2.0.0");
    expect(second.enabled).toBe(true);
  });

  it("list() returns all plugins for an agent ordered by createdAt", async () => {
    const agentId = await createAgent(prisma);
    await service.add(agentId, "plugin-a@shipwright");
    await service.add(agentId, "plugin-b@shipwright");
    await service.add(agentId, "plugin-c@shipwright");
    const plugins = await service.list(agentId);
    expect(plugins).toHaveLength(3);
    expect(plugins.map((p) => p.name)).toEqual([
      "plugin-a@shipwright",
      "plugin-b@shipwright",
      "plugin-c@shipwright",
    ]);
  });

  it("list() does not return plugins from other agents", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    await service.add(agentId1, "plugin-a@shipwright");
    const plugins = await service.list(agentId2);
    expect(plugins).toHaveLength(0);
  });

  it("remove() deletes a plugin by ID", async () => {
    const agentId = await createAgent(prisma);
    const plugin = await service.add(agentId, "shipwright@shipwright");
    await service.remove(agentId, plugin.id);
    const plugins = await service.list(agentId);
    expect(plugins).toHaveLength(0);
  });

  it("remove() throws NotFoundError for unknown pluginId", async () => {
    const agentId = await createAgent(prisma);
    await expect(service.remove(agentId, "nonexistent")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("remove() throws NotFoundError when pluginId belongs to a different agent", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    const plugin = await service.add(agentId1, "shipwright@shipwright");
    await expect(service.remove(agentId2, plugin.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("removeByName() deletes a plugin by name", async () => {
    const agentId = await createAgent(prisma);
    await service.add(agentId, "shipwright@shipwright");
    await service.removeByName(agentId, "shipwright@shipwright");
    const plugins = await service.list(agentId);
    expect(plugins).toHaveLength(0);
  });

  it("removeByName() throws NotFoundError for unknown name", async () => {
    const agentId = await createAgent(prisma);
    await expect(
      service.removeByName(agentId, "nonexistent@shipwright"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("removeByName() throws NotFoundError when the name belongs to a different agent", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    await service.add(agentId1, "shipwright@shipwright");
    await expect(
      service.removeByName(agentId2, "shipwright@shipwright"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
