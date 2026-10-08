/**
 * admin/src/openapi-schemas.ts
 * Zod schemas for the admin API — entity types, request bodies, and common
 * error shapes. Imported by route migrations (OAS-2.1, OAS-2.2).
 *
 * Import z from "@hono/zod-openapi" so .openapi() metadata is available.
 */

import { z } from "@hono/zod-openapi";
import { isGithubLogin } from "@shipwright/lib/github-login";
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

/** Minimal Agent shape for list endpoints (GET /agents). */
export const AgentSummarySchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    name: z.string().openapi({ example: "Bodhi" }),
    selfHosted: z.boolean().openapi({ example: false }),
    typeName: z.string().openapi({ example: "coding" }),
  })
  .openapi("AgentSummary");

export const PatchAgentBodySchema = z
  .object({
    /**
     * Backfills agent.slackId for agents that completed Slack OAuth before
     * UAP-1.3 shipped (it is otherwise resolved automatically via auth.test
     * right after OAuth completes). Nullable so it can also be explicitly
     * cleared.
     */
    slackId: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "U0AALR8M69X" }),
    selfHosted: z.boolean().optional().openapi({ example: false }),
    repos: z
      .array(
        z.string().refine(isOrgRepo, {
          message: "each repo must be in org/repo format",
        }),
      )
      .optional()
      .openapi({ example: ["my-org/my-repo"] }),
    /**
     * GitHub logins permitted to trigger this agent's review/dev-task work.
     */
    reviewAuthorAllowlist: z
      .array(
        z.string().refine(isGithubLogin, {
          message: "each entry must be a valid GitHub login",
        }),
      )
      .optional()
      .openapi({ example: ["octocat"] }),
    /**
     * GitHub logins permitted to trigger patch runs for this agent.
     * Independent of reviewAuthorAllowlist.
     */
    patchAuthorAllowlist: z
      .array(
        z.string().refine(isGithubLogin, {
          message: "each entry must be a valid GitHub login",
        }),
      )
      .optional()
      .openapi({ example: ["octocat"] }),
    restrictSlackToMembers: z.boolean().optional().openapi({ example: false }),
    /**
     * ATE-1.1: trial expiry timestamp. Nullable so it can also be explicitly
     * cleared. trialExpiryWarnedAt is intentionally NOT part of this schema —
     * it is written internally by ATE-2.1's warning check, not user-editable
     * via this route.
     */
    trialExpiresAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: "2026-12-01T00:00:00.000Z" }),
    /**
     * APM-1.3: the six real agent-policy fields (APM-1.1 DB columns). No
     * extra bounds validation beyond int/boolean — matches the existing
     * looseness of this schema (e.g. no min/max on other numeric fields).
     */
    autoPostReviews: z.boolean().optional().openapi({ example: true }),
    allowSelfReview: z.boolean().optional().openapi({ example: false }),
    minConfidence: z.number().int().optional().openapi({ example: 75 }),
    maxFindings: z.number().int().optional().openapi({ example: 5 }),
    cleanupMergedWorktrees: z.boolean().optional().openapi({ example: true }),
    cleanupAfterDays: z.number().int().optional().openapi({ example: 14 }),
  })
  .openapi("PatchAgentBody");

/**
 * POST /agents request body — mirrors createAgent()'s CreateAgentFormInput
 * (admin/src/agents.ts, APA-1.1) field for field: raw, unparsed strings.
 * createAgent() owns all of the parsing (multi-line repo/allowlist/member
 * lists, dedup, format validation), so every optional field here stays a
 * plain string rather than a pre-parsed array — matching exactly what the
 * web UI form at /admin/agents/new submits.
 */
export const CreateAgentBodySchema = z
  .object({
    name: z.string().min(1).openapi({ example: "Bodhi" }),
    typeName: z.string().min(1).openapi({ example: "coding" }),
    /**
     * "in-cluster" means K8s-provisioned; anything else (including absent)
     * means self-hosted.
     */
    runtime: z.string().optional().openapi({ example: "in-cluster" }),
    /** Newline-separated org/repo list. */
    reposRaw: z.string().optional().openapi({ example: "my-org/my-repo" }),
    /** Newline-separated GitHub logins allowed to trigger review/dev-task work. */
    authorAllowlistRaw: z.string().optional().openapi({ example: "octocat" }),
    /** Newline-separated GitHub logins allowed to trigger patch runs. */
    patchAuthorAllowlistRaw: z
      .string()
      .optional()
      .openapi({ example: "octocat" }),
    /** Newline-separated member emails. */
    memberEmailsRaw: z
      .string()
      .optional()
      .openapi({ example: "dev@example.com" }),
    /** Only the literal string "true" enables restrictSlackToMembers. */
    restrictSlackToMembersRaw: z
      .string()
      .optional()
      .openapi({ example: "true" }),
    claudeCodeOauthToken: z.string().optional(),
    anthropicApiKey: z.string().optional(),
  })
  .openapi("CreateAgentBody");

