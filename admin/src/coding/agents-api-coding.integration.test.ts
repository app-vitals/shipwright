/**
 * admin/src/coding/agents-api-coding.integration.test.ts
 * Integration tests for the coding extension's admin API routes
 * (agents-api-coding.ts) against a real PostgreSQL DB. Relocated from
 * agents-api.integration.test.ts (AEP-3.2).
 *
 * Requires DATABASE_URL_ADMIN_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentMemberService } from "@app-vitals/agent-admin/agent-members";
import { AgentTokenService } from "@app-vitals/agent-admin/agent-tokens";
import { AgentService } from "@app-vitals/agent-admin/agents";
import type { PrismaClient } from "@app-vitals/agent-admin/prisma/client/client.ts";
import { createAdminPrismaClient } from "@app-vitals/agent-admin/prisma-client";
import { sign } from "hono/jwt";
import { AgentPhaseMethodologyService } from "./agent-phase-methodology.ts";
import { AgentWorkQueueService } from "./agent-work-queue.ts";
import {
  type CodingAdminApiDeps,
  createCodingAdminApiApp,
} from "./agents-api-coding.ts";
import { DevTaskAdherenceService } from "./dev-task-adherence.ts";

const TEST_DB = process.env.DATABASE_URL_ADMIN_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";

async function makeSessionCookie(): Promise<string> {
  return sign(
    {
      isAdmin: true,
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

function makeDeps(prisma: PrismaClient): CodingAdminApiDeps {
  return {
    agentService: new AgentService(prisma),
    agentPhaseMethodologyService: new AgentPhaseMethodologyService(prisma),
    agentWorkQueueService: new AgentWorkQueueService(prisma),
    agentTokenService: new AgentTokenService(prisma),
    agentMemberService: new AgentMemberService(prisma),
    sessionSecret: SESSION_SECRET,
  };
}

describeOrSkip("coding admin API (integration)", () => {
  let prisma: PrismaClient;
  let agentId: string;
  let cookie: string;
  let app: ReturnType<typeof createCodingAdminApiApp>;

  beforeEach(async () => {
    prisma = makePrisma();

    // Clean all tables in FK dependency order
    await prisma.agentWorkQueueSnapshot.deleteMany();
    await prisma.agentPlugin.deleteMany();
    await prisma.agentPhaseMethodology.deleteMany();
    await prisma.agentToken.deleteMany();
    await prisma.agentCronJob.deleteMany();
    await prisma.agentTool.deleteMany();
    await prisma.agentEnv.deleteMany();
    await prisma.agentMember.deleteMany();
    await prisma.agent.deleteMany();

    agentId = await createAgent(prisma);
    cookie = await makeSessionCookie();

    app = createCodingAdminApiApp(makeDeps(prisma));
  });

  afterEach(async () => {
    await prisma.$disconnect();
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

  // ─── Phase Methodology (PMC-1.1) ───────────────────────────────────────────

  it("GET /agents/:id/phase-methodology returns an empty list for an agent with no overrides", async () => {
    const res = await app.request(`/agents/${agentId}/phase-methodology`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.phaseMethodology).toEqual([]);
  });

  it("PUT /agents/:id/phase-methodology/:phase upserts a subagentType override, reflected on GET", async () => {
    const putRes = await app.request(
      `/agents/${agentId}/phase-methodology/review`,
      {
        method: "PUT",
        body: JSON.stringify({ subagentType: "shipwright:code-reviewer" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.phaseMethodology.phase).toBe("review");
    expect(putBody.phaseMethodology.subagentType).toBe(
      "shipwright:code-reviewer",
    );

    const getRes = await app.request(`/agents/${agentId}/phase-methodology`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.phaseMethodology).toHaveLength(1);
    expect(getBody.phaseMethodology[0].phase).toBe("review");
    expect(getBody.phaseMethodology[0].subagentType).toBe(
      "shipwright:code-reviewer",
    );

    // Verify against the real DB row directly.
    const dbRow = await prisma.agentPhaseMethodology.findFirst({
      where: { agentId, phase: "review" },
    });
    expect(dbRow?.subagentType).toBe("shipwright:code-reviewer");
  });

  it("PUT /agents/:id/phase-methodology/:phase with subagentType: null clears a previously set override", async () => {
    await app.request(`/agents/${agentId}/phase-methodology/deploy`, {
      method: "PUT",
      body: JSON.stringify({ subagentType: "shipwright:deployer" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });

    const clearRes = await app.request(
      `/agents/${agentId}/phase-methodology/deploy`,
      {
        method: "PUT",
        body: JSON.stringify({ subagentType: null }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(clearRes.status).toBe(200);
    const clearBody = await clearRes.json();
    expect(clearBody.phaseMethodology.subagentType).toBeNull();
  });

  it("PUT /agents/:id/phase-methodology/:phase rejects an invalid phase with 400", async () => {
    const res = await app.request(
      `/agents/${agentId}/phase-methodology/not-a-real-phase`,
      {
        method: "PUT",
        body: JSON.stringify({ subagentType: "claude" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(400);
  });

  it("GET /agents/:id/phase-methodology returns 404 for an unknown agent", async () => {
    const res = await app.request(
      "/agents/nonexistent-agent-id/phase-methodology",
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(404);
  });

  it("PUT /agents/:id/phase-methodology/:phase returns 404 for an unknown agent", async () => {
    const res = await app.request(
      "/agents/nonexistent-agent-id/phase-methodology/review",
      {
        method: "PUT",
        body: JSON.stringify({ subagentType: "claude" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("GET /agents/:id/dev-task-adherence is scoped to the caller's own agent", async () => {
    const otherId = await createAgent(prisma);
    const seed = async (owner: string, itemId: string) => {
      const job = await prisma.agentCronJob.create({
        data: {
          agentId: owner,
          schedule: "0 9 * * *",
          prompt: "p",
          silent: true,
          name: "shipwright-dev-task",
        },
      });
      await prisma.agentCronRun.create({
        data: {
          cronId: job.id,
          agentId: owner,
          startedAt: new Date("2026-01-10T09:00:00Z"),
          skipped: false,
          phaseId: job.id,
          itemId,
        },
      });
    };
    await seed(agentId, "A-1.1");
    await seed(otherId, "B-1.1");

    const adherenceApp = createCodingAdminApiApp({
      ...makeDeps(prisma),
      devTaskAdherenceService: new DevTaskAdherenceService(prisma),
    });
    const { rawToken: tokenA } = await new AgentTokenService(prisma).create(
      agentId,
    );

    const own = await adherenceApp.request(
      `/agents/${agentId}/dev-task-adherence`,
      { headers: { Authorization: `Bearer ${tokenA}` } },
    );
    expect(own.status).toBe(200);
    const ownBody = await own.json();
    expect(ownBody.runs.map((r: { itemId: string }) => r.itemId)).toEqual([
      "A-1.1",
    ]);

    const cross = await adherenceApp.request(
      `/agents/${otherId}/dev-task-adherence`,
      { headers: { Authorization: `Bearer ${tokenA}` } },
    );
    expect(cross.status).toBe(403);

    const anon = await adherenceApp.request(
      `/agents/${agentId}/dev-task-adherence`,
    );
    expect(anon.status).toBe(401);

    // Fleet-wide admin route is unchanged: sees both agents' runs.
    const fleet = await adherenceApp.request(
      "/agents/all/cron-runs/dev-task-adherence",
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(fleet.status).toBe(200);
    expect((await fleet.json()).runs).toHaveLength(2);
  });
});
