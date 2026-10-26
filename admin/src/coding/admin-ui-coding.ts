/**
 * admin/src/coding/admin-ui-coding.ts
 * The coding extension's admin UI routes — server-rendered Hono app factory,
 * mounted by codingAdminExtension.adminUiRoutes after the platform admin UI
 * (AEP-3.2: split out of admin-ui.ts, which keeps the platform pages).
 *
 * Routes:
 *   GET  /admin/queue-activity                    — merged fleet-wide Queue & Activity
 *   GET  /admin/agents/:id/queue-activity         — one agent's Queue & Activity
 *   POST /admin/agents/:id/phase-methodology/:phase — set/clear a phase override
 *   GET  /admin/tasks, /admin/tasks/:id           — task-store tasks (board/table, detail)
 *   POST /admin/tasks/:id/release                 — release a claimed task
 *   GET  /admin/sessions, /admin/sessions/:id     — sessions list and detail
 *   POST /admin/sessions/:slug/{follow,unfollow,archive,unarchive,rename}
 *   GET|POST /admin/settings/notifications        — session notification prefs
 *   GET  /admin/prs, /admin/prs/:id               — task-store PRs (list, detail)
 *   GET  /public/tasks                            — unauthenticated read-only board
 *
 * Auth: the platform's admin_session cookie (createUIAuthMiddleware), except
 * GET /public/tasks.
 */

