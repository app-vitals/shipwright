/**
 * admin/src/coding/admin-ui-queue-pages.ts
 * Pure HTML rendering for the Queue & Activity pages: the single-agent view
 * (work-queue snapshot + cron-run log) and the merged fleet-wide view
 * (AAV-2.1). Moved out of admin-ui-pages.ts (AEP-3.2).
 */

import { renderAdminPage } from "@app-vitals/agent-admin/admin-ui-layout";
import {
  type AgentOption,
  cronOutcomeStyle,
  cronRunOutcomeLabel,
  relativeTime,
} from "@app-vitals/agent-admin/admin-ui-pages";
import {
  escapeHtml,
  renderAdminToolbar,
} from "@app-vitals/agent-admin/admin-ui-styles";
import type { ModelBreakdownEntry } from "@app-vitals/agent-admin/openapi-schemas";
import { agentLink, taskLink } from "./admin-ui-work-item-pages.ts";
import {
  annotateEligibility,
  buildEligibilityIndex,
  mergeWorkQueueSnapshots,
} from "./agent-work-queue-merge.ts";

/**
 * Renders a link for a work-queue/cron-log item id, which is either a task id
 * (e.g. "WLS-2.2") or a "repo#prNumber" PR reference (e.g. "acme/x#123") per
 * the RankedWorkItem/CronRunItem id convention. Task ids link into the admin
 * UI; PR references link out to GitHub since the internal PR record id isn't
 * available in this shape. Falls back to plain escaped text if the PR
 * reference doesn't parse.
 */
function workItemLink(type: "task" | "pr", id: string): string {
  if (type === "task") return taskLink(id);
  const match = id.match(/^(.+)#(\d+)$/);
  if (!match) return escapeHtml(id);
  const [, repo, prNumber] = match;
  return `<a href="https://github.com/${escapeHtml(repo)}/pull/${escapeHtml(prNumber)}" target="_blank" rel="noopener" style="color:#6366f1;text-decoration:none">${escapeHtml(id)}</a>`;
}

export interface CronRunItem {
  id?: string;
  startedAt: Date;
  completedAt: Date | null;
  outcome: string | null;
  skipped: boolean;
  skipReason: string | null;
  error: string | null;
  modelBreakdown?: ModelBreakdownEntry[];
  phaseId?: string | null;
  /**
   * The phase cron's own id/name — the child AgentCronJob this run's phaseId
   * points at. Present when the run has a phaseId; null/absent for legacy
   * runs or runs with no phase attribution.
   */
  phaseCron?: { id: string; name: string | null } | null;
  /**
   * The work item ("task" | "pr") and its id (e.g. "WLS-2.2" or "acme/x#123")
   * that this run's dispatched command targeted. Both null for a tick with no
   * dispatch (skipped tick, empty queue) and for legacy runs that predate
   * item tracking.
   */
  itemType?: string | null;
  itemId?: string | null;
  /**
   * The Claude session id for this cron run. Present when the run was
   * dispatched with a session context; null/absent for runs with no session.
   */
  sessionId?: string | null;
  /**
   * Most recent debounced progress-push (recordProgress()) timestamp,
   * sourced from the agent's injected Clock. Null/absent for runs that never
   * reported progress (short/legacy runs). Used by renderCronRunRow both for
   * its own "Last Heartbeat" column and as a duration fallback when the run
   * has no completedAt yet (a stalled/crashed run) — see durationCell there.
   */
  lastHeartbeatAt?: Date | null;
  /**
   * The owning cron's id/name/schedule — present on cross-cron listings (e.g.
   * renderQueueActivityPage's per-agent Past table) so the Cron column can be
   * rendered without an N+1 lookup. Absent on single-cron listings.
   */
  cron?: { id: string; name: string | null; schedule: string };
  /**
   * The agentId this run belongs to — always present on the underlying
   * AgentCronRun row (denormalized from cron.agentId), but only rendered as
   * its own column on the merged fleet-wide listing
   * (renderMergedQueueActivityPage's cron-run table, AAV-2.1), which spans
   * multiple agents. Ignored by renderQueueActivityPage's single-agent Past
   * table, which already scopes every row to the one agent being viewed.
   */
  agentId?: string;
}

/** Formats a millisecond duration as a compact human string (e.g. "1.2s", "3m 4s"). */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const min = Math.floor(totalSec / 60);
  const sec = Math.round(totalSec % 60);
  return `${min}m ${sec}s`;
}

// Inline CSS for per-model cost badges on the cron runs page. A single run can
// span multiple models, so each gets its own neutral badge — no outcome-style
// color coding needed here.
const MODEL_BADGE_STYLE = "background:#eef2ff;color:#4338ca";

