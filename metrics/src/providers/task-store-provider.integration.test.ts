/**
 * metrics/src/providers/task-store-provider.integration.test.ts
 * Integration: drive TaskStoreProvider over Recorded task-store + admin doubles
 * with a FixedClock, asserting it emits sql-provider-identical MetricTables for
 * the headline kinds, that token totals = cron + chat (no double-counting), that
 * a custom {from,to} range filters cassette rows, and that all 16 kinds return a
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
    addedAt: "2026-06-01T08:00:00.000Z",
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
    addedAt: "2026-06-02T08:00:00.000Z",
  },
  {
    id: "MQ-2.1",
    status: "blocked",
    session: "chat",
    hours: 4,
    complexity: 5,
    startedAt: "2026-06-04T08:00:00.000Z",
    addedAt: "2026-06-04T07:00:00.000Z",
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
    addedAt: "2026-07-09T08:00:00.000Z",
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
    { key1: "agent-a", key2: "ship-loop", ...agg(700, 350, 140, 70, 1.0) },
    { key1: "agent-a", key2: "patrol", ...agg(300, 150, 60, 30, 0.5) },
  ],
  byModel: [
    { key1: "agent-a", key2: "opus", ...agg(1000, 500, 200, 100, 1.5) },
  ],
  daily: [{ period: "2026-06-02", ...agg(1000, 500, 200, 100, 1.5) }],
  byCronModel: [],
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
    // avg_review_iterations = avg(reviewCycles + patchCycles) = avg(2, 3) = 2.5
    expect(row[colIndex(t, "avg_review_iterations")]).toBe(2.5);
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

  test("tokensByAgentByCron is cron-only with cost_usd", async () => {
    const provider = buildProvider();
    const t = await provider.query({
      kind: "tokensByAgentByCron",
      range: RANGE,
    });
    expect(t.columns).toEqual([
      "agent_id",
      "cron_name",
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
    expect(t.results[0][7]).toBe(1.0);
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

  test("all 16 kinds return a non-throwing MetricTable", async () => {
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
        addedAt: "2026-06-01T08:00:00.000Z",
        ciFixAttempts: 0,
        repo: "org/alpha",
      },
      {
        id: "RB-1.1",
        status: "merged",
        startedAt: "2026-06-03T08:00:00.000Z",
        completedAt: "2026-06-03T12:00:00.000Z",
        mergedAt: "2026-06-03T12:00:00.000Z",
        addedAt: "2026-06-02T08:00:00.000Z",
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
        addedAt: "2026-06-01T08:00:00.000Z",
        repo: "org/alpha",
      },
      {
        id: "RB-1.1",
        status: "merged",
        startedAt: "2026-06-03T08:00:00.000Z",
        completedAt: "2026-06-03T12:00:00.000Z",
        mergedAt: "2026-06-03T12:00:00.000Z",
        addedAt: "2026-06-02T08:00:00.000Z",
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

  test("graceful degradation: all 7 token methods handle cron failure", async () => {
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