import {
  type AdminUIEnv,
  createAgentAccessChecks,
  createHtmlResponder,
  createUIAuthMiddleware,
  resolveBackHref,
} from "@app-vitals/agent-admin/admin-ui";
import type { AgentCronJobService } from "@app-vitals/agent-admin/agent-cron-jobs";
import type { AgentCronRunService } from "@app-vitals/agent-admin/agent-cron-runs";
import type { AgentMemberService } from "@app-vitals/agent-admin/agent-members";
import type { AgentService } from "@app-vitals/agent-admin/agents";
import { publicNoAuthMiddleware } from "@app-vitals/agent-admin/api-auth";
import {
  type CallerScopeResolver,
  memberOnlyCallerScopeResolver,
  type TaskStoreViewScope,
  taskStoreViewScope,
} from "@app-vitals/agent-admin/caller-scope";
import { AGENT_PHASES } from "@app-vitals/agent-admin/openapi-schemas";
import type { PushService } from "@app-vitals/agent-admin/push-service";
import { Hono } from "hono";
import {
  buildMergedWorkQueueRows,
  renderMergedQueueActivityPage,
  renderQueueActivityPage,
  type WorkQueueItem,
} from "./admin-ui-queue-pages.ts";
import {
  registerSessionAdminActionsRoutes,
  SESSION_ADMIN_ACTION_MESSAGES,
} from "./admin-ui-session-admin-actions.ts";
import { registerSessionFollowRoutes } from "./admin-ui-session-follow.ts";
import { registerSessionSettingsRoutes } from "./admin-ui-sessions.ts";
import {
  registerSessionsListRoutes,
  resolveVisibilityScope,
  type Session,
} from "./admin-ui-sessions-list.ts";
import type { VerificationCheckItem } from "./admin-ui-verification-cards.ts";
import {
  type PrListItem,
  type PullRequestItem,
  renderPrDetailPage,
  renderPrsPage,
  renderSessionDetailPage,
  renderTaskDetailPage,
  renderTasksPage,
  resolveAgentNameFilterAndPaginate,
  type TaskItem,
} from "./admin-ui-work-item-pages.ts";
import type { AgentPhaseMethodologyService } from "./agent-phase-methodology.ts";
import type { AgentWorkQueueService } from "./agent-work-queue.ts";
import {
  type SessionFollowPrismaLike,
  SessionFollowService,
} from "./session-follow-service.ts";
import {
  deriveSessionVisibilityFromTasks,
  isSessionVisible,
  type SessionForVisibility,
} from "./session-scope.ts";
import type { ShipwrightLoopJobService } from "./shipwright-loop-jobs.ts";
import { fetchRecentVerificationChecks } from "./verification-checks.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The task-store fetchers (task-store-fetchers.ts); each is optional. */
export interface CodingTaskStoreFetchers {
  /**
   * Fetch tasks from the task-store service. If absent, the tasks page renders
   * in degraded mode (empty table + yellow notice) rather than returning 500.
   */
  fetchTaskStoreTasks?: (
    params: URLSearchParams,
    accountId?: string,
  ) => Promise<{
    tasks: TaskItem[];
    total: number;
    limit: number;
    offset: number;
  }>;
  /**
   * Fetch a single task by ID from the task-store service. If absent, the
   * detail route redirects back to the list.
   */
  fetchTaskStoreTask?: (
    id: string,
    accountId?: string,
  ) => Promise<TaskItem | null>;
  /**
   * Release a task (unclaim → pending) via the task-store service.
   */
  releaseTask?: (id: string, accountId?: string) => Promise<void>;
  /**
   * Fetch distinct session and repo values from the task-store service.
   * Used to populate datalist autocomplete suggestions in the tasks filter form.
   * If absent, no datalists are rendered (inputs remain plain text).
   */
  fetchDistinctTaskValues?: (accountId?: string) => Promise<{
    sessions: string[];
    repos: string[];
    orgs: string[];
  }>;
  /**
   * Fetch a paginated list of pull requests from the task-store service.
   * If absent, the PRs page renders in degraded mode (empty table + warning banner).
   */
  fetchTaskStorePrs?: (
    params: URLSearchParams,
    accountId?: string,
  ) => Promise<{
    prs: PrListItem[];
    total: number;
    limit: number;
    offset: number;
  }>;
  /**
   * Fetch a single pull request by its ID from the task-store service.
   * If absent or returns null, the PR detail route redirects to /admin/prs.
   */
  fetchTaskStorePrById?: (
    id: string,
    accountId?: string,
  ) => Promise<PrListItem | null>;
  /**
   * Fetch recorded verification-check outcomes (LVB-5.1) for a task or PR
   * from the task-store service, via exactly one of `?taskId=` or `?prId=`.
   * If absent, the task/PR detail pages render without a Verification Checks
   * card and the agent detail page renders without its Recent Verification
   * Activity rollup — the same graceful-degradation convention as every
   * other optional task-store fetcher here.
   */
  fetchVerificationChecks?: (
    params: URLSearchParams,
    accountId?: string,
  ) => Promise<{
    checks: VerificationCheckItem[];
    total: number;
    limit: number;
    offset: number;
  }>;
  /**
   * Fetch a paginated list of sessions from the task-store service (SESH-4.2).
   * If absent, the sessions list page renders in degraded mode (empty
   * sections + a warning banner).
   */
  fetchTaskStoreSessions?: (
    params: URLSearchParams,
    accountId?: string,
  ) => Promise<{
    sessions: Session[];
    total: number;
    limit: number;
    offset: number;
  }>;
  /**
   * Fetch a single session (its agentIds/repos, for visibility checks) from
   * the task-store service by slug. If absent, a non-admin member always
   * gets 404 on POST /admin/sessions/:slug/follow — fail-closed, since
   * visibility can't be verified without it. Not consulted on the admin or
   * unfollow paths.
   */
  fetchTaskStoreSession?: (
    slug: string,
    accountId?: string,
  ) => Promise<SessionForVisibility | null>;
  /**
   * Apply a rename/archive patch to a session via the task-store's
   * `PATCH /sessions/:slug` (SESH-3.1, admin-token only). Backs the session
   * detail page's admin-only Archive/Unarchive/Rename actions (SESH-5.2). If
   * absent, those POST routes redirect back with an `?error=` flash instead
   * of throwing — not every admin deployment has task-store configured.
   */
  patchTaskStoreSession?: (
    slug: string,
    patch: { title?: string | null; archived?: boolean },
    accountId?: string,
  ) => Promise<unknown>;
}

