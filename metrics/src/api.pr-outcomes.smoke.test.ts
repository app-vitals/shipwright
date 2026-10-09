/**
 * metrics/src/api.pr-outcomes.smoke.test.ts
 * Smoke (PAU-1.8): GET /metrics/pr-outcomes route shape. Hand-built
 * MetricsProvider double, dashboardDevAuth bypass (same pattern as
 * api.merged-prs.smoke.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { createMetricsApp, type MetricsDeps } from "./api.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import type { MetricsProvider } from "./metrics-provider.ts";
import { PrOutcomesResultSchema } from "./schemas.ts";

const COLUMNS = [
  "context_fingerprint",
  "window_from",
  "window_to",
  "prs",
  "merged",
  "approved",
  "posted",
  "other",
  "avg_review_cycles",
  "avg_patch_cycles",
  "median_time_to_merge_ms",
];

const provider: MetricsProvider = {
  query: async (q) => ({
    columns: q.kind === "prOutcomes" ? COLUMNS : [],
    results:
      q.kind === "prOutcomes"
        ? [
            [
              "fp-a",
              "2026-06-01T00:00:00.000Z",
              "2026-06-04T00:00:00.000Z",
              4,
              3,
              2,
              1,
              1,
              1.5,
              0.75,
              14400000,
            ],
            [
              "fp-b",
              "2026-06-08T00:00:00.000Z",
              "2026-06-08T23:00:00.000Z",
              0,
              0,
              0,
              0,
              0,
              null,
              null,
              null,
            ],
          ]
        : [],
    types: [],
  }),
};

const deps: MetricsDeps = {
  provider,
  sessionSecret: "",
  dashboardDevAuth: true,
};
const app = () =>
  createMetricsApp(
    new Map(),
    makeAccountsClientMock(async () => []),
    deps,
  );

describe("GET /metrics/pr-outcomes (PAU-1.8)", () => {
  test("200, schema-valid, labelled as window correlation", async () => {
    const res = await app().request("/metrics/pr-outcomes?preset=7d");
    expect(res.status).toBe(200);
    const body = PrOutcomesResultSchema.parse(await res.json());
    expect(body.attribution).toBe("window-correlation");
    expect(body.series[0]).toMatchObject({
      contextFingerprint: "fp-a",
      reviewState: { approved: 2, posted: 1, other: 1 },
      avgReviewCycles: 1.5,
      medianTimeToMergeMs: 14400000,
    });
    expect(body.series[1].avgReviewCycles).toBeNull();
  });

  test("400 on half-specified custom range", async () => {
    const res = await app().request("/metrics/pr-outcomes?from=2026-06-01");
    expect(res.status).toBe(400);
  });
});
