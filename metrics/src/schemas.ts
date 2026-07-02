/**
 * metrics/src/schemas.ts
 * Zod schemas for metrics API request params and response shapes.
 */

import { z } from "@hono/zod-openapi";

// ─── Request schemas ─────────────────────────────────────────────────────────

export const DateRangeQuerySchema = z.object({
  preset: z.enum(["today", "7d", "30d", "90d"]).optional().openapi({
    description: "Preset date range",
    example: "7d",
  }),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional()
    .openapi({
      description: "Custom start date (YYYY-MM-DD)",
      example: "2026-04-01",
    }),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
    .optional()
    .openapi({
      description: "Custom end date (YYYY-MM-DD)",
      example: "2026-04-03",
    }),
});

export type DateRangeQuery = z.infer<typeof DateRangeQuerySchema>;

export const TrendsQuerySchema = DateRangeQuerySchema.extend({
  groupBy: z.enum(["day", "week", "hour"]).optional().openapi({
    description: "Time-series grouping granularity",
    example: "day",
  }),
});

export type TrendsQuery = z.infer<typeof TrendsQuerySchema>;

// ─── Response schemas ─────────────────────────────────────────────────────────

export const SummaryResultSchema = z
  .object({
    tasksCompleted: z.number().int(),
    tasksBlocked: z.number().int(),
    taskBlockedRate: z.number().nullable(),
    avgCycleTimeHours: z.number().nullable(),
    avgActualHours: z.number().nullable(),
    avgEstimatedHours: z.number().nullable(),
    avgRetries: z.number().nullable(),
    avgFilesChanged: z.number().nullable(),
    ciGatesTotal: z.number().int(),
    ciFirstPass: z.number().int(),
    ciFirstPassRate: z.number().nullable(),
    avgFixAttempts: z.number().nullable(),
    simplifyTotal: z.number().int(),
    simplifyTotalFixes: z.number(),
    simplifyAvgDry: z.number().nullable(),
    simplifyAvgDeadCode: z.number().nullable(),
    simplifyAvgNaming: z.number().nullable(),
    simplifyAvgComplexity: z.number().nullable(),
    simplifyAvgConsistency: z.number().nullable(),
    reviewsTotal: z.number().int(),
    reviewsShipIt: z.number().int(),
    reviewShipItRate: z.number().nullable(),
    estimationAccuracy: z.number().nullable(),
    complexityDist: z.object({
      c1: z.number().int(),
      c2: z.number().int(),
      c3: z.number().int(),
      c4: z.number().int(),
      c5: z.number().int(),
    }),
    avgFixCascadeDepth: z.number().nullable(),
  })
  .openapi("SummaryResult");

export const TrendsPeriodSchema = z.object({
  period: z.string(),
  tasksCompleted: z.number().int(),
  ciGates: z.number().int(),
  ciFirstPass: z.number().int(),
  ciFirstPassCount: z.number().int(),
  simplifyPasses: z.number().int(),
  simplifyFixes: z.number(),
  tasksBlocked: z.number().int(),
  reviews: z.number().int(),
  tasksStarted: z.number().int(),
  reviewsShipIt: z.number().int(),
  avgActualHours: z.number().nullable(),
  avgEstimatedHours: z.number().nullable(),
  avgRetries: z.number().nullable(),
  avgFilesChanged: z.number().nullable(),
  avgFixAttempts: z.number().nullable(),
  avgCycleTimeHours: z.number().nullable(),
  estimationAccuracy: z.number().nullable(),
  simplifyAvgDry: z.number().nullable(),
  simplifyAvgDeadCode: z.number().nullable(),
  simplifyAvgNaming: z.number().nullable(),
  simplifyAvgComplexity: z.number().nullable(),
  simplifyAvgConsistency: z.number().nullable(),
  avgReviewFindings: z.number().nullable(),
});

export const TrendsResultSchema = z
  .object({
    rows: z.array(TrendsPeriodSchema),
  })
  .openapi("TrendsResult");

export const FeatureMetricSchema = z
  .object({
    prefix: z.string().openapi({ example: "MQ" }),
    tasksCompleted: z.number().int().openapi({ example: 3 }),
    avgActualH: z.number().nullable().openapi({ example: 2.5 }),
    avgEstimatedH: z.number().nullable().openapi({ example: 3.0 }),
    ciFirstPassRate: z.number().nullable().openapi({ example: 75 }),
    reviewShipItRate: z.number().nullable().openapi({ example: 100 }),
  })
  .openapi("FeatureMetric");

export const FeaturesResultSchema = z
  .object({
    features: z.array(FeatureMetricSchema),
  })
  .openapi("FeaturesResult");

export const QueueResultSchema = z
  .object({
    tasksStarted: z.number().int().openapi({ example: 12 }),
    tasksMerged: z.number().int().openapi({ example: 9 }),
    tasksBlocked: z.number().int().openapi({ example: 1 }),
    tasksApproved: z.number().int().openapi({ example: 9 }),
    blockRate: z.number().nullable().openapi({ example: 8.33 }),
    avgCycleTimeDays: z.number().nullable().openapi({ example: 1.4 }),
    avgReviewFindings: z.number().nullable().openapi({ example: 2.1 }),
  })
  .openapi("QueueResult");

// ─── Tokens schemas ───────────────────────────────────────────────────────────

export const TokensQuerySchema = DateRangeQuerySchema;
export type TokensQuery = z.infer<typeof TokensQuerySchema>;

