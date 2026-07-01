/**
 * agent/src/agents-api.ts
 * Admin CRUD API — OpenAPIHono app factory.
 *
 * Routes mounted at /agents/*. Full CRUD for:
 *   - Agent (create)
 *   - AgentEnv
 *   - AgentCronJob
 *   - AgentTool
 *   - AgentToken
 *   - AgentPlugin
 *
 * Routes are declared via createRoute() with Zod request/response schemas
 * (see openapi-schemas.ts). Malformed request bodies are rejected with 400 by
 * the OpenAPIHono defaultHook before reaching handlers.
 *
 * Auth: admin key (SHIPWRIGHT_ADMIN_API_KEYS) OR per-agent bearer token OR
 *       session cookie (httpOnly JWT, SHIPWRIGHT_SESSION_SECRET).
 * Cookie name: admin_session.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { PrismaClient } from "../prisma/client/index.js";
import type { AgentChatTokenService } from "./agent-chat-tokens.ts";
import type {
  AgentCronJobService,
  AgentCronJobWithRunSummary,
} from "./agent-cron-jobs.ts";
import type { AgentCronRunStatsService } from "./agent-cron-run-stats.ts";
import type { AgentCronRunService } from "./agent-cron-runs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import { createAdminAuthMiddleware, parseAdminApiKeys } from "./api-auth.ts";
import type { AdminApiKey, AdminAuthEnv } from "./api-auth.ts";
import {
  ApiError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./errors.ts";
import {
  AgentChatTokenUsageDailySchema,
  AgentCronJobSchema,
  AgentCronRunSchema,
  AgentEnvBodySchema,
  AgentEnvResponseSchema,
  AgentIdParamSchema,
  AgentPluginSchema,
  AgentSchema,
  AgentSummarySchema,
  AgentTokenSchema,
  AgentToolSchema,
  ChatTokenStatsSchema,
  CreateAgentBodySchema,
  CreateAgentCronJobBodySchema,
  CreateAgentCronRunBodySchema,
  CreateAgentPluginBodySchema,
  CreateAgentTokenBodySchema,
  CreateAgentTokenResponseSchema,
  CreateAgentToolBodySchema,
  CronIdParamSchema,
  CronRunIdParamSchema,
  CronRunTokenStatsSchema,
  CronRunsListSchema,
  CronsWithSummaryWrapperSchema,
  EnvKeyParamSchema,
  ErrorSchema,
  ListCronRunsQuerySchema,
  OkSchema,
  PatchAgentBodySchema,
  PatchAgentCronJobBodySchema,
  PatchAgentCronRunBodySchema,
  PatchAgentPluginBodySchema,
  PatchAgentToolBodySchema,
  PluginNameQuerySchema,
  TokenIdParamSchema,
  ToolIdParamSchema,
  UpsertChatTokenDailyBodySchema,
} from "./openapi-schemas.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdminDeps {
  agentEnvService: Pick<
    AgentEnvService,
    "upsert" | "patch" | "getByAgentId" | "deleteKey"
  >;
  agentCronJobService: Pick<
    AgentCronJobService,
    | "list"
    | "listWithRunSummary"
    | "create"
    | "update"
    | "delete"
    | "reconcileSystemCrons"
    | "get"
    | "setEnabled"
    | "updatePreCheck"
  >;
  agentCronRunService: Pick<AgentCronRunService, "create" | "list" | "patch">;
  agentCronRunStatsService: Pick<AgentCronRunStatsService, "query">;
  agentToolService: Pick<
    AgentToolService,
    "list" | "add" | "remove" | "toggle"
  >;
  agentTokenService: Pick<
    AgentTokenService,
    "create" | "listForAgent" | "revoke" | "validate"
  >;
  agentPluginService: Pick<
    AgentPluginService,
    "list" | "add" | "remove" | "removeByName"
  >;
  agentChatTokenService: Pick<AgentChatTokenService, "upsertDailyByModel" | "queryStats">;
  prisma: Pick<PrismaClient, "agent">;
  /**
   * Provisions (and tears down) the workload backing an agent. Defaults to a
   * no-op when Kubernetes provisioning is disabled (preserving create/delete
   * behavior without a cluster). See `agent-provisioner.ts`.
   */
  provisioner: AgentProvisioner;
  sessionSecret: string;
  /** Parsed SHIPWRIGHT_ADMIN_API_KEYS — optional; absent means env key auth is disabled. */
  adminApiKeys?: Map<string, AdminApiKey>;
}

// Re-export for callers that need to build the map from an env string.
export { parseAdminApiKeys };
export type { AdminApiKey };

// ─── Response schema helpers ────────────────────────────────────────────────────

const ReconcileCronResultSchema = z
  .object({
    created: z.number().int(),
    updated: z.number().int(),
    deleted: z.number().int(),
  })
  .openapi("ReconcileCronResult");

const ReconcileAgentsResultSchema = z
  .object({
    recreated: z.array(z.string()),
    updated: z.array(z.string()),
    orphans: z.array(z.string()),
    failed: z.array(z.object({ agentId: z.string(), error: z.string() })),
  })
  .openapi("ReconcileAgentsResult");

