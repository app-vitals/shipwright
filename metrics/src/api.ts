/**
 * metrics/src/api.ts
 * Metrics Hono sub-app factory.
 * Four endpoints: /metrics/summary, /metrics/trends, /metrics/features, /metrics/queue.
 */

import { join } from "node:path";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import type { AccountsClient } from "./lib/accounts-client.ts";
import { authMiddleware } from "./lib/api-auth.ts";
import type { AppHandler, AuthEnv, Caller } from "./lib/api-auth.ts";
import { ErrorSchema } from "./lib/api-schemas.ts";
import { registerWithAuthz } from "./lib/api-utils.ts";
import { createSessionMiddleware } from "./lib/session-middleware.ts";
import type { LocalEventStore } from "./local-store.ts";
import type { MetricsProvider } from "./metrics-provider.ts";
import { PostHogProvider } from "./providers/posthog-provider.ts";
import { renderDashboardPage } from "./dashboard/dashboard-page.ts";
import {
  resolveDateRangeForMeta,
  validateCustomRange,
  wrapResponse,
} from "./formatters.ts";
import { PostHogClientError, createPostHogClient } from "./posthog-client.ts";
import {
  buildFeaturesCiQuery,
  buildFeaturesReviewsQuery,
  buildFeaturesTasksQuery,
  buildQueueCycleMergedQuery,
  buildQueueCycleStartedQuery,
  buildQueueFunnelQuery,
  buildSummaryCycleTimeQuery,
  buildSummaryQuery,
  buildTokensByAgentQuery,
  buildTokensBySessionTypeQuery,
  buildTokensTotalsQuery,
  buildTokensTrendsQuery,
  buildTrendsQuery,
} from "./queries.ts";
import type { QueryDateRange, TrendsGroupBy } from "./queries.ts";
import {
  DateRangeQuerySchema,
  FeaturesResultSchema,
  QueueResultSchema,
  SummaryResultSchema,
  TokensResultSchema,
  TrendsQuerySchema,
  TrendsResultSchema,
} from "./schemas.ts";
import type { DateRange, HogQLResult } from "./types.ts";

// ─── DI interface ─────────────────────────────────────────────────────────────

export type PostHogClientLike = {
  query: (
    hogql: string,
    options?: { dateFrom?: string; dateTo?: string },
  ) => Promise<HogQLResult>;
};

export interface MetricsDeps {
  /**
   * Backend-agnostic read seam. When provided, all handler reads route through
   * it. When absent, a PostHogProvider is auto-constructed from the resolved
   * postHogClient + (optionally overridden) builder functions — so existing
   * `postHogClient` + `buildXQueryFn` DI tests behave identically.
   */
  provider?: MetricsProvider;
  postHogClient?: PostHogClientLike;
  buildSummaryQueryFn?: typeof buildSummaryQuery;
  buildSummaryCycleTimeQueryFn?: typeof buildSummaryCycleTimeQuery;
  buildTrendsQueryFn?: typeof buildTrendsQuery;
  buildFeaturesTasksQueryFn?: typeof buildFeaturesTasksQuery;
  buildFeaturesCiQueryFn?: typeof buildFeaturesCiQuery;
  buildFeaturesReviewsQueryFn?: typeof buildFeaturesReviewsQuery;
  buildQueueFunnelQueryFn?: typeof buildQueueFunnelQuery;
  buildQueueCycleStartedQueryFn?: typeof buildQueueCycleStartedQuery;
  buildQueueCycleMergedQueryFn?: typeof buildQueueCycleMergedQuery;
  buildTokensTotalsQueryFn?: typeof buildTokensTotalsQuery;
  buildTokensBySessionTypeQueryFn?: typeof buildTokensBySessionTypeQuery;
  buildTokensByAgentQueryFn?: typeof buildTokensByAgentQuery;
  buildTokensTrendsQueryFn?: typeof buildTokensTrendsQuery;
  dashboardDir?: string;
  sessionSecret?: string;
  /** Owner-gate: require OWNER role for session-cookie auth. Default false. */
  requireOwnerRole?: boolean;
  /** Optional single-token bearer gate (METRICS_DASHBOARD_TOKEN). Default off. */
  dashboardToken?: string;
  /** Offline mode: skip session auth and serve /dashboard as a default local user. Default false. */
  offlineMode?: boolean;
  /**
   * Local event store. When provided, the PostHog-shaped ingest route
   * `POST /batch/` is registered and writes batches to this store. When
   * absent, the route is NOT registered (404) — the default-mode flip is
   * deferred to a later task.
   */
  localStore?: LocalEventStore;
}

// ─── Route definitions (inlined) ─────────────────────────────────────────────