/**
 * DELETE /agents/:id request body. Entirely optional — omit it (or the
 * xoxpToken field) to skip automatic Slack app deletion; a present Slack app
 * then becomes a manual checklist entry instead of a hard failure.
 */
export const DeleteAgentBodySchema = z
  .object({
    xoxpToken: z.string().optional().openapi({ example: "xoxp-user-token" }),
  })
  .openapi("DeleteAgentBody");

/** A single manual operator reminder in DeleteAgentResult.manualStepsRequired. */
const ManualStepSchema = z
  .object({
    key: z.string().openapi({ example: "GH_TOKEN" }),
    message: z.string().openapi({
      example:
        "GH_TOKEN was not automatically revoked — rotate or revoke it manually.",
    }),
  })
  .openapi("ManualStep");

/** A single failed step in DeleteAgentResult.failed. */
const FailedStepSchema = z
  .object({
    step: z.string().openapi({ example: "k8s" }),
    error: z.string().openapi({ example: "k8s API timeout" }),
  })
  .openapi("FailedStep");

/**
 * DELETE /agents/:id response body — the outcome of deleteAgentFully().
 * `agentDeleted: false` means at least one automatable step failed and the
 * Agent row was intentionally preserved for a later retry (see
 * agent-deletion.ts for the full retry/idempotency contract).
 */
export const DeleteAgentResultSchema = z
  .object({
    agentDeleted: z.boolean().openapi({ example: true }),
    completed: z.array(z.string()).openapi({
      example: ["k8s", "task-store-tokens", "chat-service-tokens-and-threads"],
    }),
    failed: z.array(FailedStepSchema),
    manualStepsRequired: z.array(ManualStepSchema),
  })
  .openapi("DeleteAgentResult");

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
    parentCronId: z.string().nullable().openapi({ example: null }),
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

export const ContextBaselineEntrySchema = z
  .object({
    model: z.string().openapi({ example: "claude-sonnet-4-6" }),
    contextTokens: z.number().int().openapi({ example: 79188 }),
    inputTokens: z.number().int().openapi({ example: 2 }),
    cacheCreationTokens: z.number().int().openapi({ example: 41415 }),
    cacheReadTokens: z.number().int().openapi({ example: 37771 }),
  })
  .openapi("ContextBaselineEntry");

