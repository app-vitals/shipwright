/**
 * metrics/src/api.merged-prs.smoke.test.ts
 * Smoke coverage (POM-2.1): GET /metrics/merged-prs — the authenticated,
 * all-repo merged-PRs-by-repo-and-origin endpoint.
 *
 * Drives the authenticated app via app.request() (no real server, no
 * network). Uses the dashboardDevAuth bypass (matches
 * api.tokens-phase.smoke.test.ts's pattern) plus a hand-built MetricsProvider
 * double injected via MetricsDeps — no mock.module(), no global overrides.
 * Covers:
 *   - 200 + zod-schema-shaped body on a valid request
 *   - 400 on missing groupBy
 *   - 400 on invalid groupBy
 */

import { describe, expect, test } from "bun:test";
import { createMetricsApp, type MetricsDeps } from "./api.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import type { MetricsProvider } from "./metrics-provider.ts";
import { MergedPrsResultSchema } from "./schemas.ts";
import type { HogQLResult } from "./types.ts";

const noopAccountsClient = makeAccountsClientMock(async () => []);

const emptyResult: HogQLResult = {
  columns: [],
  results: [],
  types: [],
  hasMore: false,
  limit: 100,
  offset: 0,
};

function makeProvider(): MetricsProvider {
  return {
    query: async (q) => {
      if (q.kind === "mergedPrsByRepo") {
        return {
          columns: ["repo", "origin", "period", "count"],
          results: [
            ["org/alpha", "shipwright", "2026-06-01", 2],
            ["org/alpha", "ci", "2026-06-01", 1],
            ["org/beta", "unknown", "2026-06-08", 1],
          ],
          types: [],
        };
      }
      return emptyResult;
    },
  };
}

function makeDevAuthDeps(
  provider: MetricsProvider = makeProvider(),
): MetricsDeps {
  return {
    provider,
    sessionSecret: "",
    dashboardDevAuth: true,
  };
}

describe("GET /metrics/merged-prs (POM-2.1)", () => {
  test("valid request → 200, body validates against MergedPrsResultSchema", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/merged-prs?preset=7d&groupBy=week");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(() => MergedPrsResultSchema.parse(body.data)).not.toThrow();
    expect(body.data.groupBy).toBe("week");
    expect(typeof body.data.from).toBe("string");
    expect(typeof body.data.to).toBe("string");
  });

  test("valid request → repos[] totals and trend[] rows reflect the grouped counts", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/merged-prs?preset=7d&groupBy=week");
    const body = await res.json();

    const alpha = body.data.repos.find(
      (r: { repo: string }) => r.repo === "org/alpha",
    );
    const beta = body.data.repos.find(
      (r: { repo: string }) => r.repo === "org/beta",
    );
    expect(alpha.total).toBe(3);
    expect(alpha.byOrigin).toEqual({
      shipwright: 2,
      ci: 1,
      dependency_bot: 0,
      human: 0,
      unknown: 0,
    });
    expect(beta.total).toBe(1);
    expect(beta.byOrigin.unknown).toBe(1);

    expect(body.data.trend).toHaveLength(2);
    const alphaTrend = body.data.trend.find(
      (t: { repo: string }) => t.repo === "org/alpha",
    );
    expect(alphaTrend.period).toBe("2026-06-01");
    expect(alphaTrend.byOrigin.shipwright).toBe(2);
    expect(alphaTrend.byOrigin.ci).toBe(1);
  });

  test("missing groupBy → 400", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request("/metrics/merged-prs?preset=7d");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("invalid groupBy → 400", async () => {
    const app = createMetricsApp(
      new Map(),
      noopAccountsClient,
      makeDevAuthDeps(),
    );
    const res = await app.request(
      "/metrics/merged-prs?preset=7d&groupBy=month",
    );
    expect(res.status).toBe(400);
  });

  test("no auth, dev-auth disabled → 401", async () => {
    const deps: MetricsDeps = { provider: makeProvider(), sessionSecret: "" };
    const app = createMetricsApp(new Map(), noopAccountsClient, deps);
    const res = await app.request("/metrics/merged-prs?preset=7d&groupBy=day");
    expect(res.status).toBe(401);
  });
});
