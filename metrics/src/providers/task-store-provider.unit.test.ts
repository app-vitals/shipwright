/**
 * metrics/src/providers/task-store-provider.unit.test.ts
 * Unit: pure feature-grouping logic in TaskStoreProvider — specifically the
 * task-originated groupPrsByPrefix() replacement exercised via the
 * featuresReviews() query kind.
 *
 * PTL-2.2: the grouping mechanism moved off the since-removed stored
 * `PullRequest.taskId` column (populated ~10% of the time, 0% in several
 * repos — silently dropping most PRs from the dashboard's feature/session
 * groupings; dropped outright in PTL-3.1) to originating from `task`
 * records (task.id-derived prefix + task.pr), then attaching each task's PR
 * by matching (repo, pr) against the fetched PR list. This also naturally
 * handles the bundle case: multiple tasks pointing at the same PR each
 * attach it to their own feature bucket.
 */

import { describe, expect, test } from "bun:test";
import type { PrRecord, TaskRecord } from "../lib/task-store-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";
import {
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "./task-store-recorded.ts";

const CLOCK = FixedClock("2026-06-10T12:00:00.000Z");
const RANGE = { from: "2026-06-01", to: "2026-06-07" } as const;

const ZERO_AGG = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  total: 0,
};
const EMPTY_CRON_STATS = {
  totals: ZERO_AGG,
  byAgent: [],
  byCron: [],
  byModel: [],
  daily: [],
  byCronModel: [],
  byPhase: [],
};
const EMPTY_CHAT_STATS = {
  totals: ZERO_AGG,
  byAgent: [],
  byModel: [],
  daily: [],
};

function colIndex(t: { columns: string[] }, name: string): number {
  return t.columns.indexOf(name);
}

function buildProvider(tasks: TaskRecord[], prs: PrRecord[]) {
  const taskStore = new RecordedTaskStoreClient(tasks, prs);
  const admin = new RecordedAdminMetricsClient(
    EMPTY_CRON_STATS,
    EMPTY_CHAT_STATS,
  );
  return new TaskStoreProvider(taskStore, admin, CLOCK);
}

