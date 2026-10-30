/**
 * admin/src/coding/admin-ui-work-item-pages.ts
 * Pure HTML rendering for the coding agent's task-store work-item views:
 * the tasks page (table + board), task detail, session detail (task-state
 * classification, needs-you panel, dependency graph layout), and the PRs
 * list/detail pages. Moved out of admin-ui-pages.ts (AEP-3.2); mounted by the
 * coding AdminExtension's admin UI routes (admin-ui-coding.ts).
 */

import { renderAdminPage } from "@app-vitals/agent-admin/admin-ui-layout";
import {
  relativeTime,
  renderMarkdown,
} from "@app-vitals/agent-admin/admin-ui-pages";
import {
  escapeHtml,
  renderAdminToolbar,
} from "@app-vitals/agent-admin/admin-ui-styles";
import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import {
  renderVerificationChecksCard,
  type VerificationCheckItem,
} from "./admin-ui-verification-cards.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Renders a link to a task's detail page, styled like the rest of the admin UI's inline links. */
export function taskLink(taskId: string): string {
  return `<a href="/admin/tasks/${escapeHtml(taskId)}" style="color:#6366f1;text-decoration:none">${escapeHtml(taskId)}</a>`;
}

/**
 * Renders a link to an agent's detail page. `label` defaults to the agent id
 * but callers pass a display name (e.g. "Xray Agent (agent-x)") when one is
 * available from an `agentNames` lookup map, keeping the link text
 * human-readable while still routing by id.
 */
export function agentLink(agentId: string, label?: string): string {
  return `<a href="/admin/agents/${escapeHtml(agentId)}" style="color:#6366f1;text-decoration:none">${escapeHtml(label ?? agentId)}</a>`;
}

// Inline type — mirrors task-store/src/blocked-by.ts without cross-package coupling.
export type BlockedByEntry =
  | { type: "hitl"; notified?: true }
  | { type: "dependency"; id: string; status: string }
  | { type: "blocked"; reason: string | null };

// Inline type mirroring PullRequest fields relevant to the task detail UI.
// Avoids cross-package coupling to @shipwright/task-store.
export interface PullRequestItem {
  id: string;
  repo: string;
  prNumber: number;
  state: string;
  reviewState: string;
  patchCycles: number;
  reviewCycles: number;
  reviewedAt?: string | null;
  patchedAt?: string | null;
}

// Inline type for the PR list/detail admin UI.
// Mirrors PullRequest model fields without cross-package coupling.
export interface PrListItem {
  id: string;
  repo: string;
  prNumber: number;
  staged: boolean;
  state: string;
  reviewState: string;
  commitSha?: string | null;
  patchCycles: number;
  reviewCycles: number;
  agentId?: string | null;
  claimedBy?: string | null;
  reviewedAt?: string | null;
  patchedAt?: string | null;
  mergedAt?: string | null;
  claimedAt?: string | null;
  heartbeatAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  blocked?: boolean | null;
  blockedReason?: string | null;
  skipCount?: number | null;
  lastSkippedAt?: string | null;
  /** Tenant account (SSP-6.1); always present on task-store responses. */
  accountId?: string;
}

export interface TaskItem {
  id: string;
  title: string;
  status: string;
  session?: string | null;
  repo?: string | null;
  assignee?: string | null;
  claimedBy?: string | null;
  // Detail fields — populated on single-task fetch
  description?: string | null;
  acceptanceCriteria?: string[];
  branch?: string | null;
  pr?: number | null;
  prUrl?: string | null;
  dependencies?: string[];
  priority?: string | null;
  type?: string | null;
  layer?: string | null;
  source?: string | null;
  issue?: string | null;
  note?: string | null;
  blockedReason?: string | null;
  model?: string | null;
  complexity?: number | null;
  hitl?: boolean | null;
  hours?: number | null;
  kind?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  blockedAt?: string | null;
  claimedAt?: string | null;
  heartbeatAt?: string | null;
  agentHint?: string | null;
  mergeCommit?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  blockedBy?: BlockedByEntry[] | null;
  skipCount?: number | null;
  lastSkippedAt?: string | null;
  /** Tenant account (SSP-6.1); always present on task-store responses. */
  accountId?: string;
}

function statusBadgeClass(s: string): string {
  if (s === "in_progress" || s === "pr_open" || s === "approved")
    return "badge-blue";
  if (s === "done" || s === "deployed" || s === "merged") return "badge-green";
  if (s === "blocked" || s === "cancelled") return "badge-red";
  return "badge-gray";
}

/**
 * Normalize a filter value that may be a single string (legacy/bookmarked
 * URL, e.g. `?repo=org/repo`) or an array of strings (repeated query params,
 * e.g. `?repo=a&repo=b`) into an array. Absent values normalize to `[]`.
 */
function toFilterArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Shared org/repo multiselect filter fields, used by the Tasks page filter
 * form (and, eventually, the PRs page — ORF-2.2). Renders two native
 * `<select multiple>` elements — Org and Repo — populated from
 * `suggestions.orgs` / `suggestions.repos`, with `<option selected>` for any
 * value present in the currently-active filters. A native multiselect
 * submits repeated query params on GET with no client JS required.
 *
 * Any active filter value not present in the suggestions list is still
 * rendered as a selected option, so a value from a stale/edited-by-hand URL
 * isn't silently dropped from the visible selection.
 */
export function renderRepoOrgFilterFields(
  filters: { org?: string | string[]; repo?: string | string[] },
  suggestions?: { orgs?: string[]; repos?: string[] },
): string {
  const activeOrgs = new Set(toFilterArray(filters.org));
  const activeRepos = new Set(toFilterArray(filters.repo));

  const orgOptionValues = new Set([
    ...(suggestions?.orgs ?? []),
    ...activeOrgs,
  ]);
  const repoOptionValues = new Set([
    ...(suggestions?.repos ?? []),
    ...activeRepos,
  ]);

  const renderOptions = (values: Set<string>, active: Set<string>) =>
    [...values]
      .map((v) => {
        const selected = active.has(v) ? " selected" : "";
        return `<option value="${escapeHtml(v)}"${selected}>${escapeHtml(v)}</option>`;
      })
      .join("");

  return `<div class="form-group scope-select-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Org</label>
          <select name="org" multiple class="form-input scope-select" style="font-size:12px;padding:4px 8px">${renderOptions(orgOptionValues, activeOrgs)}</select>
        </div>
        <div class="form-group scope-select-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Repo</label>
          <select name="repo" multiple class="form-input scope-select" style="font-size:12px;padding:4px 8px">${renderOptions(repoOptionValues, activeRepos)}</select>
        </div>`;
}

/**
 * Shared "filter by agent display name, not id" resolver/paginator.
 *
 * The task-store's list endpoints (GET /tasks, GET /sessions) only support
 * narrowing by real agent *id* (assignee/claimedBy or rollup.agentIds) — they
 * have no "match by display name" filter, and there's no OR-of-ids filter
 * either. So when a caller's filter form offers a name-based datalist (every
 * admin list page that filters by agent), the name has to be resolved to the
 * set of matching agent ids first, and membership in that set has to be
 * checked client-side against a widened, unpaginated fetch — otherwise a
 * fuzzy/partial name match that hits N agents can't be expressed as a single
 * upstream query, and normal limit/offset pagination would undercount pages
 * once the client-side filter narrows the result set.
 *
 * Originally lived inline in the Tasks page route (admin-ui.ts); extracted
 * here so the Sessions page route (admin-ui-sessions-list.ts) can share the
 * exact same resolve → widen-fetch → filter → recompute-total → re-slice
 * flow instead of carrying its own divergent copy. The two callers' list
 * items have different shapes (TaskItem's assignee/claimedBy vs. Session's
 * agentIds array), so the membership check is injected via `matches` rather
 * than hardcoded here.
 *
 * When `agentName` is absent/empty, this is a passthrough: `fetchPage` runs
 * once with the caller's own requested limit/offset and no filtering happens
 * (`filterActive: false`). When `agentName` is present, `searchByName` runs
 * once to resolve it to zero or more agent ids (a name with zero matches
 * still produces a valid, empty result rather than an error), `fetchPage`
 * runs once at limit 500 / offset 0 to gather a page large enough to filter
 * against client-side, and the result is filtered, its total recomputed from
 * the filtered set, and re-sliced to the caller's originally-requested
 * limit/offset (`filterActive: true`).
 */
export async function resolveAgentNameFilterAndPaginate<T>(options: {
  agentName: string | undefined;
  searchByName: (name: string) => Promise<Array<{ id: string }>>;
  limit: number;
  offset: number;
  matches: (item: T, matchedAgentIds: Set<string>) => boolean;
  fetchPage: (
    limit: number,
    offset: number,
  ) => Promise<{ items: T[]; total: number }>;
}): Promise<{ items: T[]; total: number; filterActive: boolean }> {
  const { agentName, searchByName, limit, offset, matches, fetchPage } =
    options;

  if (!agentName) {
    const { items, total } = await fetchPage(limit, offset);
    return { items, total, filterActive: false };
  }

  const matchedAgents = await searchByName(agentName);
  const matchedAgentIds = new Set(matchedAgents.map((a) => a.id));

  // Widen to a single large page (matching every other client-side filter
  // in this codebase) rather than paginating the upstream fetch, since the
  // filtered total isn't known until every candidate row has been fetched.
  const { items: fetched } = await fetchPage(500, 0);
  const filtered = fetched.filter((item) => matches(item, matchedAgentIds));

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    filterActive: true,
  };
}

// ─── Tasks page ──────────────────────────────────────────────────────────────

// Shared by both the board (default) and table (?view=table) layouts.
const TASKS_PAGE_EXTRA_STYLES = `
    /* Same precedent as .chat-thread-page: .tasks-board-page has equal
       specificity to .vos-page's own max-width:960px rule, but wins the
       cascade tie because extraStyles renders after baseStyles() — so only
       the board (AXR-1.3's 5-column Kanban) stretches full width; table
       view and every other admin page stay capped. The
       @media (max-width:640px) padding rule for .vos-page (@app-vitals/agent-lib/web/toolbar)
       is untouched and still applies here. */
    .tasks-board-page { max-width:none;width:100% }
    .badge-blue { background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe; }
    .badge-green { background:#dcfce7;color:#166534;border:1px solid #bbf7d0; }
    .badge-red { background:#fee2e2;color:#991b1b;border:1px solid #fecaca; }
    .badge-hitl { background:#fff7ed;color:#c2410c;border:1px solid #fed7aa; }
    .badge-dep { background:#fefce8;color:#a16207;border:1px solid #fde047; }
    .alert-warning { background:#fefce8;color:#854d0e;border:1px solid #fde047;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:13px; }
    /* ─── Task board card slide-over drawer (AXR-1.4) ────────────────────── */
    .task-drawer-toggle { position:absolute;opacity:0;width:1px;height:1px;pointer-events:none }
    .task-drawer-scrim {
      display:none;position:fixed;inset:0;z-index:101;
      background:rgba(0,0,0,0.4);cursor:pointer;
    }
    .task-drawer-toggle:checked ~ .task-drawer-scrim { display:block }
    .task-drawer {
      position:fixed;top:0;right:0;bottom:0;z-index:102;
      width:100%;max-width:400px;min-width:300px;
      background:#fff;border-left:1px solid #e8e8ee;
      overflow-y:auto;
      transform:translateX(100%);
      transition:transform 0.2s ease;
    }
    .task-drawer-toggle:checked ~ .task-drawer { transform:translateX(0) }
    @media (prefers-reduced-motion: reduce) {
      .task-drawer { transition:none }
    }
  `;

