/**
 * metrics/src/api.ts
 * Metrics Hono sub-app factory.
 * Five endpoints: /metrics/summary, /metrics/trends, /metrics/features,
 * /metrics/queue, /metrics/tokens.
 */

import { join } from "node:path";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import { renderDashboardPage } from "./dashboard/dashboard-page.ts";
import {
  resolveDateRangeForMeta,
  validateCustomRange,
  wrapResponse,
} from "./formatters.ts";
import type { AccountsClient } from "./lib/accounts-client.ts";
import type { AppHandler, AuthEnv, Caller } from "./lib/api-auth.ts";
import { ErrorSchema } from "./lib/api-schemas.ts";
import { registerWithAuthz } from "./lib/api-utils.ts";
import {
  SESSION_COOKIE,
  createSessionMiddleware,
} from "./lib/session-middleware.ts";
import type {
  MetricsProvider,
  QueryDateRange,
  TrendsGroupBy,
} from "./metrics-provider.ts";
import {
  CostEfficiencyResultSchema,
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

export interface MetricsDeps {
  /**
   * Backend-agnostic read seam. Required for all metric queries.
   */
  provider?: MetricsProvider;
  dashboardDir?: string;
  sessionSecret?: string;
  /** Owner-gate: require OWNER role for session-cookie auth. Default false. */
  requireOwnerRole?: boolean;
  /** Optional single-token bearer gate (METRICS_DASHBOARD_TOKEN). Default off. */
  dashboardToken?: string;
  /** Offline mode: skip session auth and serve /dashboard as a default local user. Default false. */
  offlineMode?: boolean;
  /**
   * Local-development auth bypass. Unlike offlineMode (which swaps in fixture
   * data), this keeps the real injected provider but relaxes auth so both
   * /dashboard AND /metrics/* are reachable with no session cookie and no
   * Bearer token — there is no login flow in the local `task stack`. The
   * metrics analogue of the admin service's ADMIN_DEV_AUTH. Default false.
   */
  dashboardDevAuth?: boolean;
  /** URL path prefix the app is mounted at (e.g. "/sw"). Injected into dashboard HTML for asset + API fetch URLs. */
  basePath?: string;
  /**
   * Base URL of the admin service (e.g. "http://localhost:3001"), used to make the
   * dashboard toolbar's Agents/Tasks/PRs links absolute when the admin console runs
   * on a different origin (local `task stack`). Falls back to METRICS_ADMIN_APP_URL,
   * then "" (same-origin relative links — the default for single-host ingress).
   */
  adminBaseUrl?: string;
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
      description: "Query error",
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
      description: "Query error",
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
      description: "Query error",
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
      description: "Query error",
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
      description: "Query error",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const costEfficiencyRoute = createRoute({
  method: "get",
  path: "/metrics/cost-efficiency",
  summary: "Cost efficiency metrics",
  description:
    "Returns fleet-wide and per-cron×model cost efficiency: routed cost vs all-Opus counterfactual. Run/cron-centric — no task dependency.",
  request: { query: DateRangeQuerySchema },
  responses: {
    200: {
      description: "Cost efficiency metrics",
      content: { "application/json": { schema: CostEfficiencyResultSchema } },
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
      description: "Query error",
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
  return c.json({ error: msg }, 500);
}

// ─── Provider-bound handler factories ────────────────────────────────────────
//
// The summary/trends/features/queue handlers depend only on a MetricsProvider,
// so they are extracted into factories that close over the provider. Both the
// authenticated app (createMetricsApp) and the public app
// (createPublicMetricsApp) register the same handler logic against their own
// route definitions — no duplicated aggregation code.

function makeCostEfficiencyHandler(
  provider: MetricsProvider,
): AppHandler<typeof costEfficiencyRoute> {
  return async (c) => {
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
      const result = await provider.query({ kind: "costEfficiency", range: dateRange });

      const scopeIdx = result.columns.indexOf("scope");
      const modelIdx = result.columns.indexOf("model_family");
      const routedIdx = result.columns.indexOf("routed_usd");
      const opusIdx = result.columns.indexOf("opus_usd");
      const savingsIdx = result.columns.indexOf("savings_usd");

      const fleetByModel: Array<{
        modelFamily: string;
        routedUsd: number;
        counterfactualOpusUsd: number;
        savingsUsd: number;
      }> = [];

      const byAgentModel: Array<{
        agentId: string;
        modelFamily: string;
        routedUsd: number;
        counterfactualOpusUsd: number;
        savingsUsd: number;
        savingsPct: number | null;
      }> = [];

      const byCronModel: Array<{
        cronKey: string;
        modelFamily: string;
        routedUsd: number;
        counterfactualOpusUsd: number;
        savingsUsd: number;
      }> = [];

      let fleetRoutedUsd = 0;
      let fleetOpusUsd = 0;

      for (const row of result.results) {
        const scope = row[scopeIdx] as string;
        const modelFamily = row[modelIdx] as string;
        const routedUsd = toNum(row[routedIdx]);
        const opusUsd = toNum(row[opusIdx]);
        const savingsUsd = toNum(row[savingsIdx]);

        if (scope === "fleet") {
          fleetByModel.push({ modelFamily, routedUsd, counterfactualOpusUsd: opusUsd, savingsUsd });
          fleetRoutedUsd += routedUsd;
          fleetOpusUsd += opusUsd;
        } else if (scope.startsWith("agent:")) {
          const agentId = scope.slice("agent:".length);
          const savingsPct = opusUsd > 0
            ? Math.round((savingsUsd / opusUsd) * 10000) / 100
            : null;
          byAgentModel.push({ agentId, modelFamily, routedUsd, counterfactualOpusUsd: opusUsd, savingsUsd, savingsPct });
        } else if (scope.startsWith("cron:")) {
          const cronKey = scope.slice("cron:".length);
          byCronModel.push({ cronKey, modelFamily, routedUsd, counterfactualOpusUsd: opusUsd, savingsUsd });
        }
      }

      const fleetSavingsUsd = fleetOpusUsd - fleetRoutedUsd;
      const fleetSavingsPct =
        fleetOpusUsd > 0
          ? Math.round((fleetSavingsUsd / fleetOpusUsd) * 10000) / 100
          : null;

      const runsTotal = new Set(byCronModel.map((r) => r.cronKey)).size;
      const runsWithCostData = new Set(byCronModel.filter((r) => r.routedUsd > 0).map((r) => r.cronKey)).size;

      return c.json(
        wrapResponse(
          {
            fleet: {
              routedUsd: fleetRoutedUsd,
              counterfactualOpusUsd: fleetOpusUsd,
              savingsUsd: fleetSavingsUsd,
              savingsPct: fleetSavingsPct,
              byModel: fleetByModel,
            },
            byAgentModel,
            byCronModel,
            runsWithCostData,
            runsTotal,
            note: "counterfactualOpusUsd is a hypothetical: what these runs would have cost if all models were claude-opus-4-8.",
          },
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
}

function makeSummaryHandler(
  provider: MetricsProvider,
): AppHandler<typeof summaryRoute> {
  return async (c) => {
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
      const avgFixCascadeDepth =
        avgFixCascadeDepthRaw === 0 ? null : avgFixCascadeDepthRaw;

      const avgCycleTimeRaw = toNumOrNull(cycleTimeRow.avg_cycle_time_hours);
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
}

function makeTrendsHandler(
  provider: MetricsProvider,
): AppHandler<typeof trendsRoute> {
  return async (c) => {
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
    const startMs = Date.now();

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
}

function makeFeaturesHandler(
  provider: MetricsProvider,
): AppHandler<typeof featuresRoute> {
  return async (c) => {
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
      const [tasksResult, ciResult, reviewsResult] = await Promise.all([
        provider.query({ kind: "featuresTasks", range: dateRange }),
        provider.query({ kind: "featuresCi", range: dateRange }),
        provider.query({ kind: "featuresReviews", range: dateRange }),
      ]);

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
}

function makeQueueHandler(
  provider: MetricsProvider,
): AppHandler<typeof queueRoute> {
  return async (c) => {
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

      const blockRate =
        tasksStarted > 0
          ? Math.round((tasksBlocked / tasksStarted) * 10000) / 100
          : null;

      const avgReviewFindingsRaw = toNumOrNull(funnelRow.avg_review_findings);
      const avgReviewFindings =
        avgReviewFindingsRaw === 0 ? null : avgReviewFindingsRaw;

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
}

// ─── Handler factory ─────────────────────────────────────────────────────────

export function createMetricsApp(
  apiKeys: Map<string, Caller>,
  accountsClient: AccountsClient,
  deps?: MetricsDeps,
): OpenAPIHono<AuthEnv> {
  const provider = deps?.provider;
  if (!provider) {
    throw new Error(
      "[metrics-api] MetricsDeps.provider is required — no fallback provider is configured",
    );
  }

  const sessionSecret =
    deps?.sessionSecret ?? process.env.SHIPWRIGHT_SESSION_SECRET ?? "";
  const requireOwnerRole = deps?.requireOwnerRole ?? false;
  if (requireOwnerRole) {
    console.warn(
      "[metrics] METRICS_REQUIRE_OWNER_ROLE is enabled — ensure your accountsClient URL serves /accounts/users/{id}. The Shipwright admin service does not expose this endpoint.",
    );
  }
  const dashboardToken = deps?.dashboardToken;
  const offlineMode = deps?.offlineMode ?? false;
  const dashboardDevAuth = deps?.dashboardDevAuth ?? false;
  const basePath = deps?.basePath ?? process.env.METRICS_BASE_PATH ?? "";
  const adminBaseUrl =
    deps?.adminBaseUrl ?? process.env.METRICS_ADMIN_APP_URL ?? "";

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

  // /metrics/* — accepts bearer token OR session cookie; returns 401 JSON on failure.
  app.use(
    "/metrics/*",
    dashboardDevAuth
      ? createMiddleware<AuthEnv>(async (c, next) => {
          c.set("caller", { name: "dev-auth", scope: "*" });
          return next();
        })
      : createCombinedAuthMiddleware(
          apiKeys,
          sessionSecret,
          accountsClient,
          requireOwnerRole,
          dashboardToken,
        ),
  );

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

  // ─── /metrics/summary, /trends, /features, /queue ─────────────────────────
  // Provider-bound handlers (shared with the public app via the make* factories).

  const handleSummary = makeSummaryHandler(provider);
  const handleTrends = makeTrendsHandler(provider);
  const handleFeatures = makeFeaturesHandler(provider);
  const handleQueue = makeQueueHandler(provider);

  // ─── /metrics/tokens ──────────────────────────────────────────────────────

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
      const [
        totalsResult,
        bySessionTypeResult,
        byAgentResult,
        trendsResult,
        byAgentBySessionTypeResult,
        byAgentByCronResult,
        byAgentByModelResult,
      ] = await Promise.all([
        provider.query({ kind: "tokensTotals", range: dateRange }),
        provider.query({ kind: "tokensBySessionType", range: dateRange }),
        provider.query({ kind: "tokensByAgent", range: dateRange }),
        provider.query({ kind: "tokensTrends", range: dateRange }),
        provider.query({
          kind: "tokensByAgentBySessionType",
          range: dateRange,
        }),
        provider.query({ kind: "tokensByAgentByCron", range: dateRange }),
        provider.query({ kind: "tokensByAgentByModel", range: dateRange }),
      ]);

      const totalsRow = rowToObject(totalsResult) ?? {};
      const totals = {
        input: toNum(totalsRow.input_tokens),
        output: toNum(totalsRow.output_tokens),
        cacheRead: toNum(totalsRow.cache_read_input_tokens),
        cacheCreation: toNum(totalsRow.cache_creation_input_tokens),
        total: toNum(totalsRow.total_tokens),
        cost: toNum(totalsRow.cost_usd),
      };

      const bySessionType = resultToRows(bySessionTypeResult).map((row) => ({
        sessionType: String(row.session_type ?? ""),
        input: toNum(row.input_tokens),
        output: toNum(row.output_tokens),
        cacheRead: toNum(row.cache_read_input_tokens),
        cacheCreation: toNum(row.cache_creation_input_tokens),
        total: toNum(row.total_tokens),
        cost: toNum(row.cost_usd),
      }));

      const byAgentRaw = resultToRows(byAgentResult).map((row) => ({
        agentId: String(row.agent_id ?? ""),
        input: toNum(row.input_tokens),
        output: toNum(row.output_tokens),
        cacheRead: toNum(row.cache_read_input_tokens),
        cacheCreation: toNum(row.cache_creation_input_tokens),
        total: toNum(row.total_tokens),
        cost: toNum(row.cost_usd),
      }));

      const agentNameMap = new Map<string, string>();
      if (byAgentRaw.length > 0) {
        try {
          const agents = await accountsClient.listAgents();
          for (const agent of agents) {
            agentNameMap.set(agent.id, agent.name);
          }
        } catch (e) {
          process.stderr.write(
            `[metrics-api] listAgents failed — agentName resolution skipped: ${String(e)}\n`,
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
        cost: toNum(row.cost_usd),
      }));

      const byAgentSessionType = resultToRows(byAgentBySessionTypeResult).map(
        (row) => ({
          agentId: String(row.agent_id ?? ""),
          sessionType: String(row.session_type ?? ""),
          input: toNum(row.input_tokens),
          output: toNum(row.output_tokens),
          cacheRead: toNum(row.cache_read_input_tokens),
          cacheCreation: toNum(row.cache_creation_input_tokens),
          total: toNum(row.total_tokens),
          cost: toNum(row.cost_usd),
        }),
      );

      const byAgentCronRaw = resultToRows(byAgentByCronResult).map((row) => ({
        agentId: String(row.agent_id ?? ""),
        cronName: String(row.cron_name ?? ""),
        input: toNum(row.input_tokens),
        output: toNum(row.output_tokens),
        cacheRead: toNum(row.cache_read_input_tokens),
        cacheCreation: toNum(row.cache_creation_input_tokens),
        total: toNum(row.total_tokens),
        cost: toNum(row.cost_usd),
      }));

      const cronDisplayNameMap = new Map<string, string>();
      if (byAgentCronRaw.length > 0) {
        const uniqueAgentIds = [
          ...new Set(byAgentCronRaw.map((r) => r.agentId)),
        ];
        await Promise.all(
          uniqueAgentIds.map(async (agentId) => {
            try {
              const jobs = await accountsClient.listAgentCronJobs(agentId);
              for (const job of jobs) {
                const displayName =
                  job.name ??
                  (job.prompt.length > 40
                    ? `${job.prompt.slice(0, 40).trim()}…`
                    : job.prompt);
                cronDisplayNameMap.set(job.id, displayName);
              }
            } catch (e) {
              process.stderr.write(
                `[metrics-api] listAgentCronJobs(${agentId}) failed — cronName resolution skipped: ${String(e)}\n`,
              );
            }
          }),
        );
      }

      const byAgentCron = byAgentCronRaw.map((row) => ({
        ...row,
        cronName: cronDisplayNameMap.get(row.cronName) ?? row.cronName,
      }));

      const byAgentModel = resultToRows(byAgentByModelResult).map((row) => ({
        agentId: String(row.agent_id ?? ""),
        model: String(row.model ?? ""),
        input: toNum(row.input_tokens),
        output: toNum(row.output_tokens),
        cacheRead: toNum(row.cache_read_input_tokens),
        cacheCreation: toNum(row.cache_creation_input_tokens),
        total: toNum(row.total_tokens),
        cost: toNum(row.cost_usd),
      }));

      return c.json(
        wrapResponse(
          {
            totals,
            bySessionType,
            byAgent,
            trends,
            byAgentSessionType,
            byAgentCron,
            byAgentModel,
          },
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

  registerWithAuthz(app, summaryRoute, metricsPolicy, handleSummary);
  registerWithAuthz(app, trendsRoute, metricsPolicy, handleTrends);
  registerWithAuthz(app, featuresRoute, metricsPolicy, handleFeatures);
  registerWithAuthz(app, queueRoute, metricsPolicy, handleQueue);
  registerWithAuthz(app, tokensRoute, metricsPolicy, handleTokens);
  registerWithAuthz(app, costEfficiencyRoute, metricsPolicy, makeCostEfficiencyHandler(provider));

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

  if (!offlineMode && !dashboardDevAuth) {
    app.use("/dashboard", createSessionMiddleware(sessionSecret));
    app.use("/dashboard/*", createSessionMiddleware(sessionSecret));
  }

  app.get("/dashboard", async (c) => {
    if (offlineMode || dashboardDevAuth) {
      const body = renderDashboardPage({
        userName: offlineMode ? "Offline User" : "Dev User",
        isOwner: true,
        basePath,
        adminBaseUrl,
      });
      return new Response(body, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const sessionToken = getCookie(c, SESSION_COOKIE);
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

    if (requireOwnerRole && accountsClient && userId) {
      const user = await accountsClient.getUser(userId);
      if (user.role !== "OWNER") {
        const body = renderDashboardPage({
          userName,
          isOwner: false,
          basePath,
          adminBaseUrl,
        });
        return new Response(body, {
          status: 403,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    const body = renderDashboardPage({
      userName,
      isOwner: true,
      basePath,
      adminBaseUrl,
    });
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

// ─── Combined auth middleware ─────────────────────────────────────────────────

/**
 * Combined auth middleware for /metrics/* routes.
 * Accepts either a valid Bearer token (service-to-service) OR a valid
 * admin_session cookie (browser dashboard). Returns 401 JSON on failure
 * so API clients get a machine-readable error rather than a redirect.
 */
function createCombinedAuthMiddleware(
  apiKeys: Map<string, Caller>,
  sessionSecret: string,
  accountsClient?: AccountsClient,
  requireOwnerRole = false,
  dashboardToken?: string,
) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const header = c.req.header("Authorization")?.trim();
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (token) {
      if (dashboardToken && token === dashboardToken) {
        c.set("caller", { name: "dashboard-token", scope: "*" });
        return next();
      }
      const caller = apiKeys.get(token);
      if (caller) {
        if (caller.scope !== "*") {
          return c.json({ error: "Forbidden" }, 403);
        }
        c.set("caller", caller);
        return next();
      }
    }

    if (sessionSecret) {
      const sessionToken = getCookie(c, SESSION_COOKIE);
      if (sessionToken) {
        try {
          const payload = (await verify(
            sessionToken,
            sessionSecret,
            "HS256",
          )) as Record<string, unknown>;
          const { userId, email } = payload;
          if (
            typeof userId === "string" &&
            userId &&
            typeof email === "string" &&
            email
          ) {
            if (requireOwnerRole && accountsClient) {
              const user = await accountsClient.getUser(userId);
              if (user.role !== "OWNER") {
                return c.json({ error: "Forbidden" }, 401);
              }
            }
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

// ─── Public (unauthenticated, repo-scoped) metrics surface ───────────────────
//
// PPL-1.2: a parallel read-only surface mounted under /public/*. It reuses the
// same provider-bound handler logic as the authenticated app but:
//   - requires NO auth (every route uses the {kind:"public"} AuthzPolicy)
//   - serves data scoped to a single repo (the injected provider is repo-scoped
//     at construction time — see TaskStoreProvider's `repo` param)
//   - omits token-usage entirely: GET /public/metrics/tokens → 404
//   - is read-only: no POST/PUT/DELETE routes exist (mutations → 404/405)
//   - serves a read-only dashboard at /public/dashboard

const publicSummaryRoute = createRoute({
  ...summaryRoute,
  path: "/public/metrics/summary",
});
const publicTrendsRoute = createRoute({
  ...trendsRoute,
  path: "/public/metrics/trends",
});
const publicFeaturesRoute = createRoute({
  ...featuresRoute,
  path: "/public/metrics/features",
});
const publicQueueRoute = createRoute({
  ...queueRoute,
  path: "/public/metrics/queue",
});
const publicCostEfficiencyRoute = createRoute({
  ...costEfficiencyRoute,
  path: "/public/metrics/cost-efficiency",
});

const PUBLIC_POLICY = { kind: "public" as const };

/**
 * Build the public, unauthenticated, repo-scoped metrics sub-app.
 *
 * The public surface lives under a `/public` mount: JSON at /public/metrics/*,
 * the read-only dashboard at /public/dashboard, and its client assets at
 * /public/dashboard/{styles.css,app.js}. The dashboard is rendered with its base
 * set to that `/public` mount so the shared client (`app.js`) fetches
 * /public/metrics/* (repo-scoped, no auth) instead of the authenticated
 * /metrics/* endpoints — otherwise the page renders but loads no data.
 *
 * @param provider - a repo-scoped MetricsProvider (built in server.ts with the
 *   configured public repo). All reads are already narrowed to that repo.
 * @param basePath - optional path prefix the whole public mount sits under.
 * @param dashboardDir - directory holding the dashboard static assets
 *   (styles.css, app.js); defaults to the bundled ./dashboard dir.
 */
export function createPublicMetricsApp(
  provider: MetricsProvider,
  basePath = "",
  dashboardDir: string = join(import.meta.dir, "dashboard"),
): OpenAPIHono<AuthEnv> {
  // Base for the public dashboard's assets + client API calls. The public routes
  // are registered literally under "/public/*", so the rendered base must resolve
  // there (e.g. app.js → `${publicBase}/metrics/summary` = /public/metrics/summary).
  const publicBase = `${basePath}/public`;
  const app = new OpenAPIHono<AuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
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

  // Read-only metric endpoints — no auth, repo-scoped via the injected provider.
  //
  // The handler factories are typed against the authenticated route configs
  // (path "/metrics/*"). The public routes share byte-identical request/response
  // schemas — only the `path` literal differs — so the handler logic is fully
  // compatible. `AppHandler<R>` carries the path only as a phantom type, so each
  // handler is cast to its public route's type. This is the single place the two
  // route families are bridged; the schemas guarantee runtime correctness.
  registerWithAuthz(
    app,
    publicSummaryRoute,
    PUBLIC_POLICY,
    makeSummaryHandler(provider) as unknown as AppHandler<
      typeof publicSummaryRoute
    >,
  );
  registerWithAuthz(
    app,
    publicTrendsRoute,
    PUBLIC_POLICY,
    makeTrendsHandler(provider) as unknown as AppHandler<
      typeof publicTrendsRoute
    >,
  );
  registerWithAuthz(
    app,
    publicFeaturesRoute,
    PUBLIC_POLICY,
    makeFeaturesHandler(provider) as unknown as AppHandler<
      typeof publicFeaturesRoute
    >,
  );
  registerWithAuthz(
    app,
    publicQueueRoute,
    PUBLIC_POLICY,
    makeQueueHandler(provider) as unknown as AppHandler<
      typeof publicQueueRoute
    >,
  );

  registerWithAuthz(
    app,
    publicCostEfficiencyRoute,
    PUBLIC_POLICY,
    makeCostEfficiencyHandler(provider) as unknown as AppHandler<typeof publicCostEfficiencyRoute>,
  );

  // Token usage is owner-only telemetry — not exposed publicly.
  app.get("/public/metrics/tokens", (c) => c.json({ error: "Not found" }, 404));

  // Read-only dashboard variant — pipeline panels only, no token usage.
  // Rendered with basePath=publicBase so the client fetches /public/metrics/*.
  // Registered for both the bare and trailing-slash paths: a proof-host root
  // redirect lands on "/public/dashboard/" (GKE's ReplacePrefixMatch on "/"
  // appends a slash), and Hono treats the trailing slash as a distinct,
  // otherwise-unmatched route — so without the alias the apex entry 404s.
  const dashboardHandler = () => {
    const body = renderDashboardPage({
      userName: "Public",
      isOwner: false,
      readOnly: true,
      basePath: publicBase,
    });
    return new Response(body, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };
  app.get("/public/dashboard", dashboardHandler);
  app.get("/public/dashboard/", dashboardHandler);

  // Dashboard static assets under the public mount, so the read-only page can
  // load its own CSS/JS without reaching the authenticated /dashboard/* routes.
  // Registered at the literal /public/* paths (basePath is the external,
  // proxy-stripped prefix — present only in the rendered URLs, not the routes).
  const PUBLIC_STATIC_FILES: Record<
    string,
    { contentType: string; file: string; cache?: string }
  > = {
    "/public/dashboard/styles.css": {
      contentType: "text/css; charset=utf-8",
      file: "styles.css",
      cache: "public, max-age=3600",
    },
    "/public/dashboard/app.js": {
      contentType: "application/javascript; charset=utf-8",
      file: "app.js",
      cache: "public, max-age=3600",
    },
  };
  for (const [path, { contentType, file, cache }] of Object.entries(
    PUBLIC_STATIC_FILES,
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
