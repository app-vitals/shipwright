/**
 * metrics/src/queries.test.ts
 * Snapshot tests for HogQL query builders — verify output structure.
 */

import { describe, expect, it } from "bun:test";
import {
  DASHBOARD_TZ,
  DENYLIST,
  type QueryDateRange,
  buildFeaturesCiQuery,
  buildFeaturesReviewsQuery,
  buildFeaturesTasksQuery,
  buildQueueCycleMergedQuery,
  buildQueueCycleStartedQuery,
  buildQueueFunnelQuery,
  buildSummaryCycleTimeQuery,
  buildSummaryQuery,
  buildTrendsQuery,
} from "./queries.ts";

// Event names the producer actually emits in PostHog (verified live,
// project <your-project-id>). The legacy `_merged`/`_approved` names do NOT exist there;
// matching is widened via alias sets — see queries.ts header.
const COMPLETED_ALIASES = [
  "shipwright_task_merged",
  "shipwright_task_complete",
  "shipwright_task_completed",
];
const REVIEWED_ALIASES = [
  "shipwright_task_approved",
  "shipwright_task_reviewed",
  "shipwright_review_complete",
];

describe("shipwright event aliasing (SM-1.1)", () => {
  const completionBuilders = [
    ["buildSummaryQuery", buildSummaryQuery] as const,
    ["buildSummaryCycleTimeQuery", buildSummaryCycleTimeQuery] as const,
    ["buildFeaturesTasksQuery", buildFeaturesTasksQuery] as const,
    ["buildQueueFunnelQuery", buildQueueFunnelQuery] as const,
    ["buildQueueCycleMergedQuery", buildQueueCycleMergedQuery] as const,
    ["buildTrendsQuery", buildTrendsQuery] as const,
  ];
  for (const [name, builder] of completionBuilders) {
    it(`${name} matches all completion aliases`, () => {
      const query = builder("7d");
      for (const ev of COMPLETED_ALIASES) {
        expect(query).toContain(ev);
      }
    });
  }

  const reviewBuilders = [
    ["buildSummaryQuery", buildSummaryQuery] as const,
    ["buildFeaturesReviewsQuery", buildFeaturesReviewsQuery] as const,
    ["buildQueueFunnelQuery", buildQueueFunnelQuery] as const,
    ["buildTrendsQuery", buildTrendsQuery] as const,
  ];
  for (const [name, builder] of reviewBuilders) {
    it(`${name} matches all review aliases`, () => {
      const query = builder("7d");
      for (const ev of REVIEWED_ALIASES) {
        expect(query).toContain(ev);
      }
    });
  }

  it("legacy names are preserved (additive-only regression guard)", () => {
    const query = buildSummaryQuery("7d");
    expect(query).toContain("shipwright_task_merged");
    expect(query).toContain("shipwright_task_approved");
  });

  it("top-level WHERE event IN list admits all 4 new real names", () => {
    const query = buildSummaryQuery("7d");
    const whereClause = query.slice(query.indexOf("WHERE event IN ("));
    for (const ev of [
      "shipwright_task_complete",
      "shipwright_task_completed",
      "shipwright_task_reviewed",
      "shipwright_review_complete",
    ]) {
      expect(whereClause).toContain(`'${ev}'`);
    }
  });

  it("buildSummaryCycleTimeQuery IN-list includes completion aliases", () => {
    // SM-1.3: single-event query over completion events only — no longer a
    // started↔merged join, so no 'shipwright_task_started' in the IN-list.
    const query = buildSummaryCycleTimeQuery("7d");
    for (const ev of COMPLETED_ALIASES) {
      expect(query).toContain(`'${ev}'`);
    }
    expect(query).not.toContain("'shipwright_task_started'");
  });

  it("buildQueueFunnelQuery IN-list includes completion + review aliases", () => {
    const query = buildQueueFunnelQuery("7d");
    for (const ev of [...COMPLETED_ALIASES, ...REVIEWED_ALIASES]) {
      expect(query).toContain(`'${ev}'`);
    }
  });
});

