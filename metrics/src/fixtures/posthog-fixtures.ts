/**
 * metrics/src/fixtures/posthog-fixtures.ts
 * Fixture PostHog client for offline/dev mode.
 *
 * Returns pre-recorded sample HogQLResult for every dashboard query type.
 * Pattern-matches on hogql strings to route to the correct fixture.
 * Falls back to a zero-row generic result for unknown queries.
 *
 * Usage:
 *   import { createFixturePostHogClient } from './fixtures/posthog-fixtures.ts';
 *   const app = createMetricsApp(apiKeys, accountsClient, {
 *     postHogClient: createFixturePostHogClient(),
 *     offlineMode: true,
 *   });
 */

import type { PostHogClientLike } from "../api.ts";
import type { HogQLResult } from "../types.ts";

function makeResult(columns: string[], rows: unknown[][]): HogQLResult {
  return {
    columns,
    results: rows,
    types: columns.map(() => "String"),
    hasMore: false,
    limit: 100,
    offset: 0,
  };
}

// ─── Summary fixture ─────────────────────────────────────────────────────────

const SUMMARY_COLUMNS = [
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
  "complexity_1",
  "complexity_2",
  "complexity_3",
  "complexity_4",
  "complexity_5",
  "avg_fix_cascade_depth",
];

const SUMMARY_FIXTURE = makeResult(SUMMARY_COLUMNS, [
  [
    // tasks_completed, tasks_blocked
    24, 2,
    // avg_actual_hours, avg_estimated_hours
    3.2, 3.5,
    // avg_retries, avg_files_changed
    1.1, 6.0,
    // ci_gates_total, ci_first_pass
    18, 14,
    // avg_fix_attempts
    0.4,
    // simplify_total, simplify_total_fixes
    8, 22,
    // simplify_avg_dry, simplify_avg_dead_code, simplify_avg_naming, simplify_avg_complexity, simplify_avg_consistency
    2.5,
    1.8, 1.2, 0.6, 0.9,
    // reviews_total, reviews_ship_it
    12, 10,
    // complexity_1, 2, 3, 4, 5
    4, 8, 7, 4, 1,
    // avg_fix_cascade_depth
    1.3,
  ],
]);

// ─── Cycle time fixture ────────────────────────────────────────────────────

const CYCLE_TIME_FIXTURE = makeResult(["avg_cycle_time_hours"], [[4.8]]);

// ─── Trends fixture ───────────────────────────────────────────────────────────

const TRENDS_COLUMNS = [
  "period",
  "tasks_completed",
  "ci_gates",
  "ci_first_pass",
  "ci_first_pass_count",
  "simplify_passes",
  "simplify_fixes",
  "tasks_blocked",
  "reviews",
  "tasks_started",
  "reviews_ship_it",
  "avg_actual_hours",
  "avg_estimated_hours",
  "avg_retries",
  "avg_files_changed",
  "avg_fix_attempts",
  "avg_cycle_time_hours",
  "estimation_accuracy",
  "simplify_avg_dry",
  "simplify_avg_dead_code",
  "simplify_avg_naming",
  "simplify_avg_complexity",
  "simplify_avg_consistency",
  "avg_review_findings",
];

const TRENDS_FIXTURE = makeResult(TRENDS_COLUMNS, [
  [
    "2026-06-01",
    3,
    4,
    3,
    2,
    1,
    5,
    0,
    2,
    4,
    2,
    3.1,
    3.5,
    1.0,
    6.0,
    0.3,
    4.5,
    0.89,
    2.2,
    1.5,
    1.0,
    0.5,
    0.8,
    1.8,
  ],
  [
    "2026-06-02",
    4,
    5,
    4,
    3,
    2,
    7,
    1,
    3,
    5,
    2,
    3.4,
    3.5,
    1.2,
    5.5,
    0.5,
    5.0,
    0.97,
    2.8,
    2.0,
    1.3,
    0.7,
    1.1,
    2.0,
  ],
  [
    "2026-06-03",
    2,
    3,
    2,
    1,
    0,
    0,
    0,
    1,
    3,
    1,
    2.9,
    3.0,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ],
  [
    "2026-06-04",
    5,
    6,
    5,
    4,
    3,
    10,
    1,
    4,
    6,
    3,
    3.6,
    3.8,
    0.8,
    7.0,
    0.2,
    5.2,
    0.95,
    3.1,
    2.2,
    1.5,
    0.9,
    1.2,
    1.5,
  ],
  [
    "2026-06-05",
    4,
    4,
    4,
    3,
    2,
    8,
    0,
    2,
    5,
    2,
    3.0,
    3.2,
    1.0,
    5.0,
    0.4,
    4.8,
    0.94,
    2.5,
    1.8,
    1.1,
    0.6,
    0.9,
    2.2,
  ],
  [
    "2026-06-06",
    3,
    5,
    3,
    2,
    1,
    3,
    0,
    3,
    4,
    3,
    3.3,
    3.5,
    1.1,
    6.5,
    0.5,
    5.5,
    0.94,
    2.0,
    1.6,
    1.2,
    0.8,
    1.0,
    1.9,
  ],
  [
    "2026-06-07",
    3,
    4,
    3,
    2,
    1,
    4,
    0,
    2,
    4,
    2,
    3.2,
    3.4,
    1.0,
    6.0,
    0.4,
    4.9,
    0.94,
    2.3,
    1.7,
    1.1,
    0.7,
    0.9,
    2.1,
  ],
]);

