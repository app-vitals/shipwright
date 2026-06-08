/**
 * metrics/src/fixtures/posthog-fixtures.integration.test.ts
 * Integration tests: createFixturePostHogClient() implements PostHogClientLike
 * and returns valid HogQLResult for every query type used by the dashboard.
 *
 * No mock.module(), no global.* overrides. Tests the fixture client injected
 * via deps.postHogClient into createMetricsApp.
 */

import { describe, expect, test } from "bun:test";
import { parseApiKeys } from "../lib/api-auth.ts";
import { makeAccountsClientMock } from "../lib/test-helpers.ts";
import { type MetricsDeps, createMetricsApp } from "../api.ts";
import {
  buildFeaturesCiQuery,
  buildFeaturesReviewsQuery,
  buildFeaturesTasksQuery,
  buildQueueCycleMergedQuery,
  buildQueueCycleStartedQuery,
  buildQueueFunnelQuery,
  buildSummaryCycleTimeQuery,
  buildSummaryQuery,
  buildTokensByAgentQuery,
  buildTokensBySessionTypeQuery,
  buildTokensTotalsQuery,
  buildTokensTrendsQuery,
  buildTrendsQuery,
} from "../queries.ts";
import { createFixturePostHogClient } from "./posthog-fixtures.ts";

const ADMIN_KEY = "sk_admin_fixtures";
const apiKeys = parseApiKeys(`admin:${ADMIN_KEY}:*`);
const noopAccountsClient = makeAccountsClientMock(async () => []);

describe("createFixturePostHogClient — implements PostHogClientLike", () => {
  test("query() returns a HogQLResult with columns and results arrays", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query("SELECT 1");
    expect(Array.isArray(result.columns)).toBe(true);
    expect(Array.isArray(result.results)).toBe(true);
    expect(Array.isArray(result.types)).toBe(true);
  });
});

describe("createFixturePostHogClient — summary query", () => {
  test("returns valid columns for buildSummaryQuery", async () => {
    const client = createFixturePostHogClient();
    const hogql = buildSummaryQuery("7d");
    const result = await client.query(hogql);
    expect(result.results.length).toBeGreaterThan(0);
    const row = Object.fromEntries(
      result.columns.map((col, i) => [col, (result.results[0] as unknown[])[i]]),
    );
    expect(typeof row.tasks_completed).toBe("number");
    expect(typeof row.ci_gates_total).toBe("number");
    expect(typeof row.reviews_total).toBe("number");
  });

  test("returns valid columns for buildSummaryCycleTimeQuery", async () => {
    const client = createFixturePostHogClient();
    const hogql = buildSummaryCycleTimeQuery("7d");
    const result = await client.query(hogql);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.columns).toContain("avg_cycle_time_hours");
  });
});

describe("createFixturePostHogClient — trends query", () => {
  test("returns time-series rows for buildTrendsQuery", async () => {
    const client = createFixturePostHogClient();
    const hogql = buildTrendsQuery("7d");
    const result = await client.query(hogql);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.columns).toContain("period");
    expect(result.columns).toContain("tasks_completed");
  });
});

describe("createFixturePostHogClient — features queries", () => {
  test("tasks query returns feature_prefix rows", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildFeaturesTasksQuery("7d"));
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.columns).toContain("feature_prefix");
    expect(result.columns).toContain("tasks_completed");
  });

  test("CI query returns ci_total and ci_first_pass columns", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildFeaturesCiQuery("7d"));
    expect(result.columns).toContain("feature_prefix");
    expect(result.columns).toContain("ci_total");
    expect(result.columns).toContain("ci_first_pass");
  });

  test("reviews query returns reviews_total and reviews_ship_it", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildFeaturesReviewsQuery("7d"));
    expect(result.columns).toContain("feature_prefix");
    expect(result.columns).toContain("reviews_total");
    expect(result.columns).toContain("reviews_ship_it");
  });
});

describe("createFixturePostHogClient — queue queries", () => {
  test("funnel query returns tasks_started and avg_review_findings", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildQueueFunnelQuery("7d"));
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.columns).toContain("tasks_started");
    expect(result.columns).toContain("avg_review_findings");
  });

  test("cycle started query returns task_id and timestamp", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildQueueCycleStartedQuery("7d"));
    expect(result.columns).toContain("task_id");
    expect(result.columns).toContain("timestamp");
  });

  test("cycle merged query returns task_id and timestamp", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildQueueCycleMergedQuery("7d"));
    expect(result.columns).toContain("task_id");
    expect(result.columns).toContain("timestamp");
  });
});

describe("createFixturePostHogClient — tokens queries", () => {
  test("totals query returns all token columns", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildTokensTotalsQuery("7d"));
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.columns).toContain("input_tokens");
    expect(result.columns).toContain("output_tokens");
    expect(result.columns).toContain("total_tokens");
  });

  test("by session type query returns session_type grouping", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildTokensBySessionTypeQuery("7d"));
    expect(result.columns).toContain("session_type");
    expect(result.columns).toContain("total_tokens");
  });

  test("by agent query returns agent_id grouping", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildTokensByAgentQuery("7d"));
    expect(result.columns).toContain("agent_id");
    expect(result.columns).toContain("total_tokens");
  });

  test("trends query returns period and daily token sums", async () => {
    const client = createFixturePostHogClient();
    const result = await client.query(buildTokensTrendsQuery("7d"));
    expect(result.columns).toContain("period");
    expect(result.columns).toContain("total_tokens");
  });
});

describe("createFixturePostHogClient — injected via deps.postHogClient", () => {
  test("summary endpoint returns 200 with fixture data via DI seam", async () => {
    const deps: MetricsDeps = {
      postHogClient: createFixturePostHogClient(),
      sessionSecret: "",
      offlineMode: true,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.data.tasksCompleted).toBe("number");
    expect(body.data.tasksCompleted).toBeGreaterThanOrEqual(0);
  });

  test("tokens endpoint returns 200 with fixture data via DI seam", async () => {
    const deps: MetricsDeps = {
      postHogClient: createFixturePostHogClient(),
      sessionSecret: "",
      offlineMode: true,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals).toBeTruthy();
    expect(body.data.totals.total).toBeGreaterThan(0);
  });
});
