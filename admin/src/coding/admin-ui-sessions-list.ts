/**
 * admin/src/coding/admin-ui-sessions-list.ts
 * GET /admin/sessions — the Sessions list page (SESH-4.2).
 *
 * Renders three sections (Waiting on you / Active / Closed) plus an
 * Archived filter, with state/repo/agent/q/sort query filters and
 * cursor (Prev/Next) pagination. Access is scoped via session-scope.ts (SESH-4.1):
 * an admin sees every session; a non-admin member sees only sessions with a
 * task assigned to one of their agents, or in one of those agents' repos.
 * A member with zero AgentMember rows sees an empty page, not an error.
 *
 * Distinct from admin-ui-sessions.ts (GET/POST /admin/settings/notifications
 * — per-user session follow/notification preferences, SESH-6.3) — that
 * module owns a different, unrelated route and is left untouched.
 *
 * Registered into admin-ui.ts's app via registerSessionsListRoutes(),
 * following the same "extracted route module" shape as
 * registerSessionSettingsRoutes()/admin-ui-sessions.ts.
 */

import type { AdminUIEnv } from "@app-vitals/agent-admin/admin-ui";
import { renderAdminPage } from "@app-vitals/agent-admin/admin-ui-layout";
import {
  escapeHtml,
  renderAdminToolbar,
} from "@app-vitals/agent-admin/admin-ui-styles";
import type { AgentMemberService } from "@app-vitals/agent-admin/agent-members";
import type { AgentService } from "@app-vitals/agent-admin/agents";
import {
  type CallerScopeResolver,
  memberOnlyCallerScopeResolver,
} from "@app-vitals/agent-admin/caller-scope";
import type { Hono, MiddlewareHandler } from "hono";
import {
  renderRepoOrgFilterFields,
  resolveAgentNameFilterAndPaginate,
} from "./admin-ui-work-item-pages.ts";
import {
  applyCursorState,
  type CursorPagination,
  type CursorState,
  parseCursorState,
  renderCursorPager,
} from "./cursor-paging.ts";
import { DEFAULT_ACCOUNT_ID } from "./default-account.ts";
import {
  documentsSummary,
  type OwnerView,
  resolveOwnerView,
  type SessionDocument,
} from "./session-documents.ts";
import type { SessionFollowService } from "./session-follow-service.ts";
import {
  accountIdFromCallerScope,
  agentIdScopeFromCallerScope,
  isSessionVisible,
  type VisibilityScope,
} from "./session-scope.ts";

const SESSIONS_LIST_PATH = "/admin/sessions";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Mirrors task-store/src/openapi-schemas.ts's SessionSchema — a Session
 * row's own fields flattened together with its computed session-rollup
 * fields (agentIds/repos/counts/state/etc.), as returned by GET /sessions.
 */
export interface Session {
  slug: string;
  title?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  archivedBy?: string | null;
  state: "waiting" | "active" | "closed" | "empty";
  waitingSince: string | null;
  lastActivityAt: string | null;
  counts: { total: number; open: number; closed: number };
  agentIds: string[];
  repos: string[];
  waitingTasks: Array<{
    id: string;
    kind: "hitl" | "blocked" | "pr_blocked";
  }>;
  archived: boolean;
  /** Owner email, set from the session's first document (PLU-5.1). */
  owner?: string | null;
  /** The org/repo the session's planning files live in. */
  homeRepo?: string | null;
  /** The session's planning documents. */
  documents?: SessionDocument[];
  /** The session's account (SSP-6.7); every task-store row carries one. */
  accountId?: string;
}

/** The narrow slice of AgentMemberService this module calls. */
export type SessionsListAgentMemberService = Pick<
  AgentMemberService,
  "listByEmail"
>;

/** The narrow slice of AgentService this module calls. */
export type SessionsListAgentService = Pick<
  AgentService,
  "listByIds" | "listOptions" | "searchByName"
>;

