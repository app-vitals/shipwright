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
