/**
 * metrics/src/providers/task-store-provider.ship-it-rate.integration.test.ts
 * STB-1.1: drive TaskStoreProvider.summary() through the real
 * HttpTaskStoreClient (pagination, updatedSince pre-filter, matchesRepo,
 * inWindow(prAnchor)) over recorded live-shape /prs pages. The transport is an
 * injected FetchLike (no mock.module, no global.fetch).
 */

import { describe, expect, test } from "bun:test";
import {
  HttpTaskStoreClient,
  type PrRecord,
} from "../lib/task-store-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";
import {
  createRecordedPrsFetch,
  RecordedAdminMetricsClient,
  type RecordedPrsPage,
} from "./task-store-recorded.ts";

// Clock: 2026-06-10T12:00Z. LA windows:
//   today 2026-06-10T07:00Z..2026-06-11T06:59Z
//   7d    2026-06-04T07:00Z..   30d 2026-05-12T07:00Z..
const CLOCK = FixedClock("2026-06-10T12:00:00.000Z");

const pr = (
  id: string,
  reviewState: NonNullable<PrRecord["reviewState"]>,
  createdAt: string,
  mergedAt: string | null,
): PrRecord => ({
  id,
  repo: "org/alpha",
  reviewState,
  createdAt,
  mergedAt,
  state: mergedAt ? "merged" : "open",
  reviewCycles: 0,
  patchCycles: 0,
});

/** Live-shape rows: merged rows carry mergedAt, open rows only createdAt. */
export const PAGE_1: RecordedPrsPage = {
  nextCursor: "cursor-2",
  prs: [
    // merged today (created long before: anchor must be mergedAt)
    pr(
      "p1",
      "approved",
      "2026-06-01T04:30:00.000Z",
      "2026-06-10T15:00:00.000Z",
    ),
    // open, created today
    pr("p2", "pending", "2026-06-10T10:00:00.000Z", null),
    // merged within 7d
    pr(
      "p3",
      "approved",
      "2026-06-05T01:00:00.000Z",
      "2026-06-06T05:00:00.000Z",
    ),
    pr("p4", "posted", "2026-06-07T01:00:00.000Z", "2026-06-08T05:00:00.000Z"),
  ],
};
export const PAGE_2: RecordedPrsPage = {
  nextCursor: null,
  prs: [
    // open, created within 7d
    pr("p5", "approved", "2026-06-09T01:00:00.000Z", null),
    // open, created within 30d only
    pr("p6", "pending", "2026-05-20T01:00:00.000Z", null),
    // merged within 30d only
    pr(
      "p7",
      "approved",
      "2026-05-15T01:00:00.000Z",
      "2026-05-16T05:00:00.000Z",
    ),
    // outside every window
    pr(
      "p8",
      "approved",
      "2026-04-01T01:00:00.000Z",
      "2026-04-02T05:00:00.000Z",
    ),
  ],
};

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
    ["today", 2, 1],
    ["7d", 5, 3],
    ["30d", 7, 4],
  ] as const)(
    "%s window: reviews_total=%d reviews_ship_it=%d",
    async (range, total, shipIt) => {
      const { provider, fetchImpl } = makeProvider({
        "": PAGE_1,
        "cursor-2": PAGE_2,
      });
      const r = await reviews(provider, range);
      expect(r).toEqual({ total, shipIt });
      expect(shipIt / total).toBeGreaterThan(0);
      // both pages were walked, second via the opaque cursor
      const prsCalls = fetchImpl.requests.filter((u) => u.includes("/prs"));
      expect(prsCalls).toHaveLength(2);
      expect(prsCalls[1]).toContain("cursor=cursor-2");
    },
  );
});
