/**
 * agent/src/admin-ui.ts
 * Admin UI — server-rendered Hono app factory.
 *
 * Routes:
 *   GET  /admin/login                 — login page (Google sign-in button)
 *   GET  /admin/auth/google           — redirect to Google OAuth consent
 *   GET  /admin/auth/callback         — Google OAuth callback → set session cookie
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
  renderProvisionStartPage,
  renderProvisionXappTokenPage,
} from "./admin-ui-pages.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import { ForbiddenError, UnprocessableEntityError } from "./errors.ts";
import type { GoogleAuthClient } from "./google-auth-client.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";
import { defaultAgentManifest } from "./slack-provisioning-client.ts";

type AdminUIEnv = { Variables: { userEmail: string } };

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Narrow interface for the admin UI's Slack dependency.
 * Deliberately narrower than the full SlackProvisioningClient
 * in slack-provisioning-client.ts — only this surface is needed here.
 */
export interface AdminUISlackClient {
  createAppManifest(
    xoxpToken: string,
    manifest: AppManifest,
  ): Promise<{
    appId: string;
    oauthRedirectUrl: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
  }>;
  exchangeOAuthCode(
    code: string,
    clientId: string,
    clientSecret: string,
    redirectUri: string,
  ): Promise<{ botToken: string }>;
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
    "list" | "create" | "setEnabled" | "delete" | "get" | "reconcileSystemCrons"
  >;
  agentToolService: Pick<
    AgentToolService,
    "list" | "add" | "toggle" | "remove"
  >;
  agentTokenService: Pick<
    AgentTokenService,
    "listForAgent" | "create" | "revoke"
  >;
  agentPluginService: Pick<AgentPluginService, "list">;
  sessionSecret: string;
  googleClient: GoogleAuthClient;
  googleClientId: string;
  googleClientSecret: string;
  adminAllowedEmails: string[];
  slackClient: AdminUISlackClient;
  appBaseUrl: string;
  /** Enable the /admin/dev-login route. Hard-blocked in production regardless of this value. */
  devAuthEnabled?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "admin_session";
const OAUTH_STATE_COOKIE = "oauth_state";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours
const OAUTH_STATE_TTL_SECONDS = 600; // 10 min

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

async function getSessionEmail(
  token: string,
  secret: string,
): Promise<string | null> {
  try {
    const payload = (await verify(token, secret, "HS256")) as Record<
      string,
      unknown
    >;
    if (
      typeof payload.userId === "string" &&
      payload.userId.length > 0 &&
      typeof payload.email === "string" &&
      payload.email.length > 0
    ) {
      return payload.email;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function createUIAuthMiddleware(
  sessionSecret: string,
): MiddlewareHandler<AdminUIEnv> {
  return async (c, next) => {
    const sessionToken = getCookie(c, SESSION_COOKIE);
    const email = sessionToken
      ? await getSessionEmail(sessionToken, sessionSecret)
      : null;
    if (!email) {
      return c.redirect("/admin/login", 302);
    }
    c.set("userEmail", email);
    return next();
  };
}

// ─── App factory ──────────────────────────────────────────────────────────────

export function createAdminUIApp(deps: AdminUIDeps): Hono<AdminUIEnv> {
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
    devAuthEnabled = false,
  } = deps;

  const app = new Hono<AdminUIEnv>();

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
    const returnTo = c.req.query("returnTo") ?? undefined;
    return html(renderLoginPage({ error, returnTo }));
  });

  app.get("/admin/auth/google", (c) => {
    if (!googleClientId) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    const nonce = crypto.randomUUID();

    // Carry returnTo through the OAuth flow by encoding it alongside the nonce.
    // Validate that returnTo is a same-origin relative path (starts with /) to
    // prevent open redirect attacks. Malformed or absolute values are silently dropped.
    const rawReturnTo = c.req.query("returnTo");
    const returnTo =
      rawReturnTo?.startsWith("/") && !rawReturnTo.startsWith("//")
        ? rawReturnTo
        : undefined;

    const oauthState = JSON.stringify({ nonce, returnTo });
    setCookie(c, OAUTH_STATE_COOKIE, oauthState, {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: OAUTH_STATE_TTL_SECONDS,
      path: "/admin/auth",
    });

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: `${appBaseUrl}/admin/auth/callback`,
      response_type: "code",
      scope: "openid profile email",
      state: nonce,
      prompt: "select_account",
    });

    return c.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`, 302);
  });

  app.get("/admin/auth/callback", async (c) => {
    const { code, state, error: googleError } = c.req.query();

    // Google returned an error (e.g. access_denied)
    if (googleError) {
      const slug =
        googleError === "access_denied" ? "access_denied" : "auth_failed";
      return c.redirect(`/admin/login?error=${slug}`, 302);
    }

    // CSRF: validate state nonce. The oauth_state cookie is JSON: {nonce, returnTo?}.
    const storedStateCookie = getCookie(c, OAUTH_STATE_COOKIE);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/admin/auth" });

    let storedNonce: string | undefined;
    let returnTo: string | undefined;
    try {
      if (storedStateCookie) {
        const parsed = JSON.parse(storedStateCookie) as {
          nonce?: string;
          returnTo?: string;
        };
        storedNonce = parsed.nonce;
        returnTo = parsed.returnTo;
      }
    } catch {
      // Malformed cookie — treat as missing
    }

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
        redirectUri: `${appBaseUrl}/admin/auth/callback`,
      });
      accessToken = tokens.accessToken;
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Fetch user info from Google
    let userInfo: {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name: string;
    };
    try {
      userInfo = await googleClient.getUserInfo(accessToken);
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    if (!userInfo.email) {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    if (!userInfo.email_verified) {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Check allowlist
    if (
      !adminAllowedEmails
        .map((e) => e.toLowerCase())
        .includes(userInfo.email.toLowerCase())
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    // Create session
    const token = await createSessionToken(
      sessionSecret,
      userInfo.sub,
      userInfo.email,
    );
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: appBaseUrl.startsWith("https://"),
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
    });
    // Redirect to returnTo if it's a valid same-origin relative path, otherwise default.
    const destination =
      returnTo?.startsWith("/") && !returnTo.startsWith("//")
        ? returnTo
        : "/admin/agents";
    return c.redirect(destination, 302);
  });

  app.post("/admin/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/admin/login", 302);
  });

  // ─── Dev auto-login (non-prod only) ──────────────────────────────────────

  app.get("/admin/dev-login", async (c) => {
    // Hard-blocked: devAuthEnabled must be true AND we must not be in production.
    // The devAuthEnabled flag is pre-computed from isDevAuthAllowed() at startup;
    // this route simply trusts the injected value.
    if (!devAuthEnabled) {
      return new Response("Not Found", { status: 404 });
    }
    const token = await createSessionToken(sessionSecret, "dev", "dev@localhost");
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: appBaseUrl.startsWith("https://"),
      sameSite: "Lax",
      maxAge: SESSION_TTL_SECONDS,
      path: "/",
    });
    return c.redirect("/admin/agents", 302);
  });

  // ─── Agents list ──────────────────────────────────────────────────────────

  app.get("/admin/agents", requireAuth, async (c) => {
    const agents = await prisma.agent.findMany();
    return html(renderAgentsPage(agents, c.var.userEmail));
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
        c.var.userEmail,
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
      silent =
        formData.get("silent") === "on" || formData.get("silent") === "true";
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
          return c.redirect(
            `/admin/agents/${agentId}?error=invalid_schedule`,
            302,
          );
        }
        if (
          msg.includes("channel") ||
          msg.includes("user") ||
          msg.includes("target")
        ) {
          return c.redirect(
            `/admin/agents/${agentId}?error=invalid_target`,
            302,
          );
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
          c.var.userEmail,
          { newToken: rawToken },
        ),
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
        // ignore errors — redirect back regardless
      }
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  // ─── Provisioning flow ────────────────────────────────────────────────────

  const PROVISION_STATE_COOKIE = "slack_provision_state";
  const PROVISION_STATE_TTL_SECONDS = 300; // 5 min

  app.get("/admin/provision", requireAuth, async (c) => {
    const agents = await prisma.agent.findMany();
    return html(
      renderProvisionStartPage(
        c.var.userEmail,
        agents.map((a) => ({ id: a.id, name: a.name })),
      ),
    );
  });

  app.post("/admin/provision/start", requireAuth, async (c) => {
    // Load agents for form re-render on error
    const agents = await prisma.agent.findMany().catch(() => []);
    const agentOptions = agents.map((a) => ({ id: a.id, name: a.name }));

    const formError = (msg: string): Response =>
      html(renderProvisionStartPage(c.var.userEmail, agentOptions, { error: msg }));

    let agentId: string | undefined;
    let xoxpToken: string | undefined;
    let ghAuthMode: string | undefined;
    let ghPat: string | undefined;
    let ghAppId: string | undefined;
    let ghAppInstallationId: string | undefined;
    let ghAppPrivateKey: string | undefined;
    let anthropicApiKey: string | undefined;
    let claudeCodeOauthToken: string | undefined;

    try {
      const formData = await c.req.formData();
      agentId = formData.get("agentId")?.toString();
      xoxpToken = formData.get("xoxpToken")?.toString();
      ghAuthMode = formData.get("ghAuthMode")?.toString() ?? "pat";
      ghPat = formData.get("ghPat")?.toString();
      ghAppId = formData.get("ghAppId")?.toString();
      ghAppInstallationId = formData.get("ghAppInstallationId")?.toString();
      ghAppPrivateKey = formData.get("ghAppPrivateKey")?.toString();
      anthropicApiKey = formData.get("anthropicApiKey")?.toString();
      claudeCodeOauthToken = formData.get("claudeCodeOauthToken")?.toString();
    } catch {
      return formError("Invalid form submission.");
    }

    // ── Validate before any Slack call ────────────────────────────────────

    if (!agentId) {
      return formError("Agent is required.");
    }

    if (!xoxpToken || !xoxpToken.startsWith("xoxp-")) {
      return formError("Slack token must start with xoxp-");
    }

    if (ghAuthMode === "pat") {
      if (!ghPat) {
        return formError("GitHub Personal Access Token is required.");
      }
    } else if (ghAuthMode === "app") {
      if (!ghAppId || !/^\d+$/.test(ghAppId)) {
        return formError("GitHub App ID must be a numeric value.");
      }
      if (!ghAppInstallationId || !/^\d+$/.test(ghAppInstallationId)) {
        return formError("GitHub App Installation ID must be a numeric value.");
      }
      if (
        !ghAppPrivateKey ||
        !ghAppPrivateKey.includes("BEGIN") ||
        !ghAppPrivateKey.includes("PRIVATE KEY")
      ) {
        return formError(
          "GitHub App Private Key must be a valid PEM-encoded key.",
        );
      }
    } else {
      return formError("Invalid GitHub auth mode.");
    }

    // ── Fetch agent name for manifest ─────────────────────────────────────

    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return formError("Agent not found.");
    }

    // ── Call Slack — first external action ────────────────────────────────

    let slackResult: {
      appId: string;
      oauthRedirectUrl: string;
      clientId: string;
      clientSecret: string;
      signingSecret: string;
    };
    try {
      const redirectUri = `${appBaseUrl}/admin/provision/complete`;
      const manifest = defaultAgentManifest(agent.name, redirectUri);
      slackResult = await slackClient.createAppManifest(xoxpToken, manifest);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "Unknown error creating Slack app.";
      return formError(msg);
    }

    const { appId, oauthRedirectUrl, clientId, clientSecret, signingSecret } =
      slackResult;

    // ── Sign provision-state cookie ───────────────────────────────────────

    const now = Math.floor(Date.now() / 1000);
    const provisionToken = await sign(
      {
        agentId,
        clientId,
        clientSecret,
        signingSecret,
        appId,
        iat: now,
        exp: now + PROVISION_STATE_TTL_SECONDS,
      },
      sessionSecret,
      "HS256",
    );

    // TODO(BP-2.2): this cookie is consumed by the OAuth exchange handler in
    // provision/complete once the Slack OAuth redirect lands.
    setCookie(c, PROVISION_STATE_COOKIE, provisionToken, {
      httpOnly: true,
      maxAge: PROVISION_STATE_TTL_SECONDS,
      sameSite: "Lax",
      path: "/",
      secure: appBaseUrl.startsWith("https://"),
    });

    // ── Write agent env ───────────────────────────────────────────────────

    const existing = (await agentEnvService.getByAgentId(agentId)) ?? {};
    const newEnv: Record<string, string> = {
      ...existing,
      SLACK_APP_ID: appId,
      SLACK_SIGNING_SECRET: signingSecret,
    };

    if (ghAuthMode === "pat") {
      newEnv.GH_TOKEN = ghPat ?? "";
    } else {
      newEnv.GH_APP_ID = ghAppId ?? "";
      newEnv.GH_APP_INSTALLATION_ID = ghAppInstallationId ?? "";
      newEnv.GH_APP_PRIVATE_KEY = ghAppPrivateKey ?? "";
    }

    if (anthropicApiKey) {
      newEnv.ANTHROPIC_API_KEY = anthropicApiKey;
    }
    if (claudeCodeOauthToken) {
      newEnv.CLAUDE_CODE_OAUTH_TOKEN = claudeCodeOauthToken;
    }

    await agentEnvService.upsert(agentId, newEnv);

    // Use c.html() so the Set-Cookie header from setCookie() is included
    return c.html(
      renderProvisionStartPage(c.var.userEmail, agentOptions, {
        oauthUrl: oauthRedirectUrl,
      }),
    );
  });

  // GET — OAuth callback → exchange code, store SLACK_BOT_TOKEN, show xapp-token page
  app.get("/admin/provision/complete", requireAuth, async (c) => {
    const userEmail = c.var.userEmail;

    // Read and validate the provision state cookie
    const rawStateCookie = getCookie(c, PROVISION_STATE_COOKIE);
    if (!rawStateCookie) {
      deleteCookie(c, PROVISION_STATE_COOKIE);
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          error:
            "Provision session expired or missing. Please start the provisioning flow again.",
        }),
      );
    }

    let provisionState: {
      agentId: string;
      clientId: string;
      clientSecret: string;
      signingSecret: string;
      appId: string;
    };
    try {
      const payload = (await verify(
        rawStateCookie,
        sessionSecret,
        "HS256",
      )) as Record<string, unknown>;
      if (
        typeof payload.agentId !== "string" ||
        typeof payload.clientId !== "string" ||
        typeof payload.clientSecret !== "string" ||
        typeof payload.signingSecret !== "string" ||
        typeof payload.appId !== "string"
      ) {
        throw new Error("invalid payload shape");
      }
      provisionState = {
        agentId: payload.agentId,
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        signingSecret: payload.signingSecret,
        appId: payload.appId,
      };
    } catch {
      deleteCookie(c, PROVISION_STATE_COOKIE);
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          error:
            "Provision session expired or invalid. Please start the provisioning flow again.",
        }),
      );
    }

    deleteCookie(c, PROVISION_STATE_COOKIE);

    // Read the OAuth code param
    const code = c.req.query("code");
    if (!code) {
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          error:
            "OAuth code not found in callback URL. Please try authorizing again.",
        }),
      );
    }

    // Exchange the OAuth code for a bot token
    let botToken: string;
    try {
      const result = await slackClient.exchangeOAuthCode(
        code,
        provisionState.clientId,
        provisionState.clientSecret,
        `${appBaseUrl}/admin/provision/complete`,
      );
      botToken = result.botToken;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown error exchanging OAuth code.";
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          error: `OAuth exchange failed: ${msg}`,
        }),
      );
    }

    // Store SLACK_BOT_TOKEN in agent env
    const existing = (await agentEnvService.getByAgentId(provisionState.agentId)) ?? {};
    await agentEnvService.upsert(provisionState.agentId, {
      ...existing,
      SLACK_BOT_TOKEN: botToken,
    });

    // Render xapp-token page
    return html(
      renderProvisionXappTokenPage(userEmail, {
        agentId: provisionState.agentId,
      }),
    );
  });

  // POST /admin/provision/complete — removed; returns 404
  app.post("/admin/provision/complete", (c) => {
    return new Response("Not Found", { status: 404 });
  });

  // POST /admin/provision/xapp-token — save xapp token, create scoped token, seed crons
  app.post("/admin/provision/xapp-token", requireAuth, async (c) => {
    const userEmail = c.var.userEmail;

    let agentId: string | undefined;
    let xappToken: string | undefined;
    try {
      const formData = await c.req.formData();
      agentId = formData.get("agentId")?.toString();
      xappToken = formData.get("xappToken")?.toString();
    } catch {
      return html(
        renderProvisionXappTokenPage(userEmail, {
          agentId: agentId ?? "",
          error: "Invalid form submission.",
        }),
      );
    }

    if (!agentId) {
      return html(
        renderProvisionXappTokenPage(userEmail, {
          agentId: "",
          error: "Agent ID is required.",
        }),
      );
    }

    if (!xappToken || !xappToken.startsWith("xapp-")) {
      return html(
        renderProvisionXappTokenPage(userEmail, {
          agentId,
          error: "App-Level Token must start with xapp-",
        }),
      );
    }

    try {
      // Store SLACK_APP_TOKEN
      const existing = (await agentEnvService.getByAgentId(agentId)) ?? {};
      await agentEnvService.upsert(agentId, {
        ...existing,
        SLACK_APP_TOKEN: xappToken,
      });

      // Create scoped token for internal API access
      const { rawToken } = await agentTokenService.create(agentId, "provision");

      // Store SHIPWRIGHT_INTERNAL_API_KEY
      const existing2 = (await agentEnvService.getByAgentId(agentId)) ?? {};
      await agentEnvService.upsert(agentId, {
        ...existing2,
        SHIPWRIGHT_INTERNAL_API_KEY: rawToken,
      });

      // Seed system crons
      await agentCronJobService.reconcileSystemCrons(agentId);

      return html(
        renderProvisionCompletePage(userEmail, {
          success: true,
          agentId,
          rawToken,
        }),
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown error completing provisioning.";
      return html(
        renderProvisionXappTokenPage(userEmail, {
          agentId,
          error: msg,
        }),
      );
    }
  });

  return app;
}
