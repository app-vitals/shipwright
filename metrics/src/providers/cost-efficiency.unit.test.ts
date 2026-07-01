/**
 * metrics/src/providers/cost-efficiency.unit.test.ts
 * Unit tests for TaskStoreProvider.costEfficiency() stub.
 *
 * costEfficiency() is stubbed pending PCE-1.5 (run-level cost data). These
 * tests verify the stable column contract and the empty-results guarantee.
 */

import { describe, expect, test } from "bun:test";
import type {
  ChatTokenStats,
  CronRunTokenStats,
} from "../lib/admin-metrics-client.ts";
import type { TaskRecord } from "../lib/task-store-client.ts";
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
  daily: [],
};

const CLOCK = FixedClock("2026-06-10T12:00:00.000Z");
const RANGE = { from: "2026-06-01", to: "2026-06-07" } as const;

function buildProvider(tasks: TaskRecord[] = []): TaskStoreProvider {
  const taskStore = new RecordedTaskStoreClient(tasks, []);
  const admin = new RecordedAdminMetricsClient(EMPTY_CRON, EMPTY_CHAT);
  return new TaskStoreProvider(taskStore, admin, CLOCK);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("TaskStoreProvider.costEfficiency() (stub)", () => {
  test("returns correct column schema", async () => {
    const provider = buildProvider();
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

  test("always returns empty results", async () => {
    const provider = buildProvider([
      {
        id: "T-1",
        status: "merged",
        model: "opus",
        mergedAt: "2026-06-02T12:00:00.000Z",
        addedAt: "2026-06-01T08:00:00.000Z",
      },
    ]);
    const t = await provider.query({ kind: "costEfficiency", range: RANGE });

    expect(t.results).toEqual([]);
  });
});
