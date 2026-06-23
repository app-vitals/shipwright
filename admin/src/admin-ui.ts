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
  type TaskItem,
  renderAgentDetailPage,
  renderAgentsPage,
  renderLoginPage,
  renderProvisionCompletePage,
  renderProvisionStartPage,
  renderProvisionXappTokenPage,
  renderTasksPage,
} from "./admin-ui-pages.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import { ForbiddenError, UnprocessableEntityError } from "./errors.ts";
import type { GoogleAuthClient } from "./google-auth-client.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";
import {
  AGENT_BOT_SCOPES,
  buildAgentManifest,
} from "./slack-provisioning-client.ts";

type AdminUIEnv = { Variables: { userEmail: string; isAdmin: boolean } };

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
  updateAppManifest(
    xoxpToken: string,
    appId: string,
    manifest: AppManifest,
  ): Promise<void>;
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
  delete(args: { where: { id: string } }): Promise<{
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
  agentMember: {
    findMany(args: {
      where: { email?: string; agentId?: string };
    }): Promise<
      Array<{ id: string; agentId: string; email: string; createdAt: Date }>
    >;
    findUnique(args: {
      where: { agentId_email: { agentId: string; email: string } };
    }): Promise<{ id: string; agentId: string; email: string } | null>;
    create(args: {
      data: { agentId: string; email: string };
    }): Promise<{ id: string; agentId: string; email: string }>;
    deleteMany(args: { where: { id: string; agentId: string } }): Promise<{
      count: number;
    }>;
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
    | "list"
    | "create"
    | "update"
    | "setEnabled"
    | "delete"
    | "get"
    | "reconcileSystemCrons"
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
  provisioner: AgentProvisioner;
  sessionSecret: string;
  googleClient: GoogleAuthClient;
  googleClientId: string;
  googleClientSecret: string;
  adminAllowedEmails: string[];
  slackClient: AdminUISlackClient;
  appBaseUrl: string;
  /** Enable the /admin/dev-login route. Hard-blocked in production regardless of this value. */
  devAuthEnabled?: boolean;
  /**
   * Fetch tasks from the task-store service. If absent, the tasks page renders
   * in degraded mode (empty table + yellow notice) rather than returning 500.
   */
  fetchTaskStoreTasks?: (params: URLSearchParams) => Promise<TaskItem[]>;
  /**
   * Release a task (unclaim → pending) via the task-store service.
   */
  releaseTask?: (id: string) => Promise<void>;
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
  isAdmin: boolean,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      userId,
      email,
      isAdmin,
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    },
    secret,
    "HS256",
  );
}

