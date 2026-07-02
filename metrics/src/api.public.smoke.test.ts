/**
 * metrics/src/api.public.smoke.test.ts
 * Smoke tests (PPL-1.2): the public, unauthenticated metrics surface.
 *
 * Drives the public sub-app via app.request() — no real server, no network.
 * Covers:
 *   - 200 unauth on /public/metrics/summary (+ trends/features/queue)
 *   - 404 on /public/metrics/tokens (token usage is not public)
 *   - 404/405 on any mutation (POST/PUT/DELETE) under /public/*
 *   - read-only dashboard render omits the token-usage section
 *
 * No mock.module(), no global overrides — the provider is injected.
 */

import { describe, expect, test } from "bun:test";
import { createPublicMetricsApp } from "./api.ts";
import type { MetricsProvider } from "./metrics-provider.ts";
import type { HogQLResult } from "./types.ts";

const emptyResult: HogQLResult = {
  columns: [],
  results: [],
  types: [],
  hasMore: false,
  limit: 100,
  offset: 0,
};

/** Provider that returns an empty table for every kind — enough to render 200s. */
function makeEmptyProvider(): MetricsProvider {
  return { query: async () => emptyResult };
}

function buildApp() {
  return createPublicMetricsApp(makeEmptyProvider());
}

describe("public metrics surface — unauthenticated reads", () => {
  for (const path of [
    "/public/metrics/summary",
    "/public/metrics/trends",
    "/public/metrics/features",
    "/public/metrics/queue",
  ]) {
    test(`GET ${path} → 200 with no auth header`, async () => {
      const app = buildApp();
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toBeTruthy();
    });
  }
});

describe("public metrics surface — token usage hidden", () => {
  test("GET /public/metrics/tokens → 404", async () => {
    const app = buildApp();
    const res = await app.request("/public/metrics/tokens");
    expect(res.status).toBe(404);
  });
});

describe("public metrics surface — no mutations", () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    test(`${method} /public/metrics/summary → 404 or 405`, async () => {
      const app = buildApp();
      const res = await app.request("/public/metrics/summary", { method });
      expect([404, 405]).toContain(res.status);
    });
  }
});

