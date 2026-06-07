/**
 * metrics/src/queries.ts
 * HogQL query builders for Shipwright pipeline metrics.
 * Three query groups: summary (all aggregates), trends (time-series),
 * and features (per-prefix breakdown via 3-query TypeScript join).
 *
 * Event-name aliasing: the producer does NOT emit `shipwright_task_merged`
 * or `shipwright_task_approved` (those names return zero rows in live PostHog data).
 * Task completion is emitted as
 * `shipwright_task_complete` (current) / `shipwright_task_completed`
 * (historical); review completion as `shipwright_task_reviewed` (current) /
 * `shipwright_review_complete` (historical). To resolve both current and any
 * historical/legacy data, completion and review matches are widened via
 * TASK_COMPLETED_EVENTS / TASK_REVIEWED_EVENTS alias sets — the legacy
 * `_merged`/`_approved` names are retained in those sets, so this is purely
 * additive widening, not a rename. Other events are emitted directly:
 *   shipwright_task_started, shipwright_task_blocked, shipwright_pr_created,
 *   shipwright_ci_result, shipwright_simplify_complete
 *
 * Task-identity coalesce: legacy completion events carry
 * `properties.task_id`; the current `shipwright_task_complete` event carries
 * `properties.task` (no task_id). TASK_KEY coalesces both so the feature-prefix
 * extract/match and all cycle/queue identity reads resolve across both event
 * generations. A missing prop is NULL and toString(NULL) is NULL, so
 * coalesce(toString(properties.task_id), toString(properties.task)) falls
 * through to whichever side is populated.
 *
 * All date filters are anchored to America/Los_Angeles so "today" and rolling
 * windows match the operator's wall clock, not UTC. Stored timestamps remain
 * UTC; HogQL's timezone-aware functions handle the comparison.
 */

import type { DatePreset, DateRange } from "./types.ts";

export type QueryDateRange = DatePreset | DateRange;
export type TrendsGroupBy = "day" | "week" | "hour";

export const DASHBOARD_TZ = "America/Los_Angeles";

/**
 * PostHog-unsupported HogQL functions that must never appear in generated SQL.
 * These cause 400 errors on live PostHog queries. Extend here as new
 * unsupported functions are discovered — the UE-1.2 denylist guard test
 * imports this const so adding to it automatically extends test coverage.
 */
export const DENYLIST = [
  "toFloatOrNull",
  "toFloatOrDefault",
  "parseDateTimeBestEffortOrNull",
  "parseDateTimeBestEffort",
] as const;

/**
 * Completion-event aliases. The producer emits `shipwright_task_complete`
 * (current) / `shipwright_task_completed` (historical); `shipwright_task_merged`
 * is the legacy name retained so older data still resolves.
 */
const TASK_COMPLETED_EVENTS = [
  "shipwright_task_merged",
  "shipwright_task_complete",
  "shipwright_task_completed",
];

/**
 * Review-event aliases. The producer emits `shipwright_task_reviewed`
 * (current) / `shipwright_review_complete` (historical);
 * `shipwright_task_approved` is the legacy name retained so older data
 * still resolves.
 */
const TASK_REVIEWED_EVENTS = [
  "shipwright_task_approved",
  "shipwright_task_reviewed",
  "shipwright_review_complete",
];

const SHIPWRIGHT_EVENTS = [
  "shipwright_task_started",
  "shipwright_task_blocked",
  ...TASK_REVIEWED_EVENTS,
  ...TASK_COMPLETED_EVENTS,
  "shipwright_pr_created",
  "shipwright_ci_result",
  "shipwright_simplify_complete",
];

/**
 * Coalesced task identity. Legacy events carry `properties.task_id`; the
 * current `shipwright_task_complete` carries `properties.task`. toString(NULL)
 * is NULL, so coalesce falls through to whichever side is populated — both
 * event generations resolve to a single key.
 *
 * Pre-deploy HogQL validation: run `bun run validate:hogql` in metrics/ with
 * POSTHOG_PERSONAL_API_KEY set to confirm query shape is accepted by PostHog
 * HogQLMetadata before deploying. Live result correctness (non-empty feature
 * prefix rows) requires real PostHog events — use the `90d` preset.
 */
const TASK_KEY =
  "coalesce(toString(properties.task_id), toString(properties.task))";

const toEventList = (events: string[]) =>
  events.map((e) => `'${e}'`).join(", ");