describe("task-identity coalesce across event generations (SM-1.2)", () => {
  // Legacy completion events carry `properties.task_id`; current
  // `shipwright_task_complete` carries `properties.task` (no task_id).
  // TASK_KEY = coalesce(toString(properties.task_id), toString(properties.task))
  // resolves BOTH generations: a missing prop is NULL, toString(NULL) is NULL,
  // so coalesce falls through to the populated side. These string-level
  // assertions document that the single expression covers both shapes.
  const TASK_KEY_EXPR =
    "coalesce(toString(properties.task_id), toString(properties.task))";

  const featureExtractBuilders = [
    ["buildFeaturesTasksQuery", buildFeaturesTasksQuery] as const,
    ["buildFeaturesCiQuery", buildFeaturesCiQuery] as const,
    ["buildFeaturesReviewsQuery", buildFeaturesReviewsQuery] as const,
  ];

  it("resolves legacy task_id-shaped identity (feature extract + match)", () => {
    // A row with properties.task_id = "MQ-1.2" and no properties.task:
    // coalesce(toString("MQ-1.2"), toString(NULL)) = "MQ-1.2" → prefix "MQ".
    for (const [, builder] of featureExtractBuilders) {
      const query = builder("7d");
      expect(query).toContain(`extract(${TASK_KEY_EXPR}, '^([A-Z]+)-')`);
      expect(query).toContain(`match(${TASK_KEY_EXPR},`);
    }
  });

  it("resolves current task-shaped identity (feature extract + match)", () => {
    // A row with properties.task = "MQ-1.2" and no properties.task_id:
    // coalesce(toString(NULL), toString("MQ-1.2")) = "MQ-1.2" → prefix "MQ".
    // The single TASK_KEY expression covers this generation too, so the
    // assertion is identical — that equivalence is the point.
    for (const [, builder] of featureExtractBuilders) {
      const query = builder("7d");
      expect(query).toContain(`extract(${TASK_KEY_EXPR}, '^([A-Z]+)-')`);
      expect(query).toContain(`match(${TASK_KEY_EXPR},`);
    }
  });

  // SM-1.3: buildSummaryCycleTimeQuery is now a single-event timestamp-diff
  // query — it no longer reads a per-task identity, so it's excluded here.
  const identityReadBuilders = [
    ["buildQueueCycleStartedQuery", buildQueueCycleStartedQuery] as const,
    ["buildQueueCycleMergedQuery", buildQueueCycleMergedQuery] as const,
  ];

  it("cycle/queue identity reads use the coalesced TASK_KEY", () => {
    for (const [, builder] of identityReadBuilders) {
      const query = builder("7d");
      expect(query).toContain(`${TASK_KEY_EXPR} AS task_id`);
      expect(query).toContain(`isNotNull(${TASK_KEY_EXPR})`);
    }
  });

  it("no bare properties.task_id identity reads remain", () => {
    const allBuilders = [
      buildFeaturesTasksQuery,
      buildFeaturesCiQuery,
      buildFeaturesReviewsQuery,
      buildSummaryCycleTimeQuery,
      buildQueueCycleStartedQuery,
      buildQueueCycleMergedQuery,
    ];
    for (const builder of allBuilders) {
      const query = builder("7d");
      expect(query).not.toContain("extract(properties.task_id");
      expect(query).not.toContain("match(toString(properties.task_id)");
      expect(query).not.toContain("isNotNull(properties.task_id)");
      expect(query).not.toContain("properties.task_id AS task_id");
    }
  });
});

const TASK_COMPLETED_ALIAS_LIST = COMPLETED_ALIASES.map((e) => `'${e}'`).join(
  ", ",
);