// Inline CSS for the cron-run "Item" column badge, keyed by the raw
// itemType ("task" | "pr") — distinct colors so a reader can tell a Task row
// from a PR row at a glance, not just by reading the label text.
const ITEM_TYPE_BADGE_STYLE: Record<string, string> = {
  task: "background:#eef2ff;color:#4338ca",
  pr: "background:#dcfce7;color:#166534",
};
const ITEM_TYPE_BADGE_STYLE_DEFAULT = "background:#f3f4f6;color:#6b7280";

// Human-readable capitalized labels for the raw lowercase itemType values.
const ITEM_TYPE_LABEL: Record<string, string> = {
  task: "Task",
  pr: "PR",
};

// ─── Cron grouping for activity display ────────────────────────────────────

interface CronGroupingInput {
  id: string;
  name: string | null;
  schedule: string;
}

/**
 * Partitions an agent's crons into the always-visible shipwright-loop cron
 * and every other cron, which collapses by default in the Past section.
 *
 * Used by renderQueueActivityPage to separate runs: shipwright-loop runs
 * stay in the primary visible table, while runs from other crons are grouped
 * under collapsed <details> disclosure blocks.
 */
export function partitionCronsForActivityDisplay(crons: CronGroupingInput[]): {
  visibleCronIds: Set<string>;
  collapsedCronIds: Set<string>;
} {
  const visibleCronIds = new Set<string>();
  const collapsedCronIds = new Set<string>();

  for (const c of crons) {
    if (c.name === "shipwright-loop") {
      visibleCronIds.add(c.id);
    } else {
      collapsedCronIds.add(c.id);
    }
  }

  return { visibleCronIds, collapsedCronIds };
}

// Inline CSS for the work-queue "Phase" column badge, keyed by the raw
// phase value (dev-task/plan/review/patch/deploy) — a single neutral palette
// distinct from the outcome-style badges elsewhere on the queue & activity
// page, since phase here is informational, not a pass/fail signal.
const WORK_QUEUE_PHASE_BADGE_STYLE: Record<string, string> = {
  "dev-task": "background:#eef2ff;color:#4338ca",
  plan: "background:#e0f2fe;color:#075985",
  review: "background:#fef3c7;color:#92400e",
  patch: "background:#fee2e2;color:#991b1b",
  deploy: "background:#dcfce7;color:#166534",
};
const WORK_QUEUE_PHASE_BADGE_STYLE_DEFAULT = "background:#f3f4f6;color:#6b7280";

// Shared header cells for the Past-section cron-run table — reused by the
// primary (shipwright-loop) table, each collapsed non-loop cron's <details>
// table (single-agent view), and the merged fleet-wide table (AAV-2.1),
// which prepends its own Agent column.
const CRON_RUN_TABLE_HEAD_CELLS = `
  <th>Outcome</th>
  <th>Cron</th>
  <th>Started</th>
  <th>Duration</th>
  <th>Last Heartbeat</th>
  <th class="col-tokens">Tokens</th>
  <th class="col-model">Model</th>
  <th>Phase</th>
  <th>Item</th>
  <th>Session</th>
  <th>Detail</th>
`;
const CRON_RUN_TABLE_HEAD = `<tr>${CRON_RUN_TABLE_HEAD_CELLS}</tr>`;
// Merged fleet-wide variant (renderMergedQueueActivityPage, AAV-2.1): adds an
// Agent column at the front so a cross-agent row can be attributed at a
// glance, otherwise identical to the single-agent header.
const MERGED_CRON_RUN_TABLE_HEAD = `<tr><th>Agent</th>${CRON_RUN_TABLE_HEAD_CELLS}</tr>`;

// Inline type mirroring RankedWorkItem (openapi-schemas.ts) without importing
// the zod schema itself — keeps this file's dependency surface to pure
// string-rendering inputs.
export interface WorkQueueItem {
  type: "task" | "pr";
  id: string;
  title?: string;
  phase: "dev-task" | "plan" | "review" | "patch" | "deploy";
  age: string;
}

export interface WorkQueueSnapshotItem {
  computedAt: Date;
  items: WorkQueueItem[];
}

// ─── Work-queue row cell helpers ────────────────────────────────────────────
// Shared by renderQueueActivityPage's single-agent Upcoming table and
// renderMergedQueueActivityPage's merged Upcoming table (AAV-2.1) so both
// render the type/phase/item/age columns identically.

function workQueueTypeCell(type: WorkQueueItem["type"]): string {
  return `<span class="badge" style="${ITEM_TYPE_BADGE_STYLE[type] ?? ITEM_TYPE_BADGE_STYLE_DEFAULT}">${escapeHtml(ITEM_TYPE_LABEL[type] ?? type)}</span>`;
}

function workQueuePhaseCell(phase: WorkQueueItem["phase"]): string {
  return `<span class="badge" style="${WORK_QUEUE_PHASE_BADGE_STYLE[phase] ?? WORK_QUEUE_PHASE_BADGE_STYLE_DEFAULT}">${escapeHtml(phase)}</span>`;
}