// ─── Features tasks fixture ───────────────────────────────────────────────────

const FEATURES_TASKS_COLUMNS = [
  "feature_prefix",
  "tasks_completed",
  "avg_actual_h",
  "avg_estimated_h",
];

const FEATURES_TASKS_FIXTURE = makeResult(FEATURES_TASKS_COLUMNS, [
  ["QS", 8, 3.2, 3.5],
  ["MQ", 6, 2.8, 3.0],
  ["DR", 4, 4.1, 4.0],
  ["UE", 3, 2.5, 2.5],
  ["SM", 3, 3.8, 4.0],
]);

// ─── Features CI fixture ──────────────────────────────────────────────────────

const FEATURES_CI_COLUMNS = ["feature_prefix", "ci_total", "ci_first_pass"];

const FEATURES_CI_FIXTURE = makeResult(FEATURES_CI_COLUMNS, [
  ["QS", 16, 13],
  ["MQ", 12, 10],
  ["DR", 8, 6],
  ["UE", 6, 5],
  ["SM", 6, 5],
]);

// ─── Features reviews fixture ─────────────────────────────────────────────────

const FEATURES_REVIEWS_COLUMNS = [
  "feature_prefix",
  "reviews_total",
  "reviews_ship_it",
];

const FEATURES_REVIEWS_FIXTURE = makeResult(FEATURES_REVIEWS_COLUMNS, [
  ["QS", 8, 7],
  ["MQ", 6, 5],
  ["DR", 4, 3],
  ["UE", 3, 3],
  ["SM", 3, 2],
]);

// ─── Queue funnel fixture ─────────────────────────────────────────────────────

const QUEUE_FUNNEL_COLUMNS = [
  "tasks_started",
  "tasks_approved",
  "tasks_merged",
  "tasks_blocked",
  "avg_review_findings",
];

const QUEUE_FUNNEL_FIXTURE = makeResult(QUEUE_FUNNEL_COLUMNS, [
  [28, 24, 24, 2, 1.8],
]);

// ─── Queue cycle fixtures ─────────────────────────────────────────────────────

const QUEUE_CYCLE_COLUMNS = ["task_id", "timestamp"];

const QUEUE_CYCLE_STARTED_FIXTURE = makeResult(QUEUE_CYCLE_COLUMNS, [
  ["QS-1.1", "2026-06-01T09:00:00.000Z"],
  ["QS-1.2", "2026-06-02T10:00:00.000Z"],
  ["MQ-2.1", "2026-06-03T08:30:00.000Z"],
  ["DR-1.1", "2026-06-04T11:00:00.000Z"],
]);

const QUEUE_CYCLE_MERGED_FIXTURE = makeResult(QUEUE_CYCLE_COLUMNS, [
  ["QS-1.1", "2026-06-02T14:00:00.000Z"],
  ["QS-1.2", "2026-06-03T16:00:00.000Z"],
  ["MQ-2.1", "2026-06-04T17:00:00.000Z"],
  ["DR-1.1", "2026-06-06T10:00:00.000Z"],
]);

// ─── Tokens fixtures ──────────────────────────────────────────────────────────

const TOKENS_TOTALS_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
];

const TOKENS_TOTALS_FIXTURE = makeResult(TOKENS_TOTALS_COLUMNS, [
  [842000, 210000, 380000, 95000, 1527000],
]);

const TOKENS_BY_SESSION_TYPE_COLUMNS = [
  "session_type",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
];

const TOKENS_BY_SESSION_TYPE_FIXTURE = makeResult(
  TOKENS_BY_SESSION_TYPE_COLUMNS,
  [
    ["cron", 420000, 105000, 190000, 48000, 763000],
    ["slack_dm", 280000, 70000, 126000, 32000, 508000],
    ["slack_mention", 142000, 35000, 64000, 15000, 256000],
  ],
);

const TOKENS_BY_AGENT_COLUMNS = [
  "agent_id",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
];

const TOKENS_BY_AGENT_FIXTURE = makeResult(TOKENS_BY_AGENT_COLUMNS, [
  ["agent-shipwright", 500000, 125000, 225000, 57000, 907000],
  ["agent-dev", 342000, 85000, 155000, 38000, 620000],
]);

const TOKENS_TRENDS_COLUMNS = [
  "period",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
];

const TOKENS_TRENDS_FIXTURE = makeResult(TOKENS_TRENDS_COLUMNS, [
  ["2026-06-01", 120000, 30000, 54000, 14000, 218000],
  ["2026-06-02", 130000, 32000, 58000, 15000, 235000],
  ["2026-06-03", 112000, 28000, 50000, 13000, 203000],
  ["2026-06-04", 140000, 35000, 63000, 16000, 254000],
  ["2026-06-05", 125000, 31000, 56000, 14000, 226000],
  ["2026-06-06", 108000, 27000, 48000, 12000, 195000],
  ["2026-06-07", 107000, 27000, 51000, 11000, 196000],
]);

