/**
 * metrics/src/types.ts
 * Shared types for the metrics module.
 */

/** Raw tabular query result (column names + typed rows) */
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
