/**
 * metrics/src/providers/task-store-provider.unit.test.ts
 * Unit: pure feature-grouping logic in TaskStoreProvider — specifically the
 * task-originated groupPrsByPrefix() replacement exercised via the
 * featuresReviews() query kind.
 *
 * PTL-2.2: the grouping mechanism moved from reading `pr.taskId` (populated
 * ~10% of the time, 0% in several repos — silently dropping most PRs from
 * the dashboard's feature/session groupings) to originating from `task`
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
  test("a PR with taskId null but a matching task.pr groups correctly", async () => {
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
        taskId: null,
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
        taskId: null,
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
        taskId: null,
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
