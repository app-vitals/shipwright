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
  | { kind: "tokensTotals"; range: QueryDateRange }
  | { kind: "tokensBySessionType"; range: QueryDateRange }
  | { kind: "tokensByAgent"; range: QueryDateRange }
  | { kind: "tokensTrends"; range: QueryDateRange }
  | { kind: "tokensByAgentBySessionType"; range: QueryDateRange }
  | { kind: "tokensByAgentByCron"; range: QueryDateRange }
  | { kind: "tokensByAgentByModel"; range: QueryDateRange }
  | { kind: "tokensByAgentByCronModel"; range: QueryDateRange }
  | { kind: "costEfficiency"; range: QueryDateRange };

export type MetricQueryKind = MetricQuery["kind"];

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
}