// ─── Generic fallback ─────────────────────────────────────────────────────────

const GENERIC_FALLBACK = makeResult([], []);

// ─── Query pattern detection ─────────────────────────────────────────────────

function detectQueryType(hogql: string): keyof typeof FIXTURES | "generic" {
  // Summary cycle time: single column avg, completion events with started_at/ts dateDiff
  if (
    hogql.includes("avg_cycle_time_hours") &&
    hogql.includes("started_at") &&
    !hogql.includes("tasks_completed") &&
    !hogql.includes("GROUP BY period")
  ) {
    return "summaryCycleTime";
  }
  // Summary: aggregates over all event types (simplify_total is unique to summary)
  if (hogql.includes("simplify_total") && !hogql.includes("GROUP BY period")) {
    return "summary";
  }
  // Trends: time-series with GROUP BY period and pipeline columns
  if (hogql.includes("GROUP BY period") && hogql.includes("ci_gates")) {
    return "trends";
  }
  // Queue funnel: aggregates over tasks_started/approved/merged in a single query
  if (
    hogql.includes("tasks_started") &&
    hogql.includes("tasks_approved") &&
    hogql.includes("tasks_merged")
  ) {
    return "queueFunnel";
  }
  // Queue cycle started: WHERE clause targets only shipwright_task_started
  if (
    hogql.includes("event = 'shipwright_task_started'") &&
    hogql.includes("task_id") &&
    hogql.includes("timestamp")
  ) {
    return "queueCycleStarted";
  }
  // Features tasks: SELECT feature_prefix, tasks_completed, avg_actual_h
  // Must check before queueCycleMerged since both target completion events
  if (
    hogql.includes("GROUP BY feature_prefix") &&
    hogql.includes("avg_actual_h")
  ) {
    return "featuresTasks";
  }
  // Features CI: per-prefix CI first pass
  if (
    hogql.includes("GROUP BY feature_prefix") &&
    hogql.includes("ci_first_pass") &&
    hogql.includes("ci_total")
  ) {
    return "featuresCi";
  }
  // Features reviews: per-prefix reviews
  if (
    hogql.includes("GROUP BY feature_prefix") &&
    hogql.includes("reviews_ship_it")
  ) {
    return "featuresReviews";
  }
  // Queue cycle merged: completion events with task_id + timestamp (no GROUP BY feature_prefix)
  if (
    hogql.includes("task_id") &&
    hogql.includes("timestamp") &&
    !hogql.includes("GROUP BY feature_prefix") &&
    !hogql.includes("GROUP BY period") &&
    !hogql.includes("tasks_approved")
  ) {
    return "queueCycleMerged";
  }
  // Tokens totals: aggregate sums, agent_token_usage, no GROUP BY
  if (
    hogql.includes("agent_token_usage") &&
    hogql.includes("total_tokens") &&
    !hogql.includes("GROUP BY")
  ) {
    return "tokensTotals";
  }
  // Tokens by session type: GROUP BY session_type
  if (
    hogql.includes("session_type") &&
    hogql.includes("GROUP BY session_type")
  ) {
    return "tokensBySessionType";
  }
  // Tokens by agent: GROUP BY agent_id
  if (hogql.includes("agent_id") && hogql.includes("GROUP BY agent_id")) {
    return "tokensByAgent";
  }
  // Tokens trends: agent_token_usage with GROUP BY period
  if (
    hogql.includes("agent_token_usage") &&
    hogql.includes("GROUP BY period")
  ) {
    return "tokensTrends";
  }
  return "generic";
}

const FIXTURES = {
  summary: SUMMARY_FIXTURE,
  summaryCycleTime: CYCLE_TIME_FIXTURE,
  trends: TRENDS_FIXTURE,
  featuresTasks: FEATURES_TASKS_FIXTURE,
  featuresCi: FEATURES_CI_FIXTURE,
  featuresReviews: FEATURES_REVIEWS_FIXTURE,
  queueFunnel: QUEUE_FUNNEL_FIXTURE,
  queueCycleStarted: QUEUE_CYCLE_STARTED_FIXTURE,
  queueCycleMerged: QUEUE_CYCLE_MERGED_FIXTURE,
  tokensTotals: TOKENS_TOTALS_FIXTURE,
  tokensBySessionType: TOKENS_BY_SESSION_TYPE_FIXTURE,
  tokensByAgent: TOKENS_BY_AGENT_FIXTURE,
  tokensTrends: TOKENS_TRENDS_FIXTURE,
};

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates a fixture PostHogClientLike that returns pre-recorded sample results
 * for every query type used by the dashboard. Suitable for offline/dev mode.
 *
 * Pattern-matches on the hogql string to route to the correct fixture.
 * Never makes network calls.
 */
export function createFixturePostHogClient(): PostHogClientLike {
  return {
    async query(hogql: string): Promise<HogQLResult> {
      const type = detectQueryType(hogql);
      if (type === "generic") return GENERIC_FALLBACK;
      return FIXTURES[type];
    },
  };
}
