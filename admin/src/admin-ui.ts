/**
 * agent/src/admin-ui.ts
 * Admin UI — server-rendered Hono app factory.
 *
 * Routes:
 *   GET  /admin/login                 — login page (Google sign-in button)
 *   GET  /admin/auth/google           — redirect to Google OAuth consent
 *   GET  /admin/auth/callback         — Google OAuth callback → set session cookie
 *   GET  /admin/auth/okta             — redirect to Okta OIDC consent
 *   GET  /admin/auth/okta/callback    — Okta OAuth callback → set session cookie
 *   POST /admin/logout                — clear cookie → redirect to login
 *   GET  /admin/agents                — list all agents (auth required)
 *   GET  /admin/agents/:id            — agent detail (auth required)
 *   POST /admin/agents/:id/envs       — add/update env var (auth required)
 *   POST /admin/agents/:id/envs/delete — delete env var (auth required)
 *   GET  /admin/provision             — 302 redirect to /admin/agents/new (legacy entry point)
 *
 * Auth: httpOnly JWT cookie named "admin_session".
 * Login is OAuth (Google or Okta) — no password, no DB user lookup. Both
 * providers share a common post-auth step (completeLogin()): verified-email
 * check, admin-allowlist/AgentMember-fallback check, session JWT + cookie.
 * Allowed users are controlled by the adminAllowedEmails allowlist in deps.
 */

import { join } from "node:path";
import { isGithubLogin } from "@shipwright/lib/github-login";
import { isOrgRepo } from "@shipwright/lib/org-repo";
import { SECRET_ENV_VARS } from "@shipwright/lib/secret-env-vars";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import {
  type AgentDetail,
  type AgentOption,
  type PrListItem,
  type PullRequestItem,
  type TaskItem,
  type WorkQueueItem,
  renderAgentDetailPage,
  renderAgentsPage,
  renderChatMessageBubble,
  renderChatPage,
  renderChatThreadPage,
  renderGithubAppInstallPage,
  renderGithubAppInstalledPage,
  renderGithubAppManifestRedirectPage,
  renderLoginPage,
  renderNewLocalAgentPage,
  renderPrDetailPage,
  renderProvisionCompletePage,
  renderProvisionXappTokenPage,
  renderPrsPage,
  renderQueueActivityPage,
  renderSessionDetailPage,
  renderTaskDetailPage,
  renderTasksPage,
} from "./admin-ui-pages.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import type { AgentCronRunService } from "./agent-cron-runs.ts";
import type { ManualStep } from "./agent-deletion-checklist.ts";
import type { DeleteAgentFullyDeps } from "./agent-deletion.ts";
import { deleteAgentFully } from "./agent-deletion.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import type { AgentMemberService } from "./agent-members.ts";
import type { AgentPluginService } from "./agent-plugins.ts";
import type { AgentProvisioner } from "./agent-provisioner.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import type { AgentToolService } from "./agent-tools.ts";
import {
  type AgentTypeManifestResolver,
  AgentTypeRegistry,
} from "./agent-type-manifest-loader.ts";
import type { AgentWorkQueueService } from "./agent-work-queue.ts";
import type { AgentService } from "./agents.ts";
import { publicNoAuthMiddleware } from "./api-auth.ts";
import { validateAttachment } from "./attachment-validation.ts";
import { ForbiddenError, UnprocessableEntityError } from "./errors.ts";
import {
  GITHUB_PROVISION_STATE_COOKIE,
  GITHUB_PROVISION_STATE_TTL_SECONDS,
  GithubProvisioningService,
} from "./github-provisioning-service.ts";
import type { GoogleAuthClient } from "./google-auth-client.ts";
import {
  type ChatClient,
  type ChatThread,
  filterSince,
} from "./http-chat-client.ts";
import type { OktaAuthClient } from "./okta-auth-client.ts";
import type { PushService } from "./push-service.ts";
import {
  PWA_ASSETS_DIR,
  PWA_ICONS,
  buildManifest,
  buildOfflinePageHtml,
  buildServiceWorkerBody,
  getPrecacheList,
  renderPwaHeadTags,
} from "./pwa.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";
import {
  AGENT_BOT_SCOPES,
  buildAgentManifest,
} from "./slack-provisioning-client.ts";
import {
  PROVISION_STATE_COOKIE,
  PROVISION_STATE_TTL_SECONDS,
  SlackProvisioningService,
} from "./slack-provisioning-service.ts";

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
  authTest(botToken: string): Promise<{ userId: string }>;
}

/**
 * Narrow interface for the admin UI's GitHub App provisioning dependency.
 * Mirrors AdminUISlackClient's DI pattern — deliberately narrower than the
 * full GithubAppProvisioningClient in github-app-provisioning-client.ts.
 */
