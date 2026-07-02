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
import {
  fakeAdminTokenService,
  fakeMessageService,
  fakeThreadService,
} from "./test-fakes.ts";

function makeApp() {
  return createChatServiceApp({
    tokenService: fakeAdminTokenService(),
    threadService: fakeThreadService(),
    messageService: fakeMessageService(),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with service: chat (unauthenticated)", async () => {
    const app = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("chat");
  });

  it("returns 200 even with invalid/missing token (health is unauthenticated)", async () => {
    const app = makeApp();
    const res = await app.request("/health", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(200);
  });
});

describe("auth — missing/invalid token", () => {
  it("returns 401 when Authorization header is absent", async () => {
    const app = makeApp();
    const res = await app.request("/tokens");
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const app = makeApp();
    const res = await app.request("/tokens", {
      headers: { Authorization: "Bearer invalid-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with WWW-Authenticate header when no token", async () => {
    const app = makeApp();
    const res = await app.request("/tokens");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBeTruthy();
  });
});
