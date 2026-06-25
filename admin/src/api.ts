/**
 * agent/src/api.ts
 * Hono runtime API — GET /:id/config and GET /:id/crons.
 *
 * Mounted at /agents/* via root.route("/agents", runtimeApp).
 * Hono v4's .route() strips the prefix before dispatching — routes must be
 * registered without the /agents prefix so they resolve correctly at
 * GET /agents/:id/config and GET /agents/:id/crons from the root.
 *
 * Auth: same admin-key / per-agent-token / session-cookie middleware as the
 * CRUD routes (SHIPWRIGHT_INTERNAL_API_KEY removed in UNI-1.2).
 * This is the endpoint the harness polls every 60s.
 *
 * NOTE: Auth middleware is scoped per-route (not global app.use("*")).
 * Using app.use("*") in a sub-app mounted via root.route("/agents", runtimeApp)
 * causes Hono v4 to hoist the middleware as a /agents/* guard in root — which
 * blocks all admin CRUD requests (POST/PATCH/DELETE /agents/:id/*) before they
 * reach the admin handlers. Per-route middleware confines the check to only the
 * two routes that need it.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AgentCronJob } from "./agent-cron-jobs.ts";
import type { AgentEnvBundle } from "./agent-envs.ts";
import {
  type AdminApiKey,
  createAdminAuthMiddleware,
} from "./api-auth.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import {
  AgentConfigResponseSchema,
  AgentCronJobSchema,
  AgentIdParamSchema,
  RuntimeErrorSchema,
} from "./openapi-schemas.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentPlugin {
  marketplace: string;
  plugin: string;
}

export interface AgentConfigResponse {
  env: Record<string, string>;
  allowedTools: string[];
  plugins: AgentPlugin[];
}

interface AgentEnvServiceLike {
  getConfigBundle(agentId: string): Promise<AgentEnvBundle | null>;
}

interface AgentCronJobServiceLike {
  list(agentId: string): Promise<AgentCronJob[]>;
  listWithRunSummary?(agentId: string): Promise<Array<AgentCronJob & { lastRun: null | { startedAt: Date; completedAt: Date | null; skipped: boolean; outcome: string | null }; runCountToday: number }>>;
}

interface PrismaLike {
  agent: {
    findUnique(args: { where: { id: string } }): Promise<{ id: string } | null>;
  };
  agentPlugin: {
    findMany(args: {
      where: { agentId: string; enabled: boolean };
    }): Promise<Array<{ name: string }>>;
  };
}

export interface AgentRuntimeDeps {
  agentEnvService: AgentEnvServiceLike;
  agentCronJobService: AgentCronJobServiceLike;
  prisma: PrismaLike;
  /** Session secret for cookie auth (SHIPWRIGHT_SESSION_SECRET). */
  sessionSecret: string;
  /** Parsed SHIPWRIGHT_ADMIN_API_KEYS — optional; absent means env key auth is disabled. */
  adminApiKeys?: Map<string, AdminApiKey>;
  /** Token service for per-agent bearer token validation. */
  agentTokenService: Pick<AgentTokenService, "validate">;
}

// ─── Route definitions ────────────────────────────────────────────────────────

const getConfigRoute = createRoute({
  method: "get",
  path: "/:id/config",
  tags: ["runtime"],
  summary: "Get agent config bundle",
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentIdParamSchema,
  },
  responses: {
    200: {
      description: "Agent config bundle",
      content: { "application/json": { schema: AgentConfigResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: RuntimeErrorSchema } },
    },
    404: {
      description: "Agent not found",
      content: { "application/json": { schema: RuntimeErrorSchema } },
    },
  },
});

const getCronsRoute = createRoute({
  method: "get",
  path: "/:id/crons",
  tags: ["runtime"],
  summary: "List agent cron jobs",
  security: [{ bearerAuth: [] }],
  request: {
    params: AgentIdParamSchema,
  },
  responses: {
    200: {
      description: "Array of cron jobs",
      content: {
        "application/json": { schema: z.array(AgentCronJobSchema) },
      },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: RuntimeErrorSchema } },
    },
    404: {
      description: "Agent not found",
      content: { "application/json": { schema: RuntimeErrorSchema } },
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates the OpenAPIHono runtime API app.
 *
 * Inject real services for production; inject mocks for tests.
 */
export function createAgentRuntimeApp(deps: AgentRuntimeDeps): OpenAPIHono {
  const { agentEnvService, agentCronJobService, prisma } = deps;

  const app = new OpenAPIHono();

  // Auth middleware — applied per-route, NOT as app.use("*").
  // See file-level comment for why global middleware is avoided here.
  const requireAuth = createAdminAuthMiddleware({
    sessionSecret: deps.sessionSecret,
    adminApiKeys: deps.adminApiKeys,
    agentTokenService: deps.agentTokenService,
  });

  // ─── GET /:id/config ─────────────────────────────────────────────────────
  //     Reachable from root as GET /agents/:id/config (Hono v4 strips prefix)

  app.use("/:id/config", requireAuth);

  app.openapi(getConfigRoute, async (c) => {
    const { id } = c.req.valid("param");

    // Check agent existence
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      return c.json({ error: "Not found" }, 404);
    }

    // Fetch env bundle and plugins in parallel
    const [bundle, plugins] = await Promise.all([
      agentEnvService.getConfigBundle(id),
      prisma.agentPlugin.findMany({ where: { agentId: id, enabled: true } }),
    ]);

    const response: AgentConfigResponse = {
      env: bundle?.env ?? {},
      allowedTools: bundle?.allowedTools ?? [],
      plugins: plugins.map((p) => {
        // The stored name is the canonical Claude plugin spec — exactly what
        // you'd pass to `claude plugin install`: "<plugin>@<marketplace>"
        // (e.g. "shipwright@shipwright"), or a bare "<plugin>" that defaults to
        // the bundled "shipwright" marketplace. The harness reassembles
        // "<plugin>@<marketplace>" from these two fields.
        const at = p.name.indexOf("@");
        return at === -1
          ? { marketplace: "shipwright", plugin: p.name }
          : { plugin: p.name.slice(0, at), marketplace: p.name.slice(at + 1) };
      }),
    };

    return c.json(response, 200);
  });

  // ─── GET /:id/crons ──────────────────────────────────────────────────────
  //     Reachable from root as GET /agents/:id/crons (Hono v4 strips prefix)

  app.use("/:id/crons", requireAuth);

  app.openapi(getCronsRoute, async (c) => {
    const { id } = c.req.valid("param");

    // Check agent existence
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      return c.json({ error: "Not found" }, 404);
    }

    const crons = await agentCronJobService.list(id);
    return c.json(crons, 200);
  });

  return app;
}