function workQueueIdTitleCell(item: WorkQueueItem): string {
  return item.title
    ? `<span class="mono" style="font-size:12px">${workItemLink(item.type, item.id)}</span> — ${escapeHtml(item.title)}`
    : `<span class="mono" style="font-size:12px">${workItemLink(item.type, item.id)}</span>`;
}

function workQueueAgeCell(age: string, now: Date): string {
  const ageDate = new Date(age);
  const ageIso = ageDate.toISOString();
  return `<span title="${escapeHtml(ageIso)}">${escapeHtml(relativeTime(ageDate, now))}</span>`;
}

/**
 * Renders a list of agent ids as comma-separated agentLink()s (resolved via
 * `agentNames`), or an em-dash when the list is empty. Shared by the merged
 * Upcoming table's "Eligible agents" and "Queued by" columns (AAV-2.1).
 */
function agentIdListCell(
  ids: string[],
  agentNames: Record<string, string>,
): string {
  if (ids.length === 0) return "—";
  return ids.map((id) => agentLink(id, agentNames[id] ?? id)).join(", ");
}

/**
 * Renders a Prev/Next pagination bar plus an "X–Y of Z" count, or "" when
 * there's nothing to paginate. Shared by renderMergedQueueActivityPage's two
 * independently-paginated tables (Upcoming's `queuePage` param, Past's `page`
 * param, AAV-2.1) — identical layout, differing only in which query param
 * carries the page number.
 */
