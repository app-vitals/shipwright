/**
 * agent/src/run-agent.smoke.test.ts
 * Smoke tests for the composed Hono app from run-agent.ts.
 *
 * Tests the thin agent: health + /agents/* proxy only.
 * Uses an injected mock fetchFn — no real DB, no real network.
 *
 * No mock.module(), no global.* overrides.
 */

import { describe, expect, it } from "bun:test";
import { createComposedApp } from "./run-agent.ts";
import {
  TEST_AGENT_ID as AGENT_ID,
  makeMockDeps,
} from "./test-helpers/mock-deps.ts";

// ─── Health route ─────────────────────────────────────────────────────────────

describe("composed app — /health", () => {
  it("GET /health returns 200 { status: 'ok' }", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });
});

// ─── /agents/* proxy to admin service ────────────────────────────────────────

describe("composed app — /agents/* (proxy to admin service)", () => {
  it("GET /agents/:id/config without Bearer returns 401", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/config`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("GET /agents/:id/config with valid Bearer returns 200", async () => {
    const app = createComposedApp(makeMockDeps());
    const res = await app.request(`/agents/${AGENT_ID}/config`, {
      headers: { Authorization: "Bearer some-key" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.env).toBeDefined();
    expect(body.allowedTools).toBeDefined();
    expect(body.plugins).toBeDefined();
  });

  it("GET /agents/:id/config proxies to correct admin URL", async () => {
    let calledUrl = "";
    const base = makeMockDeps();
    const trackingDeps = {
      ...base,
      fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
        calledUrl =
          input instanceof Request ? input.url : String(input);
        return base.fetchFn?.(input, init) ?? new Response("Not Found", { status: 404 });
      },
    };
    const app = createComposedApp(trackingDeps);
    await app.request(`/agents/${AGENT_ID}/config`, {
      headers: { Authorization: "Bearer some-key" },
    });
    expect(calledUrl).toContain(`/agents/${AGENT_ID}/config`);
  });
});