export const SkillUsageEntrySchema = z
  .object({
    kind: z.enum(["skill", "agent", "root"]).openapi({ example: "skill" }),
    name: z.string().openapi({ example: "shipwright:task-store" }),
    invocations: z.number().int().openapi({ example: 1 }),
    turns: z.number().int().openapi({ example: 3 }),
    inputTokens: z.number().int().openapi({ example: 12 }),
    outputTokens: z.number().int().openapi({ example: 100 }),
    cacheReadTokens: z.number().int().openapi({ example: 219200 }),
    cacheCreationTokens: z.number().int().openapi({ example: 9300 }),
    invokeContextDelta: z.number().int().nullable().optional().openapi({
      example: 9103,
      description:
        "input + cacheCreation of the first usage-bearing turn after the skill's first invoke — the new context admitted when its body loaded. Null for root/agent rows.",
    }),
  })
  .openapi("SkillUsageEntry");

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
    phaseId: z.string().nullable().openapi({
      example: "clx0987654321",
      description:
        "Child AgentCronJob id (FK) of the pipeline phase this run served (dev-task/review/patch/deploy). Null for legacy five-job crons or ticks with no phase attribution.",
    }),
    itemType: z.string().nullable().openapi({
      example: "task",
      description:
        'Work item type this run was dispatched against ("task" | "pr"). Null when the tick had no dispatch (skipped tick, empty queue).',
    }),
    itemId: z.string().nullable().openapi({
      example: "WLS-2.2",
      description:
        'Work item id this run was dispatched against (e.g. "WLS-2.2" or "acme/x#123"). Null when the tick had no dispatch.',
    }),
    inputTokens: z.number().int().nullable().openapi({ example: 1234 }),
    outputTokens: z.number().int().nullable().openapi({ example: 567 }),
    cacheReadTokens: z.number().int().nullable().openapi({ example: 89 }),
    cacheCreationTokens: z.number().int().nullable().openapi({ example: 10 }),
    sessionId: z.string().nullable().openapi({
      example: "session-abc-123",
      description:
        "Agent session id this run was executed under. Null for runs with no recorded session.",
    }),
    lastHeartbeatAt: z.string().datetime().nullable().openapi({
      example: "2026-01-01T08:00:03.000Z",
      description:
        "Most recent debounced progress-push (recordProgress()) timestamp, sourced from the agent's injected Clock. Null for runs that never reported progress (short/legacy runs).",
    }),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T08:00:00.000Z" }),
    modelBreakdown: z.array(ModelBreakdownEntrySchema).optional(),
    contextBaseline: ContextBaselineEntrySchema.nullable().optional().openapi({
      description:
        "First-turn context baseline (null for resumed sessions and runs from older agent builds).",
    }),
    turns: z.number().int().nullable().optional().openapi({ example: 12 }),
    toolCalls: z.number().int().nullable().optional().openapi({ example: 7 }),
    contextFingerprint: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "abc123def456" }),
    pluginVersion: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "1.363.0" }),
    claudeCodeVersion: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "2.1.285" }),
  })
  .openapi("AgentCronRun");

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
    phaseId: z.string().nullable().optional().openapi({
      example: "clx0987654321",
      description:
        "Child AgentCronJob id (FK) of the pipeline phase this run served (dev-task/review/patch/deploy)",
    }),
    itemType: z.string().nullable().optional().openapi({
      example: "task",
      description:
        'Work item type this run was dispatched against ("task" | "pr")',
    }),
    itemId: z.string().nullable().optional().openapi({
      example: "WLS-2.2",
      description:
        'Work item id this run was dispatched against (e.g. "WLS-2.2" or "acme/x#123")',
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
    sessionId: z.string().nullable().optional().openapi({
      example: "session-abc-123",
      description: "Agent session id this run was executed under.",
    }),
    lastHeartbeatAt: z.string().datetime().nullable().optional().openapi({
      example: "2026-01-01T08:00:03.000Z",
      description:
        "Most recent debounced progress-push (recordProgress()) timestamp, sourced from the agent's injected Clock.",
    }),
    modelBreakdown: z
      .array(ModelBreakdownEntrySchema)
      .optional()
      .openapi({ description: "Per-model token breakdown for this run" }),
    contextBaseline: ContextBaselineEntrySchema.optional().openapi({
      description:
        "First-turn context baseline: usage of the run's first assistant message. contextTokens = input + cacheCreation + cacheRead — the full always-loaded context independent of cache warmth. Omitted for resumed sessions.",
    }),
    turns: z.number().int().nullable().optional().openapi({
      example: 12,
      description: "Distinct usage-bearing assistant turns in the run.",
    }),
    toolCalls: z.number().int().nullable().optional().openapi({
      example: 7,
      description: "Distinct tool_use blocks in the run.",
    }),
    contextFingerprint: z.string().nullable().optional().openapi({
      example: "abc123def456",
      description:
        "sha256[:12] over the workspace's always-loaded markdown (CLAUDE.md, its @imports, no-`paths` rules) + plugin version. Groups runs by what the model was given.",
    }),
    pluginVersion: z.string().nullable().optional().openapi({
      example: "1.363.0",
    }),
    claudeCodeVersion: z.string().nullable().optional().openapi({
      example: "2.1.285",
    }),
    skillUsage: z.array(SkillUsageEntrySchema).optional().openapi({
      description:
        "Per-skill / per-subagent token attribution rows for this run; upserted per [kind, name].",
    }),
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
    /** Narrow to runs dispatched against this work item (e.g. "WLS-2.2" or "acme/x#123"). */
    itemId: z.string().optional().openapi({ example: "acme/x#123" }),
    /** Narrow to runs dispatched by this phase cron (a child AgentCronJob id). */
    phaseId: z.string().optional().openapi({ example: "clx1234567890" }),
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

const AgentCronJobWithRunSummarySchema = AgentCronJobSchema.extend({
  lastRun: CronRunLastRunSchema.nullable().openapi({ example: null }),
  runCountToday: z.number().int().openapi({ example: 3 }),
}).openapi("AgentCronJobWithRunSummary");

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

// ─── AgentPhaseMethodology ──────────────────────────────────────────────────────
//
// The six pipeline phases a methodology override can target. Must stay in
// lockstep with the phases the shipwright-loop cron can dispatch (PDR-4.1
// added "plan-session"/"prd" to the wider pipeline) — see PMC-1.1.

export const AGENT_PHASES = [
  "prd",
  "plan-session",
  "review",
  "patch",
  "deploy",
  "dev-task",
] as const;

export type AgentPhaseName = (typeof AGENT_PHASES)[number];

export const AgentPhaseMethodologySchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    phase: z.enum(AGENT_PHASES).openapi({ example: "review" }),
    subagentType: z
      .string()
      .nullable()
      .openapi({ example: "shipwright:code-reviewer" }),
    updatedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("AgentPhaseMethodology");

export type AgentPhaseMethodology = z.infer<typeof AgentPhaseMethodologySchema>;

export const PutAgentPhaseMethodologyBodySchema = z
  .object({
    subagentType: z
      .string()
      .min(1)
      .nullable()
      .openapi({ example: "shipwright:code-reviewer" }),
  })
  .openapi("PutAgentPhaseMethodologyBody");

export const PhaseParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
  phase: z.enum(AGENT_PHASES).openapi({ example: "review" }),
});

