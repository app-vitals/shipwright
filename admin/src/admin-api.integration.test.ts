/**
 * agent/src/admin-api.integration.test.ts
 * Integration tests for the admin CRUD API against a real SQLite DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 *
 * Key assertions:
 * - POST /admin/api/agents/:id/envs encrypts values at rest
 * - POST /admin/api/agents/:id/tokens stores hash not raw token
 * - GET /tokens shows hash metadata only (no rawToken)
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { PrismaClient } from "../prisma/client/index.js";
import { createAdminApp } from "./admin-api.ts";
import type { AdminDeps } from "./admin-api.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import { makeTokenCrypto } from "./token-crypto.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const REAL_KEY =
  "0000000000000000000000000000000000000000000000000000000000000001";

async function makeSessionCookie(): Promise<string> {
  return sign(
    {
      userId: "user-123",
      email: "admin@example.com",
      name: "Admin User",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    SESSION_SECRET,
    "HS256",
  );
}

function makePrisma(): PrismaClient {
  return new PrismaClient({
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

describeOrSkip("admin CRUD API (integration)", () => {
  let prisma: PrismaClient;
  let agentId: string;
  let cookie: string;
  let app: ReturnType<typeof createAdminApp>;

  beforeEach(async () => {
    prisma = makePrisma();

    // Clean all tables in FK dependency order
    await prisma.agentPlugin.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agent.deleteMany();

    agentId = await createAgent(prisma);
    cookie = await makeSessionCookie();

    // Set up crypto for the env service
    const savedKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = REAL_KEY;
    const crypto = makeTokenCrypto();
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = savedKey;

    const deps: AdminDeps = {
      agentEnvService: new AgentEnvService(prisma, crypto),
      agentCronJobService: new AgentCronJobService(prisma),
      agentToolService: new AgentToolService(prisma),
      agentTokenService: new AgentTokenService(prisma),
      agentPluginService: new AgentPluginService(prisma),
      sessionSecret: SESSION_SECRET,
    };

    app = createAdminApp(deps);
  });

  // ─── Env var encryption ───────────────────────────────────────────────────────

  it("POST /envs encrypts values at rest — raw DB value differs from input", async () => {
    const savedKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = REAL_KEY;

    try {
      const res = await app.request(`/admin/api/agents/${agentId}/envs`, {
        method: "POST",
        body: JSON.stringify({ SECRET: "my-api-key" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      });
      expect(res.status).toBe(200);

      // Raw DB value should be encrypted (not plain text)
      const raw = await prisma.agentEnv.findFirst({
        where: { agentId, key: "SECRET" },
      });
      expect(raw?.value).not.toBe("my-api-key");
      expect(raw?.value).toContain(":"); // iv:ciphertext:authTag format
    } finally {
      process.env.SHIPWRIGHT_ENCRYPTION_KEY = savedKey;
    }
  });

  it("GET /envs returns decrypted values", async () => {
    const savedKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = REAL_KEY;

    try {
      // First write via POST
      await app.request(`/admin/api/agents/${agentId}/envs`, {
        method: "POST",
        body: JSON.stringify({ SECRET: "my-api-key" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      });

      // Then read via GET
      const res = await app.request(`/admin/api/agents/${agentId}/envs`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.env.SECRET).toBe("my-api-key");
    } finally {
      process.env.SHIPWRIGHT_ENCRYPTION_KEY = savedKey;
    }
  });

  // ─── Token hash storage ───────────────────────────────────────────────────────

  it("POST /tokens stores hash not raw token; GET /tokens shows hash metadata only", async () => {
    const res = await app.request(`/admin/api/agents/${agentId}/tokens`, {
      method: "POST",
      body: JSON.stringify({ label: "ci-token" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);

    const createBody = await res.json();
    const rawToken: string = createBody.rawToken;
    expect(typeof rawToken).toBe("string");
    expect(rawToken.length).toBeGreaterThan(0);

    // Verify the stored token is a hash, not the raw token
    const dbRecord = await prisma.agentToken.findFirst({
      where: { agentId },
    });
    expect(dbRecord).not.toBeNull();
    expect(dbRecord?.token).not.toBe(rawToken);
    // SHA-256 hash is 64 hex chars
    expect(dbRecord?.token).toHaveLength(64);

    // GET /tokens should not expose rawToken
    const listRes = await app.request(`/admin/api/agents/${agentId}/tokens`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(Array.isArray(listBody.tokens)).toBe(true);
    expect(listBody.tokens).toHaveLength(1);
    // rawToken must NOT be present in the list response
    const listedToken = listBody.tokens[0];
    expect(listedToken.rawToken).toBeUndefined();
    // The stored hash value should also not be exposed
    expect(listedToken.token).toBeUndefined();
    expect(listedToken.id).toBe(dbRecord?.id);
  });
});
