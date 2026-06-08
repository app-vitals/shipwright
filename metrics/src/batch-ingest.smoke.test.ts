/**
 * metrics/src/batch-ingest.smoke.test.ts
 * Smoke tests for POST /batch/ ingest via Hono app.request() (no real socket).
 * Persists a PostHog-shaped batch into an injected in-memory local store.
 */

import { describe, expect, test } from "bun:test";
import { parseApiKeys } from "./lib/api-auth.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import { createLocalEventStore } from "./local-store.ts";

const apiKeys = parseApiKeys("admin:sk_admin:*");
const noopAccountsClient = makeAccountsClientMock(async () => []);

function postHogBatch() {
  return {
    api_key: "phc_dummy",
    batch: [
      {
        event: "task_completed",
        distinct_id: "shipwright/repo/T-1",
        timestamp: "2026-06-08T01:00:00.000Z",
        properties: { $insert_id: "task_completed/repo/T-1", task_id: "T-1" },
      },
    ],
  };
}

describe("POST /batch/", () => {
  test("persists a PostHog-shaped batch and returns { status: 1 }", async () => {
    const store = createLocalEventStore({ path: ":memory:" });
    const deps: MetricsDeps = { localStore: store };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/batch/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(postHogBatch()),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 1 });

    const rows = store.queryByEvent("task_completed");
    expect(rows).toHaveLength(1);
    expect(rows[0].insertId).toBe("task_completed/repo/T-1");
    expect(rows[0].distinctId).toBe("shipwright/repo/T-1");
    expect(rows[0].properties).toMatchObject({ task_id: "T-1" });

    store.close();
  });

  test("duplicate insert_id is ignored (dedup across requests)", async () => {
    const store = createLocalEventStore({ path: ":memory:" });
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      localStore: store,
    });

    const send = () =>
      app.request("/batch/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postHogBatch()),
      });

    await send();
    const res2 = await send();
    expect(res2.status).toBe(200);

    expect(store.queryByEvent("task_completed")).toHaveLength(1);

    store.close();
  });

  test("malformed body (missing batch array) returns 400", async () => {
    const store = createLocalEventStore({ path: ":memory:" });
    const app = createMetricsApp(apiKeys, noopAccountsClient, {
      localStore: store,
    });

    const res = await app.request("/batch/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: "phc_dummy" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();

    store.close();
  });

  test("route is absent (404) when no localStore is injected", async () => {
    const app = createMetricsApp(apiKeys, noopAccountsClient);

    const res = await app.request("/batch/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(postHogBatch()),
    });

    expect(res.status).toBe(404);
  });
});
