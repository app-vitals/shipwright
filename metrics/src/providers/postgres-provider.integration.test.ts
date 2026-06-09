/**
 * metrics/src/providers/postgres-provider.integration.test.ts
 *
 * Integration tests for PostgresProvider against a real Postgres instance.
 * Tests are skipped if METRICS_TEST_POSTGRES_URL is not set.
 *
 * Run locally with:
 *   METRICS_TEST_POSTGRES_URL=postgres://... bun test metrics/src/providers/postgres-provider.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MetricQuery } from "../metrics-provider.ts";
import {
  type PostgresEventStore,
  createPostgresEventStore,
} from "./postgres-provider.ts";

const pgUrl = process.env.METRICS_TEST_POSTGRES_URL;

// Helper: skip all tests when Postgres is unavailable
function maybeSkip(name: string, fn: () => void | Promise<void>) {
  if (!pgUrl) {
    test.skip(name, () => {});
  } else {
    test(name, fn);
  }
}

const RANGE = { from: "2026-06-01", to: "2026-06-07" } as const;

let pgStore: PostgresEventStore;

function row0(table: { columns: string[]; results: unknown[][] }) {
  const r = table.results[0] ?? [];
  return Object.fromEntries(table.columns.map((c, i) => [c, r[i]]));
}

function rows(table: { columns: string[]; results: unknown[][] }) {
  return table.results.map((raw) =>
    Object.fromEntries(table.columns.map((c, i) => [c, (raw as unknown[])[i]])),
  );
}

async function seedAll() {
  const seed = (
    event: string,
    ts: string,
    props: Record<string, unknown>,
    insertId?: string,
  ) =>
    pgStore.insertEvent({
      event,
      timestamp: ts,
      properties: props,
      insertId: insertId ?? `${event}-${ts}-${Math.random()}`,
    });

  // Completion events (2)
  await seed(
    "shipwright_task_complete",
    "2026-06-02T12:00:00.000Z",
    {
      task: "QS-1.1",
      actual_h: 4,
      estimated_h: 5,
      retries: 1,
      files_changed: 6,
      complexity: 3,
      fix_cascade_depth: 2,
      started_at: "2026-06-02T08:00:00.000Z",
      ts: "2026-06-02T12:00:00.000Z",
    },
    "pg-c1",
  );
  await seed(
    "shipwright_task_complete",
    "2026-06-03T12:00:00.000Z",
    {
      task: "QS-1.2",
      actual_h: 6,
      estimated_h: 5,
      retries: 3,
      files_changed: 10,
      complexity: 5,
      fix_cascade_depth: 4,
      started_at: "2026-06-03T06:00:00.000Z",
      ts: "2026-06-03T12:00:00.000Z",
    },
    "pg-c2",
  );

  // Blocked (1)
  await seed(
    "shipwright_task_blocked",
    "2026-06-02T15:00:00.000Z",
    { task_id: "QS-1.3" },
    "pg-b1",
  );

  // CI results (2 total, 1 first-pass)
  await seed(
    "shipwright_ci_result",
    "2026-06-02T10:00:00.000Z",
    { task_id: "QS-1.1", passed_first_try: true, fix_attempts: 0, first_pass: true },
    "pg-ci1",
  );
  await seed(
    "shipwright_ci_result",
    "2026-06-03T10:00:00.000Z",
    { task_id: "QS-1.2", passed_first_try: false, fix_attempts: 2, first_pass: false },
    "pg-ci2",
  );

  // Simplify (1)
  await seed(
    "shipwright_simplify_complete",
    "2026-06-02T11:00:00.000Z",
    {
      task_id: "QS-1.1",
      total_fixes: 5,
      dry: 2,
      dead_code: 1,
      naming: 1,
      complexity_fixes: 0.5,
      consistency: 0.5,
    },
    "pg-s1",
  );

  // Reviews (2 total, 1 SHIP IT)
  await seed(
    "shipwright_task_reviewed",
    "2026-06-02T13:00:00.000Z",
    { task_id: "QS-1.1", verdict: "SHIP IT", findings: 1 },
    "pg-r1",
  );
  await seed(
    "shipwright_task_reviewed",
    "2026-06-03T13:00:00.000Z",
    { task_id: "QS-1.2", verdict: "REVISE", findings: 3 },
    "pg-r2",
  );

  // Started (2)
  await seed(
    "shipwright_task_started",
    "2026-06-02T08:00:00.000Z",
    { task_id: "QS-1.1" },
    "pg-st1",
  );
  await seed(
    "shipwright_task_started",
    "2026-06-03T06:00:00.000Z",
    { task_id: "QS-1.2" },
    "pg-st2",
  );

  // Token usage (2)
  await seed(
    "agent_token_usage",
    "2026-06-02T09:00:00.000Z",
    {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
      session_type: "cron",
      agent_id: "agent-a",
    },
    "pg-t1",
  );
  await seed(
    "agent_token_usage",
    "2026-06-03T09:00:00.000Z",
    {
      input_tokens: 2000,
      output_tokens: 800,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 150,
      session_type: "slack_dm",
      agent_id: "agent-b",
    },
    "pg-t2",
  );
}

if (pgUrl) {
  beforeAll(async () => {
    pgStore = await createPostgresEventStore(pgUrl);
    // Clear the table before seeding to ensure test isolation
    await pgStore.truncateForTest();
    await seedAll();
  });

  afterAll(async () => {
    await pgStore.truncateForTest();
    await pgStore.close();
  });
}

async function q(query: MetricQuery) {
  return pgStore.provider.query(query);
}

describe("PostgresProvider — summary", () => {
  maybeSkip("aggregates completion / ci / simplify / review metrics", async () => {
    const table = await q({ kind: "summary", range: RANGE });
    const r = row0(table);
    expect(r.tasks_completed).toBe(2);
    expect(r.tasks_blocked).toBe(1);
    expect(Number(r.avg_actual_hours)).toBeCloseTo(5, 5);
    expect(Number(r.avg_estimated_hours)).toBeCloseTo(5, 5);
    expect(Number(r.avg_retries)).toBeCloseTo(2, 5);
    expect(Number(r.avg_files_changed)).toBeCloseTo(8, 5);
    expect(r.ci_gates_total).toBe(2);
    expect(r.ci_first_pass).toBe(1);
    expect(Number(r.avg_fix_attempts)).toBeCloseTo(1, 5);
    expect(r.simplify_total).toBe(1);
    expect(Number(r.simplify_total_fixes)).toBeCloseTo(5, 5);
    expect(r.reviews_total).toBe(2);
    expect(r.reviews_ship_it).toBe(1);
    expect(r.complexity_3).toBe(1);
    expect(r.complexity_5).toBe(1);
    expect(Number(r.avg_fix_cascade_depth)).toBeCloseTo(3, 5);
  });

  maybeSkip("date range outside seeded events yields zero counts", async () => {
    const table = await q({
      kind: "summary",
      range: { from: "2025-01-01", to: "2025-01-02" },
    });
    const r = row0(table);
    expect(r.tasks_completed).toBe(0);
    expect(r.ci_gates_total).toBe(0);
  });
});

describe("PostgresProvider — summaryCycleTime", () => {
  maybeSkip("avg cycle hours from started_at→ts", async () => {
    const table = await q({ kind: "summaryCycleTime", range: RANGE });
    const r = row0(table);
    expect(Number(r.avg_cycle_time_hours)).toBeCloseTo(5, 5);
  });
});

describe("PostgresProvider — trends", () => {
  maybeSkip("groups by day with per-period columns", async () => {
    const table = await q({ kind: "trends", range: RANGE, groupBy: "day" });
    const all = rows(table);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(table.columns).toContain("period");
    expect(table.columns).toContain("tasks_completed");
    const totalCompleted = all.reduce((acc, x) => acc + Number(x.tasks_completed ?? 0), 0);
    expect(totalCompleted).toBe(2);
    const totalStarted = all.reduce((acc, x) => acc + Number(x.tasks_started ?? 0), 0);
    expect(totalStarted).toBe(2);
  });
});

describe("PostgresProvider — features", () => {
  maybeSkip("featuresTasks groups by prefix", async () => {
    const table = await q({ kind: "featuresTasks", range: RANGE });
    const all = rows(table);
    const qs = all.find((x) => x.feature_prefix === "QS");
    expect(qs).toBeDefined();
    expect(qs?.tasks_completed).toBe(2);
    expect(Number(qs?.avg_actual_h)).toBeCloseTo(5, 5);
  });

  maybeSkip("featuresCi groups by prefix", async () => {
    const table = await q({ kind: "featuresCi", range: RANGE });
    const qs = rows(table).find((x) => x.feature_prefix === "QS");
    expect(qs?.ci_total).toBe(2);
    expect(qs?.ci_first_pass).toBe(1);
  });

  maybeSkip("featuresReviews groups by prefix", async () => {
    const table = await q({ kind: "featuresReviews", range: RANGE });
    const qs = rows(table).find((x) => x.feature_prefix === "QS");
    expect(qs?.reviews_total).toBe(2);
    expect(qs?.reviews_ship_it).toBe(1);
  });
});

describe("PostgresProvider — queue", () => {
  maybeSkip("queueFunnel counts", async () => {
    const table = await q({ kind: "queueFunnel", range: RANGE });
    const r = row0(table);
    expect(r.tasks_started).toBe(2);
    expect(r.tasks_approved).toBe(2);
    expect(r.tasks_merged).toBe(2);
    expect(r.tasks_blocked).toBe(1);
    expect(Number(r.avg_review_findings)).toBeCloseTo(2, 5);
  });

  maybeSkip("queueCycleStarted returns task_id + timestamp rows", async () => {
    const table = await q({ kind: "queueCycleStarted", range: RANGE });
    const all = rows(table);
    expect(all).toHaveLength(2);
    expect(table.columns).toEqual(["task_id", "timestamp"]);
    const ids = all.map((x) => x.task_id).sort();
    expect(ids).toEqual(["QS-1.1", "QS-1.2"]);
  });

  maybeSkip("queueCycleMerged returns task_id + timestamp rows", async () => {
    const table = await q({ kind: "queueCycleMerged", range: RANGE });
    const all = rows(table);
    expect(all).toHaveLength(2);
    const ids = all.map((x) => x.task_id).sort();
    expect(ids).toEqual(["QS-1.1", "QS-1.2"]);
  });
});

describe("PostgresProvider — tokens", () => {
  maybeSkip("tokensTotals sums all token fields", async () => {
    const table = await q({ kind: "tokensTotals", range: RANGE });
    const r = row0(table);
    expect(Number(r.input_tokens)).toBe(3000);
    expect(Number(r.output_tokens)).toBe(1300);
    expect(Number(r.cache_read_input_tokens)).toBe(600);
    expect(Number(r.cache_creation_input_tokens)).toBe(250);
    expect(Number(r.total_tokens)).toBe(5150);
  });

  maybeSkip("tokensBySessionType groups by session_type", async () => {
    const table = await q({ kind: "tokensBySessionType", range: RANGE });
    const all = rows(table);
    const cron = all.find((x) => x.session_type === "cron");
    expect(Number(cron?.input_tokens)).toBe(1000);
    const dm = all.find((x) => x.session_type === "slack_dm");
    expect(Number(dm?.input_tokens)).toBe(2000);
  });

  maybeSkip("tokensByAgent groups by agent_id", async () => {
    const table = await q({ kind: "tokensByAgent", range: RANGE });
    const all = rows(table);
    const a = all.find((x) => x.agent_id === "agent-a");
    expect(Number(a?.total_tokens)).toBe(1800);
  });

  maybeSkip("tokensTrends groups by day", async () => {
    const table = await q({ kind: "tokensTrends", range: RANGE });
    const all = rows(table);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(table.columns).toContain("period");
    const total = all.reduce((acc, x) => acc + Number(x.input_tokens ?? 0), 0);
    expect(total).toBe(3000);
  });

  maybeSkip("tokens honor date-range filtering", async () => {
    const table = await q({
      kind: "tokensTotals",
      range: { from: "2026-06-03", to: "2026-06-03" },
    });
    const r = row0(table);
    expect(Number(r.input_tokens)).toBe(2000);
  });
});

describe("PostgresProvider — dedup", () => {
  maybeSkip("inserting same insert_id twice produces only one row", async () => {
    await pgStore.truncateForTest();

    await pgStore.insertEvent({
      insertId: "dedup-test-id",
      event: "shipwright_task_complete",
      timestamp: "2026-06-04T10:00:00.000Z",
      properties: { task: "DD-1.1", actual_h: 2 },
    });
    // Second insert with same insertId — should be silently ignored
    await pgStore.insertEvent({
      insertId: "dedup-test-id",
      event: "shipwright_task_complete",
      timestamp: "2026-06-04T10:00:00.000Z",
      properties: { task: "DD-1.1", actual_h: 99 },
    });

    const table = await q({
      kind: "summary",
      range: { from: "2026-06-04", to: "2026-06-04" },
    });
    const r = row0(table);
    expect(r.tasks_completed).toBe(1);
  });
});
