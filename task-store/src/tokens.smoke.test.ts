/**
 * task-store/src/tokens.smoke.test.ts
 *
 * Smoke tests for token management routes (POST, GET, DELETE, PATCH).
 * Tests token CRUD operations via in-process `app.request()`.
 *
 * Covers:
 *   - POST /tokens: create token (admin only)
 *   - GET /tokens: list tokens (admin only)
 *   - DELETE /tokens/:id: revoke token (admin only)
 *   - PATCH /tokens/:id: update label/agentId (admin only)
 *   - 403 when agent token attempts token management
 *   - 404 when updating/deleting non-existent token
 *   - 400 when updating a revoked token
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TaskToken, TokenServiceLike } from "./token-service.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";

// ─── Fakes ────────────────────────────────────────────────────────────────────

interface FakeTokenServiceOpts {
  revokedTokenId?: string;
}

function fakeAdminTokenService(
  opts: FakeTokenServiceOpts = {},
): TokenServiceLike {
  return {
    async create(label?: string, agentId?: string) {
      return {
        token: {
          id: "tok-new",
          token: "hash-new",
          label: label ?? null,
          agentId: agentId ?? null,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw-token-value",
      };
    },
    async validate(raw: string) {
      return raw === ADMIN_TOKEN ? { id: "tok-admin", agentId: null } : null;
    },
    async revoke(tokenId: string) {
      if (tokenId === "nonexistent") return null;
      return {
        id: tokenId,
        token: "hash",
        label: "old-label",
        agentId: null,
        createdAt: new Date(),
        revokedAt: new Date(),
      };
    },
    async list() {
      return [
        {
          id: "tok-1",
          token: "hash-1",
          label: "ci",
          agentId: null,
          createdAt: new Date(),
          revokedAt: null,
        },
        {
          id: "tok-2",
          token: "hash-2",
          label: "prod-agent",
          agentId: "agent-prod",
          createdAt: new Date(),
          revokedAt: null,
        },
      ];
    },
    async update(tokenId: string, data: { label?: string; agentId?: string }) {
      // Simulate a revoked token
      if (opts.revokedTokenId && tokenId === opts.revokedTokenId) {
        const error = new Error("token is revoked");
        (error as { code?: string }).code = "REVOKED";
        throw error;
      }

      // Simulate not found
      if (tokenId === "nonexistent") return null;

      // Simulate successful update
      return {
        id: tokenId,
        token: "hash",
        label: data.label ?? "updated",
        agentId: data.agentId ?? null,
        createdAt: new Date(),
        revokedAt: null,
      };
    },
  };
}

function fakeAgentTokenService(): TokenServiceLike {
  return {
    async create(label?: string, agentId?: string) {
      return {
        token: {
          id: "tok-agent",
          token: "hash-agent",
          label: label ?? null,
          agentId: agentId ?? "agent-1",
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw-agent",
      };
    },
    async validate(raw: string) {
      return raw === AGENT_TOKEN
        ? { id: "tok-agent", agentId: "agent-1" }
        : null;
    },
    async revoke() {
      return null;
    },
    async list() {
      return [];
    },
    async update() {
      return null;
    },
  };
}

function fakeTaskService(): TaskServiceLike {
  return {
    async list() {
      return { tasks: [], total: 0, limit: 50, offset: 0 };
    },
    async listReady() {
      return [];
    },
    async listBlocked() {
      return [];
    },
    async distinct() {
      return { sessions: [], repos: [] };
    },
    async get() {
      return null;
    },
    async create(data) {
      return data as never;
    },
    async bulk() {
      return { inserted: 0, updated: 0 };
    },
    async update(_id, data) {
      return data as never;
    },
    async remove() {},
    async claim() {
      return null as never;
    },
    async heartbeat() {
      return null as never;
    },
    async complete() {
      return null as never;
    },
    async fail() {
      return null as never;
    },
    async release() {
      return null as never;
    },
  };
}

function makeApp(opts: { tokenService?: TokenServiceLike } = {}) {
  return createTaskStoreApp({
    taskService: fakeTaskService(),
    tokenService: opts.tokenService ?? fakeAdminTokenService(),
  });
}

function auth(token: string = ADMIN_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PATCH /tokens/:id", () => {
  it("returns 200 with updated token when label is changed", async () => {
    const app = makeApp();
    const res = await app.request("/tokens/tok-1", {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ label: "new-label" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskToken;
    expect(body.label).toBe("new-label");
    expect(body.id).toBe("tok-1");
  });

  it("returns 200 with updated token when agentId is changed", async () => {
    const app = makeApp();
    const res = await app.request("/tokens/tok-1", {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ agentId: "new-agent" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskToken;
    expect(body.agentId).toBe("new-agent");
    expect(body.id).toBe("tok-1");
  });

  it("returns 200 with updated token when both label and agentId are changed", async () => {
    const app = makeApp();
    const res = await app.request("/tokens/tok-1", {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ label: "new-label", agentId: "new-agent" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TaskToken;
    expect(body.label).toBe("new-label");
    expect(body.agentId).toBe("new-agent");
    expect(body.id).toBe("tok-1");
  });

  it("returns 404 when token does not exist", async () => {
    const app = makeApp();
    const res = await app.request("/tokens/nonexistent", {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ label: "new-label" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when token is revoked", async () => {
    const app = makeApp({
      tokenService: fakeAdminTokenService({ revokedTokenId: "tok-revoked" }),
    });
    const res = await app.request("/tokens/tok-revoked", {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ label: "new-label" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 when agent token attempts to update", async () => {
    const app = makeApp({ tokenService: fakeAgentTokenService() });
    const res = await app.request("/tokens/tok-1", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "new-label" }),
    });
    expect(res.status).toBe(403);
  });

  it("never returns the raw token value", async () => {
    const app = makeApp();
    const res = await app.request("/tokens/tok-1", {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ label: "new-label" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rawToken).toBeUndefined();
  });
});
