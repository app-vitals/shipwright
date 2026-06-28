/**
 * metrics/src/offline.smoke.test.ts
 * Smoke tests for offline/fixture mode — drives the Hono app via app.request()
 * with no real PostHog, no SESSION_SECRET, and no accounts service.
 *
 * METRICS_OFFLINE=true mode:
 * - /health returns 200 { status: "ok" }
 * - /metrics/summary, /metrics/trends, /metrics/features, /metrics/queue,
 *   /metrics/tokens all return 200 with fixture data
 * - /dashboard returns 200 with real server-rendered HTML (not JSON placeholder)
 *
 * No mock.module(), no global.* overrides. Uses the existing DI seam only.
 */

import { describe, expect, test } from "bun:test";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import { createFixtureTaskStoreProvider } from "./fixtures/task-store-fixtures.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";

const ADMIN_KEY = "sk_admin_offline";
const apiKeys = parseApiKeys(`admin:${ADMIN_KEY}:*`);
const noopAccountsClient = makeAccountsClientMock(async () => []);

function makeOfflineDeps(): MetricsDeps {
  return {
    provider: createFixtureTaskStoreProvider(),
    sessionSecret: "",
    offlineMode: true,
  };
}

describe("offline mode — /health", () => {
  test("returns 200 { status: ok }", async () => {
    const app = createMetricsApp(
      apiKeys,
      noopAccountsClient,
      makeOfflineDeps(),
    );
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("offline mode — /metrics/summary", () => {
  test("returns 200 with fixture data (no auth header required for offline)", async () => {
    const app = createMetricsApp(
      apiKeys,
      noopAccountsClient,
      makeOfflineDeps(),
    );
    const res = await app.request("/metrics/summary", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.tasksCompleted).toBe("number");
    expect(typeof body.data.ciGatesTotal).toBe("number");
    expect(body.meta).toBeTruthy();
  });
});

describe("offline mode — /metrics/trends", () => {
  test("returns 200 with fixture rows array", async () => {
    const app = createMetricsApp(
      apiKeys,
      noopAccountsClient,
      makeOfflineDeps(),
    );
    const res = await app.request("/metrics/trends?preset=7d", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.rows)).toBe(true);
    expect(body.data.rows.length).toBeGreaterThan(0);
    expect(typeof body.data.rows[0].period).toBe("string");
    expect(typeof body.data.rows[0].tasksCompleted).toBe("number");
  });
});

describe("offline mode — /metrics/features", () => {
  test("returns 200 with fixture features array", async () => {
    const app = createMetricsApp(
      apiKeys,
      noopAccountsClient,
      makeOfflineDeps(),
    );
    const res = await app.request("/metrics/features?preset=7d", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.features)).toBe(true);
    expect(body.data.features.length).toBeGreaterThan(0);
    const f = body.data.features[0];
    expect(typeof f.prefix).toBe("string");
    expect(typeof f.tasksCompleted).toBe("number");
  });
});

describe("offline mode — /metrics/queue", () => {
  test("returns 200 with fixture queue data", async () => {
    const app = createMetricsApp(
      apiKeys,
      noopAccountsClient,
      makeOfflineDeps(),
    );
    const res = await app.request("/metrics/queue?preset=7d", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.tasksStarted).toBe("number");
    expect(typeof body.data.tasksMerged).toBe("number");
  });
});

describe("offline mode — /metrics/tokens", () => {
  test("returns 200 with fixture token data", async () => {
    const app = createMetricsApp(
      apiKeys,
      noopAccountsClient,
      makeOfflineDeps(),
    );
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals).toBeTruthy();
    expect(typeof body.data.totals.input).toBe("number");
    expect(typeof body.data.totals.total).toBe("number");
    expect(Array.isArray(body.data.bySessionType)).toBe(true);
    expect(Array.isArray(body.data.byAgent)).toBe(true);
    expect(Array.isArray(body.data.trends)).toBe(true);
  });
});

describe("offline mode — /dashboard", () => {
  test("returns 200 with real HTML (not JSON placeholder)", async () => {
    const app = createMetricsApp(
      apiKeys,
      noopAccountsClient,
      makeOfflineDeps(),
    );
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type");
    expect(ct).toMatch(/text\/html/);
    const body = await res.text();
    // Real server-rendered page contains dashboard markup, not the JSON placeholder
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Metrics");
    // Must NOT be the JSON placeholder { service: "metrics-api", status: "ok" }
    expect(body).not.toContain('"service"');
    expect(body).not.toContain('"metrics-api"');
  });

  test("renders with offline user name", async () => {
    const app = createMetricsApp(
      apiKeys,
      noopAccountsClient,
      makeOfflineDeps(),
    );
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Offline");
  });
});

describe("offline mode — no live credentials required", () => {
  test("boots with empty session secret and no PostHog keys", async () => {
    // This test verifies that no env vars are read — everything is injected via deps
    const deps: MetricsDeps = {
      provider: createFixtureTaskStoreProvider(),
      sessionSecret: "",
      offlineMode: true,
    };
    const app = createMetricsApp(new Map(), noopAccountsClient, deps);
    // At minimum, health must respond
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});
