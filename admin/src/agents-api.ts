/**
 * agent/src/agents-api.ts
 * Admin CRUD API — Hono app factory.
 *
 * Routes mounted at /agents/*. Full CRUD for:
 *   - Agent (create)
 *   - AgentEnv
 *   - AgentCronJob
 *   - AgentTool
 *   - AgentToken
 *   - AgentPlugin
 *
 * Auth: admin key (SHIPWRIGHT_ADMIN_API_KEYS) OR per-agent bearer token OR
 *       session cookie (httpOnly JWT, SHIPWRIGHT_SESSION_SECRET).
 * Cookie name: admin_session.
 */

import { Hono } from "hono";
import type {
  AgentCronJob,
  AgentToken,
  AgentTool,
  PrismaClient,
} from "../prisma/client/index.js";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import { createAdminAuthMiddleware, parseAdminApiKeys } from "./api-auth.ts";
import type { AdminApiKey, AdminAuthEnv } from "./api-auth.ts";
import { ApiError, BadRequestError, ForbiddenError } from "./errors.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AdminDeps {
  agentEnvService: Pick<
    AgentEnvService,
    "upsert" | "patch" | "getByAgentId" | "deleteKey"
  >;
  agentCronJobService: Pick<
    AgentCronJobService,
    | "list"
    | "create"
    | "update"
    | "delete"
    | "reconcileSystemCrons"
    | "get"
    | "setEnabled"
    | "updatePreCheck"
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
  prisma: Pick<PrismaClient, "agent">;
  sessionSecret: string;
  /** Parsed SHIPWRIGHT_ADMIN_API_KEYS — optional; absent means env key auth is disabled. */
  adminApiKeys?: Map<string, AdminApiKey>;
}

// Re-export for callers that need to build the map from an env string.
export { parseAdminApiKeys };
export type { AdminApiKey };

// ─── App factory ──────────────────────────────────────────────────────────────