const EVENT_LIST = toEventList(SHIPWRIGHT_EVENTS);
const TASK_COMPLETED_LIST = toEventList(TASK_COMPLETED_EVENTS);
const TASK_REVIEWED_LIST = toEventList(TASK_REVIEWED_EVENTS);

function buildDateFilter(
  dateRange: QueryDateRange,
  column = "timestamp",
): string {
  if (typeof dateRange === "string") {
    switch (dateRange) {
      case "today":
        return `${column} >= toStartOfDay(now(), '${DASHBOARD_TZ}') AND ${column} < toStartOfDay(now(), '${DASHBOARD_TZ}') + interval 1 day`;
      case "7d":
        return `${column} >= toStartOfDay(now() - interval 7 day, '${DASHBOARD_TZ}')`;
      case "30d":
        return `${column} >= toStartOfDay(now() - interval 30 day, '${DASHBOARD_TZ}')`;
      case "90d":
        return `${column} >= toStartOfDay(now() - interval 90 day, '${DASHBOARD_TZ}')`;
    }
  }
  return `${column} >= toDateTime('${dateRange.from} 00:00:00', '${DASHBOARD_TZ}') AND ${column} <= toDateTime('${dateRange.to} 23:59:59', '${DASHBOARD_TZ}')`;
}

/**
 * Summary: all aggregate metrics in a single query.
 * Replaces the old overview + quality + health endpoints.
 */
export function buildSummaryQuery(dateRange: QueryDateRange): string {
  // toFloatOrZero is intentional for complexity bucket equality (missing prop → 0 → matches no bucket 1–5,
  // so uncategorized tasks are excluded) and for avg_fix_cascade_depth (isNotNull guard already excludes
  // absent rows; a recorded depth of 0 meaning no cascades is a valid, meaningful value).
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  countIf(event IN (${TASK_COMPLETED_LIST})) AS tasks_completed,
  countIf(event = 'shipwright_task_blocked') AS tasks_blocked,
  avg(IF(event IN (${TASK_COMPLETED_LIST}), coalesce(properties.actual_h, dateDiff('minute', properties.started_at, properties.ts) / 60.0), NULL)) AS avg_actual_hours,
  avg(IF(event IN (${TASK_COMPLETED_LIST}), toFloat(properties.estimated_h), NULL)) AS avg_estimated_hours,
  avg(IF(event IN (${TASK_COMPLETED_LIST}), properties.retries, NULL)) AS avg_retries,
  avg(IF(event IN (${TASK_COMPLETED_LIST}), toFloat(properties.files_changed), NULL)) AS avg_files_changed,
  countIf(event = 'shipwright_ci_result') AS ci_gates_total,
  countIf(event = 'shipwright_ci_result' AND toString(properties.passed_first_try) = 'true') AS ci_first_pass,
  avg(IF(event = 'shipwright_ci_result', toFloat(properties.fix_attempts), NULL)) AS avg_fix_attempts,
  countIf(event = 'shipwright_simplify_complete') AS simplify_total,
  sum(IF(event = 'shipwright_simplify_complete', toFloat(properties.total_fixes), 0)) AS simplify_total_fixes,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.dry), NULL)) AS simplify_avg_dry,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.dead_code), NULL)) AS simplify_avg_dead_code,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.naming), NULL)) AS simplify_avg_naming,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.complexity_fixes), NULL)) AS simplify_avg_complexity,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.consistency), NULL)) AS simplify_avg_consistency,
  countIf(event IN (${TASK_REVIEWED_LIST})) AS reviews_total,
  countIf(event IN (${TASK_REVIEWED_LIST}) AND properties.verdict = 'SHIP IT') AS reviews_ship_it,
  countIf(event IN (${TASK_COMPLETED_LIST}) AND toFloatOrZero(toString(properties.complexity)) = 1) AS complexity_1,
  countIf(event IN (${TASK_COMPLETED_LIST}) AND toFloatOrZero(toString(properties.complexity)) = 2) AS complexity_2,
  countIf(event IN (${TASK_COMPLETED_LIST}) AND toFloatOrZero(toString(properties.complexity)) = 3) AS complexity_3,
  countIf(event IN (${TASK_COMPLETED_LIST}) AND toFloatOrZero(toString(properties.complexity)) = 4) AS complexity_4,
  countIf(event IN (${TASK_COMPLETED_LIST}) AND toFloatOrZero(toString(properties.complexity)) = 5) AS complexity_5,
  avgIf(toFloatOrZero(toString(properties.fix_cascade_depth)), event IN (${TASK_COMPLETED_LIST}) AND isNotNull(properties.fix_cascade_depth)) AS avg_fix_cascade_depth