// ─── AgentEnv ─────────────────────────────────────────────────────────────────

/**
 * GET /agents/:id/envs response. Values are decrypted at the service layer.
 * Secret keys are masked as "***" in env and listed in secretKeys.
 */
export const AgentEnvResponseSchema = z
  .object({
    env: z
      .record(z.string(), z.string())
      .openapi({ example: { MY_VAR: "value" } }),
    secretKeys: z.array(z.string()).openapi({ example: ["MY_SECRET"] }),
  })
  .openapi("AgentEnvResponse");

/**
 * POST /agents/:id/envs body — a plain key/value map (full replace).
 */
export const AgentEnvBodySchema = z
  .record(z.string(), z.string())
  .openapi("AgentEnvBody");

/**
 * PATCH /agents/:id/envs body — partial update with optional secret designation.
 * `env` is a map of key/value pairs to upsert.
 * `secretKeys` lists which keys should be flagged as secret (masked in GET responses).
 */
export const AgentEnvPatchBodySchema = z
  .object({
    env: z
      .record(z.string(), z.string())
      .openapi({ example: { MY_VAR: "value" } }),
    secretKeys: z
      .array(z.string())
      .optional()
      .openapi({ example: ["MY_SECRET"] }),
  })
  .openapi("AgentEnvPatchBody");

// ─── AgentWorkQueueSnapshot ───────────────────────────────────────────────────

/**
 * A single ranked work item, mirroring the RankedWorkItem interface in
 * agent/src/work-selector.ts (type/phase are string enums there — validated
 * here for real, since this is a request body needing genuine validation,
 * not just an opaque Json passthrough).
 *
 * `phase` MUST stay in lockstep with RankedWorkItem["phase"] in
 * agent/src/work-selector.ts — the loop orchestrator POSTs a snapshot every
 * tick, so a phase the agent can emit but this enum doesn't list 400s the
 * whole snapshot (PDR-4.1 added "plan").
 */
export const RankedWorkItemSchema = z
  .object({
    type: z.enum(["task", "pr"]).openapi({ example: "task" }),
    id: z.string().openapi({ example: "WLS-2.2" }),
    title: z
      .string()
      .optional()
      .openapi({ example: "Add work queue snapshot endpoints" }),
    phase: z
      .enum(["dev-task", "plan", "review", "patch", "deploy"])
      .openapi({ example: "dev-task" }),
    age: z.string().openapi({
      example: "2026-01-01T00:00:00.000Z",
      description: "ISO timestamp",
    }),
  })
  .openapi("RankedWorkItem");

export type RankedWorkItem = z.infer<typeof RankedWorkItemSchema>;

/**
 * POST /agents/:id/work-queue body — the envelope an agent pushes each time
 * it recomputes its ranked work queue. Upserts the single row for that
 * agentId, overwriting any prior snapshot.
 */