export function renderTasksPage(
  tasks: TaskItem[],
  filters: {
    status?: string;
    state?: "ready" | "in_progress" | "blocked" | "closed";
    session?: string;
    repo?: string | string[];
    org?: string | string[];
    source?: string;
    agent?: string;
    hitl?: "true" | "false";
  },
  degraded: boolean,
  userName: string,
  agentNames: Record<string, string> = {},
  pagination: { total: number; limit: number; page: number } = {
    total: 0,
    limit: 50,
    page: 1,
  },
  opts?: { error?: string; agentFilterActive?: boolean },
  suggestions?: {
    sessions?: string[];
    repos?: string[];
    orgs?: string[];
    agents?: string[];
  },
  readOnly = false,
  timezone = "America/Los_Angeles",
  // Joined PR data (blocked/blockedReason/claimedBy/claimedAt/heartbeatAt),
  // keyed by task id — populated only by GET /admin/tasks (AXR-1.2). Left
  // undefined/empty by GET /public/tasks so the read-only board never
  // performs or renders the join (AC3).
  prsByTaskId: Record<string, PrListItem> = {},
  // Which layout to render. "table" is the pre-redesign dense table (the
  // function's default, so every pre-AXR-1.3 caller — including the large
  // existing unit-test suite that calls this positionally without a `view`
  // argument — keeps producing byte-identical output with zero changes).
  // GET /admin/tasks (admin-ui.ts) is the only caller that overrides this:
  // it defaults the *page* a user sees to "board" and only passes "table"
  // through when the request carries ?view=table (AXR-1.3 AC4). GET
  // /public/tasks never passes a view, so it stays on the table renderer.
  view: "board" | "table" = "table",
  // Reference "current" time for board-card age badges (TBC-1.1). Mirrors
  // renderPrsPage's own trailing `now` parameter: defaulted here (rather
  // than required) so the large pre-existing positional-call unit-test
  // suite keeps working unchanged, while the render chain itself never
  // calls `new Date()` internally (t2_clock_injection). GET /admin/tasks
  // passes `new Date()` explicitly at its call site.
  now: Date = new Date(),
): string {
  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const degradedHtml = degraded
    ? `<div class="alert alert-warning">Task store unavailable — data shown may be stale or empty.</div>`
    : "";

  const agentFilterHtml = opts?.agentFilterActive
    ? `<div class="alert alert-warning">Showing up to 500 results — agent name filter is applied client-side and may not reflect all matching tasks.</div>`
    : "";

  const renderBlockerBadges = (
    blockedBy: BlockedByEntry[] | null | undefined,
  ): string => {
    if (!blockedBy || blockedBy.length === 0) return "";
    return blockedBy
      .map((b) => {
        if (b.type === "hitl") {
          return `<span class="badge badge-hitl" style="font-size:10px;margin-left:6px">Waiting: HITL</span>`;
        }
        if (b.type === "blocked") {
          return `<span class="badge badge-dep" style="font-size:10px;margin-left:6px">Blocked: ${escapeHtml(b.reason ?? "Blocked")}</span>`;
        }
        return `<span class="badge badge-dep" style="font-size:10px;margin-left:6px">Blocked: ${readOnly ? escapeHtml(b.id) : taskLink(b.id)}</span>`;
      })
      .join("");
  };

  const renderKindBadge = (kind: string | null | undefined): string => {
    if (kind === "prd") {
      return `<span class="badge badge-purple" style="font-size:10px;margin-left:6px">PRD</span>`;
    }
    return "";
  };

  if (view === "board") {
    return renderTasksBoard({
      tasks,
      filters,
      userName,
      agentNames,
      suggestions,
      readOnly,
      prsByTaskId,
      errorHtml,
      degradedHtml,
      agentFilterHtml,
      renderBlockerBadges,
      renderKindBadge,
      page: pagination.page,
      now,
    });
  }

  // Pagination (hoisted above the row loop so row links can carry the current
  // list view as a `from` back-link param — see makePageUrl usage below).
  const totalPages = Math.max(
    1,
    Math.ceil(pagination.total / pagination.limit),
  );
  const page = pagination.page;
  const makePageUrl = (p: number) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    else if (filters.state) params.set("state", filters.state);
    if (filters.session) params.set("session", filters.session);
    for (const r of toFilterArray(filters.repo)) params.append("repo", r);
    for (const o of toFilterArray(filters.org)) params.append("org", o);
    if (filters.source) params.set("source", filters.source);
    if (filters.agent) params.set("agent", filters.agent);
    if (filters.hitl) params.set("hitl", filters.hitl);
    if (p > 1) params.set("page", String(p));
    // Keep self-referential links inside this view — bare /admin/tasks now
    // defaults to the board (AXR-1.3), so every link generated in this
    // table-view branch must carry ?view=table forward or it silently
    // bounces the user back to the board (TBF-1.1).
    params.set("view", "table");
    const qs = params.toString();
    return `/admin/tasks${qs ? `?${qs}` : ""}`;
  };

  // The URL the user is currently viewing. makePageUrl always carries
  // ?view=table forward (TBF-1.1 — bare /admin/tasks now defaults to the
  // board per AXR-1.3), so this is never the bare "/admin/tasks" default;
  // row links into the Task Detail and Session Detail pages always carry it
  // as `?from=` so their "← Tasks" back link returns to this table view
  // (with its filters) instead of falling through to the board.
  const currentListUrl = makePageUrl(page);
  const detailHrefSuffix = `?from=${encodeURIComponent(currentListUrl)}`;

  const rows =
    tasks.length === 0
      ? `<tr><td colspan="10" class="empty-state">No tasks found.</td></tr>`
      : tasks
          .map((t) => {
            const agentId = t.claimedBy ?? t.assignee;
            const agentCell = agentId
              ? readOnly
                ? escapeHtml(agentNames[agentId] ?? agentId)
                : agentLink(agentId, agentNames[agentId] ?? agentId)
              : '<span style="color:#9ca3af">—</span>';
            const blockerBadges = renderBlockerBadges(t.blockedBy);
            const kindBadge = renderKindBadge(t.kind);
            const prCell =
              t.pr && t.repo
                ? `<a href="https://github.com/${escapeHtml(t.repo)}/pull/${t.pr}" style="color:#6366f1;text-decoration:none" title="View PR">#${t.pr}</a>`
                : t.prUrl
                  ? `<a href="${escapeHtml(t.prUrl)}" style="color:#6366f1;text-decoration:none" title="View PR">#${t.pr ?? "PR"}</a>`
                  : '<span style="color:#9ca3af">—</span>';
            const createdCell = t.createdAt
              ? escapeHtml(
                  (() => {
                    const d = new Date(t.createdAt as string);
                    return Number.isNaN(d.getTime())
                      ? (t.createdAt as string)
                      : d.toLocaleString("en-US", {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: timezone,
                        });
                  })(),
                )
              : '<span style="color:#9ca3af">—</span>';
            const detailHref = `/admin/tasks/${escapeHtml(t.id)}${detailHrefSuffix}`;
            // Joined PR data attributes — rendered only when the join map
            // has an entry for this task (i.e. only from GET /admin/tasks;
            // GET /public/tasks always passes an empty map, so this stays
            // absent there). Raw plumbing for AXR-1.3's board UI; not yet
            // rendered as a visible badge here (AXR-1.2 scope is the join +
            // bucketing function only, not the board UI itself).
            const joinedPr = prsByTaskId[t.id];
            const prJoinAttrs = joinedPr
              ? ` data-pr-blocked="${joinedPr.blocked === true ? "true" : "false"}" data-pr-blocked-reason="${escapeHtml(joinedPr.blockedReason ?? "")}" data-pr-claimed-by="${escapeHtml(joinedPr.claimedBy ?? "")}" data-pr-claimed-at="${escapeHtml(joinedPr.claimedAt ?? "")}" data-pr-heartbeat-at="${escapeHtml(joinedPr.heartbeatAt ?? "")}"`
              : "";
            return `<tr${readOnly ? "" : ` data-href="${detailHref}" style="cursor:pointer"`}${prJoinAttrs}>
    <td class="mono" style="font-size:11px">${readOnly ? escapeHtml(t.id) : `<a href="${detailHref}" style="color:#6366f1;text-decoration:none" title="View details">${escapeHtml(t.id)}</a>`}</td>
    <td>${readOnly ? escapeHtml(t.title) : `<a href="${detailHref}" style="color:inherit;text-decoration:none">${escapeHtml(t.title)}</a>`}${blockerBadges}${kindBadge}</td>
    <td><span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status)}</span></td>
    <td style="font-size:12px">${agentCell}</td>
    <td class="col-session mono" style="font-size:11px">${
      t.session
        ? readOnly
          ? escapeHtml(t.session)
          : `<a href="/admin/sessions/${encodeURIComponent(t.session)}${detailHrefSuffix}" style="color:#6366f1;text-decoration:none">${escapeHtml(t.session)}</a>`
        : '<span style="color:#9ca3af">—</span>'
    }</td>
    <td class="col-repo mono" style="font-size:11px">${t.repo ? escapeHtml(t.repo) : '<span style="color:#9ca3af">—</span>'}</td>
    <td class="col-source mono" style="font-size:11px">${t.source ? escapeHtml(t.source) : '<span style="color:#9ca3af">—</span>'}</td>
    <td class="mono" style="font-size:11px">${prCell}</td>
    <td class="col-created" style="font-size:12px">${createdCell}</td>
    ${
      readOnly
        ? ""
        : `<td>${
            t.status === "in_progress"
              ? `<form method="POST" action="/admin/tasks/${escapeHtml(t.id)}/release?from=${encodeURIComponent(currentListUrl)}" style="display:inline">
        <button type="submit" class="btn btn-secondary" style="font-size:11px;padding:3px 8px">Release</button>
      </form>`
              : ""
          }</td>`
    }
  </tr>`;
          })
          .join("\n");

  // State toggle params (preserve other filters, reset page)
  const makeStateParams = (newState: string) => {
    const p = new URLSearchParams();
    p.set("state", newState);
    if (filters.session) p.set("session", filters.session);
    for (const r of toFilterArray(filters.repo)) p.append("repo", r);
    for (const o of toFilterArray(filters.org)) p.append("org", o);
    if (filters.source) p.set("source", filters.source);
    if (filters.agent) p.set("agent", filters.agent);
    if (filters.hitl) p.set("hitl", filters.hitl);
    // See makePageUrl above (TBF-1.1) — state-tab links must stay in table
    // view too, or clicking a tab bounces the user to the board.
    p.set("view", "table");
    const qs = p.toString();
    return qs ? `?${qs}` : "";
  };

  const activeState = filters.state;
  const tabStyle = (state: string) =>
    activeState === state
      ? "background:#6366f1;color:#fff;font-weight:600"
      : "background:#fff;color:#374151";
  const stateToggle = `
    <div style="display:flex;gap:0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;width:fit-content">
      <a href="/admin/tasks${makeStateParams("ready")}"
         class="state-tab" style="font-size:12px;text-decoration:none;${tabStyle("ready")}">Ready</a>
      <a href="/admin/tasks${makeStateParams("in_progress")}"
         class="state-tab" style="font-size:12px;text-decoration:none;border-left:1px solid #e5e7eb;${tabStyle("in_progress")}">In Progress</a>
      <a href="/admin/tasks${makeStateParams("blocked")}"
         class="state-tab" style="font-size:12px;text-decoration:none;border-left:1px solid #e5e7eb;${tabStyle("blocked")}">Blocked</a>
      <a href="/admin/tasks${makeStateParams("closed")}"
         class="state-tab" style="font-size:12px;text-decoration:none;border-left:1px solid #e5e7eb;${tabStyle("closed")}">Closed</a>
    </div>`;

  const statusOptions = [
    "",
    "pending",
    "in_progress",
    "pr_open",
    "approved",
    "merged",
    "done",
    "deploying",
    "deployed",
    "blocked",
    "cancelled",
  ]
    .map(
      (s) =>
        `<option value="${escapeHtml(s)}" ${filters.status === s ? "selected" : ""}>${s === "" ? "Any status" : escapeHtml(s)}</option>`,
    )
    .join("");

  const hitlOptions = [
    { value: "", label: "Any" },
    { value: "true", label: "Yes" },
    { value: "false", label: "No" },
  ]
    .map(
      (o) =>
        `<option value="${o.value}" ${filters.hitl === o.value ? "selected" : ""}>${o.label}</option>`,
    )
    .join("");

  const from = pagination.total === 0 ? 0 : (page - 1) * pagination.limit + 1;
  const to = Math.min(page * pagination.limit, pagination.total);
  // Suppress pagination in read-only mode: makePageUrl always returns /admin/tasks,
  // which is auth-walled, so unauthenticated visitors following Next/Prev links
  // would hit a login redirect.
  const paginationHtml =
    pagination.total === 0 || readOnly
      ? ""
      : `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0;font-size:12px;color:#6b7280">
      <span>${from}–${to} of ${pagination.total}</span>
      <div style="display:flex;gap:4px">
        ${page > 1 ? `<a href="${makePageUrl(page - 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">← Prev</a>` : ""}
        ${page < totalPages ? `<a href="${makePageUrl(page + 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">Next →</a>` : ""}
      </div>
    </div>`;

  return renderAdminPage({
    title: "Tasks — Shipwright",
    extraStyles: TASKS_PAGE_EXTRA_STYLES,
    body: `${readOnly ? "" : renderAdminToolbar(userName, "/admin/tasks")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <h1 class="page-title" style="margin:0">Tasks</h1>
      ${readOnly ? "" : stateToggle}
    </div>
    ${errorHtml}
    ${degradedHtml}
    ${agentFilterHtml}
    ${
      readOnly
        ? ""
        : `<div class="card" style="margin-bottom:16px">
      <form method="GET" action="/admin/tasks" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <input type="hidden" name="view" value="table" />
        ${filters.state && !filters.status ? `<input type="hidden" name="state" value="${escapeHtml(filters.state)}" />` : ""}
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Status</label>
          <select name="status" class="form-input" style="font-size:12px;padding:4px 8px">${statusOptions}</select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">HITL</label>
          <select name="hitl" class="form-input" style="font-size:12px;padding:4px 8px">${hitlOptions}</select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Session</label>
          <input name="session" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.session ?? "")}" placeholder="session-id"${suggestions?.sessions?.length ? ' list="sessions-list"' : ""} />
        </div>
        ${renderRepoOrgFilterFields(
          { org: filters.org, repo: filters.repo },
          { orgs: suggestions?.orgs, repos: suggestions?.repos },
        )}
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Source</label>
          <input name="source" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.source ?? "")}" placeholder="source" />
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Agent</label>
          <input name="agent" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.agent ?? "")}" placeholder="agent name"${suggestions?.agents?.length ? ' list="agents-list"' : ""} />
        </div>
        <button type="submit" class="btn btn-secondary" style="font-size:12px">Filter</button>
        <a href="/admin/tasks?view=table" class="btn btn-secondary" style="font-size:12px">Reset</a>
        ${suggestions?.sessions?.length ? `<datalist id="sessions-list">${suggestions.sessions.map((s) => `<option value="${escapeHtml(s)}">`).join("")}</datalist>` : ""}
        ${suggestions?.agents?.length ? `<datalist id="agents-list">${suggestions.agents.map((a) => `<option value="${escapeHtml(a)}">`).join("")}</datalist>` : ""}
      </form>
    </div>`
    }
    <div class="card">
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Status</th>
              <th>Assignee</th>
              <th class="col-session">Session</th>
              <th class="col-repo">Repo</th>
              <th class="col-source">Source</th>
              <th>PR</th>
              <th class="col-created">Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      ${paginationHtml}
    </div>
  </div>`,
    bodyEnd: readOnly
      ? ""
      : `<script>
    document.querySelectorAll("tr[data-href]").forEach(function(row) {
      row.addEventListener("click", function(e) {
        var target = e.target;
        while (target && target !== row) {
          if (target.tagName === "A" || target.tagName === "BUTTON" || target.tagName === "FORM" || target.tagName === "INPUT") return;
          target = target.parentElement;
        }
        window.location.href = row.getAttribute("data-href");
      });
    });
  </script>`,
  });
}

