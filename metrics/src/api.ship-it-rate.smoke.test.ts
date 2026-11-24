/**
 * metrics/src/api.ship-it-rate.smoke.test.ts
 * Smoke (STB-1.1): GET /metrics/summary reviewShipItRate over the real
 * HttpTaskStoreClient + TaskStoreProvider fed recorded, paginated /prs pages
 * (injected FetchLike; no mock.module, no global overrides). Non-null whenever
 * the selected range holds PRs; null only when it holds none.
 */

import { describe, expect, test } from "bun:test";
import { createMetricsApp } from "./api.ts";
import { HttpTaskStoreClient } from "./lib/task-store-client.ts";
import { FixedClock, makeAccountsClientMock } from "./lib/test-helpers.ts";
import {
  PAGE_1,
  PAGE_2,
} from "./providers/task-store-provider.ship-it-rate.integration.test.ts";
import { TaskStoreProvider } from "./providers/task-store-provider.ts";
import {
  createRecordedPrsFetch,
  RecordedAdminMetricsClient,
} from "./providers/task-store-recorded.ts";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };

function makeApp() {
  const client = new HttpTaskStoreClient(
    "http://store.test",
    "k",
    createRecordedPrsFetch({ "": PAGE_1, "cursor-2": PAGE_2 }),
  );
  const provider = new TaskStoreProvider(
    client,
    new RecordedAdminMetricsClient(
      {
        totals: ZERO,
        byAgent: [],
        byCron: [],
        byModel: [],
        daily: [],
        byCronModel: [],
        byPhase: [],
      },
      { totals: ZERO, byAgent: [], byModel: [], daily: [] },
    ),
    FixedClock("2026-06-10T12:00:00.000Z"),
  );
  return createMetricsApp(
    new Map(),
    makeAccountsClientMock(async () => []),
    { provider, sessionSecret: "", dashboardDevAuth: true },
  );
}

async function summary(qs: string) {
  const res = await makeApp().request(`/metrics/summary${qs}`);
  expect(res.status).toBe(200);
  return (await res.json()).data;
}

describe("GET /metrics/summary reviewShipItRate (STB-1.1)", () => {
  test.each([
    ["?preset=today", 2, 1, 50],
    ["?preset=7d", 5, 3, 60],
    ["?preset=30d", 7, 4, 57.14],
  ] as const)(
    "%s -> %d reviews, %d ship it, rate %d",
    async (qs, total, shipIt, rate) => {
      const d = await summary(qs);
      expect(d.reviewsTotal).toBe(total);
      expect(d.reviewsShipIt).toBe(shipIt);
      expect(d.reviewShipItRate).toBe(rate);
    },
  );

  test("custom range with PRs is non-null", async () => {
    const d = await summary("?from=2026-06-05&to=2026-06-09");
    expect(d.reviewsTotal).toBe(3);
    expect(d.reviewShipItRate).not.toBeNull();
  });

  test("null only when the range has zero PRs", async () => {
    const d = await summary("?from=2026-06-01&to=2026-06-04");
    expect(d.reviewsTotal).toBe(0);
    expect(d.reviewShipItRate).toBeNull();
  });
});