export const PushWorkQueueSnapshotBodySchema = z
  .object({
    computedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    items: z.array(RankedWorkItemSchema),
  })
  .openapi("PushWorkQueueSnapshotBody");

/**
 * GET /agents/:id/work-queue response — the latest pushed snapshot.
 */
export const AgentWorkQueueSnapshotSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    computedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    items: z.array(RankedWorkItemSchema),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("AgentWorkQueueSnapshot");

// ─── AgentGitHubInstallationsSnapshot ─────────────────────────────────────────

/**
 * One GitHub App installation as reported by an agent. The schema is CLOSED
 * (.strict()): unknown fields — notably tokens or other credentials — are
 * rejected with 400 rather than silently stored.
 */
export const GitHubInstallationSchema = z
  .object({
    owner: z.string().min(1).max(200).openapi({ example: "app-vitals" }),
    installationId: z.number().int().positive().openapi({ example: 12345678 }),
    state: z.string().min(1).max(50).openapi({ example: "active" }),
    lastError: z.string().max(500).nullable().optional().openapi({
      description:
        "Sanitized last error message (max 500 chars). Must not contain credentials.",
      example: "installation suspended",
    }),
  })
  .strict()
  .openapi("GitHubInstallation");

/**
 * PUT /agents/:id/github-installations body. Replace-all: the installations
 * array overwrites whatever was previously stored.
 */
export const PutGitHubInstallationsBodySchema = z
  .object({
    reportedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    installations: z.array(GitHubInstallationSchema),
  })
  .strict()
  .openapi("PutGitHubInstallationsBody");

export const AgentGitHubInstallationsSnapshotSchema = z
  .object({
    id: z.string().openapi({ example: "clx1234567890" }),
    agentId: z.string().openapi({ example: "clx1234567890" }),
    reportedAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
    installations: z.array(GitHubInstallationSchema),
    createdAt: z
      .string()
      .datetime()
      .openapi({ example: "2026-01-01T00:00:00.000Z" }),
  })
  .openapi("AgentGitHubInstallationsSnapshot");

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
  phase: z.string().nullable().optional().openapi({ example: "dev-task" }),
}).openapi("DoubleKeyedTokenAggregate");

/** A token aggregate bucketed by day (YYYY-MM-DD). */
const DailyTokenAggregateSchema = TokenAggregateSchema.extend({
  period: z.string().openapi({ example: "2026-01-10" }),
}).openapi("DailyTokenAggregate");

/** Per-(kind, name) skill / subagent usage rollup (PAU-1.6). */
const SkillUsageAggregateSchema = z
  .object({
    kind: z.string().openapi({ example: "skill" }),
    name: z.string().openapi({ example: "shipwright:dev-task" }),
    runs: z.number().int().openapi({ example: 4 }),
    invocations: z.number().int().openapi({ example: 5 }),
    turns: z.number().int().openapi({ example: 40 }),
    input: z.number().int().openapi({ example: 600 }),
    output: z.number().int().openapi({ example: 300 }),
    cacheRead: z.number().int().openapi({ example: 60 }),
    cacheCreation: z.number().int().openapi({ example: 30 }),
    avgInvokeContextDelta: z.number().nullable().openapi({ example: 1200 }),
  })
  .openapi("SkillUsageAggregate");

/** First-turn context baseline per (contextFingerprint, baselineModel, phase). */
const ContextBaselineAggregateSchema = z
  .object({
    contextFingerprint: z.string().nullable().openapi({ example: "a1b2c3" }),
    baselineModel: z
      .string()
      .nullable()
      .openapi({ example: "claude-sonnet-5-5" }),
    phase: z.string().nullable().openapi({ example: "dev-task" }),
    runs: z.number().int().openapi({ example: 12 }),
    avgContextTokens: z.number().openapi({ example: 24000 }),
    minContextTokens: z.number().int().openapi({ example: 23000 }),
    maxContextTokens: z.number().int().openapi({ example: 25000 }),
    avgTurns: z.number().nullable().openapi({ example: 30 }),
    avgToolCalls: z.number().nullable().openapi({ example: 55 }),
    firstSeen: z.string().openapi({ example: "2026-01-10T09:00:00.000Z" }),
    lastSeen: z.string().openapi({ example: "2026-01-15T09:00:00.000Z" }),
  })
  .openapi("ContextBaselineAggregate");

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
    /** Per (kind, name); skipped runs excluded. */
    bySkill: z.array(SkillUsageAggregateSchema).optional(),
    /** Per (fingerprint, model, phase); skipped runs included, runs without a baseline excluded. */
    baselines: z.array(ContextBaselineAggregateSchema).optional(),
  })
  .openapi("CronRunTokenStats");

