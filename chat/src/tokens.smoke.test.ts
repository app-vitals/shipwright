/**
 * chat/src/tokens.smoke.test.ts
 *
 * Smoke tests for token management routes (POST, GET, DELETE).
 * Tests token CRUD operations via in-process `app.request()`.
 *
 * Covers:
 *   - POST /tokens: create token returns 201 with rawToken (admin only)
 *   - GET /tokens: list tokens returns 200 array (admin only)
 *   - DELETE /tokens/:id: revoke token returns 200 (admin only)
 *   - 403 when agent token attempts token management
 */

import { describe, expect, it } from "bun:test";
import { createChatServiceApp } from "./app.ts";
import {
  fakeAgentTokenService,
  fakeMessageService,
  fakeThreadService,
} from "./test-fakes.ts";
import type { ChatToken, ChatTokenServiceLike } from "./token-service.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";

// ─── Token fakes (kept local — need richer list/update behaviour) ─────────────

function fakeAdminTokenService(): ChatTokenServiceLike {
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
    async list(): Promise<ChatToken[]> {
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
      if (tokenId === "nonexistent") return null;
      return {
        id: tokenId,
        token: "hash",
        label: data.label ?? "updated",
        agentId: data.agentId ?? null,
        createdAt: new Date(),
        revokedAt: null,
      };
    },
    async seed() {},
  };
}

function makeApp(tokenService: ChatTokenServiceLike) {
  return createChatServiceApp({
    tokenService,
    threadService: fakeThreadService(),
    messageService: fakeMessageService(),
  });
}

function auth(token: string = ADMIN_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /tokens", () => {
  it("returns 201 with rawToken (admin only)", async () => {
    const app = makeApp(fakeAdminTokenService());
    const res = await app.request("/tokens", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ label: "my-token" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { rawToken: string; id: string };
    expect(typeof body.rawToken).toBe("string");
    expect(body.rawToken.length).toBeGreaterThan(0);
    expect(body.id).toBe("tok-new");
  });
});

describe("GET /tokens", () => {
  it("returns 200 with token array (admin only)", async () => {
    const app = makeApp(fakeAdminTokenService());
    const res = await app.request("/tokens", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatToken[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
  });
});

describe("DELETE /tokens/:id", () => {
  it("returns 200 on successful revocation", async () => {
    const app = makeApp(fakeAdminTokenService());
    const res = await app.request("/tokens/tok-1", {
      method: "DELETE",
      headers: auth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChatToken;
    expect(body.id).toBe("tok-1");
    expect(body.revokedAt).toBeTruthy();
  });

  it("returns 404 when token does not exist", async () => {
    const app = makeApp(fakeAdminTokenService());
    const res = await app.request("/tokens/nonexistent", {
      method: "DELETE",
      headers: auth(),
    });
    expect(res.status).toBe(404);
  });
});

describe("agent token attempting token management", () => {
  it("returns 403 on POST /tokens with agent token", async () => {
    const app = makeApp(fakeAgentTokenService(AGENT_TOKEN));
    const res = await app.request("/tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 on GET /tokens with agent token", async () => {
    const app = makeApp(fakeAgentTokenService(AGENT_TOKEN));
    const res = await app.request("/tokens", {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(403);
  });
});
