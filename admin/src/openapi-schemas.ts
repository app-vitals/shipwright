/**
 * admin/src/openapi-schemas.ts
 * Zod schemas for the admin API — entity types, request bodies, and common
 * error shapes. Imported by route migrations (OAS-2.1, OAS-2.2).
 *
 * Import z from "@hono/zod-openapi" so .openapi() metadata is available.
 */

import { z } from "@hono/zod-openapi";
import { isOrgRepo } from "@shipwright/lib/org-repo";

// ─── Common ───────────────────────────────────────────────────────────────────

export const ErrorSchema = z
  .object({
    error: z.string().openapi({ example: "not found" }),
  })
  .openapi("Error");

export type ErrorResponse = z.infer<typeof ErrorSchema>;

export const OkSchema = z
  .object({
    ok: z.literal(true),
  })
  .openapi("Ok");

// ─── Agent ────────────────────────────────────────────────────────────────────

/**
 * Full Agent response shape (POST /agents → 201).
 * Sensitive fields (slackBotToken, anthropicApiKey) are never returned.
 */
export const AgentSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    name: z.string().openapi({ example: "Bodhi" }),
    slackId: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "U0AALR8M69X" }),
    selfHosted: z.boolean().openapi({ example: false }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("Agent");

export type Agent = z.infer<typeof AgentSchema>;

/** Minimal Agent shape for list endpoints (GET /agents). */
export const AgentSummarySchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    name: z.string().openapi({ example: "Bodhi" }),
    selfHosted: z.boolean().openapi({ example: false }),
  })
  .openapi("AgentSummary");

export const CreateAgentBodySchema = z
  .object({
    name: z.string().min(1).openapi({ example: "Bodhi" }),
    slackId: z.string().optional().openapi({ example: "U0AALR8M69X" }),
    selfHosted: z.boolean().optional().openapi({ example: false }),
  })
  .openapi("CreateAgentBody");

export const PatchAgentBodySchema = z
  .object({
    selfHosted: z.boolean().optional().openapi({ example: false }),
    repos: z
      .array(
        z.string().refine(isOrgRepo, {
          message: "each repo must be in org/repo format",
        }),
      )
      .optional()
      .openapi({ example: ["my-org/my-repo"] }),
  })
  .openapi("PatchAgentBody");

// ─── AgentCronJob ─────────────────────────────────────────────────────────────

export const AgentCronJobSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    schedule: z.string().openapi({ example: "0 9 * * 1-5" }),
    prompt: z.string().openapi({ example: "Run the morning brief." }),
    channel: z.string().nullable().openapi({ example: "C01234567" }),
    user: z.string().nullable().openapi({ example: "U0AALR8M69X" }),
    silent: z.boolean().openapi({ example: false }),
    enabled: z.boolean().openapi({ example: true }),
    preCheck: z
      .string()
      .nullable()
      .openapi({ example: "shipwright:check-dev-task.ts" }),
    name: z.string().nullable().openapi({ example: "morning-brief" }),
    system: z.boolean().openapi({ example: false }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("AgentCronJob");

export type AgentCronJob = z.infer<typeof AgentCronJobSchema>;

export const CreateAgentCronJobBodySchema = z
  .object({
    schedule: z.string().openapi({ example: "0 9 * * 1-5" }),
    prompt: z.string().openapi({ example: "Run the morning brief." }),
    channel: z.string().nullable().optional().openapi({ example: "C01234567" }),
    user: z.string().nullable().optional().openapi({ example: "U0AALR8M69X" }),
    silent: z.boolean().optional().openapi({ example: false }),
    enabled: z.boolean().optional().openapi({ example: true }),
    preCheck: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "shipwright:check-dev-task.ts" }),
    name: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "morning-brief" }),
  })
  .openapi("CreateAgentCronJobBody");

/**
 * PATCH /agents/:id/crons/:cronId body.
 * schedule and prompt must be provided together (content update).
 * enabled and preCheck are orthogonal — each may be sent alone.
 */
