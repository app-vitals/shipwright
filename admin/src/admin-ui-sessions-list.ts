/**
 * admin/src/admin-ui-sessions-list.ts
 * GET /admin/sessions — the Sessions list page (SESH-4.2).
 *
 * Renders three sections (Waiting on you / Active / Closed) plus an
 * Archived filter, with state/repo/agent/q/sort query filters and
 * limit/offset pagination. Access is scoped via session-scope.ts (SESH-4.1):
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

import type { Hono, MiddlewareHandler } from "hono";
import type { AdminUIEnv } from "./admin-ui.ts";
import { renderAdminPage } from "./admin-ui-layout.ts";
import {
  renderRepoOrgFilterFields,
  resolveAgentNameFilterAndPaginate,
} from "./admin-ui-pages.ts";
import { escapeHtml, renderAdminToolbar } from "./admin-ui-styles.ts";
import type { AgentMemberService } from "./agent-members.ts";
import type { AgentService } from "./agents.ts";
import type { SessionFollowService } from "./session-follow-service.ts";
import {
  isSessionVisible,
  type VisibilityScope,
  visibleAgentIdsFor,
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
  fetchTaskStoreSessions?: (params: URLSearchParams) => Promise<{
    sessions: Session[];
    total: number;
    limit: number;
    offset: number;
  }>;
  /**
   * Fetch distinct session/repo/org values from the task-store service.
   * Used to populate the Org/Repo multiselect and Agent datalist
   * autocomplete suggestions in the filter form — same dep shape as the
   * Tasks page's identically-named dep. If absent, the filter fields still
   * render (no crash) but with no autocomplete suggestions.
   */
  fetchDistinctTaskValues?: () => Promise<{
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
}

// ─── Scope resolution ───────────────────────────────────────────────────────

/**
 * Resolves the caller's VisibilityScope from their email + isAdmin flag.
 * An admin sees every session ("all", repos unused). A non-admin member's
 * scope is the union of their memberships' agent ids plus those agents'
 * own repos[] — a member with zero memberships resolves to an empty scope
 * (no I/O beyond the membership lookup, no throw).
 *
 * Shared by both the sessions list route (this module) and the session
 * detail route's updated gate (admin-ui.ts), so both apply the exact same
 * visibility rule.
 */
