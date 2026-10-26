/**
 * admin/src/coding/agents-api-coding.smoke.test.ts
 * Smoke tests for the coding extension's admin API routes (agents-api-coding.ts):
 * work-queue snapshots and phase-methodology overrides. Relocated from
 * agents-api.smoke.test.ts (AEP-3.2).
 *
 * Uses app.request() — no real server, no real DB.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTokenService } from "@app-vitals/agent-admin/agent-tokens";
import type { Prisma } from "@app-vitals/agent-admin/prisma/client/client.ts";
import { sign } from "hono/jwt";
import {
  type CodingAdminApiDeps,
  createCodingAdminApiApp,
} from "./agents-api-coding.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-test-123";
const PHASE_METHODOLOGY_ID = "phase-methodology-test-ghi";
const WORK_QUEUE_SNAPSHOT_ID = "wqs-test-222";

// ─── JWT helper ───────────────────────────────────────────────────────────────

async function makeSessionCookie(secret = SESSION_SECRET): Promise<string> {
  return sign(
    {
      isAdmin: true,
      userId: "user-123",
      email: "admin@example.com",
      name: "Admin User",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    "HS256",
  );
}

// ─── In-memory AgentWorkQueueService double ───────────────────────────────────
//
// Real upsert semantics (one row per agentId, overwritten on repeat push) via
// a plain Map — no mock.module, no global overrides. A fresh instance per
// makeMockDeps() call keeps tests isolated from each other.

interface MockWorkQueueSnapshot {
  id: string;
  agentId: string;
  computedAt: Date;
  items: Prisma.JsonValue;
  createdAt: Date;
}

function makeInMemoryWorkQueueService(): CodingAdminApiDeps["agentWorkQueueService"] {
  const rows = new Map<string, MockWorkQueueSnapshot>();
  return {
    push: async (agentId, input) => {
      const existing = rows.get(agentId);
      const row: MockWorkQueueSnapshot = {
        id: existing?.id ?? WORK_QUEUE_SNAPSHOT_ID,
        agentId,
        computedAt: input.computedAt,
        items: input.items as Prisma.JsonValue,
        createdAt: existing?.createdAt ?? new Date("2024-01-01"),
      };
      rows.set(agentId, row);
      return row;
    },
    get: async (agentId) => rows.get(agentId) ?? null,
  };
}

function makeMockDeps(): CodingAdminApiDeps {
  return {
    agentService: {
      exists: async (id: string) => id === AGENT_ID,
    },
    agentPhaseMethodologyService: {
      list: async () => [
        {
          id: PHASE_METHODOLOGY_ID,
          agentId: AGENT_ID,
          phase: "review",
          subagentType: "shipwright:code-reviewer",
          updatedAt: new Date("2024-01-01"),
        },
      ],
      upsert: async (agentId: string, phase: string, subagentType) => ({
        id: PHASE_METHODOLOGY_ID,
        agentId,
        phase,
        subagentType,
        updatedAt: new Date("2024-01-01"),
      }),
    },
    agentWorkQueueService: makeInMemoryWorkQueueService(),
    agentTokenService: { validate: async () => null },
    agentMemberService: { listByEmail: async () => [] },
    sessionSecret: SESSION_SECRET,
  };
}

// ─── Work queue snapshot routes ────────────────────────────────────────────────

describe("admin API — work queue snapshot", () => {
  let cookie: string;

  const VALID_SNAPSHOT_BODY = {
    computedAt: "2026-01-01T00:00:00.000Z",
    items: [
      {
        type: "task",
        id: "WLS-2.2",
        title: "Add work queue snapshot endpoints",
        phase: "dev-task",
        age: "2026-01-01T00:00:00.000Z",
      },
      {
        type: "pr",
        id: "acme/x#123",
        phase: "review",
        age: "2025-12-31T00:00:00.000Z",
      },
    ],
  };

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /agents/:id/work-queue pushes a snapshot (200)", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      method: "POST",
      body: JSON.stringify(VALID_SNAPSHOT_BODY),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshot.agentId).toBe(AGENT_ID);
    expect(body.snapshot.computedAt).toBe(VALID_SNAPSHOT_BODY.computedAt);
    expect(body.snapshot.items).toEqual(VALID_SNAPSHOT_BODY.items);
  });

  // PDR-4.1: the loop orchestrator emits phase "plan" for autonomous
  // plan-session candidates. The enum must accept it, or enabling the phase
  // 400s the agent's every-tick snapshot POST.
  it('POST /agents/:id/work-queue accepts phase "plan" (200)', async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const body = {
      computedAt: "2026-01-01T00:00:00.000Z",
      items: [
        {
          type: "task",
          id: "PDR-1",
          phase: "plan",
          age: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const res = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.snapshot.items).toEqual(body.items);
  });

  it("POST /agents/:id/work-queue with malformed body (bad phase enum) returns 400", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      method: "POST",
      body: JSON.stringify({
        computedAt: "2026-01-01T00:00:00.000Z",
        items: [
          {
            type: "task",
            id: "WLS-2.2",
            phase: "not-a-real-phase",
            age: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("POST /agents/:id/work-queue with missing required fields returns 400", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      method: "POST",
      body: JSON.stringify({ items: [] }), // missing computedAt
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("POST /agents/:id/work-queue with non-ISO computedAt returns 400", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      method: "POST",
      body: JSON.stringify({ computedAt: "not-a-date", items: [] }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
  });

  it("GET /agents/:id/work-queue returns the pushed snapshot (200)", async () => {
    const deps = makeMockDeps();
    const app = createCodingAdminApiApp(deps);

    const postRes = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      method: "POST",
      body: JSON.stringify(VALID_SNAPSHOT_BODY),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(postRes.status).toBe(200);

    const getRes = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.snapshot.agentId).toBe(AGENT_ID);
    expect(body.snapshot.items).toEqual(VALID_SNAPSHOT_BODY.items);
  });

  it("GET /agents/:id/work-queue returns 404 when no snapshot has been pushed yet", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(404);
  });

  it("unauthenticated POST /agents/:id/work-queue returns 401", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      method: "POST",
      body: JSON.stringify(VALID_SNAPSHOT_BODY),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("unauthenticated GET /agents/:id/work-queue returns 401", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/work-queue`);
    expect(res.status).toBe(401);
  });
});

describe("admin API — phase methodology (PMC-1.1)", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("GET /agents/:id/phase-methodology returns list", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/phase-methodology`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.phaseMethodology)).toBe(true);
    expect(body.phaseMethodology).toHaveLength(1);
    expect(body.phaseMethodology[0].phase).toBe("review");
  });

  it("PUT /agents/:id/phase-methodology/:phase upserts a subagentType override (200)", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(
      `/agents/${AGENT_ID}/phase-methodology/review`,
      {
        method: "PUT",
        body: JSON.stringify({ subagentType: "shipwright:code-reviewer" }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.phaseMethodology.phase).toBe("review");
    expect(body.phaseMethodology.subagentType).toBe("shipwright:code-reviewer");
  });

  it("PUT /agents/:id/phase-methodology/:phase with subagentType: null clears the override (200)", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(
      `/agents/${AGENT_ID}/phase-methodology/deploy`,
      {
        method: "PUT",
        body: JSON.stringify({ subagentType: null }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.phaseMethodology.subagentType).toBeNull();
  });

  it("PUT /agents/:id/phase-methodology/:phase with an invalid phase returns 400", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(
      `/agents/${AGENT_ID}/phase-methodology/not-a-real-phase`,
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
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(
      "/agents/unknown-agent-id/phase-methodology",
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(404);
  });

  it("PUT /agents/:id/phase-methodology/:phase returns 404 for an unknown agent", async () => {
    const app = createCodingAdminApiApp(makeMockDeps());
    const res = await app.request(
      "/agents/unknown-agent-id/phase-methodology/review",
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
});

// ADMIN_API_KEY is used by several describe blocks in this file (create,
// reconcile, work queue bearer auth, provision).

// ─── Bearer token auth smoke tests ───────────────────────────────────────────

const VALID_BEARER_TOKEN = "valid-bearer-token-value";

function makeDepsWithTokenValidation(
  validateFn: AgentTokenService["validate"],
): CodingAdminApiDeps {
  return {
    ...makeMockDeps(),
    agentTokenService: {
      ...makeMockDeps().agentTokenService,
      validate: validateFn,
    },
  };
}

describe("admin API — bearer token auth", () => {
  it("POST /agents/:id/work-queue accepts the agent's own bearer token (200)", async () => {
    const deps = makeDepsWithTokenValidation(async () => ({
      agentId: AGENT_ID,
    }));
    const app = createCodingAdminApiApp(deps);
    const res = await app.request(`/agents/${AGENT_ID}/work-queue`, {
      method: "POST",
      body: JSON.stringify({
        computedAt: "2026-01-01T00:00:00.000Z",
        items: [],
      }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VALID_BEARER_TOKEN}`,
      },
    });
    expect(res.status).toBe(200);
  });
});
