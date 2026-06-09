/**
 * metrics/src/providers/sqlite-provider.unit.test.ts
 * Unit tests for SqliteProvider: seed PostHog-shaped events into an in-memory
 * store, then assert every MetricQuery kind returns a correctly-shaped
 * MetricTable with the aggregated values the api.ts handlers expect, and that
 * date-range filtering is honored.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LocalEventStore, createLocalEventStore } from "../local-store.ts";
import type { MetricQuery } from "../metrics-provider.ts";
import { SqliteProvider } from "./sqlite-provider.ts";

let store: LocalEventStore;
let provider: SqliteProvider;

/** Custom range covering all seeded events (all within June 2026, LA). */
const RANGE = { from: "2026-06-01", to: "2026-06-07" } as const;

/** Map column array + a single row into an object for ergonomic assertions. */
function row0(table: { columns: string[]; results: unknown[][] }) {
  const r = table.results[0] ?? [];
  return Object.fromEntries(table.columns.map((c, i) => [c, r[i]]));
}

function rows(table: { columns: string[]; results: unknown[][] }) {
  return table.results.map((raw) =>
    Object.fromEntries(table.columns.map((c, i) => [c, (raw as unknown[])[i]])),
  );
}

function seed(
  event: string,
  timestamp: string,
  properties: Record<string, unknown>,
  insertId?: string,
) {
  store.insertEvent({
    event,
    timestamp,
    properties,
    insertId: insertId ?? `${event}-${timestamp}-${Math.random()}`,
  });
}

beforeEach(() => {
  store = createLocalEventStore({ path: ":memory:" });
  provider = new SqliteProvider(store);

  // ─ Completion events (2 completed) ─
  seed("shipwright_task_complete", "2026-06-02T12:00:00.000Z", {
    task: "QS-1.1",
    actual_h: 4,
    estimated_h: 5,
    retries: 1,
    files_changed: 6,
    complexity: 3,
    fix_cascade_depth: 2,
    started_at: "2026-06-02T08:00:00.000Z",
    ts: "2026-06-02T12:00:00.000Z",
  });
  seed("shipwright_task_complete", "2026-06-03T12:00:00.000Z", {
    task: "QS-1.2",
    actual_h: 6,
    estimated_h: 5,
    retries: 3,
    files_changed: 10,
    complexity: 5,
    fix_cascade_depth: 4,
    started_at: "2026-06-03T06:00:00.000Z",
    ts: "2026-06-03T12:00:00.000Z",
  });

  // ─ Blocked (1) ─
  seed("shipwright_task_blocked", "2026-06-02T15:00:00.000Z", {
    task_id: "QS-1.3",
  });

  // ─ CI results (2 total, 1 first-pass) ─
  seed("shipwright_ci_result", "2026-06-02T10:00:00.000Z", {
    task_id: "QS-1.1",
    passed_first_try: true,
    fix_attempts: 0,
    first_pass: true,
  });
  seed("shipwright_ci_result", "2026-06-03T10:00:00.000Z", {
    task_id: "QS-1.2",
    passed_first_try: false,
    fix_attempts: 2,
    first_pass: false,
  });

  // ─ Simplify (1) ─
  seed("shipwright_simplify_complete", "2026-06-02T11:00:00.000Z", {
    task_id: "QS-1.1",
    total_fixes: 5,
    dry: 2,
    dead_code: 1,
    naming: 1,
    complexity_fixes: 0.5,
    consistency: 0.5,
  });

  // ─ Reviews (2 total, 1 SHIP IT) ─
  seed("shipwright_task_reviewed", "2026-06-02T13:00:00.000Z", {
    task_id: "QS-1.1",
    verdict: "SHIP IT",
    findings: 1,
  });
  seed("shipwright_task_reviewed", "2026-06-03T13:00:00.000Z", {
    task_id: "QS-1.2",
    verdict: "REVISE",
    findings: 3,
  });

  // ─ Started (2) — used by queue cycle + trends ─
  seed("shipwright_task_started", "2026-06-02T08:00:00.000Z", {
    task_id: "QS-1.1",
  });
  seed("shipwright_task_started", "2026-06-03T06:00:00.000Z", {
    task_id: "QS-1.2",
  });

  // ─ Token usage (2 events) ─
  seed("agent_token_usage", "2026-06-02T09:00:00.000Z", {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 100,
    session_type: "cron",
    agent_id: "agent-a",
  });
  seed("agent_token_usage", "2026-06-03T09:00:00.000Z", {
    input_tokens: 2000,
    output_tokens: 800,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 150,
    session_type: "slack_dm",
    agent_id: "agent-b",
  });
});