export interface CodingAdminUIDeps extends CodingTaskStoreFetchers {
  /**
   * Prisma client for the session-follow service (SessionFollow +
   * UserNotificationPrefs). Typed loosely: see the cast at its construction.
   */
  prisma: unknown;
  sessionSecret: string;
  /** Base URL for the PWA head tags (same value as the platform UI's). */
  appBaseUrl: string;
  /**
   * IANA timezone name for date/time display. Defaults to
   * "America/Los_Angeles" when absent, matching the platform UI.
   */
  timezone?: string;
  agentService: Pick<
    AgentService,
    "listAll" | "listByIds" | "searchByName" | "listOptions" | "getDetail"
  >;
  agentCronJobService: Pick<AgentCronJobService, "list">;
  shipwrightLoopJobService: Pick<
    ShipwrightLoopJobService,
    "listShipwrightLoopJobs"
  >;
  agentCronRunService: Pick<
    AgentCronRunService,
    "listForAgent" | "listAcrossAgents"
  >;
  agentWorkQueueService: Pick<AgentWorkQueueService, "get" | "getMany">;
  agentPhaseMethodologyService: Pick<AgentPhaseMethodologyService, "upsert">;
  agentMemberService: Pick<AgentMemberService, "listByEmail" | "exists">;
  /**
   * Account-aware caller-scope resolver (SSP-2.1). Defaults to the
   * AgentMember-only resolver, matching the platform UI.
   */
  callerScopeResolver?: CallerScopeResolver;
  /**
   * Resolve whether the current user follows a session, for the session
   * detail page's Follow/Unfollow button (SESH-5.3). Defaults to querying
   * the real sessionFollowService when absent — injectable for tests.
   */
  fetchIsFollowingSession?: (
    userEmail: string,
    slug: string,
  ) => Promise<boolean>;
  /**
   * Public repo slug (SHIPWRIGHT_ADMIN_PUBLIC_REPO) for the read-only task board.
   * When set, GET /public/tasks renders the task list filtered to this repo
   * without requiring authentication. When absent, /public/tasks renders in
   * degraded mode (empty table + warning notice).
   */
  publicRepo?: string;
  /**
   * Web Push (CFB-4.2), for the notification settings page's push toggle:
   * enabled only with both the service and the VAPID public key.
   */
  pushService?: PushService;
  vapidPublicKey?: string;
}

/**
 * `?error=` codes the coding routes redirect to the platform agent detail page
 * with; contributed to its error map via AdminUIDeps.agentDetailErrorMessages.
 */
export const CODING_AGENT_DETAIL_ERROR_MESSAGES: Record<string, string> = {
  invalid_phase: "Invalid pipeline phase.",
};

// ─── Back-link validation ───────────────────────────────────────────────────

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
 * Resolves each task's linked PR via a live GET /prs?repo=&prNumber= lookup,
 * one request per distinct (repo, pr) pair among the given tasks, run in
 * parallel to avoid an N+1 sequential-await chain. Shared by GET /admin/tasks
 * (AXR-1.2) and GET /admin/sessions/:id (SESH-5.1), which both need the same
 * task-id → PR map. Falls back to no PR data per row if the fetcher is
 * absent, a task has no repo/pr, or a lookup throws — a failed join never
 * breaks the page, it just means the caller sees no PR data for that row.
 */
async function joinPrsByTaskId(
  tasks: TaskItem[],
  fetchTaskStorePrs:
    | ((params: URLSearchParams) => Promise<{ prs: PrListItem[] }>)
    | undefined,
): Promise<Record<string, PrListItem>> {
  const prsByTaskId: Record<string, PrListItem> = {};
  if (!fetchTaskStorePrs || tasks.length === 0) return prsByTaskId;

  const distinctPairs = new Map<string, { repo: string; pr: number }>();
  for (const t of tasks) {
    if (t.repo && t.pr) {
      distinctPairs.set(`${t.repo}#${t.pr}`, { repo: t.repo, pr: t.pr });
    }
  }
  if (distinctPairs.size === 0) return prsByTaskId;

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
  return prsByTaskId;
}

// ─── App factory ──────────────────────────────────────────────────────────────

