/**
 * metrics/src/integration.test.ts
 * Integration tests: API route → real query builder → real PostHogClient
 * (with mocked fetch layer) → real formatters → JSON response.
 *
 * Unlike api.test.ts which injects a mock PostHogClientLike, these tests use
 * the real PostHogClient (createPostHogClient) with a mocked fetchFn, exercising
 * the full pipeline through every layer.
 */

import { describe, expect, test } from "bun:test";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import { Cache } from "./cache.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import { createPostHogClient } from "./posthog-client.ts";
import type { FetchFn, HogQLResponse } from "./types.ts";

const noopAccountsClient = makeAccountsClientMock(async () => []);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = "sk_admin_metrics";
const apiKeys = parseApiKeys(`admin:${ADMIN_KEY}:*`);

const TEST_CONFIG = {
  personalApiKey: "phx_test_personal_key",
  projectId: "12345",
};

function authHeader(key: string) {
  return { Authorization: `Bearer ${key}` };
}

/** Build a minimal HogQLResponse envelope PostHogClient expects */
function makePostHogResponse(
  columns: string[],
  rows: unknown[][],
): HogQLResponse {
  return {
    columns,
    results: rows,
    types: [],
    hasMore: false,
    limit: 100,
    offset: 0,
  };
}

/** Create a fetchFn mock that returns the given PostHogResponse as JSON */
function makeFetchMock(response: HogQLResponse): {
  fetchFn: FetchFn;
  callCount: () => number;
} {
  let calls = 0;
  const fetchFn: FetchFn = async (_url, _init) => {
    calls++;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchFn, callCount: () => calls };
}

/** Create a fetchFn mock that returns a given HTTP status (no body) */
function makeErrorFetchMock(status: number): {
  fetchFn: FetchFn;
  callCount: () => number;
} {
  let calls = 0;
  const fetchFn: FetchFn = async (_url, _init) => {
    calls++;
    return new Response("Internal Server Error", { status });
  };
  return { fetchFn, callCount: () => calls };
}

// ─── Realistic PostHog response shapes ────────────────────────────────────────

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
];
const summaryRow = [
  10, 2, 2.5, 3.0, 1.2, 5.0, 8, 6, 0.5, 4, 12, 3.1, 2.0, 1.5, 0.8, 1.0, 5, 4,
];

const trendsColumns = [
  "period",
  "tasks_completed",
  "ci_gates",
  "ci_first_pass",
  "simplify_passes",
  "simplify_fixes",
  "tasks_blocked",
  "reviews",
];
const trendsRows = [
  ["2026-04-01", 2, 3, 2, 1, 4, 1, 2],
  ["2026-04-02", 3, 5, 4, 2, 8, 0, 3],
];

// ─── GET /metrics/summary — integration ─────────────────────────────────────

