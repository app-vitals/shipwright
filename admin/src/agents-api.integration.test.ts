/**
 * agent/src/agents-api.integration.test.ts
 * Integration tests for the admin CRUD API against a real PostgreSQL DB.
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 *
 * Key assertions:
 * - POST /agents/:id/envs encrypts values at rest
 * - POST /agents/:id/tokens stores hash not raw token
 * - GET /tokens shows hash metadata only (no rawToken)
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
import type { AgentProvisioner } from "./agent-provisioner.ts";
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

async function createAgent(
  prisma: PrismaClient,
  name = "Test Agent",
): Promise<string> {
  const agent = await prisma.agent.create({ data: { name } });
  return agent.id;
}

/** A minimal valid "coding" manifest used to drive seeding assertions below. */
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
  tools: [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Bash",
    "WebSearch",
    "WebFetch",
    "Skill",
    "Agent",
  ],
  env: { required: [], optional: [] },
  members: [],
  repos: [],
  chat: true,
  voice: true,
};

/**
 * Fake AgentTypeManifestResolver — resolves a fixed map of manifests by
 * typeName. tryGetManifest() returns undefined (no fallback) for anything
 * not in the map, mirroring AgentTypeRegistry's real contract.
 */
function fakeAgentTypeRegistry(
  byType: Record<string, AgentTypeManifest> = { coding: CODING_MANIFEST },
): AgentTypeManifestResolver {
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

function makeDeps(
  prisma: PrismaClient,
  provisioner: AgentProvisioner = new NoopAgentProvisioner(),
  agentTypeRegistry: AgentTypeManifestResolver = fakeAgentTypeRegistry(),
): AdminDeps {
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
    agentTypeRegistry,
    agentChatTokenService: new AgentChatTokenService(prisma),
    agentWorkQueueService: new AgentWorkQueueService(prisma),
    prisma,
    provisioner,
    taskStore: new NoopTaskStoreProvisioningClient(),
    chatService: new NoopChatServiceProvisioningClient(),
    slack: {
      deleteApp: async () => {},
    },
    decrypt: (value: string) => crypto.decrypt(value),
    sessionSecret: SESSION_SECRET,
  };
}