/**
 * Renders the AXR-1.3 board layout for GET /admin/tasks — 3 columns
 * (Queued/In Progress/Blocked-HITL, per TASK_BOARD_COLUMNS; Claimed and Done
 * are dropped from the default board per TBC-2.1 — both stay reachable via
 * ?view=table's status/state filters)
 * bucketed via bucketTaskColumn using each task's status/hitl/blockedBy
 * plus its joined PR's blocked flag (AXR-1.2's prsByTaskId). The default
 * filter row shows only the Org and Repo multiselects (renderRepoOrgFilterFields,
 * restyled with AXR-1.1's scope-select class) — the remaining status/HITL/
 * session/source/agent filters are collapsed under a <details
 * class="more-filters"> disclosure (AC1). Org and Repo stay two
 * independent <select multiple> controls, exactly as on the table view —
 * this function never merges them into one combined scope-pill selector,
 * so selecting an org with no repo continues to match every repo under
 * that org (AC2).
 *
 * Split out of renderTasksPage (rather than inlined behind an `if`) so the
 * pre-redesign table branch above stays textually untouched — nothing here
 * is shared by reference with that branch beyond the plain helpers passed
 * in, so a change here can't accidentally perturb ?view=table's output.
 */
function renderTasksBoard(args: {
  tasks: TaskItem[];
  filters: {
    status?: string;
    state?: "ready" | "in_progress" | "blocked" | "closed";
    session?: string;
    repo?: string | string[];
    org?: string | string[];
    source?: string;
    agent?: string;
    hitl?: "true" | "false";
  };
  userName: string;
  agentNames: Record<string, string>;
  suggestions?: {
    sessions?: string[];
    repos?: string[];
    orgs?: string[];
    agents?: string[];
  };
  readOnly: boolean;
  prsByTaskId: Record<string, PrListItem>;
  errorHtml: string;
  degradedHtml: string;
  agentFilterHtml: string;
  renderBlockerBadges: (
    blockedBy: BlockedByEntry[] | null | undefined,
  ) => string;
  renderKindBadge: (kind: string | null | undefined) => string;
  page: number;
  // Reference "current" time for card age badges (TBC-1.1) — threaded down
  // from renderTasksPage so renderCard (defined below) never calls
  // `new Date()` itself (t2_clock_injection).
  now: Date;
}): string {
  const {
    tasks,
    filters,
    userName,
    agentNames,
    suggestions,
    readOnly,
    prsByTaskId,
    errorHtml,
    degradedHtml,
    agentFilterHtml,
    renderBlockerBadges,
    renderKindBadge,
    page,
    now,
  } = args;

  // The board's Status dropdown deliberately omits the closed statuses
  // (SESSION_CLOSED_STATUSES: merged/done/deploying/deployed/cancelled).
  // Selecting one here would set `?status=…`, which bypasses admin-ui.ts's
  // `state=open` board default and returns tasks that bucketTaskColumn maps
  // to the "done" column — a column TASK_BOARD_COLUMNS no longer renders
  // (TBC-2.1), so the board would silently show "No tasks" everywhere.
  // Those statuses stay filterable on ?view=table, whose own statusOptions
  // list (above) is unchanged and still offers every status.
  const statusOptions = [
    "",
    "pending",
    "in_progress",
    "pr_open",
    "approved",
    "merged",
    "done",
    "deploying",
    "deployed",
    "blocked",
    "cancelled",
  ]
    .filter((s) => !SESSION_CLOSED_STATUSES.has(s))
    .map(
      (s) =>
        `<option value="${escapeHtml(s)}" ${filters.status === s ? "selected" : ""}>${s === "" ? "Any status" : escapeHtml(s)}</option>`,
    )
    .join("");

  const hitlOptions = [
    { value: "", label: "Any" },
    { value: "true", label: "Yes" },
    { value: "false", label: "No" },
  ]
    .map(
      (o) =>
        `<option value="${o.value}" ${filters.hitl === o.value ? "selected" : ""}>${o.label}</option>`,
    )
    .join("");

  // Query string for the current filter selection, mirroring the table
  // view's makePageUrl param order/semantics (status/state, session, repo,
  // org, source, agent, hitl, page) so a URL built here round-trips
  // identically whether the request landed on the board or the table. The
  // board doesn't render its own state-tab or pagination controls (its 5
  // columns replace the Ready/In Progress/Blocked/Closed tabs, and it
  // shows every fetched task rather than paging through them), but a
  // bookmarked/back-linked URL carrying `state` or `page` still needs to
  // reproduce faithfully in the task/session detail "from" back-link.
  const currentBoardUrl = (() => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    else if (filters.state) params.set("state", filters.state);
    if (filters.session) params.set("session", filters.session);
    for (const r of toFilterArray(filters.repo)) params.append("repo", r);
    for (const o of toFilterArray(filters.org)) params.append("org", o);
    if (filters.source) params.set("source", filters.source);
    if (filters.agent) params.set("agent", filters.agent);
    if (filters.hitl) params.set("hitl", filters.hitl);
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return `/admin/tasks${qs ? `?${qs}` : ""}`;
  })();
  const detailHrefSuffix =
    currentBoardUrl === "/admin/tasks"
      ? ""
      : `?from=${encodeURIComponent(currentBoardUrl)}`;
  const tableViewHref = `${currentBoardUrl}${currentBoardUrl.includes("?") ? "&" : "?"}view=table`;

  const renderCard = (t: TaskItem): string => {
    const agentId = t.claimedBy ?? t.assignee;
    const agentCell = agentId
      ? readOnly
        ? escapeHtml(agentNames[agentId] ?? agentId)
        : agentLink(agentId, agentNames[agentId] ?? agentId)
      : "";
    const blockerBadges = renderBlockerBadges(t.blockedBy);
    const kindBadge = renderKindBadge(t.kind);
    // Same joined-PR attributes as the table row (AXR-1.2's prsByTaskId) —
    // rendered on the card itself so the blocked/HITL state is visible
    // inline, with no click-through required (AC3).
    const joinedPr = prsByTaskId[t.id];
    const prJoinAttrs = joinedPr
      ? ` data-pr-blocked="${joinedPr.blocked === true ? "true" : "false"}" data-pr-blocked-reason="${escapeHtml(joinedPr.blockedReason ?? "")}" data-pr-claimed-by="${escapeHtml(joinedPr.claimedBy ?? "")}" data-pr-claimed-at="${escapeHtml(joinedPr.claimedAt ?? "")}" data-pr-heartbeat-at="${escapeHtml(joinedPr.heartbeatAt ?? "")}"`
      : "";
    const prBadge =
      joinedPr?.blocked === true
        ? `<span class="badge badge-hitl" style="font-size:10px;margin-left:6px">PR Blocked${joinedPr.blockedReason ? `: ${escapeHtml(joinedPr.blockedReason)}` : ""}</span>`
        : "";
    const prLink =
      t.pr && t.repo
        ? `<a href="https://github.com/${escapeHtml(t.repo)}/pull/${t.pr}" style="color:#6366f1;text-decoration:none" title="View PR">#${t.pr}</a>`
        : t.prUrl
          ? `<a href="${escapeHtml(t.prUrl)}" style="color:#6366f1;text-decoration:none" title="View PR">#${t.pr ?? "PR"}</a>`
          : "";
    const sessionLink = t.session
      ? readOnly
        ? escapeHtml(t.session)
        : `<a href="/admin/sessions/${encodeURIComponent(t.session)}${detailHrefSuffix}" style="color:#6366f1;text-decoration:none">${escapeHtml(t.session)}</a>`
      : "";
    const detailHref = `/admin/tasks/${escapeHtml(t.id)}${detailHrefSuffix}`;
    // Same <span title="{ISO}">{relative}</span> pattern as the Queue/
    // Activity table's ageCell (~line 4108) and the cron last-run age
    // (~line 1191). A null/missing/invalid createdAt renders no badge at
    // all rather than passing an invalid Date into relativeTime (AC2).
    const createdAtDate = t.createdAt ? new Date(t.createdAt) : null;
    const ageCell =
      createdAtDate && !Number.isNaN(createdAtDate.getTime())
        ? `<span title="${escapeHtml(createdAtDate.toISOString())}">${escapeHtml(relativeTime(createdAtDate, now))}</span>`
        : "";
    const releaseForm =
      readOnly || t.status !== "in_progress"
        ? ""
        : `<form method="POST" action="/admin/tasks/${escapeHtml(t.id)}/release" style="display:inline;margin-top:6px">
        <button type="submit" class="btn btn-secondary" style="font-size:11px;padding:3px 8px">Release</button>
      </form>`;

    const cardMarkup = `<div class="card"${readOnly ? "" : ` data-drawer-toggle="task-drawer-toggle-${escapeHtml(t.id)}" style="cursor:pointer"`}${prJoinAttrs}>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="font-size:13px;font-weight:600">${readOnly ? escapeHtml(t.title) : `<a href="${detailHref}" style="color:inherit;text-decoration:none">${escapeHtml(t.title)}</a>`}</div>
          <span class="badge ${statusBadgeClass(t.status)}" style="font-size:10px;white-space:nowrap">${escapeHtml(t.status)}</span>
        </div>
        <div class="mono" style="font-size:11px;color:#9ca3af;margin-top:2px">${readOnly ? escapeHtml(t.id) : `<a href="${detailHref}" style="color:#6366f1;text-decoration:none">${escapeHtml(t.id)}</a>`}</div>
        <div style="font-size:11px;color:#6b7280;margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          ${t.repo ? `<span class="mono">${escapeHtml(t.repo)}</span>` : ""}
          ${agentCell}
          ${sessionLink}
          ${prLink}
          ${ageCell}
        </div>
        ${blockerBadges}${prBadge}${kindBadge}
        ${releaseForm}
      </div>`;

    // For readOnly, render the card without drawer wrapper
    if (readOnly) {
      return cardMarkup;
    }

    // For non-readOnly, wrap card with drawer markup
    const drawerContent = `
      <div style="padding:20px 24px">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:12px;margin-bottom:16px">
          <div>
            <h2 style="font-size:16px;font-weight:600;margin-bottom:4px">${escapeHtml(t.title)}</h2>
            <div class="mono" style="font-size:12px;color:#9ca3af">${escapeHtml(t.id)}</div>
          </div>
          <label for="task-drawer-toggle-${escapeHtml(t.id)}" style="cursor:pointer;color:#6b7280;font-size:20px;line-height:1">×</label>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px">
          <span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status)}</span>
        </div>
        ${t.repo ? `<div style="font-size:12px;color:#6b7280;margin-bottom:8px"><strong>Repo:</strong> ${escapeHtml(t.repo)}</div>` : ""}
        ${t.session ? `<div style="font-size:12px;color:#6b7280;margin-bottom:8px"><strong>Session:</strong> ${escapeHtml(t.session)}</div>` : ""}
        ${agentId ? `<div style="font-size:12px;color:#6b7280;margin-bottom:16px"><strong>Agent:</strong> ${escapeHtml(agentNames[agentId] ?? agentId)}</div>` : ""}
        ${t.description ? `<div style="font-size:13px;color:#374151;line-height:1.6;margin-bottom:16px">${renderMarkdown(t.description)}</div>` : ""}
        ${
          joinedPr
            ? `
          <div style="border-top:1px solid #e8e8ee;padding-top:16px">
            <h3 style="font-size:13px;font-weight:600;margin-bottom:8px">Pull Request</h3>
            <div style="font-size:12px;color:#6b7280;margin-bottom:4px"><strong>Number:</strong> <a href="https://github.com/${escapeHtml(joinedPr.repo)}/pull/${joinedPr.prNumber}" style="color:#6366f1;text-decoration:none">#${joinedPr.prNumber}</a></div>
            <div style="font-size:12px;color:#6b7280;margin-bottom:4px"><strong>State:</strong> ${escapeHtml(joinedPr.state)}</div>
            <div style="font-size:12px;color:#6b7280;margin-bottom:4px"><strong>Review State:</strong> ${escapeHtml(joinedPr.reviewState)}</div>
            ${joinedPr.blocked ? `<div style="font-size:12px;color:#dc2626"><strong>Blocked:</strong> ${escapeHtml(joinedPr.blockedReason ?? "Yes")}</div>` : ""}
          </div>
        `
            : ""
        }
      </div>
    `;

    return `<div class="task-card-wrap">
      <input type="checkbox" id="task-drawer-toggle-${escapeHtml(t.id)}" class="task-drawer-toggle" aria-hidden="true" tabindex="-1">
      ${cardMarkup}
      <label for="task-drawer-toggle-${escapeHtml(t.id)}" class="task-drawer-scrim" aria-label="Close task detail"></label>
      <div class="task-drawer">${drawerContent}</div>
    </div>`;
  };

  const columnsHtml = TASK_BOARD_COLUMNS.map(({ key, label }) => {
    const colTasks = tasks.filter(
      (t) => bucketTaskColumn(t, prsByTaskId[t.id]?.blocked ?? null) === key,
    );
    const cards =
      colTasks.length === 0
        ? `<div class="empty-state" style="font-size:11px">No tasks</div>`
        : colTasks.map(renderCard).join("\n");
    return `<div class="column" data-column="${key}">
        <div class="column-header"><span>${label}</span><span class="column-count">${colTasks.length}</span></div>
        ${cards}
      </div>`;
  }).join("\n");

  const filterFormHtml = readOnly
    ? ""
    : `<div class="card" style="margin-bottom:16px">
      <form method="GET" action="/admin/tasks" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        ${renderRepoOrgFilterFields(
          { org: filters.org, repo: filters.repo },
          { orgs: suggestions?.orgs, repos: suggestions?.repos },
        )}
        <button type="submit" class="btn btn-secondary" style="font-size:12px">Filter</button>
        <a href="/admin/tasks" class="btn btn-secondary" style="font-size:12px">Reset</a>
        <details class="more-filters">
          <summary>More filters</summary>
          <div class="more-filters-panel">
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" style="font-size:11px">Status</label>
              <select name="status" class="form-input" style="font-size:12px;padding:4px 8px">${statusOptions}</select>
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" style="font-size:11px">HITL</label>
              <select name="hitl" class="form-input" style="font-size:12px;padding:4px 8px">${hitlOptions}</select>
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" style="font-size:11px">Session</label>
              <input name="session" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.session ?? "")}" placeholder="session-id"${suggestions?.sessions?.length ? ' list="sessions-list"' : ""} />
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" style="font-size:11px">Source</label>
              <input name="source" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.source ?? "")}" placeholder="source" />
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" style="font-size:11px">Agent</label>
              <input name="agent" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.agent ?? "")}" placeholder="agent name"${suggestions?.agents?.length ? ' list="agents-list"' : ""} />
            </div>
          </div>
        </details>
        ${suggestions?.sessions?.length ? `<datalist id="sessions-list">${suggestions.sessions.map((s) => `<option value="${escapeHtml(s)}">`).join("")}</datalist>` : ""}
        ${suggestions?.agents?.length ? `<datalist id="agents-list">${suggestions.agents.map((a) => `<option value="${escapeHtml(a)}">`).join("")}</datalist>` : ""}
      </form>
    </div>`;

  return renderAdminPage({
    title: "Tasks — Shipwright",
    extraStyles: TASKS_PAGE_EXTRA_STYLES,
    body: `${readOnly ? "" : renderAdminToolbar(userName, "/admin/tasks")}
  <div class="vos-page tasks-board-page">
    <div class="page-header" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;justify-content:space-between">
      <h1 class="page-title" style="margin:0">Tasks</h1>
      ${readOnly ? "" : `<a href="${tableViewHref}" class="btn btn-secondary" style="font-size:12px">Table view</a>`}
    </div>
    ${errorHtml}
    ${degradedHtml}
    ${agentFilterHtml}
    ${filterFormHtml}
    <div class="board">
      ${columnsHtml}
    </div>
  </div>`,
    bodyEnd: readOnly
      ? ""
      : `<script>
    document.querySelectorAll(".column .card[data-drawer-toggle]").forEach(function(card) {
      card.addEventListener("click", function(e) {
        var target = e.target;
        while (target && target !== card) {
          if (target.tagName === "A" || target.tagName === "BUTTON" || target.tagName === "FORM" || target.tagName === "INPUT") return;
          target = target.parentElement;
        }
        var toggleId = card.getAttribute("data-drawer-toggle");
        document.querySelectorAll(".task-drawer-toggle:checked").forEach(function(openToggle) {
          if (openToggle.id !== toggleId) openToggle.checked = false;
        });
        var checkbox = document.getElementById(toggleId);
        if (checkbox) {
          checkbox.checked = true;
          checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    });
    document.addEventListener("keydown", function(e) {
      if ((e.key === "Escape" || e.key === "Esc") && document.querySelector(".task-drawer-toggle:checked")) {
        document.querySelectorAll(".task-drawer-toggle:checked").forEach(function(toggle) {
          toggle.checked = false;
          toggle.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
    });
  </script>`,
  });
}