export const PatchAgentCronJobBodySchema = z
  .object({
    schedule: z.string().optional().openapi({ example: "0 9 * * 1-5" }),
    prompt: z
      .string()
      .optional()
      .openapi({ example: "Run the morning brief." }),
    channel: z.string().nullable().optional().openapi({ example: "C01234567" }),
    user: z.string().nullable().optional().openapi({ example: "U0AALR8M69X" }),
    silent: z.boolean().optional().openapi({ example: false }),
    preCheck: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "shipwright:check-dev-task.ts" }),
    enabled: z.boolean().optional().openapi({ example: true }),
  })
  .openapi("PatchAgentCronJobBody");

// ─── Model breakdown entry ────────────────────────────────────────────────────

export const ModelBreakdownEntrySchema = z
  .object({
    model: z.string().openapi({ example: "claude-sonnet-4-5" }),
    inputTokens: z.number().int().default(0).openapi({ example: 200 }),
    outputTokens: z.number().int().default(0).openapi({ example: 100 }),
    cacheReadTokens: z.number().int().default(0).openapi({ example: 8 }),
    cacheCreationTokens: z.number().int().default(0).openapi({ example: 4 }),
    costUsd: z.number().default(0).openapi({ example: 0.002 }),
  })
  .openapi("ModelBreakdownEntry");

export type ModelBreakdownEntry = z.infer<typeof ModelBreakdownEntrySchema>;

// ─── AgentCronRun ─────────────────────────────────────────────────────────────

export const AgentCronRunSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    cronId: z.string().openapi({ example: "clx0987654321" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    startedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T08:00:00.000Z" }),
    completedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({ example: "2026-01-01T08:00:05.000Z" }),
    skipped: z.boolean().openapi({ example: false }),
    skipReason: z
      .string()
      .nullable()
      .openapi({ example: "pre-check returned false" }),
    outcome: z.string().nullable().openapi({ example: "success" }),
    error: z.string().nullable().openapi({ example: null }),
    phase: z
      .string()
      .nullable()
      .openapi({
        example: "dev-task",
        description:
          "Pipeline phase this run served (dev-task/review/patch/deploy). Null for legacy five-job crons.",
      }),
    inputTokens: z.number().int().nullable().openapi({ example: 1234 }),
    outputTokens: z.number().int().nullable().openapi({ example: 567 }),
    cacheReadTokens: z.number().int().nullable().openapi({ example: 89 }),
    cacheCreationTokens: z.number().int().nullable().openapi({ example: 10 }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T08:00:00.000Z" }),
    modelBreakdown: z.array(ModelBreakdownEntrySchema).optional(),
  })
  .openapi("AgentCronRun");

export type AgentCronRunType = z.infer<typeof AgentCronRunSchema>;

export const CronRunsListSchema = z
  .object({
    items: z.array(AgentCronRunSchema),
    total: z.number().int().openapi({ example: 42 }),
    limit: z.number().int().openapi({ example: 20 }),
    offset: z.number().int().openapi({ example: 0 }),
  })
  .openapi("CronRunsList");

export type CronRunsList = z.infer<typeof CronRunsListSchema>;

export const CreateAgentCronRunBodySchema = z
  .object({
    startedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T08:00:00.000Z" }),
    completedAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: null }),
    skipped: z.boolean().optional().openapi({ example: false }),
    skipReason: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "pre-check returned false" }),
    outcome: z.string().nullable().optional().openapi({ example: "success" }),
    error: z.string().nullable().optional().openapi({ example: null }),
    phase: z
      .string()
      .nullable()
      .optional()
      .openapi({
        example: "dev-task",
        description:
          "Pipeline phase this run served (dev-task/review/patch/deploy)",
      }),
  })
  .openapi("CreateAgentCronRunBody");

/**
 * PATCH /agents/:id/crons/:cronId/runs/:runId body.
 * All fields are optional. At least one must be provided (enforced at the handler level).
 */
export const PatchAgentCronRunBodySchema = z
  .object({
    completedAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: "2026-01-01T08:05:00.000Z" }),
    outcome: z.string().nullable().optional().openapi({ example: "success" }),
    error: z.string().nullable().optional().openapi({ example: null }),
    skipped: z.boolean().optional().openapi({ example: false }),
    skipReason: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "pre-check returned false" }),
    inputTokens: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 1234 }),
    outputTokens: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 567 }),
    cacheReadTokens: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 89 }),
    cacheCreationTokens: z
      .number()
      .int()
      .nullable()
      .optional()
      .openapi({ example: 10 }),
    modelBreakdown: z
      .array(ModelBreakdownEntrySchema)
      .optional()
      .openapi({ description: "Per-model token breakdown for this run" }),
  })
  .openapi("PatchAgentCronRunBody");