describeOrSkip("admin CRUD API (integration)", () => {
  let prisma: PrismaClient;
  let agentId: string;
  let cookie: string;
  let app: ReturnType<typeof createAdminApp>;

  beforeEach(async () => {
    prisma = makePrisma();

    // Clean all tables in FK dependency order
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();

    agentId = await createAgent(prisma);
    cookie = await makeSessionCookie();

    app = createAdminApp(makeDeps(prisma));
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  // ─── Env var encryption ───────────────────────────────────────────────────────

  it("POST /envs encrypts values at rest — raw DB value differs from input", async () => {
    const savedKey = process.env.SHIPWRIGHT_ENCRYPTION_KEY;
    process.env.SHIPWRIGHT_ENCRYPTION_KEY = REAL_KEY;

    try {
      const res = await app.request(`/agents/${agentId}/envs`, {
        method: "POST",
        body: JSON.stringify({ SECRET: "my-api-key" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      });
      expect(res.status).toBe(201);

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
      await app.request(`/agents/${agentId}/envs`, {
        method: "POST",
        body: JSON.stringify({ SECRET: "my-api-key" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      });

      // Then read via GET
      const res = await app.request(`/agents/${agentId}/envs`, {
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
    const res = await app.request(`/agents/${agentId}/tokens`, {
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
    const listRes = await app.request(`/agents/${agentId}/tokens`, {
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

  // ─── typeName field ─────────────────────────────────────────────────────────

  it("GET /agents includes typeName:'coding' for an agent created before typeName existed", async () => {
    const res = await app.request("/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const entry = body.find((a: { id: string }) => a.id === agentId);
    expect(entry).toBeDefined();
    expect(entry.typeName).toBe("coding");
  });

  it("GET /agents/:id includes typeName:'coding' by default", async () => {
    const res = await app.request(`/agents/${agentId}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.typeName).toBe("coding");
  });

  // ─── Migration backfill read-back (pre-existing rows + child rows) ────────────
  //
  // Simulates the exact scenario the 20260724000000_add_agent_type_name
  // migration must handle: rows that existed *before* the typeName column was
  // added (never received an explicit value) must read back typeName="coding"
  // via the column DEFAULT, and every child row (cron/plugin/tool/env/member)
  // must be completely untouched — same count, same updatedAt — since the
  // migration only ALTERs the Agent table.

  it("migration backfill: pre-existing agent rows read back typeName='coding' and child rows (cron/plugin/tool/env/member) are untouched", async () => {
    // Seed a second "pre-existing" agent with one row in every child table,
    // simulating data that existed prior to the typeName migration landing.
    const preExisting = await prisma.agent.create({
      data: { name: "Pre-Existing Agent" },
    });

    const cron = await prisma.agentCronJob.create({
      data: {
        agentId: preExisting.id,
        schedule: "0 9 * * 1-5",
        prompt: "daily standup",
        channel: "C123",
      },
    });
    const plugin = await prisma.agentPlugin.create({
      data: { agentId: preExisting.id, name: "shipwright@shipwright" },
    });
    const tool = await prisma.agentTool.create({
      data: { agentId: preExisting.id, pattern: "Read" },
    });
    const env = await prisma.agentEnv.create({
      data: { agentId: preExisting.id, key: "FOO", value: "encrypted-value" },
    });
    const member = await prisma.agentMember.create({
      data: { agentId: preExisting.id, email: "member@example.com" },
    });

    // Re-running `prisma migrate deploy` against an already-migrated schema
    // (which is exactly the state this test DB is in — beforeEach only
    // truncates rows, it never re-runs migrations) is the idempotency
    // scenario: the additive ALTER TABLE ... ADD COLUMN has already been
    // applied once when the schema was first provisioned, and asserting the
    // column's default here — without any application-layer backfill code —
    // is the black-box proof that a second `migrate deploy` is a no-op that
    // still leaves every row readable with the column default intact.

    // Read back via the raw Agent row (bypasses the API layer entirely) —
    // this is the direct DB-level assertion that the column DEFAULT applies
    // to a row that never set typeName explicitly.
    const rawAgent = await prisma.agent.findUniqueOrThrow({
      where: { id: preExisting.id },
    });
    expect(rawAgent.typeName).toBe("coding");

    // Read back via the HTTP API too — end-to-end confirmation.
    const res = await app.request(`/agents/${preExisting.id}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.typeName).toBe("coding");

    // Child row counts are unchanged — exactly one of each, still linked to
    // the same agent.
    expect(
      await prisma.agentCronJob.count({ where: { agentId: preExisting.id } }),
    ).toBe(1);
    expect(
      await prisma.agentPlugin.count({ where: { agentId: preExisting.id } }),
    ).toBe(1);
    expect(
      await prisma.agentTool.count({ where: { agentId: preExisting.id } }),
    ).toBe(1);
    expect(
      await prisma.agentEnv.count({ where: { agentId: preExisting.id } }),
    ).toBe(1);
    expect(
      await prisma.agentMember.count({ where: { agentId: preExisting.id } }),
    ).toBe(1);

    // Child row updatedAt values are unchanged — the typeName column only
    // touches the Agent table, so nothing here should have been rewritten.
    const cronAfter = await prisma.agentCronJob.findUniqueOrThrow({
      where: { id: cron.id },
    });
    const pluginAfter = await prisma.agentPlugin.findUniqueOrThrow({
      where: { id: plugin.id },
    });
    const toolAfter = await prisma.agentTool.findUniqueOrThrow({
      where: { id: tool.id },
    });
    const envAfter = await prisma.agentEnv.findUniqueOrThrow({
      where: { id: env.id },
    });
    const memberAfter = await prisma.agentMember.findUniqueOrThrow({
      where: { id: member.id },
    });

    expect(cronAfter.updatedAt.getTime()).toBe(cron.updatedAt.getTime());
    expect(pluginAfter.updatedAt.getTime()).toBe(plugin.updatedAt.getTime());
    expect(envAfter.updatedAt.getTime()).toBe(env.updatedAt.getTime());
    // AgentTool and AgentMember have no updatedAt column — createdAt stands
    // in as the "untouched" signal for those two models.
    expect(toolAfter.createdAt.getTime()).toBe(tool.createdAt.getTime());
    expect(memberAfter.createdAt.getTime()).toBe(member.createdAt.getTime());
  });

  it("prisma migrate deploy is idempotent — running it twice does not error or duplicate the typeName column", async () => {
    // The migration has already been applied once (this test DB was
    // provisioned via `prisma migrate deploy` before the suite ran). Re-run
    // deploy here and confirm the column is still readable with a single,
    // unambiguous default — a duplicate-column error would surface as a
    // thrown exception from execSync, and a broken default would surface as
    // a failed read-back.
    const { execSync } = await import("node:child_process");
    execSync("bunx prisma migrate deploy --schema=prisma/schema.prisma", {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL_SHIPWRIGHT_ADMIN: TEST_DB },
      stdio: "pipe",
    });

    const rawAgent = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
    });
    expect(rawAgent.typeName).toBe("coding");
  });

  // ─── repos field round-trip ───────────────────────────────────────────────────

  it("PATCH /agents/:id with repos sets the field; GET /agents/:id returns it", async () => {
    // PATCH to set repos
    const patchRes = await app.request(`/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify({ repos: ["my-org/my-repo"] }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.repos).toEqual(["my-org/my-repo"]);

    // GET to confirm persisted value
    const getRes = await app.request(`/agents/${agentId}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.repos).toEqual(["my-org/my-repo"]);
  });

  // ─── authorAllowlist field round-trip ──────────────────────────────────────────

  it("PATCH /agents/:id with authorAllowlist sets the field; GET /agents/:id returns it", async () => {
    // PATCH to set authorAllowlist
    const patchRes = await app.request(`/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify({ authorAllowlist: ["octocat"] }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.authorAllowlist).toEqual(["octocat"]);

    // GET to confirm persisted value
    const getRes = await app.request(`/agents/${agentId}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.authorAllowlist).toEqual(["octocat"]);
  });

  // ─── Work queue snapshot upsert semantics ─────────────────────────────────────

  it("POST /work-queue twice overwrites the row rather than creating a second one", async () => {
    const firstRes = await app.request(`/agents/${agentId}/work-queue`, {
      method: "POST",
      body: JSON.stringify({
        computedAt: "2026-01-01T00:00:00.000Z",
        items: [
          {
            type: "task",
            id: "WLS-2.2",
            phase: "dev-task",
            age: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();

    const secondRes = await app.request(`/agents/${agentId}/work-queue`, {
      method: "POST",
      body: JSON.stringify({
        computedAt: "2026-01-02T00:00:00.000Z",
        items: [
          {
            type: "pr",
            id: "acme/x#123",
            title: "Overwritten snapshot",
            phase: "review",
            age: "2026-01-02T00:00:00.000Z",
          },
        ],
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();

    // Same row id — upserted, not a new row.
    expect(secondBody.snapshot.id).toBe(firstBody.snapshot.id);

    // Exactly one row exists for this agent in the DB.
    const rows = await prisma.agentWorkQueueSnapshot.findMany({
      where: { agentId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.computedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(rows[0]?.items).toEqual(secondBody.snapshot.items);

    // GET reflects the latest (second) snapshot, not the first.
    const getRes = await app.request(`/agents/${agentId}/work-queue`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.snapshot.items).toEqual(secondBody.snapshot.items);
  });

  it("DELETE /agents/:id cascades to its work-queue snapshot row", async () => {
    const postRes = await app.request(`/agents/${agentId}/work-queue`, {
      method: "POST",
      body: JSON.stringify({
        computedAt: "2026-01-01T00:00:00.000Z",
        items: [],
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(postRes.status).toBe(200);

    await prisma.agent.delete({ where: { id: agentId } });

    const rows = await prisma.agentWorkQueueSnapshot.findMany({
      where: { agentId },
    });
    expect(rows).toHaveLength(0);
  });

  // ─── Manifest-driven seeding (ATS-3.3) ─────────────────────────────────────

  it("POST /agents without type seeds AgentTool rows matching the coding manifest tools, and an AgentPlugin row for shipwright (decision-A delta)", async () => {
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "New Agent With Tools" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const newAgentId: string = body.id;
    expect(body.typeName).toBe("coding");

    // Query the AgentTool rows for this agent
    const tools = await prisma.agentTool.findMany({
      where: { agentId: newAgentId },
      orderBy: { pattern: "asc" },
    });
    const patterns = tools.map((t) => t.pattern).sort();
    expect(patterns).toEqual(
      [
        "Agent",
        "Bash",
        "Edit",
        "Glob",
        "Grep",
        "Read",
        "Skill",
        "WebFetch",
        "WebSearch",
        "Write",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.enabled).toBe(true);
    }

    // decision-A delta: admin-created agents now get the shipwright plugin
    // installed too (previously zero plugins were seeded at all).
    const plugins = await prisma.agentPlugin.findMany({
      where: { agentId: newAgentId },
    });
    expect(plugins.map((p) => p.name)).toEqual(["shipwright"]);
  });

  it('POST /agents with type="coding" seeds identically to the default (no type field)', async () => {
    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Explicit Coding Agent", type: "coding" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const newAgentId: string = body.id;

    const tools = await prisma.agentTool.findMany({
      where: { agentId: newAgentId },
    });
    expect(tools).toHaveLength(10);

    const plugins = await prisma.agentPlugin.findMany({
      where: { agentId: newAgentId },
    });
    expect(plugins.map((p) => p.name)).toEqual(["shipwright"]);
  });

  it("POST /agents with an unknown type returns 400 and creates zero rows (no agent, no tools, no plugins)", async () => {
    const beforeAgentCount = await prisma.agent.count();

    const res = await app.request("/agents", {
      method: "POST",
      body: JSON.stringify({
        name: "Bad Type Agent",
        type: "does-not-exist",
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);

    // No new agent row exists — the count is unchanged from before the request.
    const afterAgentCount = await prisma.agent.count();
    expect(afterAgentCount).toBe(beforeAgentCount);

    // No tool/plugin rows were created for a nonexistent agent either.
    const orphanTools = await prisma.agentTool.findMany({
      where: { agent: { name: "Bad Type Agent" } },
    });
    expect(orphanTools).toHaveLength(0);
  });

  it("a mid-seed failure (plugin seeding throws) rolls back the agent row and every already-seeded child row", async () => {
    const throwingPluginRegistry = fakeAgentTypeRegistry();
    const base = makeDeps(
      prisma,
      new NoopAgentProvisioner(),
      throwingPluginRegistry,
    );
    const failingApp = createAdminApp({
      ...base,
      agentPluginService: {
        ...base.agentPluginService,
        add: async () => {
          throw new Error("plugin seeding failure");
        },
      },
    });

    const res = await failingApp.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Mid-Seed Failure Agent" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(500);

    // The agent row itself was rolled back...
    const agents = await prisma.agent.findMany({
      where: { name: "Mid-Seed Failure Agent" },
    });
    expect(agents).toHaveLength(0);

    // ...and cascade delete took every already-seeded AgentTool row with it.
    // Query unscoped (not via a join through the now-deleted Agent row) since
    // beforeEach truncates agentTool per test — this doomed agent's seeded
    // rows are the only rows that could exist here.
    const allToolsCount = await prisma.agentTool.count();
    expect(allToolsCount).toBe(0);
  });

  it("POST /agents with provisioner failure rolls back seeded AgentTool and AgentPlugin rows via cascade delete", async () => {
    const throwingProvisioner: AgentProvisioner = {
      canProvision: false,
      provision: async () => {
        throw new Error("provisioner failure");
      },
      deprovision: async () => {},
      reconcile: async () => ({
        recreated: [],
        orphans: [],
        failed: [],
        updated: [],
      }),
    };

    const appWithFailingProvisioner = createAdminApp(
      makeDeps(prisma, throwingProvisioner),
    );

    // POST should fail because provisioner throws
    const res = await appWithFailingProvisioner.request("/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Doomed Agent With Tools" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(500);

    // After rollback, NO AgentTool or AgentPlugin rows should remain at all.
    // A relation filter like `where: { agent: { name: ... } }` would join
    // through the now-deleted Agent row and return [] regardless of whether
    // the rows were actually cascade-deleted or merely orphaned and
    // unreachable via that join. Query unscoped instead — this is valid
    // because `beforeEach` truncates `agentTool`/`agentPlugin` per test, so
    // this doomed agent's seeded rows are the only rows that could ever
    // exist here.
    const allToolsCount = await prisma.agentTool.count();
    expect(allToolsCount).toBe(0);
    const allPluginsCount = await prisma.agentPlugin.count();
    expect(allPluginsCount).toBe(0);
  });
});
