/**
 * admin/src/agent-patch-author-allowlist.integration.test.ts
 * Integration tests for the Agent.patchAuthorAllowlist column, against a
 * real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 *
 * Mirrors agents-api.integration.test.ts's API round-trip pattern, but for
 * the patchAuthorAllowlist column (DBR-1.1). Unlike the legacy
 * authorAllowlist column (removed in DBR-2.4), this one was added fresh with
 * NOT NULL DEFAULT ARRAY[]::TEXT[] from the start (one migration, no backfill
 * needed) — so there is no NULL-row / NOT NULL-constraint scenario to replay
 * here.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { PrismaClient } from "../prisma/client/index.js";
import { AgentChatTokenService } from "./agent-chat-tokens.ts";
import { AgentCronJobService } from "./agent-cron-jobs.ts";
import { AgentCronRunStatsService } from "./agent-cron-run-stats.ts";
import { AgentCronRunService } from "./agent-cron-runs.ts";
import { AgentEnvService } from "./agent-envs.ts";
import { AgentMemberService } from "./agent-members.ts";
import { AgentPluginService } from "./agent-plugins.ts";
import { NoopAgentProvisioner } from "./agent-provisioner.ts";
import { AgentTokenService } from "./agent-tokens.ts";
import { AgentToolService } from "./agent-tools.ts";
import type { AgentTypeManifestResolver } from "./agent-type-manifest-loader.ts";
import type { AgentTypeManifest } from "./agent-type-registry.ts";
import { AgentWorkQueueService } from "./agent-work-queue.ts";
import { createAdminApp } from "./agents-api.ts";
import type { AdminDeps } from "./agents-api.ts";
import { AgentService } from "./agents.ts";
import { NoopChatServiceProvisioningClient } from "./chat-service-provisioning-client.ts";
import { NoopTaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";
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

const CODING_MANIFEST: AgentTypeManifest = {
  apiVersion: "shipwright.dev/v1alpha1",
  kind: "AgentType",
  metadata: {
    name: "coding",
    displayName: "Coding Agent",
    description: "test manifest",
    version: "1.0.0",
    skills: [],
  },
  identity: { templatesDir: "agent/workspace/" },
  crons: [],
  plugins: ["shipwright"],
  tools: ["Read", "Write", "Edit"],
  env: { required: [], optional: [] },
  members: [],
  repos: [],
  chat: true,
  voice: true,
};

function fakeAgentTypeRegistry(): AgentTypeManifestResolver {
  const byType: Record<string, AgentTypeManifest> = { coding: CODING_MANIFEST };
  return {
    getManifest(typeName: string): AgentTypeManifest {
      return byType[typeName] ?? (byType.coding as AgentTypeManifest);
    },
    tryGetManifest(typeName: string): AgentTypeManifest | undefined {
      return byType[typeName];
    },
    listTypes() {
      return Object.entries(byType).map(([name, manifest]) => ({
        name,
        displayName: manifest.metadata.displayName,
      }));
    },
  };
}

function makeDeps(prisma: PrismaClient): AdminDeps {
  const savedKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
  process.env.SHIPWRIGHT_ENCRYPTION_KEY = REAL_KEY;
  const crypto = makeTokenCrypto();
  process.env.SHIPWRIGHT_ENCRYPTION_KEY = savedKey;

  return {
    agentService: new AgentService(prisma),
    agentEnvService: new AgentEnvService(prisma, crypto),
    agentCronJobService: new AgentCronJobService(prisma),
    agentCronRunService: new AgentCronRunService(prisma),
    agentCronRunStatsService: new AgentCronRunStatsService(prisma),
    agentToolService: new AgentToolService(prisma),
    agentTokenService: new AgentTokenService(prisma),
    agentPluginService: new AgentPluginService(prisma),
    agentMemberService: new AgentMemberService(prisma),
    agentTypeRegistry: fakeAgentTypeRegistry(),
    agentChatTokenService: new AgentChatTokenService(prisma),
    agentWorkQueueService: new AgentWorkQueueService(prisma),
    prisma,
    provisioner: new NoopAgentProvisioner(),
    taskStore: new NoopTaskStoreProvisioningClient(),
    chatService: new NoopChatServiceProvisioningClient(),
    slack: {
      deleteApp: async () => {},
    },
    decrypt: (value: string) => crypto.decrypt(value),
    sessionSecret: SESSION_SECRET,
  };
}

describeOrSkip("Agent.patchAuthorAllowlist (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("defaults to [] for a newly created row", async () => {
    const agent = await prisma.agent.create({
      data: { name: "Default Agent" },
    });
    expect(agent.patchAuthorAllowlist).toEqual([]);
  });

  it("round-trips via PATCH /agents/:id and GET /agents/:id, independent of reviewAuthorAllowlist", async () => {
    const agentId = await prisma.agent
      .create({ data: { name: "Round Trip Agent" } })
      .then((a) => a.id);
    const cookie = await makeSessionCookie();
    const app = createAdminApp(makeDeps(prisma));

    // PATCH sets patchAuthorAllowlist, leaving reviewAuthorAllowlist untouched
    const patchRes = await app.request(`/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify({ patchAuthorAllowlist: ["octocat"] }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.patchAuthorAllowlist).toEqual(["octocat"]);
    expect(patchBody.reviewAuthorAllowlist).toEqual([]);

    // GET confirms persisted value
    const getRes = await app.request(`/agents/${agentId}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.patchAuthorAllowlist).toEqual(["octocat"]);
    expect(getBody.reviewAuthorAllowlist).toEqual([]);

    // Setting reviewAuthorAllowlist afterwards must not disturb patchAuthorAllowlist
    const secondPatchRes = await app.request(`/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify({ reviewAuthorAllowlist: ["hubot"] }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(secondPatchRes.status).toBe(200);
    const secondPatchBody = await secondPatchRes.json();
    expect(secondPatchBody.reviewAuthorAllowlist).toEqual(["hubot"]);
    expect(secondPatchBody.patchAuthorAllowlist).toEqual(["octocat"]);
  });
});
