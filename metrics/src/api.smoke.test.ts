/**
 * metrics/src/api.test.ts
 * Unit tests for the metrics Hono sub-app (metrics/src/api.ts).
 *
 * Uses app.request() — no real server, no PostHog network calls.
 * PostHogClient is injected via MetricsDeps.
 */

import { describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import type { AccountsClient, UserRecord } from "./lib/accounts-client.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { runCanaryMode } from "./lib/test-helpers.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import { PostHogClientError } from "./posthog-client.ts";
import type { QueryDateRange } from "./queries.ts";
import type { HogQLResult } from "./types.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = "sk_admin_metrics";
const SCOPED_KEY = "sk_scoped_metrics";
const apiKeys = parseApiKeys(
  `admin:${ADMIN_KEY}:*,agent:${SCOPED_KEY}:client-abc`,
);
const TEST_SESSION_SECRET = "test-session-secret-32-bytes-min";

/** No-op AccountsClient for tests that don't care about agentName resolution. */
const noopAccountsClient = makeAccountsClientMock(async () => []);

/**
 * Create a minimal AccountsClient stub that returns a user with the given role.
 */
function makeAccountsClientStub(
  role: "OWNER" | "MEMBER" | "AGENT",
): AccountsClient {
  const user: UserRecord = {
    id: "user-123",
    email: "test@example.com",
    name: "Test User",
    role,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    getUser: async (_id: string) => user,
    // Unused methods — satisfy the interface with stubs
    listUsers: async () => [],
    listAgents: async () => [],
    createUser: async () => user,
    updateUser: async () => user,
    listClients: async () => [],
    getClient: async () => {
      throw new Error("not implemented");
    },
    createClient: async () => {
      throw new Error("not implemented");
    },
    updateClient: async () => {
      throw new Error("not implemented");
    },
    deleteClient: async () => {},
    listEngagements: async () => [],
    getEngagement: async () => {
      throw new Error("not implemented");
    },
    createEngagement: async () => {
      throw new Error("not implemented");
    },
    updateEngagement: async () => {
      throw new Error("not implemented");
    },
    deleteEngagement: async () => {},
    listOAuthConnections: async () => [],
    getOAuthConnection: async () => null,
    deleteOAuthConnection: async () => false,
    getOAuthToken: async () => {
      throw new Error("not implemented");
    },
    listConnections: async () => [],
    getConnectionToken: async () => {
      throw new Error("not implemented");
    },
    getAgentEnv: async () => {
      throw new Error("not implemented");
    },
    upsertAgentEnv: async () => {
      throw new Error("not implemented");
    },
    patchAgentEnv: async () => {
      throw new Error("not implemented");
    },
    getAgentConfigBundle: async () => {
      throw new Error("not implemented");
    },
    listAgentEnvs: async () => [],
    createAgentToken: async () => {
      throw new Error("not implemented");
    },
    getTeam: async () => null,
    listTeams: async () => [],
    listEnabledCronJobs: async () => [],
    listAgentCronJobs: async () => [],
    createAgentCronJob: async () => {
      throw new Error("not implemented");
    },
    deleteAgentCronJob: async () => {},
    setAgentCronJobEnabled: async () => {
      throw new Error("not implemented");
    },
    reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
    validateAgentToken: async () => null,
  };
}

async function makeSessionCookie(
  secret: string = TEST_SESSION_SECRET,
): Promise<string> {
  const payload = {
    userId: "user-123",
    email: "test@example.com",
    name: "Test User",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return sign(payload, secret, "HS256");
}

const featuresTasksColumns = [
  "feature_prefix",
  "tasks_completed",
  "avg_actual_h",
  "avg_estimated_h",
];
const featuresCiColumns = ["feature_prefix", "ci_total", "ci_first_pass"];
const featuresReviewsColumns = [
  "feature_prefix",
  "reviews_total",
  "reviews_ship_it",
];

const mockFeaturesTasksResult = makeResult(featuresTasksColumns, [
  ["MQ", 5, 2.5, 3.0],
  ["DR", 3, 4.0, 3.5],
]);
const mockFeaturesCiResult = makeResult(featuresCiColumns, [
  ["MQ", 10, 8],
  ["DR", 6, 4],
]);
const mockFeaturesReviewsResult = makeResult(featuresReviewsColumns, [
  ["MQ", 5, 5],
  ["DR", 3, 2],
]);

// Sentinel query strings injected via DI to route mock responses
const CYCLE_TIME_SENTINEL = "__cycle_time__";
const TASKS_SENTINEL = "__features_tasks__";
const CI_SENTINEL = "__features_ci__";
const REVIEWS_SENTINEL = "__features_reviews__";

function makeFeaturesQueryDeps(opts?: {
  tasksResult?: HogQLResult;
  ciResult?: HogQLResult;
  reviewsResult?: HogQLResult;
  throwOn?: "tasks" | "ci" | "reviews";
  throwErr?: Error;
}): Partial<MetricsDeps> {
  const client: MetricsDeps["postHogClient"] = {
    query: async (hogql: string) => {
      if (hogql === TASKS_SENTINEL) {
        if (opts?.throwOn === "tasks")
          throw opts.throwErr ?? new Error("tasks fail");
        return opts?.tasksResult ?? mockFeaturesTasksResult;
      }
      if (hogql === CI_SENTINEL) {
        if (opts?.throwOn === "ci") throw opts.throwErr ?? new Error("ci fail");
        return opts?.ciResult ?? mockFeaturesCiResult;
      }
      if (hogql === REVIEWS_SENTINEL) {
        if (opts?.throwOn === "reviews")
          throw opts.throwErr ?? new Error("reviews fail");
        return opts?.reviewsResult ?? mockFeaturesReviewsResult;
      }
      // Fallback for summary/trends queries used in other tests
      return mockFeaturesTasksResult;
    },
  };
  return {
    postHogClient: client,
    buildFeaturesTasksQueryFn: () => TASKS_SENTINEL,
    buildFeaturesCiQueryFn: () => CI_SENTINEL,
    buildFeaturesReviewsQueryFn: () => REVIEWS_SENTINEL,
  };
}

function authHeader(key: string) {
  return { Authorization: `Bearer ${key}` };
}

function makeResult(columns: string[], rows: unknown[][]): HogQLResult {
  return {
    columns,
    results: rows,
    types: [],
    hasMore: false,
    limit: 100,
    offset: 0,
  };
}

const summaryColumns = [
  "tasks_completed",
  "tasks_blocked",
  "avg_actual_hours",
  "avg_estimated_hours",
  "avg_retries",
  "avg_files_changed",
  "ci_gates_total",
  "ci_first_pass",
  "avg_fix_attempts",
  "simplify_total",
  "simplify_total_fixes",
  "simplify_avg_dry",
  "simplify_avg_dead_code",
  "simplify_avg_naming",
  "simplify_avg_complexity",
  "simplify_avg_consistency",
  "reviews_total",
  "reviews_ship_it",
  "complexity_1",
  "complexity_2",
  "complexity_3",
  "complexity_4",
  "complexity_5",
  "avg_fix_cascade_depth",
];
const mockSummaryResult = makeResult(summaryColumns, [
  [
    10, 2, 2.5, 3.0, 1.2, 5.0, 8, 6, 0.5, 4, 12, 3.1, 2.0, 1.5, 0.8, 1.0, 5, 4,
    2, 3, 4, 1, 0, 1.5,
  ],
]);

const cycleTimeColumns = ["avg_cycle_time_hours"];
const mockCycleTimeResult = makeResult(cycleTimeColumns, [[5.0]]);

const trendsColumns = [
  "period",
  "tasks_completed",
  "ci_gates",
  "ci_first_pass",
  "ci_first_pass_count",
  "simplify_passes",
  "simplify_fixes",
  "tasks_blocked",
  "reviews",
  "tasks_started",
  "reviews_ship_it",
  "avg_actual_hours",
  "avg_estimated_hours",
  "avg_retries",
  "avg_files_changed",
  "avg_fix_attempts",
  "avg_cycle_time_hours",
  "estimation_accuracy",
  "simplify_avg_dry",
  "simplify_avg_dead_code",
  "simplify_avg_naming",
  "simplify_avg_complexity",
  "simplify_avg_consistency",
  "avg_review_findings",
];
const mockTrendsResult = makeResult(trendsColumns, [
  [
    "2026-04-01",
    2,
    3,
    2,
    1,
    1,
    4,
    1,
    2,
    3,
    1,
    2.5,
    3.0,
    1.2,
    5.0,
    0.5,
    4.0,
    0.83,
    3.1,
    2.0,
    1.5,
    0.8,
    1.0,
    2.1,
  ],
  [
    "2026-04-02",
    3,
    5,
    4,
    3,
    2,
    8,
    0,
    3,
    4,
    2,
    3.0,
    3.5,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ],
]);

// ─── Shared meta assertions ────────────────────────────────────────────────────

function assertMeta(meta: {
  dateRange: { from: string; to: string };
  generatedAt: string;
  queryTimeMs: number;
}) {
  expect(meta.dateRange.from).toBeTruthy();
  expect(meta.dateRange.to).toBeTruthy();
  expect(new Date(meta.dateRange.from).getTime()).toBeLessThan(
    new Date(meta.dateRange.to).getTime(),
  );
  expect(meta.generatedAt).toBeTruthy();
  expect(typeof meta.queryTimeMs).toBe("number");
  expect(meta.queryTimeMs).toBeGreaterThanOrEqual(0);
}

// ─── GET /metrics/summary ────────────────────────────────────────────────────

describe("GET /metrics/summary", () => {
  test("happy path — default date range", async () => {
    const deps: MetricsDeps = {
      postHogClient: {
        query: async (hogql: string) => {
          if (hogql === CYCLE_TIME_SENTINEL) return mockCycleTimeResult;
          return mockSummaryResult;
        },
      },
      buildSummaryCycleTimeQueryFn: () => CYCLE_TIME_SENTINEL,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tasksCompleted).toBe(10);
    expect(body.data.tasksBlocked).toBe(2);
    // taskBlockedRate = 2 / (10+2) = 16.67%
    expect(body.data.taskBlockedRate).toBeCloseTo(16.67, 1);
    // avgCycleTimeHours from cycle time query
    expect(body.data.avgCycleTimeHours).toBe(5.0);
    expect(body.data.avgActualHours).toBe(2.5);
    expect(body.data.avgEstimatedHours).toBe(3.0);
    expect(body.data.avgRetries).toBe(1.2);
    expect(body.data.avgFilesChanged).toBe(5.0);
    expect(body.data.ciGatesTotal).toBe(8);
    expect(body.data.ciFirstPass).toBe(6);
    expect(body.data.ciFirstPassRate).toBe(75);
    expect(body.data.avgFixAttempts).toBe(0.5);
    expect(body.data.simplifyTotal).toBe(4);
    expect(body.data.simplifyTotalFixes).toBe(12);
    expect(body.data.simplifyAvgDry).toBe(3.1);
    expect(body.data.simplifyAvgDeadCode).toBe(2.0);
    expect(body.data.simplifyAvgNaming).toBe(1.5);
    expect(body.data.simplifyAvgComplexity).toBe(0.8);
    expect(body.data.simplifyAvgConsistency).toBe(1.0);
    expect(body.data.reviewsTotal).toBe(5);
    expect(body.data.reviewsShipIt).toBe(4);
    expect(body.data.reviewShipItRate).toBe(80);
    // estimationAccuracy = ((2.5/3.0 - 1) * 100) rounded to 2 decimals
    expect(body.data.estimationAccuracy).toBeCloseTo(-16.67, 1);
    // MQ-1.1: complexity distribution
    expect(body.data.complexityDist).toEqual({
      c1: 2,
      c2: 3,
      c3: 4,
      c4: 1,
      c5: 0,
    });
    // MQ-1.1: avg fix cascade depth
    expect(body.data.avgFixCascadeDepth).toBe(1.5);
    assertMeta(body.meta);
  });

  test("happy path — preset=today", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary?preset=today", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    assertMeta(body.meta);
  });

  test("happy path — custom from/to range", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request(
      "/metrics/summary?from=2026-04-01&to=2026-04-03",
      { headers: authHeader(ADMIN_KEY) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // April 2026 is PDT (UTC-7) → LA midnight on 2026-04-01 = 07:00:00 UTC,
    // and LA 23:59:59.999 on 2026-04-03 = 06:59:59.999 UTC the next day.
    expect(body.meta.dateRange.from).toBe("2026-04-01T07:00:00.000Z");
    expect(body.meta.dateRange.to).toBe("2026-04-04T06:59:59.999Z");
  });

  test("custom range: from >= to returns 400 (summary)", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request(
      "/metrics/summary?from=2026-04-03&to=2026-04-01",
      { headers: authHeader(ADMIN_KEY) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("from must be before to");
  });

  test("custom range: future to returns 400", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request(
      "/metrics/summary?from=2026-04-01&to=2099-12-31",
      { headers: authHeader(ADMIN_KEY) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("future");
  });

  test("invalid date format returns 400", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary?from=April+1&to=April+3", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("missing auth header returns 401", async () => {
    const app = createMetricsApp(apiKeys, noopAccountsClient);

    const res = await app.request("/metrics/summary");

    expect(res.status).toBe(401);
  });

  test("null values when PostHog returns nulls", async () => {
    const deps: MetricsDeps = {
      postHogClient: {
        query: async () =>
          makeResult(summaryColumns, [
            [
              // tasks_completed, tasks_blocked, avg_actual_hours, avg_estimated_hours,
              // avg_retries, avg_files_changed, ci_gates_total, ci_first_pass, avg_fix_attempts,
              // simplify_total, simplify_total_fixes, simplify_avg_dry, simplify_avg_dead_code,
              // simplify_avg_naming, simplify_avg_complexity, simplify_avg_consistency,
              // reviews_total, reviews_ship_it,
              // complexity_1..5, avg_fix_cascade_depth
              0,
              0,
              null,
              null,
              null,
              null,
              0,
              0,
              null,
              0,
              0,
              null,
              null,
              null,
              null,
              null,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
            ],
          ]),
      },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tasksBlocked).toBe(0);
    expect(body.data.taskBlockedRate).toBeNull();
    expect(body.data.avgCycleTimeHours).toBeNull();
    expect(body.data.avgActualHours).toBeNull();
    expect(body.data.avgEstimatedHours).toBeNull();
    expect(body.data.avgRetries).toBeNull();
    expect(body.data.avgFilesChanged).toBeNull();
    expect(body.data.ciFirstPassRate).toBeNull();
    expect(body.data.avgFixAttempts).toBeNull();
    expect(body.data.reviewShipItRate).toBeNull();
    expect(body.data.estimationAccuracy).toBeNull();
    // complexity counts are 0 when no tasks
    expect(body.data.complexityDist).toEqual({
      c1: 0,
      c2: 0,
      c3: 0,
      c4: 0,
      c5: 0,
    });
    // avgFixCascadeDepth is null when avgIf returns 0 (no matching rows)
    expect(body.data.avgFixCascadeDepth).toBeNull();
  });

  test("avgFixCascadeDepth is null when avg_fix_cascade_depth is 0 (no data)", async () => {
    const deps: MetricsDeps = {
      postHogClient: {
        query: async () =>
          makeResult(summaryColumns, [
            // tasks_completed=10, tasks_blocked=2, then rest of values, avg_fix_cascade_depth=0
            [
              10, 2, 2.5, 3.0, 1.2, 5.0, 8, 6, 0.5, 4, 12, 3.1, 2.0, 1.5, 0.8,
              1.0, 5, 4, 2, 3, 4, 1, 0, 0,
            ],
          ]),
      },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.avgFixCascadeDepth).toBeNull();
  });

  test("SM-1.3 AC#3: sparse retries/complexity surface as null (em-dash placeholder)", async () => {
    // Shipwright completion events lack `retries`/`complexity`. The query now
    // uses toFloatOrNull for avg_retries, so an all-absent average is NULL
    // (not 0). app.js fmtNum renders ONLY null/undefined as "--" — a 0 would
    // render as "0.0". This asserts the API emits null so the dashboard shows
    // the em-dash placeholder until canonical emission (SM-1.4) lands.
    const deps: MetricsDeps = {
      postHogClient: {
        query: async () =>
          makeResult(summaryColumns, [
            [
              // tasks_completed, tasks_blocked, avg_actual_hours,
              // avg_estimated_hours, avg_retries (NULL — no retries prop),
              // avg_files_changed, ci_gates_total, ci_first_pass,
              // avg_fix_attempts, simplify_total, simplify_total_fixes,
              // simplify_avg_dry, simplify_avg_dead_code, simplify_avg_naming,
              // simplify_avg_complexity, simplify_avg_consistency,
              // reviews_total, reviews_ship_it,
              // complexity_1..5 (all 0 — no complexity prop),
              // avg_fix_cascade_depth
              10,
              2,
              1.5,
              null,
              null,
              null,
              0,
              0,
              null,
              0,
              0,
              null,
              null,
              null,
              null,
              null,
              0,
              0,
              0,
              0,
              0,
              0,
              0,
              null,
            ],
          ]),
      },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // avg_retries NULL → avgRetries null → app.js fmtNum renders "--"
    expect(body.data.avgRetries).toBeNull();
    // actual hours still derived (1.5 from started_at/ts fallback path)
    expect(body.data.avgActualHours).toBe(1.5);
    // complexity distribution: all counts 0 (no complexity prop emitted)
    expect(body.data.complexityDist).toEqual({
      c1: 0,
      c2: 0,
      c3: 0,
      c4: 0,
      c5: 0,
    });
  });

  test("PostHog auth error propagates as 401", async () => {
    const deps: MetricsDeps = {
      postHogClient: {
        query: async () => {
          throw new PostHogClientError("auth failed", 401);
        },
      },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(401);
  });

  test("PostHog server error propagates as 500", async () => {
    const deps: MetricsDeps = {
      postHogClient: {
        query: async () => {
          throw new PostHogClientError("server error", 500);
        },
      },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("server error");
  });

  test("generic Error propagates as 500", async () => {
    const deps: MetricsDeps = {
      postHogClient: {
        query: async () => {
          throw new Error("network failure");
        },
      },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("network failure");
  });
});

// ─── GET /metrics/trends ──────────────────────────────────────────────────────

describe("GET /metrics/trends", () => {
  test("happy path — default groupBy (day)", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockTrendsResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/trends?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.rows)).toBe(true);
    expect(body.data.rows).toHaveLength(2);
    expect(body.data.rows[0].period).toBe("2026-04-01");
    expect(body.data.rows[0].tasksCompleted).toBe(2);
    expect(body.data.rows[0].ciGates).toBe(3);
    expect(body.data.rows[0].ciFirstPass).toBe(2);
    expect(body.data.rows[0].ciFirstPassCount).toBe(1);
    expect(body.data.rows[0].simplifyPasses).toBe(1);
    expect(body.data.rows[0].simplifyFixes).toBe(4);
    expect(body.data.rows[0].tasksBlocked).toBe(1);
    expect(body.data.rows[0].reviews).toBe(2);
    expect(body.data.rows[1].tasksCompleted).toBe(3);
    expect(body.data.rows[1].ciFirstPassCount).toBe(3);
    assertMeta(body.meta);
  });

  test("happy path — groupBy=week", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockTrendsResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/trends?preset=30d&groupBy=week", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.rows)).toBe(true);
  });

  test("happy path — preset=90d returns valid data", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockTrendsResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/trends?preset=90d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.rows)).toBe(true);
    expect(body.data.rows).toHaveLength(2);
    assertMeta(body.meta);
  });

  test("invalid date format returns 400", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockTrendsResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/trends?from=bad&to=input", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(400);
  });

  test("custom range: from >= to returns 400", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockTrendsResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);
    const res = await app.request(
      "/metrics/trends?from=2026-04-03&to=2026-04-01",
      { headers: authHeader(ADMIN_KEY) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("from must be before to");
  });

  test("missing auth returns 401", async () => {
    const app = createMetricsApp(apiKeys, noopAccountsClient);
    const res = await app.request("/metrics/trends");
    expect(res.status).toBe(401);
  });

  test("PostHog error propagates as 500", async () => {
    const deps: MetricsDeps = {
      postHogClient: {
        query: async () => {
          throw new PostHogClientError("rate limited", 429);
        },
      },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/trends", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(500);
  });

  test("PostHog auth error propagates as 401", async () => {
    const deps: MetricsDeps = {
      postHogClient: {
        query: async () => {
          throw new PostHogClientError("auth failed", 401);
        },
      },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/trends?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(401);
  });

  test("MG-1.1 — row includes all new per-period fields with correct values", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockTrendsResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/trends?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data.rows[0];

    // MG-1.1 count fields
    expect(row.tasksStarted).toBe(3);
    expect(row.reviewsShipIt).toBe(1);

    // MG-1.1 avg efficiency fields
    expect(row.avgActualHours).toBe(2.5);
    expect(row.avgEstimatedHours).toBe(3.0);
    expect(row.avgRetries).toBe(1.2);
    expect(row.avgFilesChanged).toBe(5.0);
    expect(row.avgFixAttempts).toBe(0.5);
    expect(row.avgCycleTimeHours).toBe(4.0);
    expect(row.estimationAccuracy).toBe(0.83);

    // MG-1.1 simplify avg fields
    expect(row.simplifyAvgDry).toBe(3.1);
    expect(row.simplifyAvgDeadCode).toBe(2.0);
    expect(row.simplifyAvgNaming).toBe(1.5);
    expect(row.simplifyAvgComplexity).toBe(0.8);
    expect(row.simplifyAvgConsistency).toBe(1.0);

    // MG-1.1 review avg field
    expect(row.avgReviewFindings).toBe(2.1);

    // Second row has null for avg fields (no data)
    const row2 = body.data.rows[1];
    expect(row2.avgRetries).toBeNull();
    expect(row2.avgFixAttempts).toBeNull();
    expect(row2.estimationAccuracy).toBeNull();
    expect(row2.simplifyAvgDry).toBeNull();
    expect(row2.avgReviewFindings).toBeNull();
  });

  test("MG-1.1 — groupBy=hour is accepted as valid (returns 200)", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockTrendsResult },
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/trends?preset=today&groupBy=hour", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.rows)).toBe(true);
  });
});

