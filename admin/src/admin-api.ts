/**
 * agent/src/admin-api.ts
 * Admin CRUD API — Hono app factory.
 *
 * Routes mounted at /admin/api/*. Full CRUD for:
 *   - AgentEnv
 *   - AgentCronJob
 *   - AgentTool
 *   - AgentToken
 *   - AgentPlugin
 *
 * Auth: session cookie (httpOnly JWT, SHIPWRIGHT_SESSION_SECRET).
 * Cookie name: admin_session.
 */

import { Hono } from "hono";
import type {
  AgentCronJob,
  AgentToken,
  AgentTool,
} from "../prisma/client/index.js";
import { createAdminAuthMiddleware, parseAdminApiKeys } from "./api-auth.ts";
import type { AdminApiKey } from "./api-auth.ts"; // re-exported below for callers
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import { ApiError, ForbiddenError } from "./errors.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdminDeps {
  agentEnvService: Pick<
    AgentEnvService,
    "upsert" | "patch" | "getByAgentId" | "deleteKey"
  >;
  agentCronJobService: Pick<
    AgentCronJobService,
    "list" | "create" | "update" | "delete" | "reconcileSystemCrons" | "get"
  >;
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
  sessionSecret: string;
  /** Parsed SHIPWRIGHT_ADMIN_API_KEYS — optional; absent means env key auth is disabled. */
  adminApiKeys?: Map<string, AdminApiKey>;
}

// Re-export for callers that need to build the map from an env string.
export { parseAdminApiKeys };

// ─── App factory ──────────────────────────────────────────────────────────────

