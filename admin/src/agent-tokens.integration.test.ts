/**
 * agent/src/agent-tokens.integration.test.ts
 * Integration tests for AgentTokenService against a real SQLite DB.
 *
 * Requires DATABASE_URL_AGENT_TEST to be set; skips otherwise.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentTokenService } from "./agent-tokens.ts";
import { UnprocessableEntityError } from "./errors.ts";

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

describeOrSkip("AgentTokenService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentTokenService;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentTokenService(prisma);
  });

  // ─── create ─────────────────────────────────────────────────────────────────

  it("create() returns a token record and a raw token", async () => {
    const agentId = await createAgent(prisma);
    const { token, rawToken } = await service.create(agentId);
    expect(token.agentId).toBe(agentId);
    expect(typeof rawToken).toBe("string");
    expect(rawToken).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(token.revokedAt).toBeNull();
  });

  it("create() stores only the SHA-256 hash (not raw token)", async () => {
    const agentId = await createAgent(prisma);
    const { token, rawToken } = await service.create(agentId);
    // The stored token should NOT be the raw token
    expect(token.token).not.toBe(rawToken);
    // But should be a valid 64-char hex SHA-256 hash
    expect(token.token).toHaveLength(64);
  });

  it("create() accepts an optional label", async () => {
    const agentId = await createAgent(prisma);
    const { token } = await service.create(agentId, "My CI Token");
    expect(token.label).toBe("My CI Token");
  });

  it("create() throws UnprocessableEntityError for unknown agentId", async () => {
    await expect(service.create("nonexistent-id")).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
  });

  // ─── validate ───────────────────────────────────────────────────────────────

  it("validate() returns agentId for a valid token", async () => {
    const agentId = await createAgent(prisma);
    const { rawToken } = await service.create(agentId);
    const result = await service.validate(rawToken);
    expect(result).not.toBeNull();
    expect(result?.agentId).toBe(agentId);
  });

  it("validate() returns null for unknown token", async () => {
    const result = await service.validate("0".repeat(64));
    expect(result).toBeNull();
  });

  it("validate() returns null for a revoked token", async () => {
    const agentId = await createAgent(prisma);
    const { token, rawToken } = await service.create(agentId);
    await service.revoke(token.id);
    const result = await service.validate(rawToken);
    expect(result).toBeNull();
  });

  // ─── revoke ─────────────────────────────────────────────────────────────────

  it("revoke() sets revokedAt on the token", async () => {
    const agentId = await createAgent(prisma);
    const { token } = await service.create(agentId);
    const revoked = await service.revoke(token.id);
    expect(revoked).not.toBeNull();
    expect(revoked?.revokedAt).not.toBeNull();
  });

  it("revoke() returns null for unknown tokenId (P2025)", async () => {
    const result = await service.revoke("nonexistent-id");
    expect(result).toBeNull();
  });

  // ─── listForAgent ────────────────────────────────────────────────────────────

  it("listForAgent() returns all tokens for an agent", async () => {
    const agentId = await createAgent(prisma);
    await service.create(agentId, "Token 1");
    await service.create(agentId, "Token 2");
    const tokens = await service.listForAgent(agentId);
    expect(tokens).toHaveLength(2);
  });

  it("listForAgent() does not return tokens from other agents", async () => {
    const agentId1 = await createAgent(prisma, "Agent 1");
    const agentId2 = await createAgent(prisma, "Agent 2");
    await service.create(agentId1);
    const tokens = await service.listForAgent(agentId2);
    expect(tokens).toHaveLength(0);
  });

  // ─── getById ────────────────────────────────────────────────────────────────

  it("getById() returns a token by ID", async () => {
    const agentId = await createAgent(prisma);
    const { token } = await service.create(agentId);
    const fetched = await service.getById(token.id);
    expect(fetched?.id).toBe(token.id);
  });

  it("getById() returns null for unknown tokenId", async () => {
    const result = await service.getById("nonexistent");
    expect(result).toBeNull();
  });
});