const ProvisionAgentResultSchema = z
  .object({
    resourceName: z.string(),
    secretName: z.string(),
    deploymentName: z.string(),
  })
  .openapi("ProvisionAgentResult");

const ProvisionSkippedResultSchema = z
  .object({
    skipped: z.literal(true),
    reason: z.string(),
  })
  .openapi("ProvisionSkippedResult");

const GetAgentResultSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slackId: z.string().nullable().optional(),
    selfHosted: z.boolean(),
    repos: z.array(z.string()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("GetAgentResult");

const CronWrapperSchema = z
  .object({ cron: AgentCronJobSchema })
  .openapi("CronWrapper");

const ToolWrapperSchema = z
  .object({ tool: AgentToolSchema })
  .openapi("ToolWrapper");

const ToolsWrapperSchema = z
  .object({ tools: z.array(AgentToolSchema) })
  .openapi("ToolsWrapper");

const TokensWrapperSchema = z
  .object({ tokens: z.array(AgentTokenSchema) })
  .openapi("TokensWrapper");

const PluginWrapperSchema = z
  .object({ plugin: AgentPluginSchema })
  .openapi("PluginWrapper");

const PluginsWrapperSchema = z
  .object({ plugins: z.array(AgentPluginSchema) })
  .openapi("PluginsWrapper");

const jsonError = {
  content: { "application/json": { schema: ErrorSchema } },
};

// ─── Route definitions ──────────────────────────────────────────────────────────

const createAgentRoute = createRoute({
  method: "post",
  path: "/agents",
  request: {
    body: {
      content: { "application/json": { schema: CreateAgentBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Agent created",
      content: { "application/json": { schema: AgentSchema } },
    },
    400: { description: "Bad request", ...jsonError },
    403: { description: "Forbidden", ...jsonError },
  },
});

const reconcileAgentsRoute = createRoute({
  method: "post",
  path: "/agents/reconcile",
  responses: {
    200: {
      description: "Reconciliation summary",
      content: { "application/json": { schema: ReconcileAgentsResultSchema } },
    },
    403: { description: "Forbidden", ...jsonError },
  },
});

const provisionAgentRoute = createRoute({
  method: "post",
  path: "/agents/{id}/provision",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description:
        "Agent provisioned (or already-provisioned — idempotent), or skipped for self-hosted agents",
      content: {
        "application/json": {
          schema: z.union([
            ProvisionAgentResultSchema,
            ProvisionSkippedResultSchema,
          ]),
        },
      },
    },
    403: { description: "Forbidden", ...jsonError },
    404: { description: "Agent not found", ...jsonError },
  },
});

const listAgentsRoute = createRoute({
  method: "get",
  path: "/agents",
  responses: {
    200: {
      description: "List of agents",
      content: { "application/json": { schema: z.array(AgentSummarySchema) } },
    },
    403: { description: "Forbidden", ...jsonError },
  },
});

const getAgentRoute = createRoute({
  method: "get",
  path: "/agents/{id}",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "Full agent record",
      content: { "application/json": { schema: GetAgentResultSchema } },
    },
    403: { description: "Forbidden", ...jsonError },
    404: { description: "Agent not found", ...jsonError },
  },
});

const patchAgentRoute = createRoute({
  method: "patch",
  path: "/agents/{id}",
  request: {
    params: AgentIdParamSchema,
    body: {
      content: { "application/json": { schema: PatchAgentBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Agent updated",
      content: { "application/json": { schema: GetAgentResultSchema } },
    },
    400: { description: "Bad request", ...jsonError },
    403: { description: "Forbidden", ...jsonError },
    404: { description: "Agent not found", ...jsonError },
  },
});

const deleteAgentRoute = createRoute({
  method: "delete",
  path: "/agents/{id}",
  request: { params: AgentIdParamSchema },
  responses: {
    204: { description: "Agent deleted" },
    403: { description: "Forbidden", ...jsonError },
    404: { description: "Agent not found", ...jsonError },
  },
});

const upsertEnvsRoute = createRoute({
  method: "post",
  path: "/agents/{id}/envs",
  request: {
    params: AgentIdParamSchema,
    body: { content: { "application/json": { schema: AgentEnvBodySchema } } },
  },
  responses: {
    201: {
      description: "Env vars replaced",
      content: { "application/json": { schema: OkSchema } },
    },
    400: { description: "Bad request", ...jsonError },
  },
});

const getEnvsRoute = createRoute({
  method: "get",
  path: "/agents/{id}/envs",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "Decrypted env vars",
      content: { "application/json": { schema: AgentEnvResponseSchema } },
    },
  },
});

const patchEnvsRoute = createRoute({
  method: "patch",
  path: "/agents/{id}/envs",
  request: {
    params: AgentIdParamSchema,
    body: { content: { "application/json": { schema: AgentEnvBodySchema } } },
  },
  responses: {
    200: {
      description: "Env vars updated",
      content: { "application/json": { schema: OkSchema } },
    },
    400: { description: "Bad request", ...jsonError },
  },
});

const deleteEnvKeyRoute = createRoute({
  method: "delete",
  path: "/agents/{id}/envs/{key}",
  request: { params: EnvKeyParamSchema },
  responses: {
    204: { description: "Key deleted" },
  },
});