export function createAdminApp(deps: AdminDeps): Hono {
  const {
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    sessionSecret,
    adminApiKeys,
  } = deps;

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 500 | 502,
      );
    }
    console.error("[admin-api] unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  // Apply combined auth (bearer token OR session cookie) to all /admin/api/* routes
  app.use(
    "/admin/api/*",
    createAdminAuthMiddleware({ sessionSecret, agentTokenService, adminApiKeys }),
  );

  // ─── Env vars ──────────────────────────────────────────────────────────────

  // POST /admin/api/agents/:id/envs — replace all env vars (bulk upsert)
  app.post("/admin/api/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<Record<string, string>>();
    await agentEnvService.upsert(agentId, body);
    return c.json({ ok: true }, 201);
  });

  // GET /admin/api/agents/:id/envs — get all env vars (decrypted)
  app.get("/admin/api/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const env = await agentEnvService.getByAgentId(agentId);
    return c.json({ env: env ?? {} });
  });

  // PATCH /admin/api/agents/:id/envs — update specific keys (without replacing all)
  app.patch("/admin/api/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<Record<string, string>>();
    await agentEnvService.patch(agentId, body);
    return c.json({ ok: true });
  });

  // DELETE /admin/api/agents/:id/envs/:key — delete a single key
  app.delete("/admin/api/agents/:id/envs/:key", async (c) => {
    const agentId = c.req.param("id");
    const key = c.req.param("key");
    await agentEnvService.deleteKey(agentId, key);
    return new Response(null, { status: 204 });
  });

  // ─── Cron jobs ─────────────────────────────────────────────────────────────

  // POST /admin/api/agents/:id/crons — create a cron job
  app.post("/admin/api/agents/:id/crons", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<{
      schedule: string;
      prompt: string;
      channel?: string | null;
      user?: string | null;
      silent?: boolean;
      enabled?: boolean;
      preCheck?: string | null;
      name?: string | null;
    }>();
    const cron: AgentCronJob = await agentCronJobService.create(agentId, body);
    return c.json({ cron }, 201);
  });

  // GET /admin/api/agents/:id/crons — list cron jobs
  app.get("/admin/api/agents/:id/crons", async (c) => {
    const agentId = c.req.param("id");
    const crons: AgentCronJob[] = await agentCronJobService.list(agentId);
    return c.json({ crons });
  });

  // POST /admin/api/agents/:id/crons/reconcile — static path must precede /:cronId routes
  app.post("/admin/api/agents/:id/crons/reconcile", async (c) => {
    const agentId = c.req.param("id");
    const result = await agentCronJobService.reconcileSystemCrons(agentId);
    return c.json(result);
  });

  // PATCH /admin/api/agents/:id/crons/:cronId — update a cron job
  app.patch("/admin/api/agents/:id/crons/:cronId", async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    const body = await c.req.json<{
      schedule: string;
      prompt: string;
      channel?: string | null;
      user?: string | null;
      silent?: boolean;
      preCheck?: string | null;
    }>();
    const cron: AgentCronJob = await agentCronJobService.update(
      agentId,
      cronId,
      body,
    );
    return c.json({ cron });
  });

  // DELETE /admin/api/agents/:id/crons/:cronId — delete a cron job
  app.delete("/admin/api/agents/:id/crons/:cronId", async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    const cron = await agentCronJobService.get(agentId, cronId);
    if (cron.system) {
      throw new ForbiddenError("system crons cannot be deleted");
    }
    await agentCronJobService.delete(agentId, cronId);
    return new Response(null, { status: 204 });
  });

  // ─── Tools ─────────────────────────────────────────────────────────────────

  // POST /admin/api/agents/:id/tools — add a tool pattern
  app.post("/admin/api/agents/:id/tools", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<{ pattern: string }>();
    const tool: AgentTool = await agentToolService.add(agentId, body.pattern);
    return c.json({ tool }, 201);
  });

  // GET /admin/api/agents/:id/tools — list tool patterns
  app.get("/admin/api/agents/:id/tools", async (c) => {
    const agentId = c.req.param("id");
    const tools: AgentTool[] = await agentToolService.list(agentId);
    return c.json({ tools });
  });

  // PATCH /admin/api/agents/:id/tools/:toolId — enable or disable a tool pattern
  app.patch("/admin/api/agents/:id/tools/:toolId", async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    const body = await c.req.json<{ enabled: boolean }>();
    const tool: AgentTool = await agentToolService.toggle(
      agentId,
      toolId,
      body.enabled,
    );
    return c.json({ tool });
  });

  // DELETE /admin/api/agents/:id/tools/:toolId — remove a tool pattern
  app.delete("/admin/api/agents/:id/tools/:toolId", async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    await agentToolService.remove(agentId, toolId);
    return new Response(null, { status: 204 });
  });

  // ─── Tokens ────────────────────────────────────────────────────────────────

  // POST /admin/api/agents/:id/tokens — create a token (returns raw once)
  app.post("/admin/api/agents/:id/tokens", async (c) => {
    const agentId = c.req.param("id");
    let label: string | undefined;
    try {
      const body = await c.req.json<{ label?: string }>();
      label = body.label;
    } catch {
      // body is optional
    }
    const { token, rawToken } = await agentTokenService.create(agentId, label);
    // Return the token record (without the hashed token value) + rawToken
    const { token: _hash, ...tokenMeta } = token;
    return c.json({ token: tokenMeta, rawToken }, 201);
  });

  // GET /admin/api/agents/:id/tokens — list tokens (hash metadata only)
  app.get("/admin/api/agents/:id/tokens", async (c) => {
    const agentId = c.req.param("id");
    const records: AgentToken[] = await agentTokenService.listForAgent(agentId);
    // Never expose the stored hash — return only metadata
    const tokens = records.map(({ token: _hash, ...meta }) => meta);
    return c.json({ tokens });
  });

  // DELETE /admin/api/agents/:id/tokens/:tokenId — revoke a token
  app.delete("/admin/api/agents/:id/tokens/:tokenId", async (c) => {
    const tokenId = c.req.param("tokenId");
    await agentTokenService.revoke(tokenId);
    return new Response(null, { status: 204 });
  });

  // ─── Plugins ───────────────────────────────────────────────────────────────

  // POST /admin/api/agents/:id/plugins — add a plugin
  app.post("/admin/api/agents/:id/plugins", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<{ name: string; version?: string | null }>();
    const plugin = await agentPluginService.add(
      agentId,
      body.name,
      body.version,
    );
    return c.json({ plugin }, 201);
  });

  // GET /admin/api/agents/:id/plugins — list plugins
  app.get("/admin/api/agents/:id/plugins", async (c) => {
    const agentId = c.req.param("id");
    const plugins = await agentPluginService.list(agentId);
    return c.json({ plugins });
  });

  // PATCH /admin/api/agents/:id/plugins?name=<name> — update plugin version (re-upsert)
  // Uses a query param rather than a path segment to support scoped names like
  // "@shipwright/plugin" which contain a literal "/" that breaks path matching.
  app.patch("/admin/api/agents/:id/plugins", async (c) => {
    const agentId = c.req.param("id");
    const name = c.req.query("name");
    if (!name) {
      return c.json({ error: "Missing required query param: name" }, 400);
    }
    const body = await c.req.json<{ version?: string | null }>();
    const plugin = await agentPluginService.add(agentId, name, body.version);
    return c.json({ plugin });
  });

  // DELETE /admin/api/agents/:id/plugins?name=<name> — remove a plugin by name
  // Uses a query param rather than a path segment to support scoped names like
  // "@shipwright/plugin" which contain a literal "/" that breaks path matching.
  app.delete("/admin/api/agents/:id/plugins", async (c) => {
    const agentId = c.req.param("id");
    const name = c.req.query("name");
    if (!name) {
      return c.json({ error: "Missing required query param: name" }, 400);
    }
    await agentPluginService.removeByName(agentId, name);
    return new Response(null, { status: 204 });
  });

  return app;
}