export const ListCronRunsQuerySchema = z
  .object({
    limit: z
      .string()
      .optional()
      .transform((v) => (v ? Number.parseInt(v, 10) : 20))
      .openapi({ example: "20" }),
    offset: z
      .string()
      .optional()
      .transform((v) => (v ? Number.parseInt(v, 10) : 0))
      .openapi({ example: "0" }),
  })
  .openapi("ListCronRunsQuery");

const CronRunLastRunSchema = z
  .object({
    startedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T08:00:00.000Z" }),
    completedAt: z.string().datetime().nullable().openapi({ example: null }),
    skipped: z.boolean().openapi({ example: false }),
    outcome: z.string().nullable().openapi({ example: "success" }),
  })
  .openapi("CronRunLastRun");

export const AgentCronJobWithRunSummarySchema = AgentCronJobSchema.extend({
  lastRun: CronRunLastRunSchema.nullable().openapi({ example: null }),
  runCountToday: z.number().int().openapi({ example: 3 }),
}).openapi("AgentCronJobWithRunSummary");

export type AgentCronJobWithRunSummaryType = z.infer<
  typeof AgentCronJobWithRunSummarySchema
>;

export const CronsWithSummaryWrapperSchema = z
  .object({ crons: z.array(AgentCronJobWithRunSummarySchema) })
  .openapi("CronsWithSummaryWrapper");

// ─── AgentTool ────────────────────────────────────────────────────────────────

export const AgentToolSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    pattern: z.string().openapi({ example: "Read" }),
    enabled: z.boolean().openapi({ example: true }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("AgentTool");

export type AgentTool = z.infer<typeof AgentToolSchema>;

export const CreateAgentToolBodySchema = z
  .object({
    pattern: z.string().min(1).openapi({ example: "Bash" }),
  })
  .openapi("CreateAgentToolBody");

export const PatchAgentToolBodySchema = z
  .object({
    enabled: z.boolean().openapi({ example: false }),
  })
  .openapi("PatchAgentToolBody");

// ─── AgentToken ───────────────────────────────────────────────────────────────

/**
 * Token metadata returned from list/create (never the hash).
 * Exported as both AgentTokenSchema (canonical per brief) and AgentTokenMetaSchema (alias).
 */
export const AgentTokenSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    label: z.string().nullable().optional().openapi({ example: "ci-runner" }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    revokedAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: null }),
  })
  .openapi("AgentToken");

export type AgentToken = z.infer<typeof AgentTokenSchema>;

/** @deprecated Use AgentTokenSchema */
export const AgentTokenMetaSchema = AgentTokenSchema;

/**
 * POST /agents/:id/tokens → 201. rawToken is returned once and not stored.
 */
export const CreateAgentTokenResponseSchema = z
  .object({
    token: AgentTokenSchema,
    rawToken: z
      .string()
      .openapi({ example: "swt_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }),
  })
  .openapi("CreateAgentTokenResponse");

export const CreateAgentTokenBodySchema = z
  .object({
    label: z.string().optional().openapi({ example: "ci-runner" }),
  })
  .openapi("CreateAgentTokenBody");

// ─── AgentPlugin ──────────────────────────────────────────────────────────────

export const AgentPluginSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    name: z.string().openapi({ example: "@shipwright/plugin" }),
    version: z.string().nullable().optional().openapi({ example: "1.2.3" }),
    enabled: z.boolean().openapi({ example: true }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("AgentPlugin");

export type AgentPlugin = z.infer<typeof AgentPluginSchema>;

export const CreateAgentPluginBodySchema = z
  .object({
    name: z.string().min(1).openapi({ example: "@shipwright/plugin" }),
    version: z.string().nullable().optional().openapi({ example: "1.2.3" }),
  })
  .openapi("CreateAgentPluginBody");

export const PatchAgentPluginBodySchema = z
  .object({
    version: z.string().nullable().optional().openapi({ example: "1.3.0" }),
  })
  .openapi("PatchAgentPluginBody");

// ─── AgentEnv ─────────────────────────────────────────────────────────────────

/**
 * GET /agents/:id/envs response. Values are decrypted at the service layer.
 * Secret keys are masked as "***" in env and listed in secretKeys.
 */
export const AgentEnvResponseSchema = z
  .object({
    env: z.record(z.string()).openapi({ example: { MY_VAR: "value" } }),
    secretKeys: z.array(z.string()).openapi({ example: ["MY_SECRET"] }),
  })
  .openapi("AgentEnvResponse");

/**
 * POST /agents/:id/envs body — a plain key/value map (full replace).
 */
export const AgentEnvBodySchema = z.record(z.string()).openapi("AgentEnvBody");

/**
 * PATCH /agents/:id/envs body — partial update with optional secret designation.
 * `env` is a map of key/value pairs to upsert.
 * `secretKeys` lists which keys should be flagged as secret (masked in GET responses).
 */
export const AgentEnvPatchBodySchema = z
  .object({
    env: z
      .record(z.string())
      .openapi({ example: { MY_VAR: "value" } }),
    secretKeys: z
      .array(z.string())
      .optional()
      .openapi({ example: ["MY_SECRET"] }),
  })
  .openapi("AgentEnvPatchBody");

// ─── Path param schemas ───────────────────────────────────────────────────────

export const AgentIdParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
});

export const CronIdParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
  cronId: z.string().openapi({ example: "clx0987654321" }),
});