const createCronRoute = createRoute({
  method: "post",
  path: "/agents/{id}/crons",
  request: {
    params: AgentIdParamSchema,
    body: {
      content: {
        "application/json": { schema: CreateAgentCronJobBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Cron job created",
      content: { "application/json": { schema: CronWrapperSchema } },
    },
    400: { description: "Bad request", ...jsonError },
  },
});

const reconcileCronsRoute = createRoute({
  method: "post",
  path: "/agents/{id}/crons/reconcile",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "Reconciliation summary",
      content: { "application/json": { schema: ReconcileCronResultSchema } },
    },
  },
});

const patchCronRoute = createRoute({
  method: "patch",
  path: "/agents/{id}/crons/{cronId}",
  request: {
    params: CronIdParamSchema,
    body: {
      content: { "application/json": { schema: PatchAgentCronJobBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Cron job updated",
      content: { "application/json": { schema: CronWrapperSchema } },
    },
    400: { description: "Bad request", ...jsonError },
  },
});

const deleteCronRoute = createRoute({
  method: "delete",
  path: "/agents/{id}/crons/{cronId}",
  request: { params: CronIdParamSchema },
  responses: {
    204: { description: "Cron job deleted" },
    403: { description: "Forbidden", ...jsonError },
  },
});

const listCronsRoute = createRoute({
  method: "get",
  path: "/agents/{id}/crons/summary",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "List of cron jobs with run summary",
      content: {
        "application/json": { schema: CronsWithSummaryWrapperSchema },
      },
    },
    403: { description: "Forbidden", ...jsonError },
  },
});

