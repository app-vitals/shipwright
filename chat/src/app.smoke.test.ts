/**
 * chat/src/app.smoke.test.ts
 *
 * Smoke tests for the chat service app factory.
 * Tests run in-process via app.request() — no real HTTP socket, no real DB.
 *
 * Covers:
 *   - GET /health → 200 { status: "ok", service: "chat" }
 *   - Any route without Authorization header → 401
 *   - Any route with invalid token → 401
 *   - GET /health with invalid token → 200 (health is unauthenticated)
 */

import { describe, expect, it } from "bun:test";
import { createChatServiceApp } from "./app.ts";
import type { ChatTokenServiceLike } from "./token-service.ts";

// ─── Fakes ────────────────────────────────────────────────────────────────────

const ADMIN_TOKEN = "admin-token";

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
        label: null,
        agentId: null,
        createdAt: new Date(),
        revokedAt: new Date(),
      };
    },
    async list() {
      return [];
    },
    async update() {
      return null;
    },
    async seed() {},
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with service: chat (unauthenticated)", async () => {
    const app = createChatServiceApp({ tokenService: fakeAdminTokenService() });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("chat");
  });

  it("returns 200 even with invalid/missing token (health is unauthenticated)", async () => {
    const app = createChatServiceApp({ tokenService: fakeAdminTokenService() });
    const res = await app.request("/health", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(200);
  });
});

describe("auth — missing/invalid token", () => {
  it("returns 401 when Authorization header is absent", async () => {
    const app = createChatServiceApp({ tokenService: fakeAdminTokenService() });
    const res = await app.request("/tokens");
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const app = createChatServiceApp({ tokenService: fakeAdminTokenService() });
    const res = await app.request("/tokens", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with WWW-Authenticate header when no token", async () => {
    const app = createChatServiceApp({ tokenService: fakeAdminTokenService() });
    const res = await app.request("/tokens");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });
});
