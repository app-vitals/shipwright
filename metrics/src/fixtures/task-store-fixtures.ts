/**
 * metrics/src/fixtures/task-store-fixtures.ts
 * Offline fixture MetricsProvider for offline/dev mode.
 *
 * Builds a TaskStoreProvider from the Recorded test doubles
 * (RecordedTaskStoreClient + RecordedAdminMetricsClient) wrapped around canned
 * cassette data and a clock anchored to call time, so METRICS_OFFLINE=true works
 * with zero live services. This replaces the PostHog fixture path
 * (posthog-fixtures.ts) for offline mode — the dashboard now renders
 * task-store-derived metrics offline.
 *
 * All cassette dates are expressed as offsets from `now` (computed once per
 * createFixtureTaskStoreProvider() call) so the 7d/30d presets always yield
 * non-empty trends regardless of when the stack is launched. No manual
 * date-rolling is required.
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

/**
 * Build an offline TaskStoreProvider over the recorded cassettes with a clock
 * anchored to call time. Always yields non-empty KPI data for the 7d/30d
 * presets regardless of when the stack is launched — no manual date-rolling
 * required.
 */
export function createFixtureTaskStoreProvider(): MetricsProvider {
  const now = new Date();
  const clock: Clock = { now: () => now };

  // ISO timestamp N whole days + H hours before now.
  const d = (offsetDays: number, offsetHours = 0): string =>
    new Date(
      now.getTime() - (offsetDays * 24 + offsetHours) * 60 * 60 * 1000,
    ).toISOString();

  // YYYY-MM-DD date string N days before now (for daily period keys).
  const ds = (offsetDays: number): string => d(offsetDays).slice(0, 10);

  // ─── Task cassette ────────────────────────────────────────────────────────────
  // Tasks land 1–2 days ago so they always fall inside the 7d/30d windows.

  const TASKS: TaskRecord[] = [
    {
      id: "QS-1.1",
      status: "merged",
      session: "cron",
      hours: 5,
      complexity: 3,
      startedAt: d(2, 4),
      completedAt: d(2),
      mergedAt: d(2),
      prCreatedAt: d(2, 1),
      ciFixAttempts: 0,
      simplifyTotal: 2,
      addedAt: d(3, 4),
      model: "claude-opus-4-8",
      effortLevel: "medium",
      coverageDelta: 5,
      simplifyDry: 1,
      simplifyDeadCode: 0,
      simplifyNaming: 1,
      simplifyComplexity: 0,
      simplifyConsistency: 0,
    },
    {
      id: "QS-1.2",
      status: "done",
      session: "cron",
      hours: 3,
      complexity: 2,
      startedAt: d(1, 3),
      completedAt: d(1, 1),
      mergedAt: d(1, 1),
      prCreatedAt: d(1, 2),
      ciFixAttempts: 2,
      simplifyTotal: 1,
      addedAt: d(2, 4),
      model: "sonnet",
      effortLevel: "low",
      coverageDelta: 3,
      simplifyDry: 0,
      simplifyDeadCode: 1,
      simplifyNaming: 0,
      simplifyComplexity: 0,
      simplifyConsistency: 0,
    },
    {
      id: "MQ-2.1",
      status: "merged",
      session: "cron",
      hours: 8,
      complexity: 4,
      startedAt: d(2, 2),
      completedAt: d(1, 2),
      mergedAt: d(1, 2),
      prCreatedAt: d(1, 3),
      ciFixAttempts: 1,
      simplifyTotal: 3,
      addedAt: d(3, 2),
      model: "haiku",
      effortLevel: "high",
      coverageDelta: 8,
      simplifyDry: 1,
      simplifyDeadCode: 1,
      simplifyNaming: 1,
      simplifyComplexity: 0,
      simplifyConsistency: 0,
    },
    {
      id: "MQ-2.2",
      status: "blocked",
      session: "chat",
      hours: 4,
      complexity: 5,
      startedAt: d(1, 4),
      addedAt: d(2, 5),
    },
  ];

  // ─── PR cassette ──────────────────────────────────────────────────────────────

  const PRS: PrRecord[] = [
    {
      id: "pr-1",
      taskId: "QS-1.1",
      reviewState: "approved",
      createdAt: d(2, 1),
      mergedAt: d(2),
    },
    {
      id: "pr-2",
      taskId: "QS-1.2",
      reviewState: "posted",
      createdAt: d(1, 2),
      mergedAt: d(1, 1),
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
      { period: ds(2), ...agg(600, 300, 120, 60, 0.9) },
      { period: ds(1), ...agg(400, 200, 80, 40, 0.6) },
    ],
  };

  const CHAT_STATS: ChatTokenStats = {
    totals: agg(400, 200, 80, 40, 0.6),
    byAgent: [{ key: "agent-a", ...agg(400, 200, 80, 40, 0.6) }],
    byModel: [{ key1: "agent-a", key2: "claude-sonnet-4-5", ...agg(400, 200, 80, 40, 0.6) }],
    daily: [{ period: ds(1), ...agg(400, 200, 80, 40, 0.6) }],
  };

  return new TaskStoreProvider(
    new RecordedTaskStoreClient(TASKS, PRS),
    new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS),
    clock,
  );
}