const createCronRunRoute = createRoute({
  method: "post",
  path: "/agents/{id}/crons/{cronId}/runs",
  request: {
    params: CronIdParamSchema,
    body: {
      content: {
        "application/json": { schema: CreateAgentCronRunBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Run record created",
      content: {
        "application/json": {
          schema: z
            .object({ run: AgentCronRunSchema })
            .openapi("CronRunWrapper"),
        },
      },
    },
    400: { description: "Bad request", ...jsonError },
    404: { description: "Cron job not found", ...jsonError },
  },
});

const listCronRunsRoute = createRoute({
  method: "get",
  path: "/agents/{id}/crons/{cronId}/runs",
  request: {
    params: CronIdParamSchema,
    query: ListCronRunsQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated list of cron runs",
      content: { "application/json": { schema: CronRunsListSchema } },
    },
    404: { description: "Cron job not found", ...jsonError },
  },
});

const patchCronRunRoute = createRoute({
  method: "patch",
  path: "/agents/{id}/crons/{cronId}/runs/{runId}",
  request: {
    params: CronRunIdParamSchema,
    body: {
      content: {
        "application/json": { schema: PatchAgentCronRunBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Run record updated",
      content: {
        "application/json": {
          schema: z
            .object({ run: AgentCronRunSchema })
            .openapi("PatchCronRunWrapper"),
        },
      },
    },
    400: { description: "Bad request", ...jsonError },
    404: { description: "Run not found or not owned by agent", ...jsonError },
  },
});

const createToolRoute = createRoute({
  method: "post",
  path: "/agents/{id}/tools",
  request: {
    params: AgentIdParamSchema,
    body: {
      content: {
        "application/json": { schema: CreateAgentToolBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Tool added",
      content: { "application/json": { schema: ToolWrapperSchema } },
    },
    400: { description: "Bad request", ...jsonError },
  },
});

const listToolsRoute = createRoute({
  method: "get",
  path: "/agents/{id}/tools",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "List of tool patterns",
      content: { "application/json": { schema: ToolsWrapperSchema } },
    },
  },
});

const patchToolRoute = createRoute({
  method: "patch",
  path: "/agents/{id}/tools/{toolId}",
  request: {
    params: ToolIdParamSchema,
    body: {
      content: { "application/json": { schema: PatchAgentToolBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Tool toggled",
      content: { "application/json": { schema: ToolWrapperSchema } },
    },
    400: { description: "Bad request", ...jsonError },
  },
});

const deleteToolRoute = createRoute({
  method: "delete",
  path: "/agents/{id}/tools/{toolId}",
  request: { params: ToolIdParamSchema },
  responses: {
    204: { description: "Tool removed" },
  },
});

const createTokenRoute = createRoute({
  method: "post",
  path: "/agents/{id}/tokens",
  request: {
    params: AgentIdParamSchema,
    body: {
      required: false,
      content: {
        "application/json": { schema: CreateAgentTokenBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Token created (raw value returned once)",
      content: {
        "application/json": { schema: CreateAgentTokenResponseSchema },
      },
    },
  },
});

const listTokensRoute = createRoute({
  method: "get",
  path: "/agents/{id}/tokens",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "List of token metadata",
      content: { "application/json": { schema: TokensWrapperSchema } },
    },
  },
});

const deleteTokenRoute = createRoute({
  method: "delete",
  path: "/agents/{id}/tokens/{tokenId}",
  request: { params: TokenIdParamSchema },
  responses: {
    204: { description: "Token revoked" },
  },
});

const createPluginRoute = createRoute({
  method: "post",
  path: "/agents/{id}/plugins",
  request: {
    params: AgentIdParamSchema,
    body: {
      content: {
        "application/json": { schema: CreateAgentPluginBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Plugin added",
      content: { "application/json": { schema: PluginWrapperSchema } },
    },
    400: { description: "Bad request", ...jsonError },
  },
});

const listPluginsRoute = createRoute({
  method: "get",
  path: "/agents/{id}/plugins",
  request: { params: AgentIdParamSchema },
  responses: {
    200: {
      description: "List of plugins",
      content: { "application/json": { schema: PluginsWrapperSchema } },
    },
  },
});

const patchPluginRoute = createRoute({
  method: "patch",
  path: "/agents/{id}/plugins",
  request: {
    params: AgentIdParamSchema,
    query: PluginNameQuerySchema,
    body: {
      content: { "application/json": { schema: PatchAgentPluginBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Plugin version updated",
      content: { "application/json": { schema: PluginWrapperSchema } },
    },
    400: { description: "Bad request", ...jsonError },
  },
});

const deletePluginRoute = createRoute({
  method: "delete",
  path: "/agents/{id}/plugins",
  request: {
    params: AgentIdParamSchema,
    query: PluginNameQuerySchema,
  },
  responses: {
    204: { description: "Plugin removed" },
    400: { description: "Bad request", ...jsonError },
  },
});

const upsertChatTokenDailyRoute = createRoute({
  method: "post",
  path: "/agents/{id}/chat-tokens/daily",
  request: {
    params: AgentIdParamSchema,
    body: {
      content: {
        "application/json": { schema: UpsertChatTokenDailyBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Updated daily chat token usage rows (one per model)",
      content: {
        "application/json": { schema: z.array(AgentChatTokenUsageDailySchema) },
      },
    },
    400: { description: "Bad request", ...jsonError },
    404: { description: "Agent not found", ...jsonError },
  },
});

const cronRunStatsQuerySchema = z
  .object({
    from: z.string().datetime().optional().openapi({ example: "2026-01-01T00:00:00Z" }),
    to: z.string().datetime().optional().openapi({ example: "2026-02-01T00:00:00Z" }),
  })
  .openapi("CronRunStatsQuery");

const cronRunTokenStatsRoute = createRoute({
  method: "get",
  path: "/agents/all/cron-runs/stats",
  request: {
    query: cronRunStatsQuerySchema,
  },
  responses: {
    200: {
      description: "Aggregated cron-run token stats across all agents",
      content: { "application/json": { schema: CronRunTokenStatsSchema } },
    },
    401: { description: "Unauthorized", ...jsonError },
    403: { description: "Forbidden — requires admin scope", ...jsonError },
  },
});

const chatTokenDailyStatsQuerySchema = z
  .object({
    from: z.string().date().optional().openapi({ example: "2026-01-01" }),
    to: z.string().date().optional().openapi({ example: "2026-02-01" }),
  })
  .openapi("ChatTokenDailyStatsQuery");

const chatTokenDailyStatsRoute = createRoute({
  method: "get",
  path: "/agents/chat-tokens/daily/stats",
  request: {
    query: chatTokenDailyStatsQuerySchema,
  },
  responses: {
    200: {
      description:
        "Aggregated chat token daily stats across all agents",
      content: { "application/json": { schema: ChatTokenStatsSchema } },
    },
    401: { description: "Unauthorized", ...jsonError },
    403: { description: "Forbidden — requires admin scope", ...jsonError },
  },
});

// ─── App factory ──────────────────────────────────────────────────────────────

export function createAdminApp(deps: AdminDeps): OpenAPIHono<AdminAuthEnv> {
  const {
    agentEnvService,
    agentCronJobService,
    agentCronRunService,
    agentCronRunStatsService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    agentChatTokenService,
    prisma,
    provisioner,
    sessionSecret,
    adminApiKeys,
  } = deps;

  const app = new OpenAPIHono<AdminAuthEnv>({
    // Fires when Zod request validation fails — surface a 400 with the issues.
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
    if (err instanceof ApiError) {
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502,
      );
    }
    console.error("[agents-api] unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  const authMiddleware = createAdminAuthMiddleware({
    sessionSecret,
    agentTokenService,
    adminApiKeys,
  });

  // Apply combined auth (bearer token OR session cookie) to all /agents/* routes.
  app.use("/agents/*", authMiddleware);

  // /agents/* covers all /agents/… paths with at least one trailing segment
  // (e.g. /agents/:id, /agents/:id/crons). Only the zero-segment paths
  // (/agents and /agents/reconcile) are not covered above — apply auth to them
  // explicitly.
  app.use("/agents", authMiddleware);
  app.use("/agents/reconcile", authMiddleware);

  // ─── Agents ────────────────────────────────────────────────────────────────

  // POST /agents — create a new agent (admin only)
  app.openapi(createAgentRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError(
        "Only admin bearers and session users can create agents",
      );
    }
    const body = c.req.valid("json");
    const agent = await prisma.agent.create({
      data: {
        name: body.name,
        slackId: body.slackId ?? null,
        selfHosted: body.selfHosted ?? false,
      },
    });

    // Provision the backing workload AFTER the row exists (the provisioner
    // mints a per-agent token tied to the agent id). If provisioning throws,
    // roll the agent row back so we never leave a half-created agent with no
    // workload — then surface the failure as a 5xx via onError. The Noop
    // provisioner never throws, preserving today's create behavior exactly.
    // Self-hosted agents manage their own workload — skip provisioning.
    if (!agent.selfHosted) {
      try {
        await provisioner.provision(agent.id, { slug: agent.name });
      } catch (err) {
        await prisma.agent
          .delete({ where: { id: agent.id } })
          .catch((cleanupErr) => {
            console.error(
              "[agents-api] failed to roll back agent after provision error:",
              cleanupErr,
            );
          });
        throw err;
      }
    }

    return c.json(serializeAgent(agent), 201);
  });

  // POST /agents/reconcile — reconcile K8s Deployment state against the DB (admin only)
  app.openapi(reconcileAgentsRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError(
        "Only admin bearers and session users can reconcile agents",
      );
    }
    const agents = await prisma.agent.findMany({
      select: { id: true, name: true, selfHosted: true },
    });
    // Self-hosted agents manage their own workloads — exclude them from K8s reconciliation.
    const managedAgents = agents.filter((a) => !a.selfHosted);
    const result = await provisioner.reconcile(
      managedAgents.map((a) => ({ id: a.id, slug: a.name })),
    );
    return c.json(result, 200);
  });

  // POST /agents/:id/provision — provision a single agent's K8s workload (admin only).
  // Idempotent: safe to call on an already-provisioned agent.
  app.openapi(provisionAgentRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError(
        "Only admin bearers and session users can provision agents",
      );
    }
    const { id: agentId } = c.req.valid("param");

    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, name: true, selfHosted: true },
    });
    if (!agent) {
      throw new NotFoundError(`agent ${agentId} not found`);
    }

    if (agent.selfHosted) {
      return c.json({ skipped: true as const, reason: "self-hosted" }, 200);
    }

    const { resourceName, secretName, deploymentName } =
      await provisioner.provision(agent.id, { slug: agent.name });
    return c.json({ resourceName, secretName, deploymentName }, 200);
  });

  // GET /agents/:id — get full agent record including selfHosted and repos
  app.openapi(getAgentRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError("Admin access required to get agent");
    }
    const { id: agentId } = c.req.valid("param");
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        name: true,
        slackId: true,
        selfHosted: true,
        repos: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!agent) {
      throw new NotFoundError(`agent ${agentId} not found`);
    }
    return c.json(serializeAgent(agent), 200);
  });

  // PATCH /agents/:id — update agent fields (selfHosted, repos)
  app.openapi(patchAgentRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError("Admin access required to update agent");
    }
    const { id: agentId } = c.req.valid("param");
    const body = c.req.valid("json");

    const existing = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError(`agent ${agentId} not found`);
    }
    const agent = await prisma.agent.update({
      where: { id: agentId },
      data: {
        selfHosted: body.selfHosted,
        ...(body.repos !== undefined ? { repos: body.repos } : {}),
      },
      select: {
        id: true,
        name: true,
        slackId: true,
        selfHosted: true,
        repos: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return c.json(serializeAgent(agent), 200);
  });

  // DELETE /agents/:id — delete an agent and tear down its workload (admin only)
  app.openapi(deleteAgentRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError(
        "Only admin bearers and session users can delete agents",
      );
    }
    const { id: agentId } = c.req.valid("param");

    // 404 on unknown id before any side effects.
    const existing = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError(`agent ${agentId} not found`);
    }

    // Tear down the workload first, then delete the row. Child rows
    // (AgentEnv / AgentCronJob / AgentTool / AgentToken / AgentPlugin) cascade
    // via `onDelete: Cascade` in the Prisma schema. deprovision() tolerates an
    // already-absent workload, so a retried delete is a no-op.
    await provisioner.deprovision(agentId);
    await prisma.agent.delete({ where: { id: agentId } });

    return c.body(null, 204);
  });

  // GET /agents — list all agents (id + name + selfHosted) for metrics name resolution.
  app.openapi(listAgentsRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError("Admin access required to list agents");
    }
    const agents = await prisma.agent.findMany({
      select: { id: true, name: true, selfHosted: true },
      orderBy: { name: "asc" },
    });
    return c.json(agents, 200);
  });

  // ─── Env vars ──────────────────────────────────────────────────────────────

  // POST /agents/:id/envs — replace all env vars (bulk upsert)
  app.openapi(upsertEnvsRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    await agentEnvService.upsert(agentId, body);
    return c.json({ ok: true } as const, 201);
  });

  // GET /agents/:id/envs — get all env vars (decrypted)
  app.openapi(getEnvsRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const env = await agentEnvService.getByAgentId(agentId);
    return c.json({ env: env ?? {} }, 200);
  });

  // PATCH /agents/:id/envs — update specific keys (without replacing all)
  app.openapi(patchEnvsRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    await agentEnvService.patch(agentId, body);
    return c.json({ ok: true } as const, 200);
  });

  // DELETE /agents/:id/envs/:key — delete a single key
  app.openapi(deleteEnvKeyRoute, async (c) => {
    const { id: agentId, key } = c.req.valid("param");
    await agentEnvService.deleteKey(agentId, key);
    return c.body(null, 204);
  });

  // ─── Cron jobs ─────────────────────────────────────────────────────────────

  // POST /agents/:id/crons — create a cron job
  app.openapi(createCronRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const cron = await agentCronJobService.create(agentId, body);
    return c.json({ cron: serializeCron(cron) }, 201);
  });

  // POST /agents/:id/crons/reconcile — static path must precede /:cronId routes
  app.openapi(reconcileCronsRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const result = await agentCronJobService.reconcileSystemCrons(agentId);
    return c.json(result, 200);
  });

  // PATCH /agents/:id/crons/:cronId — update a cron job
  //
  // schedule and prompt must be provided together (content update).
  // enabled and preCheck are orthogonal — each may be sent alone or combined
  // with a content update or with each other. Empty body returns 400.
  // These are business-logic checks (not schema-level), so they remain manual.
  app.openapi(patchCronRoute, async (c) => {
    const { id: agentId, cronId } = c.req.valid("param");
    const body = c.req.valid("json");

    const hasSchedule = body.schedule != null;
    const hasPrompt = body.prompt != null;
    const hasEnabled = body.enabled !== undefined;
    const hasPreCheck = body.preCheck !== undefined;

    if (!hasSchedule && !hasPrompt && !hasEnabled && !hasPreCheck) {
      throw new BadRequestError(
        "provide at least one field: schedule+prompt, enabled, or preCheck",
      );
    }
    if (hasSchedule !== hasPrompt) {
      throw new BadRequestError(
        "schedule and prompt must be provided together",
      );
    }

    let cron: Awaited<ReturnType<AgentCronJobService["update"]>> | undefined;
    if (hasSchedule && hasPrompt) {
      // Content update — preCheck and enabled are folded into update()
      cron = await agentCronJobService.update(agentId, cronId, {
        schedule: body.schedule as string,
        prompt: body.prompt as string,
        channel: body.channel,
        user: body.user,
        silent: body.silent,
        preCheck: body.preCheck,
        enabled: body.enabled,
      });
    } else {
      // Orthogonal-field-only update — apply each independently
      if (hasPreCheck) {
        cron = await agentCronJobService.updatePreCheck(
          agentId,
          cronId,
          body.preCheck as string | null,
        );
      }
      if (hasEnabled) {
        cron = await agentCronJobService.setEnabled(
          agentId,
          cronId,
          body.enabled as boolean,
        );
      }
      // When both ran, fetch final state so the response reflects all writes.
      if (hasPreCheck && hasEnabled) {
        cron = await agentCronJobService.get(agentId, cronId);
      }
    }

    // Narrowing: cron is always set here since at least one update ran (guarded
    // above), but TypeScript cannot prove it through the disjoint if-blocks.
    if (cron === undefined) {
      throw new BadRequestError(
        "provide at least one field: schedule+prompt, enabled, or preCheck",
      );
    }

    return c.json({ cron: serializeCron(cron) }, 200);
  });

  // DELETE /agents/:id/crons/:cronId — delete a cron job
  app.openapi(deleteCronRoute, async (c) => {
    const { id: agentId, cronId } = c.req.valid("param");
    const cron = await agentCronJobService.get(agentId, cronId);
    if (cron.system) {
      throw new ForbiddenError("system crons cannot be deleted");
    }
    await agentCronJobService.delete(agentId, cronId);
    return c.body(null, 204);
  });

  // GET /agents/:id/crons — list cron jobs with run summary
  app.openapi(listCronsRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const jobs = await agentCronJobService.listWithRunSummary(agentId);
    return c.json({ crons: jobs.map(serializeCronWithSummary) }, 200);
  });

  // POST /agents/:id/crons/:cronId/runs — create a cron run record
  // Static path /runs suffix must follow the :cronId param routes
  app.openapi(createCronRunRoute, async (c) => {
    const { id: agentId, cronId } = c.req.valid("param");
    const body = c.req.valid("json");
    const run = await agentCronRunService.create(cronId, agentId, {
      startedAt: new Date(body.startedAt),
      completedAt: body.completedAt ? new Date(body.completedAt) : null,
      skipped: body.skipped,
      skipReason: body.skipReason,
      outcome: body.outcome,
      error: body.error,
    });
    return c.json({ run: serializeCronRun(run) }, 201);
  });

  // GET /agents/:id/crons/:cronId/runs — list cron runs (paginated)
  app.openapi(listCronRunsRoute, async (c) => {
    const { id: agentId, cronId } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");
    const result = await agentCronRunService.list(cronId, agentId, {
      limit,
      offset,
    });
    return c.json(
      {
        items: result.items.map(serializeCronRun),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
      200,
    );
  });

  // PATCH /agents/:id/crons/:cronId/runs/:runId — update a cron run record
  app.openapi(patchCronRunRoute, async (c) => {
    const { id: agentId, cronId, runId } = c.req.valid("param");
    const body = c.req.valid("json");

    // At least one field must be provided
    if (Object.keys(body).length === 0) {
      throw new BadRequestError("provide at least one field to update");
    }

    const run = await agentCronRunService.patch(runId, agentId, cronId, {
      ...(body.completedAt !== undefined && {
        completedAt: body.completedAt ? new Date(body.completedAt) : null,
      }),
      ...(body.outcome !== undefined && { outcome: body.outcome }),
      ...(body.error !== undefined && { error: body.error }),
      ...(body.skipped !== undefined && { skipped: body.skipped }),
      ...(body.skipReason !== undefined && { skipReason: body.skipReason }),
      ...(body.inputTokens !== undefined && { inputTokens: body.inputTokens }),
      ...(body.outputTokens !== undefined && {
        outputTokens: body.outputTokens,
      }),
      ...(body.cacheReadTokens !== undefined && {
        cacheReadTokens: body.cacheReadTokens,
      }),
      ...(body.cacheCreationTokens !== undefined && {
        cacheCreationTokens: body.cacheCreationTokens,
      }),
      ...(body.costUsd !== undefined && { costUsd: body.costUsd }),
      ...(body.model !== undefined && { model: body.model }),
      ...(body.modelBreakdown !== undefined && {
        modelBreakdown: body.modelBreakdown,
      }),
    });

    return c.json({ run: serializeCronRun(run) }, 200);
  });

  // ─── Tools ─────────────────────────────────────────────────────────────────

  // POST /agents/:id/tools — add a tool pattern
  app.openapi(createToolRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tool = await agentToolService.add(agentId, body.pattern);
    return c.json({ tool: serializeTool(tool) }, 201);
  });

  // GET /agents/:id/tools — list tool patterns
  app.openapi(listToolsRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const tools = await agentToolService.list(agentId);
    return c.json({ tools: tools.map(serializeTool) }, 200);
  });

  // PATCH /agents/:id/tools/:toolId — enable or disable a tool pattern
  app.openapi(patchToolRoute, async (c) => {
    const { id: agentId, toolId } = c.req.valid("param");
    const body = c.req.valid("json");
    const tool = await agentToolService.toggle(agentId, toolId, body.enabled);
    return c.json({ tool: serializeTool(tool) }, 200);
  });

  // DELETE /agents/:id/tools/:toolId — remove a tool pattern
  app.openapi(deleteToolRoute, async (c) => {
    const { id: agentId, toolId } = c.req.valid("param");
    await agentToolService.remove(agentId, toolId);
    return c.body(null, 204);
  });

  // ─── Tokens ────────────────────────────────────────────────────────────────

  // POST /agents/:id/tokens — create a token (returns raw once)
  app.openapi(createTokenRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { token, rawToken } = await agentTokenService.create(
      agentId,
      body?.label,
    );
    // Return the token record (without the hashed token value) + rawToken
    const { token: _hash, ...tokenMeta } = token;
    return c.json(
      {
        token: {
          ...tokenMeta,
          createdAt: tokenMeta.createdAt.toISOString(),
          revokedAt: tokenMeta.revokedAt
            ? tokenMeta.revokedAt.toISOString()
            : null,
        },
        rawToken,
      },
      201,
    );
  });

  // GET /agents/:id/tokens — list tokens (hash metadata only)
  app.openapi(listTokensRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const records = await agentTokenService.listForAgent(agentId);
    // Never expose the stored hash — return only metadata
    const tokens = records.map(({ token: _hash, ...meta }) => ({
      ...meta,
      createdAt: meta.createdAt.toISOString(),
      revokedAt: meta.revokedAt ? meta.revokedAt.toISOString() : null,
    }));
    return c.json({ tokens }, 200);
  });

  // DELETE /agents/:id/tokens/:tokenId — revoke a token
  app.openapi(deleteTokenRoute, async (c) => {
    const { tokenId } = c.req.valid("param");
    await agentTokenService.revoke(tokenId);
    return c.body(null, 204);
  });

  // ─── Plugins ───────────────────────────────────────────────────────────────

  // POST /agents/:id/plugins — add a plugin
  app.openapi(createPluginRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const plugin = await agentPluginService.add(
      agentId,
      body.name,
      body.version,
    );
    return c.json({ plugin: serializePlugin(plugin) }, 201);
  });

  // GET /agents/:id/plugins — list plugins
  app.openapi(listPluginsRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const plugins = await agentPluginService.list(agentId);
    return c.json({ plugins: plugins.map(serializePlugin) }, 200);
  });

  // PATCH /agents/:id/plugins?name=<name> — update plugin version (re-upsert)
  // Uses a query param rather than a path segment because a canonical spec like
  // "my-plugin@org/my-marketplace" can contain a literal "/" that breaks path
  // matching. The name param is validated by Zod (PluginNameQuerySchema).
  app.openapi(patchPluginRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const { name } = c.req.valid("query");
    const body = c.req.valid("json");
    const plugin = await agentPluginService.add(agentId, name, body.version);
    return c.json({ plugin: serializePlugin(plugin) }, 200);
  });

  // DELETE /agents/:id/plugins?name=<name> — remove a plugin by name
  app.openapi(deletePluginRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const { name } = c.req.valid("query");
    await agentPluginService.removeByName(agentId, name);
    return c.body(null, 204);
  });

  // ─── Cron-run token stats ──────────────────────────────────────────────────

  // GET /agents/all/cron-runs/stats — aggregated token stats across all agents
  // Static path "all" must be registered before any /:id routes to prevent
  // the literal "all" being matched as an agentId.
  app.openapi(cronRunTokenStatsRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError(
        "Only admin bearers and session users can access cross-agent stats",
      );
    }
    const { from, to } = c.req.valid("query");
    const stats = await agentCronRunStatsService.query(from, to);
    return c.json(stats, 200);
  });

  // GET /agents/chat-tokens/daily/stats — aggregated daily chat token stats
  // Static path "chat-tokens" must be registered before any /:id routes to
  // prevent "chat-tokens" from being matched as an agentId.
  app.openapi(chatTokenDailyStatsRoute, async (c) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError(
        "Only admin bearers and session users can access cross-agent stats",
      );
    }
    const { from, to } = c.req.valid("query");
    const stats = await agentChatTokenService.queryStats(from, to);
    return c.json(stats, 200);
  });

  // ─── Chat token usage ──────────────────────────────────────────────────────

  // POST /agents/:id/chat-tokens/daily — atomically accumulate daily chat token usage per model
  app.openapi(upsertChatTokenDailyRoute, async (c) => {
    const { id: agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const rows = await Promise.all(
      body.modelBreakdown.map((entry) =>
        agentChatTokenService.upsertDailyByModel(agentId, body.date, entry.model, {
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheReadTokens: entry.cacheReadTokens,
          cacheCreationTokens: entry.cacheCreationTokens,
          costUsd: entry.costUsd,
        }),
      ),
    );
    return c.json(rows.map(serializeChatTokenDaily), 200);
  });

  return app;
}