afterEach(() => {
  store.close();
});

async function q(query: MetricQuery) {
  return provider.query(query);
}

describe("SqliteProvider.summary", () => {
  test("aggregates completion / ci / simplify / review metrics", async () => {
    const table = await q({ kind: "summary", range: RANGE });
    const r = row0(table);

    expect(r.tasks_completed).toBe(2);
    expect(r.tasks_blocked).toBe(1);
    expect(Number(r.avg_actual_hours)).toBeCloseTo(5, 5); // (4+6)/2
    expect(Number(r.avg_estimated_hours)).toBeCloseTo(5, 5);
    expect(Number(r.avg_retries)).toBeCloseTo(2, 5); // (1+3)/2
    expect(Number(r.avg_files_changed)).toBeCloseTo(8, 5);
    expect(r.ci_gates_total).toBe(2);
    expect(r.ci_first_pass).toBe(1);
    expect(Number(r.avg_fix_attempts)).toBeCloseTo(1, 5); // (0+2)/2
    expect(r.simplify_total).toBe(1);
    expect(Number(r.simplify_total_fixes)).toBeCloseTo(5, 5);
    expect(Number(r.simplify_avg_dry)).toBeCloseTo(2, 5);
    expect(r.reviews_total).toBe(2);
    expect(r.reviews_ship_it).toBe(1);
    expect(r.complexity_3).toBe(1);
    expect(r.complexity_5).toBe(1);
    expect(r.complexity_1).toBe(0);
    expect(Number(r.avg_fix_cascade_depth)).toBeCloseTo(3, 5); // (2+4)/2
  });

  test("date range outside seeded events yields zero counts", async () => {
    const table = await q({
      kind: "summary",
      range: { from: "2025-01-01", to: "2025-01-02" },
    });
    const r = row0(table);
    expect(r.tasks_completed).toBe(0);
    expect(r.ci_gates_total).toBe(0);
  });
});

describe("SqliteProvider.summaryCycleTime", () => {
  test("avg cycle hours from started_at→ts", async () => {
    const table = await q({ kind: "summaryCycleTime", range: RANGE });
    const r = row0(table);
    // QS-1.1: 4h, QS-1.2: 6h → avg 5
    expect(Number(r.avg_cycle_time_hours)).toBeCloseTo(5, 5);
  });
});

describe("SqliteProvider.trends", () => {
  test("groups by day with per-period columns", async () => {
    const table = await q({ kind: "trends", range: RANGE, groupBy: "day" });
    const all = rows(table);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(table.columns).toContain("period");
    expect(table.columns).toContain("tasks_completed");

    const totalCompleted = all.reduce(
      (acc, x) => acc + Number(x.tasks_completed ?? 0),
      0,
    );
    expect(totalCompleted).toBe(2);
    const totalStarted = all.reduce(
      (acc, x) => acc + Number(x.tasks_started ?? 0),
      0,
    );
    expect(totalStarted).toBe(2);
  });
});

