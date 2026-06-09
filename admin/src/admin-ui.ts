/**
 * agent/src/admin-ui.ts
 * Admin UI — server-rendered Hono app factory.
 *
 * Routes:
 *   GET  /admin/login                 — login page (Google sign-in button)
 *   GET  /auth/google                 — redirect to Google OAuth consent
 *   GET  /auth/callback               — Google OAuth callback → set session cookie
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
 * Login is Google OAuth — no password, no DB user lookup.
 * Allowed users are controlled by the adminAllowedEmails allowlist in deps.
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
import { ForbiddenError, UnprocessableEntityError } from "./errors.ts";
import type { GoogleAuthClient } from "./google-auth-client.ts";
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
    "list" | "create" | "setEnabled" | "delete" | "get"
  >;
  agentToolService: Pick<AgentToolService, "list" | "add" | "toggle" | "remove">;
  agentTokenService: Pick<AgentTokenService, "listForAgent" | "create" | "revoke">;
  agentPluginService: Pick<AgentPluginService, "list">;
  sessionSecret: string;
  googleClient: GoogleAuthClient;
  googleClientId: string;
  googleClientSecret: string;
  adminAllowedEmails: string[];
  slackClient: AdminUISlackClient;
  appBaseUrl: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "admin_session";
const OAUTH_STATE_COOKIE = "oauth_state";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours
const OAUTH_STATE_TTL_SECONDS = 600; // 10 min
const ADMIN_USER_NAME = "admin";

// ─── Auth helpers ─────────────────────────────────────────────────────────────

async function createSessionToken(
  secret: string,
  userId: string,
  email: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      userId,
      email,
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
      payload.userId.length > 0 &&
      typeof payload.email === "string" &&
      payload.email.length > 0
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
    googleClient,
    googleClientId,
    googleClientSecret,
    adminAllowedEmails,
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

  // ─── Login / OAuth / Logout ───────────────────────────────────────────────

  app.get("/admin/login", (c) => {
    const error = c.req.query("error") ?? undefined;
    return html(renderLoginPage({ error }));
  });

  app.get("/auth/google", (c) => {
    if (!googleClientId) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    const nonce = crypto.randomUUID();
    setCookie(c, OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: OAUTH_STATE_TTL_SECONDS,
      path: "/auth",
    });

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: `${appBaseUrl}/auth/callback`,
      response_type: "code",
      scope: "openid profile email",
      state: nonce,
      prompt: "select_account",
    });

    return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
  });

  app.get("/auth/callback", async (c) => {
    const { code, state, error: googleError } = c.req.query();

    // Google returned an error (e.g. access_denied)
    if (googleError) {
      const slug = googleError === "access_denied" ? "access_denied" : "auth_failed";
      return c.redirect(`/admin/login?error=${slug}`, 302);
    }

    // CSRF: validate state nonce
    const storedNonce = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/auth" });

    if (!storedNonce || !state || storedNonce !== state) {
      return c.redirect("/admin/login?error=invalid_state", 302);
    }

    if (!googleClientId || !googleClientSecret) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    if (!code) {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Exchange authorization code for tokens
    let accessToken: string;
    try {
      const tokens = await googleClient.exchangeCode({
        code,
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        redirectUri: `${appBaseUrl}/auth/callback`,
      });
      accessToken = tokens.accessToken;
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Fetch user info from Google
    let userInfo: { sub: string; email?: string; name: string };
    try {
      userInfo = await googleClient.getUserInfo(accessToken);
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    if (!userInfo.email) {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Check allowlist
    if (!adminAllowedEmails.includes(userInfo.email)) {
      return new Response("Forbidden", { status: 403 });
    }

    // Create session
    const token = await createSessionToken(sessionSecret, userInfo.sub, userInfo.email);
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
    const error = rawError
      ? (ERROR_MESSAGES[rawError] ?? rawError)
      : undefined;
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
    let channel: string | null = null;
    let user: string | null = null;
    let silent = false;
    let enabled = true;
    let name: string | null = null;
    try {
      const formData = await c.req.formData();
      schedule = formData.get("schedule")?.toString();
      prompt = formData.get("prompt")?.toString();
      channel = formData.get("channel")?.toString() || null;
      user = formData.get("user")?.toString() || null;
      silent = formData.get("silent") === "on" || formData.get("silent") === "true";
      const enabledVal = formData.get("enabled");
      // Checkbox: present as "on" when checked, absent (null) when unchecked.
      // Programmatic callers may send "true"/"false" explicitly.
      enabled = enabledVal === "on" || enabledVal === "true";
      name = formData.get("name")?.toString() || null;
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (!schedule || !prompt) {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }
    try {
      await agentCronJobService.create(agentId, {
        schedule,
        prompt,
        channel,
        user,
        silent,
        enabled,
        name,
      });
    } catch (err) {
      if (err instanceof UnprocessableEntityError) {
        const msg = err.message.toLowerCase();
        if (msg.includes("invalid cron")) {
          return c.redirect(`/admin/agents/${agentId}?error=invalid_schedule`, 302);
        }
        if (msg.includes("channel") || msg.includes("user") || msg.includes("target")) {
          return c.redirect(`/admin/agents/${agentId}?error=invalid_target`, 302);
        }
      }
      return c.redirect(`/admin/agents/${agentId}?error=create_failed`, 302);
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/crons/:cronId/toggle", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    let enabled = true;
    try {
      const formData = await c.req.formData();
      enabled = formData.get("enabled") !== "false";
    } catch {
      // use default
    }
    try {
      await agentCronJobService.setEnabled(agentId, cronId, enabled);
    } catch {
      // ignore errors — redirect back regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/crons/:cronId/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    try {
      const cron = await agentCronJobService.get(agentId, cronId);
      if (cron.system) {
        throw new ForbiddenError("system crons cannot be deleted");
      }
      await agentCronJobService.delete(agentId, cronId);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        return c.redirect(
          `/admin/agents/${agentId}?error=${encodeURIComponent(err.message)}`,
          302,
        );
      }
      // other errors (NotFoundError, etc.) — redirect back silently
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
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (!pattern) {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }
    try {
      await agentToolService.add(agentId, pattern);
    } catch {
      // ignore errors — redirect back regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/tools/:toolId/toggle", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    let enabled = true;
    try {
      const formData = await c.req.formData();
      enabled = formData.get("enabled") !== "false";
    } catch {
      // use default
    }
    try {
      await agentToolService.toggle(agentId, toolId, enabled);
    } catch {
      // ignore errors — redirect back regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/tools/:toolId/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const toolId = c.req.param("toolId");
    try {
      await agentToolService.remove(agentId, toolId);
    } catch {
      // ignore errors — redirect back regardless
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
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }
    try {
      const { rawToken } = await agentTokenService.create(agentId, label);
      // Render the page directly (200) rather than redirecting with the token in the URL.
      // A redirect would expose the raw token in server access logs and browser history.
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
          { newToken: rawToken },
        ),
      );
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=create_failed`, 302);
    }
  });

  app.post("/admin/agents/:id/tokens/:tokenId/revoke", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const tokenId = c.req.param("tokenId");
    try {
      await agentTokenService.revoke(tokenId);
    } catch {
      // ignore errors — redirect back regardless
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

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
