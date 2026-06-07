/**
 * agent/src/agent-tools.integration.test.ts
 * Integration tests for AgentToolService against a real SQLite DB.
 *
 * Requires DATABASE_URL_AGENT_TEST to be set; skips otherwise.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentToolService } from "./agent-tools.ts";
import { NotFoundError } from "./errors.ts";

const TEST_DB = process.env.DATABASE_URL_AGENT_TEST;

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

describeOrSkip("AgentToolService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentToolService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentToolService(prisma);
  });

  it("add() creates a new tool pattern", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "Read");
    expect(tool.agentId).toBe(agentId);
    expect(tool.pattern).toBe("Read");
    expect(tool.enabled).toBe(true);
  });

  it("add() re-enables a disabled pattern (upsert behavior)", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "Write");
    await service.toggle(agentId, tool.id, false);
    // Re-add should re-enable it
    const reenabled = await service.add(agentId, "Write");
    expect(reenabled.enabled).toBe(true);
  });

  it("list() returns all tools for an agent ordered by createdAt", async () => {
    const agentId = await createAgent(prisma);
    await service.add(agentId, "Read");
    await service.add(agentId, "Write");
    await service.add(agentId, "Bash");
    const tools = await service.list(agentId);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.pattern)).toEqual(["Read", "Write", "Bash"]);
  });

  it("remove() deletes a tool pattern", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "Bash");
    await service.remove(agentId, tool.id);
    const tools = await service.list(agentId);
    expect(tools).toHaveLength(0);
  });

  it("remove() throws NotFoundError for unknown toolId", async () => {
    const agentId = await createAgent(prisma);
    await expect(service.remove(agentId, "nonexistent")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("remove() throws NotFoundError when toolId belongs to a different agent", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    const tool = await service.add(agentId1, "Read");
    await expect(service.remove(agentId2, tool.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("toggle() enables and disables a tool", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "Write");
    const disabled = await service.toggle(agentId, tool.id, false);
    expect(disabled.enabled).toBe(false);
    const enabled = await service.toggle(agentId, tool.id, true);
    expect(enabled.enabled).toBe(true);
  });

  it("toggle() throws NotFoundError for unknown toolId", async () => {
    const agentId = await createAgent(prisma);
    await expect(
      service.toggle(agentId, "nonexistent", true),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("updatePattern() changes the pattern string", async () => {
    const agentId = await createAgent(prisma);
    const tool = await service.add(agentId, "OldPattern");
    const updated = await service.updatePattern(agentId, tool.id, "NewPattern");
    expect(updated.pattern).toBe("NewPattern");
  });

  it("updatePattern() throws NotFoundError for unknown toolId", async () => {
    const agentId = await createAgent(prisma);
    await expect(
      service.updatePattern(agentId, "nonexistent", "Read"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