describe("SqliteProvider.features", () => {
  test("featuresTasks groups by prefix", async () => {
    const table = await q({ kind: "featuresTasks", range: RANGE });
    const all = rows(table);
    const qs = all.find((x) => x.feature_prefix === "QS");
    expect(qs).toBeDefined();
    expect(qs?.tasks_completed).toBe(2);
    expect(Number(qs?.avg_actual_h)).toBeCloseTo(5, 5);
  });

  test("featuresCi groups by prefix", async () => {
    const table = await q({ kind: "featuresCi", range: RANGE });
    const qs = rows(table).find((x) => x.feature_prefix === "QS");
    expect(qs?.ci_total).toBe(2);
    expect(qs?.ci_first_pass).toBe(1);
  });

  test("featuresReviews groups by prefix", async () => {
    const table = await q({ kind: "featuresReviews", range: RANGE });
    const qs = rows(table).find((x) => x.feature_prefix === "QS");
    expect(qs?.reviews_total).toBe(2);
    expect(qs?.reviews_ship_it).toBe(1);
  });
});

describe("SqliteProvider.queue", () => {
  test("queueFunnel counts", async () => {
    const table = await q({ kind: "queueFunnel", range: RANGE });
    const r = row0(table);
    expect(r.tasks_started).toBe(2);
    expect(r.tasks_approved).toBe(2); // reviewed events
    expect(r.tasks_merged).toBe(2); // completed events
    expect(r.tasks_blocked).toBe(1);
    expect(Number(r.avg_review_findings)).toBeCloseTo(2, 5); // (1+3)/2
  });

  test("queueCycleStarted returns task_id + timestamp rows", async () => {
    const table = await q({ kind: "queueCycleStarted", range: RANGE });
    const all = rows(table);
    expect(all).toHaveLength(2);
    expect(table.columns).toEqual(["task_id", "timestamp"]);
    const ids = all.map((x) => x.task_id).sort();
    expect(ids).toEqual(["QS-1.1", "QS-1.2"]);
  });

  test("queueCycleMerged returns task_id + timestamp rows", async () => {
    const table = await q({ kind: "queueCycleMerged", range: RANGE });
    const all = rows(table);
    expect(all).toHaveLength(2);
    const ids = all.map((x) => x.task_id).sort();
    expect(ids).toEqual(["QS-1.1", "QS-1.2"]);
  });
});

describe("SqliteProvider.tokens", () => {
  test("tokensTotals sums all token fields", async () => {
    const table = await q({ kind: "tokensTotals", range: RANGE });
    const r = row0(table);
    expect(Number(r.input_tokens)).toBe(3000);
    expect(Number(r.output_tokens)).toBe(1300);
    expect(Number(r.cache_read_input_tokens)).toBe(600);
    expect(Number(r.cache_creation_input_tokens)).toBe(250);
    expect(Number(r.total_tokens)).toBe(3000 + 1300 + 600 + 250);
  });

  test("tokensBySessionType groups by session_type", async () => {
    const table = await q({ kind: "tokensBySessionType", range: RANGE });
    const all = rows(table);
    const cron = all.find((x) => x.session_type === "cron");
    expect(Number(cron?.input_tokens)).toBe(1000);
    const dm = all.find((x) => x.session_type === "slack_dm");
    expect(Number(dm?.input_tokens)).toBe(2000);
  });

  test("tokensByAgent groups by agent_id", async () => {
    const table = await q({ kind: "tokensByAgent", range: RANGE });
    const all = rows(table);
    const a = all.find((x) => x.agent_id === "agent-a");
    expect(Number(a?.total_tokens)).toBe(1000 + 500 + 200 + 100);
  });

  test("tokensTrends groups by day", async () => {
    const table = await q({ kind: "tokensTrends", range: RANGE });
    const all = rows(table);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(table.columns).toContain("period");
    const total = all.reduce((acc, x) => acc + Number(x.input_tokens ?? 0), 0);
    expect(total).toBe(3000);
  });

  test("tokens honor date-range filtering", async () => {
    const table = await q({
      kind: "tokensTotals",
      range: { from: "2026-06-03", to: "2026-06-03" },
    });
    const r = row0(table);
    // Only the 2026-06-03 event (input 2000) falls in range.
    expect(Number(r.input_tokens)).toBe(2000);
  });
});
