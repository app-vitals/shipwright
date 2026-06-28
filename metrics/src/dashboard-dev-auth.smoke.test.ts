/**
 * metrics/src/dashboard-dev-auth.smoke.test.ts
 * Smoke tests for the local-development dashboard auth bypass (dashboardDevAuth).
 *
 * Unlike offline/fixture mode, dashboardDevAuth keeps the real (injected) data
 * provider — it only relaxes auth so the server-rendered dashboard AND its data
 * endpoints are reachable from a browser with no session cookie and no Bearer
 * token (there is no login flow in the local `task stack`). This is the metrics
 * analogue of the admin service's ADMIN_DEV_AUTH.
 *
 * Contract (with dashboardDevAuth=true, empty sessionSecret, no credentials):
 * - /dashboard returns 200 server-rendered HTML (no redirect, no 500)
 * - /metrics/summary (and the other /metrics/* endpoints) return 200 with real
 *   provider data — WITHOUT any Authorization header or cookie
 *
 * No mock.module(), no global.* overrides — DI seam only.
 */

import { describe, expect, test } from "bun:test";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import { createFixtureTaskStoreProvider } from "./fixtures/task-store-fixtures.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";

const noopAccountsClient = makeAccountsClientMock(async () => []);

// dashboardDevAuth keeps a real injected provider (the recorded fixture
// provider stands in here — the point under test is auth, not the data source).
function makeDevAuthDeps(): MetricsDeps {
  return {
    provider: createFixtureTaskStoreProvider(),
    sessionSecret: "",
    dashboardDevAuth: true,
  };
}

describe("dashboardDevAuth — /dashboard", () => {
  test("returns 200 server-rendered HTML with no session cookie", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Metrics");
  });

  test("adminBaseUrl makes the toolbar's admin links absolute (cross-origin local stack)", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, {
      ...makeDevAuthDeps(),
      adminBaseUrl: "http://localhost:3001",
    });
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain('href="http://localhost:3001/admin/agents"');
    expect(body).toContain('href="http://localhost:3001/admin/tasks"');
    expect(body).toContain('href="http://localhost:3001/admin/prs"');
  });

  test("without adminBaseUrl the admin links stay relative (prod default)", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/dashboard");
    const body = await res.text();
    expect(body).toContain('href="/admin/agents"');
    expect(body).not.toContain('href="http://localhost:3001/admin/agents"');
  });
});

describe("dashboardDevAuth — /metrics/* without credentials", () => {
  test("/metrics/summary returns 200 with no Authorization header or cookie", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/summary?preset=7d");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.tasksCompleted).toBe("number");
  });

  test("/metrics/trends returns 200 with no credentials", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/trends?preset=7d");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.rows)).toBe(true);
  });
});

describe("dashboardDevAuth — disabled by default", () => {
  test("without the flag, /metrics/summary still requires auth (401)", async () => {
    const deps: MetricsDeps = {
      provider: createFixtureTaskStoreProvider(),
      sessionSecret: "",
    };
    const app = createMetricsApp(new Map(), noopAccountsClient, deps);
    const res = await app.request("/metrics/summary?preset=7d");
    expect(res.status).toBe(401);
  });
});
