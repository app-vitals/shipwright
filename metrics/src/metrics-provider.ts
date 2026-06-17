/**
 * metrics/src/metrics-provider.ts
 * Backend-agnostic read seam for the metrics dashboard.
 *
 * A `MetricsProvider` answers typed `MetricQuery` requests and returns a
 * `MetricTable` (an alias of the existing PostHog result shape) so the
 * handlers in api.ts are identical regardless of which backend served the
 * data. PostHog and SQLite both implement this; no HogQL string ever crosses
 * the handler↔provider boundary.
 */

import type { QueryDateRange, TrendsGroupBy } from "./queries.ts";
import type { HogQLResult } from "./types.ts";

/** Result shape every backend returns — an alias, NOT a narrowing. */
export type MetricTable = HogQLResult;

/** The 13 typed read queries the dashboard issues. */
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
  | { kind: "tokensByAgentByModel"; range: QueryDateRange };

export type MetricQueryKind = MetricQuery["kind"];

/** Read seam: every backend serves every query kind. */
export interface MetricsProvider {
  query(q: MetricQuery): Promise<MetricTable>;
}