function renderPaginationBar(opts: {
  pagination: { total: number; limit: number; page: number };
  basePath: string;
  pageParam: string;
}): string {
  const { pagination, basePath, pageParam } = opts;
  if (pagination.total === 0) return "";

  const totalPages = Math.max(
    1,
    Math.ceil(pagination.total / pagination.limit),
  );
  const { page, limit, total } = pagination;
  const from = (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  const makePageUrl = (p: number) => {
    const params = new URLSearchParams();
    if (p > 1) params.set(pageParam, String(p));
    const qs = params.toString();
    return `${basePath}${qs ? `?${qs}` : ""}`;
  };

  return `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0;font-size:12px;color:#6b7280">
      <span>${from}–${to} of ${total}</span>
      <div style="display:flex;gap:4px">
        ${page > 1 ? `<a href="${makePageUrl(page - 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">← Prev</a>` : ""}
        ${page < totalPages ? `<a href="${makePageUrl(page + 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">Next →</a>` : ""}
      </div>
    </div>`;
}

// ─── Agent selector (AXR-3.4 / AAV-2) ───────────────────────────────────────
// Sentinel value for the "All agents" option: selecting it navigates to the
// merged multi-agent view instead of a per-agent page. Shared by both
// renderQueueActivityPage (single-agent, a specific agent pre-selected) and
// renderMergedQueueActivityPage (fleet-wide, "All agents" pre-selected) so
// the two pages complete a round trip through the same dropdown component.
const ALL_AGENTS_SENTINEL = "__all__";

/**
 * GET form navigating to /admin/agents/{selected-id}/queue-activity (or
 * /admin/queue-activity for the "All agents" sentinel) on change, matching
 * the app's server-rendered, no-SPA pattern — the select rewrites the form's
 * action (the agent id lives in the path, not a query param) before
 * submitting, same idiom as the chat page's onchange-submit agent selector.
 *
 * `selectedValue` is either a specific agent's id or ALL_AGENTS_SENTINEL —
 * whichever option is currently active pre-selects in the <select>.
 * `formAction` is the form's static `action` attribute, used only if the
 * user resubmits without changing the selection (onchange never fires).
 */
function renderAgentSelector(opts: {
  agents: AgentOption[];
  selectedValue: string;
  formAction: string;
}): string {
  const { agents, selectedValue, formAction } = opts;
  const agentSelectorOptions = agents
    .map(
      (a) =>
        `<option value="${escapeHtml(a.id)}"${a.id === selectedValue ? " selected" : ""}>${escapeHtml(a.name)}</option>`,
    )
    .join("\n");
  const allAgentsSelected = selectedValue === ALL_AGENTS_SENTINEL;
  return `<form method="GET" action="${escapeHtml(formAction)}" style="margin:0">
      <select name="agentId" class="form-input" style="font-size:12px;padding:4px 8px" aria-label="Switch agent" onchange="if (this.value === '${ALL_AGENTS_SENTINEL}') { this.form.action = '/admin/queue-activity'; } else { this.form.action = '/admin/agents/' + this.value + '/queue-activity'; } this.form.submit()">
        <option value="${ALL_AGENTS_SENTINEL}"${allAgentsSelected ? " selected" : ""}>All agents</option>
        ${agentSelectorOptions}
      </select>
    </form>`;
}

// ─── Cron-run row helper ────────────────────────────────────────────────────
// Shared by renderQueueActivityPage's single-agent Past table and
// renderMergedQueueActivityPage's merged cron-run table (AAV-2.1).

function renderCronRunRow(
  r: CronRunItem,
  opts: {
    timezone: string;
    now: Date;
    /** Agent id used to build the cron-filter link's URL — the row's own
     * agent on the merged table, the single viewed agent otherwise. */
    cronLinkAgentId: string;
    /** Rendered `<td>...</td>` HTML for a leading Agent column — present
     * only on the merged fleet-wide table. */
    agentCell?: string;
  },
): string {
  const { timezone, now, cronLinkAgentId, agentCell } = opts;
  const outcomeLabel = cronRunOutcomeLabel(r);
  const badgeStyle = cronOutcomeStyle(outcomeLabel);
  const badgeTitle =
    r.skipped && r.skipReason
      ? r.skipReason
      : !r.skipped && r.error
        ? r.error
        : outcomeLabel;
  const outcomeCell = `<span class="badge" style="${badgeStyle}" title="${escapeHtml(badgeTitle)}">${escapeHtml(outcomeLabel)}</span>`;

  const cronLabel = r.cron ? (r.cron.name ?? r.cron.schedule) : "—";
  const cronCell = r.cron
    ? `<a href="/admin/agents/${escapeHtml(cronLinkAgentId)}/queue-activity?cronId=${escapeHtml(r.cron.id)}" style="color:#6366f1;text-decoration:none">${escapeHtml(cronLabel)}</a>`
    : escapeHtml(cronLabel);

  const startedIso = new Date(r.startedAt).toISOString();
  const startedFmt = new Date(r.startedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  });
  const startedCell = `<span title="${escapeHtml(startedIso)}">${escapeHtml(startedFmt)}</span>`;

  // A run that stalls or crashes before reaching completedAt would otherwise
  // render a bare "—" with no signal of how long it ran before going dark.
  // Fall back to the most recent lastHeartbeatAt as the duration's end point,
  // prefixed with "~" to mark it as a best-effort in-progress duration —
  // visually distinct from a completedAt-backed final duration.
  const durationEndAt = r.completedAt ?? r.lastHeartbeatAt;
  const durationCell = durationEndAt
    ? escapeHtml(
        `${r.completedAt ? "" : "~"}${fmtDuration(
          new Date(durationEndAt).getTime() - new Date(r.startedAt).getTime(),
        )}`,
      )
    : "—";

  // Last Heartbeat cell: relative time of the most recent debounced
  // progress-push, em-dash when the run never reported one (short/legacy
  // runs) — same convention as the other optional-timestamp cells here.
  const heartbeatCell = r.lastHeartbeatAt
    ? (() => {
        const heartbeatDate = new Date(r.lastHeartbeatAt as Date);
        return `<span title="${escapeHtml(heartbeatDate.toISOString())}">${escapeHtml(relativeTime(heartbeatDate, now))}</span>`;
      })()
    : "—";

  // Token totals are summed from the per-model breakdown rows — the sole
  // source of cron-run token data. A run with no breakdown shows an em-dash.
  const breakdown = r.modelBreakdown ?? [];
  const tokensCell =
    breakdown.length === 0
      ? "—"
      : (() => {
          const input = breakdown.reduce((sum, m) => sum + m.inputTokens, 0);
          const output = breakdown.reduce((sum, m) => sum + m.outputTokens, 0);
          return `${escapeHtml(String(input))} in / ${escapeHtml(String(output))} out`;
        })();

  const modelCell =
    r.modelBreakdown && r.modelBreakdown.length > 0
      ? r.modelBreakdown
          .map(
            (m) =>
              `<span class="badge" style="${MODEL_BADGE_STYLE}">${escapeHtml(m.model)} — $${m.costUsd.toFixed(4)}</span>`,
          )
          .join('<br style="line-height:6px" />')
      : "—";

  // Legacy five-job crons and runs with no phase attribution (including an
  // agent that hasn't reconciled its phase child rows yet) never set
  // phaseId — em-dash rather than a blank cell. Resolved by joining through
  // phaseId to the child AgentCronJob row's name and stripping the
  // "shipwright-" prefix to match the old string column's short-form display.
  const phaseCell = r.phaseCron?.name
    ? escapeHtml(r.phaseCron.name.replace(/^shipwright-/, ""))
    : "—";

  // A run with no dispatch (skipped tick, empty queue) leaves itemType/itemId
  // null — em-dash rather than a blank cell, same convention as phaseCell.
  // When set, render a distinctly-labeled Task/PR badge — a bare
  // "task: WLS-2.2" string forces the reader to parse itemType to infer
  // what kind of thing the id refers to.
  const itemCell =
    r.itemType && r.itemId
      ? `<span class="badge" style="${ITEM_TYPE_BADGE_STYLE[r.itemType] ?? ITEM_TYPE_BADGE_STYLE_DEFAULT}">${escapeHtml(ITEM_TYPE_LABEL[r.itemType] ?? r.itemType)}</span> <span class="mono" style="font-size:12px">${
          r.itemType === "task" || r.itemType === "pr"
            ? workItemLink(r.itemType, r.itemId)
            : escapeHtml(r.itemId)
        }</span>`
      : "—";

  // Session cell: render truncated sessionId (first 8 chars) with full id
  // in a title= tooltip, em-dash when null/undefined/empty string. Follows
  // the same monospace styling convention as other id cells.
  const sessionCell = r.sessionId?.trim()
    ? `<span class="mono" style="font-size:12px" title="${escapeHtml(r.sessionId)}">${escapeHtml(r.sessionId.substring(0, 8))}</span>`
    : "—";

  // Detail cell: mirrors badgeTitle's priority above — skipReason wins whenever
  // the run is skipped (even if error is also set), then falls back to error,
  // else renders an em-dash. Multi-line/long error text is truncated for
  // display via CSS (max-width/overflow/ellipsis) but fully present in a title
  // attribute. When the value is the em-dash "—", no title is needed.
  const detailCell = (() => {
    if (r.skipped && r.skipReason) {
      const escapedReason = escapeHtml(r.skipReason);
      return `<span title="${escapedReason}">${escapedReason}</span>`;
    }
    if (r.error) {
      const escapedError = escapeHtml(r.error);
      return `<span title="${escapedError}">${escapedError}</span>`;
    }
    return "—";
  })();

  return `<tr>
      ${agentCell !== undefined ? `<td style="font-size:12px">${agentCell}</td>` : ""}
      <td>${outcomeCell}</td>
      <td style="font-size:12px">${cronCell}</td>
      <td style="font-size:12px">${startedCell}</td>
      <td class="mono" style="font-size:12px">${durationCell}</td>
      <td style="font-size:12px">${heartbeatCell}</td>
      <td class="col-tokens mono" style="font-size:12px">${tokensCell}</td>
      <td class="col-model" style="font-size:12px">${modelCell}</td>
      <td style="font-size:12px">${phaseCell}</td>
      <td style="font-size:12px">${itemCell}</td>
      <td style="font-size:12px">${sessionCell}</td>
      <td style="font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${detailCell}</td>
    </tr>`;
}

