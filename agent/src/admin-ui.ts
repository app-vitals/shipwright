/**
 * agent/src/admin-ui.ts
 * Admin UI — server-rendered Hono app factory.
 *
 * Routes:
 *   GET  /admin/login                 — login form
 *   POST /admin/login                 — submit password → set session cookie → redirect
 *   POST /admin/logout                — clear cookie → redirect to login
 *   GET  /admin/agents                — list all agents (auth required)
 *   GET  /admin/agents/:id            — agent detail (auth required)
 *   POST /admin/agents/:id/envs       — add/update env var (auth required)
 *   POST /admin/agents/:id/envs/delete — delete env var (auth required)
 *   GET  /admin/provision             — provision start page (auth required)
 *   POST /admin/provision/start       — submit xoxp- token → create Slack app
 *   GET  /admin/provision/complete    — OAuth callback → store credentials
 *
 * Auth: httpOnly JWT cookie named "admin_session".
 * Login is password-only (adminPassword from deps) — no DB user lookup.
 */

import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import {
  renderAgentDetailPage,
  renderAgentsPage,
  renderLoginPage,
  renderProvisionCompletePage,
  renderProvisionPasteForm,
  renderProvisionStartPage,
} from "./admin-ui-pages.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";
import { defaultAgentManifest } from "./slack-provisioning-client.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Narrow interface for the admin UI's Slack dependency.
 * Only `createAppManifest` is needed — signing secret comes from the paste form,
 * not from an OAuth exchange. Deliberately narrower than the full SlackProvisioningClient
 * in slack-provisioning-client.ts — only this surface is needed here.
 */
export interface AdminUISlackClient {
  createAppManifest(
    xoxpToken: string,
    manifest: AppManifest,
  ): Promise<{ appId: string; oauthRedirectUrl: string }>;
}