describe("public dashboard — read-only render", () => {
  test("GET /public/dashboard → 200 and omits token-usage section", async () => {
    const app = buildApp();
    const res = await app.request("/public/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Pipeline panels remain.
    expect(html).toContain("Pipeline Queue");
    expect(html).toContain("Tasks Completed");
    // Token-usage section is hidden in read-only mode.
    expect(html).not.toContain("Token Usage");
    expect(html).not.toContain("token-agent-table");
  });

  // The public toolbar must not link to authenticated /admin/* pages (they 404 on
  // the proof host) and must not offer sign-out; it surfaces only Metrics + Tasks.
  test("GET /public/dashboard → toolbar omits admin links + logout, links to public tasks", async () => {
    const app = buildApp();
    const html = await (await app.request("/public/dashboard")).text();
    expect(html).not.toContain("/admin/");
    expect(html).not.toContain("Sign out");
    expect(html).toContain('href="/public/tasks"');
    expect(html).toContain('href="/public/dashboard"');
  });

  // PPL-1.4: the read-only page must point its client at the /public mount so
  // app.js fetches /public/metrics/* (repo-scoped, no auth) — not the
  // authenticated /metrics/* endpoints, which would 401 and leave it dataless.
  test("GET /public/dashboard → client base + assets resolve to the /public mount", async () => {
    const app = buildApp();
    const res = await app.request("/public/dashboard");
    const html = await res.text();
    expect(html).toContain('window.__METRICS_BASE__ = "/public";');
    expect(html).toContain('href="/public/dashboard/styles.css"');
    expect(html).toContain('src="/public/dashboard/app.js"');
  });

  test("GET /public/dashboard prefixes the rendered base with a non-empty basePath", async () => {
    const app = createPublicMetricsApp(makeEmptyProvider(), "/m");
    const res = await app.request("/public/dashboard");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('window.__METRICS_BASE__ = "/m/public";');
  });

  // The proof-host root redirect lands on "/public/dashboard/" (GKE appends a
  // slash), which Hono treats as a distinct route — serve it too so the apex
  // entry doesn't 404.
  test("GET /public/dashboard/ (trailing slash) → 200, same page", async () => {
    const app = buildApp();
    const res = await app.request("/public/dashboard/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pipeline Queue");
    expect(html).toContain('window.__METRICS_BASE__ = "/public";');
  });
});

describe("public metrics surface — cost-efficiency endpoint", () => {
  test("GET /public/metrics/cost-efficiency → 200 with no auth", async () => {
    const app = buildApp();
    const res = await app.request("/public/metrics/cost-efficiency");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
    // Run/cron-centric shape: fleet + byAgentModel + byCronModel arrays
    expect(Array.isArray(body.data.fleet)).toBe(true);
    expect(Array.isArray(body.data.byAgentModel)).toBe(true);
    expect(Array.isArray(body.data.byCronModel)).toBe(true);
  });

  test("GET /public/metrics/cost-efficiency → response uses run/cron field names", async () => {
    const provider: MetricsProvider = {
      query: async () => ({
        columns: ["scope", "model_family", "routed_usd", "opus_usd", "savings_usd"],
        results: [
          ["fleet", "claude-sonnet", 10.0, 20.0, 10.0],
          ["agent:agent-abc", "claude-sonnet", 10.0, 20.0, 10.0],
          ["cron:agent1:daily-review", "claude-sonnet", 5.0, 10.0, 5.0],
        ],
        types: [],
        hasMore: false,
        limit: 100,
        offset: 0,
      }),
    };
    const app = createPublicMetricsApp(provider);
    const res = await app.request("/public/metrics/cost-efficiency");
    expect(res.status).toBe(200);
    const body = await res.json();

    // Fleet row has correct camelCase field names
    expect(body.data.fleet).toHaveLength(1);
    const fleetRow = body.data.fleet[0];
    expect(fleetRow).toHaveProperty("modelFamily", "claude-sonnet");
    expect(fleetRow).toHaveProperty("routedUsd", 10.0);
    expect(fleetRow).toHaveProperty("counterfactualOpusUsd", 20.0);
    expect(fleetRow).toHaveProperty("savingsUsd", 10.0);
    expect(typeof fleetRow.savingsPct).toBe("number");

    // byAgentModel row
    expect(body.data.byAgentModel).toHaveLength(1);
    const agentRow = body.data.byAgentModel[0];
    expect(agentRow).toHaveProperty("agentId", "agent-abc");
    expect(agentRow).toHaveProperty("modelFamily", "claude-sonnet");
    expect(agentRow).toHaveProperty("routedUsd", 10.0);
    expect(agentRow).toHaveProperty("counterfactualOpusUsd", 20.0);

    // byCronModel row
    expect(body.data.byCronModel).toHaveLength(1);
    const cronRow = body.data.byCronModel[0];
    expect(cronRow).toHaveProperty("scope", "cron:agent1:daily-review");
    expect(cronRow).toHaveProperty("modelFamily", "claude-sonnet");
    expect(cronRow).toHaveProperty("routedUsd", 5.0);
    expect(cronRow).toHaveProperty("counterfactualOpusUsd", 10.0);
    expect(cronRow).toHaveProperty("savingsUsd", 5.0);
  });

  test("GET /public/metrics/cost-efficiency → NO task-centric fields in response", async () => {
    const app = buildApp();
    const res = await app.request("/public/metrics/cost-efficiency");
    expect(res.status).toBe(200);
    const body = await res.json();
    const bodyStr = JSON.stringify(body);
    // No task-centric field names
    expect(bodyStr).not.toContain("tasksWithCostData");
    expect(bodyStr).not.toContain("tasksShippedTotal");
  });

  test("GET /public/metrics/cost-efficiency → savingsPct computed correctly", async () => {
    const provider: MetricsProvider = {
      query: async () => ({
        columns: ["scope", "model_family", "routed_usd", "opus_usd", "savings_usd"],
        results: [
          // savingsPct = (10 / 20) * 100 = 50
          ["fleet", "claude-sonnet", 10.0, 20.0, 10.0],
        ],
        types: [],
        hasMore: false,
        limit: 100,
        offset: 0,
      }),
    };
    const app = createPublicMetricsApp(provider);
    const res = await app.request("/public/metrics/cost-efficiency");
    const body = await res.json();
    expect(body.data.fleet[0].savingsPct).toBe(50);
  });

  test("GET /public/metrics/cost-efficiency → savingsPct is null when counterfactualOpusUsd is 0", async () => {
    const provider: MetricsProvider = {
      query: async () => ({
        columns: ["scope", "model_family", "routed_usd", "opus_usd", "savings_usd"],
        results: [
          ["fleet", "claude-sonnet", 0.0, 0.0, 0.0],
        ],
        types: [],
        hasMore: false,
        limit: 100,
        offset: 0,
      }),
    };
    const app = createPublicMetricsApp(provider);
    const res = await app.request("/public/metrics/cost-efficiency");
    const body = await res.json();
    expect(body.data.fleet[0].savingsPct).toBeNull();
  });
});

describe("public dashboard — static assets", () => {
  for (const [path, type] of [
    ["/public/dashboard/styles.css", "text/css"],
    ["/public/dashboard/app.js", "application/javascript"],
  ]) {
    test(`GET ${path} → 200 ${type}`, async () => {
      const app = buildApp();
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain(type);
      expect((await res.text()).length).toBeGreaterThan(0);
    });
  }
});