export interface SessionsListDeps {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  agentMemberService: SessionsListAgentMemberService;
  /** Account-aware scope resolver (SSP-2.1); defaults to AgentMember-only. */
  callerScopeResolver?: CallerScopeResolver;
  agentService: SessionsListAgentService;
  /**
   * Resolves which sessions the current user already follows (SESH-6.1/
   * SESH-6.2). Called once per request — via listByUser(userEmail) — and
   * the resulting slugs are threaded down into each row's Follow button
   * rather than resolved per-row, mirroring the single agentService.listByIds
   * call already made for agentNames.
   */
  sessionFollowService: Pick<SessionFollowService, "listByUser">;
  /**
   * Fetch sessions from the task-store service. If absent, the page renders
   * in degraded mode (empty sections + a warning banner) rather than 500ing.
   */
  fetchTaskStoreSessions?: (
    params: URLSearchParams,
    accountId?: string,
  ) => Promise<{
    sessions: Session[];
    total: number;
    limit: number;
    nextCursor?: string | null;
  }>;
  /**
   * Fetch distinct session/repo/org values from the task-store service.
   * Used to populate the Org/Repo multiselect and Agent datalist
   * autocomplete suggestions in the filter form — same dep shape as the
   * Tasks page's identically-named dep. If absent, the filter fields still
   * render (no crash) but with no autocomplete suggestions.
   */
  fetchDistinctTaskValues?: (accountId?: string) => Promise<{
    sessions: string[];
    repos: string[];
    orgs: string[];
  }>;
  /**
   * IANA timezone name for date/time display. Defaults to
   * "America/Los_Angeles" when absent (mirrors every other admin page).
   */
  timezone?: string;
  /** admin-ui.ts's shared response helper (headers + PWA head-tag injection). */
  html: (content: string, opts?: { status?: number }) => Response;
}

interface SessionsListFilters {
  repo: string[];
  org: string[];
  agentId?: string;
  q?: string;
  sort: "waitingSince" | "lastActivityAt";
  archived: boolean;
  /** Mine / All / specific-owner view, kept in the URL as `?owner=`. */
  ownerView: OwnerView;
}

// ─── Scope resolution ───────────────────────────────────────────────────────

/**
 * Resolves the caller's VisibilityScope from their email + isAdmin flag.
 * An admin sees every session ("all", repos unused). A non-admin member's
 * scope is the union of their memberships' agent ids plus those agents'
 * own repos[] — a member with zero memberships resolves to an empty scope
 * (no I/O beyond the membership lookup, no throw). An account user
 * (SSP-6.8, flag on) instead gets an account scope: their account's sessions,
 * fetched server-side via the task-store's `?accountId=`.
 *
 * Shared by both the sessions list route (this module) and the session
 * detail route's updated gate (admin-ui.ts), so both apply the exact same
 * visibility rule.
 */
export async function resolveVisibilityScope(
  isAdmin: boolean,
  userEmail: string,
  callerScopeResolver: CallerScopeResolver,
  agentService: SessionsListAgentService,
): Promise<VisibilityScope> {
  if (isAdmin) return { agentIds: "all", repos: [] };

  const callerScope = await callerScopeResolver(userEmail, false);
  const agentIdScope = agentIdScopeFromCallerScope(callerScope);
  // SSP-6.8: an account user (flag on) sees exactly their account's
  // sessions — account membership, not agent/repo overlap, decides — so
  // they keep access even before their account has any agents.
  const accountId = accountIdFromCallerScope(callerScope);
  if (accountId !== null) {
    return {
      agentIds: agentIdScope === "all" ? [] : agentIdScope,
      repos: [],
      accountId,
    };
  }
  if (agentIdScope === "all" || agentIdScope.length === 0) {
    return { agentIds: [], repos: [] };
  }

  const agents = await agentService.listByIds(agentIdScope);
  const repos = [...new Set(agents.flatMap((a) => a.repos ?? []))];
  return { agentIds: agentIdScope, repos };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const SECTION_META: Array<{
  key: "waiting" | "active" | "closed";
  label: string;
}> = [
  { key: "waiting", label: "Waiting on you" },
  { key: "active", label: "Active" },
  { key: "closed", label: "Closed" },
];

function formatTimestamp(
  value: string | null | undefined,
  timezone?: string,
): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return escapeHtml(value);
  return escapeHtml(d.toLocaleString(undefined, { timeZone: timezone }));
}

function badgeList(values: string[], badgeClass: string): string {
  if (values.length === 0) return '<span style="color:#9ca3af">—</span>';
  return values
    .map(
      (v) =>
        `<span class="badge ${badgeClass}" style="margin-right:4px">${escapeHtml(v)}</span>`,
    )
    .join("");
}