describe("derived actual-hours + single-event cycle time (SM-1.3)", () => {
  // Shipwright completion events lack `actual_h` but carry
  // `properties.started_at` and `properties.ts`. Actual-hours coalesces an
  // explicit `actual_h` with a timestamp-derived fallback; cycle time is a
  // single-event per-row dateDiff over started_at/ts (no started↔merged join).

  it("buildSummaryQuery derives actual hours via coalesce + timestamp fallback", () => {
    const query = buildSummaryQuery("7d");
    // UE-1.1: properties.actual_h is a natively-typed Float — reference it
    // directly. The toString()->toFloatOrNull() round-trip is unsupported by
    // PostHog HogQL (400s the live query) and redundant.
    expect(query).toContain(
      "coalesce(properties.actual_h, dateDiff('minute', properties.started_at, properties.ts) / 60.0)",
    );
    // The derived expression stays a completion-only average.
    expect(query).toContain(
      `avg(IF(event IN (${TASK_COMPLETED_ALIAS_LIST}), coalesce(properties.actual_h`,
    );
    expect(query).toContain("AS avg_actual_hours");
    // Bare typed Float is NULL when absent, preserving the coalesce
    // fallthrough to the timestamp-derived value. NEVER the unsupported
    // toFloatOrNull, nor toFloatOrDefault (returns 0 and defeats coalesce).
    expect(query).not.toContain("toFloatOrNull");
    expect(query).not.toContain("toFloatOrDefault(properties.actual_h)");
  });

  it("buildSummaryCycleTimeQuery is a single-event query (no started↔merged join)", () => {
    const query = buildSummaryCycleTimeQuery("7d");
    expect(query).not.toContain("shipwright_task_started");
    expect(query).not.toContain("minIf");
    expect(query).not.toContain("maxIf");
    expect(query).not.toContain("merged_at");
    expect(query).not.toContain("GROUP BY task_id");
  });

  it("buildSummaryCycleTimeQuery computes per-event dateDiff over started_at/ts", () => {
    const query = buildSummaryCycleTimeQuery("7d");
    expect(query).toContain(
      "dateDiff('hour', properties.started_at, properties.ts)",
    );
    expect(query).toContain("AS avg_cycle_time_hours");
    // Completion events only.
    expect(query).toContain(`event IN (${TASK_COMPLETED_ALIAS_LIST})`);
    // Guards against NULL/zero/negative diffs poisoning the average.
    expect(query).toContain("> 0");
  });

  it("MUE-1.1: uses bare native-DateTime props, never parseDateTimeBestEffort", () => {
    // PostHog HogQL does not support parseDateTimeBestEffortOrNull, and
    // started_at/ts are stored as native DateTime, so the parse round-trip
    // is both unsupported (400) and redundant. Both queries must reference
    // bare properties.started_at / properties.ts directly.
    const summary = buildSummaryQuery("7d");
    const cycle = buildSummaryCycleTimeQuery("7d");
    expect(summary).not.toContain("parseDateTimeBestEffort");
    expect(cycle).not.toContain("parseDateTimeBestEffort");
    expect(summary).toContain(
      "dateDiff('minute', properties.started_at, properties.ts)",
    );
    expect(cycle).toContain(
      "dateDiff('hour', properties.started_at, properties.ts)",
    );
  });

  it("buildSummaryCycleTimeQuery applies date filter to completion timestamp column", () => {
    const query = buildSummaryCycleTimeQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
  });

  it("avg_retries uses bare typed properties.retries so absent retries surface as NULL (AC#3 em-dash)", () => {
    // app.js fmtNum renders ONLY null/undefined as "--"; it renders 0 as
    // "0.0". toFloatOrDefault/toFloatOrZero return 0 for missing props → avg
    // of zeros = 0 → dashboard shows "0.0", never the em-dash placeholder.
    // properties.retries is a natively-typed Float: absent prop → NULL → an
    // all-absent average is NULL → toNumOrNull → null → fmtNum renders "--".
    // This is the AC#3 contract: sparse retries surface as the em-dash
    // placeholder, not a fake 0.0 — and the bare typed prop preserves that
    // NULL semantics without the unsupported toFloatOrNull round-trip.
    const query = buildSummaryQuery("7d");
    expect(query).toContain("avg(IF(event IN (");
    expect(query).toContain("properties.retries, NULL)) AS avg_retries");
    expect(query).not.toContain("toFloatOrNull");
    expect(query).not.toContain("toFloatOrDefault(properties.retries)");
    expect(query).not.toContain("toFloatOrZero(toString(properties.retries))");
    expect(query).toContain("AS avg_retries");
  });
});