async function getSessionUser(
  token: string,
  secret: string,
): Promise<{ email: string; isAdmin: boolean } | null> {
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
      return { email: payload.email, isAdmin: payload.isAdmin !== false };
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
    const user = sessionToken
      ? await getSessionUser(sessionToken, sessionSecret)
      : null;
    if (!user) {
      return c.redirect("/admin/login", 302);
    }
    c.set("userEmail", user.email);
    c.set("isAdmin", user.isAdmin);
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
    provisioner,
    sessionSecret,
    googleClient,
    googleClientId,
    googleClientSecret,
    adminAllowedEmails,
    slackClient,
    appBaseUrl,
    devAuthEnabled = false,
    fetchTaskStoreTasks,
    releaseTask,
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

    // Check admin allowlist first, then fall back to member access
    const isAdmin = adminAllowedEmails
      .map((e) => e.toLowerCase())
      .includes(userInfo.email.toLowerCase());

    if (!isAdmin) {
      const memberships = await prisma.agentMember.findMany({
        where: { email: userInfo.email.toLowerCase() },
      });
      if (memberships.length === 0) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    // Create session
    const token = await createSessionToken(
      sessionSecret,
      userInfo.sub,
      userInfo.email,
      isAdmin,
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
    const token = await createSessionToken(
      sessionSecret,
      "dev",
      "dev@localhost",
      true,
    );
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
    let agents: Awaited<ReturnType<typeof prisma.agent.findMany>>;
    if (c.var.isAdmin) {
      agents = await prisma.agent.findMany();
    } else {
      const memberships = await prisma.agentMember.findMany({
        where: { email: c.var.userEmail.toLowerCase() },
      });
      const agentIds = memberships.map((m) => m.agentId);
      agents = await prisma.agent.findMany({ where: { id: { in: agentIds } } });
    }
    return html(renderAgentsPage(agents, c.var.userEmail, c.var.isAdmin));
  });

  // ─── Agent detail ─────────────────────────────────────────────────────────

  async function assertAgentAccess(
    agentId: string,
    userEmail: string,
    isAdmin: boolean,
  ): Promise<boolean> {
    if (isAdmin) return true;
    const membership = await prisma.agentMember.findUnique({
      where: { agentId_email: { agentId, email: userEmail.toLowerCase() } },
    });
    return membership !== null;
  }

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

    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }

    const rawError = c.req.query("error") ?? undefined;
    const error = rawError ? (ERROR_MESSAGES[rawError] ?? rawError) : undefined;
    const newToken = c.req.query("newToken") ?? undefined;
    const successParam = c.req.query("success");
    const successMsg =
      successParam === "manifest_synced"
        ? "Manifest synced successfully."
        : successParam === "reinstalled"
          ? "Slack app reinstalled successfully."
          : undefined;

    const [envVars, crons, tools, tokens, plugins, members] = await Promise.all(
      [
        agentEnvService.getByAgentId(agentId).then((e) => e ?? {}),
        agentCronJobService.list(agentId),
        agentToolService.list(agentId),
        agentTokenService.listForAgent(agentId),
        agentPluginService.list(agentId),
        c.var.isAdmin
          ? prisma.agentMember.findMany({ where: { agentId } })
          : Promise.resolve([]),
      ],
    );

    return html(
      renderAgentDetailPage(
        agent,
        envVars,
        crons,
        tools,
        tokens,
        plugins,
        members,
        c.var.userEmail,
        c.var.isAdmin,
        { error, newToken, successMsg },
      ),
    );
  });

  // ─── Env var mutations ────────────────────────────────────────────────────

  app.post("/admin/agents/:id/envs", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
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
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
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
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
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
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
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

  app.post("/admin/agents/:id/crons/:cronId/update", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let schedule = "";
    let prompt = "";
    let channel: string | null = null;
    let preCheck: string | null = null;
    try {
      const formData = await c.req.formData();
      schedule = ((formData.get("schedule") as string | null) ?? "").trim();
      prompt = ((formData.get("prompt") as string | null) ?? "").trim();
      const ch = ((formData.get("channel") as string | null) ?? "").trim();
      channel = ch === "" ? null : ch;
      const pc = ((formData.get("preCheck") as string | null) ?? "").trim();
      preCheck = pc === "" ? null : pc; // empty clears the preCheck
    } catch {
      // fall through to validation
    }
    if (!schedule || !prompt) {
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent("schedule and prompt are required")}`,
        302,
      );
    }
    try {
      // Fetch the existing cron so we (a) block edits to system crons — their
      // contents are owned by reconcileSystemCrons and would be reverted — and
      // (b) forward `user`/`silent`. Without them the service resolves user→null,
      // silent→false and validateDeliveryTarget throws for any DM-routed cron.
      const existing = await agentCronJobService.get(agentId, cronId);
      if (existing.system) {
        return c.redirect(
          `/admin/agents/${agentId}?error=${encodeURIComponent("system crons cannot be edited")}`,
          302,
        );
      }
      await agentCronJobService.update(agentId, cronId, {
        schedule,
        prompt,
        channel,
        preCheck,
        user: existing.user,
        silent: existing.silent,
      });
    } catch (err) {
      // Surface validation errors (e.g. invalid cron expression) back to the page.
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent(
          err instanceof Error ? err.message : "cron update failed",
        )}`,
        302,
      );
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/crons/:cronId/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
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
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
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
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
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
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
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
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
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
      const [envVars, crons, tools, tokens, plugins, members] =
        await Promise.all([
          agentEnvService.getByAgentId(agentId).then((e) => e ?? {}),
          agentCronJobService.list(agentId),
          agentToolService.list(agentId),
          agentTokenService.listForAgent(agentId),
          agentPluginService.list(agentId),
          c.var.isAdmin
            ? prisma.agentMember.findMany({ where: { agentId } })
            : Promise.resolve([]),
        ]);
      return html(
        renderAgentDetailPage(
          agent,
          envVars,
          crons,
          tools,
          tokens,
          plugins,
          members,
          c.var.userEmail,
          c.var.isAdmin,
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
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        await agentTokenService.revoke(tokenId);
      } catch {
        // ignore errors — redirect back regardless
      }
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  // ─── Provisioning state constants ────────────────────────────────────────

  const PROVISION_STATE_COOKIE = "slack_provision_state";
  const PROVISION_STATE_TTL_SECONDS = 300; // 5 min

  // ─── Manifest sync ────────────────────────────────────────────────────────

  app.post("/admin/agents/:id/sync-manifest", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return new Response("Agent not found", { status: 404 });

    let xoxpToken: string | undefined;
    try {
      const formData = await c.req.formData();
      xoxpToken = formData.get("xoxpToken")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }

    if (!xoxpToken || !xoxpToken.startsWith("xoxe.xoxp-")) {
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent("Slack app configuration token must start with xoxe.xoxp-")}`,
        302,
      );
    }

    const envVars = (await agentEnvService.getByAgentId(agentId)) ?? {};
    const appId = envVars.SLACK_APP_ID;
    if (!appId) {
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent("SLACK_APP_ID is not set — provision the agent first.")}`,
        302,
      );
    }

    try {
      const redirectUri = `${appBaseUrl}/admin/provision/complete`;
      const manifest = buildAgentManifest(agent.name, redirectUri);
      await slackClient.updateAppManifest(xoxpToken, appId, manifest);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Unknown error syncing manifest.";
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent(msg)}`,
        302,
      );
    }

    // If the agent has OAuth credentials stored, trigger a reinstall via Slack OAuth
    const clientId = envVars.SLACK_CLIENT_ID;
    const clientSecret = envVars.SLACK_CLIENT_SECRET;
    const signingSecret = envVars.SLACK_SIGNING_SECRET;

    if (clientId && clientSecret && signingSecret) {
      // Sign a provision-state cookie so /provision/complete can exchange the code
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
      setCookie(c, PROVISION_STATE_COOKIE, provisionToken, {
        httpOnly: true,
        maxAge: PROVISION_STATE_TTL_SECONDS,
        sameSite: "Lax",
        path: "/",
        secure: appBaseUrl.startsWith("https://"),
      });

      // Build the Slack OAuth v2 authorize URL — use the canonical scope list
      // exported from slack-provisioning-client.ts so this stays in sync with
      // what buildAgentManifest declares.
      const scopes = AGENT_BOT_SCOPES.join(",");
      const redirectUri = `${appBaseUrl}/admin/provision/complete`;
      const oauthParams = new URLSearchParams({
        client_id: clientId,
        scope: scopes,
        redirect_uri: redirectUri,
      });
      return c.redirect(
        `https://slack.com/oauth/v2/authorize?${oauthParams.toString()}`,
        302,
      );
    }

    return c.redirect(`/admin/agents/${agentId}?success=manifest_synced`, 302);
  });

  // ─── Provisioning flow ────────────────────────────────────────────────────

  app.get("/admin/provision", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const agents = await prisma.agent.findMany();
    return html(
      renderProvisionStartPage(
        c.var.userEmail,
        agents.map((a) => ({ id: a.id, name: a.name })),
      ),
    );
  });

  app.post("/admin/provision/start", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    // Load agents for form re-render on error
    const agents = await prisma.agent.findMany().catch(() => []);
    const agentOptions = agents.map((a) => ({ id: a.id, name: a.name }));

    const formError = (msg: string): Response =>
      html(
        renderProvisionStartPage(c.var.userEmail, agentOptions, { error: msg }),
      );

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

    if (!xoxpToken || !xoxpToken.startsWith("xoxe.xoxp-")) {
      return formError(
        "Slack app configuration token must start with xoxe.xoxp-",
      );
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
      const manifest = buildAgentManifest(agent.name, redirectUri);
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
      SLACK_CLIENT_ID: clientId,
      SLACK_CLIENT_SECRET: clientSecret,
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
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
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

    // Read the OAuth code param before consuming the cookie — if code is absent
    // the cookie must remain intact so the user can restart the provision flow.
    const code = c.req.query("code");
    if (!code) {
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          error:
            "Authorization was not completed (no OAuth code received). Please restart the provisioning flow from the beginning.",
        }),
      );
    }

    deleteCookie(c, PROVISION_STATE_COOKIE);

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
        err instanceof Error
          ? err.message
          : "Unknown error exchanging OAuth code.";
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          error: `OAuth exchange failed: ${msg}`,
        }),
      );
    }

    // Store SLACK_BOT_TOKEN in agent env
    const existing =
      (await agentEnvService.getByAgentId(provisionState.agentId)) ?? {};
    await agentEnvService.upsert(provisionState.agentId, {
      ...existing,
      SLACK_BOT_TOKEN: botToken,
    });

    // If SLACK_APP_TOKEN is already set this is a reinstall (not fresh provisioning).
    // Skip the xapp-token page and redirect directly to the agent detail page.
    if (existing.SLACK_APP_TOKEN) {
      return c.redirect(
        `/admin/agents/${provisionState.agentId}?success=reinstalled`,
        302,
      );
    }

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
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
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
      // Create scoped token first so both secrets land in one upsert
      const { rawToken } = await agentTokenService.create(agentId, "provision");

      const existing = (await agentEnvService.getByAgentId(agentId)) ?? {};
      await agentEnvService.upsert(agentId, {
        ...existing,
        SLACK_APP_TOKEN: xappToken,
        SHIPWRIGHT_AGENT_API_KEY: rawToken,
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
        err instanceof Error
          ? err.message
          : "Unknown error completing provisioning.";
      return html(
        renderProvisionXappTokenPage(userEmail, {
          agentId,
          error: msg,
        }),
      );
    }
  });

  // ─── Member management (admin only) ──────────────────────────────────────

  app.post("/admin/agents/:id/members", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const agentId = c.req.param("id");
    let email: string | undefined;
    try {
      const formData = await c.req.formData();
      email = formData.get("email")?.toString()?.toLowerCase();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (email) {
      try {
        await prisma.agentMember.create({ data: { agentId, email } });
      } catch {
        // unique constraint violation — already a member, ignore
      }
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/members/delete", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const agentId = c.req.param("id");
    let memberId: string | undefined;
    try {
      const formData = await c.req.formData();
      memberId = formData.get("memberId")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (memberId) {
      try {
        await prisma.agentMember.deleteMany({
          where: { id: memberId, agentId },
        });
      } catch {
        // already gone, ignore
      }
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Tasks page ───────────────────────────────────────────────────────────

  app.get("/admin/tasks", requireAuth, async (c) => {
    const status = c.req.query("status") ?? undefined;
    const session = c.req.query("session") ?? undefined;
    const repo = c.req.query("repo") ?? undefined;
    const error = c.req.query("error") ?? undefined;

    let tasks: TaskItem[] = [];
    let degraded = false;

    if (!fetchTaskStoreTasks) {
      degraded = true;
    } else {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (session) params.set("session", session);
      if (repo) params.set("repo", repo);
      try {
        tasks = await fetchTaskStoreTasks(params);
      } catch {
        degraded = true;
      }
    }

    return html(
      renderTasksPage(
        tasks,
        { status, session, repo },
        degraded,
        c.var.userEmail,
        error ? { error } : undefined,
      ),
    );
  });

  app.post("/admin/tasks/:id/release", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const taskId = c.req.param("id");
    if (releaseTask) {
      try {
        await releaseTask(taskId);
      } catch {
        return c.redirect("/admin/tasks?error=release_failed", 302);
      }
    }
    return c.redirect("/admin/tasks", 302);
  });

  // ─── Agent delete (danger zone) ───────────────────────────────────────────

  app.post("/admin/agents/:id/delete", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const agentId = c.req.param("id");
    try {
      await provisioner.deprovision(agentId);
      await prisma.agent.delete({ where: { id: agentId } });
    } catch (err) {
      const msg =
        err instanceof Error
          ? encodeURIComponent(err.message)
          : "delete_failed";
      return c.redirect(`/admin/agents/${agentId}?error=${msg}`, 302);
    }
    return c.redirect("/admin/agents?success=deleted", 302);
  });

  return app;
}
