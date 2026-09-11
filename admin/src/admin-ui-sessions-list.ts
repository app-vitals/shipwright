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
import { renderAdminPage } from "./admin-ui-layout.ts";
import { escapeHtml, renderAdminToolbar } from "./admin-ui-styles.ts";
import type { AdminUIEnv } from "./admin-ui.ts";
import type { AgentMemberService } from "./agent-members.ts";
import type { AgentService } from "./agents.ts";
import {
  isSessionVisible,
  visibleAgentIdsFor,
  type VisibilityScope,
} from "./session-scope.ts";

export const SESSIONS_LIST_PATH = "/admin/sessions";

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
export type SessionsListAgentService = Pick<AgentService, "listByIds">;

export interface SessionsListDeps {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  agentMemberService: SessionsListAgentMemberService;
  agentService: SessionsListAgentService;
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
  /** admin-ui.ts's shared response helper (headers + PWA head-tag injection). */
  html: (content: string, opts?: { status?: number }) => Response;
}

export interface SessionsListFilters {
  repo: string[];
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

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return escapeHtml(value);
  return escapeHtml(d.toLocaleString());
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

function sessionRow(session: Session): string {
  const title = session.title?.trim() || session.slug;
  return `<tr>
    <td><a href="/admin/sessions/${encodeURIComponent(session.slug)}" style="color:#6366f1;text-decoration:none;font-weight:500">${escapeHtml(title)}</a></td>
    <td class="mono" style="font-size:11px">${escapeHtml(session.slug)}</td>
    <td style="font-size:12px">${badgeList(session.agentIds, "badge-gray")}</td>
    <td style="font-size:12px">${badgeList(session.repos, "badge-purple")}</td>
    <td style="font-size:12px">${session.counts.open}/${session.counts.total}</td>
    <td style="font-size:12px">${formatTimestamp(session.waitingSince)}</td>
    <td style="font-size:12px">${formatTimestamp(session.lastActivityAt)}</td>
    <td style="text-align:right">
      <!-- Follow/Following toggle stub (SESH-4.2) — visual only, not yet
           wired to SessionFollowService (SES-6.1). A future task wires this
           to POST /admin/settings/notifications' follow/unfollow actions. -->
      <button type="button" class="btn btn-secondary follow-toggle-stub" style="font-size:11px;padding:3px 10px" disabled title="Follow is not wired up yet">Follow</button>
    </td>
  </tr>`;
}

function renderSection(label: string, sessions: Session[]): string {
  return `<div class="card" style="margin-bottom:16px">
    <div class="card-title" style="font-size:12px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">${escapeHtml(label)} (${sessions.length})</div>
    <div class="data-table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Slug</th>
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
              ? `<tr><td colspan="8" class="empty-state">No sessions.</td></tr>`
              : sessions.map(sessionRow).join("\n")
          }
        </tbody>
      </table>
    </div>
  </div>`;
}

export function renderSessionsListPage(
  sessions: Session[],
  filters: SessionsListFilters,
  degraded: boolean,
  userName: string,
  pagination: { total: number; limit: number; offset: number } = {
    total: 0,
    limit: 50,
    offset: 0,
  },
): string {
  const degradedHtml = degraded
    ? `<div class="alert alert-warning">Task store unavailable — data shown may be stale or empty.</div>`
    : "";

  const makeUrl = (
    overrides: Partial<{ archived: boolean; offset: number }>,
  ): string => {
    const params = new URLSearchParams();
    for (const r of filters.repo) params.append("repo", r);
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
      <input id="agent" name="agent" type="text" class="form-input" value="${escapeHtml(filters.agentId ?? "")}" />
    </div>
    <div class="form-group" style="margin:0">
      <label class="form-label" for="repo">Repo</label>
      <input id="repo" name="repo" type="text" class="form-input" value="${escapeHtml(filters.repo[0] ?? "")}" />
    </div>
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
  </form>`;

  let sectionsHtml: string;
  if (filters.archived) {
    sectionsHtml = renderSection("Archived", sessions);
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
      renderSection(label, bySection.get(key) ?? []),
    ).join("\n");
  }

  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.limit));
  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const paginationHtml =
    pagination.total === 0
      ? ""
      : `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0;font-size:12px;color:#6b7280">
      <span>${pagination.offset + 1}–${Math.min(pagination.offset + pagination.limit, pagination.total)} of ${pagination.total}</span>
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
  </div>`,
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

    const filters: SessionsListFilters = { repo, agentId, q, sort, archived };

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
        renderSessionsListPage([], filters, false, userEmail, {
          total: 0,
          limit,
          offset,
        }),
      );
    }

    let sessions: Session[] = [];
    let total = 0;
    let degraded = false;

    if (!deps.fetchTaskStoreSessions) {
      degraded = true;
    } else {
      const params = new URLSearchParams();
      // state=all/archived (never the default-omitted filter) — the three
      // main sections are bucketed client-side from the full, unfiltered
      // set so Waiting/Active/Closed can all render from one request.
      params.set("state", archived ? "archived" : "all");
      params.set("sort", sort);
      for (const r of repo) params.append("repo", r);
      if (agentId) params.set("agentId", agentId);
      if (q) params.set("q", q);
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      try {
        const result = await deps.fetchTaskStoreSessions(params);
        sessions = result.sessions;
        total = result.total;
      } catch {
        degraded = true;
      }
    }

    // Member scoping: the task store has no "any of these agent ids OR
    // these repos" filter, only ANDed single-value narrowing — so the
    // access-control filter is applied client-side against the full
    // fetched page, on top of (not instead of) the user's own repo/agent/q
    // filters already forwarded above.
    if (scope.agentIds !== "all") {
      sessions = sessions.filter((s) =>
        isSessionVisible({ agentIds: s.agentIds, repos: s.repos }, scope),
      );
    }

    return deps.html(
      renderSessionsListPage(sessions, filters, degraded, userEmail, {
        total,
        limit,
        offset,
      }),
    );
  });
}
