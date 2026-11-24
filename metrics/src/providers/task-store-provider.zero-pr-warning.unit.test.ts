/**
 * metrics/src/providers/task-store-provider.zero-pr-warning.unit.test.ts
 * STB-1.1: summary() emits one structured warning when the window has
 * completed tasks but zero PRs (the signature of an agent-scoped token whose
 * GET /prs returns nothing), and stays quiet otherwise. Never logs secrets.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { PrRecord, TaskRecord } from "../lib/task-store-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";
import {
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "./task-store-recorded.ts";

const CLOCK = FixedClock("2026-06-10T12:00:00.000Z");
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };
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

const doneTask: TaskRecord = {
  id: "T-1",
  status: "merged",
  repo: "org/alpha",
  createdAt: "2026-06-09T01:00:00.000Z",
  completedAt: "2026-06-09T05:00:00.000Z",
};
const inRangePr: PrRecord = {
  id: "p1",
  repo: "org/alpha",
  reviewState: "approved",
  createdAt: "2026-06-09T01:00:00.000Z",
  mergedAt: null,
};
// updated recently but anchored outside the 7d window
const staleAnchorPr: PrRecord = {
  id: "p2",
  repo: "org/alpha",
  reviewState: "approved",
  createdAt: "2026-01-01T01:00:00.000Z",
  mergedAt: null,
};

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const run = (tasks: TaskRecord[], prs: PrRecord[]) =>
  new TaskStoreProvider(
    new RecordedTaskStoreClient(tasks, prs),
    admin,
    CLOCK,
  ).query({ kind: "summary", range: "7d" });

describe("summary() zero-PR warning (STB-1.1)", () => {
  test("fires once when completed tasks > 0 and PRs == 0, with window and counts", async () => {
    await run([doneTask], [staleAnchorPr]);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    const payload = warn.mock.calls[0].find(
      (a: unknown) => typeof a === "object" && a !== null,
    ) as Record<string, unknown>;
    expect(payload.event).toBe("summary_zero_prs_with_tasks");
    expect(payload.window).toEqual({
      from: "2026-06-04T07:00:00.000Z",
      to: "2026-06-11T06:59:59.999Z",
    });
    expect(payload.tasks).toBe(1);
    expect(payload.prsPreWindow).toBe(1);
    expect(payload.prsPostWindow).toBe(0);
    expect(logged.toLowerCase()).not.toMatch(
      /token|secret|bearer|authorization/,
    );
  });

  test("silent when PRs are present in the window", async () => {
    await run([doneTask], [inRangePr]);
    expect(warn).not.toHaveBeenCalled();
  });

  test("silent when there are no completed tasks (even with zero PRs)", async () => {
    await run([], []);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a failing diagnostic fetch never breaks summary()", async () => {
    const store = new RecordedTaskStoreClient([doneTask], []);
    store.listPrsUpdatedSince = async () => {
      throw new Error("boom");
    };
    const t = await new TaskStoreProvider(store, admin, CLOCK).query({
      kind: "summary",
      range: "7d",
    });
    expect(t.results[0][t.columns.indexOf("reviews_total")]).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
