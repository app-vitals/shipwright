/**
 * metrics/src/types.ts
 * Shared types for the metrics module.
 */

/**
 * Tabular query result shape every provider returns.
 *
 * Historically this mirrored PostHog's HogQL response; it is now a
 * backend-agnostic table (columns + row tuples) produced by the
 * TaskStoreProvider. The name is retained to avoid churn across the handler
 * layer that consumes it.
 */
export interface HogQLResult {
  columns: string[];
  results: unknown[][];
  types: string[];
  hasMore?: boolean;
  limit?: number;
  offset?: number;
}

/** Date range preset or custom range */
export type DatePreset = "today" | "7d" | "30d" | "90d";

export interface DateRange {
  from: string; // ISO date string (YYYY-MM-DD)
  to: string; // ISO date string (YYYY-MM-DD)
}

/** Resolved date range (always has from/to) */
export interface ResolvedDateRange {
  from: string;
  to: string;
  preset?: DatePreset;
}

/** Date range accepted by the provider query seam — preset or custom range. */
export type QueryDateRange = DatePreset | DateRange;

/** Trend bucketing granularity. */
export type TrendsGroupBy = "day" | "week" | "hour";

/** Wall-clock timezone all dashboard date math is anchored to. */
export const DASHBOARD_TZ = "America/Los_Angeles";