/**
 * Renders the merged per-agent Queue & Activity page (AXR-3.1): an "Upcoming"
 * section showing the agent's self-reported ranked work queue (as last pushed
 * via POST /agents/:id/work-queue), and a "Past" section — a filter form
 * (cron dropdown + outcome dropdown) plus a table of cron runs across every
 * cron the agent owns, paginated consistently with renderPrsPage's pattern.
 *
 * Supersedes the former separate renderWorkQueuePage/renderCronLogsPage
 * pages/routes (now removed) — both existing services are composed onto one
 * page rather than duplicated across two.
 *
 * `agents` (AXR-3.4) drives the in-page agent-selector: the caller's full
 * accessible-agents list (admin: full fleet; non-admin: AgentMember-scoped),
 * with `agent` pre-selected. Defaults to `[agent]` so existing callers that
 * don't pass it still render a valid (single-option) selector.
 */
export function renderQueueActivityPage(opts: {
  agent: { id: string; name: string };
  agents?: AgentOption[];
  snapshot: WorkQueueSnapshotItem | null;
  crons: { id: string; name: string | null; schedule: string }[];
  runs: CronRunItem[];
  filters: { cronId?: string; outcome?: string };
  pagination: { total: number; limit: number; page: number };
  userName: string;
  timezone?: string;
  now?: Date;
}): string {
  const { agent, snapshot, crons, runs, filters, pagination, userName } = opts;
  const accessibleAgents = opts.agents ?? [agent];
  const timezone = opts.timezone ?? "America/Los_Angeles";
  const now = opts.now ?? new Date();

  // ─── Agent selector (AXR-3.4 / AAV-2) ───────────────────────────────────
  const agentSelectorHtml = renderAgentSelector({
    agents: accessibleAgents,
    selectedValue: agent.id,
    formAction: `/admin/agents/${agent.id}/queue-activity`,
  });

  // ─── Upcoming (work queue snapshot) ─────────────────────────────────────

  function queueRow(item: WorkQueueItem, index: number): string {
    return `<tr>
      <td class="mono" style="font-size:12px">${index + 1}</td>
      <td>${workQueueTypeCell(item.type)}</td>
      <td>${workQueuePhaseCell(item.phase)}</td>
      <td style="font-size:12px">${workQueueIdTitleCell(item)}</td>
      <td style="font-size:12px">${workQueueAgeCell(item.age, now)}</td>
    </tr>`;
  }

  const upcomingContent =
    snapshot === null
      ? `<div class="card">
      <div class="empty-state">No work queue snapshot yet for this agent. It will appear once the agent's shipwright-loop cron ticks and reports its ranked work queue.</div>
    </div>`
      : `<div style="margin-bottom:12px;font-size:12px;color:#6b7280">Last computed: ${escapeHtml(relativeTime(snapshot.computedAt, now))}</div>
    <div class="card">
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Phase</th>
              <th>Item</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            ${
              snapshot.items.length === 0
                ? `<tr><td colspan="5" class="empty-state">Queue is empty — nothing pending.</td></tr>`
                : snapshot.items.map(queueRow).join("\n")
            }
          </tbody>
        </table>
      </div>
    </div>`;

  // ─── Past (cron run history) ────────────────────────────────────────────

  function row(r: CronRunItem): string {
    return renderCronRunRow(r, { timezone, now, cronLinkAgentId: agent.id });
  }

  // Partition crons into visible (shipwright-loop) and collapsed (all others).
  // When filters.cronId narrows `runs` server-side to a single cron, the
  // visible/collapsed split is skipped entirely — every run already belongs
  // to the one cron the user asked to see, so splitting it into a collapsed
  // group would falsely report the primary table as empty even though the
  // matching runs exist (just tucked inside a closed <details> block).
  const { visibleCronIds, collapsedCronIds } =
    partitionCronsForActivityDisplay(crons);

  const isCronFiltered = Boolean(filters.cronId);

  // Separate runs into visible (primary table) and grouped (collapsed details blocks)
  const visibleRuns = isCronFiltered
    ? runs
    : runs.filter((r) => !r.cron || visibleCronIds.has(r.cron.id));

  // Group collapsed runs by cron ID, preserving insertion order of each cron
  const collapsedGroups = new Map<string, CronRunItem[]>();
  const collapsedCronOrder: string[] = [];
  if (!isCronFiltered) {
    for (const r of runs) {
      if (r.cron && collapsedCronIds.has(r.cron.id)) {
        if (!collapsedGroups.has(r.cron.id)) {
          collapsedCronOrder.push(r.cron.id);
          collapsedGroups.set(r.cron.id, []);
        }
        const group = collapsedGroups.get(r.cron.id);
        if (group) {
          group.push(r);
        }
      }
    }
  }

  const bodyRows =
    visibleRuns.length === 0
      ? `<tr><td colspan="10" class="empty-state">No runs match the selected filters.</td></tr>`
      : visibleRuns.map(row).join("\n");

  // Build collapsed detail blocks for non-loop crons
  const collapsedGroupsHtml = collapsedCronOrder
    .map((cronId) => {
      const groupRuns = collapsedGroups.get(cronId);
      if (!groupRuns) return "";
      const cron = crons.find((c) => c.id === cronId);
      if (!cron) return "";

      const cronLabel = cron.name ?? cron.schedule;
      const escapedLabel = escapeHtml(cronLabel);
      const groupBodyRows = groupRuns.map(row).join("\n");

      return `<details class="more-filters" style="margin-top:12px">
      <summary>${escapedLabel} (${groupRuns.length} run${groupRuns.length === 1 ? "" : "s"})</summary>
      <div class="card" style="margin-top:8px">
        <div class="data-table-wrapper">
          <table class="data-table">
            <thead>
              ${CRON_RUN_TABLE_HEAD}
            </thead>
            <tbody>
              ${groupBodyRows}
            </tbody>
          </table>
        </div>
      </div>
    </details>`;
    })
    .join("\n");

  // Filter form
  const cronOptions = crons
    .map((c) => {
      const label = c.name ?? c.schedule;
      const selected = filters.cronId === c.id ? "selected" : "";
      return `<option value="${escapeHtml(c.id)}" ${selected}>${escapeHtml(label)}</option>`;
    })
    .join("\n");

  const OUTCOME_OPTIONS = ["posted", "dm", "silent", "skipped", "error"];
  const outcomeOptions = OUTCOME_OPTIONS.map((o) => {
    const selected = filters.outcome === o ? "selected" : "";
    return `<option value="${o}" ${selected}>${o}</option>`;
  }).join("\n");

  // Pagination — mirrors renderPrsPage's pattern.
  const totalPages = Math.max(
    1,
    Math.ceil(pagination.total / pagination.limit),
  );
  const page = pagination.page;
  const makePageUrl = (p: number) => {
    const params = new URLSearchParams();
    if (filters.cronId) params.set("cronId", filters.cronId);
    if (filters.outcome) params.set("outcome", filters.outcome);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/admin/agents/${escapeHtml(agent.id)}/queue-activity${qs ? `?${qs}` : ""}`;
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

  return renderAdminPage({
    title: `Queue & Activity — ${agent.name} — Shipwright Admin`,
    extraStyles: "\n  ",
    body: `${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <a href="/admin/agents/${escapeHtml(agent.id)}" style="color:#6b7280;font-size:13px;text-decoration:none">← ${escapeHtml(agent.name)}</a>
      <h1 class="page-title" style="margin:0;flex:1">Queue &amp; Activity — ${escapeHtml(agent.name)}</h1>
      ${agentSelectorHtml}
    </div>

    <h2 class="section-title" style="font-size:14px;margin:0 0 8px">Upcoming</h2>
    ${upcomingContent}

    <h2 class="section-title" style="font-size:14px;margin:24px 0 8px">Past</h2>
    <div class="card" style="margin-bottom:16px">
      <form method="GET" action="/admin/agents/${escapeHtml(agent.id)}/queue-activity" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Cron</label>
          <select name="cronId" class="form-input" style="font-size:12px;padding:4px 8px">
            <option value="">Any</option>
            ${cronOptions}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Outcome</label>
          <select name="outcome" class="form-input" style="font-size:12px;padding:4px 8px">
            <option value="">Any</option>
            ${outcomeOptions}
          </select>
        </div>
        <button type="submit" class="btn btn-secondary" style="font-size:12px;padding:4px 12px">Filter</button>
        <a href="/admin/agents/${escapeHtml(agent.id)}/queue-activity" class="btn btn-secondary" style="font-size:12px;padding:4px 12px">Reset</a>
      </form>
    </div>

    <div class="card">
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            ${CRON_RUN_TABLE_HEAD}
          </thead>
          <tbody>
            ${bodyRows}
          </tbody>
        </table>
      </div>
      ${paginationHtml}
      ${collapsedGroupsHtml}
    </div>
  </div>`,
  });
}

// ─── Merged fleet-wide work queue (AAV-2.1) ─────────────────────────────────

/**
 * A merged, deduped work-queue row — the original WorkQueueItem fields plus
 * every agent id that currently has it queued (`queuedByAgentIds`) and every
 * agent id eligible to work it (`eligibleAgentIds`), both populated via
 * AAV-1.3's pure merge/eligibility helpers (agent-work-queue-merge.ts).
 */
export interface MergedWorkQueueRow extends WorkQueueItem {
  queuedByAgentIds: string[];
  eligibleAgentIds: string[];
}

/**
 * Derives the repo a work-queue item belongs to, for eligibility lookup via
 * AAV-1.3's buildEligibilityIndex()/annotateEligibility() (both keyed on a
 * `repo: string` field neither WorkQueueItem nor its source RankedWorkItem
 * carry today — see agent-work-queue-merge.ts's own doc comment, which
 * deliberately leaves this bridge to callers).
 *
 * PR items encode their repo directly in the id (`"org/repo#123"`, the same
 * convention workItemLink() parses). Task items carry no repo field
 * anywhere in the RankedWorkItem shape, so "" is returned — this never
 * matches any agent's repos[] (buildEligibilityIndex only ever indexes
 * non-empty repo strings), so a task row correctly renders zero eligible
 * agents rather than a guessed answer.
 */
function deriveWorkItemRepo(item: WorkQueueItem): string {
  if (item.type !== "pr") return "";
  const match = item.id.match(/^(.+)#(\d+)$/);
  return match ? match[1] : "";
}

/**
 * Pure, no-I/O composition of AAV-1.3's merge/eligibility helpers: dedupes
 * every accessible agent's latest work-queue snapshot by (type, id) via
 * mergeWorkQueueSnapshots(), then annotates each surviving row with the
 * agents eligible to work it (via buildEligibilityIndex()/
 * annotateEligibility(), keyed on each agent's repos[] and gated on
 * loopEnabled). Result is sorted
 * oldest-first by age, mirroring rankWorkItems()'s ordering convention
 * (agent/src/coding/work-selector.ts) so the merged Upcoming table reads the same
 * way a single agent's own queue does.
 */
export function buildMergedWorkQueueRows(
  snapshots: { agentId: string; items: WorkQueueItem[] }[],
  agents: { id: string; repos: string[]; loopEnabled: boolean }[],
): MergedWorkQueueRow[] {
  const merged = mergeWorkQueueSnapshots(snapshots);
  const index = buildEligibilityIndex(agents);
  const withRepo = merged.map((item) => ({
    ...item,
    repo: deriveWorkItemRepo(item),
  }));
  const annotated = annotateEligibility(withRepo, index);

  return annotated
    .map(({ repo: _repo, ...rest }) => rest)
    .sort((a, b) => (a.age < b.age ? -1 : a.age > b.age ? 1 : 0));
}

/**
 * Renders the merged, fleet-wide Queue & Activity view (AAV-2.1): the
 * destination `/admin/queue-activity` now renders directly (superseding the
 * former AXR-3.3 default-agent redirect) rather than bouncing to the first
 * accessible agent's own queue-activity page.
 *
 * Mirrors renderQueueActivityPage's two-section layout (Upcoming + Past) but
 * spans every accessible agent instead of one:
 *   - "Upcoming" is the deduped, cross-agent work queue (buildMergedWorkQueueRows'
 *     output) with two extra columns — Eligible agents and Queued by — and,
 *     unlike the single-agent page's uncapped display of one snapshot
 *     (at most 50 items), is paginated, since a merged view can span many
 *     agents' snapshots at once.
 *   - "Past" is a flat cron-run table across every accessible agent (via
 *     AgentCronRunService.listAcrossAgents(), AAV-1.1) with a leading Agent
 *     column; no per-cron collapse/partition grouping (that grouping exists
 *     to keep one agent's many crons legible — across a fleet, a flat,
 *     paginated table is the simpler, still-legible choice).
 *
 * The in-header agent selector (shared renderAgentSelector(), same component
 * as renderQueueActivityPage) defaults to "All agents" selected; choosing a
 * specific agent navigates to that agent's own /admin/agents/:id/queue-activity
 * page, completing the round trip the per-agent page's selector already
 * supports (AAV-2.2's "All agents" dropdown option navigates back here).
 */
export function renderMergedQueueActivityPage(opts: {
  agents: AgentOption[];
  agentNames: Record<string, string>;
  workQueueRows: MergedWorkQueueRow[];
  workQueuePagination: { total: number; limit: number; page: number };
  runs: CronRunItem[];
  runsPagination: { total: number; limit: number; page: number };
  userName: string;
  timezone?: string;
  now?: Date;
}): string {
  const {
    agents,
    agentNames,
    workQueueRows,
    workQueuePagination,
    runs,
    runsPagination,
    userName,
  } = opts;
  const timezone = opts.timezone ?? "America/Los_Angeles";
  const now = opts.now ?? new Date();

  // ─── Agent selector (AAV-2) ──────────────────────────────────────────────
  const agentSelectorHtml = renderAgentSelector({
    agents,
    selectedValue: ALL_AGENTS_SENTINEL,
    formAction: "/admin/queue-activity",
  });

  // ─── Upcoming (merged work queue) ───────────────────────────────────────

  function mergedQueueRow(item: MergedWorkQueueRow, index: number): string {
    return `<tr>
      <td class="mono" style="font-size:12px">${index + 1}</td>
      <td>${workQueueTypeCell(item.type)}</td>
      <td>${workQueuePhaseCell(item.phase)}</td>
      <td style="font-size:12px">${workQueueIdTitleCell(item)}</td>
      <td style="font-size:12px">${workQueueAgeCell(item.age, now)}</td>
      <td style="font-size:12px">${agentIdListCell(item.eligibleAgentIds, agentNames)}</td>
      <td style="font-size:12px">${agentIdListCell(item.queuedByAgentIds, agentNames)}</td>
    </tr>`;
  }

  const queuePaginationHtml = renderPaginationBar({
    pagination: workQueuePagination,
    basePath: "/admin/queue-activity",
    pageParam: "queuePage",
  });

  const upcomingContent =
    workQueuePagination.total === 0
      ? `<div class="card">
      <div class="empty-state">No work queue items across any accessible agent right now.</div>
    </div>`
      : `<div class="card">
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Phase</th>
              <th>Item</th>
              <th>Age</th>
              <th>Eligible agents</th>
              <th>Queued by</th>
            </tr>
          </thead>
          <tbody>
            ${workQueueRows.map(mergedQueueRow).join("\n")}
          </tbody>
        </table>
      </div>
      ${queuePaginationHtml}
    </div>`;

  // ─── Past (cron run history, flat across every accessible agent) ────────

  function row(r: CronRunItem): string {
    const agentId = r.agentId ?? "";
    const agentCell = agentId
      ? agentLink(agentId, agentNames[agentId] ?? agentId)
      : "—";
    return renderCronRunRow(r, {
      timezone,
      now,
      cronLinkAgentId: agentId,
      agentCell,
    });
  }

  const bodyRows =
    runs.length === 0
      ? `<tr><td colspan="11" class="empty-state">No runs across any accessible agent.</td></tr>`
      : runs.map(row).join("\n");

  const runsPaginationHtml = renderPaginationBar({
    pagination: runsPagination,
    basePath: "/admin/queue-activity",
    pageParam: "page",
  });

  return renderAdminPage({
    title: "Queue & Activity — All Agents — Shipwright Admin",
    extraStyles: "\n  ",
    body: `${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <a href="/admin/agents" style="color:#6b7280;font-size:13px;text-decoration:none">← Agents</a>
      <h1 class="page-title" style="margin:0;flex:1">Queue &amp; Activity — All Agents</h1>
      ${agentSelectorHtml}
    </div>

    <h2 class="section-title" style="font-size:14px;margin:0 0 8px">Upcoming</h2>
    ${upcomingContent}

    <h2 class="section-title" style="font-size:14px;margin:24px 0 8px">Past</h2>
    <div class="card">
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            ${MERGED_CRON_RUN_TABLE_HEAD}
          </thead>
          <tbody>
            ${bodyRows}
          </tbody>
        </table>
      </div>
      ${runsPaginationHtml}
    </div>
  </div>`,
  });
}
