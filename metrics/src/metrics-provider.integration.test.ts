/**
 * metrics/src/metrics-provider.integration.test.ts
 * Integration: seed events via POST /batch/, build the app with a
 * SqliteProvider over the same store, and hit the /metrics/* endpoints via
 * app.request() — asserting dashboard-shaped JSON comes back from real local
 * data (no PostHog, no HogQL).
 */

import { describe, expect, test } from "bun:test";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import { createLocalEventStore } from "./local-store.ts";
import { SqliteProvider } from "./providers/sqlite-provider.ts";

const ADMIN_KEY = "sk_admin_lds13";
const apiKeys = parseApiKeys(`admin:${ADMIN_KEY}:*`);
const noopAccountsClient = makeAccountsClientMock(async () => []);

function authHeader() {
  return { Authorization: `Bearer ${ADMIN_KEY}` };
}

function buildApp() {
  const store = createLocalEventStore({ path: ":memory:" });
  const provider = new SqliteProvider(store);
  const deps: MetricsDeps = { provider, localStore: store };
  const app = createMetricsApp(apiKeys, noopAccountsClient, deps);
  return { app, store };
}

function batch() {
  return {
    api_key: "phc_dummy",
    batch: [
      {
        event: "shipwright_task_complete",
        distinct_id: "d",
        timestamp: "2026-06-02T12:00:00.000Z",
        properties: {
          $insert_id: "c1",
          task: "QS-1.1",
          actual_h: 4,
          estimated_h: 5,
          complexity: 3,
          started_at: "2026-06-02T08:00:00.000Z",
          ts: "2026-06-02T12:00:00.000Z",
        },
      },
      {
        event: "shipwright_task_blocked",
        distinct_id: "d",
        timestamp: "2026-06-02T15:00:00.000Z",
        properties: { $insert_id: "b1", task_id: "QS-1.2" },
      },
      {
        event: "shipwright_ci_result",
        distinct_id: "d",
        timestamp: "2026-06-02T10:00:00.000Z",
        properties: {
          $insert_id: "ci1",
          task_id: "QS-1.1",
          passed_first_try: true,
          fix_attempts: 0,
        },
      },
      {
        event: "shipwright_task_reviewed",
        distinct_id: "d",
        timestamp: "2026-06-02T13:00:00.000Z",
        properties: {
          $insert_id: "r1",
          task_id: "QS-1.1",
          verdict: "SHIP IT",
          findings: 1,
        },
      },
      {
        event: "shipwright_task_started",
        distinct_id: "d",
        timestamp: "2026-06-02T08:00:00.000Z",
        properties: { $insert_id: "s1", task_id: "QS-1.1" },
      },
      {
        event: "agent_token_usage",
        distinct_id: "d",
        timestamp: "2026-06-02T09:00:00.000Z",
        properties: {
          $insert_id: "t1",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
          session_type: "cron",
          agent_id: "agent-a",
        },
      },
    ],
  };
}

const RANGE = "from=2026-06-01&to=2026-06-07";

async function ingest(app: ReturnType<typeof buildApp>["app"]) {
  const res = await app.request("/batch/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch()),
  });
  expect(res.status).toBe(200);
}

describe("metrics via SqliteProvider (integration)", () => {
  test("GET /metrics/summary returns aggregated local data", async () => {
    const { app, store } = buildApp();
    await ingest(app);

    const res = await app.request(`/metrics/summary?${RANGE}`, {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tasksCompleted).toBe(1);
    expect(body.data.tasksBlocked).toBe(1);
    expect(body.data.ciGatesTotal).toBe(1);
    expect(body.data.ciFirstPass).toBe(1);
    expect(body.data.ciFirstPassRate).toBe(100);
    expect(body.data.reviewsTotal).toBe(1);
    expect(body.data.reviewsShipIt).toBe(1);
    expect(body.data.complexityDist.c3).toBe(1);
    expect(body.meta.dateRange.from).toBeTruthy();
    store.close();
  });

  test("GET /metrics/trends returns rows", async () => {
    const { app, store } = buildApp();
    await ingest(app);

    const res = await app.request(`/metrics/trends?${RANGE}`, {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data.rows)).toBe(true);
    const total = body.data.rows.reduce(
      (acc: number, r: { tasksCompleted: number }) => acc + r.tasksCompleted,
      0,
    );
    expect(total).toBe(1);
    store.close();
  });

  test("GET /metrics/features returns per-prefix breakdown", async () => {
    const { app, store } = buildApp();
    await ingest(app);

    const res = await app.request(`/metrics/features?${RANGE}`, {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const qs = body.data.features.find(
      (f: { prefix: string }) => f.prefix === "QS",
    );
    expect(qs).toBeDefined();
    expect(qs.tasksCompleted).toBe(1);
    expect(qs.ciFirstPassRate).toBe(100);
    expect(qs.reviewShipItRate).toBe(100);
    store.close();
  });

  test("GET /metrics/queue returns funnel + cycle", async () => {
    const { app, store } = buildApp();
    await ingest(app);

    const res = await app.request(`/metrics/queue?${RANGE}`, {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.tasksStarted).toBe(1);
    expect(body.data.tasksMerged).toBe(1);
    expect(body.data.tasksBlocked).toBe(1);
    store.close();
  });

  test("GET /metrics/tokens returns totals + breakdowns", async () => {
    const { app, store } = buildApp();
    await ingest(app);

    const res = await app.request(`/metrics/tokens?${RANGE}`, {
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.input).toBe(1000);
    expect(body.data.totals.total).toBe(1800);
    const cron = body.data.bySessionType.find(
      (s: { sessionType: string }) => s.sessionType === "cron",
    );
    expect(cron.input).toBe(1000);
    store.close();
  });
});
