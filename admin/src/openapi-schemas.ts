/**
 * admin/src/openapi-schemas.ts
 * Zod schemas for the admin API — entity types, request bodies, and common
 * error shapes. Imported by route migrations (OAS-2.1, OAS-2.2).
 *
 * Import z from "@hono/zod-openapi" so .openapi() metadata is available.
 */

import { z } from "@hono/zod-openapi";

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
      .array(z.string())
      .optional()
      .openapi({ example: ["app-vitals/vitals-os"] }),
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
    user: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "U0AALR8M69X" }),
    silent: z.boolean().optional().openapi({ example: false }),
    enabled: z.boolean().optional().openapi({ example: true }),
    preCheck: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "shipwright:check-dev-task.ts" }),
    name: z.string().nullable().optional().openapi({ example: "morning-brief" }),
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
    user: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "U0AALR8M69X" }),
    silent: z.boolean().optional().openapi({ example: false }),
    preCheck: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "shipwright:check-dev-task.ts" }),
    enabled: z.boolean().optional().openapi({ example: true }),
  })
  .openapi("PatchAgentCronJobBody");

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
    label: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "ci-runner" }),
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
    version: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "1.2.3" }),
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
    version: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "1.2.3" }),
  })
  .openapi("CreateAgentPluginBody");

export const PatchAgentPluginBodySchema = z
  .object({
    version: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "1.3.0" }),
  })
  .openapi("PatchAgentPluginBody");

// ─── AgentEnv ─────────────────────────────────────────────────────────────────

/**
 * GET /agents/:id/envs response. Values are decrypted at the service layer.
 */
export const AgentEnvResponseSchema = z
  .object({
    env: z.record(z.string()).openapi({ example: { MY_VAR: "value" } }),
  })
  .openapi("AgentEnvResponse");

/**
 * POST or PATCH /agents/:id/envs body — a plain key/value map.
 */
export const AgentEnvBodySchema = z
  .record(z.string())
  .openapi("AgentEnvBody");

// ─── Path param schemas ───────────────────────────────────────────────────────

export const AgentIdParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
});

export const CronIdParamSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
  cronId: z.string().openapi({ example: "clx0987654321" }),
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

// ─── AgentConfig (runtime GET /agents/:id/config response) ───────────────────

export const AgentConfigPluginSchema = z
  .object({
    marketplace: z.string().openapi({ example: "shipwright" }),
    plugin: z.string().openapi({ example: "shipwright" }),
  })
  .openapi("AgentConfigPlugin");

export const AgentConfigResponseSchema = z
  .object({
    env: z.record(z.string()).openapi({ example: { SLACK_BOT_TOKEN: "xoxb-..." } }),
    allowedTools: z.array(z.string()).openapi({ example: ["Read", "Write"] }),
    plugins: z.array(AgentConfigPluginSchema),
  })
  .openapi("AgentConfigResponse");

// Simple error shape for runtime API responses (no status field)
export const RuntimeErrorSchema = z
  .object({
    error: z.string().openapi({ example: "Not found" }),
  })
  .openapi("RuntimeError");
