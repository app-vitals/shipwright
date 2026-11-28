/**
 * metrics/src/api.readiness.smoke.test.ts
 * Smoke (RDY-5.1): GET /metrics/readiness — authenticated fleet readiness
 * roll-up passed through from the task store, with no public variant. Real
 * TaskStoreProvider over recorded fixtures; no mock.module(), no globals.
 */

import { describe, expect, test } from "bun:test";
import { createMetricsApp, type MetricsDeps } from "./api.ts";
import { createFixtureTaskStoreProvider } from "./fixtures/task-store-fixtures.ts";
import { FixedClock, makeAccountsClientMock } from "./lib/test-helpers.ts";
import { TaskStoreProvider } from "./providers/task-store-provider.ts";
import {
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "./providers/task-store-recorded.ts";
import { ReadinessResultSchema } from "./schemas.ts";

const noopAccountsClient = makeAccountsClientMock(async () => []);

const ZERO_AGG = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};

const SUMMARY = {
  percentAtOrAboveFloor: 50,
  repoCount: 2,
  staleCount: 0,
  levelDistribution: { "0": 0, "1": 0, "2": 1, "3": 0, "4": 1, "5": 0 },
  repos: [
    {
      repo: "org/alpha",
      level: 4,
      failingChecks: [],
      scoredAt: "2026-06-19T00:00:00.000Z",
      stale: false,
    },
    {
      repo: "org/beta",
      level: 2,
      failingChecks: [
        { id: "ci-required", level: 3, owner: "ci-patrol", ownerRunning: true },
        {
          id: "preview-env",
          level: 3,
          owner: "environments-scan",
          ownerRunning: false,
        },
      ],
      scoredAt: "2026-06-19T00:00:00.000Z",
      stale: false,
    },
  ],
  trend: [
    {
      weekStart: "2026-06-13T12:00:00.000Z",
      weekEnd: "2026-06-20T12:00:00.000Z",
      percentAtOrAboveFloor: 50,
      repoCount: 2,
    },
  ],
};

function makeProvider(): TaskStoreProvider {
  return new TaskStoreProvider(
    new RecordedTaskStoreClient([], [], [], [], [], SUMMARY),
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

describe("GET /metrics/readiness (RDY-5.1)", () => {
  test("200, body matches ReadinessResultSchema and mirrors the task-store summary", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, devAuthDeps);
    const res = await app.request("/metrics/readiness");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => ReadinessResultSchema.parse(body.data)).not.toThrow();
    expect(body.data).toEqual(SUMMARY);
    const unowned = body.data.repos[1].failingChecks[1];
    expect(unowned.ownerRunning).toBe(false);
  });

  test("offline fixtures serve a non-empty summary", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, {
      provider: createFixtureTaskStoreProvider(),
      sessionSecret: "",
      dashboardDevAuth: true,
    });
    const res = await app.request("/metrics/readiness");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => ReadinessResultSchema.parse(body.data)).not.toThrow();
    expect(body.data.repos.length).toBeGreaterThan(0);
    expect(body.data.trend).toHaveLength(12);
  });

  test("unauthenticated request → 401", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, {
      provider: makeProvider(),
      sessionSecret: "test-secret-test-secret-test-secret",
      dashboardToken: "dash-token",
    });
    const res = await app.request("/metrics/readiness");
    expect(res.status).toBe(401);
  });

  test("there is no public variant: /public/metrics/readiness → 404", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, devAuthDeps);
    const res = await app.request("/public/metrics/readiness");
    expect(res.status).toBe(404);
  });

  test("a provider without readiness support answers 501", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, {
      provider: {
        query: async () => ({ columns: [], results: [], types: [] }),
      },
      sessionSecret: "",
      dashboardDevAuth: true,
    });
    expect((await app.request("/metrics/readiness")).status).toBe(501);
  });

  test("a provider failure surfaces as a handled error, not a crash", async () => {
    const app = createMetricsApp(new Map(), noopAccountsClient, {
      provider: {
        query: async () => ({ columns: [], results: [], types: [] }),
        readiness: async () => {
          throw new Error("boom");
        },
      },
      sessionSecret: "",
      dashboardDevAuth: true,
    });
    expect(
      (await app.request("/metrics/readiness")).status,
    ).toBeGreaterThanOrEqual(500);
  });
});