export async function resolveVisibilityScope(
  isAdmin: boolean,
  userEmail: string,
  agentMemberService: SessionsListAgentMemberService,
  agentService: SessionsListAgentService,
): Promise<VisibilityScope> {
  if (isAdmin) return { agentIds: "all", repos: [] };

  const memberships = await agentMemberService.listByEmail(
    userEmail.toLowerCase(),
  );
  const agentIdScope = visibleAgentIdsFor(false, memberships);
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
  return `<tr>
    <td><a href="/admin/sessions/${encodeURIComponent(session.slug)}" style="color:#6366f1;text-decoration:none;font-weight:500">${escapeHtml(title)}</a>${slugHtml}</td>
    <td style="font-size:12px">${badgeList(agentLabels, "badge-gray")}</td>
    <td style="font-size:12px">${badgeList(session.repos, "badge-purple")}</td>
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
): string {
  return `<div class="card" style="margin-bottom:16px">
    <div class="card-title" style="font-size:12px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">${escapeHtml(label)} (${sessions.length})</div>
    <div class="data-table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Agents</th>
            <th>Repos</th>
            <th>Open/Total</th>
            <th>Waiting since</th>
            <th>Last activity</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${
            sessions.length === 0
              ? `<tr><td colspan="7" class="empty-state">No sessions.</td></tr>`
              : sessions
                  .map((s) =>
                    sessionRow(s, agentNames, followedSlugs, timezone),
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
  pagination: {
    total: number;
    limit: number;
    offset: number;
    /**
     * True when `sessions` was narrowed client-side by the member-visibility
     * filter, so total/limit/offset describe the task-store's pre-filter
     * result set rather than the rows actually rendered. The summary is
     * relabelled accordingly instead of misstating a visible-row count.
     */
    scoped?: boolean;
  } = {
    total: 0,
    limit: 50,
    offset: 0,
  },
  suggestions?: { orgs?: string[]; repos?: string[]; agents?: string[] },
  timezone?: string,
): string {
  const degradedHtml = degraded
    ? `<div class="alert alert-warning">Task store unavailable — data shown may be stale or empty.</div>`
    : "";

  const makeUrl = (
    overrides: Partial<{ archived: boolean; offset: number }>,
  ): string => {
    const params = new URLSearchParams();
    for (const r of filters.repo) params.append("repo", r);
    for (const o of filters.org) params.append("org", o);
    if (filters.agentId) params.set("agent", filters.agentId);
    if (filters.q) params.set("q", filters.q);
    if (filters.sort !== "waitingSince") params.set("sort", filters.sort);
    const archived = overrides.archived ?? filters.archived;
    if (archived) params.set("archived", "true");
    const offset = overrides.offset ?? pagination.offset;
    if (offset > 0) params.set("offset", String(offset));
    const qs = params.toString();
    return `${SESSIONS_LIST_PATH}${qs ? `?${qs}` : ""}`;
  };

  const archivedToggle = filters.archived
    ? `<a href="${makeUrl({ archived: false, offset: 0 })}" class="btn btn-secondary" style="font-size:12px">← Back to active sessions</a>`
    : `<a href="${makeUrl({ archived: true, offset: 0 })}" class="btn btn-secondary" style="font-size:12px">Archived</a>`;

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
      ),
    ).join("\n");
  }

  const totalPages = Math.max(
    1,
    Math.ceil(pagination.total / pagination.limit),
  );
  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const rangeEnd = Math.min(
    pagination.offset + pagination.limit,
    pagination.total,
  );
  // For a scoped member the rendered rows are a client-side subset of the
  // task-store page, so "X–Y of Z" would overstate what's actually visible.
  // Lead with the true visible-row count and label the range/total as the
  // pre-filter result set the Prev/Next controls actually traverse.
  const summaryHtml = pagination.scoped
    ? `<span title="Only sessions you have access to are listed; the range and total describe all sessions matching your filters.">${sessions.length} visible in results ${pagination.offset + 1}–${rangeEnd} of ${pagination.total}</span>`
    : `<span>${pagination.offset + 1}–${rangeEnd} of ${pagination.total}</span>`;
  const paginationHtml =
    pagination.total === 0
      ? ""
      : `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;font-size:12px;color:#6b7280">
      ${summaryHtml}
      <div style="display:flex;gap:4px">
        ${currentPage > 1 ? `<a href="${makeUrl({ offset: Math.max(0, pagination.offset - pagination.limit) })}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">← Prev</a>` : ""}
        ${currentPage < totalPages ? `<a href="${makeUrl({ offset: pagination.offset + pagination.limit })}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">Next →</a>` : ""}
      </div>
    </div>`;

  return renderAdminPage({
    title: "Sessions — Shipwright Admin",
    body: `${renderAdminToolbar(userName, SESSIONS_LIST_PATH)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Sessions</h1>
    </div>
    ${degradedHtml}
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
    const offsetRaw = c.req.query("offset");
    const offset = offsetRaw
      ? Math.max(0, Number.parseInt(offsetRaw, 10) || 0)
      : 0;

    const filters: SessionsListFilters = {
      repo,
      org,
      agentId,
      q,
      sort,
      archived,
    };

    const scope = await resolveVisibilityScope(
      isAdmin,
      userEmail,
      deps.agentMemberService,
      deps.agentService,
    );

    // A member with zero memberships can see nothing — short-circuit
    // without ever calling the task store, rendering an empty page rather
    // than an error (AC2).
    if (scope.agentIds !== "all" && scope.agentIds.length === 0) {
      return deps.html(
        renderSessionsListPage([], filters, false, userEmail, {}, new Set(), {
          total: 0,
          limit,
          offset,
        }),
      );
    }

    let sessions: Session[] = [];
    let total = 0;
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
            offset,
            matches: (session, matchedAgentIds) =>
              session.agentIds.some((id) => matchedAgentIds.has(id)),
            fetchPage: async (fetchLimit, fetchOffset) => {
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
              params.set("limit", String(fetchLimit));
              params.set("offset", String(fetchOffset));
              const fetched = await fetchTaskStoreSessions(params);
              return { items: fetched.sessions, total: fetched.total };
            },
          }),
          deps.fetchDistinctTaskValues
            ? deps.fetchDistinctTaskValues().catch(() => null)
            : Promise.resolve(null),
        ]);
        sessions = result.items;
        total = result.total;
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
    const scoped = scope.agentIds !== "all";
    if (scoped) {
      sessions = sessions.filter((s) =>
        isSessionVisible({ agentIds: s.agentIds, repos: s.repos }, scope),
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
    const followedSlugs = new Set(
      (await deps.sessionFollowService.listByUser(userEmail)).map(
        (f) => f.sessionSlug,
      ),
    );

    // Build autocomplete suggestions only when task-store integration is
    // active — skip the extra agentService.listOptions() call entirely when
    // fetchDistinctTaskValues is not configured (degraded mode).
    const suggestions =
      deps.fetchDistinctTaskValues && distinctValues
        ? {
            orgs: distinctValues.orgs,
            repos: distinctValues.repos,
            agents: (await deps.agentService.listOptions()).map((a) => a.name),
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
          total,
          limit,
          offset,
          // total/limit/offset are the task-store's pre-filter values; flag
          // that so the summary doesn't claim they describe the rendered rows.
          scoped,
        },
        suggestions,
        deps.timezone,
      ),
    );
  });
}