const TokenTotalsSchema = z
  .object({
    input: z.number().openapi({ example: 1000 }),
    output: z.number().openapi({ example: 500 }),
    cacheRead: z.number().openapi({ example: 200 }),
    cacheCreation: z.number().openapi({ example: 100 }),
    total: z.number().openapi({ example: 1800 }),
    cost: z.number().openapi({ example: 0.5 }),
  })
  .openapi("TokenTotals");

const TokensBySessionTypeSchema = z
  .object({
    sessionType: z.string().openapi({ example: "slack_dm" }),
    input: z.number().openapi({ example: 400 }),
    output: z.number().openapi({ example: 200 }),
    cacheRead: z.number().openapi({ example: 80 }),
    cacheCreation: z.number().openapi({ example: 40 }),
    total: z.number().openapi({ example: 720 }),
    cost: z.number().openapi({ example: 0.2 }),
  })
  .openapi("TokensBySessionType");

const TokensByAgentSchema = z
  .object({
    agentId: z.string().openapi({ example: "agent-abc123" }),
    agentName: z.string().optional().openapi({ example: "Bodhi" }),
    input: z.number().openapi({ example: 1000 }),
    output: z.number().openapi({ example: 500 }),
    cacheRead: z.number().openapi({ example: 200 }),
    cacheCreation: z.number().openapi({ example: 100 }),
    total: z.number().openapi({ example: 1800 }),
    cost: z.number().openapi({ example: 0.5 }),
  })
  .openapi("TokensByAgent");

const TokenTrendSchema = z
  .object({
    date: z.string().openapi({ example: "2026-04-01" }),
    input: z.number().openapi({ example: 300 }),
    output: z.number().openapi({ example: 150 }),
    cacheRead: z.number().openapi({ example: 60 }),
    cacheCreation: z.number().openapi({ example: 30 }),
    total: z.number().openapi({ example: 540 }),
    cost: z.number().openapi({ example: 0.15 }),
  })
  .openapi("TokenTrend");

const TokensByAgentBySessionTypeSchema = z
  .object({
    agentId: z.string(),
    sessionType: z.string(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheCreation: z.number(),
    total: z.number(),
    cost: z.number(),
  })
  .openapi("TokensByAgentBySessionType");

const TokensByAgentByCronSchema = z
  .object({
    agentId: z.string(),
    cronName: z.string(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheCreation: z.number(),
    total: z.number(),
    cost: z.number(),
  })
  .openapi("TokensByAgentByCron");

const TokensByAgentByModelSchema = z
  .object({
    agentId: z.string(),
    model: z.string(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheCreation: z.number(),
    total: z.number(),
    cost: z.number(),
  })
  .openapi("TokensByAgentByModel");

export const TokensResultSchema = z
  .object({
    totals: TokenTotalsSchema,
    bySessionType: z.array(TokensBySessionTypeSchema),
    byAgent: z.array(TokensByAgentSchema),
    trends: z.array(TokenTrendSchema),
    byAgentSessionType: z.array(TokensByAgentBySessionTypeSchema),
    byAgentCron: z.array(TokensByAgentByCronSchema),
    byAgentModel: z.array(TokensByAgentByModelSchema),
  })
  .openapi("TokensResult");

// ─── Cost efficiency schemas ──────────────────────────────────────────────────

export const CostEfficiencyFleetRowSchema = z
  .object({
    modelFamily: z.string().openapi({ example: "claude-sonnet" }),
    routedUsd: z.number().openapi({ example: 10.5 }),
    counterfactualOpusUsd: z.number().openapi({ example: 25.0 }),
    savingsUsd: z.number().openapi({ example: 14.5 }),
    savingsPct: z.number().nullable().openapi({ example: 58.0 }),
  })
  .openapi("CostEfficiencyFleetRow");

export const CostEfficiencyCronModelRowSchema = z
  .object({
    scope: z.string().openapi({ example: "cron:agent1:daily-review" }),
    modelFamily: z.string().openapi({ example: "claude-sonnet" }),
    routedUsd: z.number().openapi({ example: 5.25 }),
    counterfactualOpusUsd: z.number().openapi({ example: 12.5 }),
    savingsUsd: z.number().openapi({ example: 7.25 }),
    savingsPct: z.number().nullable().openapi({ example: 58.0 }),
  })
  .openapi("CostEfficiencyCronModelRow");

export const CostEfficiencyAgentModelRowSchema = z
  .object({
    agentId: z.string().openapi({ example: "agent-abc123" }),
    modelFamily: z.string().openapi({ example: "claude-sonnet" }),
    routedUsd: z.number().openapi({ example: 5.25 }),
    counterfactualOpusUsd: z.number().openapi({ example: 12.5 }),
    savingsUsd: z.number().openapi({ example: 7.25 }),
    savingsPct: z.number().nullable().openapi({ example: 58.0 }),
  })
  .openapi("CostEfficiencyAgentModelRow");

export const CostEfficiencyResultSchema = z
  .object({
    fleet: z.array(CostEfficiencyFleetRowSchema),
    byAgentModel: z.array(CostEfficiencyAgentModelRowSchema),
    byCronModel: z.array(CostEfficiencyCronModelRowSchema),
  })
  .openapi("CostEfficiencyResult");

// ─── Response envelope schema ─────────────────────────────────────────────────

export const MetaSchema = z
  .object({
    dateRange: z.object({
      from: z.string().openapi({ example: "2026-04-01T00:00:00.000Z" }),
      to: z.string().openapi({ example: "2026-04-07T23:59:59.999Z" }),
    }),
    generatedAt: z.string().openapi({ example: "2026-04-03T12:00:00.000Z" }),
    queryTimeMs: z.number().openapi({ example: 42 }),
  })
  .openapi("ResponseMeta");

export type ResponseMeta = z.infer<typeof MetaSchema>;