// ─── Task detail page ────────────────────────────────────────────────────────

export function renderTaskDetailPage(
  task: TaskItem,
  userName: string,
  agentNames: Record<string, string> = {},
  timezone = "America/Los_Angeles",
  pullRequest?: PullRequestItem,
  backHref = "/admin/tasks",
  verificationChecks: VerificationCheckItem[] = [],
): string {
  const statusClass =
    task.status === "in_progress"
      ? "badge-blue"
      : task.status === "done"
        ? "badge-green"
        : "badge-gray";

  function field(
    label: string,
    value: string | null | undefined,
    mono = false,
  ): string {
    if (!value) return "";
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-size:13px${mono ? ";font-family:monospace;font-size:12px" : ""}">${escapeHtml(value)}</td>
    </tr>`;
  }

  function agentField(
    label: string,
    agentId: string | null | undefined,
  ): string {
    if (!agentId) return "";
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-size:13px;font-family:monospace;font-size:12px">${agentLink(agentId, agentNames[agentId] ? `${agentNames[agentId]} (${agentId})` : agentId)}</td>
    </tr>`;
  }

  function linkField(
    label: string,
    url: string | null | undefined,
    text?: string,
  ): string {
    if (!url) return "";
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-size:13px"><a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="color:#6366f1">${escapeHtml(text ?? url)}</a></td>
    </tr>`;
  }

  function listField(
    label: string,
    items: string[] | undefined,
    linkItem = false,
  ): string {
    if (!items || items.length === 0) return "";
    const listItems = items
      .map(
        (i) =>
          `<li style="font-size:13px;margin-bottom:4px">${linkItem ? taskLink(i) : escapeHtml(i)}</li>`,
      )
      .join("");
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:8px 12px"><ul style="margin:0;padding-left:16px">${listItems}</ul></td>
    </tr>`;
  }

  function dateField(label: string, iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    const fmt = Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: timezone,
        });
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-size:13px" title="${escapeHtml(iso)}">${escapeHtml(fmt)}</td>
    </tr>`;
  }

  const prSection = pullRequest
    ? (() => {
        const prUrl = `https://github.com/${pullRequest.repo}/pull/${pullRequest.prNumber}`;
        const reviewedFmt = pullRequest.reviewedAt
          ? dateField("Reviewed", pullRequest.reviewedAt)
          : "";
        const patchedFmt = pullRequest.patchedAt
          ? dateField("Patched", pullRequest.patchedAt)
          : "";
        return `<div class="card" style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Pull Request Review</div>
      <table class="detail-table"><tbody>
        <tr>
          <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">GitHub PR</td>
          <td style="padding:8px 12px;font-size:13px"><a href="${escapeHtml(prUrl)}" target="_blank" rel="noopener" style="color:#6366f1">#${escapeHtml(String(pullRequest.prNumber))}</a></td>
        </tr>
        <tr>
          <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">State</td>
          <td style="padding:8px 12px;font-size:13px"><span class="badge badge-gray">${escapeHtml(pullRequest.state)}</span></td>
        </tr>
        <tr>
          <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">Review State</td>
          <td style="padding:8px 12px;font-size:13px"><span class="badge badge-gray">${escapeHtml(pullRequest.reviewState)}</span></td>
        </tr>
        <tr>
          <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">Review Cycles</td>
          <td style="padding:8px 12px;font-size:13px">${escapeHtml(String(pullRequest.reviewCycles))}</td>
        </tr>
        <tr>
          <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">Patch Cycles</td>
          <td style="padding:8px 12px;font-size:13px">${escapeHtml(String(pullRequest.patchCycles))}</td>
        </tr>
        ${reviewedFmt}
        ${patchedFmt}
      </tbody></table>
    </div>`;
      })()
    : "";

  const verificationSection = renderVerificationChecksCard(
    verificationChecks,
    timezone,
  );

  const releaseButton =
    task.status === "in_progress"
      ? `<form method="POST" action="/admin/tasks/${escapeHtml(task.id)}/release" style="display:inline">
          <button type="submit" class="btn btn-secondary" style="font-size:12px">Release</button>
        </form>`
      : "";

  const descriptionSection = task.description
    ? `<div class="card" style="margin-bottom:16px">
        <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Description</div>
        <div class="markdown-body" style="font-size:14px;line-height:1.6">${renderMarkdown(task.description)}</div>
      </div>`
    : "";

  const acSection =
    task.acceptanceCriteria && task.acceptanceCriteria.length > 0
      ? `<div class="card" style="margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Acceptance Criteria</div>
          <ul style="margin:0;padding-left:16px">
            ${task.acceptanceCriteria.map((c) => `<li style="font-size:14px;line-height:1.6;margin-bottom:6px">${renderMarkdown(c)}</li>`).join("")}
          </ul>
        </div>`
      : "";

  const blockersSection =
    task.blockedBy && task.blockedBy.length > 0
      ? `<div class="card" style="margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Blockers</div>
          <ul style="margin:0;padding-left:16px">
            ${task.blockedBy
              .map((b) => {
                if (b.type === "hitl") {
                  const label = b.notified
                    ? "HITL gate (notification sent — awaiting clearance)"
                    : "HITL gate (notification pending)";
                  return `<li style="font-size:14px;line-height:1.6;margin-bottom:4px">${escapeHtml(label)}</li>`;
                }
                if (b.type === "blocked") {
                  return `<li style="font-size:14px;line-height:1.6;margin-bottom:4px">Blocked: ${escapeHtml(b.reason ?? "Blocked")}</li>`;
                }
                return `<li style="font-size:14px;line-height:1.6;margin-bottom:4px">dep:${taskLink(b.id)} (${escapeHtml(b.status)})</li>`;
              })
              .join("")}
          </ul>
        </div>`
      : "";

  const metaRows = [
    field("Status", task.status),
    field("Priority", task.priority),
    field("Type", task.type),
    field("Layer", task.layer),
    field("Kind", task.kind),
    field("Source", task.source),
    agentField("Assignee", task.assignee),
    agentField("Agent Hint", task.agentHint),
    agentField("Claimed By", task.claimedBy),
    task.session
      ? `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap">Session</td>
      <td style="padding:8px 12px;font-size:13px;font-family:monospace;font-size:12px"><a href="/admin/sessions/${encodeURIComponent(task.session)}?from=${encodeURIComponent(`/admin/tasks/${encodeURIComponent(task.id)}`)}" style="color:#6366f1">${escapeHtml(task.session)}</a></td>
    </tr>`
      : "",
    field("Repo", task.repo, true),
    field("Branch", task.branch, true),
    task.pr
      ? linkField(
          "PR",
          task.prUrl ?? `https://github.com/${task.repo}/pull/${task.pr}`,
          `#${task.pr}`,
        )
      : "",
    task.issue
      ? task.issue.startsWith("http")
        ? linkField("Issue", task.issue, task.issue)
        : field("Issue", task.issue)
      : "",
    field("Model", task.model),
    task.complexity !== null && task.complexity !== undefined
      ? field("Complexity", String(task.complexity))
      : "",
    task.hours !== null && task.hours !== undefined
      ? field("Hours", String(task.hours))
      : "",
    task.hitl !== null && task.hitl !== undefined
      ? field("HITL", task.hitl ? "yes" : "no")
      : "",
    task.skipCount ? field("Skip Count", String(task.skipCount)) : "",
    field("Note", task.note),
    field("Blocked Reason", task.blockedReason),
    field("Merge Commit", task.mergeCommit, true),
  ]
    .filter(Boolean)
    .join("\n");

  const datesRows = [
    dateField("Added", task.createdAt),
    dateField("Started", task.startedAt),
    dateField("Claimed", task.claimedAt),
    dateField("Last Heartbeat", task.heartbeatAt),
    dateField("Blocked", task.blockedAt),
    task.skipCount ? dateField("Last Skipped", task.lastSkippedAt) : "",
    dateField("Completed", task.completedAt),
    dateField("Created", task.createdAt),
    dateField("Updated", task.updatedAt),
  ]
    .filter(Boolean)
    .join("\n");

  const depsSection =
    task.dependencies && task.dependencies.length > 0
      ? listField("Dependencies", task.dependencies, true)
      : "";

  return renderAdminPage({
    title: `${task.title} — Tasks — Shipwright Admin`,
    extraStyles: `
    .badge-blue { background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe; }
    .detail-table { width:100%;border-collapse:collapse; }
    .detail-table tr:not(:last-child) td { border-bottom:1px solid #f3f4f6; }
    .markdown-body pre { background:#f3f4f6; border-radius:4px; padding:12px; overflow-x:auto; font-size:12px; }
    .markdown-body code { background:#f3f4f6; border-radius:3px; padding:1px 4px; font-size:12px; }
    .markdown-body pre code { background:none; padding:0; }
    .markdown-body ul, .markdown-body ol { padding-left:20px; margin:8px 0; }
    .markdown-body li { margin-bottom:4px; }
  `,
    body: `${renderAdminToolbar(userName, "/admin/tasks")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <a href="${escapeHtml(backHref)}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>
      <h1 class="page-title" style="margin:0;flex:1">${escapeHtml(task.title)}</h1>
      <span class="badge ${statusClass}">${escapeHtml(task.status)}</span>
      ${releaseButton}
    </div>
    <div style="margin-top:4px;margin-bottom:16px;font-family:monospace;font-size:11px;color:#9ca3af">${escapeHtml(task.id)}</div>

    ${blockersSection}
    ${descriptionSection}
    ${acSection}

    <div class="card" style="margin-bottom:16px">
      <table class="detail-table">
        <tbody>
          ${metaRows}
          ${depsSection}
        </tbody>
      </table>
    </div>

    ${
      datesRows
        ? `<div class="card" style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Timeline</div>
      <table class="detail-table"><tbody>${datesRows}</tbody></table>
    </div>`
        : ""
    }
    ${prSection}
    ${verificationSection}
  </div>`,
  });
}