export function createCodingAdminUIApp(
  deps: CodingAdminUIDeps,
): Hono<AdminUIEnv> {
  const {
    prisma,
    sessionSecret,
    appBaseUrl,
    timezone = "America/Los_Angeles",
    agentService,
    agentCronJobService,
    shipwrightLoopJobService,
    agentCronRunService,
    agentWorkQueueService,
    agentPhaseMethodologyService,
    agentMemberService,
    callerScopeResolver = memberOnlyCallerScopeResolver(agentMemberService),
    fetchTaskStoreTasks,
    fetchTaskStoreTask,
    releaseTask,
    fetchDistinctTaskValues,
    fetchTaskStorePrs,
    fetchTaskStorePrById,
    fetchVerificationChecks,
    fetchTaskStoreSessions,
    fetchTaskStoreSession,
    patchTaskStoreSession,
    fetchIsFollowingSession,
    publicRepo,
    pushService,
    vapidPublicKey = "",
  } = deps;

  // Push is enabled only when the service was constructed (VAPID fully set) AND
  // a public key is available for the browser — same gate as the platform UI.
  const pushEnabled = Boolean(pushService && vapidPublicKey);

  const app = new Hono<AdminUIEnv>();

  const requireAuth = createUIAuthMiddleware(sessionSecret);
  const html = createHtmlResponder(appBaseUrl);
  const { resolveAccessibleAgents, assertAgentAccess } =
    createAgentAccessChecks({ agentService, callerScopeResolver });

  // SES-6.1's service — CRUD over SessionFollow + UserNotificationPrefs.
  // Constructed here (not injected) since it needs only the same `prisma`
  // dep every other in-process service already gets. `prisma` is typed
  // loosely (test doubles pass the platform's narrow PrismaLike, which lacks
  // the two models only this service touches); the real PrismaClient wired by
  // the coding extension structurally satisfies SessionFollowPrismaLike, so
  // the cast here is safe and keeps the blast radius to this one call site.
  const sessionFollowService = new SessionFollowService(
    prisma as unknown as SessionFollowPrismaLike,
  );

  // SESH-5.3: resolves whether the current user already follows a session,
  // for the detail page's Follow/Unfollow button. Defaults to a real
  // sessionFollowService.listByUser() lookup — DB-backed via the service
  // already constructed above, not an HTTP fetch, so no main.ts wiring is
  // needed. Tests inject a plain double via fetchIsFollowingSession.
  const resolveIsFollowingSession =
    fetchIsFollowingSession ??
    (async (userEmail: string, slug: string) => {
      const follows = await sessionFollowService.listByUser(userEmail);
      return follows.some((f) => f.sessionSlug === slug);
    });

  // ─── Merged fleet-wide queue-activity view (AAV-2.1) ─────────────────────
  // Resolves the caller's accessible agents with the same scoping as
  // /admin/agents (createAgentAccessChecks), then renders the merged cross-agent Queue &
  // Activity view directly — superseding the former AXR-3.3 behavior of
  // redirecting to the first accessible agent's own queue-activity page.
  // Zero accessible agents still falls back to the agents list rather than
  // rendering an empty merged view with no agent to switch to.

  app.get("/admin/queue-activity", requireAuth, async (c) => {
    const agents = await resolveAccessibleAgents(
      c.var.userEmail,
      c.var.isAdmin,
    );
    if (agents.length === 0) {
      return c.redirect("/admin/agents", 302);
    }

    const agentIds = agents.map((a) => a.id);

    const pageRaw = c.req.query("page");
    const page = pageRaw ? Math.max(1, Number.parseInt(pageRaw, 10) || 1) : 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const queuePageRaw = c.req.query("queuePage");
    const queuePage = queuePageRaw
      ? Math.max(1, Number.parseInt(queuePageRaw, 10) || 1)
      : 1;
    const queueLimit = 20;
    const queueOffset = (queuePage - 1) * queueLimit;

    const [snapshots, runResult, loopJobs] = await Promise.all([
      agentWorkQueueService.getMany(agentIds),
      agentCronRunService.listAcrossAgents(agentIds, { limit, offset }),
      shipwrightLoopJobService.listShipwrightLoopJobs(agentIds),
    ]);

    const agentNames: Record<string, string> = {};
    for (const a of agents) agentNames[a.id] = a.name;

    // A missing shipwright-loop row defaults to not-loop-enabled; a present
    // row is loop-enabled only when its own enabled flag is true.
    const loopEnabledByAgentId = new Map<string, boolean>();
    for (const job of loopJobs) {
      loopEnabledByAgentId.set(job.agentId, job.enabled === true);
    }

    const mergedRows = buildMergedWorkQueueRows(
      snapshots.map((s) => ({
        agentId: s.agentId,
        items: s.items as unknown as WorkQueueItem[],
      })),
      agents.map((a) => ({
        id: a.id,
        repos: a.repos ?? [],
        loopEnabled: loopEnabledByAgentId.get(a.id) ?? false,
      })),
    );
    const queueTotal = mergedRows.length;
    const pagedRows = mergedRows.slice(queueOffset, queueOffset + queueLimit);

    return html(
      renderMergedQueueActivityPage({
        agents: agents.map((a) => ({ id: a.id, name: a.name })),
        agentNames,
        workQueueRows: pagedRows,
        workQueuePagination: {
          total: queueTotal,
          limit: queueLimit,
          page: queuePage,
        },
        runs: runResult.items,
        runsPagination: { total: runResult.total, limit, page },
        userName: c.var.userEmail,
        timezone,
      }),
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

  // ─── Phase methodology mutations ─────────────────────────────────────────

  app.post(
    "/admin/agents/:id/phase-methodology/:phase",
    requireAuth,
    async (c) => {
      const agentId = c.req.param("id");
      const phase = c.req.param("phase");
      if (!(await assertAgentAccess(agentId, c.var.userEmail, c.var.isAdmin))) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!(AGENT_PHASES as readonly string[]).includes(phase)) {
        return c.redirect(`/admin/agents/${agentId}?error=invalid_phase`, 302);
      }
      let subagentType: string | null = null;
      try {
        const formData = await c.req.formData();
        const raw = formData.get("subagentType")?.toString().trim() ?? "";
        subagentType = raw === "" ? null : raw;
      } catch {
        return c.redirect(`/admin/agents/${agentId}`, 302);
      }
      try {
        await agentPhaseMethodologyService.upsert(agentId, phase, subagentType);
      } catch {
        // ignore errors — redirect back regardless
      }
      return c.redirect(`/admin/agents/${agentId}`, 302);
    },
  );

  // ─── Task-store view scoping (SSP-6.8) ─────────────────────────────────────

  /**
   * Who may read the Tasks/PRs/Sessions views, and over which account:
   * platform admins see every account (no filter), an account user (flag
   * on) exactly their own, anyone else nothing (Tasks/PRs stay admin-only).
   */
  async function resolveTaskStoreView(
    isAdmin: boolean,
    userEmail: string,
  ): Promise<TaskStoreViewScope> {
    if (isAdmin) return { kind: "all" };
    return taskStoreViewScope(await callerScopeResolver(userEmail, false));
  }

  /**
   * The task-store fetchers bound to one account (`?accountId=`, sent with
   * the admin token) — or unbound (every account) when `accountId` is
   * undefined. Each route reads through these, so every task-store call it
   * makes, including PR/task joins and suggestion lookups, stays in scope.
   */
  function scopedTaskStore(accountId: string | undefined) {
    return {
      fetchTasks:
        fetchTaskStoreTasks &&
        ((params: URLSearchParams) => fetchTaskStoreTasks(params, accountId)),
      fetchTask:
        fetchTaskStoreTask &&
        ((id: string) => fetchTaskStoreTask(id, accountId)),
      release: releaseTask && ((id: string) => releaseTask(id, accountId)),
      fetchDistinct:
        fetchDistinctTaskValues && (() => fetchDistinctTaskValues(accountId)),
      fetchPrs:
        fetchTaskStorePrs &&
        ((params: URLSearchParams) => fetchTaskStorePrs(params, accountId)),
      fetchPrById:
        fetchTaskStorePrById &&
        ((id: string) => fetchTaskStorePrById(id, accountId)),
      fetchChecks:
        fetchVerificationChecks &&
        ((params: URLSearchParams) =>
          fetchVerificationChecks(params, accountId)),
    };
  }

  /** Agent-name suggestions: an account user only sees their own agents. */
  async function agentSuggestions(view: TaskStoreViewScope): Promise<string[]> {
    const agents =
      view.kind === "account"
        ? await agentService.listByIds(view.agentIds)
        : await agentService.listOptions();
    return agents.map((a) => a.name);
  }

  const NOT_FOUND = () => new Response("Not Found", { status: 404 });

  // ─── Tasks page ───────────────────────────────────────────────────────────

  app.get("/admin/tasks", requireAuth, async (c) => {
    const scopeView = await resolveTaskStoreView(
      c.var.isAdmin,
      c.var.userEmail,
    );
    if (scopeView.kind === "none")
      return new Response("Forbidden", { status: 403 });
    const ts = scopedTaskStore(
      scopeView.kind === "account" ? scopeView.accountId : undefined,
    );
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

    let tasks: TaskItem[] = [];
    let total = 0;
    let degraded = false;
    let agentFilterActive = false;
    let distinctValues: {
      sessions: string[];
      repos: string[];
      orgs: string[];
    } | null = null;

    const fetchTasks = ts.fetchTasks;
    const fetchDistinct = ts.fetchDistinct;
    if (!fetchTasks) {
      degraded = true;
    } else {
      try {
        const [result, distinct] = await Promise.all([
          resolveAgentNameFilterAndPaginate<TaskItem>({
            agentName: agent,
            searchByName: (name) => agentService.searchByName(name),
            limit,
            offset,
            matches: (t, ids) =>
              (!!t.assignee && ids.has(t.assignee)) ||
              (!!t.claimedBy && ids.has(t.claimedBy)),
            fetchPage: async (fetchLimit, fetchOffset) => {
              const params = new URLSearchParams();
              if (status) {
                params.set("status", status);
              } else if (state) {
                params.set("state", state);
              } else if (view === "board") {
                // TBC-2.1: with no explicit status/state filter, the
                // default board query excludes the fully-closed statuses
                // (merged/done/deploying/deployed/cancelled) so Done tasks
                // never crowd out the shared recency window. This can't
                // exclude "claimed" specifically at the query level —
                // claimed and queued share the same "pending" status,
                // distinguished only by claimedBy — so Claimed is dropped
                // purely by no longer being a rendered TASK_BOARD_COLUMNS
                // entry.
                params.set("state", "open");
              }
              if (session) params.set("session", session);
              for (const r of repo ?? []) params.append("repo", r);
              for (const o of org ?? []) params.append("org", o);
              if (source) params.set("source", source);
              if (hitl) params.set("hitl", hitl);
              params.set("limit", String(fetchLimit));
              params.set("offset", String(fetchOffset));
              params.set("sort", "desc");
              const fetched = await fetchTasks(params);
              return { items: fetched.tasks, total: fetched.total };
            },
          }),
          fetchDistinct
            ? fetchDistinct().catch(() => null)
            : Promise.resolve(null),
        ]);
        tasks = result.items;
        total = result.total;
        agentFilterActive = result.filterActive;
        distinctValues = distinct;
      } catch {
        degraded = true;
      }
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

    // Resolve each task's linked PR (AXR-1.2) — same pattern as GET
    // /admin/prs's linkedTasksByPr join, and the single-task version at GET
    // /admin/tasks/:id, just batched.
    const prsByTaskId = await joinPrsByTaskId(tasks, ts.fetchPrs);

    // Build suggestions for autocomplete datalists only when task-store integration is active.
    // Skip the DB query entirely when fetchDistinctTaskValues is not configured.
    const suggestions =
      fetchDistinct && distinctValues
        ? {
            sessions: distinctValues.sessions,
            repos: distinctValues.repos,
            orgs: distinctValues.orgs,
            agents: await agentSuggestions(scopeView),
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
          agentFilterActive,
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
    const view = await resolveTaskStoreView(c.var.isAdmin, c.var.userEmail);
    if (view.kind === "none") return new Response("Forbidden", { status: 403 });
    const ts = scopedTaskStore(
      view.kind === "account" ? view.accountId : undefined,
    );
    const taskId = c.req.param("id");
    const backHref = resolveTaskDetailBackHref(c.req.query("from"));
    if (!ts.fetchTask)
      return c.redirect("/admin/tasks?error=task_store_unavailable", 302);
    let task: TaskItem | null = null;
    try {
      task = await ts.fetchTask(taskId);
    } catch {
      return c.redirect("/admin/tasks?error=task_fetch_failed", 302);
    }
    // SSP-6.8: for an account user a missing task and another account's task
    // are the same 404, so ids from other accounts can't be probed.
    if (!task && view.kind === "account") return NOT_FOUND();
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
    if (ts.fetchPrs && task.repo && task.pr) {
      try {
        const result = await ts.fetchPrs(
          new URLSearchParams({ repo: task.repo, prNumber: String(task.pr) }),
        );
        pullRequest = result.prs[0];
      } catch {
        // swallow — page renders without PR section
      }
    }

    // Fetch recorded verification-check outcomes (LVB-5.1) for this task —
    // absence of the fetcher or a failed lookup renders the page without a
    // Verification Checks section, never a 500.
    let verificationChecks: VerificationCheckItem[] = [];
    if (ts.fetchChecks) {
      try {
        verificationChecks = await fetchRecentVerificationChecks(
          ts.fetchChecks,
          { taskId },
        );
      } catch {
        // swallow — page renders without Verification Checks section
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
        verificationChecks,
      ),
    );
  });

  app.post("/admin/tasks/:id/release", requireAuth, async (c) => {
    const view = await resolveTaskStoreView(c.var.isAdmin, c.var.userEmail);
    if (view.kind === "none") return new Response("Forbidden", { status: 403 });
    const ts = scopedTaskStore(
      view.kind === "account" ? view.accountId : undefined,
    );
    const taskId = c.req.param("id");
    if (!ts.release)
      return c.redirect("/admin/tasks?error=task_store_unavailable", 302);
    // SSP-6.8: an account user may only release a task in their own account.
    // The task-store enforces this too (?accountId= on the release call);
    // checking first turns another account's id into a clean 404.
    if (view.kind === "account") {
      let owned: TaskItem | null = null;
      try {
        owned = ts.fetchTask ? await ts.fetchTask(taskId) : null;
      } catch {
        return c.redirect("/admin/tasks?error=release_failed", 302);
      }
      if (!owned) return NOT_FOUND();
    }
    try {
      await ts.release(taskId);
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

  // ─── Sessions list (SESH-4.2) ──────────────────────────────────────────────

  registerSessionsListRoutes(app, {
    requireAuth,
    agentMemberService,
    callerScopeResolver,
    agentService,
    sessionFollowService,
    fetchTaskStoreSessions,
    fetchDistinctTaskValues,
    timezone,
    html,
  });

  // ─── Session detail ───────────────────────────────────────────────────────

  app.get("/admin/sessions/:id", requireAuth, async (c) => {
    const sessionId = c.req.param("id");
    const backHref = resolveSessionDetailBackHref(c.req.query("from"));

    // SSP-6.8: an account user is pinned to their own account (a supplied
    // ?accountId= is ignored); a platform admin may address another
    // account's same-slug session via ?accountId= (the list links carry it).
    const view = await resolveTaskStoreView(c.var.isAdmin, c.var.userEmail);
    const accountId =
      view.kind === "account"
        ? view.accountId
        : view.kind === "all"
          ? c.req.query("accountId") || undefined
          : undefined;
    const ts = scopedTaskStore(accountId);
    const fetchTasks = ts.fetchTasks;

    let tasks: TaskItem[] = [];
    let degraded = false;

    if (!fetchTasks) {
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
        const result = await fetchTasks(params);
        tasks = result.tasks;
      } catch {
        degraded = true;
      }
    }

    // SESH-5.1: resolve each waiting-candidate task's linked PR so
    // renderSessionDetailPage can classify "pr_blocked" rows — a failed join
    // never breaks the page, it just means no task classifies that way.
    const prsByTaskId = await joinPrsByTaskId(tasks, ts.fetchPrs);

    // SESH-4.2: replaces the old flat `if (!isAdmin) 403` gate with a
    // session-scope.ts-based visibility check — an admin always sees the
    // page; a member sees it only when one of the session's own tasks is
    // assigned/claimed by one of their agents, or is in one of those
    // agents' repos. Derived from the tasks already fetched above (no
    // second fetch), using deriveSessionVisibilityFromTasks() so the
    // agentIds precedence (`claimedBy ?? assignee`) matches the task-store
    // rollup the list page's check consumes. A session outside the caller's
    // scope 404s rather than 403s, so its existence isn't leaked to callers
    // who can't see it.
    //
    // Skipped entirely in degraded mode: `tasks` is empty because the task
    // store is unreachable, so the derived scope would be empty and every
    // member would be 404'd on sessions they legitimately own. Like every
    // other degraded-mode route here, render 200 with the "unavailable"
    // banner instead — the degraded page carries no session data beyond the
    // slug the caller already supplied, so nothing is leaked.
    if (!degraded) {
      const scope = await resolveVisibilityScope(
        c.var.isAdmin,
        c.var.userEmail,
        callerScopeResolver,
        agentService,
      );
      if (scope.agentIds !== "all") {
        const derived: SessionForVisibility =
          deriveSessionVisibilityFromTasks(tasks);
        if (!isSessionVisible(derived, scope)) {
          return new Response("Not Found", { status: 404 });
        }
      }
    }

    // SESH-5.2: the ?success=/?error= flash-message convention used
    // elsewhere in this file (e.g. the agent detail page's
    // ?success=manifest_synced handling) — set by
    // registerSessionAdminActionsRoutes()'s archive/unarchive/rename
    // redirects below.
    const successParam = c.req.query("success");
    const errorParam = c.req.query("error");
    const notice = successParam
      ? {
          kind: "success" as const,
          message: SESSION_ADMIN_ACTION_MESSAGES[successParam] ?? successParam,
        }
      : errorParam
        ? {
            kind: "error" as const,
            message: SESSION_ADMIN_ACTION_MESSAGES[errorParam] ?? errorParam,
          }
        : undefined;

    // SESH-5.3: best-effort follow-state lookup for the button's initial
    // render. Independent of the task-store `degraded` flag (it's a
    // DB-backed lookup, not a task-store fetch) — fail open to "not
    // following" on error since this is just button display state, not a
    // security check (the follow route itself enforces visibility).
    let isFollowing = false;
    try {
      isFollowing = await resolveIsFollowingSession(c.var.userEmail, sessionId);
    } catch {
      isFollowing = false;
    }

    return html(
      renderSessionDetailPage(
        sessionId,
        tasks,
        c.var.userEmail,
        degraded,
        backHref,
        prsByTaskId,
        // SSP-6.8: account users may rename/archive their own sessions.
        c.var.isAdmin || view.kind === "account",
        notice,
        isFollowing,
        view.kind === "all" && accountId
          ? `?accountId=${encodeURIComponent(accountId)}`
          : "",
      ),
    );
  });

  // ─── Session follow (SESH-6.2) ─────────────────────────────────────────────

  registerSessionFollowRoutes(app, {
    requireAuth,
    sessionFollowService,
    agentMemberService,
    callerScopeResolver,
    agentService,
    fetchTaskStoreSession,
  });

  // ─── Session admin actions: archive/unarchive/rename (SESH-5.2) ───────────

  registerSessionAdminActionsRoutes(app, {
    requireAuth,
    patchTaskStoreSession,
    callerScopeResolver,
  });

  // ─── Notification settings (SESH-6.3) ─────────────────────────────────────

  registerSessionSettingsRoutes(app, {
    requireAuth,
    sessionFollowService,
    pushEnabled,
    vapidPublicKey,
    pushService,
    timezone,
    html,
  });

  // ─── PRs ─────────────────────────────────────────────────────────────────

  app.get("/admin/prs", requireAuth, async (c) => {
    const view = await resolveTaskStoreView(c.var.isAdmin, c.var.userEmail);
    if (view.kind === "none") return new Response("Forbidden", { status: 403 });
    const ts = scopedTaskStore(
      view.kind === "account" ? view.accountId : undefined,
    );

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

    const fetchPrs = ts.fetchPrs;
    const fetchTask = ts.fetchTask;
    if (!fetchPrs) {
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
        if (!fetchTask) {
          taskFilterUnresolved = true;
        } else {
          try {
            const task = await fetchTask(taskId);
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
          const result = await fetchPrs(params);
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
    const fetchTasks = ts.fetchTasks;
    if (fetchTasks && prs.length > 0) {
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
              const result = await fetchTasks(
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

    const suggestions = ts.fetchDistinct
      ? await ts
          .fetchDistinct()
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
    const view = await resolveTaskStoreView(c.var.isAdmin, c.var.userEmail);
    if (view.kind === "none") return new Response("Forbidden", { status: 403 });
    const ts = scopedTaskStore(
      view.kind === "account" ? view.accountId : undefined,
    );
    if (!ts.fetchPrById) return c.redirect("/admin/prs", 302);
    const prId = c.req.param("id");
    let pr: PrListItem | null = null;
    try {
      pr = await ts.fetchPrById(prId);
    } catch {
      return c.redirect("/admin/prs", 302);
    }
    // SSP-6.8: another account's PR id is indistinguishable from a missing one.
    if (!pr && view.kind === "account") return NOT_FOUND();
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
    if (ts.fetchTasks) {
      try {
        const result = await ts.fetchTasks(
          new URLSearchParams({ repo: pr.repo, pr: String(pr.prNumber) }),
        );
        linkedTasks = result.tasks;
      } catch {
        linkedTasks = [];
      }
    }

    // Fetch recorded verification-check outcomes (LVB-5.1) for this PR —
    // absence of the fetcher or a failed lookup renders the page without a
    // Verification Checks section, never a 500.
    let verificationChecks: VerificationCheckItem[] = [];
    if (ts.fetchChecks) {
      try {
        verificationChecks = await fetchRecentVerificationChecks(
          ts.fetchChecks,
          { prId },
        );
      } catch {
        // swallow — page renders without Verification Checks section
      }
    }

    return html(
      renderPrDetailPage(
        pr,
        c.var.userEmail,
        agentNames,
        timezone,
        linkedTasks,
        verificationChecks,
      ),
    );
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