interface PrismaAgentLike {
  findMany(args?: object): Promise<
    Array<{
      id: string;
      name: string;
      slackId: string | null;
      createdAt: Date;
      updatedAt?: Date;
    }>
  >;
  findUnique(args: { where: { id: string } }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  create(args: {
    data: { name: string; slackId?: string | null };
  }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;
}

interface PrismaLike {
  agent: PrismaAgentLike;
  agentPlugin: {
    findMany(args: {
      where: { agentId: string; enabled: boolean };
    }): Promise<
      Array<{
        id: string;
        name: string;
        version: string | null;
        enabled: boolean;
      }>
    >;
  };
}

export interface AdminUIDeps {
  prisma: PrismaLike;
  agentEnvService: Pick<
    AgentEnvService,
    "getByAgentId" | "upsert" | "deleteKey" | "getConfigBundle"
  >;
  agentCronJobService: Pick<
    AgentCronJobService,
    "list" | "create" | "delete" | "setEnabled"
  >;
  agentToolService: Pick<
    AgentToolService,
    "list" | "add" | "remove" | "toggle"
  >;
  agentTokenService: Pick<
    AgentTokenService,
    "listForAgent" | "create" | "revoke"
  >;
  agentPluginService: Pick<AgentPluginService, "list">;
  sessionSecret: string;
  adminPassword: string;
  slackClient: AdminUISlackClient;
  appBaseUrl: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours
const ADMIN_USER_NAME = "admin";

// ─── Timing-safe comparison ───────────────────────────────────────────────────

/**
 * Constant-time string comparison to prevent timing attacks on the admin password.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) {
    // Still iterate to avoid length-based timing leak
    let diff = ab.length ^ bb.length;
    for (let i = 0; i < Math.max(ab.length, bb.length); i++) {
      diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
    }
    return diff === 0;
  }
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function createSessionToken(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      userId: "admin",
      email: "admin",
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    },
    secret,
    "HS256",
  );
}

async function verifySessionToken(
  token: string,
  secret: string,
): Promise<boolean> {
  try {
    const payload = (await verify(token, secret, "HS256")) as Record<
      string,
      unknown
    >;
    return (
      typeof payload.userId === "string" &&
      payload.userId === "admin" &&
      typeof payload.email === "string"
    );
  } catch {
    return false;
  }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function createUIAuthMiddleware(sessionSecret: string): MiddlewareHandler {
  return async (c, next) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (
      !sessionToken ||
      !(await verifySessionToken(sessionToken, sessionSecret))
    ) {
      return c.redirect("/admin/login", 302);
    }
    return next();
  };
}

// ─── App factory ──────────────────────────────────────────────────────────────

export function createAdminUIApp(deps: AdminUIDeps): Hono {
  const {
    prisma,
    agentEnvService,
    agentCronJobService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    sessionSecret,
    adminPassword,
    slackClient,
    appBaseUrl,
  } = deps;

  const app = new Hono();

  const requireAuth = createUIAuthMiddleware(sessionSecret);

  // ─── HTML helper ──────────────────────────────────────────────────────────

  function html(content: string): Response {
    return new Response(content, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // ─── Login / Logout ───────────────────────────────────────────────────────

  app.get("/admin/login", (c) => {
    return html(renderLoginPage());
  });

  app.post("/admin/login", async (c) => {
    let password: string | undefined;
    try {
      const formData = await c.req.formData();
      password = formData.get("password")?.toString();
    } catch {
      return html(renderLoginPage({ error: "Invalid form submission." }));
    }

    if (!password || !timingSafeEqual(password, adminPassword)) {
      return new Response(renderLoginPage({ error: "Invalid password." }), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const token = await createSessionToken(sessionSecret);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: appBaseUrl.startsWith("https://"),
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
    });
    return c.redirect("/admin/agents", 302);
  });

  app.post("/admin/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/admin/login", 302);
  });

  // ─── Agents list ──────────────────────────────────────────────────────────

  app.get("/admin/agents", requireAuth, async (c) => {
    const agents = await prisma.agent.findMany();
    return html(renderAgentsPage(agents, ADMIN_USER_NAME));
  });

  // ─── Agent detail ─────────────────────────────────────────────────────────

  const ERROR_MESSAGES: Record<string, string> = {
    missing_fields: "Required fields are missing.",
    create_failed: "Failed to create — please try again.",
    invalid_schedule: "Invalid cron schedule expression.",
    invalid_target:
      "Invalid delivery target — set channel or user (or enable silent mode).",
  };

  app.get("/admin/agents/:id", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }

    const rawError = c.req.query("error") ?? undefined;
    const error = rawError ? (ERROR_MESSAGES[rawError] ?? rawError) : undefined;
    const newToken = c.req.query("newToken") ?? undefined;

    const [envVars, crons, tools, tokens, plugins] = await Promise.all([
      agentEnvService.getByAgentId(agentId).then((e) => e ?? {}),
      agentCronJobService.list(agentId),
      agentToolService.list(agentId),
      agentTokenService.listForAgent(agentId),
      agentPluginService.list(agentId),
    ]);

    return html(
      renderAgentDetailPage(
        agent,
        envVars,
        crons,
        tools,
        tokens,
        plugins,
        ADMIN_USER_NAME,
        { error, newToken },
      ),
    );
  });

  // ─── Env var mutations ────────────────────────────────────────────────────

  app.post("/admin/agents/:id/envs", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    let key: string | undefined;
    let value: string | undefined;
    try {
      const formData = await c.req.formData();
      key = formData.get("key")?.toString();
      value = formData.get("value")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (key && value !== undefined) {
      const existing = (await agentEnvService.getByAgentId(agentId)) ?? {};
      await agentEnvService.upsert(agentId, { ...existing, [key]: value });
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/envs/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    let key: string | undefined;
    try {
      const formData = await c.req.formData();
      key = formData.get("key")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (key) {
      await agentEnvService.deleteKey(agentId, key);
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Cron job mutations ───────────────────────────────────────────────────

  app.post("/admin/agents/:id/crons", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    let schedule: string | undefined;
    let prompt: string | undefined;
    let channel: string | undefined;
    let user: string | undefined;
    let silent: boolean;
    let preCheck: string | undefined;
    let enabled: boolean;
    try {
      const formData = await c.req.formData();
      schedule = formData.get("schedule")?.toString();
      prompt = formData.get("prompt")?.toString();
      channel = formData.get("channel")?.toString() || undefined;
      user = formData.get("user")?.toString() || undefined;
      silent = formData.get("silent")?.toString() === "true";
      preCheck = formData.get("preCheck")?.toString() || undefined;
      const rawEnabled = formData.get("enabled")?.toString();
      enabled = rawEnabled !== undefined ? rawEnabled === "true" : true;
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }

    if (!schedule || !prompt) {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }

    try {
      await agentCronJobService.create(agentId, {
        schedule,
        prompt,
        channel: channel ?? null,
        user: user ?? null,
        silent,
        preCheck: preCheck ?? null,
        enabled,
      });
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=create_failed`, 302);
    }

    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/crons/:cronId/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    try {
      await agentCronJobService.delete(agentId, cronId);
    } catch {
      // swallow — redirect regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/crons/:cronId/toggle", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    let enabled = true;
    try {
      const formData = await c.req.formData();
      const raw = formData.get("enabled")?.toString();
      enabled = raw !== "false";
    } catch {
      // default to enabled=true on parse failure
    }
    try {
      await agentCronJobService.setEnabled(agentId, cronId, enabled);
    } catch {
      // swallow — redirect regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Tool mutations ───────────────────────────────────────────────────────

  app.post("/admin/agents/:id/tools", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    let pattern: string | undefined;
    try {
      const formData = await c.req.formData();
      pattern = formData.get("pattern")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }
    if (!pattern) {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }
    try {
      await agentToolService.add(agentId, pattern);
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=create_failed`, 302);
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/tools/:toolId/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    try {
      await agentToolService.remove(agentId, toolId);
    } catch {
      // swallow — redirect regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/tools/:toolId/toggle", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    let enabled = true;
    try {
      const formData = await c.req.formData();
      const raw = formData.get("enabled")?.toString();
      enabled = raw !== "false";
    } catch {
      // default to enabled=true on parse failure
    }
    try {
      await agentToolService.toggle(agentId, toolId, enabled);
    } catch {
      // swallow — redirect regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Token mutations ──────────────────────────────────────────────────────

  app.post("/admin/agents/:id/tokens", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    let label: string | undefined;
    try {
      const formData = await c.req.formData();
      label = formData.get("label")?.toString() || undefined;
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=create_failed`, 302);
    }
    try {
      const { rawToken } = await agentTokenService.create(agentId, label);
      return c.redirect(
        `/admin/agents/${agentId}?newToken=${encodeURIComponent(rawToken)}`,
        302,
      );
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=create_failed`, 302);
    }
  });

  app.post(
    "/admin/agents/:id/tokens/:tokenId/revoke",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      const tokenId = c.req.param("tokenId");
      try {
        await agentTokenService.revoke(tokenId);
      } catch {
        // swallow — redirect regardless
      }
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  // ─── Provisioning flow ────────────────────────────────────────────────────

  app.get("/admin/provision", requireAuth, (c) => {
    return html(renderProvisionStartPage(ADMIN_USER_NAME));
  });

  app.post("/admin/provision/start", requireAuth, async (c) => {
    let xoxpToken: string | undefined;
    try {
      const formData = await c.req.formData();
      xoxpToken = formData.get("xoxpToken")?.toString();
    } catch {
      return html(
        renderProvisionStartPage(ADMIN_USER_NAME, {
          error: "Invalid form submission.",
        }),
      );
    }

    if (!xoxpToken || !xoxpToken.startsWith("xoxp-")) {
      return html(
        renderProvisionStartPage(ADMIN_USER_NAME, {
          error: "Token must start with xoxp-",
        }),
      );
    }

    try {
      const redirectUri = `${appBaseUrl}/admin/provision/complete`;
      const manifest = defaultAgentManifest("Shipwright Agent", redirectUri);
      const { oauthRedirectUrl } = await slackClient.createAppManifest(
        xoxpToken,
        manifest,
      );
      return html(
        renderProvisionStartPage(ADMIN_USER_NAME, {
          oauthUrl: oauthRedirectUrl,
        }),
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Unknown error creating Slack app.";
      return html(renderProvisionStartPage(ADMIN_USER_NAME, { error: msg }));
    }
  });

  // GET — OAuth callback → show paste form for credentials
  app.get("/admin/provision/complete", requireAuth, (c) => {
    const agentId = c.req.query("agentId");
    return html(renderProvisionPasteForm(ADMIN_USER_NAME, { agentId }));
  });

  // POST — receive pasted credentials → store in AgentEnv
  app.post("/admin/provision/complete", requireAuth, async (c) => {
    let agentId: string | undefined;
    let appId: string | undefined;
    let signingSecret: string | undefined;
    try {
      const formData = await c.req.formData();
      agentId = formData.get("agentId")?.toString();
      appId = formData.get("appId")?.toString();
      signingSecret = formData.get("signingSecret")?.toString();
    } catch {
      return html(
        renderProvisionCompletePage(ADMIN_USER_NAME, {
          success: false,
          error: "Invalid form submission.",
        }),
      );
    }

    if (!agentId || !appId || !signingSecret) {
      return html(
        renderProvisionPasteForm(ADMIN_USER_NAME, {
          agentId,
          error: "Agent ID, App ID, and Signing Secret are all required.",
        }),
      );
    }

    try {
      const existing = (await agentEnvService.getByAgentId(agentId)) ?? {};
      await agentEnvService.upsert(agentId, {
        ...existing,
        SLACK_APP_ID: appId,
        SLACK_SIGNING_SECRET: signingSecret,
      });
      return html(
        renderProvisionCompletePage(ADMIN_USER_NAME, {
          success: true,
          agentId,
        }),
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Unknown error storing credentials.";
      return html(
        renderProvisionPasteForm(ADMIN_USER_NAME, { agentId, error: msg }),
      );
    }
  });

  return app;
}