describe("buildSummaryQuery", () => {
  it("7d preset produces interval filter", () => {
    const query = buildSummaryQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("30d preset produces interval filter", () => {
    const query = buildSummaryQuery("30d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 30 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("today preset produces correct date filter", () => {
    const query = buildSummaryQuery("today");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now(), 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "timestamp < toStartOfDay(now(), 'America/Los_Angeles') + interval 1 day",
    );
    expect(query).toMatchSnapshot();
  });

  it("custom range produces literal timestamp filter", () => {
    const query = buildSummaryQuery({ from: "2026-04-01", to: "2026-04-03" });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "toDateTime('2026-04-03 23:59:59', 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("references v3 Shipwright event names", () => {
    const query = buildSummaryQuery("7d");
    expect(query).toContain("shipwright_task_merged");
    expect(query).toContain("shipwright_task_blocked");
    expect(query).toContain("shipwright_ci_result");
    expect(query).toContain("shipwright_simplify_complete");
    expect(query).toContain("shipwright_task_approved");
  });

  it("does not reference removed v2 event names", () => {
    const query = buildSummaryQuery("7d");
    expect(query).not.toContain("shipwright_ci_gate");
    expect(query).not.toContain("shipwright_simplify_pass");
    expect(query).not.toContain("shipwright_coverage");
    expect(query).not.toContain("shipwright_review_pass");
  });

  it("selects all summary aggregate columns", () => {
    const query = buildSummaryQuery("7d");
    expect(query).toContain("tasks_completed");
    expect(query).toContain("tasks_blocked");
    expect(query).toContain("avg_actual_hours");
    expect(query).toContain("avg_estimated_hours");
    expect(query).toContain("avg_retries");
    expect(query).toContain("avg_files_changed");
    expect(query).toContain("ci_gates_total");
    expect(query).toContain("ci_first_pass");
    expect(query).toContain("avg_fix_attempts");
    expect(query).toContain("simplify_total");
    expect(query).toContain("simplify_total_fixes");
    expect(query).toContain("simplify_avg_dry");
    expect(query).toContain("simplify_avg_dead_code");
    expect(query).toContain("simplify_avg_naming");
    expect(query).toContain("simplify_avg_complexity");
    expect(query).toContain("simplify_avg_consistency");
    expect(query).toContain("reviews_total");
    expect(query).toContain("reviews_ship_it");
    // complexity distribution + fix cascade depth
    expect(query).toContain("complexity_1");
    expect(query).toContain("complexity_2");
    expect(query).toContain("complexity_3");
    expect(query).toContain("complexity_4");
    expect(query).toContain("complexity_5");
    expect(query).toContain("avg_fix_cascade_depth");
  });

  it("does not select removed coverage columns", () => {
    const query = buildSummaryQuery("7d");
    expect(query).not.toContain("coverage_reports");
    expect(query).not.toContain("avg_coverage_delta");
  });

  it("tasks_blocked uses countIf on shipwright_task_blocked", () => {
    const query = buildSummaryQuery("7d");
    expect(query).toContain(
      "countIf(event = 'shipwright_task_blocked') AS tasks_blocked",
    );
  });

  it("complexity_1 through complexity_5 use countIf on task_merged", () => {
    const query = buildSummaryQuery("7d");
    for (let i = 1; i <= 5; i++) {
      expect(query).toContain(`AS complexity_${i}`);
    }
    expect(query).toContain("properties.complexity");
    expect(query).toContain("shipwright_task_merged");
  });

  it("avg_fix_cascade_depth uses avgIf with null guard", () => {
    const query = buildSummaryQuery("7d");
    expect(query).toContain("avg_fix_cascade_depth");
    expect(query).toContain("fix_cascade_depth");
    expect(query).toContain("isNotNull");
  });

  it("queries from events table", () => {
    const query = buildSummaryQuery("today");
    expect(query).toContain("FROM events");
  });
});

describe("buildSummaryCycleTimeQuery", () => {
  // SM-1.3: rewritten as a single-event query over completion events only.
  // Cycle time is a per-row dateDiff over properties.started_at → properties.ts;
  // there is no started↔merged self-join, no merged_at alias.
  it("7d preset produces interval filter on the completion timestamp", () => {
    const query = buildSummaryCycleTimeQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("custom range produces literal timestamp filter", () => {
    const query = buildSummaryCycleTimeQuery({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "toDateTime('2026-04-07 23:59:59', 'America/Los_Angeles')",
    );
  });

  it("selects avg_cycle_time_hours via per-event dateDiff", () => {
    const query = buildSummaryCycleTimeQuery("7d");
    expect(query).toContain("avg_cycle_time_hours");
    expect(query).toContain(
      "dateDiff('hour', properties.started_at, properties.ts)",
    );
  });

  it("is single-event over completion events (no started↔merged join)", () => {
    const query = buildSummaryCycleTimeQuery("7d");
    expect(query).not.toContain("shipwright_task_started");
    expect(query).not.toContain("minIf");
    expect(query).not.toContain("maxIf");
    expect(query).not.toContain("merged_at");
    expect(query).toContain("shipwright_task_merged");
  });

  it("guards against null/zero/negative diffs poisoning the average", () => {
    const query = buildSummaryCycleTimeQuery("7d");
    expect(query).toContain(
      "dateDiff('hour', properties.started_at, properties.ts) > 0",
    );
  });

  it("does not derive a per-task identity (no GROUP BY task_id)", () => {
    const query = buildSummaryCycleTimeQuery("7d");
    expect(query).not.toContain("GROUP BY task_id");
    expect(query).not.toContain(" AS task_id");
  });

  it("queries from events table", () => {
    const query = buildSummaryCycleTimeQuery("today");
    expect(query).toContain("FROM events");
  });
});

describe("buildTrendsQuery", () => {
  it("90d preset produces 90 day interval filter", () => {
    const query = buildTrendsQuery("90d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 90 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("defaults to day grouping", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain(
      "toDate(toTimeZone(timestamp, 'America/Los_Angeles')) AS period",
    );
    expect(query).toMatchSnapshot();
  });

  it("day grouping uses toDate", () => {
    const query = buildTrendsQuery("30d", "day");
    expect(query).toContain(
      "toDate(toTimeZone(timestamp, 'America/Los_Angeles')) AS period",
    );
    expect(query).toMatchSnapshot();
  });

  it("week grouping uses toStartOfWeek", () => {
    const query = buildTrendsQuery("30d", "week");
    expect(query).toContain(
      "toStartOfWeek(toTimeZone(timestamp, 'America/Los_Angeles')) AS period",
    );
    expect(query).toMatchSnapshot();
  });

  it("today preset with day grouping", () => {
    const query = buildTrendsQuery("today", "day");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now(), 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "timestamp < toStartOfDay(now(), 'America/Los_Angeles') + interval 1 day",
    );
    expect(query).toMatchSnapshot();
  });

  it("custom range with week grouping", () => {
    const query = buildTrendsQuery(
      { from: "2026-03-01", to: "2026-04-01" },
      "week",
    );
    expect(query).toContain(
      "toDateTime('2026-03-01 00:00:00', 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "toStartOfWeek(toTimeZone(timestamp, 'America/Los_Angeles')) AS period",
    );
    expect(query).toMatchSnapshot();
  });

  it("includes GROUP BY and ORDER BY period", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain("GROUP BY period");
    expect(query).toContain("ORDER BY period ASC");
  });

  it("selects trend metric columns including tasksBlocked", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain("tasks_completed");
    expect(query).toContain("ci_gates");
    expect(query).toContain("ci_first_pass");
    expect(query).toContain("ci_first_pass_count");
    expect(query).toContain("simplify_passes");
    expect(query).toContain("simplify_fixes");
    expect(query).toContain("tasks_blocked");
    expect(query).toContain("reviews");
  });

  it("does not select coverage_reports (removed in v3)", () => {
    const query = buildTrendsQuery("7d");
    expect(query).not.toContain("coverage_reports");
    expect(query).not.toContain("shipwright_coverage");
  });

  it("references v3 Shipwright event names", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain("shipwright_task_merged");
    expect(query).toContain("shipwright_ci_result");
    expect(query).toContain("shipwright_simplify_complete");
    expect(query).toContain("shipwright_task_blocked");
    expect(query).toContain("shipwright_task_approved");
  });

  it("does not reference removed v2 event names", () => {
    const query = buildTrendsQuery("7d");
    expect(query).not.toContain("shipwright_ci_gate");
    expect(query).not.toContain("shipwright_simplify_pass");
    expect(query).not.toContain("shipwright_review_pass");
  });

  it("ci_first_pass_count uses first_pass property on shipwright_ci_result", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain("properties.first_pass");
    expect(query).toContain("ci_first_pass_count");
    expect(query).toContain("shipwright_ci_result");
  });

  it("includes new MG-1.1 count columns: tasks_started, reviews_ship_it", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain("tasks_started");
    expect(query).toContain("reviews_ship_it");
    expect(query).toContain("shipwright_task_started");
  });

  it("includes new MG-1.1 avg columns: avg_actual_hours, avg_estimated_hours, avg_retries, avg_files_changed", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain("avg_actual_hours");
    expect(query).toContain("avg_estimated_hours");
    expect(query).toContain("avg_retries");
    expect(query).toContain("avg_files_changed");
  });

  it("includes new MG-1.1 avg columns: avg_fix_attempts, avg_cycle_time_hours, estimation_accuracy", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain("avg_fix_attempts");
    expect(query).toContain("avg_cycle_time_hours");
    expect(query).toContain("estimation_accuracy");
  });

  it("includes new MG-1.1 simplify avg columns", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain("simplify_avg_dry");
    expect(query).toContain("simplify_avg_dead_code");
    expect(query).toContain("simplify_avg_naming");
    expect(query).toContain("simplify_avg_complexity");
    expect(query).toContain("simplify_avg_consistency");
  });

  it("includes new MG-1.1 avg_review_findings", () => {
    const query = buildTrendsQuery("7d");
    expect(query).toContain("avg_review_findings");
    expect(query).toContain("properties.findings");
  });

  it("hour grouping uses toStartOfHour", () => {
    const query = buildTrendsQuery("today", "hour");
    expect(query).toContain(
      "toStartOfHour(toTimeZone(timestamp, 'America/Los_Angeles')) AS period",
    );
    expect(query).toMatchSnapshot();
  });

  it("does not use DENYLIST functions in trends query", () => {
    const query = buildTrendsQuery("7d", "day");
    for (const fn of DENYLIST) {
      expect(query).not.toContain(fn);
    }
  });
});

