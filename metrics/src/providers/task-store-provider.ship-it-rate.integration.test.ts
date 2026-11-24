/**
 * metrics/src/providers/task-store-provider.ship-it-rate.integration.test.ts
 * STB-1.1: drive TaskStoreProvider.summary() through the real
 * HttpTaskStoreClient (pagination, updatedSince pre-filter, matchesRepo,
 * inWindow(prAnchor)) over recorded live-shape /prs pages. The transport is an
 * injected FetchLike (no mock.module, no global.fetch).
 */

import { describe, expect, test } from "bun:test";
import { HttpTaskStoreClient } from "../lib/task-store-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";
import {
  createRecordedPrsFetch,
  PAGE_1,
  PAGE_2,
  RecordedAdminMetricsClient,
  type RecordedPrsPage,
} from "./task-store-recorded.ts";

// Clock + fixtures: see PAGE_1/PAGE_2 in task-store-recorded.ts.
const CLOCK = FixedClock("2026-06-10T12:00:00.000Z");

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };

function makeProvider(pages: Record<string, RecordedPrsPage>) {
  const fetchImpl = createRecordedPrsFetch(pages);
  const client = new HttpTaskStoreClient("http://store.test", "k", fetchImpl);
  const admin = new RecordedAdminMetricsClient(
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
  );
  return {
    provider: new TaskStoreProvider(client, admin, CLOCK),
    fetchImpl,
  };
}

async function reviews(
  provider: TaskStoreProvider,
  range: "today" | "7d" | "30d",
) {
  const t = await provider.query({ kind: "summary", range });
  const total = t.results[0][t.columns.indexOf("reviews_total")] as number;
  const shipIt = t.results[0][t.columns.indexOf("reviews_ship_it")] as number;
  return { total, shipIt };
}

describe("TaskStoreProvider.summary() SHIP IT over paginated /prs (STB-1.1)", () => {
  test.each([
    ["today", 2, 1, 50],
    ["7d", 5, 3, 60],
    ["30d", 7, 4, 57.14],
  ] as const)(
    "%s window: reviews_total=%d reviews_ship_it=%d rate=%d",
    async (range, total, shipIt, rate) => {
      const { provider, fetchImpl } = makeProvider({
        "": PAGE_1,
        "cursor-2": PAGE_2,
      });
      const r = await reviews(provider, range);
      expect(r).toEqual({ total, shipIt });
      expect(Math.round((shipIt / total) * 10000) / 100).toBe(rate);
      // both pages were walked, second via the opaque cursor
      const prsCalls = fetchImpl.requests.filter((u) => u.includes("/prs"));
      expect(prsCalls).toHaveLength(2);
      expect(prsCalls[1]).toContain("cursor=cursor-2");
    },
  );
});
