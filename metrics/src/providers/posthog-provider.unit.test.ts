/**
 * metrics/src/providers/posthog-provider.unit.test.ts
 * Unit tests for PostHogProvider: each MetricQuery kind routes to the matching
 * builder, the resulting HogQL is handed to the client, and the client result
 * is returned verbatim. Trends must forward its groupBy to the builder.
 */

import { describe, expect, test } from "bun:test";
import type { PostHogClientLike } from "../api.ts";
import type { MetricQuery } from "../metrics-provider.ts";
import type { QueryDateRange, TrendsGroupBy } from "../queries.ts";
import type { HogQLResult } from "../types.ts";
import { PostHogProvider } from "./posthog-provider.ts";

function makeResult(tag: string): HogQLResult {
  return { columns: [tag], results: [[tag]], types: ["String"] };
}

/** Client that records the last HogQL string it received. */
function recordingClient(): { client: PostHogClientLike; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    client: {
      async query(hogql: string): Promise<HogQLResult> {
        seen.push(hogql);
        return makeResult(hogql);
      },
    },
  };
}

/** Builder overrides that emit a unique sentinel per kind. */
function sentinelBuilders() {
  const groupByCapture: TrendsGroupBy[] = [];
  return {
    groupByCapture,
    builders: {
      summary: (_r: QueryDateRange) => "S:summary",
      summaryCycleTime: (_r: QueryDateRange) => "S:cycle",
      trends: (_r: QueryDateRange, g: TrendsGroupBy) => {
        groupByCapture.push(g);
        return `S:trends:${g}`;
      },
      featuresTasks: (_r: QueryDateRange) => "S:ftasks",
      featuresCi: (_r: QueryDateRange) => "S:fci",
      featuresReviews: (_r: QueryDateRange) => "S:freviews",
      queueFunnel: (_r: QueryDateRange) => "S:qfunnel",
      queueCycleStarted: (_r: QueryDateRange) => "S:qstarted",
      queueCycleMerged: (_r: QueryDateRange) => "S:qmerged",
      tokensTotals: (_r: QueryDateRange) => "S:ttotals",
      tokensBySessionType: (_r: QueryDateRange) => "S:tsession",
      tokensByAgent: (_r: QueryDateRange) => "S:tagent",
      tokensTrends: (_r: QueryDateRange) => "S:ttrends",
    },
  };
}

const cases: Array<{ q: MetricQuery; expected: string }> = [
  { q: { kind: "summary", range: "today" }, expected: "S:summary" },
  { q: { kind: "summaryCycleTime", range: "today" }, expected: "S:cycle" },
  { q: { kind: "featuresTasks", range: "today" }, expected: "S:ftasks" },
  { q: { kind: "featuresCi", range: "today" }, expected: "S:fci" },
  { q: { kind: "featuresReviews", range: "today" }, expected: "S:freviews" },
  { q: { kind: "queueFunnel", range: "today" }, expected: "S:qfunnel" },
  { q: { kind: "queueCycleStarted", range: "today" }, expected: "S:qstarted" },
  { q: { kind: "queueCycleMerged", range: "today" }, expected: "S:qmerged" },
  { q: { kind: "tokensTotals", range: "today" }, expected: "S:ttotals" },
  {
    q: { kind: "tokensBySessionType", range: "today" },
    expected: "S:tsession",
  },
  { q: { kind: "tokensByAgent", range: "today" }, expected: "S:tagent" },
  { q: { kind: "tokensTrends", range: "today" }, expected: "S:ttrends" },
];

describe("PostHogProvider routing", () => {
  for (const { q, expected } of cases) {
    test(`${q.kind} routes to its builder and returns the client result`, async () => {
      const { client, seen } = recordingClient();
      const { builders } = sentinelBuilders();
      const provider = new PostHogProvider(client, builders);

      const result = await provider.query(q);

      expect(seen).toEqual([expected]);
      expect(result.columns).toEqual([expected]);
    });
  }

  test("trends forwards groupBy to the builder", async () => {
    const { client, seen } = recordingClient();
    const { builders, groupByCapture } = sentinelBuilders();
    const provider = new PostHogProvider(client, builders);

    await provider.query({ kind: "trends", range: "7d", groupBy: "week" });

    expect(groupByCapture).toEqual(["week"]);
    expect(seen).toEqual(["S:trends:week"]);
  });
});