describe("TaskStoreProvider.featuresReviews (unit) — task-originated grouping", () => {
  test("a PR with no stored task link but a matching task.pr groups correctly", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "QS-1.1",
        status: "merged",
        repo: "org/repo",
        pr: 42,
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
      },
    ];
    const prs: PrRecord[] = [
      {
        prNumber: 42,
        repo: "org/repo",
        reviewState: "approved",
        mergedAt: "2026-06-02T12:00:00.000Z",
      },
    ];

    const provider = buildProvider(tasks, prs);
    const t = await provider.query({ kind: "featuresReviews", range: RANGE });

    const row = t.results.find(
      (r) => r[colIndex(t, "feature_prefix")] === "QS",
    );
    expect(row).toBeDefined();
    expect(row?.[colIndex(t, "reviews_total")]).toBe(1);
    expect(row?.[colIndex(t, "reviews_ship_it")]).toBe(1);
  });

  test("a bundle PR shared by 2 tasks with different prefixes appears in both groupings", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "AA-1.1",
        status: "merged",
        repo: "org/repo",
        pr: 99,
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
      },
      {
        id: "BB-2.1",
        status: "merged",
        repo: "org/repo",
        pr: 99,
        startedAt: "2026-06-03T08:00:00.000Z",
        completedAt: "2026-06-03T12:00:00.000Z",
        mergedAt: "2026-06-03T12:00:00.000Z",
        createdAt: "2026-06-02T08:00:00.000Z",
      },
    ];
    const prs: PrRecord[] = [
      {
        prNumber: 99,
        repo: "org/repo",
        reviewState: "approved",
        mergedAt: "2026-06-03T12:00:00.000Z",
      },
    ];

    const provider = buildProvider(tasks, prs);
    const t = await provider.query({ kind: "featuresReviews", range: RANGE });

    const rowAA = t.results.find(
      (r) => r[colIndex(t, "feature_prefix")] === "AA",
    );
    const rowBB = t.results.find(
      (r) => r[colIndex(t, "feature_prefix")] === "BB",
    );
    expect(rowAA).toBeDefined();
    expect(rowBB).toBeDefined();
    expect(rowAA?.[colIndex(t, "reviews_total")]).toBe(1);
    expect(rowBB?.[colIndex(t, "reviews_total")]).toBe(1);
    expect(rowAA?.[colIndex(t, "reviews_ship_it")]).toBe(1);
    expect(rowBB?.[colIndex(t, "reviews_ship_it")]).toBe(1);
  });

  test("a task with repo null and a matching pr groups against a non-null-repo PR record", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "EE-1.1",
        status: "merged",
        repo: null,
        pr: 55,
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
      },
    ];
    const prs: PrRecord[] = [
      {
        prNumber: 55,
        repo: "org/repo",
        reviewState: "approved",
        mergedAt: "2026-06-02T12:00:00.000Z",
      },
    ];

    const provider = buildProvider(tasks, prs);
    const t = await provider.query({ kind: "featuresReviews", range: RANGE });

    const row = t.results.find(
      (r) => r[colIndex(t, "feature_prefix")] === "EE",
    );
    expect(row).toBeDefined();
    expect(row?.[colIndex(t, "reviews_total")]).toBe(1);
    expect(row?.[colIndex(t, "reviews_ship_it")]).toBe(1);
  });

  test("a task with no matching PR (missing .pr or no matching record) contributes nothing, no crash", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "CC-1.1",
        status: "merged",
        repo: "org/repo",
        // no .pr field at all
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
      },
      {
        id: "DD-1.1",
        status: "merged",
        repo: "org/repo",
        pr: 7, // points at a PR number that doesn't exist in the fetched PR list
        startedAt: "2026-06-03T08:00:00.000Z",
        completedAt: "2026-06-03T12:00:00.000Z",
        mergedAt: "2026-06-03T12:00:00.000Z",
        createdAt: "2026-06-02T08:00:00.000Z",
      },
    ];
    const prs: PrRecord[] = [];

    const provider = buildProvider(tasks, prs);
    const t = await provider.query({ kind: "featuresReviews", range: RANGE });

    expect(
      t.results.find((r) => r[colIndex(t, "feature_prefix")] === "CC"),
    ).toBeUndefined();
    expect(
      t.results.find((r) => r[colIndex(t, "feature_prefix")] === "DD"),
    ).toBeUndefined();
  });
});

// ─── mergedPrsByRepo (POM-2.1) ─────────────────────────────────────────────

