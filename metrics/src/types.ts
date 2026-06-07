/**
 * metrics/src/types.ts
 * Shared types for the PostHog metrics module.
 */

/** Raw HogQL query result from PostHog API */
export interface HogQLResult {
  columns: string[];
  results: unknown[][];
  types: string[];
  hasMore?: boolean;
  limit?: number;
  offset?: number;
}

/** PostHog HogQL API response envelope */
export interface HogQLResponse {
  results: unknown[][];
  columns: string[];
  types: string[];
  hasMore: boolean;
  limit: number;
  offset: number;
  query_status?: {
    id: string;
    complete: boolean;
  };
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

/** PostHog client configuration */
export interface PostHogConfig {
  personalApiKey: string;
  projectId: string;
  baseUrl?: string; // defaults to https://us.posthog.com
}

/** PostHog HogQLMetadata API response */
export interface HogQLMetadataResponse {
  isValid: boolean;
  errors: Array<{ message: string; start?: number; end?: number }>;
  notices: Array<{ message: string; start?: number; end?: number }>;
}

/** Parsed result from validate() — isValid + errors only */
export interface HogQLValidationResult {
  isValid: boolean;
  errors: Array<{ message: string; start?: number; end?: number }>;
}

/** Fetch function type for DI */
export type FetchFn = typeof globalThis.fetch;
