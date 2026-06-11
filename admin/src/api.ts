/**
 * agent/src/api.ts
 * Hono runtime API — GET /:id/config and GET /:id/crons.
 *
 * Mounted at /agents/* via root.route("/agents", runtimeApp).
 * Hono v4's .route() strips the prefix before dispatching — routes must be
 * registered without the /agents prefix so they resolve correctly at
 * GET /agents/:id/config and GET /agents/:id/crons from the root.
 * Auth via SHIPWRIGHT_INTERNAL_API_KEY bearer token.
 * This is the endpoint the harness polls every 60s.
 *
 * NOTE: The internal key middleware is scoped per-route (not global app.use("*")).
 * Using app.use("*") in a sub-app mounted via root.route("/agents", runtimeApp)
 * causes Hono v4 to hoist the middleware as a /agents/* guard in root — which
 * blocks all admin CRUD requests (POST/PATCH/DELETE /agents/:id/*) before they
 * reach the admin handlers. Per-route middleware confines the check to only the
 * two routes that need it.
 */

import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { AgentCronJob } from "./agent-cron-jobs.ts";
import type { AgentEnvBundle } from "./agent-envs.ts";

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
  internalApiKey: string;
}

// ─── openapi-fetch paths type ─────────────────────────────────────────────────

/**
 * Typed paths for the two runtime GET endpoints — use with createClient<RuntimeApiPaths>().
 *
 * These paths reflect the full URL as seen by clients (root-level paths),
 * not the sub-app registration paths (which omit the /agents prefix).
 */
export interface RuntimeApiPaths {
  "/agents/{agentId}/config": {
    get: {
      parameters: { path: { agentId: string } };
      responses: {
        200: { content: { "application/json": AgentConfigResponse } };
        401: { content: { "application/json": { error: string } } };
        404: { content: { "application/json": { error: string } } };
      };
    };
  };
  "/agents/{agentId}/crons": {
    get: {
      parameters: { path: { agentId: string } };
      responses: {
        200: { content: { "application/json": AgentCronJob[] } };
        401: { content: { "application/json": { error: string } } };
        404: { content: { "application/json": { error: string } } };
      };
    };
  };
}

/** Typed paths for the admin POST endpoint — use with createClient<AdminApiPaths>(). */
export interface AdminApiPaths {
  "/agents/{agentId}/crons/reconcile": {
    post: {
      parameters: { path: { agentId: string } };
      responses: {
        200: {
          content: {
            "application/json": {
              created: number;
              updated: number;
              deleted: number;
            };
          };
        };
        401: { content: { "application/json": { error: string } } };
        404: { content: { "application/json": { error: string } } };
      };
    };
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates the Hono runtime API app.
 *
 * Inject real services for production; inject mocks for tests.
 */
export function createAgentRuntimeApp(deps: AgentRuntimeDeps): Hono {
  const { agentEnvService, agentCronJobService, prisma, internalApiKey } = deps;

  const app = new Hono();

  // Internal key check — applied per-route, NOT as app.use("*").
  // See file-level comment for why global middleware is avoided here.
  const requireInternalKey = async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token || token !== internalApiKey) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    await next();
  };

  // ─── GET /:id/config ─────────────────────────────────────────────────────
  //     Reachable from root as GET /agents/:id/config (Hono v4 strips prefix)

  app.get("/:id/config", requireInternalKey, async (c) => {
    const id = c.req.param("id") ?? "";

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
      plugins: plugins.map((p) => ({
        // Derive the marketplace from the plugin's namespace (scoped names like
        // "@vitals-os/plugin" install from their own registry); default to
        // "shipwright" for unscoped names.
        marketplace: p.name.startsWith("@")
          ? p.name.split("/")[0].slice(1)
          : "shipwright",
        plugin: p.name,
      })),
    };

    return c.json(response, 200);
  });

  // ─── GET /:id/crons ──────────────────────────────────────────────────────
  //     Reachable from root as GET /agents/:id/crons (Hono v4 strips prefix)

  app.get("/:id/crons", requireInternalKey, async (c) => {
    const id = c.req.param("id") ?? "";

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