describe("TaskStoreProvider.mergedPrsByRepo (unit) — repo × origin × bucket grouping", () => {
  const RANGE_WIDE = { from: "2026-05-25", to: "2026-06-15" } as const;

  function buildPrs(): PrRecord[] {
    return [
      {
        id: "pr-1",
        repo: "org/alpha",
        state: "merged",
        origin: "shipwright",
        mergedAt: "2026-06-01T12:00:00.000Z", // Monday
      },
      {
        id: "pr-2",
        repo: "org/alpha",
        state: "merged",
        origin: "ci",
        mergedAt: "2026-06-02T12:00:00.000Z", // Tuesday — same ISO week as pr-1
      },
      {
        id: "pr-3",
        repo: "org/alpha",
        state: "merged",
        origin: "dependency_bot",
        mergedAt: "2026-06-09T12:00:00.000Z", // Tuesday, next week
      },
      {
        id: "pr-4",
        repo: "org/beta",
        state: "merged",
        origin: "human",
        mergedAt: "2026-06-01T12:00:00.000Z",
      },
      {
        id: "pr-5",
        repo: "org/beta",
        state: "merged",
        origin: null, // no stamped origin → unknown bucket
        mergedAt: "2026-06-02T12:00:00.000Z",
      },
      {
        id: "pr-6",
        repo: "org/beta",
        state: "open", // excluded — not merged, despite carrying a mergedAt-shaped value
        origin: "shipwright",
        mergedAt: "2026-06-03T12:00:00.000Z",
      },
      {
        id: "pr-7",
        repo: "org/alpha",
        state: "closed", // excluded — not merged
        origin: "human",
        mergedAt: "2026-06-04T12:00:00.000Z",
      },
    ];
  }

  function totalsByRepoOrigin(t: {
    columns: string[];
    results: unknown[][];
  }): Map<string, number> {
    const totals = new Map<string, number>();
    for (const row of t.results) {
      const repo = String(row[colIndex(t, "repo")]);
      const origin = String(row[colIndex(t, "origin")]);
      const count = Number(row[colIndex(t, "count")]);
      const key = `${repo}:${origin}`;
      totals.set(key, (totals.get(key) ?? 0) + count);
    }
    return totals;
  }

  test("groupBy=day: exact repo×origin totals; null origin → unknown; open/closed excluded", async () => {
    const provider = buildProvider([], buildPrs());
    const t = await provider.query({
      kind: "mergedPrsByRepo",
      range: RANGE_WIDE,
      groupBy: "day",
    });

    expect(t.columns).toEqual(["repo", "origin", "period", "count"]);

    const totals = totalsByRepoOrigin(t);
    expect(totals.get("org/alpha:shipwright")).toBe(1);
    expect(totals.get("org/alpha:ci")).toBe(1);
    expect(totals.get("org/alpha:dependency_bot")).toBe(1);
    expect(totals.get("org/beta:human")).toBe(1);
    expect(totals.get("org/beta:unknown")).toBe(1);
    // Excluded (state !== merged) rows contribute nothing.
    expect(totals.get("org/beta:shipwright")).toBeUndefined();
    expect(totals.get("org/alpha:human")).toBeUndefined();
    expect(totals.size).toBe(5);

    // Three distinct calendar-day buckets: 06-01, 06-02, 06-09.
    const periods = new Set(t.results.map((r) => r[colIndex(t, "period")]));
    expect(periods).toEqual(
      new Set(["2026-06-01", "2026-06-02", "2026-06-09"]),
    );

    const alphaShipwright = t.results.find(
      (r) =>
        r[colIndex(t, "repo")] === "org/alpha" &&
        r[colIndex(t, "origin")] === "shipwright",
    );
    expect(alphaShipwright?.[colIndex(t, "period")]).toBe("2026-06-01");
    expect(alphaShipwright?.[colIndex(t, "count")]).toBe(1);
  });

  test("groupBy=week: same-week rows collapse into one bucket; a following week stays separate", async () => {
    const provider = buildProvider([], buildPrs());
    const t = await provider.query({
      kind: "mergedPrsByRepo",
      range: RANGE_WIDE,
      groupBy: "week",
    });

    const totals = totalsByRepoOrigin(t);
    expect(totals.get("org/alpha:shipwright")).toBe(1);
    expect(totals.get("org/alpha:ci")).toBe(1);
    expect(totals.get("org/alpha:dependency_bot")).toBe(1);
    expect(totals.get("org/beta:human")).toBe(1);
    expect(totals.get("org/beta:unknown")).toBe(1);
    expect(totals.size).toBe(5);

    const alphaShipwright = t.results.find(
      (r) =>
        r[colIndex(t, "repo")] === "org/alpha" &&
        r[colIndex(t, "origin")] === "shipwright",
    );
    const alphaCi = t.results.find(
      (r) =>
        r[colIndex(t, "repo")] === "org/alpha" &&
        r[colIndex(t, "origin")] === "ci",
    );
    const alphaDepBot = t.results.find(
      (r) =>
        r[colIndex(t, "repo")] === "org/alpha" &&
        r[colIndex(t, "origin")] === "dependency_bot",
    );

    // pr-1 (06-01, Mon) and pr-2 (06-02, Tue) fall in the same Monday-anchored
    // week bucket; pr-3 (06-09, the following Tuesday) falls in the next one.
    expect(alphaShipwright?.[colIndex(t, "period")]).toBe("2026-06-01");
    expect(alphaCi?.[colIndex(t, "period")]).toBe("2026-06-01");
    expect(alphaDepBot?.[colIndex(t, "period")]).toBe("2026-06-08");

    const periods = new Set(t.results.map((r) => r[colIndex(t, "period")]));
    expect(periods).toEqual(new Set(["2026-06-01", "2026-06-08"]));
  });
});
