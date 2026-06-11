/**
 * agent/src/run-agent.smoke.test.ts
 * Smoke tests for the composed Hono app from run-agent.ts.
 *
 * After UNI-1.3: the composed app is a minimal chat-only server.
 * - /health is NOT mounted here — it runs on the dedicated health server
 *   (startHealthServer on SHIPWRIGHT_HEALTH_PORT). See health.integration.test.ts.
 * - /agents/* proxy is REMOVED — no proxy routes remain.
 * - /chat is only registered when devChat=true (DEFAULT-DENY).
 *
 * No mock.module(), no global.* overrides.
 */

import { describe, expect, it } from "bun:test";
import { createComposedApp } from "./run-agent.ts";
import { makeMockDeps } from "./test-helpers/mock-deps.ts";

// ─── /health is NOT served by the composed app ───────────────────────────────
// Health is served by the dedicated health server (startHealthServer).
// Regression guard: make sure createComposedApp never re-mounts it.

describe("composed app — /health not mounted", () => {
  it("GET /health returns 404 from composed app", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(404);
  });
});

// ─── /agents/* proxy removed ─────────────────────────────────────────────────
// The transparent proxy to the admin service was removed in UNI-1.3.

describe("composed app — /agents/* not proxied", () => {
  it("GET /agents/* returns 404 — no proxy routes", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request("/agents/agent-test-123/config");
    expect(res.status).toBe(404);
  });

  it("POST /agents/* returns 404", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request("/agents/agent-test-123/config", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

// ─── /chat — DEFAULT-DENY ────────────────────────────────────────────────────

describe("composed app — /chat (DEFAULT-DENY)", () => {
  it("POST /chat returns 404 when devChat is false (default)", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(404);
  });
});
