/**
 * metrics/src/providers/task-store-provider.integration.test.ts
 * Integration: drive TaskStoreProvider over Recorded task-store + admin doubles
 * with a FixedClock, asserting it emits sql-provider-identical MetricTables for
 * the headline kinds, that token totals = cron + chat (no double-counting), that
 * a custom {from,to} range filters cassette rows, and that all 17 kinds return a
 * table without throwing.
 */

import { describe, expect, test } from "bun:test";
import type {
  ChatTokenStats,
  CronRunTokenStats,
} from "../lib/admin-metrics-client.ts";
import type { PrRecord, TaskRecord } from "../lib/task-store-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import type { MetricQuery } from "../metrics-provider.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";
import {
  FaultingBothAdminMetricsClient,
  FaultingChatAdminMetricsClient,
  FaultingCronAdminMetricsClient,
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "./task-store-recorded.ts";

// ─── Cassettes ────────────────────────────────────────────────────────────────

const TASKS: TaskRecord[] = [
  {
    id: "QS-1.1",
    status: "merged",
    session: "cron",
    hours: 5,
    complexity: 3,
    startedAt: "2026-06-02T08:00:00.000Z",
    completedAt: "2026-06-02T12:00:00.000Z",
    mergedAt: "2026-06-02T12:00:00.000Z",
    prCreatedAt: "2026-06-02T11:00:00.000Z",
    ciFixAttempts: 0,
    simplifyTotal: 2,
    createdAt: "2026-06-01T08:00:00.000Z",
    coverageDelta: 2.5,
    simplifyDry: 4,
    simplifyDeadCode: 2,
    simplifyNaming: 6,
    simplifyComplexity: 1,
    simplifyConsistency: 3,
  },
  {
    id: "QS-1.2",
    status: "done",
    session: "cron",
    hours: 3,
    complexity: 2,
    startedAt: "2026-06-03T09:00:00.000Z",
    completedAt: "2026-06-03T15:00:00.000Z",
    mergedAt: "2026-06-03T15:00:00.000Z",
    prCreatedAt: "2026-06-03T14:00:00.000Z",
    ciFixAttempts: 2,
    simplifyTotal: 1,
    createdAt: "2026-06-02T08:00:00.000Z",
    coverageDelta: null,
    simplifyDry: 2,
    simplifyDeadCode: 0,
    simplifyNaming: 4,
    simplifyComplexity: 3,
    simplifyConsistency: 1,
  },
  {
    id: "MQ-2.1",
    status: "blocked",
    session: "chat",
    hours: 4,
    complexity: 5,
    startedAt: "2026-06-04T08:00:00.000Z",
    createdAt: "2026-06-04T07:00:00.000Z",
  },
  {
    id: "PV-9.9",
    status: "merged",
    session: "cron",
    hours: 8,
    complexity: 4,
    startedAt: "2026-07-10T08:00:00.000Z",
    completedAt: "2026-07-10T16:00:00.000Z",
    mergedAt: "2026-07-10T16:00:00.000Z",
    ciFixAttempts: 0,
    simplifyTotal: 0,
    createdAt: "2026-07-09T08:00:00.000Z",
  },
];

const PRS: PrRecord[] = [
  {
    id: "pr-1",
    taskId: "QS-1.1",
    reviewState: "approved",
    createdAt: "2026-06-02T11:00:00.000Z",
    mergedAt: "2026-06-02T12:00:00.000Z",
    reviewCycles: 1,
    patchCycles: 1,
  },
  {
    id: "pr-2",
    taskId: "QS-1.2",
    reviewState: "posted",
    createdAt: "2026-06-03T14:00:00.000Z",
    mergedAt: "2026-06-03T15:00:00.000Z",
    reviewCycles: 2,
    patchCycles: 1,
  },
];

const agg = (
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation: number,
  costUsd?: number,
) => ({
  input,
  output,
  cacheRead,
  cacheCreation,
  total: input + output + cacheRead + cacheCreation,
  ...(costUsd !== undefined ? { costUsd } : {}),
});

const CRON_STATS: CronRunTokenStats = {
  totals: agg(1000, 500, 200, 100, 1.5),
  byAgent: [{ key: "agent-a", ...agg(1000, 500, 200, 100, 1.5) }],
  byCron: [
    // Legacy, no-phase rows (fall back to today's cronId-only grouping).
    { key1: "agent-a", key2: "ship-loop", ...agg(700, 350, 140, 70, 1.0) },
    { key1: "agent-a", key2: "patrol", ...agg(300, 150, 60, 30, 0.5) },
  ],
  byModel: [
    { key1: "agent-a", key2: "opus", ...agg(1000, 500, 200, 100, 1.5) },
  ],
  daily: [{ period: "2026-06-02", ...agg(1000, 500, 200, 100, 1.5) }],
  byCronModel: [
    {
      key1: "agent-a:ship-loop",
      key2: "opus",
      ...agg(700, 350, 140, 70, 1.0),
    },
    {
      key1: "agent-a:patrol",
      key2: "opus",
      ...agg(300, 150, 60, 30, 0.5),
    },
  ],
  byPhase: [],
};

// Phase-aware cron stats (mirrors CRON_STATS but with `phase` set on byCron /
// byCronModel rows) — used to exercise the WL-3.5 grouping/pass-through path.
const CRON_STATS_WITH_PHASE: CronRunTokenStats = {
  ...CRON_STATS,
  byCron: [
    {
      key1: "agent-a",
      key2: "shipwright-loop",
      phase: "dev-task",
      ...agg(700, 350, 140, 70, 1.0),
    },
    {
      key1: "agent-a",
      key2: "shipwright-loop",
      phase: "review",
      ...agg(300, 150, 60, 30, 0.5),
    },
    // Legacy row on a different cron — no phase set, must fall back to
    // cronId-only display (phase omitted/null).
    { key1: "agent-a", key2: "patrol", ...agg(100, 50, 20, 10, 0.2) },
  ],
  byCronModel: [
    {
      key1: "agent-a:shipwright-loop",
      key2: "opus",
      phase: "dev-task",
      ...agg(700, 350, 140, 70, 1.0),
    },
    {
      key1: "agent-a:shipwright-loop",
      key2: "opus",
      phase: "review",
      ...agg(300, 150, 60, 30, 0.5),
    },
    {
      key1: "agent-a:patrol",
      key2: "opus",
      ...agg(100, 50, 20, 10, 0.2),
    },
  ],
};

const CHAT_STATS: ChatTokenStats = {
  totals: agg(400, 200, 80, 40, 0.6),
  byAgent: [{ key: "agent-a", ...agg(400, 200, 80, 40, 0.6) }],
  byModel: [{ key1: "agent-a", key2: "claude-sonnet-4-5", ...agg(400, 200, 80, 40, 0.6) }],
  daily: [{ period: "2026-06-03", ...agg(400, 200, 80, 40, 0.6) }],
};

// ─── Harness ──────────────────────────────────────────────────────────────────

const CLOCK = FixedClock("2026-06-10T12:00:00.000Z");

function buildProvider() {
  const taskStore = new RecordedTaskStoreClient(TASKS, PRS);
  const admin = new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS);
  return new TaskStoreProvider(taskStore, admin, CLOCK);
}

