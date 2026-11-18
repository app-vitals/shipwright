/**
 * metrics/src/metrics-provider.ts
 * Backend-agnostic read seam for the metrics dashboard.
 *
 * A `MetricsProvider` answers typed `MetricQuery` requests and returns a
 * `MetricTable` (an alias of the shared result shape) so the handlers in
 * api.ts are identical regardless of which backend served the data.
 * No HogQL string ever crosses the handler↔provider boundary.
 */

import type { DatePreset, DateRange, HogQLResult } from "./types.ts";

/** Preset or custom date range accepted by all metric queries. */
export type QueryDateRange = DatePreset | DateRange;

/** Grouping granularity for the trends endpoint. */
export type TrendsGroupBy = "day" | "week" | "hour";

/** Grouping granularity for the merged-PRs-by-repo endpoint (no "hour" bucket — PR merges are sparse enough that day/week are the only useful buckets). */
type MergedPrsGroupBy = "day" | "week";

/** Dashboard timezone — all date windows are anchored to LA wall clock. */
export const DASHBOARD_TZ = "America/Los_Angeles";

/** Result shape every backend returns — an alias, NOT a narrowing. */
export type MetricTable = HogQLResult;

/** The typed read queries the dashboard issues. */
export type MetricQuery =
  | { kind: "summary"; range: QueryDateRange }
  | { kind: "summaryCycleTime"; range: QueryDateRange }
  | { kind: "trends"; range: QueryDateRange; groupBy: TrendsGroupBy }
  | { kind: "featuresTasks"; range: QueryDateRange }
  | { kind: "featuresCi"; range: QueryDateRange }
  | { kind: "featuresReviews"; range: QueryDateRange }
  | { kind: "queueFunnel"; range: QueryDateRange }
  | { kind: "queueCycleStarted"; range: QueryDateRange }
  | { kind: "queueCycleMerged"; range: QueryDateRange }
  | {
      kind: "mergedPrsByRepo";
      range: QueryDateRange;
      groupBy: MergedPrsGroupBy;
    }
  // Latest coverage per repo (always "now") + a trend over `range`
  // (defaults to "today", like the other endpoints).
  | { kind: "coverage"; range?: QueryDateRange }
  | { kind: "prOutcomes"; range: QueryDateRange }
  | { kind: "tokensTotals"; range: QueryDateRange }
  | { kind: "tokensBySessionType"; range: QueryDateRange }
  | { kind: "tokensByAgent"; range: QueryDateRange }
  | { kind: "tokensTrends"; range: QueryDateRange }
  | { kind: "tokensByAgentBySessionType"; range: QueryDateRange }
  | { kind: "tokensByAgentByCron"; range: QueryDateRange }
  | { kind: "tokensByAgentByModel"; range: QueryDateRange }
  | { kind: "tokensByAgentByCronModel"; range: QueryDateRange }
  | { kind: "costEfficiency"; range: QueryDateRange };

// ─── System-cron work metrics (SCM-8.3) ─────────────────────────────────────

/** Task-store `GET /tasks` params that list exactly the rows behind a count. */
export type DrillDownFilter = Record<string, string>;

/** A count plus the filter params of its drill-down list. */
export interface FilteredCount {
  count: number;
  filter: DrillDownFilter;
}

/** One registered system cron's work over the queried range. */
export interface SystemCronMetricsRow {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  /** Distinct fired slots that created at least one task in range. */
  fires: FilteredCount;
  /** SC- tasks created in range. Equals the sum of `buckets`. */
  tasksCreated: FilteredCount;
  buckets: {
    shipped: FilteredCount;
    inFlight: FilteredCount;
    stuck: FilteredCount;
    failed: FilteredCount;
    noOp: FilteredCount;
    pending: FilteredCount;
  };
  /** Cron-origin tasks (same originRef) whose source is not system-cron. */
  followOn: { created: FilteredCount; shipped: FilteredCount };
}

export interface SystemCronMetrics {
  from: string;
  to: string;
  crons: SystemCronMetricsRow[];
  meta: {
    generatedAt: string;
    /** Distinct repos across the cron-origin tasks in range. */
    repoCount: number;
    /** The account every registered cron belongs to; null when mixed/none. */
    accountId: string | null;
  };
}

/**
 * Read seam: every backend serves every query kind.
 *
 * Repo scoping (public mode, PPL-1.2) is a constructor-level concern, not a
 * query parameter — a repo-scoped provider is built once (see
 * TaskStoreProvider's `repo` ctor param) and narrows every read it answers. The
 * MetricQuery shape is therefore unchanged: handlers stay repo-agnostic and the
 * same code serves authenticated (all repos) and public (one repo) surfaces.
 */
export interface MetricsProvider {
  query(q: MetricQuery): Promise<MetricTable>;
  /**
   * System-cron work metrics (SCM-8.3). Optional: only the task-store-backed
   * provider implements it; the /metrics/system-crons route answers 501
   * otherwise.
   */
  systemCrons?(range: QueryDateRange): Promise<SystemCronMetrics>;
}