// ─── Serializers ────────────────────────────────────────────────────────────────
//
// Prisma returns Date objects; the Zod response schemas expect ISO strings.
// These helpers normalize date fields so c.json() output matches the schema.

function serializeCron(cron: {
  createdAt: Date;
  updatedAt: Date;
  [k: string]: unknown;
}): z.infer<typeof AgentCronJobSchema> {
  return {
    ...cron,
    createdAt: cron.createdAt.toISOString(),
    updatedAt: cron.updatedAt.toISOString(),
  } as z.infer<typeof AgentCronJobSchema>;
}

function serializeCronWithSummary(job: AgentCronJobWithRunSummary): z.infer<
  typeof AgentCronJobSchema
> & {
  lastRun: {
    startedAt: string;
    completedAt: string | null;
    skipped: boolean;
    outcome: string | null;
  } | null;
  runCountToday: number;
} {
  return {
    id: job.id,
    agentId: job.agentId,
    schedule: job.schedule,
    prompt: job.prompt,
    channel: job.channel,
    user: job.user,
    silent: job.silent,
    enabled: job.enabled,
    preCheck: job.preCheck,
    name: job.name,
    system: job.system,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    lastRun: job.lastRun
      ? {
          startedAt: job.lastRun.startedAt.toISOString(),
          completedAt: job.lastRun.completedAt
            ? job.lastRun.completedAt.toISOString()
            : null,
          skipped: job.lastRun.skipped,
          outcome: job.lastRun.outcome,
        }
      : null,
    runCountToday: job.runCountToday,
  } as ReturnType<typeof serializeCronWithSummary>;
}