const RANGE = { from: "2026-06-01", to: "2026-06-07" } as const;

function colIndex(table: { columns: string[] }, name: string): number {
  return table.columns.indexOf(name);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TaskStoreProvider (integration)", () => {
  test("summary aggregates completed/blocked tasks in window", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "summary", range: RANGE });

    expect(t.columns).toEqual([
      "tasks_completed",
      "tasks_blocked",
      "avg_actual_hours",
      "avg_estimated_hours",
      "avg_retries",
      "avg_files_changed",
      "ci_gates_total",
      "ci_first_pass",
      "avg_fix_attempts",
      "simplify_total",
      "simplify_total_fixes",
      "simplify_avg_dry",
      "simplify_avg_dead_code",
      "simplify_avg_naming",
      "simplify_avg_complexity",
      "simplify_avg_consistency",
      "reviews_total",
      "reviews_ship_it",
      "avg_review_iterations",
      "complexity_1",
      "complexity_2",
      "complexity_3",
      "complexity_4",
      "complexity_5",
      "avg_fix_cascade_depth",
      "coverage_reports",
      "avg_coverage_delta",
    ]);
    const row = t.results[0];
    // QS-1.1 + QS-1.2 completed; PV-9.9 out of window.
    expect(row[colIndex(t, "tasks_completed")]).toBe(2);
    expect(row[colIndex(t, "tasks_blocked")]).toBe(1);
    // ci_gates_total = completed with a recorded ciFixAttempts (both)
    expect(row[colIndex(t, "ci_gates_total")]).toBe(2);
    // ci_first_pass = ciFixAttempts === 0 → only QS-1.1
    expect(row[colIndex(t, "ci_first_pass")]).toBe(1);
    expect(row[colIndex(t, "complexity_3")]).toBe(1);
    expect(row[colIndex(t, "complexity_2")]).toBe(1);
    // reviews from PR records
    expect(row[colIndex(t, "reviews_total")]).toBe(2);
    expect(row[colIndex(t, "reviews_ship_it")]).toBe(1);
    // coverage: QS-1.1 has coverageDelta=2.5, QS-1.2 has null → excluded, not
    // treated as zero.
    expect(row[colIndex(t, "coverage_reports")]).toBe(1);
    expect(row[colIndex(t, "avg_coverage_delta")]).toBe(2.5);
    // avg_review_iterations = avg(reviewCycles + patchCycles) = avg(2, 3) = 2.5
    expect(row[colIndex(t, "avg_review_iterations")]).toBe(2.5);
    // simplify category averages: QS-1.1 (4,2,6,1,3) + QS-1.2 (2,0,4,3,1)
    expect(row[colIndex(t, "simplify_avg_dry")]).toBe(3);
    expect(row[colIndex(t, "simplify_avg_dead_code")]).toBe(1);
    expect(row[colIndex(t, "simplify_avg_naming")]).toBe(5);
    expect(row[colIndex(t, "simplify_avg_complexity")]).toBe(2);
    expect(row[colIndex(t, "simplify_avg_consistency")]).toBe(2);
  });

  test("summary coverage aggregation excludes null coverageDelta tasks from the average", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "CV-1.1",
        status: "merged",
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
        coverageDelta: 4,
      },
      {
        id: "CV-1.2",
        status: "merged",
        startedAt: "2026-06-03T08:00:00.000Z",
        completedAt: "2026-06-03T12:00:00.000Z",
        mergedAt: "2026-06-03T12:00:00.000Z",
        createdAt: "2026-06-02T08:00:00.000Z",
        coverageDelta: -2,
      },
      {
        id: "CV-1.3",
        status: "merged",
        startedAt: "2026-06-04T08:00:00.000Z",
        completedAt: "2026-06-04T12:00:00.000Z",
        mergedAt: "2026-06-04T12:00:00.000Z",
        createdAt: "2026-06-03T08:00:00.000Z",
        coverageDelta: null,
      },
      {
        id: "CV-1.4",
        status: "merged",
        startedAt: "2026-06-05T08:00:00.000Z",
        completedAt: "2026-06-05T12:00:00.000Z",
        mergedAt: "2026-06-05T12:00:00.000Z",
        createdAt: "2026-06-04T08:00:00.000Z",
        // coverageDelta intentionally omitted (undefined)
      },
    ];
    const taskStore = new RecordedTaskStoreClient(tasks, []);
    const admin = new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({ kind: "summary", range: RANGE });
    const row = t.results[0];
    expect(row[colIndex(t, "tasks_completed")]).toBe(4);
    // Only CV-1.1 and CV-1.2 have a non-null coverageDelta.
    expect(row[colIndex(t, "coverage_reports")]).toBe(2);
    // Average of 4 and -2 = 1, not diluted by the two null/undefined tasks.
    expect(row[colIndex(t, "avg_coverage_delta")]).toBe(1);
  });

  test("summary simplify category averages exclude tasks with null/undefined values", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "SX-1.1",
        status: "merged",
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
        simplifyDry: 6,
        simplifyDeadCode: 4,
        simplifyNaming: 8,
        simplifyComplexity: 2,
        simplifyConsistency: 5,
      },
      {
        id: "SX-1.2",
        status: "merged",
        startedAt: "2026-06-03T08:00:00.000Z",
        completedAt: "2026-06-03T12:00:00.000Z",
        mergedAt: "2026-06-03T12:00:00.000Z",
        createdAt: "2026-06-02T08:00:00.000Z",
        simplifyDry: null,
        simplifyDeadCode: null,
        simplifyNaming: null,
        simplifyComplexity: null,
        simplifyConsistency: null,
      },
      {
        id: "SX-1.3",
        status: "merged",
        startedAt: "2026-06-04T08:00:00.000Z",
        completedAt: "2026-06-04T12:00:00.000Z",
        mergedAt: "2026-06-04T12:00:00.000Z",
        createdAt: "2026-06-03T08:00:00.000Z",
        // simplify* fields intentionally omitted (undefined)
      },
    ];
    const taskStore = new RecordedTaskStoreClient(tasks, []);
    const admin = new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({ kind: "summary", range: RANGE });
    const row = t.results[0];
    // Only SX-1.1 has non-null simplify category values → average equals its
    // own values, not diluted by the null/undefined tasks.
    expect(row[colIndex(t, "simplify_avg_dry")]).toBe(6);
    expect(row[colIndex(t, "simplify_avg_dead_code")]).toBe(4);
    expect(row[colIndex(t, "simplify_avg_naming")]).toBe(8);
    expect(row[colIndex(t, "simplify_avg_complexity")]).toBe(2);
    expect(row[colIndex(t, "simplify_avg_consistency")]).toBe(5);
  });

  test("summary simplify category averages are null when no tasks have simplify data", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "SX-2.1",
        status: "merged",
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
      },
    ];
    const taskStore = new RecordedTaskStoreClient(tasks, []);
    const admin = new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({ kind: "summary", range: RANGE });
    const row = t.results[0];
    expect(row[colIndex(t, "simplify_avg_dry")]).toBeNull();
    expect(row[colIndex(t, "simplify_avg_dead_code")]).toBeNull();
    expect(row[colIndex(t, "simplify_avg_naming")]).toBeNull();
    expect(row[colIndex(t, "simplify_avg_complexity")]).toBeNull();
    expect(row[colIndex(t, "simplify_avg_consistency")]).toBeNull();
  });

  test("summary coverage aggregation returns 0/null when no tasks have coverageDelta", async () => {
    const tasks: TaskRecord[] = [
      {
        id: "CV-2.1",
        status: "merged",
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
      },
    ];
    const taskStore = new RecordedTaskStoreClient(tasks, []);
    const admin = new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({ kind: "summary", range: RANGE });
    const row = t.results[0];
    expect(row[colIndex(t, "coverage_reports")]).toBe(0);
    expect(row[colIndex(t, "avg_coverage_delta")]).toBeNull();
  });

  test("queueFunnel counts started/approved/merged/blocked", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "queueFunnel", range: RANGE });
    expect(t.columns).toEqual([
      "tasks_started",
      "tasks_approved",
      "tasks_merged",
      "tasks_blocked",
      "avg_review_findings",
    ]);
    const row = t.results[0];
    expect(row[colIndex(t, "tasks_merged")]).toBe(2);
    expect(row[colIndex(t, "tasks_blocked")]).toBe(1);
    // approved derives from PRs whose reviewState === "approved"
    expect(row[colIndex(t, "tasks_approved")]).toBe(1);
    // task-store PR records carry no findings count → always null
    expect(row[colIndex(t, "avg_review_findings")]).toBeNull();
  });

  test("trends includes coverage_reports and avg_coverage_delta columns computed per period", async () => {
    const provider = buildProvider();
    const t = await provider.query({
      kind: "trends",
      range: RANGE,
      groupBy: "day",
    });

    expect(t.columns).toContain("coverage_reports");
    expect(t.columns).toContain("avg_coverage_delta");

    // QS-1.1 completes on 2026-06-02 with coverageDelta=2.5.
    const day1 = t.results.find(
      (r) => r[colIndex(t, "period")] === "2026-06-02",
    );
    expect(day1).toBeDefined();
    expect(day1?.[colIndex(t, "coverage_reports")]).toBe(1);
    expect(day1?.[colIndex(t, "avg_coverage_delta")]).toBe(2.5);

    // QS-1.2 completes on 2026-06-03 with coverageDelta=null → excluded, not
    // treated as zero.
    const day2 = t.results.find(
      (r) => r[colIndex(t, "period")] === "2026-06-03",
    );
    expect(day2).toBeDefined();
    expect(day2?.[colIndex(t, "coverage_reports")]).toBe(0);
    expect(day2?.[colIndex(t, "avg_coverage_delta")]).toBeNull();
  });

  test("trends per-period simplify_avg_* columns are non-null when simplify data exists", async () => {
    const provider = buildProvider();
    const t = await provider.query({
      kind: "trends",
      range: RANGE,
      groupBy: "day",
    });

    // QS-1.1 completes on 2026-06-02 with simplifyDry=4, simplifyDeadCode=2,
    // simplifyNaming=6, simplifyComplexity=1, simplifyConsistency=3.
    const day1 = t.results.find(
      (r) => r[colIndex(t, "period")] === "2026-06-02",
    );
    expect(day1).toBeDefined();
    expect(day1?.[colIndex(t, "simplify_avg_dry")]).toBe(4);
    expect(day1?.[colIndex(t, "simplify_avg_dead_code")]).toBe(2);
    expect(day1?.[colIndex(t, "simplify_avg_naming")]).toBe(6);
    expect(day1?.[colIndex(t, "simplify_avg_complexity")]).toBe(1);
    expect(day1?.[colIndex(t, "simplify_avg_consistency")]).toBe(3);

    // QS-1.2 completes on 2026-06-03 with simplifyDry=2, simplifyDeadCode=0,
    // simplifyNaming=4, simplifyComplexity=3, simplifyConsistency=1.
    const day2 = t.results.find(
      (r) => r[colIndex(t, "period")] === "2026-06-03",
    );
    expect(day2).toBeDefined();
    expect(day2?.[colIndex(t, "simplify_avg_dry")]).toBe(2);
    expect(day2?.[colIndex(t, "simplify_avg_dead_code")]).toBe(0);
    expect(day2?.[colIndex(t, "simplify_avg_naming")]).toBe(4);
    expect(day2?.[colIndex(t, "simplify_avg_complexity")]).toBe(3);
    expect(day2?.[colIndex(t, "simplify_avg_consistency")]).toBe(1);
  });

  test("tokensTotals = cron + chat summed field-wise (no double counting)", async () => {
    const provider = buildProvider();
    const t = await provider.query({ kind: "tokensTotals", range: RANGE });
    expect(t.columns).toEqual([
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
      "cost_usd",
    ]);
    const row = t.results[0];
    const c = CRON_STATS.totals;
    const h = CHAT_STATS.totals;
    expect(row[0]).toBe(c.input + h.input);
    expect(row[1]).toBe(c.output + h.output);
    expect(row[2]).toBe(c.cacheRead + h.cacheRead);
    expect(row[3]).toBe(c.cacheCreation + h.cacheCreation);
    expect(row[4]).toBe(c.total + h.total);
    expect(row[5]).toBe((c.costUsd ?? 0) + (h.costUsd ?? 0));
  });

  test("tokensByAgentByCron is cron-only with cost_usd and a phase column", async () => {
    const provider = buildProvider();
    const t = await provider.query({
      kind: "tokensByAgentByCron",
      range: RANGE,
    });
    expect(t.columns).toEqual([
      "agent_id",
      "cron_name",
      "phase",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
      "cost_usd",
    ]);
    expect(t.results.length).toBe(2);
    // sorted by total desc → ship-loop first
    expect(t.results[0][1]).toBe("ship-loop");
    expect(t.results[0][0]).toBe("agent-a");
    expect(t.results[0][8]).toBe(1.0);
    // legacy (no-phase) rows carry a null phase — no fabricated bucket.
    expect(t.results[0][2]).toBeNull();
    expect(t.results[1][2]).toBeNull();
  });

  test("tokensByAgentByCron groups (cronId, phase): a phase-tagged cron yields one row per phase", async () => {
    const taskStore = new RecordedTaskStoreClient(TASKS, PRS);
    const admin = new RecordedAdminMetricsClient(
      CRON_STATS_WITH_PHASE,
      CHAT_STATS,
    );
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({
      kind: "tokensByAgentByCron",
      range: RANGE,
    });

    expect(t.results.length).toBe(3);
    const devTaskRow = t.results.find(
      (r) => r[1] === "shipwright-loop" && r[2] === "dev-task",
    );
    const reviewRow = t.results.find(
      (r) => r[1] === "shipwright-loop" && r[2] === "review",
    );
    const legacyRow = t.results.find((r) => r[1] === "patrol");

    expect(devTaskRow).toBeDefined();
    expect(devTaskRow?.[0]).toBe("agent-a");
    expect(devTaskRow?.[8]).toBe(1.0);

    expect(reviewRow).toBeDefined();
    expect(reviewRow?.[8]).toBe(0.5);

    // Legacy no-phase cron still collapses to a single row (fallback path).
    expect(legacyRow).toBeDefined();
    expect(legacyRow?.[2]).toBeNull();
  });

  test("tokensByAgentByCronModel is cron-only with cost_usd, split from key1, and a phase column", async () => {
    const provider = buildProvider();
    const t = await provider.query({
      kind: "tokensByAgentByCronModel",
      range: RANGE,
    });
    expect(t.columns).toEqual([
      "agent_id",
      "cron_name",
      "model",
      "phase",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
      "cost_usd",
    ]);
    expect(t.results.length).toBe(2);
    // sorted by total desc → ship-loop first
    expect(t.results[0][0]).toBe("agent-a");
    expect(t.results[0][1]).toBe("ship-loop");
    expect(t.results[0][2]).toBe("opus");
    expect(t.results[0][9]).toBe(1.0);
    expect(t.results[0][3]).toBeNull();
    expect(t.results[1][1]).toBe("patrol");
    expect(t.results[1][9]).toBe(0.5);
  });

  test("tokensByAgentByCronModel groups (cronId, phase, model): a phase-tagged cron yields one row per phase", async () => {
    const taskStore = new RecordedTaskStoreClient(TASKS, PRS);
    const admin = new RecordedAdminMetricsClient(
      CRON_STATS_WITH_PHASE,
      CHAT_STATS,
    );
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({
      kind: "tokensByAgentByCronModel",
      range: RANGE,
    });

    expect(t.results.length).toBe(3);
    const devTaskRow = t.results.find(
      (r) => r[1] === "shipwright-loop" && r[3] === "dev-task",
    );
    const reviewRow = t.results.find(
      (r) => r[1] === "shipwright-loop" && r[3] === "review",
    );
    const legacyRow = t.results.find((r) => r[1] === "patrol");

    expect(devTaskRow).toBeDefined();
    expect(devTaskRow?.[2]).toBe("opus");
    expect(devTaskRow?.[9]).toBe(1.0);

    expect(reviewRow).toBeDefined();
    expect(reviewRow?.[9]).toBe(0.5);

    expect(legacyRow).toBeDefined();
    expect(legacyRow?.[3]).toBeNull();
  });

  test("custom {from,to} range filters out-of-window tasks", async () => {
    const provider = buildProvider();
    // Window covering only July → only PV-9.9 completes
    const t = await provider.query({
      kind: "summary",
      range: { from: "2026-07-01", to: "2026-07-31" },
    });
    const row = t.results[0];
    expect(row[colIndex(t, "tasks_completed")]).toBe(1);
    expect(row[colIndex(t, "tasks_blocked")]).toBe(0);
  });

  test("task with only createdAt (no completedAt/mergedAt/startedAt) anchors on createdAt for window filtering", async () => {
    // A task that was created but never started should still be filterable
    // by its createdAt timestamp, which becomes the anchor point.
    const tasks: TaskRecord[] = [
      {
        id: "ANCHOR-1",
        status: "pending",
        createdAt: "2026-06-05T10:00:00.000Z",
        // No completedAt, mergedAt, or startedAt — only createdAt.
      },
      {
        id: "OUT-OF-WINDOW",
        status: "pending",
        createdAt: "2026-07-05T10:00:00.000Z",
      },
    ];
    const taskStore = new RecordedTaskStoreClient(tasks, []);
    const admin = new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({
      kind: "summary",
      range: { from: "2026-06-01", to: "2026-06-07" },
    });
    // Only ANCHOR-1 should be included because its createdAt is in the window;
    // OUT-OF-WINDOW has createdAt in July, outside the June 1-7 window.
    const row = t.results[0];
    expect(row[colIndex(t, "tasks_blocked")]).toBe(1);
  });

  test("all 17 kinds return a non-throwing MetricTable", async () => {
    const provider = buildProvider();
    const kinds: MetricQuery[] = [
      { kind: "summary", range: RANGE },
      { kind: "summaryCycleTime", range: RANGE },
      { kind: "trends", range: RANGE, groupBy: "day" },
      { kind: "featuresTasks", range: RANGE },
      { kind: "featuresCi", range: RANGE },
      { kind: "featuresReviews", range: RANGE },
      { kind: "queueFunnel", range: RANGE },
      { kind: "queueCycleStarted", range: RANGE },
      { kind: "queueCycleMerged", range: RANGE },
      { kind: "tokensTotals", range: RANGE },
      { kind: "tokensBySessionType", range: RANGE },
      { kind: "tokensByAgent", range: RANGE },
      { kind: "tokensTrends", range: RANGE },
      { kind: "tokensByAgentBySessionType", range: RANGE },
      { kind: "tokensByAgentByCron", range: RANGE },
      { kind: "tokensByAgentByModel", range: RANGE },
      { kind: "tokensByAgentByCronModel", range: RANGE },
    ];
    for (const q of kinds) {
      const t = await provider.query(q);
      expect(Array.isArray(t.columns)).toBe(true);
      expect(t.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(t.results)).toBe(true);
      expect(t.types.length).toBe(t.columns.length);
      expect(t.hasMore).toBe(false);
      expect(t.limit).toBe(100);
      expect(t.offset).toBe(0);
    }
  });

  test("repo-scoped provider counts only the target repo's tasks", async () => {
    // Two repos in the store, both inside the window. A repo-scoped provider
    // must see only its repo's tasks.
    const repoTasks: TaskRecord[] = [
      {
        id: "RA-1.1",
        status: "merged",
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
        ciFixAttempts: 0,
        repo: "org/alpha",
      },
      {
        id: "RB-1.1",
        status: "merged",
        startedAt: "2026-06-03T08:00:00.000Z",
        completedAt: "2026-06-03T12:00:00.000Z",
        mergedAt: "2026-06-03T12:00:00.000Z",
        createdAt: "2026-06-02T08:00:00.000Z",
        ciFixAttempts: 0,
        repo: "org/beta",
      },
    ];
    const repoPrs: PrRecord[] = [
      {
        id: "pr-a",
        taskId: "RA-1.1",
        reviewState: "approved",
        mergedAt: "2026-06-02T12:00:00.000Z",
        repo: "org/alpha",
      },
      {
        id: "pr-b",
        taskId: "RB-1.1",
        reviewState: "approved",
        mergedAt: "2026-06-03T12:00:00.000Z",
        repo: "org/beta",
      },
    ];
    const taskStore = new RecordedTaskStoreClient(repoTasks, repoPrs);
    const admin = new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(
      taskStore,
      admin,
      CLOCK,
      "org/alpha",
    );

    const t = await provider.query({ kind: "summary", range: RANGE });
    const row = t.results[0];
    expect(row[colIndex(t, "tasks_completed")]).toBe(1);
    // Only org/alpha's approved PR counts.
    expect(row[colIndex(t, "reviews_total")]).toBe(1);
    expect(row[colIndex(t, "reviews_ship_it")]).toBe(1);
  });

  test("unscoped provider counts both repos' tasks", async () => {
    const repoTasks: TaskRecord[] = [
      {
        id: "RA-1.1",
        status: "merged",
        startedAt: "2026-06-02T08:00:00.000Z",
        completedAt: "2026-06-02T12:00:00.000Z",
        mergedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T08:00:00.000Z",
        repo: "org/alpha",
      },
      {
        id: "RB-1.1",
        status: "merged",
        startedAt: "2026-06-03T08:00:00.000Z",
        completedAt: "2026-06-03T12:00:00.000Z",
        mergedAt: "2026-06-03T12:00:00.000Z",
        createdAt: "2026-06-02T08:00:00.000Z",
        repo: "org/beta",
      },
    ];
    const taskStore = new RecordedTaskStoreClient(repoTasks, []);
    const admin = new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({ kind: "summary", range: RANGE });
    expect(t.results[0][colIndex(t, "tasks_completed")]).toBe(2);
  });

  test("tokensBySessionType yields a cron row and a chat row", async () => {
    const provider = buildProvider();
    const t = await provider.query({
      kind: "tokensBySessionType",
      range: RANGE,
    });
    expect(t.columns).toEqual([
      "session_type",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
      "cost_usd",
    ]);
    const byType = new Map(t.results.map((r) => [r[0], r]));
    expect(byType.has("cron")).toBe(true);
    expect(byType.has("chat")).toBe(true);
    expect(byType.get("cron")?.[1]).toBe(CRON_STATS.totals.input);
    expect(byType.get("chat")?.[1]).toBe(CHAT_STATS.totals.input);
    expect(byType.get("cron")?.[6]).toBe(CRON_STATS.totals.costUsd ?? 0);
    expect(byType.get("chat")?.[6]).toBe(CHAT_STATS.totals.costUsd ?? 0);
  });

  test("graceful degradation: cronRunTokenStats throws, returns 200 with zero cron + chat data", async () => {
    const taskStore = new RecordedTaskStoreClient(TASKS, PRS);
    const admin = new FaultingCronAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({ kind: "tokensTotals", range: RANGE });
    // Should return 200 (not throw) with only chat data
    expect(t.columns).toEqual([
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
      "cost_usd",
    ]);
    const row = t.results[0];
    // Cron should be zero; chat should still be present
    expect(row[0]).toBe(CHAT_STATS.totals.input);
    expect(row[1]).toBe(CHAT_STATS.totals.output);
  });

  test("graceful degradation: chatTokenStats throws, returns 200 with cron data + zero chat", async () => {
    const taskStore = new RecordedTaskStoreClient(TASKS, PRS);
    const admin = new FaultingChatAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({ kind: "tokensTotals", range: RANGE });
    // Should return 200 (not throw) with only cron data
    expect(t.columns).toEqual([
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
      "cost_usd",
    ]);
    const row = t.results[0];
    // Chat should be zero; cron should still be present
    expect(row[0]).toBe(CRON_STATS.totals.input);
    expect(row[1]).toBe(CRON_STATS.totals.output);
  });

  test("graceful degradation: both throw, returns 200 with all-zero aggregates", async () => {
    const taskStore = new RecordedTaskStoreClient(TASKS, PRS);
    const admin = new FaultingBothAdminMetricsClient();
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const t = await provider.query({ kind: "tokensTotals", range: RANGE });
    // Should return 200 (not throw) with zero aggregates
    expect(t.columns).toEqual([
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
      "cost_usd",
    ]);
    const row = t.results[0];
    // All zeros
    expect(row[0]).toBe(0);
    expect(row[1]).toBe(0);
    expect(row[2]).toBe(0);
    expect(row[3]).toBe(0);
    expect(row[4]).toBe(0);
  });

  test("graceful degradation: all 8 token methods handle cron failure", async () => {
    const taskStore = new RecordedTaskStoreClient(TASKS, PRS);
    const admin = new FaultingCronAdminMetricsClient(CRON_STATS, CHAT_STATS);
    const provider = new TaskStoreProvider(taskStore, admin, CLOCK);

    const kinds: MetricQuery[] = [
      { kind: "tokensTotals", range: RANGE },
      { kind: "tokensBySessionType", range: RANGE },
      { kind: "tokensByAgent", range: RANGE },
      { kind: "tokensTrends", range: RANGE },
      { kind: "tokensByAgentBySessionType", range: RANGE },
      { kind: "tokensByAgentByCron", range: RANGE },
      { kind: "tokensByAgentByModel", range: RANGE },
      { kind: "tokensByAgentByCronModel", range: RANGE },
    ];

    for (const q of kinds) {
      const t = await provider.query(q);
      // Should not throw and should return valid table
      expect(Array.isArray(t.columns)).toBe(true);
      expect(t.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(t.results)).toBe(true);
    }
  });
});