export const CronRunIdParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
  cronId: z.string().openapi({ example: "clx0987654321" }),
  runId: z.string().openapi({ example: "clx1111111111" }),
});

export const ToolIdParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
  toolId: z.string().openapi({ example: "clx0987654321" }),
});

export const TokenIdParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
  tokenId: z.string().openapi({ example: "clx0987654321" }),
});

export const EnvKeyParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
  key: z.string().openapi({ example: "MY_VAR" }),
});

export const PluginNameQuerySchema = z.object({
  name: z.string().openapi({ example: "@shipwright/plugin" }),
});

// ─── AgentChatTokenUsageDailyByModel ─────────────────────────────────────────

/** One entry in the per-model breakdown sent to POST /agents/:id/chat-tokens/daily. */
const ChatTokenModelEntrySchema = z
  .object({
    model: z.string().openapi({ example: "claude-sonnet-4-5" }),
    inputTokens: z.number().int().min(0).openapi({ example: 100 }),
    outputTokens: z.number().int().min(0).openapi({ example: 50 }),
    cacheReadTokens: z.number().int().min(0).openapi({ example: 10 }),
    cacheCreationTokens: z.number().int().min(0).openapi({ example: 5 }),
    costUsd: z.number().min(0).openapi({ example: 0.0012 }),
  })
  .openapi("ChatTokenModelEntry");

/**
 * POST /agents/:id/chat-tokens/daily request body.
 * date is YYYY-MM-DD; modelBreakdown carries per-model additive increments.
 */
export const UpsertChatTokenDailyBodySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be in YYYY-MM-DD format")
      .openapi({ example: "2026-01-15" }),
    modelBreakdown: z
      .array(ChatTokenModelEntrySchema)
      .min(1)
      .openapi({ description: "Per-model token usage increments" }),
  })
  .openapi("UpsertChatTokenDailyBody");

export type UpsertChatTokenDailyBody = z.infer<
  typeof UpsertChatTokenDailyBodySchema
>;

/** Serialized AgentChatTokenUsageDailyByModel row returned by the upsert endpoint. */
export const AgentChatTokenUsageDailySchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    date: z.string().openapi({ example: "2026-01-15" }),
    model: z.string().openapi({ example: "claude-sonnet-4-5" }),
    inputTokens: z.number().int().openapi({ example: 100 }),
    outputTokens: z.number().int().openapi({ example: 50 }),
    cacheReadTokens: z.number().int().openapi({ example: 10 }),
    cacheCreationTokens: z.number().int().openapi({ example: 5 }),
    costUsd: z.number().openapi({ example: 0.0012 }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-15T00:00:00.000Z" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-15T12:00:00.000Z" }),
  })
  .openapi("AgentChatTokenUsageDailyByModel");

export type AgentChatTokenUsageDailyType = z.infer<
  typeof AgentChatTokenUsageDailySchema
>;

// ─── CronRunTokenStats ────────────────────────────────────────────────────────

/**
 * A single rolled-up token aggregate (totals row or per-dimension bucket).
 */