// ─── Session detail page ─────────────────────────────────────────────────────

// Inline mirror of task-store/src/statuses.ts's CLOSED_STATUSES — avoids
// cross-package coupling to @shipwright/task-store (same convention as the
// other inline type mirrors in this file). Keep in sync with that file.
const SESSION_CLOSED_STATUSES = new Set([
  "merged",
  "done",
  "deploying",
  "deployed",
  "cancelled",
]);

/** Mirrors the ready/in_progress/blocked/closed taxonomy used by the Tasks
 * page's state tabs — see task-store's TaskService.listReady/listBlocked:
 * closed = terminal status; blocked = a non-empty `blockedBy` (unresolved
 * dependency or hitl wait) on any non-closed task, or explicit status
 * "blocked"; in_progress = {in_progress, pr_open, approved} with no
 * outstanding blockers; ready = "pending" with none. `blockedBy` is computed
 * server-side by the task-store's computeBlockedBy for every status (not
 * just "pending") and passed through as-is on each TaskItem — this only
 * classifies, it doesn't resolve dependencies itself. The blockedBy check
 * must run before the in_progress/pr_open/approved check so a task that's
 * technically in progress but still waiting on a dependency or a human
 * (hitl) buckets as blocked, not in_progress. Shared by the session task
 * table and the dependency graph card below so both use the same grouping.
 */
type TaskState = "ready" | "in_progress" | "blocked" | "closed";

export function classifyTaskState(t: TaskItem): TaskState {
  if (SESSION_CLOSED_STATUSES.has(t.status)) return "closed";
  if ((t.blockedBy?.length ?? 0) > 0) return "blocked";
  if (
    t.status === "in_progress" ||
    t.status === "pr_open" ||
    t.status === "approved"
  ) {
    return "in_progress";
  }
  if (t.status === "blocked") return "blocked";
  return "ready";
}

const TASK_STATE_GROUPS: { key: TaskState; label: string }[] = [
  { key: "ready", label: "Ready" },
  { key: "in_progress", label: "In Progress" },
  { key: "blocked", label: "Blocked" },
  { key: "closed", label: "Closed" },
];

// ─── Needs-you panel + header state badge (SESH-5.1) ─────────────────────────
//
// Mirrors task-store/src/session-rollup.ts's classifyWaiting precedence
// (blocked > pr_blocked > hitl), reimplemented here against the TaskItem/
// PrListItem shapes already available on the admin side — this file avoids
// importing task-store internals (same convention as the BlockedByEntry
// mirror above). A task only counts as waiting when it's open (not in
// SESSION_CLOSED_STATUSES).

type WaitingKind = "hitl" | "blocked" | "pr_blocked";

interface SessionWaitingTask {
  task: TaskItem;
  kind: WaitingKind;
}

function classifyWaitingTask(
  task: TaskItem,
  prsByTaskId: Record<string, PrListItem>,
): WaitingKind | null {
  if (task.status === "blocked") return "blocked";
  if (task.pr != null && prsByTaskId[task.id]?.blocked === true) {
    return "pr_blocked";
  }
  if (task.hitl === true) {
    const hasUnmetDependency = (task.blockedBy ?? []).some(
      (entry) => entry.type === "dependency",
    );
    if (!hasUnmetDependency) return "hitl";
  }
  return null;
}

/** Computes the session's waiting tasks — open tasks (not in
 * SESSION_CLOSED_STATUSES) that classify into a WaitingKind. `prsByTaskId`
 * defaults to `{}` so callers with no PR join simply never surface
 * "pr_blocked" rows. */
function computeSessionWaitingTasks(
  tasks: TaskItem[],
  prsByTaskId: Record<string, PrListItem> = {},
): SessionWaitingTask[] {
  const waiting: SessionWaitingTask[] = [];
  for (const t of tasks) {
    if (SESSION_CLOSED_STATUSES.has(t.status)) continue;
    const kind = classifyWaitingTask(t, prsByTaskId);
    if (kind) waiting.push({ task: t, kind });
  }
  return waiting;
}

type SessionRollupState = "waiting" | "active" | "closed" | "empty";

/** Session-level state: "empty" with zero tasks; "closed" when every task is
 * closed; "waiting" when at least one open task is waiting; else "active". */
function computeSessionState(
  tasks: TaskItem[],
  waitingTasks: SessionWaitingTask[],
): SessionRollupState {
  if (tasks.length === 0) return "empty";
  const openCount = tasks.filter(
    (t) => !SESSION_CLOSED_STATUSES.has(t.status),
  ).length;
  if (openCount === 0) return "closed";
  if (waitingTasks.length > 0) return "waiting";
  return "active";
}

/** Earliest `updatedAt` among the session's waiting tasks (mirrors
 * session-rollup.ts's `waitingSince`) — null when no waiting task carries an
 * `updatedAt`. */
function computeWaitingSince(
  waitingTasks: SessionWaitingTask[],
): string | null {
  let earliest: string | null = null;
  for (const { task } of waitingTasks) {
    if (!task.updatedAt) continue;
    if (
      earliest === null ||
      new Date(task.updatedAt).getTime() < new Date(earliest).getTime()
    ) {
      earliest = task.updatedAt;
    }
  }
  return earliest;
}

const WAITING_KIND_LABEL: Record<WaitingKind, string> = {
  hitl: "HITL",
  blocked: "Blocked",
  pr_blocked: "PR blocked",
};

const WAITING_KIND_BADGE_CLASS: Record<WaitingKind, string> = {
  hitl: "badge-purple",
  blocked: "badge-red",
  pr_blocked: "badge-warning",
};

/** Per-row reason text: blockedReason for "blocked", the joined PR's
 * blockedReason for "pr_blocked" (no natural per-task reason field exists
 * for hitl, so that case is a fixed descriptive string). */
function waitingTaskReason(
  entry: SessionWaitingTask,
  prsByTaskId: Record<string, PrListItem>,
): string | null {
  if (entry.kind === "blocked") return entry.task.blockedReason ?? null;
  if (entry.kind === "pr_blocked") {
    return prsByTaskId[entry.task.id]?.blockedReason ?? null;
  }
  return "Needs human via /shipwright:hitl";
}

/** Copyable slash-command hint for the row's kind — no clipboard JS, just
 * plain selectable text in a <code> span. */
function waitingTaskHint(entry: SessionWaitingTask): string {
  return entry.kind === "hitl"
    ? `/shipwright:hitl ${entry.task.id}`
    : `/shipwright:unblock ${entry.task.id}`;
}

function renderNeedsYouPanel(
  waitingTasks: SessionWaitingTask[],
  prsByTaskId: Record<string, PrListItem>,
): string {
  const rows = waitingTasks
    .map((entry) => {
      const { task, kind } = entry;
      const reason = waitingTaskReason(entry, prsByTaskId);
      const since = task.updatedAt ?? null;
      const prLink =
        task.prUrl != null
          ? `<a href="${escapeHtml(task.prUrl)}" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none">PR</a>`
          : '<span style="color:#9ca3af">—</span>';
      return `<tr>
        <td><span class="badge ${WAITING_KIND_BADGE_CLASS[kind]}">${escapeHtml(WAITING_KIND_LABEL[kind])}</span></td>
        <td style="font-size:12px">${reason ? escapeHtml(reason) : '<span style="color:#9ca3af">—</span>'}</td>
        <td style="font-size:12px">${since ? escapeHtml(since) : '<span style="color:#9ca3af">—</span>'}</td>
        <td class="mono" style="font-size:11px"><a href="/admin/tasks/${escapeHtml(task.id)}" style="color:#6366f1;text-decoration:none">${escapeHtml(task.id)}</a></td>
        <td style="font-size:12px">${prLink}</td>
        <td class="mono" style="font-size:11px"><code>${escapeHtml(waitingTaskHint(entry))}</code></td>
      </tr>`;
    })
    .join("\n");

  return `<div class="card" style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">Needs you</div>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Reason</th>
              <th>Since</th>
              <th>Task</th>
              <th>PR</th>
              <th>Command</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    </div>`;
}

const SESSION_STATE_LABEL: Record<SessionRollupState, string> = {
  waiting: "Waiting",
  active: "Active",
  closed: "Closed",
  empty: "Empty",
};

const SESSION_STATE_BADGE_CLASS: Record<SessionRollupState, string> = {
  waiting: "badge-warning",
  active: "badge-blue",
  closed: "badge-green",
  empty: "badge-gray",
};

