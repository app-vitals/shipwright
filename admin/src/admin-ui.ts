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

import { isOrgRepo } from "@shipwright/lib/org-repo";
import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import {
  type AgentDetail,
  type AgentOption,
  type PrListItem,
  type PullRequestItem,
  type TaskItem,
  type TaskStoreTokenItem,
  renderAgentDetailPage,
  renderAgentsPage,
  renderChatPage,
  renderChatThreadPage,
  renderCronRunsPage,
  renderLoginPage,
  renderNewLocalAgentPage,
  renderPrDetailPage,
  renderProvisionCompletePage,
  renderProvisionStartPage,
  renderProvisionXappTokenPage,
  renderPrsPage,
  renderTaskDetailPage,
  renderTasksPage,
  renderTokensPage,
} from "./admin-ui-pages.ts";
import { validateAttachment } from "./attachment-validation.ts";
import type { ChatClient, ChatThread } from "./http-chat-client.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentCronRunService } from "./agent-cron-runs.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import { publicNoAuthMiddleware } from "./api-auth.ts";
import { ForbiddenError, UnprocessableEntityError } from "./errors.ts";
import type { GoogleAuthClient } from "./google-auth-client.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";
import {
  AGENT_BOT_SCOPES,
  buildAgentManifest,
} from "./slack-provisioning-client.ts";
import type { TaskStoreProvisioningClient } from "./task-store-provisioning-client.ts";

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
      repos?: string[];
    }>
  >;
  findUnique(args: { where: { id: string } }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    selfHosted: boolean;
    createdAt: Date;
    updatedAt: Date;
    repos: string[];
  } | null>;
  create(args: {
    data: { name: string; slackId?: string | null; selfHosted?: boolean };
  }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    createdAt: Date;
    updatedAt: Date;
    repos: string[];
  }>;
  update(args: {
    where: { id: string };
    data: { repos: string[] };
  }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    createdAt: Date;
    updatedAt: Date;
    repos: string[];
  }>;
  delete(args: { where: { id: string } }): Promise<{
    id: string;
    name: string;
    slackId: string | null;
    createdAt: Date;
    updatedAt: Date;
    repos: string[];
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
    "getByAgentId" | "upsert" | "patch" | "deleteKey" | "getConfigBundle"
  >;
  agentCronJobService: Pick<
    AgentCronJobService,
    | "list"
    | "listWithRunSummary"
    | "create"
    | "update"
    | "setEnabled"
    | "delete"
    | "get"
    | "reconcileSystemCrons"
  >;
  agentCronRunService: Pick<AgentCronRunService, "list">;
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
  fetchTaskStoreTasks?: (params: URLSearchParams) => Promise<{
    tasks: TaskItem[];
    total: number;
    limit: number;
    offset: number;
  }>;
  /**
   * Fetch a single task by ID from the task-store service. If absent, the
   * detail route redirects back to the list.
   */
  fetchTaskStoreTask?: (id: string) => Promise<TaskItem | null>;
  /**
   * Release a task (unclaim → pending) via the task-store service.
   */
  releaseTask?: (id: string) => Promise<void>;
  /**
   * Fetch distinct session and repo values from the task-store service.
   * Used to populate datalist autocomplete suggestions in the tasks filter form.
   * If absent, no datalists are rendered (inputs remain plain text).
   */
  fetchDistinctTaskValues?: () => Promise<{
    sessions: string[];
    repos: string[];
  }>;
  /**
   * IANA timezone name for date/time display in the admin UI.
   * Defaults to "America/Los_Angeles" when absent.
   */
  timezone?: string;
  /**
   * Fetch the pull request linked to a task from the task-store service.
   * If absent or the query fails, the task detail page renders without a PR section.
   */
  fetchTaskStorePr?: (taskId: string) => Promise<PullRequestItem | null>;
  /**
   * Fetch a paginated list of pull requests from the task-store service.
   * If absent, the PRs page renders in degraded mode (empty table + warning banner).
   */
  fetchTaskStorePrs?: (params: URLSearchParams) => Promise<{
    prs: PrListItem[];
    total: number;
    limit: number;
    offset: number;
  }>;
  /**
   * Fetch a single pull request by its ID from the task-store service.
   * If absent or returns null, the PR detail route redirects to /admin/prs.
   */
  fetchTaskStorePrById?: (id: string) => Promise<PrListItem | null>;
  /**
   * List all tokens from the task-store service (admin token required).
   * If absent, the tokens page renders in degraded mode.
   */
  adminListTokens?: () => Promise<TaskStoreTokenItem[]>;
  /**
   * Create a new token in the task-store service (admin token required).
   * Returns the token record plus the rawToken — shown once, never stored.
   */
  adminCreateToken?: (
    label?: string,
    agentId?: string,
  ) => Promise<TaskStoreTokenItem & { rawToken: string }>;
  /**
   * Revoke a token by ID via the task-store service (admin token required).
   */
  adminRevokeToken?: (id: string) => Promise<void>;
  /**
   * Base URL of the task-store service. When provided, the mint-success banner
   * renders a ready-to-paste env block with SHIPWRIGHT_TASK_STORE_URL and
   * SHIPWRIGHT_TASK_STORE_TOKEN so operators can copy-paste into their shell.
   */
  taskStoreBaseUrl?: string;
  /**
   * Public repo slug (SHIPWRIGHT_ADMIN_PUBLIC_REPO) for the read-only task board.
   * When set, GET /public/tasks renders the task list filtered to this repo
   * without requiring authentication. When absent, /public/tasks renders in
   * degraded mode (empty table + warning notice).
   */
  publicRepo?: string;
  /**
   * Chat service client for the /admin/chat routes.
   * When absent, all chat routes render in degraded mode (notice, no table/messages).
   */
  chatClient?: ChatClient;
  /**
   * Task-store provisioning client used by the xapp-token handler to mint a
   * per-agent task-store token during Slack wizard provisioning, mirroring
   * the K8s provisioning path. When absent, provisioning proceeds without
   * task-store credentials and a warning is logged.
   */
  taskStoreProvisioningClient?: TaskStoreProvisioningClient;
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
    agentCronRunService,
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
    fetchTaskStoreTask,
    releaseTask,
    fetchDistinctTaskValues,
    timezone = "America/Los_Angeles",
    fetchTaskStorePr,
    fetchTaskStorePrs,
    fetchTaskStorePrById,
    adminListTokens,
    adminCreateToken,
    adminRevokeToken,
    taskStoreBaseUrl,
    publicRepo,
    chatClient,
    taskStoreProvisioningClient,
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
    return html(
      renderAgentsPage(agents, c.var.userEmail, c.var.isAdmin, timezone),
    );
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
    invalid_repo_format:
      "Repo must be in org/repo format (e.g. my-org/my-repo).",
  };

  // ─── New local agent form (MUST be before /:id to avoid "new" being captured as param)

  app.get("/admin/agents/new", requireAuth, (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const rawError = c.req.query("error") ?? undefined;
    const error = rawError ? (ERROR_MESSAGES[rawError] ?? rawError) : undefined;
    return html(renderNewLocalAgentPage(c.var.userEmail, error));
  });

  // ─── Create agent (local / self-hosted) ──────────────────────────────────

  app.post("/admin/agents", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    let name: string | undefined;
    let reposRaw: string | undefined;
    try {
      const formData = await c.req.formData();
      name = formData.get("name")?.toString()?.trim();
      reposRaw = formData.get("repos")?.toString()?.trim();
    } catch {
      return c.redirect("/admin/agents/new", 302);
    }
    if (!name) {
      return c.redirect("/admin/agents/new?error=missing_fields", 302);
    }
    const agent = await prisma.agent.create({
      data: { name, selfHosted: true },
    });
    // Attach repos if provided
    if (reposRaw) {
      const repos = reposRaw
        .split(/\r?\n/)
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      const invalid = repos.filter((r) => !isOrgRepo(r));
      if (invalid.length > 0) {
        await prisma.agent.delete({ where: { id: agent.id } });
        return c.redirect("/admin/agents/new?error=invalid_repo_format", 302);
      }
      if (repos.length > 0) {
        await prisma.agent.update({
          where: { id: agent.id },
          data: { repos },
        });
      }
    }
    return c.redirect(`/admin/agents/${agent.id}`, 302);
  });

  app.get("/admin/agents/:id", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }
    const agentDetail: AgentDetail = {
      id: agent.id,
      name: agent.name,
      slackId: agent.slackId ?? null,
      selfHosted: agent.selfHosted,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      repos: agent.repos,
    };

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

    const [envResult, crons, tools, tokens, plugins, members] =
      await Promise.all([
        agentEnvService
          .getByAgentId(agentId)
          .then((e) => e ?? { env: {}, secretKeys: [] }),
        agentCronJobService.listWithRunSummary(agentId),
        agentToolService.list(agentId),
        agentTokenService.listForAgent(agentId),
        agentPluginService.list(agentId),
        c.var.isAdmin
          ? prisma.agentMember.findMany({ where: { agentId } })
          : Promise.resolve([]),
      ]);

    return html(
      renderAgentDetailPage(
        agentDetail,
        envResult,
        crons,
        tools,
        tokens,
        plugins,
        members,
        c.var.userEmail,
        c.var.isAdmin,
        { error, newToken, successMsg, timezone },
      ),
    );
  });

  app.get("/admin/agents/:id/crons/:cronId/runs", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const cronId = c.req.param("cronId");
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }

    let cron: Awaited<ReturnType<typeof agentCronJobService.get>>;
    try {
      cron = await agentCronJobService.get(agentId, cronId);
    } catch {
      return new Response("Cron not found", { status: 404 });
    }

    const runs = await agentCronRunService.list(cronId, agentId, {
      limit: 50,
    });

    return html(
      renderCronRunsPage({
        agent: { id: agent.id, name: agent.name },
        cron: { id: cron.id, name: cron.name, schedule: cron.schedule },
        runs: runs.items,
        userName: c.var.userEmail,
        timezone,
      }),
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
    let secretStr: string | undefined;
    try {
      const formData = await c.req.formData();
      key = formData.get("key")?.toString();
      value = formData.get("value")?.toString();
      secretStr = formData.get("secret")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (key && value !== undefined) {
      const isSecret = secretStr === "true";
      await agentEnvService.patch(
        agentId,
        { [key]: value },
        isSecret ? new Set([key]) : new Set(),
      );
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

  // ─── Repo mutations ───────────────────────────────────────────────────────

  app.post("/admin/agents/:id/repos/add", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let repo: string | undefined;
    try {
      const formData = await c.req.formData();
      repo = formData.get("repo")?.toString()?.trim();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (!repo || !isOrgRepo(repo)) {
      return c.redirect(
        `/admin/agents/${agentId}?error=invalid_repo_format`,
        302,
      );
    }
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }
    const existing = agent.repos ?? [];
    const deduped = existing.includes(repo) ? existing : [...existing, repo];
    await prisma.agent.update({
      where: { id: agentId },
      data: { repos: deduped },
    });
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  app.post("/admin/agents/:id/repos/delete", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    let repo: string | undefined;
    try {
      const formData = await c.req.formData();
      repo = formData.get("repo")?.toString()?.trim();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    if (repo) {
      const agent = await prisma.agent.findUnique({ where: { id: agentId } });
      if (!agent) {
        return new Response("Agent not found", { status: 404 });
      }
      const updated = (agent.repos ?? []).filter((r) => r !== repo);
      await prisma.agent.update({
        where: { id: agentId },
        data: { repos: updated },
      });
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
    const agentDetail: AgentDetail = {
      id: agent.id,
      name: agent.name,
      slackId: agent.slackId ?? null,
      selfHosted: agent.selfHosted,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      repos: agent.repos,
    };
    try {
      const { rawToken } = await agentTokenService.create(agentId, label);
      // Render the page directly (200) rather than redirecting with the token in the URL.
      // A redirect would expose the raw token in server access logs and browser history.
      const [envResult, crons, tools, tokens, plugins, members] =
        await Promise.all([
          agentEnvService
            .getByAgentId(agentId)
            .then((e) => e ?? { env: {}, secretKeys: [] }),
          agentCronJobService.listWithRunSummary(agentId),
          agentToolService.list(agentId),
          agentTokenService.listForAgent(agentId),
          agentPluginService.list(agentId),
          c.var.isAdmin
            ? prisma.agentMember.findMany({ where: { agentId } })
            : Promise.resolve([]),
        ]);
      return html(
        renderAgentDetailPage(
          agentDetail,
          envResult,
          crons,
          tools,
          tokens,
          plugins,
          members,
          c.var.userEmail,
          c.var.isAdmin,
          { newToken: rawToken, timezone },
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

    const envBundle = await agentEnvService.getConfigBundle(agentId);
    const appId = envBundle?.env.SLACK_APP_ID;
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
    const clientId = envBundle?.env.SLACK_CLIENT_ID;
    const clientSecret = envBundle?.env.SLACK_CLIENT_SECRET;
    const signingSecret = envBundle?.env.SLACK_SIGNING_SECRET;

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

    let agentMode: string | undefined;
    let agentId: string | undefined;
    let newAgentName: string | undefined;
    let newAgentRepos: string | undefined;
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
      agentMode = formData.get("agentMode")?.toString() ?? "existing";
      agentId = formData.get("agentId")?.toString();
      newAgentName = formData.get("newAgentName")?.toString()?.trim();
      newAgentRepos = formData.get("newAgentRepos")?.toString()?.trim();
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

    if (agentMode === "new") {
      if (!newAgentName) {
        return formError("Agent name is required.");
      }
    } else if (!agentId) {
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

    // ── Create new agent + provision (with rollback) ──────────────────────
    // Mirrors POST /agents in agents-api.ts: create the row, optionally
    // attach repos, then provision — rolling the row back if provisioning
    // throws so we never leave a half-created agent with no workload.

    if (agentMode === "new") {
      // biome-ignore lint/style/noNonNullAssertion: validated above (agentMode === "new" requires newAgentName)
      const name = newAgentName!;
      const repos = (newAgentRepos ?? "")
        .split(/\r?\n/)
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      const invalid = repos.filter((r) => !isOrgRepo(r));
      if (invalid.length > 0) {
        return formError(
          `Invalid repo format: ${invalid.join(", ")}. Expected org/repo.`,
        );
      }

      const newAgent = await prisma.agent.create({
        data: { name, selfHosted: false, ...(repos.length > 0 && { repos }) },
      });
      agentId = newAgent.id;

      try {
        await provisioner.provision(newAgent.id, { slug: newAgent.name });
      } catch (err) {
        await prisma.agent
          .delete({ where: { id: newAgent.id } })
          .catch((cleanupErr) => {
            console.error(
              "[admin-ui] failed to roll back agent after provision error:",
              cleanupErr,
            );
          });
        const msg =
          err instanceof Error ? err.message : "Unknown provisioning error.";
        return formError(`Agent created but provisioning failed: ${msg}`);
      }
    }

    // ── Fetch agent name for manifest ─────────────────────────────────────

    // agentId is guaranteed to be a non-empty string here: either validated
    // directly above (existing mode) or set to the newly-created agent's id
    // (new mode).
    // biome-ignore lint/style/noNonNullAssertion: see comment above
    const resolvedAgentId = agentId!;
    const agent = await prisma.agent.findUnique({
      where: { id: resolvedAgentId },
    });
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
      // In "new agent" mode, the agent row + K8s workload were already
      // created above. A downstream Slack failure here must roll those
      // back too, or a retry with the same name creates a second orphan
      // (this flow isn't idempotent on newAgentName).
      if (agentMode === "new") {
        await provisioner.deprovision(resolvedAgentId).catch((cleanupErr) => {
          console.error(
            "[admin-ui] failed to deprovision agent after Slack manifest error:",
            cleanupErr,
          );
        });
        await prisma.agent
          .delete({ where: { id: resolvedAgentId } })
          .catch((cleanupErr) => {
            console.error(
              "[admin-ui] failed to roll back agent after Slack manifest error:",
              cleanupErr,
            );
          });
        return formError(`Agent created but Slack setup failed: ${msg}`);
      }
      return formError(msg);
    }

    const { appId, oauthRedirectUrl, clientId, clientSecret, signingSecret } =
      slackResult;

    // ── Sign provision-state cookie ───────────────────────────────────────

    const now = Math.floor(Date.now() / 1000);
    const provisionToken = await sign(
      {
        agentId: resolvedAgentId,
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

    // Use patch() to merge new keys without overwriting existing unrelated keys
    const newEnv: Record<string, string> = {
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

    await agentEnvService.patch(resolvedAgentId, newEnv);

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
    // Fetch config bundle to get real (unmasked) values for merge check
    const existingBundle = await agentEnvService.getConfigBundle(
      provisionState.agentId,
    );
    // Use patch() to merge SLACK_BOT_TOKEN without overwriting other keys
    await agentEnvService.patch(provisionState.agentId, {
      SLACK_BOT_TOKEN: botToken,
    });

    // If SLACK_APP_TOKEN is already set this is a reinstall (not fresh provisioning).
    // Skip the xapp-token page and redirect directly to the agent detail page.
    if (existingBundle?.env.SLACK_APP_TOKEN) {
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
      // If SHIPWRIGHT_AGENT_API_KEY is already set, skip minting a new one — the
      // form has no CSRF/idempotency guard, so a resubmit must not mint (and
      // silently orphan) a second key while the configured one stays valid.
      const existingBundle = await agentEnvService.getConfigBundle(agentId);
      const alreadyConfigured = Boolean(
        existingBundle?.env.SHIPWRIGHT_AGENT_API_KEY,
      );

      let rawToken: string | undefined;
      if (!alreadyConfigured) {
        // Create scoped token first so both secrets land in one upsert
        const created = await agentTokenService.create(agentId, "provision");
        rawToken = created.rawToken;
      }

      // Mint a task-store token the same way the K8s provisioning path does
      // (agent-provisioner.ts), gated on the same idempotency guard as
      // SHIPWRIGHT_AGENT_API_KEY above so a resubmit can't orphan a second
      // token. When the admin server has no task-store client configured,
      // warn instead of silently skipping provisioning.
      const alreadyHasTaskStoreToken = Boolean(
        existingBundle?.env.SHIPWRIGHT_TASK_STORE_TOKEN,
      );
      let taskStoreToken: string | undefined;
      if (!taskStoreProvisioningClient) {
        console.warn(
          "[admin] task-store not configured — skipping task-store provisioning for agent",
          agentId,
        );
      } else if (!alreadyHasTaskStoreToken) {
        const minted = await taskStoreProvisioningClient.mintToken(
          `agent:${agentId}`,
          agentId,
        );
        taskStoreToken = minted.rawToken;
      }

      // Use patch() to merge new keys without overwriting existing env vars
      await agentEnvService.patch(agentId, {
        SLACK_APP_TOKEN: xappToken,
        ...(rawToken ? { SHIPWRIGHT_AGENT_API_KEY: rawToken } : {}),
        ...(taskStoreToken
          ? {
              SHIPWRIGHT_TASK_STORE_TOKEN: taskStoreToken,
              ...(taskStoreBaseUrl
                ? { SHIPWRIGHT_TASK_STORE_URL: taskStoreBaseUrl }
                : {}),
            }
          : {}),
      });

      // Seed system crons
      await agentCronJobService.reconcileSystemCrons(agentId);

      return html(
        renderProvisionCompletePage(userEmail, {
          success: true,
          agentId,
          rawToken,
          alreadyConfigured,
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
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const status = c.req.query("status") ?? undefined;
    const stateRaw = c.req.query("state");
    const state: "ready" | "in_progress" | "blocked" | "closed" | undefined =
      status
        ? undefined
        : stateRaw === "ready" ||
            stateRaw === "in_progress" ||
            stateRaw === "blocked" ||
            stateRaw === "closed"
          ? stateRaw
          : undefined;
    const session = c.req.query("session") ?? undefined;
    const repo = c.req.query("repo") ?? undefined;
    const agent = c.req.query("agent") ?? undefined;
    const error = c.req.query("error") ?? undefined;
    const pageRaw = c.req.query("page");
    const page = pageRaw ? Math.max(1, Number.parseInt(pageRaw, 10) || 1) : 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    // When filtering by agent name, resolve matching IDs upfront so we can
    // filter tasks client-side (task store only supports a single assignee ID).
    let agentFilterIds: Set<string> | null = null;
    if (agent) {
      const matched = await prisma.agent.findMany({
        where: { name: { contains: agent, mode: "insensitive" } },
      });
      agentFilterIds = new Set(matched.map((a) => a.id));
    }

    let tasks: TaskItem[] = [];
    let total = 0;
    let degraded = false;
    let distinctValues: { sessions: string[]; repos: string[] } | null = null;

    if (!fetchTaskStoreTasks) {
      degraded = true;
    } else {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (state) params.set("state", state);
      if (session) params.set("session", session);
      if (repo) params.set("repo", repo);
      // Agent-name filtering is done client-side, so we fetch a larger slice
      // when an agent filter is active to avoid under-counting across pages.
      params.set("limit", agentFilterIds !== null ? "500" : String(limit));
      params.set("offset", agentFilterIds !== null ? "0" : String(offset));
      try {
        const [result, distinct] = await Promise.all([
          fetchTaskStoreTasks(params),
          fetchDistinctTaskValues
            ? fetchDistinctTaskValues().catch(() => null)
            : Promise.resolve(null),
        ]);
        tasks = result.tasks;
        total = result.total;
        distinctValues = distinct;
      } catch {
        degraded = true;
      }
    }

    if (agentFilterIds !== null) {
      const ids = agentFilterIds;
      tasks = tasks.filter(
        (t) =>
          (t.assignee && ids.has(t.assignee)) ||
          (t.claimedBy && ids.has(t.claimedBy)),
      );
      total = tasks.length;
      tasks = tasks.slice(offset, offset + limit);
    }

    const agentIds = [
      ...new Set(
        tasks
          .flatMap((t) => [t.assignee, t.claimedBy])
          .filter((id): id is string => !!id),
      ),
    ];
    const agentNames: Record<string, string> = {};
    if (agentIds.length > 0) {
      const agents = await prisma.agent.findMany({
        where: { id: { in: agentIds } },
      });
      for (const a of agents) agentNames[a.id] = a.name;
    }

    // Build suggestions for autocomplete datalists only when task-store integration is active.
    // Skip the DB query entirely when fetchDistinctTaskValues is not configured.
    const suggestions =
      fetchDistinctTaskValues && distinctValues
        ? {
            sessions: distinctValues.sessions,
            repos: distinctValues.repos,
            agents: (
              await prisma.agent.findMany({ select: { name: true } })
            ).map((a) => a.name),
          }
        : undefined;

    return html(
      renderTasksPage(
        tasks,
        { status, state, session, repo, agent },
        degraded,
        c.var.userEmail,
        agentNames,
        { total, limit, page },
        {
          ...(error ? { error } : {}),
          agentFilterActive: agentFilterIds !== null,
        },
        suggestions,
      ),
    );
  });

  app.get("/admin/tasks/:id", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const taskId = c.req.param("id");
    if (!fetchTaskStoreTask)
      return c.redirect("/admin/tasks?error=task_store_unavailable", 302);
    let task: TaskItem | null = null;
    try {
      task = await fetchTaskStoreTask(taskId);
    } catch {
      return c.redirect("/admin/tasks?error=task_fetch_failed", 302);
    }
    if (!task) return c.redirect("/admin/tasks?error=task_not_found", 302);

    // Resolve agent IDs → names from the local admin DB
    const agentIds = [task.assignee, task.claimedBy, task.agentHint].filter(
      (id): id is string => !!id,
    );
    const agentNames: Record<string, string> = {};
    if (agentIds.length > 0) {
      const agents = await prisma.agent.findMany({
        where: { id: { in: agentIds } },
      });
      for (const a of agents) agentNames[a.id] = a.name;
    }

    // Fetch linked pull request — failure or absence renders the page without a PR section
    let pullRequest: PullRequestItem | undefined;
    if (fetchTaskStorePr) {
      try {
        pullRequest = (await fetchTaskStorePr(taskId)) ?? undefined;
      } catch {
        // swallow — page renders without PR section
      }
    }

    return html(
      renderTaskDetailPage(
        task,
        c.var.userEmail,
        agentNames,
        timezone,
        pullRequest,
      ),
    );
  });

  app.post("/admin/tasks/:id/release", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const taskId = c.req.param("id");
    if (!releaseTask)
      return c.redirect("/admin/tasks?error=task_store_unavailable", 302);
    try {
      await releaseTask(taskId);
    } catch {
      return c.redirect("/admin/tasks?error=release_failed", 302);
    }
    return c.redirect(
      fetchTaskStoreTask ? `/admin/tasks/${taskId}` : "/admin/tasks",
      302,
    );
  });

  // ─── PRs ─────────────────────────────────────────────────────────────────

  app.get("/admin/prs", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

    const stateParam = c.req.query("state") ?? undefined;
    const reviewState = c.req.query("reviewState") ?? undefined;
    const repo = c.req.query("repo") ?? undefined;
    const taskId = c.req.query("taskId") ?? undefined;
    const pageRaw = c.req.query("page");
    const page = pageRaw ? Math.max(1, Number.parseInt(pageRaw, 10) || 1) : 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    let prs: PrListItem[] = [];
    let total = 0;
    let degraded = false;

    if (!fetchTaskStorePrs) {
      degraded = true;
    } else {
      const params = new URLSearchParams();
      if (stateParam) params.set("state", stateParam);
      if (reviewState) params.set("reviewState", reviewState);
      if (repo) params.set("repo", repo);
      if (taskId) params.set("taskId", taskId);
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      try {
        const result = await fetchTaskStorePrs(params);
        prs = result.prs;
        total = result.total;
      } catch {
        degraded = true;
      }
    }

    const agentIds = [
      ...new Set(
        prs
          .flatMap((pr) => [pr.agentId, pr.claimedBy])
          .filter((id): id is string => !!id),
      ),
    ];
    const agentNames: Record<string, string> = {};
    if (agentIds.length > 0) {
      const agents = await prisma.agent.findMany({
        where: { id: { in: agentIds } },
      });
      for (const a of agents) agentNames[a.id] = a.name;
    }

    const suggestions = fetchDistinctTaskValues
      ? await fetchDistinctTaskValues()
          .then((v) => ({ repos: v.repos }))
          .catch(() => ({}))
      : {};

    return html(
      renderPrsPage(
        prs,
        { state: stateParam, reviewState, repo, taskId },
        degraded,
        c.var.userEmail,
        agentNames,
        { total, limit, page },
        timezone,
        suggestions,
      ),
    );
  });

  app.get("/admin/prs/:id", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    if (!fetchTaskStorePrById) return c.redirect("/admin/prs", 302);
    const prId = c.req.param("id");
    let pr: PrListItem | null = null;
    try {
      pr = await fetchTaskStorePrById(prId);
    } catch {
      return c.redirect("/admin/prs", 302);
    }
    if (!pr) return c.redirect("/admin/prs", 302);

    const agentIds = [pr.agentId, pr.claimedBy].filter(
      (id): id is string => !!id,
    );
    const agentNames: Record<string, string> = {};
    if (agentIds.length > 0) {
      const agents = await prisma.agent.findMany({
        where: { id: { in: agentIds } },
      });
      for (const a of agents) agentNames[a.id] = a.name;
    }

    return html(renderPrDetailPage(pr, c.var.userEmail, agentNames, timezone));
  });

  // ─── Chat routes ─────────────────────────────────────────────────────────

  app.get("/admin/chat", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

    const selectedAgentId = c.req.query("agentId") || undefined;
    const q = c.req.query("q") || undefined;
    const agents: AgentOption[] = (await prisma.agent.findMany()).map((a) => ({
      id: a.id,
      name: a.name,
    }));

    if (!chatClient) {
      return html(renderChatPage(agents, selectedAgentId, null, c.var.userEmail, q));
    }

    let threads: ChatThread[] = [];
    if (selectedAgentId) {
      try {
        const result = await chatClient.listThreads(selectedAgentId);
        threads = result.threads;
        // Server-side filter by search query
        if (q) {
          const lowerQ = q.toLowerCase();
          threads = threads.filter((t) =>
            (t.title ?? "").toLowerCase().includes(lowerQ),
          );
        }
      } catch {
        threads = [];
      }
    }

    return html(
      renderChatPage(agents, selectedAgentId, threads, c.var.userEmail, q),
    );
  });

  app.get("/admin/chat/:agentId/threads/:threadId", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

    const agentId = c.req.param("agentId");
    const threadId = c.req.param("threadId");

    if (!chatClient) {
      return html(
        renderChatThreadPage(agentId, null, null, null, c.var.userEmail),
      );
    }

    try {
      const [thread, messagesResult, threadListResult, statsResult] = await Promise.all([
        chatClient.getThread(threadId),
        chatClient.listMessages(threadId),
        chatClient.listThreads(agentId).catch(() => null),
        chatClient.getThreadStats(threadId).catch(() => null),
      ]);
      const threadList = threadListResult ? threadListResult.threads : null;
      return html(
        renderChatThreadPage(agentId, thread, messagesResult.messages, threadList, c.var.userEmail, statsResult),
      );
    } catch {
      return html(
        renderChatThreadPage(agentId, null, null, null, c.var.userEmail),
      );
    }
  });

  app.post("/admin/chat/:agentId/threads", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

    const agentId = c.req.param("agentId");

    if (!chatClient) {
      return c.redirect(`/admin/chat?agentId=${encodeURIComponent(agentId)}`, 302);
    }

    let title: string | undefined;
    try {
      const formData = await c.req.formData();
      title = formData.get("title")?.toString()?.trim() || undefined;
    } catch {
      return c.redirect(`/admin/chat?agentId=${encodeURIComponent(agentId)}`, 302);
    }

    try {
      const thread = await chatClient.createThread(agentId, { title });
      return c.redirect(
        `/admin/chat/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(thread.id)}`,
        302,
      );
    } catch {
      return c.redirect(`/admin/chat?agentId=${encodeURIComponent(agentId)}`, 302);
    }
  });

  // Upload route — registered BEFORE the form POST /messages route so the more
  // specific `/messages/upload` segment matches first. Returns JSON so the inline
  // send flow can surface validation errors without a full-page redirect.
  app.post(
    "/admin/chat/:agentId/threads/:threadId/messages/upload",
    requireAuth,
    async (c) => {
      if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

      const threadId = c.req.param("threadId");

      if (!chatClient) {
        return c.json({ error: "chat service not configured" }, 503);
      }

      let body: string | undefined;
      let file: File | null = null;
      try {
        const formData = await c.req.formData();
        body = formData.get("body")?.toString()?.trim();
        const rawFile = formData.get("file");
        file = rawFile instanceof File && rawFile.size > 0 ? rawFile : null;
      } catch {
        return c.json({ error: "invalid form data" }, 400);
      }

      let attachment:
        | { filename: string; size: number; bytes: Uint8Array }
        | undefined;
      if (file) {
        const validation = validateAttachment(file.name, file.size, file.type);
        if (!validation.ok) {
          return c.json({ error: validation.error }, validation.status);
        }
        attachment = {
          filename: file.name,
          size: file.size,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }

      // A message needs at least a body or a file.
      if (!body && !attachment) {
        return c.json({ error: "message body or file is required" }, 400);
      }

      try {
        const message = await chatClient.createMessage(
          threadId,
          "user",
          body ?? "",
          attachment,
        );
        return c.json({ message }, 201);
      } catch {
        return c.json({ error: "failed to create message" }, 500);
      }
    },
  );

  app.post(
    "/admin/chat/:agentId/threads/:threadId/messages",
    requireAuth,
    async (c) => {
      if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

      const agentId = c.req.param("agentId");
      const threadId = c.req.param("threadId");

      const backUrl = `/admin/chat/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`;

      if (!chatClient) {
        return c.redirect(backUrl, 302);
      }

      const ALLOWED_ROLES = ["user", "assistant"] as const;
      type MessageRole = (typeof ALLOWED_ROLES)[number];

      let body: string | undefined;
      let role: MessageRole = "user";
      let file: File | null = null;
      try {
        const formData = await c.req.formData();
        body = formData.get("body")?.toString()?.trim();
        const rawRole = formData.get("role")?.toString() || "user";
        role = (ALLOWED_ROLES as readonly string[]).includes(rawRole)
          ? (rawRole as MessageRole)
          : "user";
        const rawFile = formData.get("file");
        file = rawFile instanceof File && rawFile.size > 0 ? rawFile : null;
      } catch {
        return c.redirect(backUrl, 302);
      }

      let attachment:
        | { filename: string; size: number; bytes: Uint8Array }
        | undefined;
      if (file) {
        const validation = validateAttachment(file.name, file.size, file.type);
        if (!validation.ok) {
          // Invalid attachment — bounce back without queuing anything.
          return c.redirect(backUrl, 302);
        }
        attachment = {
          filename: file.name,
          size: file.size,
          bytes: new Uint8Array(await file.arrayBuffer()),
        };
      }

      if (!body && !attachment) {
        return c.redirect(backUrl, 302);
      }

      try {
        await chatClient.createMessage(threadId, role, body ?? "", attachment);
      } catch {
        // swallow — redirect back regardless
      }

      return c.redirect(backUrl, 302);
    },
  );

  app.post(
    "/admin/chat/:agentId/threads/:threadId/rename",
    requireAuth,
    async (c) => {
      if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

      const agentId = c.req.param("agentId");
      const threadId = c.req.param("threadId");
      const backUrl = `/admin/chat/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}`;

      if (!chatClient) {
        return c.redirect(backUrl, 302);
      }

      let title: string | undefined;
      try {
        const formData = await c.req.formData();
        title = formData.get("title")?.toString()?.trim() || undefined;
      } catch {
        return c.redirect(backUrl, 302);
      }

      // Guard: skip the API call when title is blank to avoid a silent no-op PATCH
      if (!title) {
        return c.redirect(backUrl, 302);
      }

      try {
        await chatClient.updateThread(threadId, { title });
      } catch {
        // swallow — redirect back regardless
      }

      return c.redirect(backUrl, 302);
    },
  );

  app.post(
    "/admin/chat/:agentId/threads/:threadId/delete",
    requireAuth,
    async (c) => {
      if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

      const agentId = c.req.param("agentId");
      const threadId = c.req.param("threadId");

      if (!chatClient) {
        return c.redirect(
          `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
          302,
        );
      }

      try {
        await chatClient.deleteThread(threadId);
      } catch {
        // swallow — redirect back regardless
      }

      return c.redirect(
        `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
        302,
      );
    },
  );

  // ─── Chat JSON API routes ─────────────────────────────────────────────────

  app.get(
    "/admin/chat/:agentId/threads/:threadId/messages.json",
    requireAuth,
    async (c) => {
      if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

      const threadId = c.req.param("threadId");

      if (!chatClient) {
        return c.json({ messages: [] });
      }

      try {
        const result = await chatClient.listMessages(threadId);
        return c.json({ messages: result.messages });
      } catch {
        return c.json({ messages: [] });
      }
    },
  );

  app.post(
    "/admin/chat/:agentId/threads/:threadId/messages.json",
    requireAuth,
    async (c) => {
      if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

      const threadId = c.req.param("threadId");

      if (!chatClient) {
        return c.json({ message: null });
      }

      let body: string | undefined;
      try {
        const jsonBody = await c.req.json<{ body?: string }>();
        body = jsonBody.body?.trim();
      } catch {
        return c.json({ message: null }, 400);
      }

      if (!body) {
        return c.json({ message: null }, 400);
      }

      try {
        const message = await chatClient.createMessage(threadId, "user", body);
        return c.json({ message });
      } catch {
        return c.json({ message: null }, 500);
      }
    },
  );

  // ─── Task-store token proxy routes ────────────────────────────────────────

  app.get("/admin/tokens", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const error = c.req.query("error") ?? undefined;
    const selectedAgentId = c.req.query("agentId") ?? undefined;
    let tokens: TaskStoreTokenItem[] = [];
    let degraded = false;
    if (!adminListTokens) {
      degraded = true;
    } else {
      try {
        tokens = await adminListTokens();
      } catch {
        degraded = true;
      }
    }
    const agents = await prisma.agent.findMany();
    return html(
      renderTokensPage(
        tokens,
        degraded,
        c.var.userEmail,
        c.req.path,
        undefined,
        timezone,
        error,
        agents,
        selectedAgentId,
      ),
    );
  });

  app.post("/admin/tokens", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    if (!adminCreateToken)
      return new Response("Token store not configured", { status: 503 });
    const form = await c.req.formData();
    const label = form.get("label")?.toString()?.trim() || undefined;
    if (!label) return c.redirect("/admin/tokens?error=Label+is+required", 302);
    const agentId = form.get("agentId")?.toString() || undefined;
    let result: (TaskStoreTokenItem & { rawToken: string }) | undefined;
    try {
      result = await adminCreateToken(label, agentId);
    } catch (err) {
      const msg =
        err instanceof Error
          ? encodeURIComponent(err.message)
          : "create_failed";
      return c.redirect(`/admin/tokens?error=${msg}`, 302);
    }
    // Render inline — never redirect with the raw token in the URL.
    let tokens: TaskStoreTokenItem[] = [];
    try {
      if (adminListTokens) tokens = await adminListTokens();
    } catch {
      // best-effort refresh; show the new token even if list fails
    }
    const agents = await prisma.agent.findMany();
    return html(
      renderTokensPage(
        tokens,
        false,
        c.var.userEmail,
        "/admin/tokens",
        result.rawToken,
        timezone,
        undefined,
        agents,
        agentId,
        taskStoreBaseUrl,
      ),
    );
  });

  app.post("/admin/tokens/:id/revoke", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    if (!adminRevokeToken)
      return new Response("Token store not configured", { status: 503 });
    const tokenId = c.req.param("id");
    try {
      await adminRevokeToken(tokenId);
    } catch (err) {
      const msg =
        err instanceof Error
          ? encodeURIComponent(err.message)
          : "revoke_failed";
      return c.redirect(`/admin/tokens?error=${msg}`, 302);
    }
    return c.redirect("/admin/tokens", 302);
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

  // ─── Public read-only task board ──────────────────────────────────────────
  //
  // Unauthenticated GET /public/tasks — no session cookie required.
  // Scoped to publicRepo (SHIPWRIGHT_ADMIN_PUBLIC_REPO). When publicRepo is
  // absent the page renders in degraded mode (empty table + warning notice).
  // No create/edit/status-change controls are rendered (readOnly=true).
  // Mutation methods (POST/PUT/DELETE) fall through to Hono's 404 default.

  app.get("/public/tasks", publicNoAuthMiddleware, async (c) => {
    let tasks: TaskItem[] = [];
    let total = 0;
    let degraded = false;

    if (!fetchTaskStoreTasks || !publicRepo) {
      degraded = true;
    } else {
      const params = new URLSearchParams();
      params.set("repo", publicRepo);
      params.set("limit", "50");
      params.set("offset", "0");
      try {
        const result = await fetchTaskStoreTasks(params);
        tasks = result.tasks;
        total = result.total;
      } catch {
        degraded = true;
      }
    }

    return html(
      renderTasksPage(
        tasks,
        { repo: publicRepo },
        degraded,
        "",
        {},
        { total, limit: 50, page: 1 },
        undefined,
        undefined,
        true, // readOnly
      ),
    );
  });

  return app;
}
