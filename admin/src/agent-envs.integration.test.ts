/**
 * agent/src/agent-envs.integration.test.ts
 * Integration tests for AgentEnvService against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentEnvService } from "./agent-envs.ts";
import { UnprocessableEntityError } from "./errors.ts";
import { identityCrypto } from "./token-crypto.ts";

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

describeOrSkip("AgentEnvService (integration)", () => {
  let prisma: PrismaClient;
  let service: AgentEnvService;

  beforeEach(async () => {
    prisma = makePrisma();
    // Clean all tables in FK dependency order
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();
    service = new AgentEnvService(prisma, identityCrypto);
  });

  it("upsert() writes values and getByAgentId() returns them", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, { FOO: "bar", BAZ: "qux" });
    const result = await service.getByAgentId(agentId);
    expect(result).not.toBeNull();
    expect(result?.env).toEqual({ FOO: "bar", BAZ: "qux" });
    expect(result?.secretKeys).toEqual([]);
  });

  it("upsert() replaces all existing vars (delete + insert)", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, { FOO: "bar", OLD: "value" });
    await service.upsert(agentId, { FOO: "new", FRESH: "yes" });
    const result = await service.getByAgentId(agentId);
    expect(result).not.toBeNull();
    expect(result?.env).toEqual({ FOO: "new", FRESH: "yes" });
    expect(result?.env).not.toHaveProperty("OLD");
  });

  it("upsert() encrypts values (round-trip with real crypto)", async () => {
    // Use a real crypto instead of identity to verify encrypt→decrypt round-trip
    const { makeTokenCrypto } = await import("./token-crypto.ts");
    const realKey =
      "0000000000000000000000000000000000000000000000000000000000000001";
    const origKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = realKey;
    const realCrypto = makeTokenCrypto();

    try {
      const encService = new AgentEnvService(prisma, realCrypto);
      const agentId = await createAgent(prisma);
      await encService.upsert(agentId, { SECRET: "my-api-key" });

      // Raw DB value should be encrypted (not plain text)
      const raw = await prisma.agentEnv.findFirst({
        where: { agentId, key: "SECRET" },
      });
      expect(raw?.value).not.toBe("my-api-key");
      expect(raw?.value).toContain(":"); // iv:ciphertext:authTag format

      // But getByAgentId should return decrypted (not secret-flagged, so not masked)
      const result = await encService.getByAgentId(agentId);
      expect(result?.env.SECRET).toBe("my-api-key");
    } finally {
      process.env.SHIPWRIGHT_ENCRYPTION_KEY =
        origKey === undefined ? undefined : origKey;
    }
  });

  it("upsert() throws UnprocessableEntityError for unknown agent", async () => {
    await expect(
      service.upsert("nonexistent-id", { FOO: "bar" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });

  it("patch() upserts specific keys without touching others", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, { A: "1", B: "2" });
    await service.patch(agentId, { B: "updated", C: "new" });
    const result = await service.getByAgentId(agentId);
    expect(result).not.toBeNull();
    expect(result?.env).toEqual({ A: "1", B: "updated", C: "new" });
  });

  it("patch() throws UnprocessableEntityError for unknown agent", async () => {
    await expect(
      service.patch("nonexistent-id", { FOO: "bar" }),
    ).rejects.toBeInstanceOf(UnprocessableEntityError);
  });

  it("getByAgentId() returns null when no env vars set", async () => {
    const agentId = await createAgent(prisma);
    const result = await service.getByAgentId(agentId);
    expect(result).toBeNull();
  });

  it("getConfigBundle() returns env and agentId and allowedTools", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, { SLACK_BOT_TOKEN: "xoxb-test" });

    const bundle = await service.getConfigBundle(agentId);
    expect(bundle).not.toBeNull();
    expect(bundle?.env.SLACK_BOT_TOKEN).toBe("xoxb-test");
    expect(bundle?.agentId).toBe(agentId);
    expect(Array.isArray(bundle?.allowedTools)).toBe(true);
  });

  it("getConfigBundle() returns null when no env vars", async () => {
    const agentId = await createAgent(prisma);
    const bundle = await service.getConfigBundle(agentId);
    expect(bundle).toBeNull();
  });

  it("getConfigBundle() includes enabled tools in allowedTools", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, { FOO: "bar" });
    await prisma.agentTool.create({
      data: { agentId, pattern: "Read", enabled: true },
    });
    await prisma.agentTool.create({
      data: { agentId, pattern: "Bash", enabled: false },
    });

    const bundle = await service.getConfigBundle(agentId);
    expect(bundle?.allowedTools).toContain("Read");
    expect(bundle?.allowedTools).not.toContain("Bash");
  });

  it("deleteKey() removes a specific env var", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, { A: "1", B: "2" });
    await service.deleteKey(agentId, "A");
    const result = await service.getByAgentId(agentId);
    expect(result).not.toBeNull();
    expect(result?.env).toEqual({ B: "2" });
  });

  it("deleteKey() no-ops for a key that doesn't exist", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, { B: "2" });
    await expect(
      service.deleteKey(agentId, "MISSING"),
    ).resolves.toBeUndefined();
  });

  it("listAll() returns entries for all agents", async () => {
    const id1 = await createAgent(prisma, "Agent 1");
    const id2 = await createAgent(prisma, "Agent 2");
    await service.upsert(id1, { KEY: "val1" });
    await service.upsert(id2, { KEY: "val2" });

    const all = await service.listAll();
    expect(all).toHaveLength(2);
    const entry1 = all.find((e) => e.agentId === id1);
    const entry2 = all.find((e) => e.agentId === id2);
    expect(entry1?.env.KEY).toBe("val1");
    expect(entry2?.env.KEY).toBe("val2");
  });

  // ─── Secret flag tests ────────────────────────────────────────────────────

  it("upsert() with secret=true masks value in getByAgentId() response", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(
      agentId,
      { MY_SECRET: "supersecret", PLAIN: "visible" },
      new Set(["MY_SECRET"]),
    );
    const result = await service.getByAgentId(agentId);
    expect(result).not.toBeNull();
    expect(result?.env.MY_SECRET).toBe("***");
    expect(result?.env.PLAIN).toBe("visible");
    expect(result?.secretKeys).toContain("MY_SECRET");
    expect(result?.secretKeys).not.toContain("PLAIN");
  });

  it("upsert() with secret=false returns real value in getByAgentId() response", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, { MY_KEY: "realvalue" });
    const result = await service.getByAgentId(agentId);
    expect(result).not.toBeNull();
    expect(result?.env.MY_KEY).toBe("realvalue");
    expect(result?.secretKeys).toEqual([]);
  });

  it("getConfigBundle() always decrypts regardless of secret flag", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(
      agentId,
      { MY_SECRET: "supersecret", PLAIN: "visible" },
      new Set(["MY_SECRET"]),
    );
    const bundle = await service.getConfigBundle(agentId);
    expect(bundle).not.toBeNull();
    // Config bundle always returns real values — no masking
    expect(bundle?.env.MY_SECRET).toBe("supersecret");
    expect(bundle?.env.PLAIN).toBe("visible");
  });

  it("patch() with secretKeys updates secret flag", async () => {
    const agentId = await createAgent(prisma);
    await service.upsert(agentId, { A: "1", B: "2" });
    // Patch B as secret
    await service.patch(agentId, { B: "newsecret" }, new Set(["B"]));
    const result = await service.getByAgentId(agentId);
    expect(result).not.toBeNull();
    expect(result?.env.A).toBe("1");
    expect(result?.env.B).toBe("***");
    expect(result?.secretKeys).toContain("B");
    expect(result?.secretKeys).not.toContain("A");
  });
});