const summaryRoute = createRoute({
  method: "get",
  path: "/metrics/summary",
  summary: "All pipeline metrics",
  description:
    "Returns all Shipwright pipeline metrics: task counts, CI gates, simplify fixes, coverage, reviews, estimation accuracy.",
  request: { query: DateRangeQuerySchema },
  responses: {
    200: {
      description: "Summary metrics",
      content: { "application/json": { schema: SummaryResultSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "PostHog query error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const trendsRoute = createRoute({
  method: "get",
  path: "/metrics/trends",
  summary: "Time-series trend data",
  description: "Returns event counts grouped by day or week for trend charts.",
  request: { query: TrendsQuerySchema },
  responses: {
    200: {
      description: "Trends data",
      content: { "application/json": { schema: TrendsResultSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "PostHog query error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const featuresRoute = createRoute({
  method: "get",
  path: "/metrics/features",
  summary: "Per-feature-prefix pipeline metrics",
  description:
    "Returns per-feature-prefix aggregates: task count, avg hours, CI first-pass rate, review SHIP IT rate. Features are grouped by task ID prefix (e.g., MQ, DR).",
  request: { query: DateRangeQuerySchema },
  responses: {
    200: {
      description: "Feature breakdown metrics",
      content: { "application/json": { schema: FeaturesResultSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "PostHog query error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const queueRoute = createRoute({
  method: "get",
  path: "/metrics/queue",
  summary: "Queue throughput metrics",
  description:
    "Returns Shipwright v3 queue metrics: funnel counts, block rate, avg cycle time in days, and avg review findings.",
  request: { query: DateRangeQuerySchema },
  responses: {
    200: {
      description: "Queue metrics",
      content: { "application/json": { schema: QueueResultSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "PostHog query error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const tokensRoute = createRoute({
  method: "get",
  path: "/metrics/tokens",
  summary: "Agent token usage metrics",
  description:
    "Returns agent_token_usage token totals, per session_type breakdown, per agent_id breakdown, and daily trends.",
  request: { query: DateRangeQuerySchema },
  responses: {
    200: {
      description: "Token usage metrics",
      content: { "application/json": { schema: TokensResultSchema } },
    },
    400: {
      description: "Invalid parameters",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    500: {
      description: "PostHog query error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveDateRange(
  preset: string | undefined,
  from: string | undefined,
  to: string | undefined,
): QueryDateRange {
  if (
    preset === "today" ||
    preset === "7d" ||
    preset === "30d" ||
    preset === "90d"
  )
    return preset;
  if (from && to) return { from, to } as DateRange;
  return "today";
}

function rowToObject(
  result: HogQLResult,
  rowIndex = 0,
): Record<string, unknown> | null {
  if (!result.results[rowIndex]) return null;
  const row = result.results[rowIndex] as unknown[];
  return Object.fromEntries(result.columns.map((col, i) => [col, row[i]]));
}

function resultToRows(result: HogQLResult): Record<string, unknown>[] {
  return result.results.map((raw) =>
    Object.fromEntries(
      result.columns.map((col, i) => [col, (raw as unknown[])[i]]),
    ),
  );
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function handleQueryError(
  c: { json: (v: unknown, s: number) => Response },
  err: unknown,
): Response {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof PostHogClientError) {
    if (err.statusCode === 401) return c.json({ error: msg }, 401);
    return c.json({ error: msg }, 500);
  }
  return c.json({ error: msg }, 500);
}

// ─── Handler factory ─────────────────────────────────────────────────────────

/**
 * Resolve the active read provider. If `deps.provider` is set it wins;
 * otherwise a PostHogProvider is constructed over the resolved client +
 * builder overrides — reproducing the previous client.query(builder(...))
 * behavior exactly, so existing DI tests route through it unchanged.
 */
function resolveProvider(
  client: PostHogClientLike,
  deps?: MetricsDeps,
): MetricsProvider {
  if (deps?.provider) return deps.provider;
  return new PostHogProvider(client, {
    summary: deps?.buildSummaryQueryFn ?? buildSummaryQuery,
    summaryCycleTime:
      deps?.buildSummaryCycleTimeQueryFn ?? buildSummaryCycleTimeQuery,
    trends: deps?.buildTrendsQueryFn ?? buildTrendsQuery,
    featuresTasks: deps?.buildFeaturesTasksQueryFn ?? buildFeaturesTasksQuery,
    featuresCi: deps?.buildFeaturesCiQueryFn ?? buildFeaturesCiQuery,
    featuresReviews:
      deps?.buildFeaturesReviewsQueryFn ?? buildFeaturesReviewsQuery,
    queueFunnel: deps?.buildQueueFunnelQueryFn ?? buildQueueFunnelQuery,
    queueCycleStarted:
      deps?.buildQueueCycleStartedQueryFn ?? buildQueueCycleStartedQuery,
    queueCycleMerged:
      deps?.buildQueueCycleMergedQueryFn ?? buildQueueCycleMergedQuery,
    tokensTotals: deps?.buildTokensTotalsQueryFn ?? buildTokensTotalsQuery,
    tokensBySessionType:
      deps?.buildTokensBySessionTypeQueryFn ?? buildTokensBySessionTypeQuery,
    tokensByAgent: deps?.buildTokensByAgentQueryFn ?? buildTokensByAgentQuery,
    tokensTrends: deps?.buildTokensTrendsQueryFn ?? buildTokensTrendsQuery,
  });
}

export function createMetricsHandlers(
  client: PostHogClientLike,
  accountsClient: AccountsClient,
  deps?: MetricsDeps,
) {
  const provider = resolveProvider(client, deps);

  const handleSummary: AppHandler<typeof summaryRoute> = async (c) => {
    const { preset, from, to } = c.req.valid("query");

    if ((from && !to) || (!from && to)) {
      return c.json({ error: "custom range requires both from and to" }, 400);
    }
    if (from && to) {
      const rangeError = validateCustomRange(from, to);
      if (rangeError) return c.json({ error: rangeError }, 400);
    }

    const dateRange = resolveDateRange(preset, from, to);
    const dateRangeMeta = resolveDateRangeForMeta(preset, from, to);
    const startMs = Date.now(); // infra: request timing telemetry

    try {
      const [result, cycleTimeResult] = await Promise.all([
        provider.query({ kind: "summary", range: dateRange }),
        provider.query({ kind: "summaryCycleTime", range: dateRange }),
      ]);
      const row = rowToObject(result) ?? {};
      const cycleTimeRow = rowToObject(cycleTimeResult) ?? {};

      const ciTotal = toNum(row.ci_gates_total);
      const ciFirst = toNum(row.ci_first_pass);
      const reviewsTotal = toNum(row.reviews_total);
      const reviewsShipIt = toNum(row.reviews_ship_it);
      const avgActual = toNumOrNull(row.avg_actual_hours);
      const avgEstimated = toNumOrNull(row.avg_estimated_hours);
      const tasksCompleted = toNum(row.tasks_completed);
      const tasksBlocked = toNum(row.tasks_blocked);

      const ciFirstPassRate =
        ciTotal > 0 ? Math.round((ciFirst / ciTotal) * 10000) / 100 : null;
      const reviewShipItRate =
        reviewsTotal > 0
          ? Math.round((reviewsShipIt / reviewsTotal) * 10000) / 100
          : null;
      const estimationAccuracy =
        avgActual !== null && avgEstimated !== null && avgEstimated > 0
          ? Math.round((avgActual / avgEstimated - 1) * 100 * 100) / 100
          : null;
      const taskBlockedRate =
        tasksCompleted + tasksBlocked > 0
          ? Math.round(
              (tasksBlocked / (tasksCompleted + tasksBlocked)) * 10000,
            ) / 100
          : null;

      const avgFixCascadeDepthRaw = toNumOrNull(row.avg_fix_cascade_depth);
      // avgIf returns 0 when no rows match — treat 0 as null (no data)
      const avgFixCascadeDepth =
        avgFixCascadeDepthRaw === 0 ? null : avgFixCascadeDepthRaw;

      const avgCycleTimeRaw = toNumOrNull(cycleTimeRow.avg_cycle_time_hours);
      // avg returns 0 when no rows match — treat 0 as null (no data)
      const avgCycleTimeHours = avgCycleTimeRaw === 0 ? null : avgCycleTimeRaw;

      return c.json(
        wrapResponse(
          {
            tasksCompleted,
            tasksBlocked,
            taskBlockedRate,
            avgCycleTimeHours,
            avgActualHours: avgActual,
            avgEstimatedHours: avgEstimated,
            avgRetries: toNumOrNull(row.avg_retries),
            avgFilesChanged: toNumOrNull(row.avg_files_changed),
            ciGatesTotal: ciTotal,
            ciFirstPass: ciFirst,
            ciFirstPassRate,
            avgFixAttempts: toNumOrNull(row.avg_fix_attempts),
            simplifyTotal: toNum(row.simplify_total),
            simplifyTotalFixes: toNum(row.simplify_total_fixes),
            simplifyAvgDry: toNumOrNull(row.simplify_avg_dry),
            simplifyAvgDeadCode: toNumOrNull(row.simplify_avg_dead_code),
            simplifyAvgNaming: toNumOrNull(row.simplify_avg_naming),
            simplifyAvgComplexity: toNumOrNull(row.simplify_avg_complexity),
            simplifyAvgConsistency: toNumOrNull(row.simplify_avg_consistency),
            reviewsTotal,
            reviewsShipIt,
            reviewShipItRate,
            estimationAccuracy,
            complexityDist: {
              c1: toNum(row.complexity_1),
              c2: toNum(row.complexity_2),
              c3: toNum(row.complexity_3),
              c4: toNum(row.complexity_4),
              c5: toNum(row.complexity_5),
            },
            avgFixCascadeDepth,
          },
          {
            dateRange: dateRangeMeta,
            generatedAt: new Date().toISOString(), // infra: response envelope timestamp
            queryTimeMs: Date.now() - startMs, // infra: request timing telemetry
          },
        ),
        200,
      );
    } catch (err) {
      return handleQueryError(c, err);
    }
  };

  const handleTrends: AppHandler<typeof trendsRoute> = async (c) => {
    const { preset, from, to, groupBy } = c.req.valid("query");

    if ((from && !to) || (!from && to)) {
      return c.json({ error: "custom range requires both from and to" }, 400);
    }
    if (from && to) {
      const rangeError = validateCustomRange(from, to);
      if (rangeError) return c.json({ error: rangeError }, 400);
    }

    const dateRange = resolveDateRange(preset, from, to);
    const dateRangeMeta = resolveDateRangeForMeta(preset, from, to);
    const grouping = (groupBy ?? "day") as TrendsGroupBy;
    const startMs = Date.now(); // infra: request timing telemetry

    try {
      const result = await provider.query({
        kind: "trends",
        range: dateRange,
        groupBy: grouping,
      });

      const rows = result.results.map((raw) => {
        const row = Object.fromEntries(
          result.columns.map((col, i) => [col, (raw as unknown[])[i]]),
        );
        return {
          period: String(row.period ?? ""),
          tasksCompleted: toNum(row.tasks_completed),
          ciGates: toNum(row.ci_gates),
          ciFirstPass: toNum(row.ci_first_pass),
          ciFirstPassCount: toNum(row.ci_first_pass_count),
          simplifyPasses: toNum(row.simplify_passes),
          simplifyFixes: toNum(row.simplify_fixes),
          tasksBlocked: toNum(row.tasks_blocked),
          reviews: toNum(row.reviews),
          tasksStarted: toNum(row.tasks_started),
          reviewsShipIt: toNum(row.reviews_ship_it),
          avgActualHours: toNumOrNull(row.avg_actual_hours),
          avgEstimatedHours: toNumOrNull(row.avg_estimated_hours),
          avgRetries: toNumOrNull(row.avg_retries),
          avgFilesChanged: toNumOrNull(row.avg_files_changed),
          avgFixAttempts: toNumOrNull(row.avg_fix_attempts),
          avgCycleTimeHours: toNumOrNull(row.avg_cycle_time_hours),
          estimationAccuracy: toNumOrNull(row.estimation_accuracy),
          simplifyAvgDry: toNumOrNull(row.simplify_avg_dry),
          simplifyAvgDeadCode: toNumOrNull(row.simplify_avg_dead_code),
          simplifyAvgNaming: toNumOrNull(row.simplify_avg_naming),
          simplifyAvgComplexity: toNumOrNull(row.simplify_avg_complexity),
          simplifyAvgConsistency: toNumOrNull(row.simplify_avg_consistency),
          avgReviewFindings: toNumOrNull(row.avg_review_findings),
        };
      });

      return c.json(
        wrapResponse(
          { rows },
          {
            dateRange: dateRangeMeta,
            generatedAt: new Date().toISOString(), // infra: response envelope timestamp
            queryTimeMs: Date.now() - startMs, // infra: request timing telemetry
          },
        ),
        200,
      );
    } catch (err) {
      return handleQueryError(c, err);
    }
  };

  const handleFeatures: AppHandler<typeof featuresRoute> = async (c) => {
    const { preset, from, to } = c.req.valid("query");

    if ((from && !to) || (!from && to)) {
      return c.json({ error: "custom range requires both from and to" }, 400);
    }
    if (from && to) {
      const rangeError = validateCustomRange(from, to);
      if (rangeError) return c.json({ error: rangeError }, 400);
    }

    const dateRange = resolveDateRange(preset, from, to);
    const dateRangeMeta = resolveDateRangeForMeta(preset, from, to);
    const startMs = Date.now(); // infra: request timing telemetry

    try {
      const [tasksResult, ciResult, reviewsResult] = await Promise.all([
        provider.query({ kind: "featuresTasks", range: dateRange }),
        provider.query({ kind: "featuresCi", range: dateRange }),
        provider.query({ kind: "featuresReviews", range: dateRange }),
      ]);

      // Build lookup maps from CI and reviews results
      const ciByPrefix = new Map<
        string,
        { total: number; firstPass: number }
      >();
      for (const raw of ciResult.results) {
        const row = Object.fromEntries(
          ciResult.columns.map((col, i) => [col, (raw as unknown[])[i]]),
        );
        const prefix = String(row.feature_prefix ?? "");
        if (prefix) {
          ciByPrefix.set(prefix, {
            total: toNum(row.ci_total),
            firstPass: toNum(row.ci_first_pass),
          });
        }
      }

      const reviewsByPrefix = new Map<
        string,
        { total: number; shipIt: number }
      >();
      for (const raw of reviewsResult.results) {
        const row = Object.fromEntries(
          reviewsResult.columns.map((col, i) => [col, (raw as unknown[])[i]]),
        );
        const prefix = String(row.feature_prefix ?? "");
        if (prefix) {
          reviewsByPrefix.set(prefix, {
            total: toNum(row.reviews_total),
            shipIt: toNum(row.reviews_ship_it),
          });
        }
      }

      const features = tasksResult.results.map((raw) => {
        const row = Object.fromEntries(
          tasksResult.columns.map((col, i) => [col, (raw as unknown[])[i]]),
        );
        const prefix = String(row.feature_prefix ?? "");
        const avgActualH = toNumOrNull(row.avg_actual_h);
        const avgEstimatedH = toNumOrNull(row.avg_estimated_h);

        const ci = ciByPrefix.get(prefix);
        const ciFirstPassRate =
          ci && ci.total > 0
            ? Math.round((ci.firstPass / ci.total) * 10000) / 100
            : null;

        const reviews = reviewsByPrefix.get(prefix);
        const reviewShipItRate =
          reviews && reviews.total > 0
            ? Math.round((reviews.shipIt / reviews.total) * 10000) / 100
            : null;

        return {
          prefix,
          tasksCompleted: toNum(row.tasks_completed),
          avgActualH,
          avgEstimatedH,
          ciFirstPassRate,
          reviewShipItRate,
        };
      });

      return c.json(
        wrapResponse(
          { features },
          {
            dateRange: dateRangeMeta,
            generatedAt: new Date().toISOString(), // infra: response envelope timestamp
            queryTimeMs: Date.now() - startMs, // infra: request timing telemetry
          },
        ),
        200,
      );
    } catch (err) {
      return handleQueryError(c, err);
    }
  };

  const handleQueue: AppHandler<typeof queueRoute> = async (c) => {
    const { preset, from, to } = c.req.valid("query");

    if ((from && !to) || (!from && to)) {
      return c.json({ error: "custom range requires both from and to" }, 400);
    }
    if (from && to) {
      const rangeError = validateCustomRange(from, to);
      if (rangeError) return c.json({ error: rangeError }, 400);
    }

    const dateRange = resolveDateRange(preset, from, to);
    const dateRangeMeta = resolveDateRangeForMeta(preset, from, to);
    const startMs = Date.now(); // infra: request timing telemetry

    try {
      const [funnelResult, cycleStartedResult, cycleMergedResult] =
        await Promise.all([
          provider.query({ kind: "queueFunnel", range: dateRange }),
          provider.query({ kind: "queueCycleStarted", range: dateRange }),
          provider.query({ kind: "queueCycleMerged", range: dateRange }),
        ]);

      const funnelRow = rowToObject(funnelResult) ?? {};

      const tasksStarted = toNum(funnelRow.tasks_started);
      const tasksApproved = toNum(funnelRow.tasks_approved);
      const tasksMerged = toNum(funnelRow.tasks_merged);
      const tasksBlocked = toNum(funnelRow.tasks_blocked);

      // blockRate = (tasksBlocked / tasksStarted) * 100, null when tasksStarted = 0
      const blockRate =
        tasksStarted > 0
          ? Math.round((tasksBlocked / tasksStarted) * 10000) / 100
          : null;

      // avgReviewFindings — avg returns 0 when no matching rows, treat as null
      const avgReviewFindingsRaw = toNumOrNull(funnelRow.avg_review_findings);
      const avgReviewFindings =
        avgReviewFindingsRaw === 0 ? null : avgReviewFindingsRaw;

      // avgCycleTimeDays: TypeScript join of started + merged by task_id
      const startedMap = new Map<string, number>();
      for (const raw of cycleStartedResult.results) {
        const row = Object.fromEntries(
          cycleStartedResult.columns.map((col, i) => [
            col,
            (raw as unknown[])[i],
          ]),
        );
        const taskId = String(row.task_id ?? "");
        if (taskId) {
          startedMap.set(taskId, new Date(String(row.timestamp)).getTime());
        }
      }

      let totalDays = 0;
      let matchCount = 0;
      for (const raw of cycleMergedResult.results) {
        const row = Object.fromEntries(
          cycleMergedResult.columns.map((col, i) => [
            col,
            (raw as unknown[])[i],
          ]),
        );
        const taskId = String(row.task_id ?? "");
        const startedMs = startedMap.get(taskId);
        if (startedMs !== undefined) {
          const mergedMs = new Date(String(row.timestamp)).getTime();
          const diffDays = (mergedMs - startedMs) / (1000 * 60 * 60 * 24);
          totalDays += diffDays;
          matchCount++;
        }
      }

      const avgCycleTimeDays = matchCount > 0 ? totalDays / matchCount : null;

      return c.json(
        wrapResponse(
          {
            tasksStarted,
            tasksMerged,
            tasksBlocked,
            tasksApproved,
            blockRate,
            avgCycleTimeDays,
            avgReviewFindings,
          },
          {
            dateRange: dateRangeMeta,
            generatedAt: new Date().toISOString(), // infra: response envelope timestamp
            queryTimeMs: Date.now() - startMs, // infra: request timing telemetry
          },
        ),
        200,
      );
    } catch (err) {
      return handleQueryError(c, err);
    }
  };

  const handleTokens: AppHandler<typeof tokensRoute> = async (c) => {
    const { preset, from, to } = c.req.valid("query");

    if ((from && !to) || (!from && to)) {
      return c.json({ error: "custom range requires both from and to" }, 400);
    }
    if (from && to) {
      const rangeError = validateCustomRange(from, to);
      if (rangeError) return c.json({ error: rangeError }, 400);
    }

    const dateRange = resolveDateRange(preset, from, to);
    const dateRangeMeta = resolveDateRangeForMeta(preset, from, to);
    const startMs = Date.now();

    try {
      const [totalsResult, bySessionTypeResult, byAgentResult, trendsResult] =
        await Promise.all([
          provider.query({ kind: "tokensTotals", range: dateRange }),
          provider.query({ kind: "tokensBySessionType", range: dateRange }),
          provider.query({ kind: "tokensByAgent", range: dateRange }),
          provider.query({ kind: "tokensTrends", range: dateRange }),
        ]);

      const totalsRow = rowToObject(totalsResult) ?? {};
      const totals = {
        input: toNum(totalsRow.input_tokens),
        output: toNum(totalsRow.output_tokens),
        cacheRead: toNum(totalsRow.cache_read_input_tokens),
        cacheCreation: toNum(totalsRow.cache_creation_input_tokens),
        total: toNum(totalsRow.total_tokens),
      };

      const bySessionType = resultToRows(bySessionTypeResult).map((row) => ({
        sessionType: String(row.session_type ?? ""),
        input: toNum(row.input_tokens),
        output: toNum(row.output_tokens),
        cacheRead: toNum(row.cache_read_input_tokens),
        cacheCreation: toNum(row.cache_creation_input_tokens),
        total: toNum(row.total_tokens),
      }));

      const byAgentRaw = resultToRows(byAgentResult).map((row) => ({
        agentId: String(row.agent_id ?? ""),
        input: toNum(row.input_tokens),
        output: toNum(row.output_tokens),
        cacheRead: toNum(row.cache_read_input_tokens),
        cacheCreation: toNum(row.cache_creation_input_tokens),
        total: toNum(row.total_tokens),
      }));

      const agentNameMap = new Map<string, string>();
      if (byAgentRaw.length > 0) {
        try {
          const users = await accountsClient.listUsers();
          for (const user of users) {
            agentNameMap.set(user.id, user.name);
          }
        } catch (e) {
          process.stderr.write(
            `[metrics-api] listUsers failed — agentName resolution skipped: ${String(e)}\n`,
          );
        }
      }

      const byAgent = byAgentRaw.map((row) => ({
        ...row,
        agentName: agentNameMap.get(row.agentId),
      }));

      const trends = resultToRows(trendsResult).map((row) => ({
        date: String(row.period ?? ""),
        input: toNum(row.input_tokens),
        output: toNum(row.output_tokens),
        cacheRead: toNum(row.cache_read_input_tokens),
        cacheCreation: toNum(row.cache_creation_input_tokens),
        total: toNum(row.total_tokens),
      }));

      return c.json(
        wrapResponse(
          { totals, bySessionType, byAgent, trends },
          {
            dateRange: dateRangeMeta,
            generatedAt: new Date().toISOString(),
            queryTimeMs: Date.now() - startMs,
          },
        ),
        200,
      );
    } catch (err) {
      return handleQueryError(c, err);
    }
  };

  return {
    handleSummary,
    handleTrends,
    handleFeatures,
    handleQueue,
    handleTokens,
  };
}

// ─── Sub-app factory ──────────────────────────────────────────────────────────

/**
 * Combined auth middleware for /metrics/* routes.
 * Accepts either a valid Bearer token (service-to-service) OR a valid
 * vitals_session cookie (browser dashboard). Returns 401 JSON on failure
 * so API clients get a machine-readable error rather than a redirect.
 *
 * Owner gate:
 * - Bearer token path: scoped tokens (scope !== "*") are rejected with 403.
 * - Session cookie path: if accountsClient is provided, the user's role is
 *   checked; non-OWNER roles are rejected with 401.
 */
function createCombinedAuthMiddleware(
  apiKeys: Map<string, Caller>,
  sessionSecret: string,
  accountsClient?: AccountsClient,
  requireOwnerRole = false,
  dashboardToken?: string,
) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    // 1. Try bearer token first
    const header = c.req.header("Authorization")?.trim();
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (token) {
      // dashboardToken is a single admin bearer token (takes priority over apiKeys)
      if (dashboardToken && token === dashboardToken) {
        c.set("caller", { name: "dashboard-token", scope: "*" });
        return next();
      }
      const caller = apiKeys.get(token);
      if (caller) {
        // Scoped tokens (clientId scope) are forbidden from the metrics API
        if (caller.scope !== "*") {
          return c.json({ error: "Forbidden" }, 403);
        }
        c.set("caller", caller);
        return next();
      }
    }

    // 2. Try session cookie
    if (sessionSecret) {
      const sessionToken = getCookie(c, "vitals_session");
      if (sessionToken) {
        try {
          const payload = (await verify(
            sessionToken,
            sessionSecret,
            "HS256",
          )) as Record<string, unknown>;
          const { userId, email, name } = payload;
          if (
            typeof userId === "string" &&
            userId &&
            typeof email === "string" &&
            email &&
            typeof name === "string" &&
            name
          ) {
            // Owner role gate — only when requireOwnerRole is true AND accountsClient is wired
            if (requireOwnerRole && accountsClient) {
              const user = await accountsClient.getUser(userId);
              if (user.role !== "OWNER") {
                return c.json({ error: "Forbidden" }, 401);
              }
            }
            // Session valid — set a synthetic caller for metrics handlers
            c.set("caller", { name: email, scope: "*" });
            return next();
          }
        } catch {
          // Invalid JWT — fall through to 401
        }
      }
    }

    return c.json({ error: "Unauthorized" }, 401);
  });
}

export function createMetricsApp(
  apiKeys: Map<string, Caller>,
  accountsClient: AccountsClient,
  deps?: MetricsDeps,
): OpenAPIHono<AuthEnv> {
  const client: PostHogClientLike =
    deps?.postHogClient ??
    createPostHogClient({
      personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY ?? "",
      projectId: process.env.POSTHOG_PROJECT_ID ?? "",
    });

  const sessionSecret = deps?.sessionSecret ?? process.env.SESSION_SECRET ?? "";
  const requireOwnerRole = deps?.requireOwnerRole ?? false;
  const dashboardToken = deps?.dashboardToken;
  const offlineMode = deps?.offlineMode ?? false;

  const app = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issues = result.error.issues;
        const message = issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ");
        return c.json({ error: message }, 400);
      }
    },
  });

  app.onError((err, c) => {
    console.error("unhandled error:", err);
    return c.json({ error: err.message }, 500);
  });

  // Health check — no auth required
  app.get("/health", (c) => c.json({ status: "ok" }, 200));

  // /metrics/* — accepts bearer token OR session cookie; returns 401 JSON on failure
  app.use(
    "/metrics/*",
    createCombinedAuthMiddleware(
      apiKeys,
      sessionSecret,
      accountsClient,
      requireOwnerRole,
      dashboardToken,
    ),
  );

  const handlers = createMetricsHandlers(client, accountsClient, deps);
  // Metrics combined-auth middleware accepts either an admin bearer token
  // (scope === "*", scoped tokens already 403'd above) or an OWNER session
  // cookie. The kind="custom" policy documents that this dual gate is
  // applied at middleware-time, not in the route handler.
  const metricsPolicy = {
    kind: "custom" as const,
    check: () => {},
    justification:
      "Mixed auth: admin bearer token OR OWNER session cookie (enforced by createCombinedAuthMiddleware on /metrics/*)",
  };
  registerWithAuthz(app, summaryRoute, metricsPolicy, handlers.handleSummary);
  registerWithAuthz(app, trendsRoute, metricsPolicy, handlers.handleTrends);
  registerWithAuthz(app, featuresRoute, metricsPolicy, handlers.handleFeatures);
  registerWithAuthz(app, queueRoute, metricsPolicy, handlers.handleQueue);
  registerWithAuthz(app, tokensRoute, metricsPolicy, handlers.handleTokens);

  // ─── Ingest: POST /batch/ (local-store mode only) ─────────────────────────
  //
  // PostHog-shaped batch ingest. Mounted as a plain route (NOT behind the
  // /metrics/* combined-auth middleware) to mirror PostHog's unauthenticated
  // transport — the api_key travels in the body. Registered ONLY when a local
  // store is injected; otherwise the route is absent (404).
  const localStore = deps?.localStore;
  if (localStore) {
    app.post("/batch/", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      if (
        !body ||
        typeof body !== "object" ||
        !Array.isArray((body as { batch?: unknown }).batch)
      ) {
        return c.json({ error: "body must include a 'batch' array" }, 400);
      }

      const batch = (body as { batch: unknown[] }).batch;
      for (const raw of batch) {
        if (!raw || typeof raw !== "object") continue;
        const ev = raw as Record<string, unknown>;
        if (typeof ev.event !== "string" || !ev.event) continue;
        const properties =
          ev.properties && typeof ev.properties === "object"
            ? (ev.properties as Record<string, unknown>)
            : {};
        const insertId = properties.$insert_id;
        localStore.insertEvent({
          insertId: typeof insertId === "string" ? insertId : null,
          event: ev.event,
          distinctId:
            typeof ev.distinct_id === "string" ? ev.distinct_id : null,
          timestamp: typeof ev.timestamp === "string" ? ev.timestamp : "",
          properties,
        });
      }

      return c.json({ status: 1 }, 200);
    });
  }

  // ─── Dashboard static files ───────────────────────────────────────────────

  const dashboardDir = deps?.dashboardDir ?? join(import.meta.dir, "dashboard");

  const STATIC_FILES: Record<
    string,
    { contentType: string; file: string; cache?: string }
  > = {
    "/dashboard/styles.css": {
      contentType: "text/css; charset=utf-8",
      file: "styles.css",
      cache: "public, max-age=3600",
    },
    "/dashboard/app.js": {
      contentType: "application/javascript; charset=utf-8",
      file: "app.js",
    },
  };

  // Dashboard routes are protected by session cookie — redirect to /auth/login on failure
  // In offline mode: skip session auth entirely and inject a default local user
  if (!offlineMode) {
    app.use("/dashboard", createSessionMiddleware(sessionSecret));
    app.use("/dashboard/*", createSessionMiddleware(sessionSecret));
  }

  // /dashboard — server-rendered with shared toolbar and user name from session
  app.get("/dashboard", async (c) => {
    // Offline mode: inject a default local user, skip all session/owner checks
    if (offlineMode) {
      const body = renderDashboardPage({
        userName: "Offline User",
        isOwner: true,
      });
      return new Response(body, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const sessionToken = getCookie(c, "vitals_session");
    let userName = "Unknown";
    let userId: string | undefined;
    if (sessionToken && sessionSecret) {
      try {
        const p = (await verify(
          sessionToken,
          sessionSecret,
          "HS256",
        )) as Record<string, unknown>;
        if (typeof p.userId === "string" && p.userId) {
          userId = p.userId;
        }
        if (typeof p.name === "string" && p.name) {
          userName = p.name;
        } else if (typeof p.email === "string" && p.email) {
          userName = p.email;
        }
      } catch {
        // Session middleware already validated — this shouldn't fail
      }
    }

    // Owner gate: only check if requireOwnerRole is explicitly enabled
    if (requireOwnerRole && accountsClient && userId) {
      const user = await accountsClient.getUser(userId);
      if (user.role !== "OWNER") {
        const body = renderDashboardPage({ userName, isOwner: false });
        return new Response(body, {
          status: 403,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    const body = renderDashboardPage({ userName, isOwner: true });
    return new Response(body, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  for (const [path, { contentType, file, cache }] of Object.entries(
    STATIC_FILES,
  )) {
    app.get(path, async (c) => {
      try {
        const body = await Bun.file(join(dashboardDir, file)).text();
        const headers: Record<string, string> = { "Content-Type": contentType };
        if (cache) headers["Cache-Control"] = cache;
        return new Response(body, { headers });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return c.json({ error: "Not found" }, 404);
        }
        console.error(`Static file error [${file}]:`, err);
        return c.json({ error: "Internal server error" }, 500);
      }
    });
  }

  return app;
}