export interface AdminUIGithubAppClient {
  exchangeManifestCode(code: string): Promise<{
    appId: string;
    slug: string;
    pem: string;
    clientId: string;
    clientSecret: string;
  }>;
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
  agentEnv: {
    findMany(args: {
      where: { agentId: string };
      select: { key: true; value: true; secret: true };
    }): Promise<{ key: string; value: string; secret: boolean }[]>;
  };
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
  // Web Push (CFB-4.2). Present on the real PrismaClient after the migration;
  // narrowed here to only what the admin UI routes touch. Optional so existing
  // test doubles (which never enable push) stay valid — the push routes only
  // touch these when pushEnabled is true.
  pushSubscription?: {
    upsert(args: {
      where: { endpoint: string };
      create: {
        userEmail: string;
        endpoint: string;
        p256dh: string;
        auth: string;
      };
      update: { userEmail: string; p256dh: string; auth: string };
    }): Promise<{ id: string }>;
    deleteMany(args: {
      where: { endpoint: string; userEmail?: string };
    }): Promise<{ count: number }>;
  };
  chatThreadWatch?: {
    upsert(args: {
      where: { userEmail_threadId: { userEmail: string; threadId: string } };
      create: { userEmail: string; threadId: string; agentId: string };
      update: { agentId: string };
    }): Promise<{ id: string }>;
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
  agentCronRunService: Pick<AgentCronRunService, "listForAgent">;
  agentWorkQueueService: Pick<AgentWorkQueueService, "get">;
  agentToolService: Pick<
    AgentToolService,
    "list" | "add" | "toggle" | "remove"
  >;
  agentTokenService: Pick<
    AgentTokenService,
    "listForAgent" | "create" | "revoke"
  >;
  agentPluginService: Pick<AgentPluginService, "list">;
  agentMemberService: Pick<
    AgentMemberService,
    "listByEmail" | "exists" | "add" | "remove" | "listByAgentId"
  >;
  agentService: Pick<
    AgentService,
    | "listAll"
    | "listByIds"
    | "searchByName"
    | "listOptions"
    | "create"
    | "delete"
    | "getDetail"
    | "updateFields"
  >;
  provisioner: AgentProvisioner;
  /**
   * Resolves an agent's typeName to its parsed Agent Type manifest and lists
   * the registry's discoverable types (for the new-agent type picker).
   * Defaults to a disk-backed AgentTypeRegistry, matching the DI pattern
   * already used by agents-api.ts's AdminDeps.
   */
  agentTypeRegistry?: AgentTypeManifestResolver;
  /**
   * Cleanup deps for the full delete-agent orchestration (POST
   * /admin/agents/:id/delete → deleteAgentFully()). Matches
   * DeleteAgentFullyDeps's shapes exactly, mirroring agents-api.ts's AdminDeps
   * so both delete entry points share the same production wiring in main.ts.
   */
  taskStore: DeleteAgentFullyDeps["taskStore"];
  chatService: DeleteAgentFullyDeps["chatService"];
  slack: DeleteAgentFullyDeps["slack"];
  decrypt: DeleteAgentFullyDeps["decrypt"];
  sessionSecret: string;
  googleClient: GoogleAuthClient;
  googleClientId: string;
  googleClientSecret: string;
  /**
   * Okta OIDC client for GET /admin/auth/okta and GET /admin/auth/okta/callback.
   * Optional — when oktaClientId/oktaIssuer are unset (or oktaClient is absent),
   * both Okta routes redirect to /admin/login?error=server_error without
   * attempting any external call, mirroring Google's own missing-config guard.
   */
  oktaClient?: OktaAuthClient;
  oktaClientId?: string;
  oktaClientSecret?: string;
  oktaIssuer?: string;
  adminAllowedEmails: string[];
  slackClient: AdminUISlackClient;
  /**
   * GitHub App manifest-flow provisioning client, used by the auto-provision
   * sub-flow under ghAuthMode=app: GET /admin/provision/github-app/complete
   * exchanges the manifest-flow code via exchangeManifestCode().
   */
  githubAppClient: AdminUIGithubAppClient;
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
    orgs: string[];
  }>;
  /**
   * IANA timezone name for date/time display in the admin UI.
   * Defaults to "America/Los_Angeles" when absent.
   */
  timezone?: string;
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
   * Base directory the PWA shell's icon route reads committed PNGs from.
   * Injectable for tests; defaults to the committed admin/pwa-assets/icons
   * dir (see admin/src/pwa.ts's PWA_ASSETS_DIR, populated by the
   * one-time/on-demand scripts/build-pwa-icons.ts).
   */
  pwaAssetsDir?: string;
  /**
   * App version string interpolated into the service worker's cache name
   * (see admin/src/pwa.ts's buildServiceWorkerBody) so a version bump busts
   * any previously installed cache. Read once from version.txt at startup —
   * matches the "inject time via a Clock" isolation convention rather than
   * reading the file inside the route handler.
   */
  appVersion?: string;
  /**
   * Web Push (CFB-4.2). All three are set together or none: main.ts only wires
   * them when isPushEnabled() is true (public + private + subject all set), so
   * when push is not fully configured pushService is undefined, the routes 503,
   * and the toggle renders "" (page degrades to the CFB-3.2 page).
   */
  pushService?: PushService;
  /** VAPID PUBLIC key — sent to the browser (NOT a secret). "" disables the toggle. */
  vapidPublicKey?: string;
  /** Shared token the chat service presents to the push-notify webhook. */
  pushWebhookToken?: string;
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

// ─── Back-link validation ───────────────────────────────────────────────────

// Shared allowlist resolver: a `from` query param is only honored as a back
// link when it matches the given same-origin pattern. Rejects protocol-relative
// (//evil.com), absolute (https://evil.com), javascript:, and any other-path
// values — those fall back to the given default so a "← X" anchor can never be
// used as an open-redirect/phishing hop off the admin domain.
function resolveBackHref(
  fromParam: string | undefined,
  pattern: RegExp,
  fallback: string,
): string {
  if (fromParam && pattern.test(fromParam)) {
    return fromParam;
  }
  return fallback;
}

// Allowlist for the Task Detail "← Tasks" back link: a same-path /admin/tasks
// URL, optionally followed by a query string.
const TASK_LIST_BACK_HREF_PATTERN = /^\/admin\/tasks(\?[^\s]*)?$/;

// TBC-2.1: the default (board) view of /admin/tasks queries task-store with
// this raised cap instead of the standard 50, since it now excludes the
// fully-closed statuses (Claimed/Done are no longer rendered board columns)
// and needs a wider window over the remaining active statuses to avoid
// under-filling Queued/In Progress/Blocked-HITL. ?view=table keeps the
// standard limit of 50, unaffected by this constant.
const BOARD_TASK_LIMIT = 200;

function resolveTaskDetailBackHref(fromParam: string | undefined): string {
  return resolveBackHref(
    fromParam,
    TASK_LIST_BACK_HREF_PATTERN,
    "/admin/tasks",
  );
}

// Allowlist for the Session Detail "← Tasks" back link: either the tasks list
// (/admin/tasks) or a single task detail page (/admin/tasks/:id), each
// optionally followed by a query string — Session Detail is reachable from
// both the tasks list and a task's Session field.
const SESSION_BACK_HREF_PATTERN = /^\/admin\/tasks(\/[^/?\s]+)?(\?[^\s]*)?$/;

function resolveSessionDetailBackHref(fromParam: string | undefined): string {
  return resolveBackHref(fromParam, SESSION_BACK_HREF_PATTERN, "/admin/tasks");
}

/**
 * Redirects to the agent detail page, appending the zero-members warning
 * query param when restrictSlackToMembers was just enabled on an agent with
 * no AgentMember rows. Non-blocking — the caller's save already succeeded;
 * this only decides which redirect target to use.
 */
async function redirectWithMembersWarning(
  c: Context<AdminUIEnv>,
  agentMemberService: Pick<AgentMemberService, "listByAgentId">,
  agentId: string,
  restrictSlackToMembers: boolean,
) {
  if (restrictSlackToMembers) {
    const members = await agentMemberService.listByAgentId(agentId);
    if (members.length === 0) {
      return c.redirect(
        `/admin/agents/${agentId}?warning=restrict_slack_no_members`,
        302,
      );
    }
  }
  return c.redirect(`/admin/agents/${agentId}`, 302);
}

// ─── App factory ──────────────────────────────────────────────────────────────

export function createAdminUIApp(deps: AdminUIDeps): Hono<AdminUIEnv> {
  const {
    prisma,
    agentEnvService,
    agentCronJobService,
    agentCronRunService,
    agentWorkQueueService,
    agentToolService,
    agentTokenService,
    agentPluginService,
    agentMemberService,
    agentService,
    provisioner,
    agentTypeRegistry = new AgentTypeRegistry(),
    taskStore,
    chatService,
    slack,
    decrypt,
    sessionSecret,
    googleClient,
    googleClientId,
    googleClientSecret,
    oktaClient,
    oktaClientId = "",
    oktaClientSecret = "",
    oktaIssuer = "",
    adminAllowedEmails,
    slackClient,
    githubAppClient,
    appBaseUrl,
    devAuthEnabled = false,
    fetchTaskStoreTasks,
    fetchTaskStoreTask,
    releaseTask,
    fetchDistinctTaskValues,
    timezone = "America/Los_Angeles",
    fetchTaskStorePrs,
    fetchTaskStorePrById,
    publicRepo,
    chatClient,
    pwaAssetsDir = PWA_ASSETS_DIR,
    appVersion = "0.0.0",
    pushService,
    vapidPublicKey = "",
    pushWebhookToken,
  } = deps;

  // Push is enabled only when the service was constructed (VAPID fully set) AND
  // a public key is available for the browser. A single derived flag so the
  // toggle-render gate and the route-503 gate can't drift.
  const pushEnabled = Boolean(pushService && vapidPublicKey);

  const app = new Hono<AdminUIEnv>();

  const requireAuth = createUIAuthMiddleware(sessionSecret);

  // Extracted Slack app-manifest-creation/OAuth/app-token orchestration
  // (UAP-1.1) — shared by the legacy /admin/provision/* wizard's Slack
  // branch and the new per-agent /admin/agents/:id/connect-slack routes so
  // both reach the same outcome via the same code path.
  const slackProvisioningService = new SlackProvisioningService({
    slackClient,
    agentService,
    agentEnvService,
    agentCronJobService,
    sessionSecret,
    appBaseUrl,
    secretEnvVars: new Set(SECRET_ENV_VARS),
  });

  // Extracted GitHub App manifest-flow/PAT provisioning orchestration
  // (UAP-1.2) — shared by the legacy /admin/provision/* wizard's GitHub
  // branches (+ github-app/complete + github-app/installed) and the new
  // per-agent /admin/agents/:id/connect-github routes so both reach the same
  // outcome via the same code path.
  const githubProvisioningService = new GithubProvisioningService({
    githubAppClient,
    agentService,
    agentEnvService,
    agentCronJobService,
    sessionSecret,
    appBaseUrl,
    secretEnvVars: new Set(SECRET_ENV_VARS),
  });

  // Best-effort upsert of a ChatThreadWatch row (CFB-4.2). Never throws into a
  // request cycle — push is a convenience layer, so a watch-write failure must
  // not fail the message send it rides along with.
  async function watchThread(
    userEmail: string,
    agentId: string,
    threadId: string,
  ): Promise<void> {
    if (!prisma.chatThreadWatch) return;
    try {
      await prisma.chatThreadWatch.upsert({
        where: { userEmail_threadId: { userEmail, threadId } },
        create: { userEmail, threadId, agentId },
        update: { agentId },
      });
    } catch (err) {
      console.error("[push] watchThread upsert failed:", err);
    }
  }

  // ─── HTML helper ──────────────────────────────────────────────────────────

  // Precomputed once per app instance (not per-request): the manifest link +
  // SW-registration script, gated on appBaseUrl being https (see
  // admin/src/pwa.ts's renderPwaHeadTags — "" when the gate fails, e.g. a
  // home-lab operator on plain HTTP).
  const pwaHeadTags = renderPwaHeadTags(appBaseUrl);

  /**
   * Splices the PWA head tags in just before </head> so every rendered
   * admin page gets the manifest link + SW registration site-wide, without
   * threading appBaseUrl through admin-ui-pages.ts's 24 render*Page
   * functions. A no-op when pwaHeadTags is "" (non-https appBaseUrl).
   */
  function injectPwaHeadTags(content: string): string {
    if (!pwaHeadTags) return content;
    return content.replace("</head>", `  ${pwaHeadTags}\n</head>`);
  }

  /**
   * `includePwaTags` defaults to true for every /admin/* page. The one
   * opt-out is GET /public/tasks — its manifest scope is /admin/, and that
   * unauthenticated read-only board must never reference /admin/ URLs at
   * all (see the "does not leak /admin/ links" contract below).
   */
  function html(
    content: string,
    opts?: { includePwaTags?: boolean },
  ): Response {
    const body =
      opts?.includePwaTags === false ? content : injectPwaHeadTags(content);
    return new Response(body, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // CSP is out of scope (would need unsafe-inline today and buys
        // nothing here) — these three are the low-risk, high-value headers
        // for a server-rendered admin console.
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
      },
    });
  }

  // ─── Login / OAuth / Logout ───────────────────────────────────────────────

  /**
   * Shared post-authentication step for every OAuth provider (Google, Okta):
   * checks the verified-email + admin-allowlist/AgentMember-fallback rules,
   * mints the session JWT, sets the session cookie, and redirects to
   * `returnTo` (or the default landing page). Each provider's callback route
   * normalizes its own userinfo shape into this common `{sub, email,
   * email_verified}` input before calling in — callers never see a
   * provider-specific type here.
   *
   * Returns a Response in every case (a redirect or a 403), matching each
   * inline early-return the Google callback used before this was extracted.
   */
  async function completeLogin(
    // biome-ignore lint/suspicious/noExplicitAny: matches each OAuth callback route's own path-string literal type; the path itself is irrelevant here.
    c: Context<AdminUIEnv, any>,
    userInfo: { sub: string; email?: string; email_verified?: boolean },
    returnTo: string | undefined,
  ): Promise<Response> {
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
      const memberships = await agentMemberService.listByEmail(
        userInfo.email.toLowerCase(),
      );
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
  }

  /**
   * Shared OAuth-start step for every provider (Google, Okta): mints a CSRF
   * nonce, validates `returnTo` as a same-origin relative path (dropping
   * malformed/absolute values), and stores both in the oauth_state cookie.
   */
  function beginOAuthFlow(
    // biome-ignore lint/suspicious/noExplicitAny: matches each OAuth start route's own path-string literal type; the path itself is irrelevant here.
    c: Context<AdminUIEnv, any>,
  ): { nonce: string; returnTo: string | undefined } {
    const nonce = crypto.randomUUID();

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

    return { nonce, returnTo };
  }

  /**
   * Shared OAuth-callback CSRF check for every provider: reads + clears the
   * oauth_state cookie, and confirms its nonce matches the `state` query
   * param. Returns the carried `returnTo` on success, or `null` if the
   * cookie is missing/malformed or the nonce doesn't match.
   */
  function validateOAuthState(
    // biome-ignore lint/suspicious/noExplicitAny: matches each OAuth callback route's own path-string literal type; the path itself is irrelevant here.
    c: Context<AdminUIEnv, any>,
    state: string | undefined,
  ): { returnTo: string | undefined } | null {
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
      return null;
    }
    return { returnTo };
  }

  // ─── PWA shell (manifest, service worker, icons, offline page) ───────────
  //
  // Deliberately unauthenticated (no requireAuth) — this is required, not a
  // shortcut. Browsers fetch the manifest and service worker with
  // credentials:omit, so gating either behind the session cookie would 302
  // to /admin/login and silently break install. Neither route leaks
  // secrets: the manifest is static config, and the SW's own caching
  // predicate (admin/src/pwa.ts) refuses every authenticated document/JSON
  // route by construction.

  app.get("/admin/manifest.webmanifest", (c) => {
    return c.json(buildManifest(), 200, {
      "Content-Type": "application/manifest+json",
    });
  });

  app.get("/admin/sw.js", (c) => {
    const body = buildServiceWorkerBody(appVersion, getPrecacheList());
    return new Response(body, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        // A cached service worker is unupdatable — browsers must always
        // revalidate this file so a version bump's new cache name (and any
        // precache-list change) actually takes effect.
        "Cache-Control": "no-cache",
      },
    });
  });

  app.get("/admin/offline.html", (c) => {
    return new Response(buildOfflinePageHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });

  const PWA_ICON_FILENAMES = new Set(PWA_ICONS.map((icon) => icon.filename));

  app.get("/admin/icons/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!PWA_ICON_FILENAMES.has(filename)) {
      return c.json({ error: "Not found" }, 404);
    }
    try {
      const body = await Bun.file(
        join(pwaAssetsDir, "icons", filename),
      ).arrayBuffer();
      return new Response(body, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return c.json({ error: "Not found" }, 404);
      }
      console.error(`[admin-ui] PWA icon read error [${filename}]:`, err);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  app.get("/admin/login", (c) => {
    const error = c.req.query("error") ?? undefined;
    const returnTo = c.req.query("returnTo") ?? undefined;
    const oktaEnabled = Boolean(oktaClientId && oktaIssuer && oktaClient);
    return html(renderLoginPage({ error, returnTo, oktaEnabled }));
  });

  app.get("/admin/auth/google", (c) => {
    if (!googleClientId) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    const { nonce } = beginOAuthFlow(c);

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
    const validated = validateOAuthState(c, state);
    if (!validated) {
      return c.redirect("/admin/login?error=invalid_state", 302);
    }
    const { returnTo } = validated;

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

    return completeLogin(c, userInfo, returnTo);
  });

  app.get("/admin/auth/okta", (c) => {
    if (!oktaClientId || !oktaIssuer || !oktaClient) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    const { nonce } = beginOAuthFlow(c);

    const authUrl = oktaClient.getAuthorizationUrl({
      clientId: oktaClientId,
      redirectUri: `${appBaseUrl}/admin/auth/okta/callback`,
      state: nonce,
      scope: "openid profile email",
    });

    return c.redirect(authUrl, 302);
  });

  app.get("/admin/auth/okta/callback", async (c) => {
    const { code, state, error: oktaError } = c.req.query();

    // Okta returned an error (e.g. access_denied)
    if (oktaError) {
      const slug =
        oktaError === "access_denied" ? "access_denied" : "auth_failed";
      return c.redirect(`/admin/login?error=${slug}`, 302);
    }

    // CSRF: validate state nonce. The oauth_state cookie is JSON: {nonce, returnTo?}.
    const validated = validateOAuthState(c, state);
    if (!validated) {
      return c.redirect("/admin/login?error=invalid_state", 302);
    }
    const { returnTo } = validated;

    if (!oktaClientId || !oktaClientSecret || !oktaIssuer || !oktaClient) {
      return c.redirect("/admin/login?error=server_error", 302);
    }

    if (!code) {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Exchange authorization code for tokens
    let accessToken: string;
    try {
      const tokens = await oktaClient.exchangeCode({
        code,
        clientId: oktaClientId,
        clientSecret: oktaClientSecret,
        redirectUri: `${appBaseUrl}/admin/auth/okta/callback`,
      });
      accessToken = tokens.accessToken;
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    // Fetch user info from Okta
    let userInfo: {
      sub: string;
      email?: string;
      email_verified?: boolean;
      name: string;
      picture?: string;
    };
    try {
      userInfo = await oktaClient.getUserInfo(accessToken);
    } catch {
      return c.redirect("/admin/login?error=auth_failed", 302);
    }

    return completeLogin(c, userInfo, returnTo);
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

  // Access-scoping shared by the agents list and the /admin/queue-activity
  // default-agent redirect: admins see the full fleet, non-admins see only
  // the agents they have an AgentMember row for. No ordering/ranking beyond
  // whatever agentService.listAll()/listByIds() already returns.
  async function resolveAccessibleAgents(
    userEmail: string,
    isAdmin: boolean,
  ): Promise<Awaited<ReturnType<typeof agentService.listAll>>> {
    if (isAdmin) {
      return agentService.listAll();
    }
    const memberships = await agentMemberService.listByEmail(
      userEmail.toLowerCase(),
    );
    const agentIds = memberships.map((m) => m.agentId);
    return agentService.listByIds(agentIds);
  }

  app.get("/admin/agents", requireAuth, async (c) => {
    const agents = await resolveAccessibleAgents(
      c.var.userEmail,
      c.var.isAdmin,
    );
    const successMsg =
      c.req.query("success") === "deleted" ? "Agent deleted." : undefined;
    // Surfaced by POST /admin/agents/:id/delete after a successful
    // deleteAgentFully() call — operator-facing reminders that would
    // otherwise be silently dropped on the redirect to this list.
    const manualStepsRaw = c.req.query("manualSteps");
    let manualSteps: ManualStep[] | undefined;
    if (manualStepsRaw) {
      try {
        const parsed = JSON.parse(manualStepsRaw);
        if (Array.isArray(parsed)) manualSteps = parsed;
      } catch {
        // malformed/tampered query param — render without the panel
      }
    }
    return html(
      renderAgentsPage(agents, c.var.userEmail, c.var.isAdmin, timezone, {
        successMsg,
        manualSteps,
      }),
    );
  });

  // ─── Default-agent queue-activity redirect (AXR-3.3) ─────────────────────
  // Top-level entry point into GET /admin/agents/:id/queue-activity: resolve
  // the caller's accessible agents with the same scoping as /admin/agents
  // above, then jump straight to the first one's queue-activity page. Zero
  // accessible agents falls back to the agents list rather than erroring.

  app.get("/admin/queue-activity", requireAuth, async (c) => {
    const agents = await resolveAccessibleAgents(
      c.var.userEmail,
      c.var.isAdmin,
    );
    const firstAgent = agents[0];
    if (!firstAgent) {
      return c.redirect("/admin/agents", 302);
    }
    return c.redirect(`/admin/agents/${firstAgent.id}/queue-activity`, 302);
  });

  // ─── Agent detail ─────────────────────────────────────────────────────────

  async function assertAgentAccess(
    agentId: string,
    userEmail: string,
    isAdmin: boolean,
  ): Promise<boolean> {
    if (isAdmin) return true;
    return agentMemberService.exists(agentId, userEmail.toLowerCase());
  }

  const ERROR_MESSAGES: Record<string, string> = {
    missing_fields: "Required fields are missing.",
    create_failed: "Failed to create — please try again.",
    invalid_schedule: "Invalid cron schedule expression.",
    invalid_target:
      "Invalid delivery target — set channel or user (or enable silent mode).",
    invalid_repo_format:
      "Repo must be in org/repo format (e.g. my-org/my-repo).",
    invalid_author_allowlist_format:
      "Author allowlist entries must be valid GitHub logins.",
    invalid_type: "Select a valid agent type.",
    provisioning_disabled:
      "In-cluster provisioning is not enabled on this admin service — create a self-hosted agent instead.",
    provision_failed:
      "Failed to provision the agent's cluster resources — the agent was not created.",
  };

  // ─── New agent form (MUST be before /:id to avoid "new" being captured as param)

  app.get("/admin/agents/new", requireAuth, (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const rawError = c.req.query("error") ?? undefined;
    const error = rawError ? (ERROR_MESSAGES[rawError] ?? rawError) : undefined;
    const types = agentTypeRegistry.listTypes();
    return html(
      renderNewLocalAgentPage(c.var.userEmail, types, {
        error,
        canProvision: provisioner.canProvision,
      }),
    );
  });

  // ─── Create agent (self-hosted or provisioned in-cluster) ────────────────

  app.post("/admin/agents", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    let name: string | undefined;
    let typeName: string | undefined;
    let reposRaw: string | undefined;
    let authorAllowlistRaw: string | undefined;
    let patchAuthorAllowlistRaw: string | undefined;
    let memberEmailsRaw: string | undefined;
    let restrictSlackToMembersRaw: string | undefined;
    let runtime: string | undefined;
    let claudeCodeOauthToken: string | undefined;
    let anthropicApiKey: string | undefined;
    let connectSlackRaw: string | undefined;
    let xoxpToken: string | undefined;
    let ghAuthMode: string | undefined;
    let ghPat: string | undefined;
    let githubOrg: string | undefined;
    let ghAppMode: string | undefined;
    let ghAppId: string | undefined;
    let ghAppInstallationId: string | undefined;
    let ghAppPrivateKey: string | undefined;
    try {
      const formData = await c.req.formData();
      name = formData.get("name")?.toString()?.trim();
      typeName = formData.get("type")?.toString()?.trim();
      reposRaw = formData.get("repos")?.toString()?.trim();
      authorAllowlistRaw = formData.get("authorAllowlist")?.toString()?.trim();
      patchAuthorAllowlistRaw = formData
        .get("patchAuthorAllowlist")
        ?.toString()
        ?.trim();
      memberEmailsRaw = formData.get("memberEmails")?.toString()?.trim();
      restrictSlackToMembersRaw = formData
        .get("restrictSlackToMembers")
        ?.toString();
      runtime = formData.get("runtime")?.toString()?.trim();
      claudeCodeOauthToken = formData
        .get("claudeCodeOauthToken")
        ?.toString()
        ?.trim();
      anthropicApiKey = formData.get("anthropicApiKey")?.toString()?.trim();
      connectSlackRaw = formData.get("connectSlack")?.toString();
      xoxpToken = formData.get("xoxpToken")?.toString();
      ghAuthMode = formData.get("ghAuthMode")?.toString()?.trim();
      ghPat = formData.get("ghPat")?.toString();
      githubOrg = formData.get("githubOrg")?.toString()?.trim();
      ghAppMode = formData.get("ghAppMode")?.toString()?.trim();
      ghAppId = formData.get("ghAppId")?.toString();
      ghAppInstallationId = formData.get("ghAppInstallationId")?.toString();
      // UAP-5.3: the "Use existing GitHub App" option submits the private
      // key as a file upload rather than pasted text — read its contents
      // server-side, mirroring the per-agent connect-github route.
      const ghAppPrivateKeyFile = formData.get("ghAppPrivateKeyFile");
      ghAppPrivateKey =
        ghAppPrivateKeyFile instanceof File
          ? await ghAppPrivateKeyFile.text()
          : undefined;
    } catch {
      return c.redirect("/admin/agents/new", 302);
    }
    const connectSlack = connectSlackRaw === "true";
    if (!name) {
      return c.redirect("/admin/agents/new?error=missing_fields", 302);
    }
    // Resolve the requested type BEFORE creating any row — an unknown/missing
    // type must redirect with zero rows created, mirroring the tryGetManifest
    // validation POST /agents already does in agents-api.ts.
    if (!typeName || !agentTypeRegistry.tryGetManifest(typeName)) {
      return c.redirect("/admin/agents/new?error=invalid_type", 302);
    }
    // Absent/unrecognized runtime means self-hosted — the historical behavior of
    // this form, and what `task stack` depends on.
    const inCluster = runtime === "in-cluster";
    // Same "validate before creating any row" rule as the type check above: a
    // no-op provisioner would let provision() succeed while creating nothing,
    // leaving an agent row with no workload behind it.
    if (inCluster && !provisioner.canProvision) {
      return c.redirect("/admin/agents/new?error=provisioning_disabled", 302);
    }
    const restrictSlackToMembers = restrictSlackToMembersRaw === "true";
    const agent = await agentService.create({
      name,
      selfHosted: !inCluster,
      typeName,
      restrictSlackToMembers,
    });
    // Attach repos if provided
    if (reposRaw) {
      const repos = reposRaw
        .split(/\r?\n/)
        .map((r) => r.trim())
        .filter((r) => r.length > 0);
      const invalid = repos.filter((r) => !isOrgRepo(r));
      if (invalid.length > 0) {
        await agentService.delete(agent.id);
        return c.redirect("/admin/agents/new?error=invalid_repo_format", 302);
      }
      if (repos.length > 0) {
        await agentService.updateFields(agent.id, { repos });
      }
    }
    // Attach authorAllowlist if provided
    if (authorAllowlistRaw) {
      const authorAllowlist = [
        ...new Set(
          authorAllowlistRaw
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        ),
      ];
      const invalid = authorAllowlist.filter((l) => !isGithubLogin(l));
      if (invalid.length > 0) {
        await agentService.delete(agent.id);
        return c.redirect(
          "/admin/agents/new?error=invalid_author_allowlist_format",
          302,
        );
      }
      if (authorAllowlist.length > 0) {
        await agentService.updateFields(agent.id, {
          reviewAuthorAllowlist: authorAllowlist,
        });
      }
    }
    // Attach patchAuthorAllowlist if provided
    if (patchAuthorAllowlistRaw) {
      const patchAuthorAllowlist = [
        ...new Set(
          patchAuthorAllowlistRaw
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0),
        ),
      ];
      const invalid = patchAuthorAllowlist.filter((l) => !isGithubLogin(l));
      if (invalid.length > 0) {
        await agentService.delete(agent.id);
        return c.redirect(
          "/admin/agents/new?error=invalid_author_allowlist_format",
          302,
        );
      }
      if (patchAuthorAllowlist.length > 0) {
        await agentService.updateFields(agent.id, {
          patchAuthorAllowlist,
        });
      }
    }
    // Attach member emails if provided — best-effort, mirrors the single-add
    // POST /admin/agents/:id/members route: no format validation, and a
    // failed/duplicate add is silently ignored rather than rolling back the
    // agent. Runs before redirectWithMembersWarning below so freshly-added
    // members are already visible to its zero-members check.
    if (memberEmailsRaw) {
      const memberEmails = [
        ...new Set(
          memberEmailsRaw
            .split(/\r?\n/)
            .map((l) => l.trim().toLowerCase())
            .filter((l) => l.length > 0),
        ),
      ];
      for (const email of memberEmails) {
        try {
          await agentMemberService.add(agent.id, email);
        } catch {
          // unique constraint violation — already a member, ignore
        }
      }
    }
    // Store the Claude credentials before provisioning so the pod comes up
    // with them already in its env bundle rather than failing its first
    // turn. Both fields (if supplied) go through a single patch call, mirroring
    // the provision wizard's AI-credentials fieldset.
    const claudeEnv: Record<string, string> = {};
    if (claudeCodeOauthToken) {
      claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = claudeCodeOauthToken;
    }
    if (anthropicApiKey) {
      claudeEnv.ANTHROPIC_API_KEY = anthropicApiKey;
    }
    if (Object.keys(claudeEnv).length > 0) {
      await agentEnvService.patch(
        agent.id,
        claudeEnv,
        new Set(SECRET_ENV_VARS),
      );
    }
    if (inCluster) {
      // Roll the row back on failure so a retry with the same name doesn't
      // collide with a half-created agent.
      try {
        await provisioner.provision(agent.id, { slug: agent.name });
      } catch (err) {
        console.error("[admin-ui] provisioning failed, rolling back:", err);
        await agentService.delete(agent.id).catch((cleanupErr) => {
          console.error(
            "[admin-ui] failed to roll back agent after provision error:",
            cleanupErr,
          );
        });
        return c.redirect("/admin/agents/new?error=provision_failed", 302);
      }
    }
    // Best-effort, mirroring the same call at agent boot (agent/src/index.ts).
    // reconcileSystemCrons is a full three-pass reconcile, so a second run is a
    // no-op — and failing here would strand the operator next to a live agent.
    try {
      await agentCronJobService.reconcileSystemCrons(agent.id);
    } catch (err) {
      console.error("[admin-ui] failed to seed system crons (non-fatal):", err);
    }

    // ─── UAP-2.1: inline Slack/GitHub connect branches ─────────────────────
    // The agent row already exists at this point, so any failure below
    // redirects to the agent DETAIL page with an error — never rolls back
    // the agent (mirrors how the standalone connect-slack/connect-github
    // routes behave against an already-existing agent).
    //
    // Slack's OAuth flow is an external browser redirect, so at most one of
    // Slack/GitHub can produce the final HTTP response. When both are
    // requested, GitHub's storage/redirect-prep runs first (PAT storage is
    // synchronous; the App-manifest flow can't run before Slack's redirect
    // either, so it's skipped when Slack is also requested) so GH_TOKEN is
    // already in place by the time the user lands back from Slack's OAuth
    // callback — then Slack's redirect is returned last.
    //
    // UAP-5.1: this whole block only applies to in-cluster agents. Self-hosted
    // agents use local git config for GitHub auth, not admin-managed
    // provisioning, so Slack/GitHub connect must never run for them — even if
    // connectSlack/ghAuthMode were submitted via a raw POST bypassing the UI
    // (the New Agent form hides these sections for self-hosted, but that's
    // client-side only).
    if (inCluster) {
      let ghPatResult:
        | Awaited<ReturnType<typeof githubProvisioningService.startPatConnect>>
        | undefined;
      if (ghAuthMode === "pat") {
        ghPatResult = await githubProvisioningService.startPatConnect(
          agent.id,
          ghPat,
        );
        if (!ghPatResult.ok && !connectSlack) {
          return c.redirect(
            `/admin/agents/${agent.id}?error=${encodeURIComponent(ghPatResult.error)}`,
            302,
          );
        }
        if (!ghPatResult.ok) {
          console.error(
            "[admin-ui] GitHub PAT storage failed during combined Slack+GitHub connect:",
            ghPatResult.error,
          );
        }
      }

      if (connectSlack) {
        const redirectUri = `${appBaseUrl}/admin/agents/${agent.id}/connect-slack/callback`;
        // Carry a failed-PAT-storage warning (UAP-2.1) through Slack's OAuth
        // round trip via the signed provision-state cookie so it resurfaces on
        // the post-callback landing page. Without this, a GitHub PAT that failed
        // to store above would be silently swallowed and the operator misled
        // into believing GH_TOKEN was connected.
        const ghConnectError =
          ghPatResult && !ghPatResult.ok ? ghPatResult.error : undefined;
        const slackResult = await slackProvisioningService.startConnect(
          agent.id,
          xoxpToken,
          redirectUri,
          ghConnectError,
        );
        if (!slackResult.ok) {
          return c.redirect(
            `/admin/agents/${agent.id}?error=${encodeURIComponent(slackResult.error)}`,
            302,
          );
        }
        setCookie(c, PROVISION_STATE_COOKIE, slackResult.provisionStateToken, {
          httpOnly: true,
          maxAge: PROVISION_STATE_TTL_SECONDS,
          sameSite: "Lax",
          path: "/",
          secure: appBaseUrl.startsWith("https://"),
        });
        return c.redirect(slackResult.oauthRedirectUrl, 302);
      }

      if (ghAuthMode === "app" && ghAppMode === "manual") {
        // UAP-5.3: "Use existing GitHub App" — validates and persists
        // GH_APP_ID/GH_APP_INSTALLATION_ID/GH_APP_PRIVATE_KEY directly, no
        // GitHub API call. On success falls through to the shared
        // redirectWithMembersWarning below, matching the ghAuthMode=pat
        // branch's success path.
        const manualResult =
          await githubProvisioningService.startAppManualConnect(agent.id, {
            ghAppId,
            ghAppInstallationId,
            ghAppPrivateKey,
          });
        if (!manualResult.ok) {
          return c.redirect(
            `/admin/agents/${agent.id}?error=${encodeURIComponent(manualResult.error)}`,
            302,
          );
        }
      } else if (ghAuthMode === "app") {
        const appResult = await githubProvisioningService.startAppAutoConnect(
          agent.id,
          githubOrg,
          {
            redirectUri: `${appBaseUrl}/admin/agents/${agent.id}/connect-github/callback`,
            setupUrl: `${appBaseUrl}/admin/agents/${agent.id}/connect-github/installed`,
          },
        );
        if (!appResult.ok) {
          return c.redirect(
            `/admin/agents/${agent.id}?error=${encodeURIComponent(appResult.error)}`,
            302,
          );
        }
        setCookie(
          c,
          GITHUB_PROVISION_STATE_COOKIE,
          appResult.provisionStateToken,
          {
            httpOnly: true,
            maxAge: GITHUB_PROVISION_STATE_TTL_SECONDS,
            sameSite: "Lax",
            path: "/",
            secure: appBaseUrl.startsWith("https://"),
          },
        );
        return c.html(
          renderGithubAppManifestRedirectPage(c.var.userEmail, {
            githubOrg: appResult.githubOrg,
            manifest: appResult.manifest,
          }),
        );
      }
    }

    return redirectWithMembersWarning(
      c,
      agentMemberService,
      agent.id,
      restrictSlackToMembers,
    );
  });

  app.get("/admin/agents/:id", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const agent = await agentService.getDetail(agentId);
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
      authorAllowlist: agent.reviewAuthorAllowlist,
      patchAuthorAllowlist: agent.patchAuthorAllowlist,
      restrictSlackToMembers: agent.restrictSlackToMembers,
      typeName: agent.typeName,
      missingRequiredEnv: agent.missingRequiredEnv,
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
    const warningParam = c.req.query("warning");
    const warning =
      warningParam === "restrict_slack_no_members"
        ? "This agent has no members — enabling restrictSlackToMembers will block all Slack senders."
        : // Free-form warning text (e.g. UAP-2.1's combined-flow GitHub PAT
          // failure carried through the Slack OAuth round trip). Passed through
          // verbatim rather than mapped to a fixed key.
          (warningParam ?? undefined);

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
          ? agentMemberService.listByAgentId(agentId)
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
        { error, newToken, successMsg, warning, timezone },
      ),
    );
  });

  app.get("/admin/agents/:id/queue-activity", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    const agent = await agentService.getDetail(agentId);
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }

    const cronId = c.req.query("cronId") || undefined;
    const outcome = c.req.query("outcome") || undefined;
    const pageRaw = c.req.query("page");
    const page = pageRaw ? Math.max(1, Number.parseInt(pageRaw, 10) || 1) : 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const [snapshot, crons, runResult, accessibleAgents] = await Promise.all([
      agentWorkQueueService.get(agentId),
      agentCronJobService.list(agentId),
      agentCronRunService.listForAgent(agentId, {
        cronId,
        outcome,
        limit,
        offset,
      }),
      resolveAccessibleAgents(c.var.userEmail, c.var.isAdmin),
    ]);

    return html(
      renderQueueActivityPage({
        agent: { id: agent.id, name: agent.name },
        agents: accessibleAgents.map((a) => ({ id: a.id, name: a.name })),
        snapshot: snapshot
          ? {
              computedAt: snapshot.computedAt,
              items: snapshot.items as unknown as WorkQueueItem[],
            }
          : null,
        crons: crons.map((cr) => ({
          id: cr.id,
          name: cr.name,
          schedule: cr.schedule,
        })),
        runs: runResult.items,
        filters: { cronId, outcome },
        pagination: { total: runResult.total, limit, page },
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
    const agent = await agentService.getDetail(agentId);
    if (!agent) {
      return new Response("Agent not found", { status: 404 });
    }
    const existing = agent.repos ?? [];
    const deduped = existing.includes(repo) ? existing : [...existing, repo];
    await agentService.updateFields(agentId, { repos: deduped });
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
      const agent = await agentService.getDetail(agentId);
      if (!agent) {
        return new Response("Agent not found", { status: 404 });
      }
      const updated = (agent.repos ?? []).filter((r) => r !== repo);
      await agentService.updateFields(agentId, { repos: updated });
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Author allowlist (review) mutations ───────────────────────────────────

  app.post(
    "/admin/agents/:id/review-author-allowlist/add",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      let login: string | undefined;
      try {
        const formData = await c.req.formData();
        login = formData.get("login")?.toString()?.trim();
      } catch {
        return c.redirect(`/admin/agents/${agentId}`, 302);
      }
      if (!login || !isGithubLogin(login)) {
        return c.redirect(
          `/admin/agents/${agentId}?error=invalid_author_allowlist_format`,
          302,
        );
      }
      const agent = await agentService.getDetail(agentId);
      if (!agent) {
        return new Response("Agent not found", { status: 404 });
      }
      const existing = agent.reviewAuthorAllowlist ?? [];
      const deduped = existing.includes(login)
        ? existing
        : [...existing, login];
      await agentService.updateFields(agentId, {
        reviewAuthorAllowlist: deduped,
      });
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  app.post(
    "/admin/agents/:id/review-author-allowlist/delete",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      let login: string | undefined;
      try {
        const formData = await c.req.formData();
        login = formData.get("login")?.toString()?.trim();
      } catch {
        return c.redirect(`/admin/agents/${agentId}`, 302);
      }
      if (login) {
        const agent = await agentService.getDetail(agentId);
        if (!agent) {
          return new Response("Agent not found", { status: 404 });
        }
        const updated = (agent.reviewAuthorAllowlist ?? []).filter(
          (l) => l !== login,
        );
        await agentService.updateFields(agentId, {
          reviewAuthorAllowlist: updated,
        });
      }
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  // ─── Author allowlist (patch) mutations ────────────────────────────────────

  app.post(
    "/admin/agents/:id/patch-author-allowlist/add",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      let login: string | undefined;
      try {
        const formData = await c.req.formData();
        login = formData.get("login")?.toString()?.trim();
      } catch {
        return c.redirect(`/admin/agents/${agentId}`, 302);
      }
      if (!login || !isGithubLogin(login)) {
        return c.redirect(
          `/admin/agents/${agentId}?error=invalid_author_allowlist_format`,
          302,
        );
      }
      const agent = await agentService.getDetail(agentId);
      if (!agent) {
        return new Response("Agent not found", { status: 404 });
      }
      const existing = agent.patchAuthorAllowlist ?? [];
      const deduped = existing.includes(login)
        ? existing
        : [...existing, login];
      await agentService.updateFields(agentId, {
        patchAuthorAllowlist: deduped,
      });
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  app.post(
    "/admin/agents/:id/patch-author-allowlist/delete",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      let login: string | undefined;
      try {
        const formData = await c.req.formData();
        login = formData.get("login")?.toString()?.trim();
      } catch {
        return c.redirect(`/admin/agents/${agentId}`, 302);
      }
      if (login) {
        const agent = await agentService.getDetail(agentId);
        if (!agent) {
          return new Response("Agent not found", { status: 404 });
        }
        const updated = (agent.patchAuthorAllowlist ?? []).filter(
          (l) => l !== login,
        );
        await agentService.updateFields(agentId, {
          patchAuthorAllowlist: updated,
        });
      }
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  // ─── Slack access settings (restrictSlackToMembers) ────────────────────────

  app.post("/admin/agents/:id/settings", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const agentId = c.req.param("id");
    let restrictSlackToMembersRaw: string | undefined;
    try {
      const formData = await c.req.formData();
      restrictSlackToMembersRaw = formData
        .get("restrictSlackToMembers")
        ?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}`, 302);
    }
    const restrictSlackToMembers = restrictSlackToMembersRaw === "true";
    const agent = await agentService.updateFields(agentId, {
      restrictSlackToMembers,
    });
    return redirectWithMembersWarning(
      c,
      agentMemberService,
      agent.id,
      restrictSlackToMembers,
    );
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
    const agent = await agentService.getDetail(agentId);
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
      authorAllowlist: agent.reviewAuthorAllowlist,
      patchAuthorAllowlist: agent.patchAuthorAllowlist,
      restrictSlackToMembers: agent.restrictSlackToMembers,
      typeName: agent.typeName,
      missingRequiredEnv: agent.missingRequiredEnv,
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
            ? agentMemberService.listByAgentId(agentId)
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
  // PROVISION_STATE_COOKIE / PROVISION_STATE_TTL_SECONDS now live in
  // slack-provisioning-service.ts (UAP-1.1); GITHUB_PROVISION_STATE_COOKIE /
  // GITHUB_PROVISION_STATE_TTL_SECONDS / GITHUB_ORG_PATTERN now live in
  // github-provisioning-service.ts (UAP-1.2) — re-imported above so every
  // route in this file keeps using the same names.

  // ─── Manifest sync ────────────────────────────────────────────────────────

  app.post("/admin/agents/:id/sync-manifest", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    const agent = await agentService.getDetail(agentId);
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
      const redirectUri = `${appBaseUrl}/admin/agents/${agentId}/connect-slack/callback`;
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
      // Sign a provision-state cookie so the connect-slack callback can exchange the code
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
      const redirectUri = `${appBaseUrl}/admin/agents/${agentId}/connect-slack/callback`;
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

  // ─── connect-slack (UAP-1.1) ───────────────────────────────────────────────
  // Per-agent equivalents of the legacy /admin/provision/* Slack wizard,
  // scoped to an already-existing agent id. All three delegate to the same
  // SlackProvisioningService the wizard now calls — pure routing/rendering
  // here, no business logic.

  app.post("/admin/agents/:id/connect-slack", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }

    let xoxpToken: string | undefined;
    try {
      const formData = await c.req.formData();
      xoxpToken = formData.get("xoxpToken")?.toString();
    } catch {
      return c.redirect(`/admin/agents/${agentId}?error=missing_fields`, 302);
    }

    const result = await slackProvisioningService.startConnect(
      agentId,
      xoxpToken,
      `${appBaseUrl}/admin/agents/${agentId}/connect-slack/callback`,
    );

    if (!result.ok) {
      return c.redirect(
        `/admin/agents/${agentId}?error=${encodeURIComponent(result.error)}`,
        302,
      );
    }

    setCookie(c, PROVISION_STATE_COOKIE, result.provisionStateToken, {
      httpOnly: true,
      maxAge: PROVISION_STATE_TTL_SECONDS,
      sameSite: "Lax",
      path: "/",
      secure: appBaseUrl.startsWith("https://"),
    });

    return c.redirect(result.oauthRedirectUrl, 302);
  });

  app.get(
    "/admin/agents/:id/connect-slack/callback",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      const userEmail = c.var.userEmail;

      const rawStateCookie = getCookie(c, PROVISION_STATE_COOKIE);
      const code = c.req.query("code");
      const result = await slackProvisioningService.completeConnect(
        rawStateCookie,
        code,
        `${appBaseUrl}/admin/agents/${agentId}/connect-slack/callback`,
      );

      if (result.outcome === "invalid_state") {
        deleteCookie(c, PROVISION_STATE_COOKIE);
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      if (result.outcome === "missing_code") {
        // Cookie must remain intact so the user can restart the provision flow.
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // Every other outcome consumed the cookie's OAuth code — clear it now.
      deleteCookie(c, PROVISION_STATE_COOKIE);

      if (result.outcome === "exchange_failed") {
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // A non-fatal GitHub PAT storage failure from the combined create+connect
      // flow (UAP-2.1) rode through Slack's OAuth round trip in the signed
      // cookie — surface it now so the operator isn't misled into believing
      // GH_TOKEN was stored.
      const ghConnectWarning = result.ghConnectError
        ? `GitHub was not connected — storing the PAT failed: ${result.ghConnectError}`
        : undefined;

      if (result.outcome === "reinstalled") {
        const query = ghConnectWarning
          ? `?success=reinstalled&warning=${encodeURIComponent(ghConnectWarning)}`
          : "?success=reinstalled";
        return c.redirect(`/admin/agents/${result.agentId}${query}`, 302);
      }

      // result.outcome === "needs_app_token"
      return html(
        renderProvisionXappTokenPage(userEmail, {
          agentId: result.agentId,
          warning: ghConnectWarning,
        }),
      );
    },
  );

  app.post(
    "/admin/agents/:id/connect-slack/app-token",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      const userEmail = c.var.userEmail;

      let xappToken: string | undefined;
      try {
        const formData = await c.req.formData();
        xappToken = formData.get("xappToken")?.toString();
      } catch {
        return html(
          renderProvisionXappTokenPage(userEmail, {
            agentId,
            error: "Invalid form submission.",
          }),
        );
      }

      const result = await slackProvisioningService.saveAppToken(
        agentId,
        xappToken,
      );

      if (!result.ok) {
        return html(
          renderProvisionXappTokenPage(userEmail, {
            agentId: result.agentId,
            error: result.error,
          }),
        );
      }

      return html(
        renderProvisionCompletePage(userEmail, {
          success: true,
          agentId: result.agentId,
        }),
      );
    },
  );

  // ─── connect-github (UAP-1.2) ───────────────────────────────────────────────
  // Per-agent equivalents of the legacy /admin/provision/* GitHub App/PAT
  // wizard branches, scoped to an already-existing agent id. All three
  // delegate to the same GithubProvisioningService the wizard now calls —
  // pure routing/rendering here, no business logic. Supports all three modes
  // selected via `ghAuthMode`/`ghAppMode` form fields, mirroring the legacy
  // wizard's form shape: pat, app+manual, app+auto.

  app.post("/admin/agents/:id/connect-github", requireAuth, async (c) => {
    const agentId = c.req.param("id");
    if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
      return new Response("Forbidden", { status: 403 });
    }
    const userEmail = c.var.userEmail;

    let ghAuthMode: string | undefined;
    let ghPat: string | undefined;
    let ghAppMode: string | undefined;
    let ghAppId: string | undefined;
    let ghAppInstallationId: string | undefined;
    let ghAppPrivateKey: string | undefined;
    let githubOrg: string | undefined;
    try {
      const formData = await c.req.formData();
      ghAuthMode = formData.get("ghAuthMode")?.toString() ?? "pat";
      ghPat = formData.get("ghPat")?.toString();
      ghAppMode = formData.get("ghAppMode")?.toString() ?? "manual";
      ghAppId = formData.get("ghAppId")?.toString();
      ghAppInstallationId = formData.get("ghAppInstallationId")?.toString();
      // The detail page's "Use existing GitHub App" action (UAP-5.4) submits
      // the private key as a file upload rather than pasted text — read its
      // contents server-side. Falls back to a plain ghAppPrivateKey text
      // field for back-compat with any other caller still posting it that
      // way (e.g. API clients).
      const ghAppPrivateKeyFile = formData.get("ghAppPrivateKeyFile");
      ghAppPrivateKey =
        ghAppPrivateKeyFile instanceof File
          ? await ghAppPrivateKeyFile.text()
          : formData.get("ghAppPrivateKey")?.toString();
      githubOrg = formData.get("githubOrg")?.toString()?.trim();
    } catch {
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          agentId,
          error: "Invalid form submission.",
        }),
      );
    }

    if (ghAuthMode === "pat") {
      const result = await githubProvisioningService.startPatConnect(
        agentId,
        ghPat,
      );
      if (!result.ok) {
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            agentId: result.agentId,
            error: result.error,
          }),
        );
      }
      return html(
        renderProvisionCompletePage(userEmail, {
          success: true,
          agentId: result.agentId,
        }),
      );
    }

    if (ghAppMode === "auto") {
      const result = await githubProvisioningService.startAppAutoConnect(
        agentId,
        githubOrg,
        {
          redirectUri: `${appBaseUrl}/admin/agents/${agentId}/connect-github/callback`,
          setupUrl: `${appBaseUrl}/admin/agents/${agentId}/connect-github/installed`,
        },
      );
      if (!result.ok) {
        return html(
          renderProvisionCompletePage(userEmail, {
            success: false,
            agentId,
            error: result.error,
          }),
        );
      }
      setCookie(c, GITHUB_PROVISION_STATE_COOKIE, result.provisionStateToken, {
        httpOnly: true,
        maxAge: GITHUB_PROVISION_STATE_TTL_SECONDS,
        sameSite: "Lax",
        path: "/",
        secure: appBaseUrl.startsWith("https://"),
      });
      // Use c.html() so the Set-Cookie header from setCookie() is included
      return c.html(
        renderGithubAppManifestRedirectPage(userEmail, {
          githubOrg: result.githubOrg,
          manifest: result.manifest,
        }),
      );
    }

    // ghAppMode === "manual" (default)
    const result = await githubProvisioningService.startAppManualConnect(
      agentId,
      { ghAppId, ghAppInstallationId, ghAppPrivateKey },
    );
    if (!result.ok) {
      return html(
        renderProvisionCompletePage(userEmail, {
          success: false,
          agentId: result.agentId,
          error: result.error,
        }),
      );
    }
    return html(
      renderProvisionCompletePage(userEmail, {
        success: true,
        agentId: result.agentId,
      }),
    );
  });

  app.get(
    "/admin/agents/:id/connect-github/callback",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      const userEmail = c.var.userEmail;

      const rawStateCookie = getCookie(c, GITHUB_PROVISION_STATE_COOKIE);
      const code = c.req.query("code");
      const result = await githubProvisioningService.completeConnect(
        rawStateCookie,
        code,
        agentId,
      );

      if (result.outcome === "invalid_state") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      if (result.outcome === "agent_mismatch") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return new Response("Forbidden", { status: 403 });
      }

      if (result.outcome === "missing_code") {
        // Cookie must remain intact so the user can restart the provision flow.
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // Every other outcome consumed the cookie's manifest code — clear it now.
      deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);

      if (result.outcome === "exchange_failed") {
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // result.outcome === "success"
      return html(
        renderGithubAppInstallPage(userEmail, {
          installUrl: result.installUrl,
        }),
      );
    },
  );

  app.get(
    "/admin/agents/:id/connect-github/installed",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      const userEmail = c.var.userEmail;

      const rawStateCookie = getCookie(c, GITHUB_PROVISION_STATE_COOKIE);
      const installationId = c.req.query("installation_id");
      const result = await githubProvisioningService.completeInstalled(
        rawStateCookie,
        installationId,
        agentId,
      );

      if (result.outcome === "invalid_state") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      if (result.outcome === "agent_mismatch") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return new Response("Forbidden", { status: 403 });
      }

      if (result.outcome === "invalid_installation_id") {
        deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
        return html(
          renderGithubAppInstalledPage(userEmail, {
            success: false,
            error: result.error,
          }),
        );
      }

      // result.outcome === "success"
      deleteCookie(c, GITHUB_PROVISION_STATE_COOKIE);
      return html(renderGithubAppInstalledPage(userEmail, { success: true }));
    },
  );

  // ─── Provisioning flow ────────────────────────────────────────────────────

  app.get("/admin/provision", (c) => c.redirect("/admin/agents/new", 302));

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
        await agentMemberService.add(agentId, email);
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
        await agentMemberService.remove(agentId, memberId);
      } catch {
        // already gone, ignore
      }
    }
    return c.redirect(`/admin/agents/${agentId}`, 302);
  });

  // ─── Tasks page ───────────────────────────────────────────────────────────

  app.get("/admin/tasks", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    // AXR-1.3: the board is the default layout; ?view=table opts back into
    // the pre-redesign dense table (any other/absent value falls back to
    // the board, matching AC1's "defaults to board" requirement).
    const view: "board" | "table" =
      c.req.query("view") === "table" ? "table" : "board";
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
    // c.req.query("repo") only returns the first value when the query string
    // repeats the key (?repo=a&repo=b) — use queries() to get all values, so
    // both a bookmarked single-value URL and a multiselect submission with
    // several selections round-trip correctly.
    const repo = c.req.queries("repo");
    const org = c.req.queries("org");
    const source = c.req.query("source") ?? undefined;
    const agent = c.req.query("agent") ?? undefined;
    const hitlRaw = c.req.query("hitl");
    const hitl: "true" | "false" | undefined =
      hitlRaw === "true" || hitlRaw === "false" ? hitlRaw : undefined;
    const error = c.req.query("error") ?? undefined;
    const pageRaw = c.req.query("page");
    const page = pageRaw ? Math.max(1, Number.parseInt(pageRaw, 10) || 1) : 1;
    // TBC-2.1: the default board view scopes its outbound query to the
    // active (non-closed) statuses and raises the cap from 50 to 200, since
    // Claimed/Done tasks (which churn fastest) no longer share the same
    // top-N-by-recency window as Queued/In Progress/Blocked-HITL. ?view=table
    // is untouched — same limit, same state/status behavior as before.
    const limit = view === "board" ? BOARD_TASK_LIMIT : 50;
    const offset = (page - 1) * limit;

    // When filtering by agent name, resolve matching IDs upfront so we can
    // filter tasks client-side (task store only supports a single assignee ID).
    let agentFilterIds: Set<string> | null = null;
    if (agent) {
      const matched = await agentService.searchByName(agent);
      agentFilterIds = new Set(matched.map((a) => a.id));
    }

    let tasks: TaskItem[] = [];
    let total = 0;
    let degraded = false;
    let distinctValues: {
      sessions: string[];
      repos: string[];
      orgs: string[];
    } | null = null;

    if (!fetchTaskStoreTasks) {
      degraded = true;
    } else {
      const params = new URLSearchParams();
      if (status) {
        params.set("status", status);
      } else if (state) {
        params.set("state", state);
      } else if (view === "board") {
        // TBC-2.1: with no explicit status/state filter, the default board
        // query excludes the fully-closed statuses (merged/done/deploying/
        // deployed/cancelled) so Done tasks never crowd out the shared
        // recency window. This can't exclude "claimed" specifically at the
        // query level — claimed and queued share the same "pending" status,
        // distinguished only by claimedBy — so Claimed is dropped purely by
        // no longer being a rendered TASK_BOARD_COLUMNS entry.
        params.set("state", "open");
      }
      if (session) params.set("session", session);
      for (const r of repo ?? []) params.append("repo", r);
      for (const o of org ?? []) params.append("org", o);
      if (source) params.set("source", source);
      if (hitl) params.set("hitl", hitl);
      // Agent-name filtering is done client-side, so we fetch a larger slice
      // when an agent filter is active to avoid under-counting across pages.
      params.set("limit", agentFilterIds !== null ? "500" : String(limit));
      params.set("offset", agentFilterIds !== null ? "0" : String(offset));
      params.set("sort", "desc");
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
      const agents = await agentService.listByIds(agentIds);
      for (const a of agents) agentNames[a.id] = a.name;
    }

    // Resolve each task's linked PR via a live GET /prs?repo=&prNumber=
    // lookup, one request per distinct (repo, pr) pair on this page of
    // tasks, run in parallel to avoid an N+1 sequential-await chain — same
    // pattern as GET /admin/prs's linkedTasksByPr join, and the single-task
    // version at GET /admin/tasks/:id, just batched (AXR-1.2). Falls back to
    // no PR data per row if the fetcher is absent, a task has no repo/pr, or
    // a lookup throws — a failed join never breaks the page.
    const prsByTaskId: Record<string, PrListItem> = {};
    if (fetchTaskStorePrs && tasks.length > 0) {
      const distinctPairs = new Map<string, { repo: string; pr: number }>();
      for (const t of tasks) {
        if (t.repo && t.pr) {
          distinctPairs.set(`${t.repo}#${t.pr}`, { repo: t.repo, pr: t.pr });
        }
      }
      if (distinctPairs.size > 0) {
        const pairResults = await Promise.all(
          [...distinctPairs.entries()].map(
            async ([key, { repo: r, pr: p }]): Promise<
              [string, PrListItem | undefined]
            > => {
              try {
                const result = await fetchTaskStorePrs(
                  new URLSearchParams({ repo: r, prNumber: String(p) }),
                );
                return [key, result.prs[0]];
              } catch {
                return [key, undefined];
              }
            },
          ),
        );
        const prsByPairKey = new Map(pairResults);
        for (const t of tasks) {
          if (t.repo && t.pr) {
            const pr = prsByPairKey.get(`${t.repo}#${t.pr}`);
            if (pr) prsByTaskId[t.id] = pr;
          }
        }
      }
    }

    // Build suggestions for autocomplete datalists only when task-store integration is active.
    // Skip the DB query entirely when fetchDistinctTaskValues is not configured.
    const suggestions =
      fetchDistinctTaskValues && distinctValues
        ? {
            sessions: distinctValues.sessions,
            repos: distinctValues.repos,
            orgs: distinctValues.orgs,
            agents: (await agentService.listOptions()).map((a) => a.name),
          }
        : undefined;

    return html(
      renderTasksPage(
        tasks,
        { status, state, session, repo, org, source, agent, hitl },
        degraded,
        c.var.userEmail,
        agentNames,
        { total, limit, page },
        {
          ...(error ? { error } : {}),
          agentFilterActive: agentFilterIds !== null,
        },
        suggestions,
        false,
        timezone,
        prsByTaskId,
        view,
        new Date(),
      ),
    );
  });

  app.get("/admin/tasks/:id", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const taskId = c.req.param("id");
    const backHref = resolveTaskDetailBackHref(c.req.query("from"));
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
      const agents = await agentService.listByIds(agentIds);
      for (const a of agents) agentNames[a.id] = a.name;
    }

    // Fetch linked pull request via a live repo+prNumber lookup — failure,
    // absence of the fetcher, or the task missing repo/pr renders the page
    // without a PR section.
    let pullRequest: PullRequestItem | undefined;
    if (fetchTaskStorePrs && task.repo && task.pr) {
      try {
        const result = await fetchTaskStorePrs(
          new URLSearchParams({ repo: task.repo, prNumber: String(task.pr) }),
        );
        pullRequest = result.prs[0];
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
        backHref,
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
    // TBF-1.1: the table row's Release button carries the list view it was
    // clicked from (e.g. ?view=table&...) as `from`, so the Task Detail page
    // we land on can hand it straight back to its own "← Tasks" link via
    // resolveTaskDetailBackHref — otherwise that link falls back to bare
    // /admin/tasks, which is the board (AXR-1.3), bouncing the user off the
    // table view they released the task from. Reuse the same allowlist
    // pattern so an unlisted `from` value can't become an open redirect.
    const fromParam = c.req.query("from");
    const validFrom =
      fromParam && TASK_LIST_BACK_HREF_PATTERN.test(fromParam)
        ? fromParam
        : undefined;
    if (!fetchTaskStoreTask) return c.redirect("/admin/tasks", 302);
    return c.redirect(
      validFrom
        ? `/admin/tasks/${taskId}?from=${encodeURIComponent(validFrom)}`
        : `/admin/tasks/${taskId}`,
      302,
    );
  });

  // ─── Session detail ───────────────────────────────────────────────────────

  app.get("/admin/sessions/:id", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const sessionId = c.req.param("id");
    const backHref = resolveSessionDetailBackHref(c.req.query("from"));

    let tasks: TaskItem[] = [];
    let degraded = false;

    if (!fetchTaskStoreTasks) {
      degraded = true;
    } else {
      const params = new URLSearchParams();
      params.set("session", sessionId);
      // Fetch ALL tasks for the session, not one page — sessions are typically
      // a handful of tasks, well under this ceiling.
      params.set("limit", "500");
      params.set("offset", "0");
      params.set("sort", "desc");
      try {
        const result = await fetchTaskStoreTasks(params);
        tasks = result.tasks;
      } catch {
        degraded = true;
      }
    }

    return html(
      renderSessionDetailPage(
        sessionId,
        tasks,
        c.var.userEmail,
        degraded,
        backHref,
      ),
    );
  });

  // ─── PRs ─────────────────────────────────────────────────────────────────

  app.get("/admin/prs", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

    const stateParam = c.req.query("state") ?? undefined;
    const reviewState = c.req.query("reviewState") ?? undefined;
    // c.req.query("repo") only returns the first value when the query string
    // repeats the key (?repo=a&repo=b) — use queries() to get all values, so
    // both a bookmarked single-value URL and a multiselect submission with
    // several selections round-trip correctly.
    const repo = c.req.queries("repo");
    const org = c.req.queries("org");
    const taskId = c.req.query("taskId") ?? undefined;
    const blockedParam = c.req.query("blocked") ?? undefined;
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
      // The taskId filter is resolved live against the task-store rather than
      // forwarded as a stored `taskId=` query param (PTL-2.1) — look up the
      // task's repo+pr and filter /prs by those instead. If the task isn't
      // found, or has no linked pr, render an empty list rather than an
      // unfiltered one.
      let taskFilterRepo: string | undefined;
      let taskFilterPr: number | undefined;
      let taskFilterUnresolved = false;
      if (taskId) {
        if (!fetchTaskStoreTask) {
          taskFilterUnresolved = true;
        } else {
          try {
            const task = await fetchTaskStoreTask(taskId);
            if (task?.repo && task.pr) {
              taskFilterRepo = task.repo;
              taskFilterPr = task.pr;
            } else {
              taskFilterUnresolved = true;
            }
          } catch {
            taskFilterUnresolved = true;
          }
        }
      }

      // A user-supplied repo/org filter lives in the same <form> as the
      // taskId filter, so both can be submitted together. If the task's
      // resolved repo doesn't satisfy the user's own repo filter, the
      // combination is unsatisfiable — render an empty list rather than
      // silently overwriting (and losing) the user's repo selection.
      if (
        taskFilterRepo &&
        repo &&
        repo.length > 0 &&
        !repo.includes(taskFilterRepo)
      ) {
        taskFilterUnresolved = true;
      }

      if (taskFilterUnresolved) {
        // Task not found / no linked pr / lookup failed / conflicts with the
        // user's own repo filter — render empty list.
        prs = [];
        total = 0;
      } else {
        const params = new URLSearchParams();
        if (stateParam) params.set("state", stateParam);
        if (reviewState) params.set("reviewState", reviewState);
        for (const r of repo ?? []) params.append("repo", r);
        for (const o of org ?? []) params.append("org", o);
        if (taskFilterRepo && taskFilterPr) {
          params.set("repo", taskFilterRepo);
          params.set("prNumber", String(taskFilterPr));
        }
        if (blockedParam === "true") params.set("blocked", "true");
        params.set("limit", String(limit));
        params.set("offset", String(offset));
        params.set("sort", "desc");
        try {
          const result = await fetchTaskStorePrs(params);
          prs = result.prs;
          total = result.total;
        } catch {
          degraded = true;
        }
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
      const agents = await agentService.listByIds(agentIds);
      for (const a of agents) agentNames[a.id] = a.name;
    }

    // Resolve linked task(s) per PR via a live GET /tasks?repo=&pr= lookup,
    // one request per distinct (repo, prNumber) pair, run in parallel to
    // avoid an N+1 sequential-await chain (PTL-2.1). Falls back to an empty
    // task list per row if the fetcher is absent or a lookup throws.
    const linkedTasksByPr: Record<string, TaskItem[]> = {};
    if (fetchTaskStoreTasks && prs.length > 0) {
      const distinctPairs = new Map<string, { repo: string; pr: number }>();
      for (const pr of prs) {
        distinctPairs.set(`${pr.repo}#${pr.prNumber}`, {
          repo: pr.repo,
          pr: pr.prNumber,
        });
      }
      const pairResults = await Promise.all(
        [...distinctPairs.entries()].map(
          async ([key, { repo: r, pr: p }]): Promise<[string, TaskItem[]]> => {
            try {
              const result = await fetchTaskStoreTasks(
                new URLSearchParams({ repo: r, pr: String(p) }),
              );
              return [key, result.tasks];
            } catch {
              return [key, []];
            }
          },
        ),
      );
      const tasksByPairKey = new Map(pairResults);
      for (const pr of prs) {
        linkedTasksByPr[pr.id] =
          tasksByPairKey.get(`${pr.repo}#${pr.prNumber}`) ?? [];
      }
    }

    const suggestions = fetchDistinctTaskValues
      ? await fetchDistinctTaskValues()
          .then((v) => ({ repos: v.repos, orgs: v.orgs }))
          .catch(() => ({}))
      : {};

    return html(
      renderPrsPage(
        prs,
        {
          state: stateParam,
          reviewState,
          repo,
          org,
          taskId,
          blocked: blockedParam,
        },
        degraded,
        c.var.userEmail,
        agentNames,
        { total, limit, page },
        timezone,
        suggestions,
        linkedTasksByPr,
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
      const agents = await agentService.listByIds(agentIds);
      for (const a of agents) agentNames[a.id] = a.name;
    }

    // Resolve the linked task(s) via a live GET /tasks?repo=&pr= lookup,
    // mirroring the list page's per-row lookup (PTL-2.1). Falls back to an
    // empty task list if the fetcher is absent or the lookup throws.
    let linkedTasks: TaskItem[] = [];
    if (fetchTaskStoreTasks) {
      try {
        const result = await fetchTaskStoreTasks(
          new URLSearchParams({ repo: pr.repo, pr: String(pr.prNumber) }),
        );
        linkedTasks = result.tasks;
      } catch {
        linkedTasks = [];
      }
    }

    return html(
      renderPrDetailPage(
        pr,
        c.var.userEmail,
        agentNames,
        timezone,
        linkedTasks,
      ),
    );
  });

  // ─── Chat routes ─────────────────────────────────────────────────────────

  app.get("/admin/chat", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });

    const selectedAgentId = c.req.query("agentId") || undefined;
    const q = c.req.query("q") || undefined;
    const agents: AgentOption[] = await agentService.listOptions();

    if (!chatClient) {
      return html(
        renderChatPage(agents, selectedAgentId, null, c.var.userEmail, q),
      );
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

    // Test-only override for the live-progress stall-warning threshold so e2e
    // doesn't need a real 2-minute wait. Clamped to a sane range; production
    // never passes it, so the 120s default stands.
    const rawStall = c.req.query("stallWarnAfterMs");
    const stallWarnAfterMs =
      rawStall !== undefined &&
      Number.isFinite(Number(rawStall)) &&
      Number(rawStall) > 0
        ? Number(rawStall)
        : undefined;

    if (!chatClient) {
      return html(
        renderChatThreadPage(agentId, null, null, null, c.var.userEmail),
      );
    }

    try {
      const [thread, messagesResult, threadListResult, statsResult] =
        await Promise.all([
          chatClient.getThread(threadId),
          chatClient.listMessages(threadId),
          chatClient.listThreads(agentId).catch(() => null),
          chatClient.getThreadStats(threadId).catch(() => null),
        ]);
      const threadList = threadListResult ? threadListResult.threads : null;
      return html(
        renderChatThreadPage(
          agentId,
          thread,
          messagesResult.messages,
          threadList,
          c.var.userEmail,
          statsResult,
          { stallWarnAfterMs, pushEnabled, vapidPublicKey },
        ),
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
      return c.redirect(
        `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
        302,
      );
    }

    let title: string | undefined;
    try {
      const formData = await c.req.formData();
      title = formData.get("title")?.toString()?.trim() || undefined;
    } catch {
      return c.redirect(
        `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
        302,
      );
    }

    try {
      const thread = await chatClient.createThread(agentId, { title });
      return c.redirect(
        `/admin/chat/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(thread.id)}`,
        302,
      );
    } catch {
      return c.redirect(
        `/admin/chat?agentId=${encodeURIComponent(agentId)}`,
        302,
      );
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

      const agentId = c.req.param("agentId");
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
        // Record that this user is watching the thread so the agent's reply
        // can be targeted back to them via push (CFB-4.2). This is the route
        // the live chat UI's send box actually posts to (see
        // admin-ui-pages.ts's uploadUrl) — the form POST /messages and
        // /messages.json routes above are alternate entry points with their
        // own identical call; all three must stay in sync. Best-effort —
        // never block the response.
        if (pushEnabled) {
          await watchThread(c.var.userEmail, agentId, threadId);
        }
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

      // Record that this user is watching the thread so the agent's reply can
      // be targeted back to them via push (CFB-4.2). Only on user messages, and
      // only when push is configured. Best-effort — never block the redirect.
      if (pushEnabled && role === "user") {
        await watchThread(c.var.userEmail, agentId, threadId);
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
      // ?since=<messageId> → incremental poll: only messages after that id.
      const since = c.req.query("since") || undefined;

      if (!chatClient) {
        return c.json({ messages: [] });
      }

      try {
        const result = await chatClient.listMessages(threadId);
        // Track retryBody (CFB-2.4) over the FULL ordered list — not the
        // ?since-filtered slice — so a retry button on a polled-in error
        // reply still resolves to its originating user message even when
        // that user message was delivered in an earlier poll response.
        const retryBodyByMessageId = new Map<string, string | null>();
        let lastUserBody: string | null = null;
        for (const m of result.messages) {
          retryBodyByMessageId.set(m.id, lastUserBody);
          if (m.role === "user") lastUserBody = m.body;
        }
        // ?since filtering is applied here at the admin (server) layer over the
        // full ordered list, so it works regardless of the chat client impl.
        const ordered = since
          ? filterSince(result.messages, since)
          : result.messages;
        // Attach the server-rendered bubbleHtml so polled bubbles are
        // byte-identical to a full reload's server-rendered bubble.
        const messages = ordered.map((m) => ({
          ...m,
          bubbleHtml: renderChatMessageBubble(
            m,
            retryBodyByMessageId.get(m.id) ?? null,
          ),
        }));
        return c.json({ messages });
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
        if (pushEnabled) {
          await watchThread(c.var.userEmail, c.req.param("agentId"), threadId);
        }
        return c.json({ message });
      } catch {
        return c.json({ message: null }, 500);
      }
    },
  );

  // ─── Web Push routes (CFB-4.2) ────────────────────────────────────────────
  // All 503 when push is not fully configured server-side, so the client-side
  // toggle (which is itself absent in that case) degrades cleanly.

  app.post("/admin/chat/:agentId/push/subscribe", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    if (!pushEnabled) return c.json({ error: "push_disabled" }, 503);

    let payload: { endpoint?: string; p256dh?: string; auth?: string };
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    const { endpoint, p256dh, auth } = payload;
    if (!endpoint || !p256dh || !auth) {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!prisma.pushSubscription)
      return c.json({ error: "push_disabled" }, 503);
    try {
      await prisma.pushSubscription.upsert({
        where: { endpoint },
        create: { userEmail: c.var.userEmail, endpoint, p256dh, auth },
        update: { userEmail: c.var.userEmail, p256dh, auth },
      });
    } catch (err) {
      console.error("[push] subscribe upsert failed:", err);
      return c.json({ error: "store_failed" }, 500);
    }
    return c.json({ ok: true });
  });

  app.post("/admin/chat/:agentId/push/unsubscribe", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    if (!pushEnabled) return c.json({ error: "push_disabled" }, 503);

    let endpoint: string | undefined;
    try {
      endpoint = (await c.req.json<{ endpoint?: string }>()).endpoint;
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!endpoint) return c.json({ error: "bad_request" }, 400);
    if (!prisma.pushSubscription)
      return c.json({ error: "push_disabled" }, 503);
    try {
      // Scope the delete to the caller so a stale endpoint can't be used to
      // prune another user's subscription.
      await prisma.pushSubscription.deleteMany({
        where: { endpoint, userEmail: c.var.userEmail },
      });
    } catch (err) {
      console.error("[push] unsubscribe delete failed:", err);
    }
    return c.json({ ok: true });
  });

  // Inbound webhook the chat service calls when an agent posts a reply, so the
  // watching user(s) get notified. Authenticated by a shared bearer token
  // (SHIPWRIGHT_ADMIN_PUSH_WEBHOOK_TOKEN) — NOT a user session — since the
  // caller is a service, not a browser.
  app.post("/admin/push/notify", async (c) => {
    if (!pushEnabled || !pushService || !pushWebhookToken) {
      return c.json({ error: "push_disabled" }, 503);
    }
    const auth = c.req.header("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!presented || presented !== pushWebhookToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: {
      threadId?: string;
      agentId?: string;
      title?: string | null;
      preview?: string | null;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad_request" }, 400);
    }
    if (!body.threadId || !body.agentId) {
      return c.json({ error: "bad_request" }, 400);
    }
    const result = await pushService.notifyThreadReply({
      threadId: body.threadId,
      agentId: body.agentId,
      title: body.title ?? null,
      preview: body.preview ?? null,
    });
    return c.json({ ok: true, ...result });
  });

  // ─── Agent delete (danger zone) ───────────────────────────────────────────

  app.post("/admin/agents/:id/delete", requireAuth, async (c) => {
    if (!c.var.isAdmin) return new Response("Forbidden", { status: 403 });
    const agentId = c.req.param("id");
    try {
      // Full teardown: K8s workload, task-store + chat-service tokens/threads,
      // optional Slack app deletion, then the Agent row itself (deleted last,
      // only if every automatable step succeeded). Same orchestration DELETE
      // /agents/:id uses (agents-api.ts) — this was previously a separate
      // inline provisioner.deprovision() + direct-prisma-delete path that had
      // drifted from it. deleteAgentFully() still takes prisma directly (its
      // own dependency shape, not routed through AgentService).
      const result = await deleteAgentFully(agentId, {
        prisma,
        provisioner,
        taskStore,
        chatService,
        slack,
        decrypt,
      });
      if (!result.agentDeleted) {
        // Cleanup is incomplete — keep the operator on the agent's own page
        // (NOT the agents list) so the agent doesn't appear deleted while
        // steps still need a retry.
        const failedSteps = result.failed.map((f) => f.step).join(", ");
        return c.redirect(
          `/admin/agents/${agentId}?error=${encodeURIComponent(
            `Cleanup incomplete — retry. Failed steps: ${failedSteps}`,
          )}`,
          302,
        );
      }
      const manualStepsParam =
        result.manualStepsRequired.length > 0
          ? `&manualSteps=${encodeURIComponent(
              JSON.stringify(result.manualStepsRequired),
            )}`
          : "";
      return c.redirect(
        `/admin/agents?success=deleted${manualStepsParam}`,
        302,
      );
    } catch (err) {
      const msg =
        err instanceof Error
          ? encodeURIComponent(err.message)
          : "delete_failed";
      return c.redirect(`/admin/agents/${agentId}?error=${msg}`, 302);
    }
  });

  // ─── Public read-only task board ──────────────────────────────────────────
  //
  // Unauthenticated GET /public/tasks — no session cookie required.
  // Scoped to publicRepo (SHIPWRIGHT_ADMIN_PUBLIC_REPO). When publicRepo is
  // absent the page renders in degraded mode (empty table + warning notice).
  // No create/edit/status-change controls are rendered (readOnly=true).
  // Mutation methods (POST/PUT/DELETE) fall through to Hono's 404 default.

  app.get("/public/tasks", publicNoAuthMiddleware, async (c) => {
    const source = c.req.query("source") ?? undefined;
    let tasks: TaskItem[] = [];
    let total = 0;
    let degraded = false;

    if (!fetchTaskStoreTasks || !publicRepo) {
      degraded = true;
    } else {
      const params = new URLSearchParams();
      params.set("repo", publicRepo);
      if (source) params.set("source", source);
      params.set("limit", "50");
      params.set("offset", "0");
      params.set("sort", "desc");
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
        { repo: publicRepo, source },
        degraded,
        "",
        {},
        { total, limit: 50, page: 1 },
        undefined,
        undefined,
        true, // readOnly
        timezone,
      ),
      // The PWA manifest's scope is /admin/ — this unauthenticated public
      // board must never reference /admin/ URLs at all.
      { includePwaTags: false },
    );
  });

  return app;
}
