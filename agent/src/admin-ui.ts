/**
 * agent/src/admin-ui.ts
 * Admin UI — server-rendered HTML routes.
 *
 * Routes:
 *   GET  /admin/login               → login page
 *   POST /admin/login               → authenticate, set session cookie
 *   POST /admin/logout              → clear cookie, redirect
 *   GET  /admin/agents              → agent list (auth required)
 *   GET  /admin/agents/:id          → agent detail (auth required)
 *   POST /admin/agents/:id/envs     → patch env var, redirect
 *   POST /admin/agents/:id/envs/delete → delete env key, redirect
 *   POST /admin/agents/:id/slack-connect → start Slack OAuth
 *   GET  /admin/oauth/slack/callback    → handle Slack OAuth callback
 *   POST /admin/agents/:id/slack-app-token → store SLACK_APP_TOKEN
 */

import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { AgentEnvService } from "./agent-envs.ts";
import type { SlackProvisionService } from "./slack-provision.ts";
import {
  renderLoginPage,
  renderAgentsPage,
  renderAgentDetailPage,
  type AgentSummary,
  type AgentDetail,
} from "./admin-ui-templates.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type { AgentSummary, AgentDetail };

export interface AgentRepository {
  list(): Promise<AgentSummary[]>;
  findById(id: string): Promise<AgentDetail | null>;
}

export interface AdminUIDeps {
  agentRepo: AgentRepository;
  agentEnvService: Pick<AgentEnvService, "patch" | "deleteKey" | "getByAgentId">;
  slackProvisionService?: SlackProvisionService;
  sessionSecret: string;
  adminPassword: string;
  baseUrl: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "admin_session";
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

// ─── Session auth middleware (UI variant — redirects instead of 401) ──────────

function createUISessionAuthMiddleware(
  sessionSecret: string,
): MiddlewareHandler {
  return async (c, next) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (!sessionToken) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.redirect(`/admin/login?returnTo=${returnTo}`, 302);
    }
    try {
      const payload = (await verify(
        sessionToken,
        sessionSecret,
        "HS256",
      )) as Record<string, unknown>;
      if (
        typeof payload.userId !== "string" ||
        !payload.userId
      ) {
        const returnTo = encodeURIComponent(c.req.path);
        return c.redirect(`/admin/login?returnTo=${returnTo}`, 302);
      }
    } catch {
      const returnTo = encodeURIComponent(c.req.path);
      return c.redirect(`/admin/login?returnTo=${returnTo}`, 302);
    }
    return next();
  };
}

// ─── App factory ──────────────────────────────────────────────────────────────

export function createAdminUIApp(deps: AdminUIDeps): Hono {
  const {
    agentRepo,
    agentEnvService,
    slackProvisionService,
    sessionSecret,
    adminPassword,
    baseUrl,
  } = deps;

  const app = new Hono();

  // ─── Login / Logout ─────────────────────────────────────────────────────────

  app.get("/admin/login", (c) => {
    return c.html(renderLoginPage());
  });

  app.post("/admin/login", async (c) => {
    const body = await c.req.parseBody();
    const password = String(body.password ?? "");
    const returnTo = (c.req.query("returnTo") as string | undefined) ?? "/admin/agents";

    if (password !== adminPassword) {
      return c.html(renderLoginPage({ error: "Invalid password." }));
    }

    const now = Math.floor(Date.now() / 1000);
    const token = await sign(
      {
        userId: "admin",
        email: "admin@shipwright.local",
        iat: now,
        exp: now + COOKIE_MAX_AGE,
      },
      sessionSecret,
      "HS256",
    );

    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: baseUrl.startsWith("https"),
      sameSite: "Lax",
      maxAge: COOKIE_MAX_AGE,
      path: "/",
    });

    return c.redirect(returnTo, 302);
  });

  app.post("/admin/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/admin/login", 302);
  });

  // ─── Protected routes ───────────────────────────────────────────────────────

  const auth = createUISessionAuthMiddleware(sessionSecret);

  app.use("/admin/agents", auth);
  app.use("/admin/agents/*", auth);
  app.use("/admin/oauth/*", auth);

  // Agents list
  app.get("/admin/agents", async (c) => {
    const agents = await agentRepo.list();
    return c.html(renderAgentsPage(agents));
  });

  // Agent detail
  app.get("/admin/agents/:id", async (c) => {
    const id = c.req.param("id");
    const agent = await agentRepo.findById(id);
    if (!agent) {
      return c.html("<h1>Agent not found</h1>", 404);
    }
    return c.html(renderAgentDetailPage(agent));
  });

  // Patch env var (POST with form body containing key + value)
  app.post("/admin/agents/:id/envs", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.parseBody();
    const key = String(body.key ?? "").trim();
    const value = String(body.value ?? "");

    if (key) {
      await agentEnvService.patch(agentId, { [key]: value });
    }

    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // Delete env var (POST with _method=DELETE simulation or dedicated path)
  app.post("/admin/agents/:id/envs/delete", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.parseBody();
    const key = String(body.key ?? "").trim();

    if (key) {
      await agentEnvService.deleteKey(agentId, key);
    }

    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // Start Slack OAuth
  app.post("/admin/agents/:id/slack-connect", async (c) => {
    const agentId = c.req.param("id");

    if (!slackProvisionService) {
      return c.html("<h1>Slack provisioning not configured</h1>", 503);
    }

    const body = await c.req.parseBody();
    const xoxpToken = String(body.xoxpToken ?? "").trim();

    if (!xoxpToken.startsWith("xoxp-")) {
      return c.html(
        renderAgentDetailPage(
          (await agentRepo.findById(agentId)) ?? {
            id: agentId,
            name: agentId,
            slackId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            envVars: {},
            crons: [],
            tools: [],
            tokens: [],
            plugins: [],
          },
        ),
        400,
      );
    }

    const redirectUri = `${baseUrl}/admin/oauth/slack/callback?agent=${encodeURIComponent(agentId)}`;
    const oauthUrl = await slackProvisionService.startOAuth(
      agentId,
      xoxpToken,
      redirectUri,
    );

    return c.redirect(oauthUrl, 302);
  });

  // Handle Slack OAuth callback
  app.get("/admin/oauth/slack/callback", async (c) => {
    const code = c.req.query("code");
    const agentId = c.req.query("agent");

    if (!code || !agentId) {
      return c.html("<h1>Missing code or agent parameter</h1>", 400);
    }

    if (!slackProvisionService) {
      return c.html("<h1>Slack provisioning not configured</h1>", 503);
    }

    const redirectUri = `${baseUrl}/admin/oauth/slack/callback?agent=${encodeURIComponent(agentId)}`;
    await slackProvisionService.handleCallback(agentId, code, redirectUri);

    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // Store app-level token
  app.post("/admin/agents/:id/slack-app-token", async (c) => {
    const agentId = c.req.param("id");
    const body = await c.req.parseBody();
    const xappToken = String(body.xappToken ?? "").trim();

    if (xappToken) {
      await agentEnvService.patch(agentId, { SLACK_APP_TOKEN: xappToken });
    }

    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  return app;
}