const TokenAggregateSchema = z
  .object({
    input: z.number().int().openapi({ example: 600 }),
    output: z.number().int().openapi({ example: 300 }),
    cacheRead: z.number().int().openapi({ example: 60 }),
    cacheCreation: z.number().int().openapi({ example: 30 }),
    total: z.number().int().openapi({ example: 990 }),
    costUsd: z.number().optional().openapi({ example: 0.006 }),
  })
  .openapi("TokenAggregate");

/** A token aggregate keyed by a single grouping value (e.g. agentId). */
const KeyedTokenAggregateSchema = TokenAggregateSchema.extend({
  key: z.string().openapi({ example: "agent-id-123" }),
}).openapi("KeyedTokenAggregate");

/**
 * A token aggregate keyed by two grouping values (e.g. agentId + cronName).
 * `phase` is populated on byCron/byCronModel rows (WL-3.5): the pipeline
 * phase (dev-task/review/patch/deploy) the row's runs served, or null for
 * legacy runs that predate phase tracking. Omitted/undefined on dimensions
 * that don't group by phase (e.g. byModel).
 */
const DoubleKeyedTokenAggregateSchema = TokenAggregateSchema.extend({
  key1: z.string().openapi({ example: "agent-id-123" }),
  key2: z.string().openapi({ example: "morning-brief" }),
  phase: z
    .string()
    .nullable()
    .optional()
    .openapi({ example: "dev-task" }),
}).openapi("DoubleKeyedTokenAggregate");

/** A token aggregate bucketed by day (YYYY-MM-DD). */
const DailyTokenAggregateSchema = TokenAggregateSchema.extend({
  period: z.string().openapi({ example: "2026-01-10" }),
}).openapi("DailyTokenAggregate");

/**
 * Response shape for GET /agents/all/cron-runs/stats.
 * Matches the CronRunTokenStats interface in admin-metrics-client.ts exactly.
 */
export const CronRunTokenStatsSchema = z
  .object({
    totals: TokenAggregateSchema,
    byAgent: z.array(KeyedTokenAggregateSchema),
    byCron: z.array(DoubleKeyedTokenAggregateSchema),
    byModel: z.array(DoubleKeyedTokenAggregateSchema),
    daily: z.array(DailyTokenAggregateSchema),
    byCronModel: z.array(DoubleKeyedTokenAggregateSchema),
    /** Keyed by phase (dev-task/review/patch/deploy). Runs with a null phase are excluded. */
    byPhase: z.array(KeyedTokenAggregateSchema),
  })
  .openapi("CronRunTokenStats");

export type CronRunTokenStatsType = z.infer<typeof CronRunTokenStatsSchema>;

/**
 * Response shape for GET /agents/chat-tokens/daily/stats.
 * Matches the ChatTokenStats interface in admin-metrics-client.ts exactly.
 * byModel carries per-(agentId, model) groupings; no byCron dimension.
 */
export const ChatTokenStatsSchema = z
  .object({
    totals: TokenAggregateSchema,
    byAgent: z.array(KeyedTokenAggregateSchema),
    byModel: z.array(DoubleKeyedTokenAggregateSchema),
    daily: z.array(DailyTokenAggregateSchema),
  })
  .openapi("ChatTokenStats");

export type ChatTokenStatsType = z.infer<typeof ChatTokenStatsSchema>;

// ─── AgentConfig (runtime GET /agents/:id/config response) ───────────────────

export const AgentConfigPluginSchema = z
  .object({
    marketplace: z.string().openapi({ example: "shipwright" }),
    plugin: z.string().openapi({ example: "shipwright" }),
  })
  .openapi("AgentConfigPlugin");

export const AgentConfigResponseSchema = z
  .object({
    env: z
      .record(z.string())
      .openapi({ example: { SLACK_BOT_TOKEN: "xoxb-..." } }),
    allowedTools: z.array(z.string()).openapi({ example: ["Read", "Write"] }),
    plugins: z.array(AgentConfigPluginSchema),
    repos: z.array(z.string()).openapi({ example: ["org/repo1", "org/repo2"] }),
  })
  .openapi("AgentConfigResponse");

// Simple error shape for runtime API responses (no status field)
export const RuntimeErrorSchema = z
  .object({
    error: z.string().openapi({ example: "Not found" }),
  })
  .openapi("RuntimeError");
