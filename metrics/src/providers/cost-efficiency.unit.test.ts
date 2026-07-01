/**
 * metrics/src/providers/cost-efficiency.unit.test.ts
 * Unit tests for TaskStoreProvider.costEfficiency() method.
 *
 * Uses an injected RecordedTaskStoreClient double — no real DB, no network.
 * Tests TDD-first: written against the interface before implementation.
 */

import { describe, expect, test } from "bun:test";
import type {
  ChatTokenStats,
  CronRunTokenStats,
} from "../lib/admin-metrics-client.ts";
import type { PrRecord, TaskRecord } from "../lib/task-store-client.ts";
import { FixedClock } from "../lib/test-helpers.ts";
import { TaskStoreProvider } from "./task-store-provider.ts";
import {
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "./task-store-recorded.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

const EMPTY_CRON: CronRunTokenStats = {
  totals: agg(0, 0, 0, 0),
  byAgent: [],
  byCron: [],
  byModel: [],
  daily: [],
};
const EMPTY_CHAT: ChatTokenStats = {
  totals: agg(0, 0, 0, 0),
  byAgent: [],
  byModel: [],
  daily: [],
};

const CLOCK = FixedClock("2026-06-10T12:00:00.000Z");
const RANGE = { from: "2026-06-01", to: "2026-06-07" } as const;

function buildProvider(
  tasks: TaskRecord[],
  prs: PrRecord[] = [],
  repo?: string,
): TaskStoreProvider {
  const taskStore = new RecordedTaskStoreClient(tasks, prs);
  const admin = new RecordedAdminMetricsClient(EMPTY_CRON, EMPTY_CHAT);
  return new TaskStoreProvider(taskStore, admin, CLOCK, repo);
}

function colIndex(table: { columns: string[] }, name: string): number {
  return table.columns.indexOf(name);
}

// ─── Fixture tasks ────────────────────────────────────────────────────────────

/** Tasks spread across model families, inside the June window */
const MIXED_TASKS: TaskRecord[] = [
  // opus short-alias — has costUsd (routed cost wins)
  {
    id: "T-1.1",
    status: "merged",
    repo: "org/main",
    startedAt: "2026-06-02T08:00:00.000Z",
    completedAt: "2026-06-02T12:00:00.000Z",
    mergedAt: "2026-06-02T12:00:00.000Z",
    addedAt: "2026-06-01T08:00:00.000Z",
    model: "opus",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheCreationTokens: 100,
    costUsd: 0.042,
  },
  // claude-opus-4-8 canonical — no costUsd (calculateCost fallback)
  {
    id: "T-1.2",
    status: "done",
    repo: "org/main",
    startedAt: "2026-06-03T09:00:00.000Z",
    completedAt: "2026-06-03T15:00:00.000Z",
    mergedAt: "2026-06-03T15:00:00.000Z",
    addedAt: "2026-06-02T08:00:00.000Z",
    model: "claude-opus-4-8",
    inputTokens: 2000,
    outputTokens: 1000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    // costUsd absent → must fall back to calculateCost
  },
  // sonnet
  {
    id: "T-2.1",
    status: "merged",
    repo: "org/main",
    startedAt: "2026-06-04T08:00:00.000Z",
    completedAt: "2026-06-04T10:00:00.000Z",
    mergedAt: "2026-06-04T10:00:00.000Z",
    addedAt: "2026-06-03T08:00:00.000Z",
    model: "sonnet",
    inputTokens: 500,
    outputTokens: 200,
    cacheReadTokens: 100,
    cacheCreationTokens: 50,
    costUsd: 0.005,
  },
  // haiku
  {
    id: "T-3.1",
    status: "deployed",
    repo: "org/main",
    startedAt: "2026-06-05T08:00:00.000Z",
    completedAt: "2026-06-05T09:00:00.000Z",
    mergedAt: "2026-06-05T09:00:00.000Z",
    addedAt: "2026-06-04T08:00:00.000Z",
    model: "haiku",
    inputTokens: 300,
    outputTokens: 100,
    cacheReadTokens: 50,
    cacheCreationTokens: 25,
    // no costUsd → calculateCost fallback
  },
  // unnormalizable model — must be excluded
  {
    id: "T-4.1",
    status: "merged",
    repo: "org/main",
    startedAt: "2026-06-02T08:00:00.000Z",
    completedAt: "2026-06-02T14:00:00.000Z",
    mergedAt: "2026-06-02T14:00:00.000Z",
    addedAt: "2026-06-01T09:00:00.000Z",
    model: "gpt-4o",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0.01,
  },
  // all-null token counts — must be excluded
  {
    id: "T-5.1",
    status: "merged",
    repo: "org/main",
    startedAt: "2026-06-02T08:00:00.000Z",
    completedAt: "2026-06-02T15:00:00.000Z",
    mergedAt: "2026-06-02T15:00:00.000Z",
    addedAt: "2026-06-01T10:00:00.000Z",
    model: "opus",
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
  },
  // different repo — must be excluded when scoped
  {
    id: "T-6.1",
    status: "merged",
    repo: "org/other",
    startedAt: "2026-06-02T08:00:00.000Z",
    completedAt: "2026-06-02T16:00:00.000Z",
    mergedAt: "2026-06-02T16:00:00.000Z",
    addedAt: "2026-06-01T11:00:00.000Z",
    model: "opus",
    inputTokens: 5000,
    outputTokens: 2000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 1.0,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TaskStoreProvider.costEfficiency()", () => {
  test("returns correct columns", async () => {
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    expect(t.columns).toEqual([
      "tasks_shipped",
      "tasks_with_cost_data",
      "model_family",
      "task_count",
      "routed_usd",
      "opus_usd",
    ]);
  });

  test("buckets tasks into correct model families", async () => {
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const families = t.results.map((r) => r[colIndex(t, "model_family")]);
    expect(families).toContain("claude-opus-4-8");
    expect(families).toContain("claude-sonnet-4-6");
    expect(families).toContain("claude-haiku-4-5");
    // unnormalizable + null-token tasks excluded → only 3 families
    expect(families.length).toBe(3);
  });

  test("opus family has task_count=2 (T-1.1 and T-1.2)", async () => {
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const opusRow = t.results.find(
      (r) => r[colIndex(t, "model_family")] === "claude-opus-4-8",
    );
    expect(opusRow).toBeDefined();
    expect(opusRow?.[colIndex(t, "task_count")]).toBe(2);
  });

  test("uses costUsd when present (T-1.1 routed_usd = 0.042)", async () => {
    // T-1.1 has costUsd=0.042; T-1.2 has no costUsd → calculateCost fallback
    // calculateCost for T-1.2: 2000*5 + 1000*25 + 0*5*1.25 + 0*5*0.1 = 10000+25000 = 35000 / 1e6 = 0.035
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const opusRow = t.results.find(
      (r) => r[colIndex(t, "model_family")] === "claude-opus-4-8",
    );
    const routedUsd = opusRow?.[colIndex(t, "routed_usd")] as number;
    // T-1.1: 0.042, T-1.2 fallback: 0.035 → total ≈ 0.077
    expect(routedUsd).toBeCloseTo(0.077, 5);
  });

  test("opus_usd prices all tasks at OPUS_MODEL rate", async () => {
    // T-1.1 opus: 1000*5 + 500*25 + 100*5*1.25 + 200*5*0.1 = 5000+12500+625+100 = 18225 / 1e6 = 0.018225
    // T-1.2 opus: 2000*5 + 1000*25 + 0 + 0 = 10000+25000 = 35000 / 1e6 = 0.035
    // total opus_usd for opus family ≈ 0.053225
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const opusRow = t.results.find(
      (r) => r[colIndex(t, "model_family")] === "claude-opus-4-8",
    );
    const opusUsd = opusRow?.[colIndex(t, "opus_usd")] as number;
    expect(opusUsd).toBeCloseTo(0.018225 + 0.035, 5);
  });

  test("unnormalizable-model tasks excluded from results", async () => {
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    // No row should reference gpt-4o
    const families = t.results.map((r) => r[colIndex(t, "model_family")]);
    expect(families).not.toContain("gpt-4o");
  });

  test("all-null-token tasks excluded", async () => {
    // T-5.1 has model=opus but all null tokens → excluded
    // opus family should have only T-1.1 and T-1.2 (count=2, not 3)
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const opusRow = t.results.find(
      (r) => r[colIndex(t, "model_family")] === "claude-opus-4-8",
    );
    expect(opusRow?.[colIndex(t, "task_count")]).toBe(2);
  });

  test("repo-scoped provider excludes other-repo tasks", async () => {
    // T-6.1 is repo=org/other with opus model → must be excluded
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const opusRow = t.results.find(
      (r) => r[colIndex(t, "model_family")] === "claude-opus-4-8",
    );
    // If T-6.1 were included, task_count would be 3 (not 2) and routed_usd would include 1.0
    expect(opusRow?.[colIndex(t, "task_count")]).toBe(2);
    const routedUsd = opusRow?.[colIndex(t, "routed_usd")] as number;
    expect(routedUsd).toBeLessThan(1.0);
  });

  test("tasks_shipped and tasks_with_cost_data broadcast on every row", async () => {
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    // All rows must have the same tasks_shipped value
    const shipped = t.results.map((r) => r[colIndex(t, "tasks_shipped")]);
    const costData = t.results.map((r) =>
      r[colIndex(t, "tasks_with_cost_data")],
    );
    expect(new Set(shipped).size).toBe(1);
    expect(new Set(costData).size).toBe(1);

    // 4 eligible costed tasks (T-1.1, T-1.2, T-2.1, T-3.1) in org/main in window
    // total tasks with cost data = 4 (those with normalizable model AND at least one token count non-null)
    expect(costData[0]).toBe(4);
  });

  test("unscoped provider includes all repos", async () => {
    const provider = buildProvider(MIXED_TASKS);
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    // T-6.1 (org/other, opus) should now be included → opus count = 3
    const opusRow = t.results.find(
      (r) => r[colIndex(t, "model_family")] === "claude-opus-4-8",
    );
    expect(opusRow?.[colIndex(t, "task_count")]).toBe(3);
  });

  test("haiku family uses calculateCost fallback (no costUsd)", async () => {
    // T-3.1: haiku, 300 input, 100 output, 50 cacheRead, 25 cacheCreation, no costUsd
    // calculateCost for haiku (claude-haiku-4-5): rates = {input:1.0, output:5.0}
    // routed_usd = 300*1.0 + 100*5.0 + 25*1.0*1.25 + 50*1.0*0.1 = 300+500+31.25+5 = 836.25 / 1e6 = 0.00083625
    const provider = buildProvider(MIXED_TASKS, [], "org/main");
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    const haikuRow = t.results.find(
      (r) => r[colIndex(t, "model_family")] === "claude-haiku-4-5",
    );
    expect(haikuRow).toBeDefined();
    const routedUsd = haikuRow?.[colIndex(t, "routed_usd")] as number;
    expect(routedUsd).toBeCloseTo(0.00083625, 7);
  });

  test("empty result when no eligible tasks in window", async () => {
    const provider = buildProvider([]);
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });
    expect(t.results).toEqual([]);
  });
});