function sessionRow(
  session: Session,
  agentNames: Record<string, string>,
  followedSlugs: Set<string>,
  timezone?: string,
  showAccount = false,
): string {
  const title = session.title?.trim() || session.slug;
  // The Slug row renders only when it actually differs from the title —
  // when there's no custom title, `title` already fell back to `session.slug`
  // above, so a separate slug line underneath would just duplicate it.
  const slugHtml =
    session.slug !== title
      ? `<div class="mono" style="font-size:11px;color:#9ca3af">${escapeHtml(session.slug)}</div>`
      : "";
  const agentLabels = session.agentIds.map((id) => agentNames[id] ?? id);
  // SESH-6.2/FLW-1.1: live Follow/Following toggle, mirroring the session
  // detail page's #session-follow-btn (admin-ui-pages.ts) but class-based
  // since there's one per row — the page's single delegated <script>
  // (renderSessionsListPage) handles clicks for every row via that class.
  const isFollowing = followedSlugs.has(session.slug);
  // SSP-6.8: an admin's link into a non-default account's session carries
  // that account, so the detail page (and its actions) address the right
  // [accountId, slug] row rather than the default account's.
  const accountQuery =
    showAccount && session.accountId && session.accountId !== DEFAULT_ACCOUNT_ID
      ? `?accountId=${encodeURIComponent(session.accountId)}`
      : "";
  const docs = documentsSummary(session.documents);
  const documentsCell =
    docs.specCount === 0 && !docs.needsAttention
      ? '<span style="color:#9ca3af">—</span>'
      : `${docs.specCount} ${docs.specCount === 1 ? "spec" : "specs"}${
          docs.needsAttention
            ? ' <span class="badge badge-warning" title="A document is a draft, has an open PR, or was abandoned">unmerged</span>'
            : ""
        }`;
  const accountCell = showAccount
    ? `<td style="font-size:12px">${badgeList(session.accountId ? [session.accountId] : [], "badge-gray")}</td>`
    : "";
  return `<tr>
    <td><a href="/admin/sessions/${encodeURIComponent(session.slug)}${accountQuery}" style="color:#6366f1;text-decoration:none;font-weight:500">${escapeHtml(title)}</a>${slugHtml}</td>${accountCell}
    <td style="font-size:12px">${session.owner ? escapeHtml(session.owner) : '<span style="color:#9ca3af">—</span>'}</td>
    <td style="font-size:12px">${badgeList(agentLabels, "badge-gray")}</td>
    <td style="font-size:12px">${badgeList(session.repos, "badge-purple")}</td>
    <td style="font-size:12px">${documentsCell}</td>
    <td style="font-size:12px">${session.counts.open}/${session.counts.total}</td>
    <td style="font-size:12px">${formatTimestamp(session.waitingSince, timezone)}</td>
    <td style="font-size:12px">${formatTimestamp(session.lastActivityAt, timezone)}</td>
    <td style="text-align:right">
      <button type="button" class="btn btn-secondary session-follow-btn" style="font-size:11px;padding:3px 10px" data-slug="${escapeHtml(session.slug)}" data-following="${isFollowing ? "true" : "false"}">${isFollowing ? "Following" : "Follow"}</button>
    </td>
  </tr>`;
}

