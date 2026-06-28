/**
 * metrics/src/fixtures/task-store-fixtures.ts
 * Offline fixture MetricsProvider for offline/dev mode.
 *
 * Builds a TaskStoreProvider from the Recorded test doubles
 * (RecordedTaskStoreClient + RecordedAdminMetricsClient) wrapped around canned
 * cassette data and a FIXED clock, so METRICS_OFFLINE=true works with zero live
 * services. This replaces the PostHog fixture path (posthog-fixtures.ts) for
 * offline mode — the dashboard now renders task-store-derived metrics offline.
 *
 * The cassette dates are anchored two days before FIXED_NOW so the 7d/30d
 * presets (resolved against FIXED_NOW) always yield non-empty trends/features.
 * No test-helpers are imported here — this is a production module, so the clock
 * is defined inline.
 *
 * Usage:
 *   import { createFixtureTaskStoreProvider } from './fixtures/task-store-fixtures.ts';
 *   const app = createMetricsApp(apiKeys, accountsClient, {
 *     provider: createFixtureTaskStoreProvider(),
 *     offlineMode: true,
 *   });
 */

import type {
  ChatTokenStats,
  CronRunTokenStats,
} from "../lib/admin-metrics-client.ts";
import type { Clock } from "../lib/clock.ts";
import type { PrRecord, TaskRecord } from "../lib/task-store-client.ts";
import type { MetricsProvider } from "../metrics-provider.ts";
import { TaskStoreProvider } from "../providers/task-store-provider.ts";
import {
  RecordedAdminMetricsClient,
  RecordedTaskStoreClient,
} from "../providers/task-store-recorded.ts";

// Fixed "now" so offline output is deterministic and independent of wall-clock.
const FIXED_NOW = "2026-06-10T12:00:00.000Z";
const fixedClock: Clock = { now: () => new Date(FIXED_NOW) };

// ─── Task cassette ────────────────────────────────────────────────────────────
// Dates land on 2026-06-08 / 2026-06-09 — within the 7d/30d windows resolved
// against FIXED_NOW (2026-06-10).

const TASKS: TaskRecord[] = [
  {
    id: "QS-1.1",
    status: "merged",
    session: "cron",
    hours: 5,
    complexity: 3,
    startedAt: "2026-06-08T08:00:00.000Z",
    completedAt: "2026-06-08T12:00:00.000Z",
    mergedAt: "2026-06-08T12:00:00.000Z",
    prCreatedAt: "2026-06-08T11:00:00.000Z",
    ciFixAttempts: 0,
    simplifyTotal: 2,
    addedAt: "2026-06-07T08:00:00.000Z",
  },
  {
    id: "QS-1.2",
    status: "done",
    session: "cron",
    hours: 3,
    complexity: 2,
    startedAt: "2026-06-09T09:00:00.000Z",
    completedAt: "2026-06-09T15:00:00.000Z",
    mergedAt: "2026-06-09T15:00:00.000Z",
    prCreatedAt: "2026-06-09T14:00:00.000Z",
    ciFixAttempts: 2,
    simplifyTotal: 1,
    addedAt: "2026-06-08T08:00:00.000Z",
  },
  {
    id: "MQ-2.1",
    status: "merged",
    session: "cron",
    hours: 8,
    complexity: 4,
    startedAt: "2026-06-08T10:00:00.000Z",
    completedAt: "2026-06-09T10:00:00.000Z",
    mergedAt: "2026-06-09T10:00:00.000Z",
    prCreatedAt: "2026-06-09T09:00:00.000Z",
    ciFixAttempts: 1,
    simplifyTotal: 3,
    addedAt: "2026-06-07T10:00:00.000Z",
  },
  {
    id: "MQ-2.2",
    status: "blocked",
    session: "chat",
    hours: 4,
    complexity: 5,
    startedAt: "2026-06-09T08:00:00.000Z",
    addedAt: "2026-06-08T07:00:00.000Z",
  },
];

// ─── PR cassette ──────────────────────────────────────────────────────────────

const PRS: PrRecord[] = [
  {
    id: "pr-1",
    taskId: "QS-1.1",
    reviewState: "approved",
    createdAt: "2026-06-08T11:00:00.000Z",
    mergedAt: "2026-06-08T12:00:00.000Z",
  },
  {
    id: "pr-2",
    taskId: "QS-1.2",
    reviewState: "posted",
    createdAt: "2026-06-09T14:00:00.000Z",
    mergedAt: "2026-06-09T15:00:00.000Z",
  },
];

// ─── Token cassettes ──────────────────────────────────────────────────────────
// Mirrors the agg() helper pattern from task-store-provider.integration.test.ts.

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
  daily: [
    { period: "2026-06-08", ...agg(600, 300, 120, 60, 0.9) },
    { period: "2026-06-09", ...agg(400, 200, 80, 40, 0.6) },
  ],
};

const CHAT_STATS: ChatTokenStats = {
  totals: agg(400, 200, 80, 40, 0.6),
  byAgent: [{ key: "agent-a", ...agg(400, 200, 80, 40, 0.6) }],
  daily: [{ period: "2026-06-09", ...agg(400, 200, 80, 40, 0.6) }],
};

/**
 * Build an offline TaskStoreProvider over the recorded cassettes with a fixed
 * clock. Deterministic and dependency-free.
 */
export function createFixtureTaskStoreProvider(): MetricsProvider {
  return new TaskStoreProvider(
    new RecordedTaskStoreClient(TASKS, PRS),
    new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS),
    fixedClock,
  );
}