export type CronRunTokenStatsType = z.infer<typeof CronRunTokenStatsSchema>;

/** One (phase, contextFingerprint) outcome series for GET /agents/all/cron-runs/outcomes. */
const CronRunOutcomeSeriesSchema = z
  .object({
    phase: z.string().nullable().openapi({ example: "dev-task" }),
    contextFingerprint: z
      .string()
      .nullable()
      .openapi({ example: "a1b2c3d4e5f6" }),
    runs: z.number().int(),
    completed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    skipReasons: z
      .record(z.string(), z.number().int())
      .openapi({ example: { "no-ready-task": 3 } }),
    avgDurationMs: z.number().nullable(),
    p50DurationMs: z.number().nullable(),
    avgTurns: z.number().nullable(),
    avgToolCalls: z.number().nullable(),
    avgContextTokens: z.number().nullable(),
  })
  .openapi("CronRunOutcomeSeries");

/** Response shape for GET /agents/all/cron-runs/outcomes. */
export const CronRunOutcomesSchema = z
  .object({ series: z.array(CronRunOutcomeSeriesSchema) })
  .openapi("CronRunOutcomes");

export type CronRunOutcomesType = z.infer<typeof CronRunOutcomesSchema>;

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

const AgentConfigPluginSchema = z
  .object({
    marketplace: z.string().openapi({ example: "shipwright" }),
    plugin: z.string().openapi({ example: "shipwright" }),
  })
  .openapi("AgentConfigPlugin");

export const AgentConfigResponseSchema = z
  .object({
    env: z
      .record(z.string(), z.string())
      .openapi({ example: { SLACK_BOT_TOKEN: "xoxb-..." } }),
    allowedTools: z.array(z.string()).openapi({ example: ["Read", "Write"] }),
    plugins: z.array(AgentConfigPluginSchema),
    repos: z.array(z.string()).openapi({ example: ["org/repo1", "org/repo2"] }),
    reviewAuthorAllowlist: z
      .array(z.string())
      .openapi({ example: ["octocat"] }),
    patchAuthorAllowlist: z.array(z.string()).openapi({ example: ["octocat"] }),
    /**
     * APM-1.5: direct passthrough of the 6 agent-policy fields APM-1.1 added
     * to the Agent row — required, populated by the handler unconditionally.
     */
    autoPostReviews: z.boolean().openapi({ example: true }),
    allowSelfReview: z.boolean().openapi({ example: false }),
    minConfidence: z.number().int().openapi({ example: 75 }),
    maxFindings: z.number().int().openapi({ example: 5 }),
    cleanupMergedWorktrees: z.boolean().openapi({ example: true }),
    cleanupAfterDays: z.number().int().openapi({ example: 14 }),
    restrictSlackToMembers: z.boolean().openapi({ example: false }),
    memberEmails: z.array(z.string()).openapi({ example: ["dev@example.com"] }),
    /**
     * ATE-3.1: ISO timestamp of trial expiry, or null when no trial is
     * configured. Optional — mirrors AgentConfigResponse's own
     * trialExpiresAt (admin/src/api.ts) being optional rather than required.
     */
    trialExpiresAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .openapi({ example: "2026-12-01T00:00:00.000Z" }),
    /**
     * PMC-1.1: phase -> subagentType (or null) map, covering all six pipeline
     * phases (see AGENT_PHASES) regardless of whether the agent has an
     * explicit override row for each — phases without a row default to null.
     */
    phaseMethodology: z.record(z.string(), z.string().nullable()).openapi({
      example: {
        prd: null,
        "plan-session": null,
        review: "shipwright:code-reviewer",
        patch: null,
        deploy: null,
        "dev-task": null,
      },
    }),
  })
  .openapi("AgentConfigResponse");

// Simple error shape for runtime API responses (no status field)
export const RuntimeErrorSchema = z
  .object({
    error: z.string().openapi({ example: "Not found" }),
  })
  .openapi("RuntimeError");
