/**
 * metrics/src/api.system-crons.smoke.test.ts
 * Smoke (SCM-8.3): GET /metrics/system-crons route shape, range handling and
 * the 501 for providers without system-cron support. Hand-built provider
 * double, dashboardDevAuth bypass (same pattern as api.pr-outcomes.smoke.test).
 */

import { describe, expect, test } from "bun:test";
import { createMetricsApp, type MetricsDeps } from "./api.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import type {
  FilteredCount,
  MetricsProvider,
  QueryDateRange,
  SystemCronMetrics,
} from "./metrics-provider.ts";
import { SystemCronsResultSchema } from "./schemas.ts";

const fc = (count: number): FilteredCount => ({
  count,
  filter: { originKind: "cron", originRef: "c1" },
});

const RESULT: SystemCronMetrics = {
  from: "2026-11-11T08:00:00.000Z",
  to: "2026-11-18T07:59:59.999Z",
  crons: [
    {
      id: "c1",
      name: "Cron one",
      enabled: true,
      schedule: "0 7 * * *",
      fires: fc(2),
      tasksCreated: fc(3),
      buckets: {
        shipped: fc(1),
        inFlight: fc(1),
        stuck: fc(0),
        failed: fc(0),
        noOp: fc(1),
        pending: fc(0),
      },
      followOn: { created: fc(0), shipped: fc(0) },
    },
  ],
  meta: {
    generatedAt: "2026-11-18T12:00:00.000Z",
    repoCount: 2,
    accountId: "default",
  },
};

function makeApp(provider: MetricsProvider) {
  const deps: MetricsDeps = {
    provider,
    sessionSecret: "",
    dashboardDevAuth: true,
  };
  return createMetricsApp(
    new Map(),
    makeAccountsClientMock(async () => []),
    deps,
  );
}

describe("GET /metrics/system-crons", () => {
  test("returns the provider result, conforming to the schema", async () => {
    const seen: QueryDateRange[] = [];
    const app = makeApp({
      query: async () => ({ columns: [], results: [], types: [] }),
      systemCrons: async (range) => {
        seen.push(range);
        return RESULT;
      },
    });
    const res = await app.request("/metrics/system-crons?preset=7d");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(SystemCronsResultSchema.safeParse(body).success).toBe(true);
    expect(body.meta.accountId).toBe("default");
    expect(seen).toEqual(["7d"]);
  });

  test("custom from/to is resolved via resolveDateRange", async () => {
    const seen: QueryDateRange[] = [];
    const app = makeApp({
      query: async () => ({ columns: [], results: [], types: [] }),
      systemCrons: async (range) => {
        seen.push(range);
        return RESULT;
      },
    });
    const res = await app.request(
      "/metrics/system-crons?from=2026-11-01&to=2026-11-03",
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ from: "2026-11-01", to: "2026-11-03" }]);
  });

  test("defaults to today with no params", async () => {
    const seen: QueryDateRange[] = [];
    const app = makeApp({
      query: async () => ({ columns: [], results: [], types: [] }),
      systemCrons: async (range) => {
        seen.push(range);
        return RESULT;
      },
    });
    await app.request("/metrics/system-crons");
    expect(seen).toEqual(["today"]);
  });

  test("400 when only one of from/to is given", async () => {
    const app = makeApp({
      query: async () => ({ columns: [], results: [], types: [] }),
      systemCrons: async () => RESULT,
    });
    const res = await app.request("/metrics/system-crons?from=2026-11-01");
    expect(res.status).toBe(400);
  });

  test("501 when the provider has no system-cron support", async () => {
    const app = makeApp({
      query: async () => ({ columns: [], results: [], types: [] }),
    });
    const res = await app.request("/metrics/system-crons");
    expect(res.status).toBe(501);
  });
});