FROM events
WHERE event IN (${EVENT_LIST})
  AND ${dateFilter}`;
}

/**
 * Cycle time query: avg hours derived per completion event from the
 * timestamps the event carries — `properties.started_at` → `properties.ts`.
 *
 * SM-1.3: Shipwright `shipwright_task_complete` / `_completed` events do NOT
 * carry `actual_h`/`complexity`/`retries`, and there is no separate
 * `shipwright_task_started` event to join against. They DO carry
 * `properties.started_at` and `properties.ts`, so cycle time is a
 * single-event per-row `dateDiff('hour', started_at, ts)` averaged over
 * completion events only — no started↔merged self-join, no `merged_at`
 * alias.
 *
 * Direct-typed-prop rule (SM-1.3 / MUE-1.1 / UE-1.1): PostHog stores these
 * event properties as natively-typed values — `started_at`/`ts` as DateTime,
 * `actual_h`/`retries` as Float. Reference them directly; NEVER round-trip
 * through `toString()` + a parser/converter (`parseDateTimeBestEffortOrNull`,
 * `toFloatOrNull`, etc.). That round-trip is both unsupported by PostHog
 * HogQL (it 400s the live query) and redundant. A missing prop reads as
 * NULL, which preserves the intended semantics: the `dateDiff` is NULL so the WHERE
 * guard (`> 0`) drops rows without a started_at/ts pair (and negative/zero
 * diffs) so they don't poison the average. The date filter targets the
 * completion event's `timestamp`.
 *
 * Output column stays `avg_cycle_time_hours` (single scalar) so the summary
 * handler (api.ts, `cycleTimeRow.avg_cycle_time_hours`) is untouched.
 *
 * Pre-deploy HogQL validation: run `bun run validate:hogql` in metrics/ with
 * POSTHOG_PERSONAL_API_KEY set to confirm query shape is accepted by PostHog
 * HogQLMetadata before deploying. Live result correctness (non-null avg cycle
 * time) requires real PostHog events — use the `90d` preset.
 */
export function buildSummaryCycleTimeQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  // Per-event cycle hours. Referenced in both SELECT and WHERE — HogQL
  // evaluates WHERE before SELECT aliases exist, so the expression must be
  // repeated; keep it in one place so the two copies cannot drift.
  const cycleHours = "dateDiff('hour', properties.started_at, properties.ts)";
  return `SELECT avg(${cycleHours}) AS avg_cycle_time_hours
FROM events
WHERE event IN (${TASK_COMPLETED_LIST})
  AND ${dateFilter}
  AND ${cycleHours} > 0`;
}

/**
 * Features: per-prefix aggregates using 3 separate queries joined in TypeScript.
 * Only tasks with IDs matching PREFIX-N.M format are included.
 */

/** Tasks query: completed task count + avg hours per prefix. */
export function buildFeaturesTasksQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  extract(${TASK_KEY}, '^([A-Z]+)-') AS feature_prefix,
  count() AS tasks_completed,
  avg(properties.actual_h) AS avg_actual_h,
  avg(properties.estimated_h) AS avg_estimated_h
FROM events
WHERE event IN (${TASK_COMPLETED_LIST})
  AND match(${TASK_KEY}, '^[A-Z]+-[0-9]+\\\\.[0-9]+$')
  AND ${dateFilter}
GROUP BY feature_prefix
ORDER BY tasks_completed DESC`;
}

/** CI query: first-pass counts per prefix. */
export function buildFeaturesCiQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  extract(${TASK_KEY}, '^([A-Z]+)-') AS feature_prefix,
  count() AS ci_total,
  countIf(toString(properties.passed_first_try) = 'true') AS ci_first_pass
FROM events
WHERE event = 'shipwright_ci_result'
  AND match(${TASK_KEY}, '^[A-Z]+-[0-9]+\\\\.[0-9]+$')
  AND ${dateFilter}
GROUP BY feature_prefix`;
}

/** Reviews query: SHIP IT counts per prefix. */
export function buildFeaturesReviewsQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  extract(${TASK_KEY}, '^([A-Z]+)-') AS feature_prefix,
  count() AS reviews_total,
  countIf(properties.verdict = 'SHIP IT') AS reviews_ship_it
FROM events
WHERE event IN (${TASK_REVIEWED_LIST})
  AND match(${TASK_KEY}, '^[A-Z]+-[0-9]+\\\\.[0-9]+$')
  AND ${dateFilter}
GROUP BY feature_prefix`;
}