describe("buildFeaturesTasksQuery", () => {
  it("7d preset produces interval filter", () => {
    const query = buildFeaturesTasksQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("custom range produces literal timestamp filter", () => {
    const query = buildFeaturesTasksQuery({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "toDateTime('2026-04-07 23:59:59', 'America/Los_Angeles')",
    );
  });

  it("filters to completion-alias events", () => {
    const query = buildFeaturesTasksQuery("7d");
    expect(query).toContain("event IN (");
    expect(query).toContain("'shipwright_task_merged'");
  });

  it("includes PREFIX-N.M format regex filter", () => {
    const query = buildFeaturesTasksQuery("7d");
    expect(query).toContain(
      "match(coalesce(toString(properties.task_id), toString(properties.task))",
    );
    expect(query).toContain("[A-Z]+-[0-9]+");
  });

  it("extracts feature_prefix from task identity", () => {
    const query = buildFeaturesTasksQuery("7d");
    expect(query).toContain(
      "extract(coalesce(toString(properties.task_id), toString(properties.task))",
    );
    expect(query).toContain("feature_prefix");
  });

  it("groups by feature_prefix ordered by tasks_completed desc", () => {
    const query = buildFeaturesTasksQuery("7d");
    expect(query).toContain("GROUP BY feature_prefix");
    expect(query).toContain("ORDER BY tasks_completed DESC");
  });

  it("selects task count and avg hours columns", () => {
    const query = buildFeaturesTasksQuery("7d");
    expect(query).toContain("tasks_completed");
    expect(query).toContain("avg_actual_h");
    expect(query).toContain("avg_estimated_h");
  });
});

describe("buildFeaturesCiQuery", () => {
  it("7d preset produces interval filter", () => {
    const query = buildFeaturesCiQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("filters to shipwright_ci_result event", () => {
    const query = buildFeaturesCiQuery("7d");
    expect(query).toContain("event = 'shipwright_ci_result'");
  });

  it("does not use removed v2 ci_gate event", () => {
    const query = buildFeaturesCiQuery("7d");
    expect(query).not.toContain("shipwright_ci_gate");
  });

  it("includes PREFIX-N.M format regex filter", () => {
    const query = buildFeaturesCiQuery("7d");
    expect(query).toContain(
      "match(coalesce(toString(properties.task_id), toString(properties.task))",
    );
  });

  it("selects ci_total and ci_first_pass columns", () => {
    const query = buildFeaturesCiQuery("7d");
    expect(query).toContain("ci_total");
    expect(query).toContain("ci_first_pass");
  });

  it("groups by feature_prefix", () => {
    const query = buildFeaturesCiQuery("7d");
    expect(query).toContain("GROUP BY feature_prefix");
  });
});

describe("buildFeaturesReviewsQuery", () => {
  it("7d preset produces interval filter", () => {
    const query = buildFeaturesReviewsQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("filters to review-alias events", () => {
    const query = buildFeaturesReviewsQuery("7d");
    expect(query).toContain("event IN (");
    expect(query).toContain("'shipwright_task_approved'");
  });

  it("does not use removed v2 review_pass event", () => {
    const query = buildFeaturesReviewsQuery("7d");
    expect(query).not.toContain("shipwright_review_pass");
  });

  it("includes PREFIX-N.M format regex filter", () => {
    const query = buildFeaturesReviewsQuery("7d");
    expect(query).toContain(
      "match(coalesce(toString(properties.task_id), toString(properties.task))",
    );
  });

  it("selects reviews_total and reviews_ship_it columns", () => {
    const query = buildFeaturesReviewsQuery("7d");
    expect(query).toContain("reviews_total");
    expect(query).toContain("reviews_ship_it");
  });

  it("groups by feature_prefix", () => {
    const query = buildFeaturesReviewsQuery("7d");
    expect(query).toContain("GROUP BY feature_prefix");
  });

  it("counts SHIP IT verdicts", () => {
    const query = buildFeaturesReviewsQuery("7d");
    expect(query).toContain("SHIP IT");
  });
});

describe("buildQueueFunnelQuery", () => {
  it("7d preset produces interval filter", () => {
    const query = buildQueueFunnelQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("custom range produces literal timestamp filter", () => {
    const query = buildQueueFunnelQuery({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "toDateTime('2026-04-07 23:59:59', 'America/Los_Angeles')",
    );
  });

  it("selects all 4 funnel count columns and avg_review_findings", () => {
    const query = buildQueueFunnelQuery("7d");
    expect(query).toContain("tasks_started");
    expect(query).toContain("tasks_approved");
    expect(query).toContain("tasks_merged");
    expect(query).toContain("tasks_blocked");
    expect(query).toContain("avg_review_findings");
  });

  it("filters to the 4 queue events", () => {
    const query = buildQueueFunnelQuery("7d");
    expect(query).toContain("shipwright_task_started");
    expect(query).toContain("shipwright_task_approved");
    expect(query).toContain("shipwright_task_merged");
    expect(query).toContain("shipwright_task_blocked");
  });

  it("avg_review_findings reads properties.findings from approved events", () => {
    const query = buildQueueFunnelQuery("7d");
    expect(query).toContain("properties.findings");
    expect(query).toContain("shipwright_task_approved");
  });
});

describe("buildQueueCycleStartedQuery", () => {
  it("7d preset produces interval filter", () => {
    const query = buildQueueCycleStartedQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("custom range produces literal timestamp filter", () => {
    const query = buildQueueCycleStartedQuery({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "toDateTime('2026-04-07 23:59:59', 'America/Los_Angeles')",
    );
  });

  it("filters to shipwright_task_started event", () => {
    const query = buildQueueCycleStartedQuery("7d");
    expect(query).toContain("event = 'shipwright_task_started'");
  });

  it("selects task_id and timestamp", () => {
    const query = buildQueueCycleStartedQuery("7d");
    expect(query).toContain("task_id");
    expect(query).toContain("timestamp");
  });

  it("guards on non-null coalesced task identity", () => {
    const query = buildQueueCycleStartedQuery("7d");
    expect(query).toContain(
      "isNotNull(coalesce(toString(properties.task_id), toString(properties.task)))",
    );
  });

  it("aliases coalesced task identity to task_id", () => {
    const query = buildQueueCycleStartedQuery("7d");
    expect(query).toContain(
      "coalesce(toString(properties.task_id), toString(properties.task)) AS task_id",
    );
  });
});

describe("buildQueueCycleMergedQuery", () => {
  it("7d preset produces interval filter", () => {
    const query = buildQueueCycleMergedQuery("7d");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now() - interval 7 day, 'America/Los_Angeles')",
    );
    expect(query).toMatchSnapshot();
  });

  it("custom range produces literal timestamp filter", () => {
    const query = buildQueueCycleMergedQuery({
      from: "2026-04-01",
      to: "2026-04-07",
    });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "toDateTime('2026-04-07 23:59:59', 'America/Los_Angeles')",
    );
  });

  it("filters to completion-alias events", () => {
    const query = buildQueueCycleMergedQuery("7d");
    expect(query).toContain("event IN (");
    expect(query).toContain("'shipwright_task_merged'");
  });

  it("selects task_id and timestamp", () => {
    const query = buildQueueCycleMergedQuery("7d");
    expect(query).toContain("task_id");
    expect(query).toContain("timestamp");
  });

  it("guards on non-null coalesced task identity", () => {
    const query = buildQueueCycleMergedQuery("7d");
    expect(query).toContain(
      "isNotNull(coalesce(toString(properties.task_id), toString(properties.task)))",
    );
  });

  it("aliases coalesced task identity to task_id", () => {
    const query = buildQueueCycleMergedQuery("7d");
    expect(query).toContain(
      "coalesce(toString(properties.task_id), toString(properties.task)) AS task_id",
    );
  });
});

// ─── PST timezone anchor ──────────────────────────────────────────────────────

describe("PST timezone anchor", () => {
  it("DASHBOARD_TZ constant is America/Los_Angeles", () => {
    // The constant locks the dashboard's reference timezone. Changing it
    // silently would shift every operator's wall-clock view of the data.
    expect(DASHBOARD_TZ).toBe("America/Los_Angeles");
  });

  const builders = [
    ["buildSummaryQuery", buildSummaryQuery] as const,
    ["buildSummaryCycleTimeQuery", buildSummaryCycleTimeQuery] as const,
    ["buildFeaturesTasksQuery", buildFeaturesTasksQuery] as const,
    ["buildFeaturesCiQuery", buildFeaturesCiQuery] as const,
    ["buildFeaturesReviewsQuery", buildFeaturesReviewsQuery] as const,
    ["buildQueueFunnelQuery", buildQueueFunnelQuery] as const,
    ["buildQueueCycleStartedQuery", buildQueueCycleStartedQuery] as const,
    ["buildQueueCycleMergedQuery", buildQueueCycleMergedQuery] as const,
    ["buildTrendsQuery", buildTrendsQuery] as const,
  ];
  for (const [name, builder] of builders) {
    it(`${name}("today") emits the timezone argument`, () => {
      expect(builder("today")).toContain("'America/Los_Angeles'");
    });
  }

  it("buildTrendsQuery day grouping wraps timestamp with toTimeZone", () => {
    const query = buildTrendsQuery("today", "day");
    expect(query).toContain(
      "toDate(toTimeZone(timestamp, 'America/Los_Angeles')) AS period",
    );
  });

  it("buildTrendsQuery week grouping wraps timestamp with toTimeZone", () => {
    const query = buildTrendsQuery("today", "week");
    expect(query).toContain(
      "toStartOfWeek(toTimeZone(timestamp, 'America/Los_Angeles')) AS period",
    );
  });

  it("buildSummaryCycleTimeQuery applies timezone to the completion timestamp", () => {
    // SM-1.3: single-event query filters on the completion event's
    // `timestamp` column (no merged_at alias). Regression guard for the TZ.
    const query = buildSummaryCycleTimeQuery("today");
    expect(query).toContain(
      "timestamp >= toStartOfDay(now(), 'America/Los_Angeles')",
    );
  });

  it("custom range applies timezone to both bounds", () => {
    const query = buildSummaryQuery({ from: "2026-04-01", to: "2026-04-03" });
    expect(query).toContain(
      "toDateTime('2026-04-01 00:00:00', 'America/Los_Angeles')",
    );
    expect(query).toContain(
      "toDateTime('2026-04-03 23:59:59', 'America/Los_Angeles')",
    );
  });

  it("does not emit any UTC-naive today() or interval expression", () => {
    // Catches a regression where a builder forgets to wrap with toStartOfDay.
    for (const [, builder] of builders) {
      const query = builder("today");
      // Must NOT use bare today() — that's UTC.
      expect(query).not.toMatch(/(?<!OfDay\()\btoday\(\)/);
      // Must NOT use bare "now() - interval" without toStartOfDay wrapping.
      expect(query).not.toMatch(/now\(\) - interval \d+ day(?!,)/);
    }
  });
});

// ─── UE-3.1: feature-breakdown avg uses bare typed props ─────────────────────

describe("UE-3.1: feature-breakdown avg_actual_h / avg_estimated_h use bare typed props", () => {
  it("avg_actual_h uses bare typed properties.actual_h, not toFloatOrZero(toString(...))", () => {
    const query = buildFeaturesTasksQuery("7d");
    expect(query).not.toContain("toFloatOrZero(toString(properties.actual_h))");
    expect(query).toContain("avg(properties.actual_h)");
  });

  it("avg_estimated_h uses bare typed properties.estimated_h, not toFloatOrZero(toString(...))", () => {
    const query = buildFeaturesTasksQuery("7d");
    expect(query).not.toContain(
      "toFloatOrZero(toString(properties.estimated_h))",
    );
    expect(query).toContain("avg(properties.estimated_h)");
  });
});

// ─── HogQL denylist guard (UE-1.2) ───────────────────────────────────────────

describe("HogQL denylist guard (UE-1.2)", () => {
  // All exported query builders. Any new builder added to queries.ts must
  // also be added here so denylist coverage is automatic.
  const allBuilders: Array<[string, (dateRange: QueryDateRange) => string]> = [
    ["buildSummaryQuery", buildSummaryQuery],
    ["buildSummaryCycleTimeQuery", buildSummaryCycleTimeQuery],
    ["buildFeaturesTasksQuery", buildFeaturesTasksQuery],
    ["buildFeaturesCiQuery", buildFeaturesCiQuery],
    ["buildFeaturesReviewsQuery", buildFeaturesReviewsQuery],
    ["buildQueueFunnelQuery", buildQueueFunnelQuery],
    ["buildQueueCycleStartedQuery", buildQueueCycleStartedQuery],
    ["buildQueueCycleMergedQuery", buildQueueCycleMergedQuery],
    ["buildTrendsQuery", buildTrendsQuery],
  ];

  // Representative date range that exercises the custom-range code path in
  // buildDateFilter — deterministic, no secrets, no network required.
  const DATE_RANGE: QueryDateRange = { from: "2026-01-01", to: "2026-03-31" };

  for (const [builderName, builder] of allBuilders) {
    for (const token of DENYLIST) {
      it(`${builderName} must not use ${token} (denylisted HogQL function)`, () => {
        const sql = builder(DATE_RANGE);
        expect(
          sql,
          `${builderName} must not use ${token} (denylisted HogQL function — PostHog returns 400 when this appears in a query)`,
        ).not.toContain(token);
      });
    }
  }
});
