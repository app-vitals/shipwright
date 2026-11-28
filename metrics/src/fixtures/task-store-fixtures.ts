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
import type {
  CoverageSnapshotRecord,
  PrRecord,
  ReadinessSummaryRecord,
  SystemCronRecord,
  TaskRecord,
} from "../lib/task-store-client.ts";
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
 *
 * @param repo - optional `org/repo` scope, forwarded to TaskStoreProvider.
 *   Only the PR cassette carries repo/origin attribution (org/alpha,
 *   org/beta), so this is meant for scoping the merged-PRs-by-repo query in
 *   a repo-scoped (public-mode-style) preview/test — task-derived metrics
 *   have no repo field and would come back empty if scoped.
 */
export function createFixtureTaskStoreProvider(repo?: string): MetricsProvider {
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
      createdAt: d(3, 4),
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
      createdAt: d(2, 4),
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
      createdAt: d(3, 2),
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
      createdAt: d(2, 5),
    },
  ];

  // ─── PR cassette ──────────────────────────────────────────────────────────────

  const PRS: PrRecord[] = [
    {
      id: "pr-1",
      reviewState: "approved",
      createdAt: d(2, 1),
      mergedAt: d(2),
      // repo/origin/state (POM-2.1/POM-2.2): drives the merged-PRs-by-repo
      // dashboard panel — two repos, one merged PR each, distinct origins.
      repo: "org/alpha",
      origin: "shipwright",
      state: "merged",
    },
    {
      id: "pr-2",
      reviewState: "posted",
      createdAt: d(1, 2),
      mergedAt: d(1, 1),
      repo: "org/beta",
      origin: "ci",
      state: "merged",
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

  const CHAT_STATS: ChatTokenStats = {
    totals: agg(400, 200, 80, 40, 0.6),
    byAgent: [{ key: "agent-a", ...agg(400, 200, 80, 40, 0.6) }],
    byModel: [
      {
        key1: "agent-a",
        key2: "claude-sonnet-4-5",
        ...agg(400, 200, 80, 40, 0.6),
      },
    ],
    daily: [{ period: ds(1), ...agg(400, 200, 80, 40, 0.6) }],
  };

  // ─── Coverage cassette (CVT-3.1) ────────────────────────────────────────────
  // org/alpha has two snapshots (delta +1.5), org/beta a single stale one
  // (delta null, > 14 days old).

  const COVERAGE: CoverageSnapshotRecord[] = [
    {
      repo: "org/alpha",
      commitSha: "a1b2c3d4e5f6",
      linesPct: 81,
      branchesPct: 74,
      functionsPct: 88,
      measuredAt: d(5),
    },
    {
      repo: "org/alpha",
      commitSha: "f6e5d4c3b2a1",
      linesPct: 82.5,
      branchesPct: 75.5,
      functionsPct: 90,
      measuredAt: d(1),
    },
    {
      repo: "org/beta",
      commitSha: "0a1b2c3d4e5f",
      linesPct: 64,
      branchesPct: null,
      functionsPct: null,
      measuredAt: d(20),
    },
  ];

  // ─── System-cron cassette (SCM-8.4) ─────────────────────────────────────────
  // One registered cron with a shipped, a stuck (blocked), a cancelled and a
  // no-op SC- task, plus one shipped follow-on. Served only to listCronTasks.

  const SYSTEM_CRONS: SystemCronRecord[] = [
    {
      id: "test-readiness",
      accountId: "default",
      name: "Test readiness",
      schedule: "0 7 * * *",
      enabled: true,
    },
  ];
  const cronTask = (
    suffix: string,
    status: string,
    extra: Partial<TaskRecord> = {},
  ): TaskRecord =>
    ({
      id: `SC-test-readiness-20260101T070000Z-${suffix}`,
      status,
      source: "system-cron",
      originKind: "cron",
      originRef: "test-readiness",
      repo: "org/alpha",
      createdAt: d(0, 2),
      ...extra,
    }) as TaskRecord;
  const CRON_TASKS: TaskRecord[] = [
    cronTask("a", "merged"),
    cronTask("b", "blocked"),
    cronTask("c", "cancelled"),
    cronTask("d", "done", { pr: null }),
    cronTask("e", "pending", { source: "plan", id: "FO-1", repo: "org/beta" }),
    cronTask("f", "merged", { source: "plan", id: "FO-2", repo: "org/beta" }),
  ];

  // ─── Readiness cassette (RDY-5.1) ───────────────────────────────────────────
  // Two fresh repos (one Level 4, one Level 2 with a running and a
  // not-running owner) and one stale repo; a 12-week trend rising 0 → 50%.

  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const READINESS: ReadinessSummaryRecord = {
    percentAtOrAboveFloor: 50,
    repoCount: 2,
    staleCount: 1,
    levelDistribution: { "0": 0, "1": 0, "2": 1, "3": 0, "4": 1, "5": 0 },
    repos: [
      {
        repo: "org/alpha",
        level: 4,
        failingChecks: [],
        scoredAt: d(1),
        stale: false,
      },
      {
        repo: "org/beta",
        level: 2,
        failingChecks: [
          {
            id: "preview-env",
            level: 3,
            owner: "environments-scan",
            ownerRunning: false,
          },
          {
            id: "lockfile",
            level: 2,
            owner: "test-readiness",
            ownerRunning: true,
          },
        ],
        scoredAt: d(2),
        stale: false,
      },
      {
        repo: "org/gamma",
        level: 1,
        failingChecks: [
          {
            id: "ci-required",
            level: 2,
            owner: "operator",
            ownerRunning: true,
          },
        ],
        scoredAt: d(30),
        stale: true,
      },
    ],
    trend: Array.from({ length: 12 }, (_, i) => {
      const weekEnd = now.getTime() - (11 - i) * WEEK_MS;
      return {
        weekStart: new Date(weekEnd - WEEK_MS).toISOString(),
        weekEnd: new Date(weekEnd).toISOString(),
        percentAtOrAboveFloor: i < 4 ? null : i < 8 ? 0 : 50,
        repoCount: i < 4 ? 0 : 2,
      };
    }),
  };

  return new TaskStoreProvider(
    new RecordedTaskStoreClient(
      TASKS,
      PRS,
      COVERAGE,
      SYSTEM_CRONS,
      CRON_TASKS,
      READINESS,
    ),
    new RecordedAdminMetricsClient(CRON_STATS, CHAT_STATS),
    clock,
    repo,
  );
}
