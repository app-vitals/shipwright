/**
 * metrics/src/api.coverage.smoke.test.ts
 * Smoke (CVT-3.1): GET /metrics/coverage — authenticated, all-repo coverage
 * per repo with deltaVsPrevious/stale and a trend. Real TaskStoreProvider over
 * recorded fixtures + an injected Clock; no mock.module(), no global overrides.
 */

import { describe, expect, test } from "bun:test";
import { createMetricsApp, type MetricsDeps } from "./api.ts";
import { FixedClock, makeAccountsClientMock } from "./lib/test-helpers.ts";
import { TaskStoreProvider } from "./providers/task-store-provider.ts";
import {
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "./providers/task-store-recorded.ts";
import { CoverageResultSchema } from "./schemas.ts";

const noopAccountsClient = makeAccountsClientMock(async () => []);

const ZERO_AGG = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

function makeProvider(): TaskStoreProvider {
  return new TaskStoreProvider(
    new RecordedTaskStoreClient(
      [],
      [],
      [
        {
          repo: "org/alpha",
          commitSha: "a1",
          linesPct: 80,
          branchesPct: 70,
          functionsPct: 85,
          measuredAt: "2026-06-10T00:00:00.000Z",
        },
        {
          repo: "org/alpha",
          commitSha: "a2",
          linesPct: 82.5,
          branchesPct: null,
          functionsPct: null,
          measuredAt: "2026-06-18T00:00:00.000Z",
        },
        {
          repo: "org/beta",
          commitSha: "b1",
          linesPct: 64,
          branchesPct: null,
          functionsPct: null,
          measuredAt: "2026-05-01T00:00:00.000Z",
        },
      ],
    ),
    new RecordedAdminMetricsClient(
      {
        totals: ZERO_AGG,
        byAgent: [],
        byCron: [],
        byModel: [],
        daily: [],
        byCronModel: [],
        byPhase: [],
      },
      { totals: ZERO_AGG, byAgent: [], byModel: [], daily: [] },
    ),
    FixedClock("2026-06-20T12:00:00.000Z"),
  );
}

const devAuthDeps: MetricsDeps = {
  provider: makeProvider(),
  sessionSecret: "",
  dashboardDevAuth: true,
};

describe("GET /metrics/coverage (CVT-3.1)", () => {
  test("200, body matches CoverageResultSchema with repos + trend", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, devAuthDeps);
    const res = await app.request("/metrics/coverage?preset=30d");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => CoverageResultSchema.parse(body.data)).not.toThrow();

    expect(body.data.repos).toHaveLength(2);
    const alpha = body.data.repos.find(
      (r: { repo: string }) => r.repo === "org/alpha",
    );
    const beta = body.data.repos.find(
      (r: { repo: string }) => r.repo === "org/beta",
    );
    expect(alpha).toEqual({
      repo: "org/alpha",
      linesPct: 82.5,
      branchesPct: null,
      functionsPct: null,
      commitSha: "a2",
      measuredAt: "2026-06-18T00:00:00.000Z",
      deltaVsPrevious: 2.5,
      stale: false,
    });
    expect(beta.deltaVsPrevious).toBeNull();
    expect(beta.stale).toBe(true);
    expect(
      body.data.trend.map((t: { commitSha: string }) => t.commitSha),
    ).toEqual(["a1", "a2"]);
  });

  test("no params defaults to today; preset/custom change the trend and meta", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, devAuthDeps);
    const get = async (qs: string) => {
      const res = await app.request(`/metrics/coverage${qs}`);
      expect(res.status).toBe(200);
      return res.json();
    };
    const none = await get("");
    expect(none.data.trend).toEqual([]);
    const d7 = await get("?preset=7d");
    expect(
      d7.data.trend.map((t: { commitSha: string }) => t.commitSha),
    ).toEqual(["a2"]);
    expect(d7.meta.dateRange.from < d7.meta.dateRange.to).toBe(true);
    const d90 = await get("?preset=90d");
    expect(
      d90.data.trend.map((t: { commitSha: string }) => t.commitSha),
    ).toEqual(["b1", "a1", "a2"]);
    const custom = await get("?from=2026-06-01&to=2026-06-12");
    expect(
      custom.data.trend.map((t: { commitSha: string }) => t.commitSha),
    ).toEqual(["a1"]);
    expect(custom.meta.dateRange.from).toContain("2026-06-01");
  });

  test("invalid custom range → 400", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, devAuthDeps);
    expect(
      (await app.request("/metrics/coverage?from=2026-06-01")).status,
    ).toBe(400);
  });

  test("unauthenticated request → 401", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, {
      provider: makeProvider(),
      sessionSecret: "test-secret-test-secret-test-secret",
      dashboardToken: "dash-token",
    });
    const res = await app.request("/metrics/coverage");
    expect(res.status).toBe(401);
  });

  test("a provider failure surfaces as a handled error, not a crash", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, {
      provider: {
        query: async () => {
          throw new Error("boom");
        },
      },
      sessionSecret: "",
      dashboardDevAuth: true,
    });
    const res = await app.request("/metrics/coverage");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