function renderSection(
  label: string,
  sessions: Session[],
  agentNames: Record<string, string>,
  followedSlugs: Set<string>,
  timezone?: string,
  showAccount = false,
): string {
  return `<div class="card" style="margin-bottom:16px">
    <div class="card-title" style="font-size:12px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">${escapeHtml(label)} (${sessions.length})</div>
    <div class="data-table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Session</th>${showAccount ? "\n            <th>Account</th>" : ""}
            <th>Owner</th>
            <th>Agents</th>
            <th>Repos</th>
            <th>Documents</th>
            <th>Open/Total</th>
            <th>Waiting since</th>
            <th>Last activity</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${
            sessions.length === 0
              ? `<tr><td colspan="${showAccount ? 10 : 9}" class="empty-state">No sessions.</td></tr>`
              : sessions
                  .map((s) =>
                    sessionRow(
                      s,
                      agentNames,
                      followedSlugs,
                      timezone,
                      showAccount,
                    ),
                  )
                  .join("\n")
          }
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderSessionsListPage(
  sessions: Session[],
  filters: SessionsListFilters,
  degraded: boolean,
  userName: string,
  agentNames: Record<string, string>,
  followedSlugs: Set<string>,
  pagination: CursorPagination & {
    /**
     * True when `sessions` was narrowed client-side by the member-visibility
     * filter, so total/limit describe the task-store's pre-filter
     * result set rather than the rows actually rendered. The summary is
     * relabelled accordingly instead of misstating a visible-row count.
     */
    scoped?: boolean;
  } = {
    count: 0,
    total: 0,
    limit: 50,
    state: { prev: [] },
  },
  suggestions?: { orgs?: string[]; repos?: string[]; agents?: string[] },
  timezone?: string,
  /** Platform admins get an Account column (SSP-6.8). */
  showAccount = false,
): string {
  const degradedHtml = degraded
    ? `<div class="alert alert-warning">Task store unavailable — data shown may be stale or empty.</div>`
    : "";

  const makeUrl = (
    overrides: Partial<{
      archived: boolean;
      owner: string;
      /** Cursor target; omitted = first page (filter/view changes reset). */
      cursorState: CursorState;
    }>,
  ): string => {
    const params = new URLSearchParams();
    // The view is always written explicitly so the URL reflects (and a
    // reload preserves) what the page is showing, including a defaulted Mine.
    const owner =
      overrides.owner ??
      (filters.ownerView.mode === "all" ? "all" : filters.ownerView.owner);
    params.set("owner", owner);
    for (const r of filters.repo) params.append("repo", r);
    for (const o of filters.org) params.append("org", o);
    if (filters.agentId) params.set("agent", filters.agentId);
    if (filters.q) params.set("q", filters.q);
    if (filters.sort !== "waitingSince") params.set("sort", filters.sort);
    const archived = overrides.archived ?? filters.archived;
    if (archived) params.set("archived", "true");
    applyCursorState(params, overrides.cursorState ?? null);
    const qs = params.toString();
    return `${SESSIONS_LIST_PATH}${qs ? `?${qs}` : ""}`;
  };

  const archivedToggle = filters.archived
    ? `<a href="${makeUrl({ archived: false })}" class="btn btn-secondary" style="font-size:12px">← Back to active sessions</a>`
    : `<a href="${makeUrl({ archived: true })}" class="btn btn-secondary" style="font-size:12px">Archived</a>`;

  const ownerSwitch = (() => {
    const tab = (label: string, active: boolean, href: string) =>
      `<a href="${escapeHtml(href)}" class="btn ${active ? "btn-primary" : "btn-secondary"}" style="font-size:12px"${active ? ' aria-current="true"' : ""}>${label}</a>`;
    const view = filters.ownerView;
    const mine = view.mode === "mine";
    const other =
      view.mode === "owner"
        ? `<span class="badge badge-gray">Owner: ${escapeHtml(view.owner)}</span>`
        : "";
    return `<div id="owner-switch" style="display:flex;gap:6px;align-items:center;margin-bottom:16px">
      ${userName ? tab("Mine", mine, makeUrl({ owner: userName })) : ""}
      ${tab("All", view.mode === "all", makeUrl({ owner: "all" }))}
      ${other}
    </div>`;
  })();

  const filterForm = `<form method="GET" action="${SESSIONS_LIST_PATH}" class="card" style="margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
    <div class="form-group" style="margin:0">
      <label class="form-label" for="q">Search</label>
      <input id="q" name="q" type="text" class="form-input" value="${escapeHtml(filters.q ?? "")}" placeholder="slug or title" />
    </div>
    <div class="form-group" style="margin:0">
      <label class="form-label" for="agent">Agent</label>
      <input id="agent" name="agent" type="text" class="form-input" value="${escapeHtml(filters.agentId ?? "")}"${suggestions?.agents?.length ? ' list="agents-list"' : ""} />
    </div>
    ${renderRepoOrgFilterFields(
      { org: filters.org, repo: filters.repo },
      { orgs: suggestions?.orgs, repos: suggestions?.repos },
    )}
    <div class="form-group" style="margin:0">
      <label class="form-label" for="sort">Sort</label>
      <select id="sort" name="sort" class="form-input">
        <option value="waitingSince"${filters.sort === "waitingSince" ? " selected" : ""}>Waiting since</option>
        <option value="lastActivityAt"${filters.sort === "lastActivityAt" ? " selected" : ""}>Last activity</option>
      </select>
    </div>
    <input type="hidden" name="owner" value="${escapeHtml(filters.ownerView.mode === "all" ? "all" : filters.ownerView.owner)}" />
    ${filters.archived ? '<input type="hidden" name="archived" value="true" />' : ""}
    <button type="submit" class="btn btn-primary" style="font-size:12px">Filter</button>
    ${archivedToggle}
    ${suggestions?.agents?.length ? `<datalist id="agents-list">${suggestions.agents.map((a) => `<option value="${escapeHtml(a)}">`).join("")}</datalist>` : ""}
  </form>`;

  let sectionsHtml: string;
  if (filters.archived) {
    sectionsHtml = renderSection(
      "Archived",
      sessions,
      agentNames,
      followedSlugs,
      timezone,
      showAccount,
    );
  } else {
    const bySection = new Map<string, Session[]>();
    for (const s of sessions) {
      // Archived sessions only show under the Archived filter, never mixed
      // into Waiting/Active/Closed — even if the caller passed state=all
      // upstream and an archived session's own rollup state happened to
      // land in one of these three buckets.
      if (s.archivedAt) continue;
      const bucket = bySection.get(s.state);
      if (bucket) bucket.push(s);
      else bySection.set(s.state, [s]);
    }
    sectionsHtml = SECTION_META.map(({ key, label }) =>
      renderSection(
        label,
        bySection.get(key) ?? [],
        agentNames,
        followedSlugs,
        timezone,
        showAccount,
      ),
    ).join("\n");
  }

  // For a scoped member the rendered rows are a client-side subset of the
  // task-store page, so a plain "N of Z" would overstate what's actually
  // visible. Lead with the true visible-row count and label the total as the
  // pre-filter result set the Prev/Next controls actually traverse.
  const summary = pagination.scoped
    ? `<span title="Only sessions you have access to are listed; the total describes all sessions matching your filters.">${sessions.length} visible of ${pagination.total} matching</span>`
    : `${sessions.length} shown of ${pagination.total}`;
  const paginationHtml =
    pagination.total === 0
      ? ""
      : renderCursorPager(
          pagination,
          (cursorState) => makeUrl({ cursorState }),
          { summary, topPadding: "12px 0" },
        );

  return renderAdminPage({
    title: "Sessions — Shipwright Admin",
    body: `${renderAdminToolbar(userName, SESSIONS_LIST_PATH)}
  <div class="vos-page vos-page-wide">
    <div class="page-header">
      <h1 class="page-title">Sessions</h1>
    </div>
    ${degradedHtml}
    ${ownerSwitch}
    ${filterForm}
    ${sectionsHtml}
    ${paginationHtml}
  </div>
  <script>
  (function() {
    document.addEventListener('click', function(e) {
      var target = e.target;
      if (!target || !target.classList || !target.classList.contains('session-follow-btn')) return;
      var btn = target;
      var slug = btn.getAttribute('data-slug');
      var following = btn.getAttribute('data-following') === 'true';
      var action = following ? 'unfollow' : 'follow';
      btn.disabled = true;
      fetch('/admin/sessions/' + encodeURIComponent(slug) + '/' + action, {
        method: 'POST',
      }).then(function(r) {
        if (!r.ok) throw new Error('request failed');
        return r.json();
      }).then(function(data) {
        var nowFollowing = Boolean(data && data.following);
        btn.setAttribute('data-following', nowFollowing ? 'true' : 'false');
        btn.textContent = nowFollowing ? 'Following' : 'Follow';
      }).catch(function() {
        // Leave the button's prior state/label in place on failure.
      }).finally(function() {
        btn.disabled = false;
      });
    });
  })();
  </script>`,
  });
}

// ─── Route registration ────────────────────────────────────────────────────────

/**
 * Registers GET /admin/sessions onto the given app. Called from
 * admin-ui.ts's createAdminUIApp() alongside its other route-registration
 * blocks.
 */
export function registerSessionsListRoutes(
  app: Hono<AdminUIEnv>,
  deps: SessionsListDeps,
): void {
  app.get(SESSIONS_LIST_PATH, deps.requireAuth, async (c) => {
    const isAdmin = c.var.isAdmin;
    const userEmail = c.var.userEmail;

    const archived = c.req.query("archived") === "true";
    const repo = c.req.queries("repo") ?? [];
    const org = c.req.queries("org") ?? [];
    const agentId = c.req.query("agent") || undefined;
    const q = c.req.query("q") || undefined;
    const sort: "waitingSince" | "lastActivityAt" =
      c.req.query("sort") === "lastActivityAt"
        ? "lastActivityAt"
        : "waitingSince";
    const limitRaw = c.req.query("limit");
    const limit = limitRaw
      ? Math.max(1, Number.parseInt(limitRaw, 10) || 50)
      : 50;
    const cursorState = parseCursorState(
      c.req.query("cursor"),
      c.req.query("prev"),
    );

    const ownerParam = c.req.query("owner");

    const scope = await resolveVisibilityScope(
      isAdmin,
      userEmail,
      deps.callerScopeResolver ??
        memberOnlyCallerScopeResolver(deps.agentMemberService),
      deps.agentService,
    );

    // SSP-6.8: an account user's sessions are filtered server-side.
    const accountId =
      typeof scope.accountId === "string" ? scope.accountId : undefined;

    // PLU-5.1: Mine / All. With no `?owner=`, default to Mine only when the
    // signed-in user actually owns a session (one cheap limit=1 probe,
    // best-effort — any failure or missing dep falls back to All).
    let ownsAny = false;
    if (
      ownerParam === undefined &&
      userEmail &&
      deps.fetchTaskStoreSessions &&
      !(
        accountId === undefined &&
        scope.agentIds !== "all" &&
        scope.agentIds.length === 0
      )
    ) {
      try {
        const probe = new URLSearchParams({
          state: "all",
          owner: userEmail,
          limit: "1",
        });
        ownsAny =
          (await deps.fetchTaskStoreSessions(probe, accountId)).total > 0;
      } catch {
        ownsAny = false;
      }
    }
    const ownerView = resolveOwnerView(ownerParam, userEmail, ownsAny);
    const filters: SessionsListFilters = {
      repo,
      org,
      agentId,
      q,
      sort,
      archived,
      ownerView,
    };

    // A member with zero memberships can see nothing — short-circuit
    // without ever calling the task store, rendering an empty page rather
    // than an error (AC2).
    if (
      accountId === undefined &&
      scope.agentIds !== "all" &&
      scope.agentIds.length === 0
    ) {
      return deps.html(
        renderSessionsListPage([], filters, false, userEmail, {}, new Set(), {
          count: 0,
          total: 0,
          limit,
          state: cursorState,
        }),
      );
    }

    let sessions: Session[] = [];
    let total = 0;
    let nextCursor: string | null = null;
    let degraded = false;
    let distinctValues: {
      sessions: string[];
      repos: string[];
      orgs: string[];
    } | null = null;

    const fetchTaskStoreSessions = deps.fetchTaskStoreSessions;
    if (!fetchTaskStoreSessions) {
      degraded = true;
    } else {
      try {
        // `agentId` (from the `agent` query param) is actually the agent's
        // display *name* — it's what the filter form's datalist suggests
        // (agentService.listOptions() returns names, not ids) — while the
        // task-store's GET /sessions ?agentId filter matches against real
        // agent ids (rollup.agentIds). resolveAgentNameFilterAndPaginate
        // resolves the name to its matching id set via searchByName() and
        // filters/re-paginates client-side, the same flow the Tasks page
        // uses for its own name-based agent filter (admin-ui.ts).
        const [result, distinct] = await Promise.all([
          resolveAgentNameFilterAndPaginate<Session>({
            agentName: agentId,
            searchByName: (name) => deps.agentService.searchByName(name),
            limit,
            cursor: cursorState.cursor,
            matches: (session, matchedAgentIds) =>
              session.agentIds.some((id) => matchedAgentIds.has(id)),
            fetchPage: async (fetchLimit, fetchCursor) => {
              const params = new URLSearchParams();
              // state=all/archived (never the default-omitted filter) —
              // the three main sections are bucketed client-side from the
              // full, unfiltered set so Waiting/Active/Closed can all
              // render from one request.
              params.set("state", archived ? "archived" : "all");
              params.set("sort", sort);
              for (const r of repo) params.append("repo", r);
              for (const o of org) params.append("org", o);
              if (q) params.set("q", q);
              if (ownerView.mode !== "all")
                params.set("owner", ownerView.owner);
              params.set("limit", String(fetchLimit));
              if (fetchCursor) params.set("cursor", fetchCursor);
              const fetched = await fetchTaskStoreSessions(params, accountId);
              return {
                items: fetched.sessions,
                total: fetched.total,
                nextCursor: fetched.nextCursor,
              };
            },
          }),
          deps.fetchDistinctTaskValues
            ? deps.fetchDistinctTaskValues(accountId).catch(() => null)
            : Promise.resolve(null),
        ]);
        sessions = result.items;
        total = result.total;
        nextCursor = result.nextCursor;
        distinctValues = distinct;
      } catch {
        degraded = true;
      }
    }

    // Member scoping: the task store has no "any of these agent ids OR
    // these repos" filter, only ANDed single-value narrowing — so the
    // access-control filter is applied client-side against the full
    // fetched page, on top of (not instead of) the user's own repo/agent/q
    // filters already forwarded above.
    // An account user's page is already exactly their account's rows
    // (server-side), so the pagination summary stays accurate for them; the
    // isSessionVisible pass below is defense in depth.
    const scoped = scope.agentIds !== "all" && accountId === undefined;
    if (scope.agentIds !== "all") {
      sessions = sessions.filter((s) =>
        isSessionVisible(
          { agentIds: s.agentIds, repos: s.repos, accountId: s.accountId },
          scope,
        ),
      );
    }

    // Resolve agent ids → names across the fetched page, same pattern as
    // every other admin page (agentNames[id] ?? id fallback in sessionRow).
    const agentIds = [...new Set(sessions.flatMap((s) => s.agentIds))];
    const agentNames: Record<string, string> = {};
    if (agentIds.length > 0) {
      const agents = await deps.agentService.listByIds(agentIds);
      for (const a of agents) agentNames[a.id] = a.name;
    }

    // Batch-resolve which of the fetched rows the current user already
    // follows via a single listByUser() call — mirrors the agentNames
    // resolution above (one call per page render, not one per row).
    //
    // Best-effort, exactly like the session detail page's equivalent lookup.
    // Independent of the task-store `degraded` flag (it's a DB-backed lookup,
    // not a task-store fetch) — fail open to "not following" on error since
    // this is just button display state, not a security check (the follow
    // route itself enforces visibility). A failure here must not 500 the whole
    // list and take the Waiting/Active/Closed sections down with it.
    let followedSlugs = new Set<string>();
    try {
      followedSlugs = new Set(
        (await deps.sessionFollowService.listByUser(userEmail)).map(
          (f) => f.sessionSlug,
        ),
      );
    } catch {
      followedSlugs = new Set();
    }

    // Build autocomplete suggestions only when task-store integration is
    // active — skip the extra agentService.listOptions() call entirely when
    // fetchDistinctTaskValues is not configured (degraded mode).
    const suggestions =
      deps.fetchDistinctTaskValues && distinctValues
        ? {
            orgs: distinctValues.orgs,
            repos: distinctValues.repos,
            // An account user is only offered their own agents' names.
            agents: (accountId !== undefined
              ? await deps.agentService.listByIds(
                  scope.agentIds === "all" ? [] : scope.agentIds,
                )
              : await deps.agentService.listOptions()
            ).map((a) => a.name),
          }
        : undefined;

    return deps.html(
      renderSessionsListPage(
        sessions,
        filters,
        degraded,
        userEmail,
        agentNames,
        followedSlugs,
        {
          count: sessions.length,
          total,
          limit,
          state: cursorState,
          nextCursor,
          // total is the task-store's pre-filter value; flag that so the
          // summary doesn't claim it describes the rendered rows.
          scoped,
        },
        suggestions,
        deps.timezone,
        isAdmin,
      ),
    );
  });
}
