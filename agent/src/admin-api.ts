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

import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import type {
  AgentCronJob,
  AgentToken,
  AgentTool,
} from "../prisma/client/index.js";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import { ApiError } from "./errors.ts";

export interface AdminDeps {
  agentEnvService: Pick<
    AgentEnvService,
    "upsert" | "patch" | "getByAgentId" | "deleteKey"
  >;
  agentCronJobService: Pick<
    AgentCronJobService,
    "list" | "create" | "update" | "delete" | "reconcileSystemCrons"
  >;
  agentToolService: Pick<
    AgentToolService,
    "list" | "add" | "remove" | "toggle"
  >;
  agentTokenService: Pick<
    AgentTokenService,
    "create" | "listForAgent" | "revoke"
  >;
  agentPluginService: Pick<AgentPluginService, "list" | "add" | "remove" | "removeByName">;
  sessionSecret: string;
}

const SESSION_COOKIE = "admin_session";

function createSessionAuthMiddleware(sessionSecret: string): MiddlewareHandler {
  return async (c, next) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (!sessionToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    try {
      const payload = (await verify(
        sessionToken,
        sessionSecret,
        "HS256",
      )) as Record<string, unknown>;
      if (
        typeof payload.userId !== "string" ||
        !payload.userId ||
        typeof payload.email !== "string" ||
        !payload.email
      ) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  };
}

export function createAdminApp(deps: AdminDeps): Hono {
  const {
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    sessionSecret,
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

  app.use("/admin/api/*", createSessionAuthMiddleware(sessionSecret));

  // Env vars routes (upsert, get, patch, delete-key)
  app.post("/admin/api/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<Record<string, string>>();
    await agentEnvService.upsert(agentId, body);
    return c.json({ ok: true });
  });

  app.get("/admin/api/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const env = await agentEnvService.getByAgentId(agentId);
    return c.json({ env: env ?? {} });
  });

  app.patch("/admin/api/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<Record<string, string>>();
    await agentEnvService.patch(agentId, body);
    return c.json({ ok: true });
  });

  app.delete("/admin/api/agents/:id/envs/:key", async (c) => {
    const agentId = c.req.param("id");
    const key = c.req.param("key");
    await agentEnvService.deleteKey(agentId, key);
    return new Response(null, { status: 204 });
  });

  // Cron job routes
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

  app.delete("/admin/api/agents/:id/crons/:cronId", async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    await agentCronJobService.delete(agentId, cronId);
    return new Response(null, { status: 204 });
  });

  // Tool routes
  app.post("/admin/api/agents/:id/tools", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<{ pattern: string }>();
    const tool: AgentTool = await agentToolService.add(agentId, body.pattern);
    return c.json({ tool }, 201);
  });

  app.get("/admin/api/agents/:id/tools", async (c) => {
    const agentId = c.req.param("id");
    const tools: AgentTool[] = await agentToolService.list(agentId);
    return c.json({ tools });
  });

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

  app.delete("/admin/api/agents/:id/tools/:toolId", async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    await agentToolService.remove(agentId, toolId);
    return new Response(null, { status: 204 });
  });

  // Token routes
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
    const { token: _hash, ...tokenMeta } = token;
    return c.json({ token: tokenMeta, rawToken }, 201);
  });

  app.get("/admin/api/agents/:id/tokens", async (c) => {
    const agentId = c.req.param("id");
    const records: AgentToken[] = await agentTokenService.listForAgent(agentId);
    const tokens = records.map(({ token: _hash, ...meta }) => meta);
    return c.json({ tokens });
  });

  app.delete("/admin/api/agents/:id/tokens/:tokenId", async (c) => {
    const tokenId = c.req.param("tokenId");
    await agentTokenService.revoke(tokenId);
    return new Response(null, { status: 204 });
  });

  // Plugin routes
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

  app.get("/admin/api/agents/:id/plugins", async (c) => {
    const agentId = c.req.param("id");
    const plugins = await agentPluginService.list(agentId);
    return c.json({ plugins });
  });

  app.patch("/admin/api/agents/:id/plugins/:name", async (c) => {
    const agentId = c.req.param("id");
    const name = c.req.param("name");
    const body = await c.req.json<{ version?: string | null }>();
    const plugin = await agentPluginService.add(agentId, name, body.version);
    return c.json({ plugin });
  });

  app.delete("/admin/api/agents/:id/plugins/:name", async (c) => {
    const agentId = c.req.param("id");
    const name = c.req.param("name");
    await agentPluginService.removeByName(agentId, name);
    return new Response(null, { status: 204 });
  });

  return app;
}