function serializeCronRun(run: {
  id: string;
  cronId: string;
  agentId: string;
  startedAt: Date;
  completedAt: Date | null;
  skipped: boolean;
  skipReason: string | null;
  outcome: string | null;
  error: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
  model?: string | null;
  createdAt: Date;
}): z.infer<typeof AgentCronRunSchema> {
  return {
    id: run.id,
    cronId: run.cronId,
    agentId: run.agentId,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    skipped: run.skipped,
    skipReason: run.skipReason,
    outcome: run.outcome,
    error: run.error,
    inputTokens: run.inputTokens ?? null,
    outputTokens: run.outputTokens ?? null,
    cacheReadTokens: run.cacheReadTokens ?? null,
    cacheCreationTokens: run.cacheCreationTokens ?? null,
    costUsd: run.costUsd ?? null,
    model: run.model ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

function serializeTool(tool: {
  createdAt: Date;
  [k: string]: unknown;
}): z.infer<typeof AgentToolSchema> {
  return {
    ...tool,
    createdAt: tool.createdAt.toISOString(),
  } as z.infer<typeof AgentToolSchema>;
}

function serializePlugin(plugin: {
  createdAt: Date;
  updatedAt: Date;
  [k: string]: unknown;
}): z.infer<typeof AgentPluginSchema> {
  return {
    ...plugin,
    createdAt: plugin.createdAt.toISOString(),
    updatedAt: plugin.updatedAt.toISOString(),
  } as z.infer<typeof AgentPluginSchema>;
}

function serializeAgent(agent: {
  id: string;
  name: string;
  slackId: string | null | undefined;
  selfHosted: boolean;
  repos?: string[];
  createdAt: Date;
  updatedAt: Date;
}): z.infer<typeof GetAgentResultSchema> {
  return {
    id: agent.id,
    name: agent.name,
    slackId: agent.slackId,
    selfHosted: agent.selfHosted,
    repos: agent.repos ?? [],
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  };
}

function serializeChatTokenDaily(row: {
  id: string;
  agentId: string;
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  createdAt: Date;
  updatedAt: Date;
}): z.infer<typeof AgentChatTokenUsageDailySchema> {
  return {
    id: row.id,
    agentId: row.agentId,
    date: row.date,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    costUsd: row.costUsd,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