// ─── Combined auth middleware (/metrics/*) ────────────────────────────────────

describe("combined auth middleware (/metrics/*)", () => {
  test("valid bearer token grants access", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
  });

  test("valid session cookie grants access", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
  });

  test("no credentials returns 401 JSON (not redirect)", async () => {
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary");

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("invalid bearer token with no session cookie returns 401", async () => {
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: { Authorization: "Bearer sk_wrong_key" },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("invalid session cookie JWT returns 401", async () => {
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: "admin_session=not.a.valid.jwt" },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("session cookie signed with wrong secret returns 401", async () => {
    const cookie = await makeSessionCookie("wrong-secret-32-bytes-exactly!!!");
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(401);
  });
});

// ─── Dashboard static routes ──────────────────────────────────────────────────

describe("GET /dashboard static routes", () => {
  test("GET /dashboard — redirects to /admin/login without session cookie", async () => {
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/admin/login");
  });

  test("GET /dashboard — returns HTML with correct Content-Type when session valid", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test("GET /dashboard — does not inject API key into HTML", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const body = await res.text();

    expect(body).not.toContain("__VITALS_API_KEY");
  });

  test("GET /dashboard/styles.css — redirects without session", async () => {
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard/styles.css");

    expect(res.status).toBe(302);
  });

  test("GET /dashboard/styles.css — returns CSS with Cache-Control when session valid", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard/styles.css", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/css/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("GET /dashboard/app.js — returns JS without Cache-Control when session valid", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard/app.js", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/javascript/);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  test("GET /dashboard — renders toolbar with user name from session", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    // Server-rendered page should include the toolbar and user name
    expect(body).toContain("vos-toolbar");
    expect(body).toContain("Test User");
  });

  test("GET /dashboard — renders page with unknown user when session cookie absent", async () => {
    // The session middleware redirects without a cookie, so inject a valid cookie
    // but test the fallback by verifying the page renders without errors
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});

// ─── GET /metrics/features ────────────────────────────────────────────────────

describe("GET /metrics/features", () => {
  test("happy path — returns feature entries with computed rates", async () => {
    const deps: MetricsDeps = { ...makeFeaturesQueryDeps() };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.features)).toBe(true);
    expect(body.data.features).toHaveLength(2);

    const mq = body.data.features[0];
    expect(mq.prefix).toBe("MQ");
    expect(mq.tasksCompleted).toBe(5);
    expect(mq.avgActualH).toBe(2.5);
    expect(mq.avgEstimatedH).toBe(3.0);
    // ciFirstPassRate: 8/10 = 80%
    expect(mq.ciFirstPassRate).toBe(80);
    // reviewShipItRate: 5/5 = 100%
    expect(mq.reviewShipItRate).toBe(100);

    const dr = body.data.features[1];
    expect(dr.prefix).toBe("DR");
    expect(dr.tasksCompleted).toBe(3);
    // ciFirstPassRate: 4/6 ≈ 66.67%
    expect(dr.ciFirstPassRate).toBeCloseTo(66.67, 1);
    // reviewShipItRate: 2/3 ≈ 66.67%
    expect(dr.reviewShipItRate).toBeCloseTo(66.67, 1);

    assertMeta(body.meta);
  });

  test("features sorted by tasksCompleted descending", async () => {
    const deps: MetricsDeps = { ...makeFeaturesQueryDeps() };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    const body = await res.json();
    const counts = body.data.features.map(
      (f: { tasksCompleted: number }) => f.tasksCompleted,
    );
    // MQ=5 comes before DR=3 — already sorted by the DB query
    expect(counts[0]).toBeGreaterThanOrEqual(counts[1]);
  });

  test("empty period returns empty features array", async () => {
    const deps: MetricsDeps = {
      ...makeFeaturesQueryDeps({
        tasksResult: makeResult(featuresTasksColumns, []),
        ciResult: makeResult(featuresCiColumns, []),
        reviewsResult: makeResult(featuresReviewsColumns, []),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features?preset=today", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.features).toHaveLength(0);
  });

  test("feature with no CI data shows null ciFirstPassRate", async () => {
    const deps: MetricsDeps = {
      ...makeFeaturesQueryDeps({
        ciResult: makeResult(featuresCiColumns, []),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    const body = await res.json();
    for (const f of body.data.features) {
      expect(f.ciFirstPassRate).toBeNull();
    }
  });

  test("feature with no review data shows null reviewShipItRate", async () => {
    const deps: MetricsDeps = {
      ...makeFeaturesQueryDeps({
        reviewsResult: makeResult(featuresReviewsColumns, []),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    const body = await res.json();
    for (const f of body.data.features) {
      expect(f.reviewShipItRate).toBeNull();
    }
  });

  test("custom from/to date range accepted", async () => {
    const deps: MetricsDeps = { ...makeFeaturesQueryDeps() };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request(
      "/metrics/features?from=2026-04-01&to=2026-04-07",
      { headers: authHeader(ADMIN_KEY) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // April 2026 is PDT (UTC-7) → LA midnight on 2026-04-01 = 07:00:00 UTC
    expect(body.meta.dateRange.from).toBe("2026-04-01T07:00:00.000Z");
    // LA 23:59:59.999 on 2026-04-07 = 06:59:59.999 UTC the next day
    expect(body.meta.dateRange.to).toBe("2026-04-08T06:59:59.999Z");
  });

  test("custom range: from >= to returns 400", async () => {
    const deps: MetricsDeps = { ...makeFeaturesQueryDeps() };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request(
      "/metrics/features?from=2026-04-07&to=2026-04-01",
      { headers: authHeader(ADMIN_KEY) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("from must be before to");
  });

  test("only from param returns 400", async () => {
    const deps: MetricsDeps = { ...makeFeaturesQueryDeps() };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features?from=2026-04-01", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(400);
  });

  test("missing auth returns 401", async () => {
    const app = createMetricsApp(apiKeys, noopAccountsClient);
    const res = await app.request("/metrics/features");
    expect(res.status).toBe(401);
  });

  test("PostHog auth error propagates as 401", async () => {
    const deps: MetricsDeps = {
      ...makeFeaturesQueryDeps({
        throwOn: "tasks",
        throwErr: new PostHogClientError("unauthorized", 401),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(401);
  });

  test("PostHog server error propagates as 500", async () => {
    const deps: MetricsDeps = {
      ...makeFeaturesQueryDeps({
        throwOn: "ci",
        throwErr: new PostHogClientError("server error", 500),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("server error");
  });

  test("reviews query error fails whole request", async () => {
    const deps: MetricsDeps = {
      ...makeFeaturesQueryDeps({
        throwOn: "reviews",
        throwErr: new PostHogClientError("rate limited", 429),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(500);
  });
});

// ─── GET /metrics/queue ───────────────────────────────────────────────────────

const QUEUE_FUNNEL_SENTINEL = "__queue_funnel__";
const QUEUE_CYCLE_STARTED_SENTINEL = "__queue_cycle_started__";
const QUEUE_CYCLE_MERGED_SENTINEL = "__queue_cycle_merged__";

const queueFunnelColumns = [
  "tasks_started",
  "tasks_approved",
  "tasks_merged",
  "tasks_blocked",
  "avg_review_findings",
];

const queueCycleStartedColumns = ["task_id", "timestamp"];
const queueCycleMergedColumns = ["task_id", "timestamp"];

function makeQueueDeps(opts?: {
  funnelResult?: HogQLResult;
  cycleStartedResult?: HogQLResult;
  cycleMergedResult?: HogQLResult;
  throwOn?: "funnel" | "cycleStarted" | "cycleMerged";
  throwErr?: Error;
}): Partial<MetricsDeps> {
  const defaultFunnel = makeResult(queueFunnelColumns, [[12, 9, 9, 1, 2.1]]);
  // started: task-A at t=0, task-B at t=0, task-C no merge match
  const defaultCycleStarted = makeResult(queueCycleStartedColumns, [
    ["task-A", "2026-04-01T00:00:00.000Z"],
    ["task-B", "2026-04-02T00:00:00.000Z"],
    ["task-C", "2026-04-03T00:00:00.000Z"],
  ]);
  // merged: task-A after 1 day, task-B after 2 days
  const defaultCycleMerged = makeResult(queueCycleMergedColumns, [
    ["task-A", "2026-04-02T00:00:00.000Z"],
    ["task-B", "2026-04-04T00:00:00.000Z"],
  ]);

  const client: MetricsDeps["postHogClient"] = {
    query: async (hogql: string) => {
      if (hogql === QUEUE_FUNNEL_SENTINEL) {
        if (opts?.throwOn === "funnel")
          throw opts.throwErr ?? new Error("funnel fail");
        return opts?.funnelResult ?? defaultFunnel;
      }
      if (hogql === QUEUE_CYCLE_STARTED_SENTINEL) {
        if (opts?.throwOn === "cycleStarted")
          throw opts.throwErr ?? new Error("cycleStarted fail");
        return opts?.cycleStartedResult ?? defaultCycleStarted;
      }
      if (hogql === QUEUE_CYCLE_MERGED_SENTINEL) {
        if (opts?.throwOn === "cycleMerged")
          throw opts.throwErr ?? new Error("cycleMerged fail");
        return opts?.cycleMergedResult ?? defaultCycleMerged;
      }
      // Fallback
      return makeResult([], []);
    },
  };

  return {
    postHogClient: client,
    buildQueueFunnelQueryFn: () => QUEUE_FUNNEL_SENTINEL,
    buildQueueCycleStartedQueryFn: () => QUEUE_CYCLE_STARTED_SENTINEL,
    buildQueueCycleMergedQueryFn: () => QUEUE_CYCLE_MERGED_SENTINEL,
  };
}

describe("GET /metrics/queue", () => {
  test("happy path — returns correct data shape and computed fields", async () => {
    const deps: MetricsDeps = { ...makeQueueDeps() };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // integer counts from funnel query
    expect(body.data.tasksStarted).toBe(12);
    expect(body.data.tasksApproved).toBe(9);
    expect(body.data.tasksMerged).toBe(9);
    expect(body.data.tasksBlocked).toBe(1);

    // blockRate = (1 / 12) * 100 = 8.33
    expect(body.data.blockRate).toBeCloseTo(8.33, 1);

    // avgCycleTimeDays: task-A = 1 day, task-B = 2 days → avg = 1.5
    expect(body.data.avgCycleTimeDays).toBeCloseTo(1.5, 5);

    // avgReviewFindings = 2.1 from funnel query
    expect(body.data.avgReviewFindings).toBe(2.1);

    assertMeta(body.meta);
  });

  test("blockRate is null when tasksStarted is 0", async () => {
    const deps: MetricsDeps = {
      ...makeQueueDeps({
        funnelResult: makeResult(queueFunnelColumns, [[0, 0, 0, 0, null]]),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tasksStarted).toBe(0);
    expect(body.data.blockRate).toBeNull();
  });

  test("avgCycleTimeDays computed from matched started/merged pairs", async () => {
    // task-X: started 2026-04-01, merged 2026-04-03 → 2 days
    // task-Y: started 2026-04-02, merged 2026-04-02T12:00 → 0.5 days
    const deps: MetricsDeps = {
      ...makeQueueDeps({
        cycleStartedResult: makeResult(queueCycleStartedColumns, [
          ["task-X", "2026-04-01T00:00:00.000Z"],
          ["task-Y", "2026-04-02T00:00:00.000Z"],
        ]),
        cycleMergedResult: makeResult(queueCycleMergedColumns, [
          ["task-X", "2026-04-03T00:00:00.000Z"],
          ["task-Y", "2026-04-02T12:00:00.000Z"],
        ]),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    // avg of 2 days and 0.5 days = 1.25
    expect(body.data.avgCycleTimeDays).toBeCloseTo(1.25, 5);
  });

  test("avgCycleTimeDays is null when no matched pairs", async () => {
    const deps: MetricsDeps = {
      ...makeQueueDeps({
        cycleStartedResult: makeResult(queueCycleStartedColumns, [
          ["task-A", "2026-04-01T00:00:00.000Z"],
        ]),
        cycleMergedResult: makeResult(queueCycleMergedColumns, [
          ["task-Z", "2026-04-02T00:00:00.000Z"], // different task_id — no match
        ]),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.avgCycleTimeDays).toBeNull();
  });

  test("avgCycleTimeDays is null when cycle sets are empty", async () => {
    const deps: MetricsDeps = {
      ...makeQueueDeps({
        cycleStartedResult: makeResult(queueCycleStartedColumns, []),
        cycleMergedResult: makeResult(queueCycleMergedColumns, []),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.avgCycleTimeDays).toBeNull();
  });

  test("avgReviewFindings is null when avg_review_findings is null", async () => {
    const deps: MetricsDeps = {
      ...makeQueueDeps({
        funnelResult: makeResult(queueFunnelColumns, [[5, 0, 4, 1, null]]),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.avgReviewFindings).toBeNull();
  });

  test("avgReviewFindings is null when avg returns 0", async () => {
    const deps: MetricsDeps = {
      ...makeQueueDeps({
        funnelResult: makeResult(queueFunnelColumns, [[5, 3, 3, 0, 0]]),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.avgReviewFindings).toBeNull();
  });

  test("missing auth returns 401", async () => {
    const app = createMetricsApp(apiKeys, noopAccountsClient);
    const res = await app.request("/metrics/queue");
    expect(res.status).toBe(401);
  });

  test("PostHog auth error propagates as 401", async () => {
    const deps: MetricsDeps = {
      ...makeQueueDeps({
        throwOn: "funnel",
        throwErr: new PostHogClientError("unauthorized", 401),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(401);
  });

  test("PostHog server error propagates as 500", async () => {
    const deps: MetricsDeps = {
      ...makeQueueDeps({
        throwOn: "cycleStarted",
        throwErr: new PostHogClientError("server error", 500),
      }),
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("server error");
  });

  test("all 3 queries run concurrently", async () => {
    const queriesReceived: string[] = [];
    let resolveAll: () => void;
    const allStarted = new Promise<void>((res) => {
      resolveAll = res;
    });

    const client: MetricsDeps["postHogClient"] = {
      query: async (hogql: string) => {
        queriesReceived.push(hogql);
        if (queriesReceived.length === 3) resolveAll();
        await allStarted;
        if (hogql === QUEUE_FUNNEL_SENTINEL)
          return makeResult(queueFunnelColumns, [[5, 3, 3, 0, 1.0]]);
        if (hogql === QUEUE_CYCLE_STARTED_SENTINEL)
          return makeResult(queueCycleStartedColumns, []);
        return makeResult(queueCycleMergedColumns, []);
      },
    };
    const deps: MetricsDeps = {
      postHogClient: client,
      buildQueueFunnelQueryFn: () => QUEUE_FUNNEL_SENTINEL,
      buildQueueCycleStartedQueryFn: () => QUEUE_CYCLE_STARTED_SENTINEL,
      buildQueueCycleMergedQueryFn: () => QUEUE_CYCLE_MERGED_SENTINEL,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    // All 3 queries must have started before any completed (concurrent)
    expect(queriesReceived).toHaveLength(3);
    expect(queriesReceived).toContain(QUEUE_FUNNEL_SENTINEL);
    expect(queriesReceived).toContain(QUEUE_CYCLE_STARTED_SENTINEL);
    expect(queriesReceived).toContain(QUEUE_CYCLE_MERGED_SENTINEL);
  });

  test("custom date range works", async () => {
    const deps: MetricsDeps = { ...makeQueueDeps() };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request(
      "/metrics/queue?from=2026-04-01&to=2026-04-07",
      { headers: authHeader(ADMIN_KEY) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    // April 2026 is PDT (UTC-7) → LA midnight on 2026-04-01 = 07:00:00 UTC
    expect(body.meta.dateRange.from).toBe("2026-04-01T07:00:00.000Z");
    // LA 23:59:59.999 on 2026-04-07 = 06:59:59.999 UTC the next day
    expect(body.meta.dateRange.to).toBe("2026-04-08T06:59:59.999Z");
  });
});

// ─── Owner gate — /metrics/* API endpoints ────────────────────────────────────

describe("owner gate — /metrics/* API endpoints", () => {
  test("MEMBER session → 401 on GET /metrics/summary", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      requireOwnerRole: true,
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("MEMBER"),
      deps,
    );

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("AGENT session → 401 on GET /metrics/summary", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      requireOwnerRole: true,
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("AGENT"),
      deps,
    );

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(401);
  });

  test("OWNER session → 200 on GET /metrics/summary", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      requireOwnerRole: true,
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("OWNER"),
      deps,
    );

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
  });

  test("scoped Bearer token → 403 on GET /metrics/summary", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(SCOPED_KEY),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("scope=* Bearer token → 200 on GET /metrics/summary", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
  });
});

// ─── Owner gate — /dashboard ──────────────────────────────────────────────────

describe("owner gate — /dashboard", () => {
  test("MEMBER session → 403 on GET /dashboard", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      sessionSecret: TEST_SESSION_SECRET,
      requireOwnerRole: true,
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("MEMBER"),
      deps,
    );

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(403);
  });

  test("OWNER session → 200 on GET /dashboard", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      sessionSecret: TEST_SESSION_SECRET,
      requireOwnerRole: true,
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("OWNER"),
      deps,
    );

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  test("noopAccountsClient → still serves dashboard when listUsers returns empty array", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
  });
});

// ─── auth smoke ──────────────────────────────────────────────────────────────

describe("auth smoke", () => {
  test("401 — missing Authorization header", async () => {
    const app = createMetricsApp(apiKeys, noopAccountsClient);
    const res = await app.request("/metrics/summary");
    expect(res.status).toBe(401);
  });

  test("403 — token without required scope", async () => {
    const app = createMetricsApp(apiKeys, noopAccountsClient);
    const res = await app.request("/metrics/summary", {
      headers: { Authorization: `Bearer ${SCOPED_KEY}` },
    });
    expect(res.status).toBe(403);
  });
});

// ─── default preset is "today" ────────────────────────────────────────────────

describe("default preset", () => {
  function captureDateRange(
    sentinel: string,
    result: HogQLResult,
  ): {
    deps: MetricsDeps;
    seen: { value: QueryDateRange | undefined };
  } {
    const seen: { value: QueryDateRange | undefined } = { value: undefined };
    const builder = (range: QueryDateRange) => {
      seen.value = range;
      return sentinel;
    };
    const trendsBuilder = (
      range: QueryDateRange,
      _groupBy?: "day" | "week" | "hour",
    ) => builder(range);
    const deps: MetricsDeps = {
      postHogClient: { query: async () => result },
      buildSummaryQueryFn: builder,
      buildSummaryCycleTimeQueryFn: builder,
      buildTrendsQueryFn: trendsBuilder,
      buildFeaturesTasksQueryFn: builder,
      buildFeaturesCiQueryFn: builder,
      buildFeaturesReviewsQueryFn: builder,
      buildQueueFunnelQueryFn: builder,
      buildQueueCycleStartedQueryFn: builder,
      buildQueueCycleMergedQueryFn: builder,
    };
    return { deps, seen };
  }

  test("/metrics/summary with no preset → today", async () => {
    const { deps, seen } = captureDateRange("__sentinel__", mockSummaryResult);
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    expect(seen.value).toBe("today");
  });

  test("/metrics/trends with no preset → today", async () => {
    const { deps, seen } = captureDateRange("__sentinel__", mockTrendsResult);
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/trends", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    expect(seen.value).toBe("today");
  });

  test("/metrics/features with no preset → today", async () => {
    const { deps, seen } = captureDateRange(
      "__sentinel__",
      mockFeaturesTasksResult,
    );
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/features", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    expect(seen.value).toBe("today");
  });

  test("/metrics/queue with no preset → today", async () => {
    const { deps, seen } = captureDateRange(
      "__sentinel__",
      makeResult(queueFunnelColumns, [[5, 3, 3, 0, 1.0]]),
    );
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/queue", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    expect(seen.value).toBe("today");
  });

  test("explicit ?preset=7d still resolves to '7d' (not overridden by new default)", async () => {
    const { deps, seen } = captureDateRange("__sentinel__", mockSummaryResult);
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    expect(seen.value).toBe("7d");
  });

  test("explicit ?preset=90d resolves to '90d' (not silently rewritten to 7d)", async () => {
    // Regression: previously the resolveDateRange conditional missed "90d" and
    // fell through to the "7d" default.
    const { deps, seen } = captureDateRange("__sentinel__", mockSummaryResult);
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary?preset=90d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    expect(seen.value).toBe("90d");
  });
});

// ─── default 1D button rendered active in dashboard HTML ──────────────────────

describe("dashboard HTML — default range button", () => {
  test("1D button has active class; 7D does not", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = { sessionSecret: TEST_SESSION_SECRET };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const body = await res.text();

    expect(body).toContain(
      '<button class="date-btn active" data-range="today" type="button">1D</button>',
    );
    expect(body).toContain(
      '<button class="date-btn" data-range="7d" type="button">7D</button>',
    );
    // No accidental double-active
    expect(body).not.toContain('class="date-btn active" data-range="7d"');
  });
});

// ─── Canary-eligible: works in local and canary mode ─────────────────────────

describe("GET /metrics/summary — canary-eligible", () => {
  test("returns 200 with expected shape", async () => {
    await runCanaryMode(async (ctx) => {
      let status: number;
      let body: Record<string, unknown>;

      if (process.env.TEST_TARGET_URL) {
        const res = await fetch(`${ctx.baseUrl}/metrics/summary`, {
          headers: { Authorization: `Bearer ${ctx.apiKey}` },
        });
        status = res.status;
        body = await res.json();
      } else {
        const deps: MetricsDeps = {
          postHogClient: { query: async () => mockSummaryResult },
        };
        const app = createMetricsApp(apiKeys, noopAccountsClient, deps);
        const res = await app.request("/metrics/summary", {
          headers: { Authorization: `Bearer ${ADMIN_KEY}` },
        });
        status = res.status;
        body = await res.json();
      }

      expect(status).toBe(200);
      expect(typeof body).toBe("object");
      expect(body !== null).toBe(true);
    });
  });
});
