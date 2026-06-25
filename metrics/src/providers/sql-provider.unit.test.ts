/**
 * metrics/src/providers/sql-provider.unit.test.ts
 *
 * Unit tests for SqlEventStoreProvider (the shared in-memory aggregation
 * engine) using an in-memory SQLite store. Verifies that the same aggregation
 * logic that backs SqliteProvider is reachable through the shared provider
 * constructor.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LocalEventStore, createLocalEventStore } from "../local-store.ts";
import type { MetricQuery } from "../metrics-provider.ts";
import { SqlEventStoreProvider } from "./sql-provider.ts";

let store: LocalEventStore;
let provider: SqlEventStoreProvider;

const RANGE = { from: "2026-06-01", to: "2026-06-07" } as const;

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
  provider = new SqlEventStoreProvider(store);

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
  seed("shipwright_task_blocked", "2026-06-02T15:00:00.000Z", {
    task_id: "QS-1.3",
  });
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
  seed("shipwright_simplify_complete", "2026-06-02T11:00:00.000Z", {
    task_id: "QS-1.1",
    total_fixes: 5,
    dry: 2,
    dead_code: 1,
    naming: 1,
    complexity_fixes: 0.5,
    consistency: 0.5,
  });
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
  seed("shipwright_task_started", "2026-06-02T08:00:00.000Z", {
    task_id: "QS-1.1",
  });
  seed("shipwright_task_started", "2026-06-03T06:00:00.000Z", {
    task_id: "QS-1.2",
  });
  seed("agent_token_usage", "2026-06-02T09:00:00.000Z", {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 200,
    cache_creation_input_tokens: 100,
    session_type: "cron",
    agent_id: "agent-a",
    cron_name: "daily-report",
    model: "claude-sonnet-4-5",
    cost_usd: 0.01,
  });
  seed("agent_token_usage", "2026-06-03T09:00:00.000Z", {
    input_tokens: 2000,
    output_tokens: 800,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 150,
    session_type: "slack_dm",
    agent_id: "agent-b",
    model: "claude-opus-4-5",
    cost_usd: 0.05,
  });
});

afterEach(() => {
  store.close();
});

async function q(query: MetricQuery) {
  return provider.query(query);
}

describe("SqlEventStoreProvider.summary", () => {
  test("aggregates completion / ci / simplify / review metrics", async () => {
    const table = await q({ kind: "summary", range: RANGE });
    const r = row0(table);
    expect(r.tasks_completed).toBe(2);
    expect(r.tasks_blocked).toBe(1);
    expect(Number(r.avg_actual_hours)).toBeCloseTo(5, 5);
    expect(r.ci_gates_total).toBe(2);
    expect(r.ci_first_pass).toBe(1);
    expect(r.reviews_total).toBe(2);
    expect(r.complexity_3).toBe(1);
  });
});

describe("SqlEventStoreProvider.summaryCycleTime", () => {
  test("returns avg_cycle_time_hours", async () => {
    const table = await q({ kind: "summaryCycleTime", range: RANGE });
    const r = row0(table);
    expect(Number(r.avg_cycle_time_hours)).toBeCloseTo(5, 5);
  });
});

describe("SqlEventStoreProvider.trends", () => {
  test("groups by day", async () => {
    const table = await q({ kind: "trends", range: RANGE, groupBy: "day" });
    const all = rows(table);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const total = all.reduce(
      (acc, x) => acc + Number(x.tasks_completed ?? 0),
      0,
    );
    expect(total).toBe(2);
  });
});

describe("SqlEventStoreProvider.features", () => {
  test("featuresTasks", async () => {
    const table = await q({ kind: "featuresTasks", range: RANGE });
    const qs = rows(table).find((x) => x.feature_prefix === "QS");
    expect(qs?.tasks_completed).toBe(2);
  });

  test("featuresCi", async () => {
    const table = await q({ kind: "featuresCi", range: RANGE });
    const qs = rows(table).find((x) => x.feature_prefix === "QS");
    expect(qs?.ci_total).toBe(2);
    expect(qs?.ci_first_pass).toBe(1);
  });

  test("featuresReviews", async () => {
    const table = await q({ kind: "featuresReviews", range: RANGE });
    const qs = rows(table).find((x) => x.feature_prefix === "QS");
    expect(qs?.reviews_total).toBe(2);
    expect(qs?.reviews_ship_it).toBe(1);
  });
});

describe("SqlEventStoreProvider.queue", () => {
  test("queueFunnel", async () => {
    const table = await q({ kind: "queueFunnel", range: RANGE });
    const r = row0(table);
    expect(r.tasks_started).toBe(2);
    expect(r.tasks_merged).toBe(2);
    expect(r.tasks_blocked).toBe(1);
  });

  test("queueCycleStarted", async () => {
    const table = await q({ kind: "queueCycleStarted", range: RANGE });
    expect(rows(table)).toHaveLength(2);
    expect(table.columns).toEqual(["task_id", "timestamp"]);
  });

  test("queueCycleMerged", async () => {
    const table = await q({ kind: "queueCycleMerged", range: RANGE });
    expect(rows(table)).toHaveLength(2);
  });
});

describe("SqlEventStoreProvider.tokens", () => {
  test("tokensTotals", async () => {
    const table = await q({ kind: "tokensTotals", range: RANGE });
    const r = row0(table);
    expect(Number(r.input_tokens)).toBe(3000);
    expect(Number(r.total_tokens)).toBe(5150);
  });

  test("tokensBySessionType", async () => {
    const table = await q({ kind: "tokensBySessionType", range: RANGE });
    const cron = rows(table).find((x) => x.session_type === "cron");
    expect(Number(cron?.input_tokens)).toBe(1000);
  });

  test("tokensByAgent", async () => {
    const table = await q({ kind: "tokensByAgent", range: RANGE });
    const a = rows(table).find((x) => x.agent_id === "agent-a");
    expect(Number(a?.total_tokens)).toBe(1800);
  });

  test("tokensTrends", async () => {
    const table = await q({ kind: "tokensTrends", range: RANGE });
    const all = rows(table);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const total = all.reduce((acc, x) => acc + Number(x.input_tokens ?? 0), 0);
    expect(total).toBe(3000);
  });

  test("tokensByAgentBySessionType — columns include cost_usd and values are correct", async () => {
    const table = await q({ kind: "tokensByAgentBySessionType", range: RANGE });
    expect(table.columns).toContain("cost_usd");
    expect(table.columns).toContain("agent_id");
    expect(table.columns).toContain("session_type");
    const all = rows(table);
    const agentA = all.find(
      (x) => x.agent_id === "agent-a" && x.session_type === "cron",
    );
    expect(agentA).toBeDefined();
    expect(Number(agentA?.input_tokens)).toBe(1000);
    expect(Number(agentA?.cost_usd)).toBeCloseTo(0.01);
  });

  test("tokensByAgentByCron — columns include cost_usd; only cron events included", async () => {
    const table = await q({ kind: "tokensByAgentByCron", range: RANGE });
    expect(table.columns).toContain("cost_usd");
    expect(table.columns).toContain("agent_id");
    expect(table.columns).toContain("cron_name");
    const all = rows(table);
    // Only the cron event (agent-a / daily-report) qualifies
    expect(all).toHaveLength(1);
    const r = all[0];
    expect(r?.agent_id).toBe("agent-a");
    expect(r?.cron_name).toBe("daily-report");
    expect(Number(r?.input_tokens)).toBe(1000);
    expect(Number(r?.cost_usd)).toBeCloseTo(0.01);
  });

  test("tokensByAgentByModel — columns include cost_usd and values are correct", async () => {
    const table = await q({ kind: "tokensByAgentByModel", range: RANGE });
    expect(table.columns).toContain("cost_usd");
    expect(table.columns).toContain("agent_id");
    expect(table.columns).toContain("model");
    const all = rows(table);
    const agentB = all.find((x) => x.agent_id === "agent-b");
    expect(agentB).toBeDefined();
    expect(Number(agentB?.input_tokens)).toBe(2000);
    expect(Number(agentB?.cost_usd)).toBeCloseTo(0.05);
  });
});