/**
 * Queue: funnel counts + avg review findings in a single query.
 * Covers shipwright_task_started, shipwright_task_approved,
 * shipwright_task_merged, shipwright_task_blocked.
 */
export function buildQueueFunnelQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  countIf(event = 'shipwright_task_started') AS tasks_started,
  countIf(event IN (${TASK_REVIEWED_LIST})) AS tasks_approved,
  countIf(event IN (${TASK_COMPLETED_LIST})) AS tasks_merged,
  countIf(event = 'shipwright_task_blocked') AS tasks_blocked,
  avg(IF(event IN (${TASK_REVIEWED_LIST}), toFloat(properties.findings), NULL)) AS avg_review_findings
FROM events
WHERE event IN ('shipwright_task_started', ${TASK_REVIEWED_LIST}, ${TASK_COMPLETED_LIST}, 'shipwright_task_blocked')
  AND ${dateFilter}`;
}

/**
 * Queue cycle time: started events with task_id + timestamp.
 * Used with buildQueueCycleMergedQuery to compute avg cycle time in days.
 */
export function buildQueueCycleStartedQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  ${TASK_KEY} AS task_id,
  timestamp
FROM events
WHERE event = 'shipwright_task_started'
  AND isNotNull(${TASK_KEY})
  AND ${dateFilter}`;
}

/**
 * Queue cycle time: merged events with task_id + timestamp.
 * Used with buildQueueCycleStartedQuery to compute avg cycle time in days.
 */
export function buildQueueCycleMergedQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  ${TASK_KEY} AS task_id,
  timestamp
FROM events
WHERE event IN (${TASK_COMPLETED_LIST})
  AND isNotNull(${TASK_KEY})
  AND ${dateFilter}`;
}

// ─── Token usage queries ──────────────────────────────────────────────────────

/**
 * Token usage totals: aggregate sums across all agent_token_usage events.
 * Returns: input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens, total_tokens.
 *
 * Direct-typed-prop rule: token count properties are stored as native numbers —
 * reference them directly via properties.X (no toString() round-trips).
 */
export function buildTokensTotalsQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  sum(properties.input_tokens) AS input_tokens,
  sum(properties.output_tokens) AS output_tokens,
  sum(properties.cache_read_input_tokens) AS cache_read_input_tokens,
  sum(properties.cache_creation_input_tokens) AS cache_creation_input_tokens,
  sum(properties.input_tokens) + sum(properties.output_tokens) + sum(properties.cache_read_input_tokens) + sum(properties.cache_creation_input_tokens) AS total_tokens
FROM events
WHERE event = 'agent_token_usage'
  AND ${dateFilter}`;
}

/**
 * Token usage by session type: aggregates grouped by session_type property.
 * session_type values: "slack_dm" | "slack_mention" | "cron"
 */
export function buildTokensBySessionTypeQuery(
  dateRange: QueryDateRange,
): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  properties.session_type AS session_type,
  sum(properties.input_tokens) AS input_tokens,
  sum(properties.output_tokens) AS output_tokens,
  sum(properties.cache_read_input_tokens) AS cache_read_input_tokens,
  sum(properties.cache_creation_input_tokens) AS cache_creation_input_tokens,
  sum(properties.input_tokens) + sum(properties.output_tokens) + sum(properties.cache_read_input_tokens) + sum(properties.cache_creation_input_tokens) AS total_tokens
FROM events
WHERE event = 'agent_token_usage'
  AND ${dateFilter}
GROUP BY session_type
ORDER BY total_tokens DESC`;
}

/**
 * Token usage by agent: aggregates grouped by agent_id property.
 */
export function buildTokensByAgentQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  properties.agent_id AS agent_id,
  sum(properties.input_tokens) AS input_tokens,
  sum(properties.output_tokens) AS output_tokens,
  sum(properties.cache_read_input_tokens) AS cache_read_input_tokens,
  sum(properties.cache_creation_input_tokens) AS cache_creation_input_tokens,
  sum(properties.input_tokens) + sum(properties.output_tokens) + sum(properties.cache_read_input_tokens) + sum(properties.cache_creation_input_tokens) AS total_tokens
FROM events
WHERE event = 'agent_token_usage'
  AND ${dateFilter}
GROUP BY agent_id
ORDER BY total_tokens DESC`;
}

/**
 * Token usage daily trends: time-series token sums grouped by day (LA timezone).
 */