describe("integration: GET /metrics/summary", () => {
  test("real PostHogClient with mocked fetch — happy path", async () => {
    const phResponse = makePostHogResponse(summaryColumns, [summaryRow]);
    const { fetchFn } = makeFetchMock(phResponse);
    const client = createPostHogClient(TEST_CONFIG, fetchFn);
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tasksCompleted).toBe(10);
    expect(body.data.avgActualHours).toBe(2.5);
    expect(body.data.avgEstimatedHours).toBe(3.0);
    expect(body.data.ciGatesTotal).toBe(8);
    expect(body.data.ciFirstPass).toBe(6);
    expect(body.data.ciFirstPassRate).toBe(75);
    expect(body.data.tasksBlocked).toBe(2);
    expect(body.data.simplifyTotal).toBe(4);
    expect(body.data.simplifyTotalFixes).toBe(12);
    expect(body.data.reviewsTotal).toBe(5);
    expect(body.data.reviewsShipIt).toBe(4);
    expect(body.data.reviewShipItRate).toBe(80);
    expect(body.meta.dateRange.from).toBeTruthy();
    expect(body.meta.dateRange.to).toBeTruthy();
    expect(typeof body.meta.queryTimeMs).toBe("number");
  });

  test("Authorization header forwarded to PostHog — Bearer token in request", async () => {
    const phResponse = makePostHogResponse(summaryColumns, [summaryRow]);
    let capturedAuthHeader: string | null = null;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedAuthHeader =
        (init?.headers as Record<string, string>)?.Authorization ?? null;
      return new Response(JSON.stringify(phResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const client = createPostHogClient(TEST_CONFIG, fetchFn);
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

    await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(capturedAuthHeader).toBeTruthy();
    expect(capturedAuthHeader as unknown as string).toBe(
      `Bearer ${TEST_CONFIG.personalApiKey}`,
    );
  });
});

// ─── GET /metrics/trends — integration ──────────────────────────────────────

describe("integration: GET /metrics/trends", () => {
  test("real PostHogClient with mocked fetch — happy path", async () => {
    const phResponse = makePostHogResponse(trendsColumns, trendsRows);
    const { fetchFn } = makeFetchMock(phResponse);
    const client = createPostHogClient(TEST_CONFIG, fetchFn);
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

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
    expect(body.data.rows[1].tasksCompleted).toBe(3);
    expect(body.data.rows[1].reviews).toBe(3);
    expect(body.meta.dateRange.from).toBeTruthy();
  });

  test("groupBy=week passes through query builder", async () => {
    const phResponse = makePostHogResponse(trendsColumns, trendsRows);
    let capturedBody: Record<string, unknown> | null = null;
    const fetchFn: FetchFn = async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<
        string,
        unknown
      >;
      return new Response(JSON.stringify(phResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const client = createPostHogClient(TEST_CONFIG, fetchFn);
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

    const res = await app.request("/metrics/trends?preset=30d&groupBy=week", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    // Verify a HogQL query was actually sent (not a mock stub)
    expect(capturedBody).toBeTruthy();
    const capturedBodySafe = capturedBody as unknown as Record<string, unknown>;
    expect(capturedBodySafe.query).toBeTruthy();
    expect(typeof capturedBodySafe.query).toBe("object");
    const hogqlQuery = capturedBodySafe.query as Record<string, unknown>;
    expect(hogqlQuery.kind).toBe("HogQLQuery");
    expect(typeof hogqlQuery.query).toBe("string");
    expect(hogqlQuery.query as string).toContain(
      "toStartOfWeek(toTimeZone(timestamp, 'America/Los_Angeles'))",
    );
  });
});

// ─── Cache integration ──────────────────────────────────────────────────────

describe("integration: cache behavior", () => {
  test("second call to same endpoint hits cache — fetch called only once", async () => {
    const phResponse = makePostHogResponse(summaryColumns, [summaryRow]);
    const { fetchFn, callCount } = makeFetchMock(phResponse);
    // Use a long TTL cache so it does not expire between calls
    const cache = new Cache<ReturnType<typeof makePostHogResponse>>();
    const client = createPostHogClient(
      TEST_CONFIG,
      fetchFn,
      cache as never,
      60_000,
    );
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

    const res1 = await app.request("/metrics/summary?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    const res2 = await app.request("/metrics/summary?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.data.tasksCompleted).toBe(10);
    expect(body2.data.tasksCompleted).toBe(10);

    // Summary runs 2 queries (main + cycle time) on first call; both cached on second call
    expect(callCount()).toBe(2);
  });

  test("different presets produce different cache keys — fetch called twice", async () => {
    const phResponse = makePostHogResponse(summaryColumns, [summaryRow]);
    const { fetchFn, callCount } = makeFetchMock(phResponse);
    const cache = new Cache<ReturnType<typeof makePostHogResponse>>();
    const client = createPostHogClient(
      TEST_CONFIG,
      fetchFn,
      cache as never,
      60_000,
    );
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

    await app.request("/metrics/summary?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    await app.request("/metrics/summary?preset=30d", {
      headers: authHeader(ADMIN_KEY),
    });

    // Summary runs 2 queries (main + cycle time) per call, each preset has different keys
    expect(callCount()).toBe(4);
  });
});

// ─── Error propagation ──────────────────────────────────────────────────────

describe("integration: error propagation", () => {
  test("PostHog 500 → metrics 500 (PostHogClientError with non-401 status)", async () => {
    const { fetchFn } = makeErrorFetchMock(500);
    const client = createPostHogClient(TEST_CONFIG, fetchFn);
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("500");
  });

  test("PostHog 401 → metrics 401", async () => {
    const { fetchFn } = makeErrorFetchMock(401);
    const client = createPostHogClient(TEST_CONFIG, fetchFn);
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("PostHog 429 → metrics 500", async () => {
    const fetchFn: FetchFn = async (_url, _init) => {
      return new Response("", {
        status: 429,
        headers: { "retry-after": "30" },
      });
    };
    const client = createPostHogClient(TEST_CONFIG, fetchFn);
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("rate limit");
  });

  test("PostHog 500 on /metrics/trends → metrics 500", async () => {
    const { fetchFn } = makeErrorFetchMock(500);
    const client = createPostHogClient(TEST_CONFIG, fetchFn);
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      postHogClient: client,
    });

    const res = await app.request("/metrics/trends", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(500);
  });
});