// ─── Board column bucketing (AXR-1.2) ────────────────────────────────────────
//
// Single source of truth for the task board's 5 possible bucket values —
// AXR-1.3 builds the board UI on top of this pure function; do not duplicate
// this logic there. Per TBC-2.1, the default board render (TASK_BOARD_COLUMNS)
// only shows 3 of these 5 buckets (queued/in_progress/blocked_hitl); claimed
// and done are still valid bucketTaskColumn outputs (used by other callers)
// but are no longer rendered as default-board columns.
// Every task resolves to exactly one column. Precedence is checked top to
// bottom below, first match wins:
//
//   1. done         — status is one of merged/deployed/done/deploying/
//                      cancelled (reuses SESSION_CLOSED_STATUSES). Wins over
//                      every other signal, including hitl:true or a blocked
//                      joined PR, so a completed task never shows as needing
//                      a human.
//   2. blocked_hitl — task.status === "blocked", OR task.blockedBy is
//                      non-empty (unresolved dependency or hitl wait — same
//                      signal classifyTaskState above treats as "blocked"),
//                      OR task.hitl === true, OR the joined PR is blocked
//                      (prBlocked === true). This is the "needs a human"
//                      bucket — task-level and PR-level blocks both collapse
//                      into this single bucket, even when several of these
//                      fire at once for the same task.
//   3. in_progress  — status is one of in_progress/pr_open/approved, and
//                      none of the blocked_hitl conditions above matched.
//   4. claimed      — status "pending" with a claimedBy set (about to start,
//                      or claimed but not yet started).
//   5. queued       — status "pending" with no claimedBy (default
//                      fallback — also covers any future/unrecognized status
//                      value, so every task still lands in exactly one
//                      column rather than "none of the above").
type TaskBoardColumn =
  | "queued"
  | "claimed"
  | "in_progress"
  | "blocked_hitl"
  | "done";

export const TASK_BOARD_COLUMNS: { key: TaskBoardColumn; label: string }[] = [
  { key: "queued", label: "Queued" },
  { key: "in_progress", label: "In Progress" },
  { key: "blocked_hitl", label: "Blocked-HITL" },
];

/**
 * Buckets a task into one of the 5 board columns above. `prBlocked` is the
 * `blocked` flag from the task's joined PR (undefined/null when the task has
 * no linked PR, or the join wasn't performed) — see the module comment above
 * for full precedence rules.
 */
export function bucketTaskColumn(
  task: Pick<TaskItem, "status" | "hitl" | "claimedBy" | "blockedBy">,
  prBlocked?: boolean | null,
): TaskBoardColumn {
  if (SESSION_CLOSED_STATUSES.has(task.status)) return "done";
  if (
    task.status === "blocked" ||
    (task.blockedBy?.length ?? 0) > 0 ||
    task.hitl === true ||
    prBlocked === true
  ) {
    return "blocked_hitl";
  }
  if (
    task.status === "in_progress" ||
    task.status === "pr_open" ||
    task.status === "approved"
  ) {
    return "in_progress";
  }
  if (task.status === "pending") {
    return task.claimedBy ? "claimed" : "queued";
  }
  return "queued";
}

export interface DependencyNode {
  id: string;
  title: string;
  status: string;
  branch: string | null;
  dependsOn: string[];
}

/**
 * Maps every session task to a graph node and returns them as a flat,
 * deterministically-ordered array for the graph card (see
 * `renderDependencyGraph`/`computeDependencyLayout`). Tasks with no
 * dependency relationship are included too — they render as depth-0 roots in
 * column 0 so the graph shows as many nodes as the session has tasks.
 * Dependency ids outside the session (unknown to this task list) aren't
 * session tasks and have no status to classify by, so they never get their
 * own node — they still show up in a task's `dependsOn` list, just unlinked.
 */
export function computeDependencyNodes(tasks: TaskItem[]): DependencyNode[] {
  const nodes: DependencyNode[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    branch: t.branch ?? null,
    dependsOn: t.dependencies ?? [],
  }));
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  return nodes;
}

// Layout constants for the dependency graph's SVG-style card layout, measured
// from the approved intel mockup (session-dependency-graph.html, including
// its 16-node fan-in/fan-out stress-test variant): fixed 220x88 cards, a
// 320px column pitch (card + 100px gap) and 118px row pitch (card + 30px
// gap), with a 40px margin on all sides.
const LAYOUT_CARD_WIDTH = 220;
const LAYOUT_CARD_HEIGHT = 88;
const LAYOUT_COLUMN_GAP = 100;
const LAYOUT_ROW_GAP = 30;
const LAYOUT_MARGIN = 40;

interface DependencyLayoutPosition {
  x: number;
  y: number;
  depth: number;
}

interface DependencyLayout {
  positions: Map<string, DependencyLayoutPosition>;
  width: number;
  height: number;
}

/**
 * Pure layered-DAG layout: assigns each node a column (depth = longest path
 * from any root, following only in-session `dependsOn` edges — ids outside
 * the input node set aren't session participants and are ignored) and a row
 * within that column, then converts to fixed-size-card pixel coordinates
 * using the constants above. Callers are expected to have already filtered
 * `nodes` via `computeDependencyNodes` — this function does no filtering of
 * its own.
 *
 * Cycle-safe: depth computation uses a Set tracking node ids on the current
 * DFS recursion stack. Re-entering a node already on the stack (i.e. a
 * cycle) stops that branch rather than recursing further, so every node
 * still resolves to some finite depth and gets a position. Resolved depths
 * are memoized so each node's longest-path depth is computed once.
 *
 * Row order within a column follows the input array's iteration order,
 * which is what makes the overall layout deterministic for a given input.
 */
export function computeDependencyLayout(
  nodes: DependencyNode[],
): DependencyLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depths = new Map<string, number>();

  function resolveDepth(id: string, stack: Set<string>): number {
    const memoized = depths.get(id);
    if (memoized !== undefined) return memoized;
    if (stack.has(id)) return 0; // cycle guard: stop descending this branch

    const node = byId.get(id);
    const dependsOn = node?.dependsOn.filter((dep) => byId.has(dep)) ?? [];
    if (dependsOn.length === 0) {
      depths.set(id, 0);
      return 0;
    }

    stack.add(id);
    let maxParentDepth = -1;
    for (const dep of dependsOn) {
      const depDepth = resolveDepth(dep, stack);
      if (depDepth > maxParentDepth) maxParentDepth = depDepth;
    }
    stack.delete(id);

    const depth = maxParentDepth + 1;
    depths.set(id, depth);
    return depth;
  }

  for (const n of nodes) resolveDepth(n.id, new Set());

  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    const depth = depths.get(n.id) ?? 0;
    const column = columns.get(depth);
    if (column) column.push(n.id);
    else columns.set(depth, [n.id]);
  }

  const positions = new Map<string, DependencyLayoutPosition>();
  let maxRows = 0;
  for (const [depth, ids] of columns) {
    maxRows = Math.max(maxRows, ids.length);
    ids.forEach((id, row) => {
      positions.set(id, {
        x: LAYOUT_MARGIN + depth * (LAYOUT_CARD_WIDTH + LAYOUT_COLUMN_GAP),
        y: LAYOUT_MARGIN + row * (LAYOUT_CARD_HEIGHT + LAYOUT_ROW_GAP),
        depth,
      });
    });
  }

  const numColumns = columns.size;
  const width =
    numColumns === 0
      ? 0
      : LAYOUT_MARGIN * 2 +
        numColumns * LAYOUT_CARD_WIDTH +
        (numColumns - 1) * LAYOUT_COLUMN_GAP;
  const height =
    maxRows === 0
      ? 0
      : LAYOUT_MARGIN * 2 +
        maxRows * LAYOUT_CARD_HEIGHT +
        (maxRows - 1) * LAYOUT_ROW_GAP;

  return { positions, width, height };
}

// Fixed palette for branch chips — a stable hash picks a color per branch
// name so tasks bundled onto the same branch/PR are visually correlated
// even when they land in different state groups (a task and its dependent
// are often shipped together on one branch, e.g. AGY-1.1 + AGY-1.2).
const BRANCH_COLORS = [
  "#6366f1",
  "#059669",
  "#d97706",
  "#db2777",
  "#0891b2",
  "#7c3aed",
];

function branchColor(branch: string): string {
  let hash = 0;
  for (let i = 0; i < branch.length; i++) {
    hash = (hash * 31 + branch.charCodeAt(i)) >>> 0;
  }
  return BRANCH_COLORS[hash % BRANCH_COLORS.length];
}

/**
 * Renders the dependency graph as absolutely-positioned node cards over an
 * SVG overlay of bezier edges, per the approved intel mockup
 * (session-dependency-graph.html): `computeDependencyLayout` assigns each
 * node an (x, y) by dependency depth, the SVG draws one arrowhead-terminated
 * path per in-session edge (source = the depended-on task, target = the
 * dependent task — an edge points from what's needed into what needs it),
 * and each card keeps its raw status badge, branch chip/color, and
 * "needs X, Y" line (linked for sibling session tasks, plain text — and no
 * edge drawn — for dependency ids outside the session, which have no
 * position in the layout).
 */
