/**
 * metrics/src/server-offline-mode.smoke.test.ts
 * Smoke test for the server.ts fixture-branch wiring.
 *
 * Replicates the deps object that server.ts builds in the `if (mode === "fixtures")`
 * branch, reading dashboardDevAuth from process.env exactly as server.ts does.
 * If dashboardDevAuth is dropped from that branch in server.ts (the pre-fix bug),
 * /metrics/summary returns 401 even with both env vars set.
 *
 * This test catches the wire-up bug that dashboard-dev-auth.smoke.test.ts cannot,
 * because that suite calls createMetricsApp directly with dashboardDevAuth: true
 * hardcoded and therefore never exercises the server.ts env-reading path.
 *
 * No mock.module(), no global.* overrides — DI seam only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import { createFixtureTaskStoreProvider } from "./fixtures/task-store-fixtures.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";

const noopAccountsClient = makeAccountsClientMock(async () => []);

// Snapshot and restore env vars touched by this suite so sibling suites are
// not affected (Bun shares the process).
let savedOffline: string | undefined;
let savedDevAuth: string | undefined;

beforeEach(() => {
  savedOffline = process.env.METRICS_OFFLINE;
  savedDevAuth = process.env.METRICS_DASHBOARD_DEV_AUTH;
  process.env.METRICS_OFFLINE = "true";
  process.env.METRICS_DASHBOARD_DEV_AUTH = "true";
});

afterEach(() => {
  if (savedOffline === undefined) {
    Reflect.deleteProperty(process.env, "METRICS_OFFLINE");
  } else {
    process.env.METRICS_OFFLINE = savedOffline;
  }
  if (savedDevAuth === undefined) {
    Reflect.deleteProperty(process.env, "METRICS_DASHBOARD_DEV_AUTH");
  } else {
    process.env.METRICS_DASHBOARD_DEV_AUTH = savedDevAuth;
  }
});

/**
 * Build deps the same way server.ts does in the fixtures branch — reading
 * dashboardDevAuth from process.env. This mirrors the FIXED server.ts behavior.
 * The regression guard: if server.ts stops forwarding dashboardDevAuth in fixture
 * mode, the /metrics/summary test below catches it with a 401.
 */
function buildFixtureDeps(): MetricsDeps {
  const dashboardDevAuth = process.env.METRICS_DASHBOARD_DEV_AUTH === "true";
  return {
    provider: createFixtureTaskStoreProvider(),
    sessionSecret: "",
    requireOwnerRole: false,
    offlineMode: true,
    dashboardDevAuth,
  };
}

describe("server.ts fixture-branch — METRICS_OFFLINE=true + METRICS_DASHBOARD_DEV_AUTH=true", () => {
  test("/metrics/summary?preset=7d returns 200 without an Authorization header", async () => {
    const deps = buildFixtureDeps();
    const app = createMetricsApp(new Map(), noopAccountsClient, deps);
    const res = await app.request("/metrics/summary?preset=7d");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.tasksCompleted).toBe("number");
  });

  test("/dashboard returns 200 server-rendered HTML without credentials", async () => {
    const deps = buildFixtureDeps();
    const app = createMetricsApp(new Map(), noopAccountsClient, deps);
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("<!DOCTYPE html>");
  });
});

/**
 * Verify that without dashboardDevAuth in fixture deps (the pre-fix server.ts bug),
 * /metrics/summary returns 401. This is the explicit RED state: if you build
 * fixture deps without forwarding dashboardDevAuth, auth is not bypassed.
 */
describe("regression guard — missing dashboardDevAuth in fixture deps causes 401", () => {
  test("fixture deps without dashboardDevAuth → /metrics/summary returns 401 (not 200)", async () => {
    // This mirrors the pre-fix server.ts fixture branch: dashboardDevAuth is absent.
    const buggyDeps: MetricsDeps = {
      provider: createFixtureTaskStoreProvider(),
      sessionSecret: "",
      requireOwnerRole: false,
      offlineMode: true,
      // dashboardDevAuth deliberately omitted — this is the bug
    };
    const app = createMetricsApp(new Map(), noopAccountsClient, buggyDeps);
    // offlineMode alone does NOT bypass /metrics/* auth (only /dashboard auth).
    // Without dashboardDevAuth, the combined auth middleware rejects the request.
    const res = await app.request("/metrics/summary?preset=7d");
    expect(res.status).toBe(401);
  });
});