export function createAdminApp(deps: AdminDeps): Hono<AdminAuthEnv> {
  const {
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    prisma,
    sessionSecret,
    adminApiKeys,
  } = deps;

  const app = new Hono<AdminAuthEnv>();

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

  // Apply combined auth (bearer token OR session cookie) to all /agents/* routes
  app.use(
    "/agents/*",
    createAdminAuthMiddleware({
      sessionSecret,
      agentTokenService,
      adminApiKeys,
    }),
  );

  // ─── Agents ────────────────────────────────────────────────────────────────

  // POST /agents — create a new agent (admin only)
  // Note: /agents route without :id — not covered by /agents/* middleware above.
  // Auth is checked manually in the handler via c.get("isAdmin").
  // The middleware is applied to /agents/* (with trailing path), so POST /agents
  // does NOT go through auth middleware — we re-apply it here explicitly.
  app.post(
    "/agents",
    createAdminAuthMiddleware({
      sessionSecret,
      agentTokenService,
      adminApiKeys,
    }),
    async (c) => {
      if (c.get("isAdmin") !== true) {
        throw new ForbiddenError(
          "Only admin bearers and session users can create agents",
        );
      }
      const body = await c.req.json<{ name?: string; slackId?: string }>();
      if (!body.name || typeof body.name !== "string") {
        throw new BadRequestError("name is required");
      }
      const agent = await prisma.agent.create({
        data: { name: body.name, slackId: body.slackId ?? null },
      });
      return c.json(
        {
          id: agent.id,
          name: agent.name,
          slackId: agent.slackId,
          createdAt: agent.createdAt,
        },
        201,
      );
    },
  );

  // GET /agents — list all agents (id + name) for metrics name resolution.
  // Not covered by /agents/* middleware — auth applied explicitly like POST /agents.
  app.get(
    "/agents",
    createAdminAuthMiddleware({
      sessionSecret,
      agentTokenService,
      adminApiKeys,
    }),
    async (c) => {
      if (c.get("isAdmin") !== true) {
        throw new ForbiddenError("Admin access required to list agents");
      }
      const agents = await prisma.agent.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
      return c.json(agents);
    },
  );

  // ─── Env vars ──────────────────────────────────────────────────────────────

  // POST /agents/:id/envs — replace all env vars (bulk upsert)
  app.post("/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<Record<string, string>>();
    await agentEnvService.upsert(agentId, body);
    return c.json({ ok: true }, 201);
  });

  // GET /agents/:id/envs — get all env vars (decrypted)
  app.get("/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const env = await agentEnvService.getByAgentId(agentId);
    return c.json({ env: env ?? {} });
  });

  // PATCH /agents/:id/envs — update specific keys (without replacing all)
  app.patch("/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<Record<string, string>>();
    await agentEnvService.patch(agentId, body);
    return c.json({ ok: true });
  });

  // DELETE /agents/:id/envs/:key — delete a single key
  app.delete("/agents/:id/envs/:key", async (c) => {
    const agentId = c.req.param("id");
    const key = c.req.param("key");
    await agentEnvService.deleteKey(agentId, key);
    return new Response(null, { status: 204 });
  });

  // ─── Cron jobs ─────────────────────────────────────────────────────────────

  // POST /agents/:id/crons — create a cron job
  app.post("/agents/:id/crons", async (c) => {
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

  // POST /agents/:id/crons/reconcile — static path must precede /:cronId routes
  app.post("/agents/:id/crons/reconcile", async (c) => {
    const agentId = c.req.param("id");
    const result = await agentCronJobService.reconcileSystemCrons(agentId);
    return c.json(result);
  });

  // PATCH /agents/:id/crons/:cronId — update a cron job
  //
  // schedule and prompt must be provided together (content update).
  // enabled and preCheck are orthogonal — each may be sent alone or combined
  // with a content update or with each other. Empty body returns 400.
  app.patch("/agents/:id/crons/:cronId", async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    const body = await c.req.json<{
      schedule?: string;
      prompt?: string;
      channel?: string | null;
      user?: string | null;
      silent?: boolean;
      preCheck?: string | null;
      enabled?: boolean;
    }>();

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

    let cron: AgentCronJob;
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
    }

    return c.json({ cron: cron! });
  });

  // DELETE /agents/:id/crons/:cronId — delete a cron job
  app.delete("/agents/:id/crons/:cronId", async (c) => {
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

  // POST /agents/:id/tools — add a tool pattern
  app.post("/agents/:id/tools", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<{ pattern: string }>();
    const tool: AgentTool = await agentToolService.add(agentId, body.pattern);
    return c.json({ tool }, 201);
  });

  // GET /agents/:id/tools — list tool patterns
  app.get("/agents/:id/tools", async (c) => {
    const agentId = c.req.param("id");
    const tools: AgentTool[] = await agentToolService.list(agentId);
    return c.json({ tools });
  });

  // PATCH /agents/:id/tools/:toolId — enable or disable a tool pattern
  app.patch("/agents/:id/tools/:toolId", async (c) => {
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

  // DELETE /agents/:id/tools/:toolId — remove a tool pattern
  app.delete("/agents/:id/tools/:toolId", async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    await agentToolService.remove(agentId, toolId);
    return new Response(null, { status: 204 });
  });

  // ─── Tokens ────────────────────────────────────────────────────────────────

  // POST /agents/:id/tokens — create a token (returns raw once)
  app.post("/agents/:id/tokens", async (c) => {
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

  // GET /agents/:id/tokens — list tokens (hash metadata only)
  app.get("/agents/:id/tokens", async (c) => {
    const agentId = c.req.param("id");
    const records: AgentToken[] = await agentTokenService.listForAgent(agentId);
    // Never expose the stored hash — return only metadata
    const tokens = records.map(({ token: _hash, ...meta }) => meta);
    return c.json({ tokens });
  });

  // DELETE /agents/:id/tokens/:tokenId — revoke a token
  app.delete("/agents/:id/tokens/:tokenId", async (c) => {
    const tokenId = c.req.param("tokenId");
    await agentTokenService.revoke(tokenId);
    return new Response(null, { status: 204 });
  });

  // ─── Plugins ───────────────────────────────────────────────────────────────

  // POST /agents/:id/plugins — add a plugin
  app.post("/agents/:id/plugins", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.json<{ name: string; version?: string | null }>();
    const plugin = await agentPluginService.add(
      agentId,
      body.name,
      body.version,
    );
    return c.json({ plugin }, 201);
  });

  // GET /agents/:id/plugins — list plugins
  app.get("/agents/:id/plugins", async (c) => {
    const agentId = c.req.param("id");
    const plugins = await agentPluginService.list(agentId);
    return c.json({ plugins });
  });

  // PATCH /agents/:id/plugins?name=<name> — update plugin version (re-upsert)
  // Uses a query param rather than a path segment to support scoped names like
  // "@shipwright/plugin" which contain a literal "/" that breaks path matching.
  app.patch("/agents/:id/plugins", async (c) => {
    const agentId = c.req.param("id");
    const name = c.req.query("name");
    if (!name) {
      return c.json({ error: "Missing required query param: name" }, 400);
    }
    const body = await c.req.json<{ version?: string | null }>();
    const plugin = await agentPluginService.add(agentId, name, body.version);
    return c.json({ plugin });
  });

  // DELETE /agents/:id/plugins?name=<name> — remove a plugin by name
  // Uses a query param rather than a path segment to support scoped names like
  // "@shipwright/plugin" which contain a literal "/" that breaks path matching.
  app.delete("/agents/:id/plugins", async (c) => {
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