function renderDependencyGraph(nodes: DependencyNode[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layout = computeDependencyLayout(nodes);

  const nodeCard = (n: DependencyNode): string => {
    const pos = layout.positions.get(n.id);
    const idHtml = `<a href="/admin/tasks/${escapeHtml(n.id)}" class="mono" style="font-size:12px;color:#6366f1;text-decoration:none;font-weight:600">${escapeHtml(n.id)}</a>`;
    const statusHtml = `<span class="badge ${statusBadgeClass(n.status)}" style="margin-left:6px;font-size:10px">${escapeHtml(n.status)}</span>`;
    const titleHtml = `<div style="font-size:12px;color:#374151;margin-top:2px">${escapeHtml(n.title)}</div>`;
    const dependsOnHtml =
      n.dependsOn.length > 0
        ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px">needs ${n.dependsOn
            .map((d) =>
              byId.has(d)
                ? `<a href="/admin/tasks/${escapeHtml(d)}" style="color:inherit;text-decoration:underline">${escapeHtml(d)}</a>`
                : escapeHtml(d),
            )
            .join(", ")}</div>`
        : "";
    const branchHtml =
      n.branch !== null
        ? `<div style="font-size:10px;margin-top:4px" class="mono"><span style="color:${branchColor(n.branch)}">⎇ ${escapeHtml(n.branch)}</span></div>`
        : "";
    const borderLeft =
      n.branch !== null
        ? `border-left:3px solid ${branchColor(n.branch)};`
        : "";
    const left = pos?.x ?? 0;
    const top = pos?.y ?? 0;
    return `<div data-task-id="${escapeHtml(n.id)}" style="position:absolute;left:${left}px;top:${top}px;width:${LAYOUT_CARD_WIDTH}px;border:1px solid #e5e7eb;${borderLeft}border-radius:6px;padding:8px 10px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,0.03)">
        <div>${idHtml}${statusHtml}</div>
        ${titleHtml}
        ${dependsOnHtml}
        ${branchHtml}
      </div>`;
  };

  const edgePaths: string[] = [];
  for (const n of nodes) {
    const targetPos = layout.positions.get(n.id);
    if (!targetPos) continue;
    for (const dep of n.dependsOn) {
      const sourcePos = layout.positions.get(dep);
      if (!sourcePos) continue; // out-of-session dependency: no position, no line
      const x1 = sourcePos.x + LAYOUT_CARD_WIDTH;
      const y1 = sourcePos.y + LAYOUT_CARD_HEIGHT / 2;
      const x2 = targetPos.x;
      const y2 = targetPos.y + LAYOUT_CARD_HEIGHT / 2;
      const cx1 = x1 + (x2 - x1) / 2;
      const cx2 = cx1;
      edgePaths.push(
        `<path data-from="${escapeHtml(dep)}" data-to="${escapeHtml(n.id)}" d="M ${x1},${y1} C ${cx1},${y1} ${cx2},${y2} ${x2},${y2}" fill="none" stroke="#c7cad1" stroke-width="1.5" marker-end="url(#arrow)" />`,
      );
    }
  }

  const svgHtml = `<svg width="${layout.width}" height="${layout.height}" style="position:absolute;top:0;left:0;pointer-events:none">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#c7cad1" />
        </marker>
      </defs>
      ${edgePaths.join("\n      ")}
    </svg>`;

  return `<div style="position:relative;width:${layout.width}px;height:${layout.height}px">
      ${svgHtml}
      ${nodes.map(nodeCard).join("\n      ")}
    </div>`;
}

/**
 * Renders the session detail page: stat cards (total tasks, est. hours,
 * distinct layers), a ready/in_progress/blocked/closed summary, a task table
 * grouped the same way, and a dependency graph — sourced from a live
 * `/tasks?session=` fetch (no plan-time snapshot).
 */
export function renderSessionDetailPage(
  sessionId: string,
  tasks: TaskItem[],
  userName: string,
  degraded = false,
  backHref = "/admin/tasks",
  prsByTaskId: Record<string, PrListItem> = {},
  isAdmin = false,
  notice?: { kind: "success" | "error"; message: string },
  isFollowing = false,
  /**
   * Query string appended to the action forms' URLs (SSP-6.8) — e.g.
   * `?accountId=acct-b` when a platform admin is viewing another account's
   * session, so the action addresses that account's same-slug row.
   */
  actionsQuery = "",
): string {
  const degradedHtml = degraded
    ? `<div class="alert alert-warning">Task store unavailable — data shown may be stale or empty.</div>`
    : "";

  const noticeHtml = notice
    ? `<div class="alert alert-${notice.kind === "success" ? "success" : "error"}">${escapeHtml(notice.message)}</div>`
    : "";

  // SESH-5.2: admin-only archive/unarchive/rename controls. Both archive and
  // unarchive forms are always rendered together (rather than resolving the
  // session's current archived state to show only the applicable one) —
  // task-store's SessionService.update() treats either as a harmless,
  // idempotent re-stamp when already in that state, and this route has no
  // cheap access to the session's current archived flag without an extra
  // fetch. Never rendered at all for a caller who can't manage the session
  // (`isAdmin` is true for platform admins and, under SSP-6.8, for an
  // account user viewing their own account's session).
  const adminActionsHtml = isAdmin
    ? `<div class="card" style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">Admin actions</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <form method="POST" action="/admin/sessions/${encodeURIComponent(sessionId)}/archive${escapeHtml(actionsQuery)}" style="margin:0">
          <button type="submit" class="btn btn-secondary">Archive</button>
        </form>
        <form method="POST" action="/admin/sessions/${encodeURIComponent(sessionId)}/unarchive${escapeHtml(actionsQuery)}" style="margin:0">
          <button type="submit" class="btn btn-secondary">Unarchive</button>
        </form>
        <form method="POST" action="/admin/sessions/${encodeURIComponent(sessionId)}/rename${escapeHtml(actionsQuery)}" style="margin:0;display:flex;gap:6px;align-items:center">
          <input type="text" name="newTitle" placeholder="New title (blank clears it)" class="form-input" style="max-width:240px" />
          <button type="submit" class="btn btn-secondary">Rename</button>
        </form>
      </div>
    </div>`
    : "";

  const waitingTasks = computeSessionWaitingTasks(tasks, prsByTaskId);
  const sessionState = computeSessionState(tasks, waitingTasks);
  const waitingSince = computeWaitingSince(waitingTasks);

  const stateBadgeHtml = `<span class="badge ${SESSION_STATE_BADGE_CLASS[sessionState]}">${escapeHtml(SESSION_STATE_LABEL[sessionState])}</span>`;
  const waitingSinceHtml =
    sessionState === "waiting" && waitingSince
      ? `<span style="font-size:12px;color:#6b7280">Waiting since ${escapeHtml(waitingSince)}</span>`
      : "";

  // SESH-5.3: Follow/Unfollow button. Initial label/data-following reflect
  // the server-resolved follow state; the inline script below toggles both
  // client-side after a successful POST, with no full page reload.
  const followButtonHtml = `<button type="button" id="session-follow-btn" class="btn btn-secondary" style="padding:5px 12px;font-size:13px" data-slug="${escapeHtml(sessionId)}" data-following="${isFollowing ? "true" : "false"}">${isFollowing ? "Following" : "Follow"}</button>`;

  const needsYouSection =
    sessionState === "waiting"
      ? renderNeedsYouPanel(waitingTasks, prsByTaskId)
      : "";

  const totalTasks = tasks.length;
  const totalHours = tasks.reduce((sum, t) => sum + (t.hours ?? 0), 0);
  const distinctLayers = new Set(
    tasks.map((t) => t.layer).filter((l): l is string => !!l),
  ).size;

  const tasksByState = new Map<TaskState, TaskItem[]>();
  for (const t of tasks) {
    const state = classifyTaskState(t);
    const bucket = tasksByState.get(state);
    if (bucket) bucket.push(t);
    else tasksByState.set(state, [t]);
  }

  const dependencyNodes = computeDependencyNodes(tasks);

  function taskRow(t: TaskItem): string {
    return `<tr>
    <td class="mono" style="font-size:11px"><a href="/admin/tasks/${escapeHtml(t.id)}" style="color:#6366f1;text-decoration:none">${escapeHtml(t.id)}</a></td>
    <td>${escapeHtml(t.title)}</td>
    <td><span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status)}</span></td>
    <td style="font-size:12px">${t.layer ? escapeHtml(t.layer) : '<span style="color:#9ca3af">—</span>'}</td>
    <td style="font-size:12px">${t.hours !== null && t.hours !== undefined ? escapeHtml(String(t.hours)) : '<span style="color:#9ca3af">—</span>'}</td>
    <td class="mono" style="font-size:11px">${t.repo ? escapeHtml(t.repo) : '<span style="color:#9ca3af">—</span>'}</td>
    <td class="col-source mono" style="font-size:11px">${t.source ? escapeHtml(t.source) : '<span style="color:#9ca3af">—</span>'}</td>
  </tr>`;
  }

  const tableRows =
    tasks.length === 0
      ? `<tr><td colspan="7" class="empty-state">No tasks found for this session.</td></tr>`
      : TASK_STATE_GROUPS.map(({ key, label }) => {
          const group = tasksByState.get(key);
          if (!group || group.length === 0) return "";
          return `<tr><td colspan="7" style="background:#f9fafb;font-size:11px;font-weight:600;color:#374151;padding:6px 12px;text-transform:uppercase;letter-spacing:.05em">${label} (${group.length})</td></tr>${group.map(taskRow).join("\n")}`;
        })
          .filter(Boolean)
          .join("\n");

  const depsSection =
    dependencyNodes.length > 0
      ? `<div class="card" style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">Dependency graph</div>
      <div class="data-table-wrapper">
      ${renderDependencyGraph(dependencyNodes)}
    </div>
    </div>`
      : "";

  const statCard = (label: string, value: string) => `
    <div class="card" style="flex:1;min-width:120px;text-align:center">
      <div style="font-size:24px;font-weight:700;color:#111827">${value}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:4px">${escapeHtml(label)}</div>
    </div>`;

  return renderAdminPage({
    title: `Session ${sessionId} — Shipwright Admin`,
    extraStyles: `
    .badge-blue { background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe; }
    .badge-green { background:#dcfce7;color:#166534;border:1px solid #bbf7d0; }
    .badge-red { background:#fee2e2;color:#991b1b;border:1px solid #fecaca; }
    .alert-warning { background:#fefce8;color:#854d0e;border:1px solid #fde047;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:13px; }
  `,
    body: `${renderAdminToolbar(userName, "/admin/tasks")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <a href="${escapeHtml(backHref)}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>
      <h1 class="page-title" style="margin:0;flex:1">Session <span class="mono">${escapeHtml(sessionId)}</span></h1>
      ${stateBadgeHtml}
      ${waitingSinceHtml}
      ${followButtonHtml}
    </div>
    ${degradedHtml}
    ${noticeHtml}
    ${adminActionsHtml}
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      ${statCard("Total Tasks", String(totalTasks))}
      ${statCard("Est. Hours", String(totalHours))}
      ${statCard("Layers", String(distinctLayers))}
    </div>
    ${needsYouSection}
    <div style="font-size:13px;color:#374151;margin-bottom:12px">
      ${TASK_STATE_GROUPS.map(
        ({ key, label }) =>
          `<strong>${tasksByState.get(key)?.length ?? 0}</strong> ${escapeHtml(label.toLowerCase())}`,
      ).join(" / ")}
    </div>
    <div class="card">
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>Status</th>
              <th>Layer</th>
              <th>Hours</th>
              <th>Repo</th>
              <th class="col-source">Source</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    </div>
    ${depsSection}
  </div>
  <script>
  (function() {
    var btn = document.getElementById('session-follow-btn');
    if (!btn) return;
    btn.addEventListener('click', function() {
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

// ─── PRs page ────────────────────────────────────────────────────────────────

/**
 * Classifies claim/heartbeat recency for the shared `.heartbeat-dot`
 * indicator (AXR-2.1, AXR-1.1's admin-ui-styles.ts). Uses `heartbeatAt` when
 * present, else falls back to `claimedAt`; returns `null` when neither is
 * set (the PR was never claimed) so the caller can render no dot at all.
 *
 * Thresholds are a display nicety, not exact stale-claim-reaper semantics:
 * "stale" mirrors @shipwright/lib/claim-ttl.ts's `DEFAULT_CLAIM_TTL_MS` (the reaper's
 * own TTL), and "aging" is half that.
 *
 * `now` is always caller-injected (never read internally) so render output
 * stays deterministic in tests.
 */
export function heartbeatFreshness(
  claimedAt: string | null | undefined,
  heartbeatAt: string | null | undefined,
  now: Date,
): "fresh" | "aging" | "stale" | null {
  const ts = heartbeatAt ?? claimedAt;
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const ageMs = now.getTime() - d.getTime();
  if (ageMs >= DEFAULT_CLAIM_TTL_MS) return "stale";
  if (ageMs >= DEFAULT_CLAIM_TTL_MS / 2) return "aging";
  return "fresh";
}

export function renderPrsPage(
  prs: PrListItem[],
  filters: {
    repo?: string | string[];
    org?: string | string[];
    state?: string;
    reviewState?: string;
    taskId?: string;
    blocked?: string;
  },
  degraded: boolean,
  userName: string,
  agentNames: Record<string, string> = {},
  pagination: { total: number; limit: number; page: number } = {
    total: 0,
    limit: 50,
    page: 1,
  },
  timezone = "America/Los_Angeles",
  suggestions?: { repos?: string[]; orgs?: string[] },
  linkedTasksByPr: Record<string, TaskItem[]> = {},
  now: Date = new Date(),
): string {
  const degradedHtml = degraded
    ? `<div class="alert alert-warning">PR store unavailable — data shown may be stale or empty.</div>`
    : "";

  // Reuses AXR-1.1's shared badge palette (admin-ui-styles.ts) instead of
  // page-local color rules — .badge-purple stands in for the former
  // page-local .badge-blue, and .badge-green/.badge-gray already exist
  // globally (AC1).
  const prStateBadgeClass = (s: string) => {
    if (s === "open") return "badge-purple";
    if (s === "closed" || s === "merged") return "badge-green";
    return "badge-gray";
  };

  const reviewStateBadgeClass = (s: string) => {
    if (s === "in_progress" || s === "posted") return "badge-purple";
    if (s === "approved") return "badge-green";
    return "badge-gray";
  };

  const renderBlockedBadge = (pr: PrListItem): string => {
    if (!pr.blocked) return "";
    const title = pr.blockedReason
      ? ` title="${escapeHtml(pr.blockedReason)}"`
      : "";
    // Reuses AXR-1.1's shared .badge-warning class instead of a page-local
    // .badge-blocked rule (AC1).
    return `<span class="badge badge-warning" style="font-size:10px;margin-left:6px"${title}>Waiting: Blocked</span>`;
  };

  const rows =
    prs.length === 0
      ? `<tr><td colspan="9" class="empty-state">No PRs found.</td></tr>`
      : prs
          .map((pr) => {
            const freshness = heartbeatFreshness(
              pr.claimedAt,
              pr.heartbeatAt,
              now,
            );
            const heartbeatDotHtml = freshness
              ? `<span class="heartbeat-dot ${freshness}" title="${freshness}"></span> `
              : "";
            const claimedCell = pr.claimedBy
              ? `${heartbeatDotHtml}${agentLink(
                  pr.claimedBy,
                  agentNames[pr.claimedBy] ?? pr.claimedBy,
                )}`
              : '<span style="color:#9ca3af">—</span>';
            const linkedTasks = linkedTasksByPr[pr.id] ?? [];
            const taskCell =
              linkedTasks.length > 0
                ? linkedTasks.map((t) => taskLink(t.id)).join(", ")
                : '<span style="color:#9ca3af">—</span>';
            const createdCell = pr.createdAt
              ? escapeHtml(
                  (() => {
                    const d = new Date(pr.createdAt);
                    return Number.isNaN(d.getTime())
                      ? pr.createdAt
                      : d.toLocaleString("en-US", {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: timezone,
                        });
                  })(),
                )
              : '<span style="color:#9ca3af">—</span>';
            return `<tr data-href="/admin/prs/${escapeHtml(pr.id)}" style="cursor:pointer">
    <td style="font-size:12px"><a href="/admin/prs/${escapeHtml(pr.id)}" style="color:#6366f1;text-decoration:none;font-weight:500">#${escapeHtml(String(pr.prNumber))}</a></td>
    <td style="font-size:12px">${escapeHtml(pr.repo)}</td>
    <td style="font-size:12px">${taskCell}</td>
    <td><span class="badge ${prStateBadgeClass(pr.state)}">${escapeHtml(pr.state)}</span>${renderBlockedBadge(pr)}</td>
    <td><span class="badge ${reviewStateBadgeClass(pr.reviewState)}">${escapeHtml(pr.reviewState)}</span></td>
    <td class="col-review-cycles" style="font-size:12px;text-align:center">${escapeHtml(String(pr.reviewCycles))}</td>
    <td class="col-patch-cycles" style="font-size:12px;text-align:center">${escapeHtml(String(pr.patchCycles))}</td>
    <td class="col-claimed-by" style="font-size:12px">${claimedCell}</td>
    <td style="font-size:12px">${createdCell}</td>
  </tr>`;
          })
          .join("\n");

  // State tab helpers
  const activeState = filters.state;
  const blockedActive = filters.blocked === "true";

  const makeTabParams = (tabState: string): string => {
    const p = new URLSearchParams();
    p.set("state", tabState);
    for (const r of toFilterArray(filters.repo)) p.append("repo", r);
    for (const o of toFilterArray(filters.org)) p.append("org", o);
    if (filters.taskId) p.set("taskId", filters.taskId);
    if (filters.reviewState) p.set("reviewState", filters.reviewState);
    return `?${p.toString()}`;
  };

  const makeBlockedTabParams = (): string => {
    const p = new URLSearchParams();
    p.set("state", "open");
    p.set("blocked", "true");
    for (const r of toFilterArray(filters.repo)) p.append("repo", r);
    for (const o of toFilterArray(filters.org)) p.append("org", o);
    if (filters.taskId) p.set("taskId", filters.taskId);
    if (filters.reviewState) p.set("reviewState", filters.reviewState);
    return `?${p.toString()}`;
  };

  // Blocked tab's own active-state takes precedence over Open/Merged when
  // filters.blocked === "true", regardless of the current filters.state.
  const tabStyle = (tabState: string) =>
    !blockedActive && activeState === tabState
      ? "background:#6366f1;color:#fff;font-weight:600"
      : "background:#fff;color:#374151";

  const blockedTabStyle = blockedActive
    ? "background:#6366f1;color:#fff;font-weight:600"
    : "background:#fff;color:#374151";

  const stateToggle = `
    <div style="display:flex;gap:0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;width:fit-content">
      <a href="/admin/prs${makeTabParams("open")}"
         style="padding:5px 14px;font-size:12px;text-decoration:none;${tabStyle("open")}">Open</a>
      <a href="/admin/prs${makeTabParams("merged")}"
         style="padding:5px 14px;font-size:12px;text-decoration:none;border-left:1px solid #e5e7eb;${tabStyle("merged")}">Merged</a>
      <a href="/admin/prs${makeBlockedTabParams()}"
         style="padding:5px 14px;font-size:12px;text-decoration:none;border-left:1px solid #e5e7eb;${blockedTabStyle}">Blocked</a>
    </div>`;

  // Pagination
  const totalPages = Math.max(
    1,
    Math.ceil(pagination.total / pagination.limit),
  );
  const page = pagination.page;
  const makePageUrl = (p: number) => {
    const params = new URLSearchParams();
    if (filters.state) params.set("state", filters.state);
    if (filters.reviewState) params.set("reviewState", filters.reviewState);
    for (const r of toFilterArray(filters.repo)) params.append("repo", r);
    for (const o of toFilterArray(filters.org)) params.append("org", o);
    if (filters.taskId) params.set("taskId", filters.taskId);
    if (filters.blocked) params.set("blocked", filters.blocked);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/admin/prs${qs ? `?${qs}` : ""}`;
  };

  const from = pagination.total === 0 ? 0 : (page - 1) * pagination.limit + 1;
  const to = Math.min(page * pagination.limit, pagination.total);
  const paginationHtml =
    pagination.total === 0
      ? ""
      : `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0;font-size:12px;color:#6b7280">
      <span>${from}–${to} of ${pagination.total}</span>
      <div style="display:flex;gap:4px">
        ${page > 1 ? `<a href="${makePageUrl(page - 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">← Prev</a>` : ""}
        ${page < totalPages ? `<a href="${makePageUrl(page + 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">Next →</a>` : ""}
      </div>
    </div>`;

  // "More filters" disclosure state. `state` already has a visible cue via the
  // Open/Merged/Blocked tab highlighting above, but `reviewState` and `taskId`
  // live only inside the collapsed panel — a bookmarked/linked filtered URL
  // would otherwise look unfiltered. Auto-expand when either is set, and keep a
  // badge on the summary so a manually re-collapsed panel still signals it.
  const hiddenActiveFilterCount =
    (filters.reviewState ? 1 : 0) + (filters.taskId ? 1 : 0);
  const moreFiltersAttrs = hiddenActiveFilterCount > 0 ? " open" : "";
  const moreFiltersBadge =
    hiddenActiveFilterCount > 0
      ? `<span class="badge badge-purple">${hiddenActiveFilterCount}</span>`
      : "";

  return renderAdminPage({
    title: "PRs — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/prs")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <h1 class="page-title" style="margin:0">PRs</h1>
      ${stateToggle}
    </div>
    ${degradedHtml}
    <div class="card" style="margin-bottom:16px">
      <form method="GET" action="/admin/prs" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        ${renderRepoOrgFilterFields(
          { org: filters.org, repo: filters.repo },
          { orgs: suggestions?.orgs, repos: suggestions?.repos },
        )}
        <button type="submit" class="btn btn-secondary" style="font-size:12px;padding:4px 12px">Filter</button>
        <a href="/admin/prs" class="btn btn-secondary" style="font-size:12px;padding:4px 12px">Reset</a>
        <details class="more-filters"${moreFiltersAttrs}>
          <summary>More filters${moreFiltersBadge}</summary>
          <div class="more-filters-panel">
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" style="font-size:11px">State</label>
              <select name="state" class="form-input" style="font-size:12px;padding:4px 8px">
                <option value="">Any</option>
                <option value="open" ${filters.state === "open" ? "selected" : ""}>open</option>
                <option value="merged" ${filters.state === "merged" ? "selected" : ""}>merged</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" style="font-size:11px">Review State</label>
              <select name="reviewState" class="form-input" style="font-size:12px;padding:4px 8px">
                <option value="">Any</option>
                <option value="pending" ${filters.reviewState === "pending" ? "selected" : ""}>pending</option>
                <option value="in_progress" ${filters.reviewState === "in_progress" ? "selected" : ""}>in_progress</option>
                <option value="posted" ${filters.reviewState === "posted" ? "selected" : ""}>posted</option>
                <option value="approved" ${filters.reviewState === "approved" ? "selected" : ""}>approved</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label" style="font-size:11px">Task ID</label>
              <input name="taskId" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.taskId ?? "")}" placeholder="TASK-123" />
            </div>
          </div>
        </details>
      </form>
    </div>
    <div class="card">
      <div class="data-table-wrapper">
        <table class="data-table" style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">PR#</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Repo</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Task</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">State</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Review State</th>
              <th class="col-review-cycles" style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb"><span class="header-tooltip" data-tip="How many times this PR has been sent back for review">Review Cycles</span></th>
              <th class="col-patch-cycles" style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb"><span class="header-tooltip" data-tip="How many times a patch was applied to address review feedback">Patch Cycles</span></th>
              <th class="col-claimed-by" style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Claimed By</th>
              <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Created</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      ${paginationHtml}
    </div>
  </div>`,
    bodyEnd: `<script>
    document.querySelectorAll("tr[data-href]").forEach(function(row) {
      row.addEventListener("click", function(e) {
        var target = e.target;
        while (target && target !== row) {
          if (target.tagName === "A" || target.tagName === "BUTTON" || target.tagName === "FORM" || target.tagName === "INPUT") return;
          target = target.parentElement;
        }
        window.location.href = row.getAttribute("data-href");
      });
    });
  </script>`,
  });
}

export function renderPrDetailPage(
  pr: PrListItem,
  userName: string,
  agentNames: Record<string, string> = {},
  timezone = "America/Los_Angeles",
  linkedTasks: TaskItem[] = [],
  verificationChecks: VerificationCheckItem[] = [],
): string {
  function field(
    label: string,
    value: string | null | undefined,
    mono = false,
  ): string {
    if (value === null || value === undefined || value === "") return "";
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-size:13px${mono ? ";font-family:monospace;font-size:12px" : ""}">${escapeHtml(value)}</td>
    </tr>`;
  }

  function dateField(label: string, iso: string | null | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    const fmt = Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: timezone,
        });
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-size:13px" title="${escapeHtml(iso)}">${escapeHtml(fmt)}</td>
    </tr>`;
  }

  function linkField(
    label: string,
    url: string | null | undefined,
    text?: string,
  ): string {
    if (!url) return "";
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-size:13px"><a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="color:#6366f1">${escapeHtml(text ?? url)}</a></td>
    </tr>`;
  }

  function agentField(
    label: string,
    agentId: string | null | undefined,
  ): string {
    if (!agentId) return "";
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-size:13px;font-family:monospace;font-size:12px">${agentLink(agentId, agentNames[agentId] ? `${agentNames[agentId]} (${agentId})` : agentId)}</td>
    </tr>`;
  }

  const githubPrUrl = `https://github.com/${pr.repo}/pull/${pr.prNumber}`;

  const metaRows = [
    field("ID", pr.id, true),
    field("Repo", pr.repo),
    linkField("PR Number", githubPrUrl, `#${pr.prNumber}`),
    linkedTasks.length > 0
      ? `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap">Task</td>
      <td style="padding:8px 12px;font-size:13px">${linkedTasks.map((t) => taskLink(t.id)).join(", ")}</td>
    </tr>`
      : "",
    field("State", pr.state),
    field("Review State", pr.reviewState),
    field("Review Cycles", String(pr.reviewCycles)),
    field("Patch Cycles", String(pr.patchCycles)),
    field("Commit SHA", pr.commitSha, true),
    field("Staged", pr.staged ? "yes" : "no"),
    agentField("Claimed By", pr.claimedBy),
    agentField("Agent ID", pr.agentId),
    pr.blocked !== null && pr.blocked !== undefined
      ? field("Blocked", pr.blocked ? "yes" : "no")
      : "",
    pr.skipCount ? field("Skip Count", String(pr.skipCount)) : "",
    field("Blocked Reason", pr.blockedReason),
  ]
    .filter(Boolean)
    .join("\n");

  const timelineRows = [
    dateField("Created", pr.createdAt),
    dateField("Claimed", pr.claimedAt),
    dateField("Reviewed", pr.reviewedAt),
    dateField("Patched", pr.patchedAt),
    dateField("Merged", pr.mergedAt),
    dateField("Last Heartbeat", pr.heartbeatAt),
    pr.skipCount ? dateField("Last Skipped", pr.lastSkippedAt) : "",
    dateField("Updated", pr.updatedAt),
  ]
    .filter(Boolean)
    .join("\n");

  const verificationSection = renderVerificationChecksCard(
    verificationChecks,
    timezone,
  );

  return renderAdminPage({
    title: `PR #${pr.prNumber} — ${pr.repo} — Shipwright Admin`,
    extraStyles: `
    .badge-blue { background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe; }
    .badge-green { background:#dcfce7;color:#166534;border:1px solid #bbf7d0; }
    .badge-gray { background:#f3f4f6;color:#374151;border:1px solid #e5e7eb; }
    .badge-blocked { background:#fff7ed;color:#c2410c;border:1px solid #fed7aa; }
    .detail-table { width:100%;border-collapse:collapse; }
    .detail-table tr:not(:last-child) td { border-bottom:1px solid #f3f4f6; }
  `,
    body: `${renderAdminToolbar(userName, "/admin/prs")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <a href="/admin/prs" style="color:#6b7280;font-size:13px;text-decoration:none">← PRs</a>
      <h1 class="page-title" style="margin:0;flex:1">${escapeHtml(pr.repo)} #${escapeHtml(String(pr.prNumber))}</h1>
      <span class="badge badge-gray">${escapeHtml(pr.state)}</span>
    </div>
    <div style="margin-top:4px;margin-bottom:16px;font-family:monospace;font-size:11px;color:#9ca3af">${escapeHtml(pr.id)}</div>

    <div class="card" style="margin-bottom:16px">
      <table class="detail-table">
        <tbody>
          ${metaRows}
        </tbody>
      </table>
    </div>

    ${
      timelineRows
        ? `<div class="card" style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Timeline</div>
      <table class="detail-table"><tbody>${timelineRows}</tbody></table>
    </div>`
        : ""
    }
    ${verificationSection}
  </div>`,
  });
}