export function buildTokensTrendsQuery(dateRange: QueryDateRange): string {
  const dateFilter = buildDateFilter(dateRange);
  return `SELECT
  toDate(toTimeZone(timestamp, '${DASHBOARD_TZ}')) AS period,
  sum(properties.input_tokens) AS input_tokens,
  sum(properties.output_tokens) AS output_tokens,
  sum(properties.cache_read_input_tokens) AS cache_read_input_tokens,
  sum(properties.cache_creation_input_tokens) AS cache_creation_input_tokens,
  sum(properties.input_tokens) + sum(properties.output_tokens) + sum(properties.cache_read_input_tokens) + sum(properties.cache_creation_input_tokens) AS total_tokens
FROM events
WHERE event = 'agent_token_usage'
  AND ${dateFilter}
GROUP BY period
ORDER BY period ASC`;
}

/**
 * Trends: time-series event counts grouped by day, week, or hour.
 */
export function buildTrendsQuery(
  dateRange: QueryDateRange,
  groupBy: TrendsGroupBy = "day",
): string {
  const dateFilter = buildDateFilter(dateRange);
  const periodExpr =
    groupBy === "week"
      ? `toStartOfWeek(toTimeZone(timestamp, '${DASHBOARD_TZ}'))`
      : groupBy === "hour"
        ? `toStartOfHour(toTimeZone(timestamp, '${DASHBOARD_TZ}'))`
        : `toDate(toTimeZone(timestamp, '${DASHBOARD_TZ}'))`;
  return `SELECT
  ${periodExpr} AS period,
  countIf(event IN (${TASK_COMPLETED_LIST})) AS tasks_completed,
  countIf(event = 'shipwright_ci_result') AS ci_gates,
  countIf(event = 'shipwright_ci_result' AND toString(properties.passed_first_try) = 'true') AS ci_first_pass,
  countIf(event = 'shipwright_ci_result' AND toString(properties.first_pass) = 'true') AS ci_first_pass_count,
  countIf(event = 'shipwright_simplify_complete') AS simplify_passes,
  sum(IF(event = 'shipwright_simplify_complete', toFloat(properties.total_fixes), 0)) AS simplify_fixes,
  countIf(event = 'shipwright_task_blocked') AS tasks_blocked,
  countIf(event IN (${TASK_REVIEWED_LIST})) AS reviews,
  countIf(event = 'shipwright_task_started') AS tasks_started,
  countIf(event IN (${TASK_REVIEWED_LIST}) AND properties.verdict = 'SHIP IT') AS reviews_ship_it,
  avg(IF(event IN (${TASK_COMPLETED_LIST}), coalesce(properties.actual_h, dateDiff('minute', properties.started_at, properties.ts) / 60.0), NULL)) AS avg_actual_hours,
  avg(IF(event IN (${TASK_COMPLETED_LIST}), toFloat(properties.estimated_h), NULL)) AS avg_estimated_hours,
  avg(IF(event IN (${TASK_COMPLETED_LIST}), properties.retries, NULL)) AS avg_retries,
  avg(IF(event IN (${TASK_COMPLETED_LIST}), toFloat(properties.files_changed), NULL)) AS avg_files_changed,
  avg(IF(event = 'shipwright_ci_result', toFloat(properties.fix_attempts), NULL)) AS avg_fix_attempts,
  avgIf(dateDiff('hour', properties.started_at, properties.ts), event IN (${TASK_COMPLETED_LIST}) AND dateDiff('hour', properties.started_at, properties.ts) > 0) AS avg_cycle_time_hours,
  avg(IF(event IN (${TASK_COMPLETED_LIST}), IF(toFloat(properties.estimated_h) > 0, toFloat(properties.actual_h) / toFloat(properties.estimated_h), NULL), NULL)) AS estimation_accuracy,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.dry), NULL)) AS simplify_avg_dry,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.dead_code), NULL)) AS simplify_avg_dead_code,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.naming), NULL)) AS simplify_avg_naming,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.complexity_fixes), NULL)) AS simplify_avg_complexity,
  avg(IF(event = 'shipwright_simplify_complete', toFloat(properties.consistency), NULL)) AS simplify_avg_consistency,
  avg(IF(event IN (${TASK_REVIEWED_LIST}), toFloat(properties.findings), NULL)) AS avg_review_findings
FROM events
WHERE event IN (${EVENT_LIST})
  AND ${dateFilter}
GROUP BY period
ORDER BY period ASC`;
}
