/**
 * agent/src/admin-ui-pages.ts
 * Pure HTML rendering functions for admin UI pages.
 * No Hono dependencies — pure string → string functions.
 *
 * Follows the same inline HTML template string pattern as
 * metrics/src/dashboard/dashboard-page.ts.
 */

import { DEFAULT_CLAIM_TTL_MS } from "@shipwright/lib/claim-ttl";
import { PROGRESS_LABELS } from "@shipwright/lib/progress-phases";
import { renderAdminPage } from "./admin-ui-layout.ts";
import {
  BREAKPOINT_MOBILE_MAX,
  escapeHtml,
  renderAdminToolbar,
} from "./admin-ui-styles.ts";
import type { ManualStep } from "./agent-deletion-checklist.ts";
import {
  annotateEligibility,
  buildEligibilityIndex,
  mergeWorkQueueSnapshots,
} from "./agent-work-queue-merge.ts";
import type { AgentTypeOption } from "./agent-type-manifest-loader.ts";
import { parseChatMarkers } from "./chat-markers.ts";
import type {
  ChatMessage,
  ChatThread,
  MessageTokens,
  ThreadStats,
} from "./http-chat-client.ts";
import type { ModelBreakdownEntry } from "./openapi-schemas.ts";
import { renderPushToggle } from "./push-toggle.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Renders a link to a task's detail page, styled like the rest of the admin UI's inline links. */
function taskLink(taskId: string): string {
  return `<a href="/admin/tasks/${escapeHtml(taskId)}" style="color:#6366f1;text-decoration:none">${escapeHtml(taskId)}</a>`;
}

/**
 * Renders a link to an agent's detail page. `label` defaults to the agent id
 * but callers pass a display name (e.g. "Xray Agent (agent-x)") when one is
 * available from an `agentNames` lookup map, keeping the link text
 * human-readable while still routing by id.
 */
function agentLink(agentId: string, label?: string): string {
  return `<a href="/admin/agents/${escapeHtml(agentId)}" style="color:#6366f1;text-decoration:none">${escapeHtml(label ?? agentId)}</a>`;
}

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

/**
 * Returns a human-friendly relative timestamp.
 * Examples: "just now", "5 minutes ago", "2 hours ago", "3 days ago", "1 week ago"
 *
 * @param date - the timestamp to describe
 * @param now  - the reference "current" time (defaults to wall clock; override in tests for determinism)
 */
function relativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return `${diffWeek} week${diffWeek === 1 ? "" : "s"} ago`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

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
}

export interface AgentListItem {
  id: string;
  name: string;
  slackId: string | null;
  createdAt: Date;
  selfHosted?: boolean;
}

export interface AgentDetail {
  id: string;
  name: string;
  slackId: string | null;
  selfHosted: boolean;
  createdAt: Date;
  updatedAt: Date;
  repos: string[];
  authorAllowlist: string[];
  patchAuthorAllowlist: string[];
  /**
   * When true, only AgentMember emails may message this agent over Slack.
   * Rendered as a checkbox on both the create and edit forms.
   */
  restrictSlackToMembers: boolean;
  /** The agent's type name (e.g. "coding"), resolved at creation time. */
  typeName: string;
  /**
   * Required env keys declared by the agent's type manifest with no
   * corresponding AgentEnv row yet — key names only, never values. Always
   * present; purely informational (ATS-4.2), see renderAgentDetailPage's Env
   * Vars card.
   */
  missingRequiredEnv: string[];
}

export interface CronJobItem {
  id: string;
  schedule: string;
  prompt: string;
  channel: string | null;
  user: string | null;
  enabled: boolean;
  name: string | null;
  system: boolean;
  parentCronId: string | null;
  preCheck?: string | null;
  lastRun?: {
    startedAt: Date;
    completedAt: Date | null;
    skipped: boolean;
    outcome: string | null;
  } | null;
  runCountToday?: number;
  createdAt: Date;
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

// Inline CSS for cron-run outcome badges, keyed by outcome string.
// Shared by the cron rows on the agent detail page and the cron runs page.
const CRON_OUTCOME_STYLE: Record<string, string> = {
  posted: "background:#22c55e;color:white",
  dm: "background:#3b82f6;color:white",
  silent: "background:#9ca3af;color:white",
  skipped: "background:#f59e0b;color:white",
  error: "background:#ef4444;color:white",
};
const CRON_OUTCOME_STYLE_DEFAULT = "background:#9ca3af;color:white";

/** Resolve the badge style for a cron outcome, falling back to a neutral gray. */
function cronOutcomeStyle(outcome: string | null | undefined): string {
  return CRON_OUTCOME_STYLE[outcome ?? ""] ?? CRON_OUTCOME_STYLE_DEFAULT;
}

/** Label for a cron run's outcome badge — "skipped" takes priority over outcome. */
function cronRunOutcomeLabel(run: {
  skipped: boolean;
  outcome: string | null;
}): string {
  return run.skipped ? "skipped" : (run.outcome ?? "unknown");
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

export interface ToolItem {
  id: string;
  pattern: string;
  enabled: boolean;
  createdAt: Date;
}

export interface TokenItem {
  id: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface PluginItem {
  id: string;
  name: string;
  version: string | null;
  enabled: boolean;
  createdAt: Date;
}

export interface MemberItem {
  id: string;
  email: string;
  createdAt: Date;
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
}

// ─── Inline markdown renderer ─────────────────────────────────────────────────

/**
 * Render a markdown string to safe HTML.
 * HTML is escaped FIRST to prevent XSS, then markdown patterns are applied
 * to generate a known-safe set of HTML tags.
 */
function renderMarkdown(text: string): string {
  // Step 1: escape all HTML entities so raw user input can't inject tags
  let out = escapeHtml(text);

  // Step 2: extract code blocks into placeholder tokens before line processing
  // so that interior lines of a fenced block are never handed to the line loop.
  const codeBlocks: string[] = [];
  // Use Unicode Private Use Area sentinels — never appear in HTML-escaped markdown,
  // and are not control characters (biome noControlCharactersInRegex safe).
  const PLACEHOLDER_PREFIX = "CODE_BLOCK_";
  const PLACEHOLDER_SUFFIX = "";
  const placeholder = (n: number) =>
    `${PLACEHOLDER_PREFIX}${n}${PLACEHOLDER_SUFFIX}`;
  const PLACEHOLDER_RE = /^CODE_BLOCK_(\d+)$/;

  // Multi-line fenced blocks: ```\n...\n```
  out = out.replace(/```[\r\n]([\s\S]*?)[\r\n]```/g, (_m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return placeholder(idx);
  });
  // Same-line fenced blocks: ```code```
  out = out.replace(/```([^`\n]+)```/g, (_m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return placeholder(idx);
  });

  // Step 3: process line-by-line for block-level elements
  const lines = out.split("\n");
  const result: string[] = [];
  let inUl = false;
  let inOl = false;

  const closeList = () => {
    if (inUl) {
      result.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      result.push("</ol>");
      inOl = false;
    }
  };

  for (const line of lines) {
    // Placeholder lines are pre-rendered code blocks — emit as-is
    const placeholderMatch = PLACEHOLDER_RE.exec(line);
    if (placeholderMatch) {
      closeList();
      result.push(codeBlocks[Number.parseInt(placeholderMatch[1], 10)]);
      continue;
    }

    // Headings
    const h3 = line.match(/^### (.+)$/);
    const h2 = line.match(/^## (.+)$/);
    const h1 = line.match(/^# (.+)$/);

    if (h3) {
      closeList();
      result.push(`<h3>${applyInline(h3[1])}</h3>`);
    } else if (h2) {
      closeList();
      result.push(`<h2>${applyInline(h2[1])}</h2>`);
    } else if (h1) {
      closeList();
      result.push(`<h1>${applyInline(h1[1])}</h1>`);
    } else if (/^[-*] /.test(line)) {
      // Unordered list item
      if (inOl) {
        closeList();
      }
      if (!inUl) {
        result.push("<ul>");
        inUl = true;
      }
      result.push(`<li>${applyInline(line.replace(/^[-*] /, ""))}</li>`);
    } else if (/^\d+\. /.test(line)) {
      // Ordered list item
      if (inUl) {
        closeList();
      }
      if (!inOl) {
        result.push("<ol>");
        inOl = true;
      }
      result.push(`<li>${applyInline(line.replace(/^\d+\. /, ""))}</li>`);
    } else if (line.trim() === "") {
      closeList();
      result.push("");
    } else {
      closeList();
      result.push(applyInline(line));
    }
  }
  closeList();

  return result.join("\n");
}

/** Apply inline markdown transforms (bold, inline code) to an already-escaped string. */
function applyInline(s: string): string {
  // Inline code: `code` — must come before bold to avoid double-processing
  const withCode = s.replace(
    /`([^`]+)`/g,
    (_m, code) => `<code>${code}</code>`,
  );
  // Bold: **text**
  return withCode.replace(
    /\*\*([^*]+)\*\*/g,
    (_m, text) => `<strong>${text}</strong>`,
  );
}

// ─── Login page ───────────────────────────────────────────────────────────────

export function renderLoginPage(opts?: {
  error?: string;
  returnTo?: string;
  oktaEnabled?: boolean;
}): string {
  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const googleHref = opts?.returnTo
    ? `/admin/auth/google?returnTo=${encodeURIComponent(opts.returnTo)}`
    : "/admin/auth/google";

  const oktaHref = opts?.returnTo
    ? `/admin/auth/okta?returnTo=${encodeURIComponent(opts.returnTo)}`
    : "/admin/auth/okta";

  const oktaButtonHtml = opts?.oktaEnabled
    ? `<a href="${oktaHref}" class="btn btn-primary" style="width:100%;justify-content:center;text-decoration:none">Sign in with Okta</a>`
    : "";

  return renderAdminPage({
    title: "Admin Login — Shipwright",
    body: `<div class="login-wrapper">
    <div class="login-card">
      <h1 class="login-title">Shipwright Admin</h1>
      <p class="login-subtitle">Sign in to manage your agents.</p>
      ${errorHtml}
      <a href="${googleHref}" class="btn btn-primary" style="width:100%;justify-content:center;text-decoration:none">Sign in with Google</a>
      ${oktaButtonHtml}
    </div>
  </div>`,
  });
}

// ─── Agents list page ─────────────────────────────────────────────────────────

export function renderAgentsPage(
  agents: AgentListItem[],
  userName: string,
  isAdmin: boolean,
  timezone: string,
  opts?: { successMsg?: string; manualSteps?: ManualStep[] },
): string {
  const successHtml = opts?.successMsg
    ? `<div class="alert alert-success">${escapeHtml(opts.successMsg)}</div>`
    : "";

  const manualStepsHtml =
    opts?.manualSteps && opts.manualSteps.length > 0
      ? `<div class="alert alert-warning" id="manual-steps-panel" style="position:relative;padding-right:32px">
      <button type="button" onclick="document.getElementById('manual-steps-panel').style.display='none'"
              style="position:absolute;top:8px;right:10px;background:none;border:none;cursor:pointer;font-size:14px;color:inherit" aria-label="Dismiss">×</button>
      <strong>Manual cleanup required:</strong>
      <ul style="margin:8px 0 0 20px">
        ${opts.manualSteps.map((s) => `<li>${escapeHtml(s.message)}</li>`).join("\n        ")}
      </ul>
    </div>`
      : "";

  const rows =
    agents.length === 0
      ? `<tr><td colspan="4" class="empty-state">${isAdmin ? 'No agents yet. <a href="/admin/agents/new">Create one →</a>' : "No agents."}</td></tr>`
      : agents
          .map(
            (a) => `<tr>
    <td><a href="/admin/agents/${escapeHtml(a.id)}" class="agent-link">${escapeHtml(a.name)}</a></td>
    <td class="mono">${a.slackId ? escapeHtml(a.slackId) : '<span style="color:#9ca3af">—</span>'}</td>
    <td>${escapeHtml(new Date(a.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
    <td>
      <a href="/admin/agents/${escapeHtml(a.id)}" class="btn btn-secondary" style="font-size:12px;padding:4px 10px">Manage</a>
      <a href="/admin/agents/${escapeHtml(a.id)}/queue-activity" class="btn btn-secondary" style="font-size:12px;padding:4px 10px;margin-left:4px">Queue &amp; Activity</a>
    </td>
  </tr>`,
          )
          .join("\n");

  // Single CTA to create an agent — the /admin/agents/new page handles agent
  // creation and provides inline options to connect Slack/GitHub if desired.
  const createAgentButtons = isAdmin
    ? `<a href="/admin/agents/new" class="btn btn-primary">+ New agent</a>`
    : "";

  return renderAdminPage({
    title: "Agents — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Agents</h1>
      ${createAgentButtons}
    </div>
    ${successHtml}
    ${manualStepsHtml}
    <div class="card">
      <table class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Slack ID</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </div>`,
  });
}

// ─── New agent page ───────────────────────────────────────────────────────────

// The three Slack/GitHub sections (restrict-slack-group, slack-section,
// github-section) are meaningless for self-hosted agents — self-hosted uses
// local git config for GitHub auth, not admin-managed provisioning — so they
// are shown only when "Provisioned in-cluster" is selected. `display` is
// either "" (visible) or "none" (hidden).
function runtimeSectionsOnchange(display: "" | "none"): string {
  const ids = ["restrict-slack-group", "slack-section", "github-section"];
  return ids
    .map((id) => `document.getElementById('${id}').style.display='${display}'`)
    .join(";");
}

export function renderNewLocalAgentPage(
  userName: string,
  types: AgentTypeOption[],
  opts?: { error?: string; canProvision?: boolean },
): string {
  const error = opts?.error;
  // Whether the admin service can actually create cluster resources. When it
  // can't (NoopAgentProvisioner — SHIPWRIGHT_K8S_PROVISIONING unset), offering
  // "in-cluster" would silently produce an agent row with no pod, so the option
  // is rendered disabled and self-hosted is preselected.
  const canProvision = opts?.canProvision ?? false;
  // Slack/GitHub sections are only relevant to in-cluster (admin-provisioned)
  // agents — self-hosted agents use local git config for GitHub auth. Their
  // initial visibility must match whichever runtime radio is preselected
  // above (canProvision===true → in-cluster preselected → visible).
  const runtimeSectionsDisplay: "" | "none" = canProvision ? "" : "none";
  const errorHtml = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : "";
  const typeOptions = types
    .map(
      (t) =>
        `<option value="${escapeHtml(t.name)}">${escapeHtml(t.displayName)}</option>`,
    )
    .join("\n");
  return renderAdminPage({
    title: "New Agent — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header">
      <div>
        <a href="/admin/agents" style="font-size:13px;color:#6b7280;text-decoration:none">← Agents</a>
        <h1 class="page-title" style="margin-top:4px">New Agent</h1>
      </div>
    </div>
    ${errorHtml}
    <div class="card">
      <p style="font-size:14px;color:#6b7280;margin-bottom:20px">
        Create an agent and choose where it runs. Slack and GitHub connections
        below are optional — you can always talk to the agent from the
        <a href="/admin/chat">Chat</a> tab first and connect them later from
        the agent detail page.
      </p>
      <form method="POST" action="/admin/agents" enctype="multipart/form-data" style="display:flex;flex-direction:column;gap:16px">
        <div class="form-group">
          <label class="form-label" for="name">Agent name <span style="color:#ef4444">*</span></label>
          <input
            id="name"
            name="name"
            type="text"
            class="form-input"
            placeholder="my-agent"
            required
            autofocus
          />
        </div>
        <div class="form-group">
          <label class="form-label" for="type">Agent type <span style="color:#ef4444">*</span></label>
          <select id="type" name="type" class="form-input" required>
            ${typeOptions}
          </select>
        </div>
        <fieldset style="border:1px solid #e8e8ee;border-radius:8px;padding:16px">
          <legend style="font-size:13px;font-weight:600;padding:0 8px">Runtime</legend>
          <div class="form-group" style="margin-bottom:0">
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">
              <input type="radio" name="runtime" value="in-cluster" ${canProvision ? "checked" : "disabled"}
                onchange="${runtimeSectionsOnchange("")}"
              />
              Provisioned in-cluster
              <span style="font-weight:400;color:#6b7280">
                — the admin service creates the Deployment, Secret, and PVC for you.
              </span>
            </label>
            <label style="display:block;font-size:13px;font-weight:500">
              <input type="radio" name="runtime" value="self-hosted" ${canProvision ? "" : "checked"}
                onchange="${runtimeSectionsOnchange("none")}"
              />
              Self-hosted
              <span style="font-weight:400;color:#6b7280">
                — you run the container yourself (<span class="mono">task stack</span>, local Docker).
              </span>
            </label>
            ${
              canProvision
                ? ""
                : `<p style="font-size:12px;color:#6b7280;margin-top:8px">
              In-cluster provisioning is unavailable — <span class="mono">SHIPWRIGHT_K8S_PROVISIONING</span> is not enabled on this admin service.
            </p>`
            }
          </div>
        </fieldset>
        <div class="form-group">
          <label class="form-label" for="claudeCodeOauthToken">Claude Code OAuth Token (optional)</label>
          <input
            id="claudeCodeOauthToken"
            name="claudeCodeOauthToken"
            type="password"
            class="form-input"
            placeholder="sk-ant-oat01-..."
          />
          <p style="font-size:12px;color:#6b7280;margin-top:4px">
            Stored as the agent's <span class="mono">CLAUDE_CODE_OAUTH_TOKEN</span>. Required for the agent
            to run — set it here or from the agent detail page.
          </p>
        </div>
        <div class="form-group">
          <label class="form-label" for="anthropicApiKey">Anthropic API Key (optional)</label>
          <input
            id="anthropicApiKey"
            name="anthropicApiKey"
            type="password"
            class="form-input"
            placeholder="sk-ant-..."
          />
          <p style="font-size:12px;color:#6b7280;margin-top:4px">
            Stored as the agent's <span class="mono">ANTHROPIC_API_KEY</span>.
          </p>
        </div>
        <div class="form-group">
          <label class="form-label" for="repos">Repos (optional, one per line)</label>
          <textarea
            id="repos"
            name="repos"
            class="form-input"
            rows="4"
            placeholder="my-org/repo-one&#10;my-org/repo-two"
          ></textarea>
          <p style="font-size:12px;color:#6b7280;margin-top:4px">Format: <span class="mono">org/repo</span></p>
        </div>
        <div class="form-group">
          <label class="form-label" for="authorAllowlist">Author allowlist (review) (optional, one GitHub login per line)</label>
          <textarea
            id="authorAllowlist"
            name="authorAllowlist"
            class="form-input"
            rows="4"
            placeholder="octocat&#10;another-user"
          ></textarea>
          <p style="font-size:12px;color:#6b7280;margin-top:4px">GitHub login, one per line</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="patchAuthorAllowlist">Patch author allowlist (optional, one GitHub login per line)</label>
          <textarea
            id="patchAuthorAllowlist"
            name="patchAuthorAllowlist"
            class="form-input"
            rows="4"
            placeholder="octocat&#10;another-user"
          ></textarea>
          <p style="font-size:12px;color:#6b7280;margin-top:4px">GitHub login, one per line</p>
        </div>
        <div id="restrict-slack-group" style="display:${runtimeSectionsDisplay}">
          <div class="form-group" style="display:flex;align-items:center;gap:6px">
            <input
              id="restrictSlackToMembers"
              name="restrictSlackToMembers"
              type="checkbox"
              value="true"
              onchange="document.getElementById('member-emails-fields').style.display=this.checked?'block':'none'"
            />
            <label class="form-label" for="restrictSlackToMembers" style="margin-bottom:0">Restrict Slack to members</label>
          </div>
          <p style="font-size:12px;color:#6b7280;margin-top:-12px">
            When enabled, only AgentMember emails may message this agent over Slack. If the agent has no
            members yet, enabling this will block all Slack senders.
          </p>
          <div id="member-emails-fields" style="display:none;margin-top:12px">
            <div class="form-group">
              <label class="form-label" for="memberEmails">Member emails (optional, one per line)</label>
              <textarea
                id="memberEmails"
                name="memberEmails"
                class="form-input"
                rows="4"
                placeholder="alice@example.com&#10;bob@example.com"
              ></textarea>
              <p style="font-size:12px;color:#6b7280;margin-top:4px">Email address, one per line</p>
            </div>
          </div>
        </div>
        <fieldset id="slack-section" style="display:${runtimeSectionsDisplay};border:1px solid #e8e8ee;border-radius:8px;padding:16px">
          <legend style="font-size:13px;font-weight:600;padding:0 8px">Slack (optional)</legend>
          <div class="form-group" style="display:flex;align-items:center;gap:6px;margin-bottom:0">
            <input
              id="connectSlack"
              name="connectSlack"
              type="checkbox"
              value="true"
              onchange="document.getElementById('slack-fields').style.display=this.checked?'block':'none'"
            />
            <label class="form-label" for="connectSlack" style="margin-bottom:0">Connect Slack</label>
          </div>
          <div id="slack-fields" style="display:none;margin-top:12px">
            <div class="form-group">
              <label class="form-label" for="xoxpToken">Slack App Configuration Token</label>
              <input
                id="xoxpToken"
                name="xoxpToken"
                type="password"
                class="form-input"
                placeholder="xoxe.xoxp-..."
              />
              <p style="font-size:12px;color:#6b7280;margin-top:4px">
                This token is used once to create the Slack app manifest. It is not stored. After
                creating the agent you'll be redirected to authorize the Slack app.
              </p>
            </div>
          </div>
        </fieldset>
        <fieldset id="github-section" style="display:${runtimeSectionsDisplay};border:1px solid #e8e8ee;border-radius:8px;padding:16px">
          <legend style="font-size:13px;font-weight:600;padding:0 8px">GitHub Authentication (optional)</legend>
          <!--
            ghAppMode disambiguates the two ghAuthMode="app" radios below
            (Create GitHub App = auto, Use existing GitHub App = manual).
            Each app-mode radio's onchange sets this hidden field alongside
            showing/hiding its own fields block; it defaults to "auto" so a
            plain ghAuthMode=app submission (the historical default) is
            unaffected. See UAP-5.3.
          -->
          <input type="hidden" id="ghAppMode" name="ghAppMode" value="auto" />
          <div class="form-group" style="margin-bottom:12px">
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">
              <input type="radio" name="ghAuthMode" value="skip" checked
                onchange="document.getElementById('gh-pat-fields').style.display='none';document.getElementById('gh-app-fields').style.display='none';document.getElementById('gh-app-manual-fields').style.display='none'"
              /> Skip
              <span style="font-weight:400;color:#6b7280">
                — connect GitHub later from the agent detail page.
              </span>
            </label>
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">
              <input type="radio" name="ghAuthMode" value="pat"
                onchange="document.getElementById('gh-pat-fields').style.display='block';document.getElementById('gh-app-fields').style.display='none';document.getElementById('gh-app-manual-fields').style.display='none'"
              /> Personal Access Token
            </label>
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">
              <input type="radio" name="ghAuthMode" value="app"
                onchange="document.getElementById('ghAppMode').value='auto';document.getElementById('gh-pat-fields').style.display='none';document.getElementById('gh-app-fields').style.display='block';document.getElementById('gh-app-manual-fields').style.display='none'"
              /> Create GitHub App
            </label>
            <label style="display:block;font-size:13px;font-weight:500">
              <input type="radio" name="ghAuthMode" value="app"
                onchange="document.getElementById('ghAppMode').value='manual';document.getElementById('gh-pat-fields').style.display='none';document.getElementById('gh-app-fields').style.display='none';document.getElementById('gh-app-manual-fields').style.display='block'"
              /> Use existing GitHub App
              <span style="font-weight:400;color:#6b7280">
                — connect a GitHub App you've already created.
              </span>
            </label>
          </div>
          <div id="gh-pat-fields" style="display:none">
            <div class="form-group">
              <label class="form-label" for="ghPat">Personal Access Token</label>
              <input id="ghPat" name="ghPat" type="password" class="form-input" placeholder="ghp_..." />
            </div>
          </div>
          <div id="gh-app-fields" style="display:none">
            <div class="form-group">
              <label class="form-label" for="githubOrg">GitHub org</label>
              <input id="githubOrg" name="githubOrg" type="text" class="form-input" placeholder="my-org" />
              <p style="font-size:12px;color:#6b7280;margin-top:4px">
                You'll be redirected to GitHub to create the App under this organization from a manifest.
              </p>
            </div>
          </div>
          <div id="gh-app-manual-fields" style="display:none">
            <div class="form-group">
              <label class="form-label" for="ghAppId">GitHub App ID</label>
              <input id="ghAppId" name="ghAppId" type="text" class="form-input" placeholder="App ID" />
            </div>
            <div class="form-group">
              <label class="form-label" for="ghAppInstallationId">Installation ID</label>
              <input id="ghAppInstallationId" name="ghAppInstallationId" type="text" class="form-input" placeholder="Installation ID" />
            </div>
            <div class="form-group">
              <label class="form-label" for="ghAppPrivateKeyFile">Private Key (.pem)</label>
              <input id="ghAppPrivateKeyFile" name="ghAppPrivateKeyFile" type="file" accept=".pem" class="form-input" />
              <p style="font-size:12px;color:#6b7280;margin-top:4px">
                Upload the private key <span class="mono">.pem</span> file you downloaded when creating the GitHub App.
              </p>
            </div>
          </div>
        </fieldset>
        <div>
          <button type="submit" class="btn btn-primary">Create agent →</button>
          <a href="/admin/agents" class="btn btn-secondary" style="margin-left:8px">Cancel</a>
        </div>
      </form>
    </div>
  </div>`,
  });
}

// ─── Agent detail page ────────────────────────────────────────────────────────

/**
 * A single "connect later" action on the agent detail page (Connect Slack /
 * Set up GitHub App / Add GitHub PAT / Use existing GitHub App) — a
 * `<details>/<summary>` popover mirroring the "Sync Manifest" pattern.
 * `envKey` is the per-agent AgentEnv key whose presence in `envVars` means
 * this integration is already configured, hiding the action.
 *
 * `inputs` is an array so an action can collect more than one field (e.g.
 * the manual GitHub App connect needs App ID + Installation ID + a Private
 * Key file upload) — every existing action still supplies exactly one entry.
 */
interface ConnectActionConfig {
  envKey: string;
  label: string;
  description: string;
  action: string;
  hiddenFields?: Record<string, string>;
  inputs: Array<{
    name: string;
    type: "text" | "password" | "file";
    placeholder?: string;
    mono?: boolean;
  }>;
}

function renderConnectAction(
  envVars: Record<string, string>,
  cfg: ConnectActionConfig,
): string {
  if (cfg.envKey in envVars) return "";
  const hiddenInputs = Object.entries(cfg.hiddenFields ?? {})
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`,
    )
    .join("\n              ");
  const hasFileInput = cfg.inputs.some((input) => input.type === "file");
  const visibleInputs = cfg.inputs
    .map(
      (input) => `<input
                name="${escapeHtml(input.name)}"
                type="${input.type}"
                class="form-input${input.mono ? " mono" : ""}"
                ${input.placeholder ? `placeholder="${escapeHtml(input.placeholder)}"` : ""}
                required
                style="font-size:12px"
              />`,
    )
    .join("\n              ");
  return `<details style="position:relative">
          <summary class="btn btn-secondary" style="cursor:pointer;font-size:12px;list-style:none">${escapeHtml(cfg.label)}</summary>
          <div style="position:absolute;left:0;margin-top:6px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08);z-index:10;min-width:320px">
            <p style="font-size:12px;color:#6b7280;margin:0 0 10px">${cfg.description}</p>
            <form method="POST" action="${cfg.action}"${hasFileInput ? ' enctype="multipart/form-data"' : ""} style="display:flex;flex-direction:column;gap:8px">
              ${hiddenInputs}
              ${visibleInputs}
              <button type="submit" class="btn btn-primary" style="font-size:12px;align-self:flex-start">${escapeHtml(cfg.label)}</button>
            </form>
          </div>
        </details>`;
}

export function renderAgentDetailPage(
  agent: AgentDetail,
  envResult:
    | { env: Record<string, string>; secretKeys: string[] }
    | Record<string, string>,
  crons: CronJobItem[],
  tools: ToolItem[],
  tokens: TokenItem[],
  plugins: PluginItem[],
  members: MemberItem[],
  userName: string,
  isAdmin: boolean,
  opts?: {
    error?: string;
    newToken?: string;
    successMsg?: string;
    /**
     * Non-blocking warning surfaced when restrictSlackToMembers was just set
     * to true on an agent with zero AgentMember rows — the save already
     * succeeded, this is purely informational.
     */
    warning?: string;
    now?: Date;
    timezone?: string;
  },
): string {
  // Reference time for relative timestamps — injected by tests for determinism,
  // defaults to wall clock in production.
  const now = opts?.now ?? new Date();
  const timezone = opts?.timezone ?? "America/Los_Angeles";

  // Normalise envResult — accept both the new {env, secretKeys} shape and the
  // legacy Record<string,string> shape for backward compatibility.
  const envVars =
    envResult &&
    "env" in envResult &&
    typeof (envResult as { env: unknown }).env === "object"
      ? (envResult as { env: Record<string, string>; secretKeys: string[] }).env
      : (envResult as Record<string, string>);
  const secretKeySet = new Set<string>(
    envResult && "secretKeys" in envResult
      ? (envResult as { secretKeys: string[] }).secretKeys
      : [],
  );

  const envRows =
    Object.keys(envVars).length === 0
      ? `<tr><td colspan="3" class="empty-state">No env vars set.</td></tr>`
      : Object.entries(envVars)
          .map(
            ([k]) => `<tr>
      <td class="mono">${escapeHtml(k)}${secretKeySet.has(k) ? ' <span title="Secret">🔒</span>' : ""}</td>
      <td class="mono" style="color:#6b7280">••••••••</td>
      <td>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/envs/delete" style="display:inline">
          <input type="hidden" name="key" value="${escapeHtml(k)}" />
          <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Delete</button>
        </form>
      </td>
    </tr>`,
          )
          .join("\n");

  // "Connect later" actions (UAP-2.3) — each hidden once its AgentEnv key is
  // already set, mirroring the "Sync Manifest" visibility pattern.
  const connectActionConfigs: ConnectActionConfig[] = [
    {
      envKey: "SLACK_APP_TOKEN",
      label: "Connect Slack",
      description: `Connects this agent to a Slack app. Requires a Slack app configuration token (<span class="mono">xoxe.xoxp-</span>).`,
      action: `/admin/agents/${escapeHtml(agent.id)}/connect-slack`,
      inputs: [
        {
          name: "xoxpToken",
          type: "password",
          placeholder: "xoxe.xoxp-...",
          mono: true,
        },
      ],
    },
    {
      envKey: "GH_APP_ID",
      label: "Set up GitHub App",
      description:
        "Creates a GitHub App for this agent from a manifest. You'll be redirected to GitHub to finish creating it under the chosen org.",
      action: `/admin/agents/${escapeHtml(agent.id)}/connect-github`,
      hiddenFields: { ghAuthMode: "app", ghAppMode: "auto" },
      inputs: [{ name: "githubOrg", type: "text", placeholder: "my-org" }],
    },
    {
      envKey: "GH_APP_ID",
      label: "Use existing GitHub App",
      description:
        "Connects an existing GitHub App you've already created — paste its App ID and Installation ID, and upload its private key (PEM file).",
      action: `/admin/agents/${escapeHtml(agent.id)}/connect-github`,
      hiddenFields: { ghAuthMode: "app", ghAppMode: "manual" },
      inputs: [
        { name: "ghAppId", type: "text", placeholder: "App ID" },
        {
          name: "ghAppInstallationId",
          type: "text",
          placeholder: "Installation ID",
        },
        { name: "ghAppPrivateKeyFile", type: "file" },
      ],
    },
    {
      envKey: "GH_TOKEN",
      label: "Add GitHub PAT",
      description:
        "Connects this agent to GitHub using a personal access token.",
      action: `/admin/agents/${escapeHtml(agent.id)}/connect-github`,
      hiddenFields: { ghAuthMode: "pat" },
      inputs: [
        {
          name: "ghPat",
          type: "password",
          placeholder: "ghp_...",
          mono: true,
        },
      ],
    },
  ];
  const connectActions = connectActionConfigs
    .map((cfg) => renderConnectAction(envVars, cfg))
    .filter(Boolean);

  const connectActionsHtml =
    connectActions.length === 0
      ? ""
      : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${connectActions.join("\n        ")}
      </div>`;

  // Top-level rows exclude any cron parented under another (e.g. shipwright-loop's
  // dev-task/review/patch/deploy phases) — those render nested beneath their
  // parent instead. `crons` (unfiltered) stays available below to look up each
  // top-level cron's children by parentCronId.
  const topLevelCrons = crons.filter((c) => !c.parentCronId);
  const systemCrons = topLevelCrons.filter((c) => c.system);
  const customCrons = topLevelCrons.filter((c) => !c.system);

  /** Renders the reusable Logs/Toggle[/Delete] action cell shared by top-level and nested cron rows. */
  function renderCronActions(c: CronJobItem): string {
    const toggleLabel = c.enabled ? "Disable" : "Enable";
    const toggleTarget = c.enabled ? "false" : "true";
    return `
      <a href="/admin/agents/${escapeHtml(agent.id)}/queue-activity?cronId=${escapeHtml(c.id)}" class="btn btn-secondary" style="font-size:11px;padding:3px 8px;margin-right:4px;text-decoration:none">Logs</a>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/crons/${escapeHtml(c.id)}/toggle" style="display:inline">
        <input type="hidden" name="enabled" value="${toggleTarget}" />
        <button type="submit" class="btn btn-secondary" style="font-size:11px;padding:3px 8px">${toggleLabel}</button>
      </form>
      ${
        !c.system
          ? `<form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/crons/${escapeHtml(c.id)}/delete" style="display:inline;margin-left:4px">
        <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Delete</button>
      </form>`
          : ""
      }`;
  }

  /**
   * Renders the nested "Phases of <parent>" block for a top-level cron's
   * children (e.g. shipwright-loop's dev-task/review/patch/deploy phases).
   * Returns "" when there are no children, so parents without phases (all
   * custom crons, and any system cron other than shipwright-loop) render
   * exactly as before — no empty block.
   */
  function renderNestedPhasesRow(
    parent: CronJobItem,
    children: CronJobItem[],
  ): string {
    if (children.length === 0) return "";
    const parentLabel = parent.name ?? parent.id;
    const childRows = children
      .map((child) => {
        const lastRunOutcomeLabel = child.lastRun
          ? cronRunOutcomeLabel(child.lastRun)
          : null;
        return `<tr>
          <td style="padding-left:20px">${escapeHtml(child.name ? `${child.name}: ${child.prompt}` : child.prompt)}</td>
          <td class="mono">${escapeHtml(child.schedule)}</td>
          <td><span class="badge ${child.enabled ? "badge-green" : "badge-gray"}">${child.enabled ? "enabled" : "disabled"}</span></td>
          <td style="font-size:11px">${
            child.lastRun?.startedAt
              ? `<span class="badge" style="${cronOutcomeStyle(lastRunOutcomeLabel)}">${escapeHtml(lastRunOutcomeLabel ?? "unknown")}</span>`
              : `<span style="color:#d1d5db">never</span>`
          }</td>
          <td style="white-space:nowrap">${renderCronActions(child)}</td>
        </tr>`;
      })
      .join("\n");
    return `<tr>
      <td colspan="8" style="background:#f9fafb;padding:12px 12px 12px 32px">
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Phases of ${escapeHtml(parentLabel)}</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Phase</th>
              <th>Schedule</th>
              <th>Status</th>
              <th>Last run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${childRows}
          </tbody>
        </table>
      </td>
    </tr>`;
  }

  function renderCronRow(c: CronJobItem): string {
    const actions = renderCronActions(c);
    // Full inline edit (schedule, prompt, channel, preCheck), collapsed behind a
    // <details> so the table stays readable. Posts to /update → cronService.update.
    // System crons get NO edit form — their contents are owned by
    // reconcileSystemCrons and the /update route rejects them (mirrors delete).
    const editForm = c.system
      ? ""
      : `
      <details style="margin-top:6px">
        <summary style="cursor:pointer;font-size:11px;color:#6b7280">Edit</summary>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/crons/${escapeHtml(c.id)}/update" style="display:flex;flex-direction:column;gap:4px;margin-top:6px;min-width:240px">
          <input name="schedule" type="text" class="form-input mono" style="font-size:11px;padding:3px 6px" value="${escapeHtml(c.schedule)}" placeholder="0 * * * *" required title="Cron expression (5 fields)" />
          <textarea name="prompt" class="form-input" style="font-size:11px;padding:3px 6px;min-height:48px" placeholder="Prompt" required>${escapeHtml(c.prompt)}</textarea>
          <input name="channel" type="text" class="form-input" style="font-size:11px;padding:3px 6px" value="${escapeHtml(c.channel ?? "")}" placeholder="Channel ID (optional)" />
          <input name="preCheck" type="text" class="form-input mono" style="font-size:11px;padding:3px 6px" value="${escapeHtml(c.preCheck ?? "")}" placeholder="plugin:check.ts or ./path.ts (optional)" />
          <button type="submit" class="btn btn-primary" style="font-size:11px;padding:3px 8px;align-self:flex-start">Save</button>
        </form>
      </details>`;
    const lastRunOutcomeLabel = c.lastRun
      ? cronRunOutcomeLabel(c.lastRun)
      : null;
    const lastRunHtml = c.lastRun?.startedAt
      ? `
      <div style="font-size:11px;color:#6b7280;margin-bottom:4px">${relativeTime(c.lastRun.startedAt, now)}</div>
      <div>
        <span class="badge" style="${cronOutcomeStyle(lastRunOutcomeLabel)}">${escapeHtml(lastRunOutcomeLabel ?? "unknown")}</span>
      </div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${c.runCountToday ?? 0} run${(c.runCountToday ?? 0) === 1 ? "" : "s"}</div>`
      : `<div style="color:#d1d5db">never</div>`;

    const children = crons.filter((child) => child.parentCronId === c.id);
    const nestedPhasesRow = renderNestedPhasesRow(c, children);

    return `<tr>
      <td class="mono">${escapeHtml(c.schedule)}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.name ? `${c.name}: ${c.prompt}` : c.prompt)}</td>
      <td class="mono" style="font-size:11px;color:#6b7280;max-width:170px;overflow:hidden;text-overflow:ellipsis">${c.preCheck ? escapeHtml(c.preCheck) : "—"}</td>
      <td>${c.channel ? escapeHtml(c.channel) : c.user ? escapeHtml(c.user) : "—"}</td>
      <td><span class="badge ${c.enabled ? "badge-green" : "badge-gray"}">${c.enabled ? "enabled" : "disabled"}</span></td>
      <td style="font-size:11px">${lastRunHtml}</td>
      <td class="col-created">${escapeHtml(new Date(c.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
      <td style="white-space:nowrap">${actions}${editForm}</td>
    </tr>
    ${nestedPhasesRow}`;
  }

  const systemCronRows =
    systemCrons.length === 0
      ? `<tr><td colspan="8" class="empty-state">No system crons configured.</td></tr>`
      : systemCrons.map(renderCronRow).join("\n");

  const customCronRows =
    customCrons.length === 0
      ? `<tr><td colspan="8" class="empty-state">No custom crons yet.</td></tr>`
      : customCrons.map(renderCronRow).join("\n");

  const toolRows =
    tools.length === 0
      ? `<tr><td colspan="4" class="empty-state">No tools configured.</td></tr>`
      : tools
          .map(
            (t) => `<tr>
      <td class="mono">${escapeHtml(t.pattern)}</td>
      <td><span class="badge ${t.enabled ? "badge-green" : "badge-gray"}">${t.enabled ? "enabled" : "disabled"}</span></td>
      <td>${escapeHtml(new Date(t.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tools/${escapeHtml(t.id)}/toggle" style="display:inline">
          <input type="hidden" name="enabled" value="${t.enabled ? "false" : "true"}" />
          <button type="submit" class="btn btn-secondary" style="font-size:11px;padding:3px 8px">${t.enabled ? "Disable" : "Enable"}</button>
        </form>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tools/${escapeHtml(t.id)}/delete" style="display:inline;margin-left:4px">
          <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Delete</button>
        </form>
      </td>
    </tr>`,
          )
          .join("\n");

  const tokenRows =
    tokens.length === 0
      ? `<tr><td colspan="4" class="empty-state">No tokens created.</td></tr>`
      : tokens
          .map(
            (t) => `<tr>
      <td>${t.label ? escapeHtml(t.label) : '<span style="color:#9ca3af">—</span>'}</td>
      <td>${escapeHtml(new Date(t.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
      <td>${t.revokedAt ? `<span class="badge badge-gray">Revoked ${escapeHtml(new Date(t.revokedAt).toLocaleDateString("en-US", { timeZone: timezone }))}</span>` : '<span class="badge badge-green">Active</span>'}</td>
      <td>${
        !t.revokedAt
          ? `<form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tokens/${escapeHtml(t.id)}/revoke" style="display:inline">
          <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Revoke</button>
        </form>`
          : ""
      }</td>
    </tr>`,
          )
          .join("\n");

  const pluginRows =
    plugins.length === 0
      ? `<tr><td colspan="4" class="empty-state">No plugins installed.</td></tr>`
      : plugins
          .map(
            (p) => `<tr>
      <td class="mono">${escapeHtml(p.name)}</td>
      <td class="mono">${p.version ? escapeHtml(p.version) : "latest"}</td>
      <td><span class="badge ${p.enabled ? "badge-green" : "badge-gray"}">${p.enabled ? "enabled" : "disabled"}</span></td>
      <td>${escapeHtml(new Date(p.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
    </tr>`,
          )
          .join("\n");

  const memberRows =
    members.length === 0
      ? `<tr><td colspan="3" class="empty-state">No members yet.</td></tr>`
      : members
          .map(
            (m) => `<tr>
      <td>${escapeHtml(m.email)}</td>
      <td>${escapeHtml(new Date(m.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
      <td>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/members/delete" style="display:inline">
          <input type="hidden" name="memberId" value="${escapeHtml(m.id)}" />
          <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Remove</button>
        </form>
      </td>
    </tr>`,
          )
          .join("\n");

  const membersSection = `
    <div class="card">
      <div class="card-title">Members</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/members" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="email" type="email" class="form-input" placeholder="user@example.com" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Added</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${memberRows}
          </tbody>
        </table>
      </div>
    </div>`;

  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const successHtml = opts?.successMsg
    ? `<div class="alert alert-success">${escapeHtml(opts.successMsg)}</div>`
    : "";

  const warningHtml = opts?.warning
    ? `<div class="alert alert-warning">${escapeHtml(opts.warning)}</div>`
    : "";

  const newTokenHtml = opts?.newToken
    ? `<div class="alert alert-success">
        <strong>Token created.</strong> Copy it now — it will not be shown again.<br />
        <code class="mono" style="display:block;margin-top:8px;font-size:13px;word-break:break-all">${escapeHtml(opts.newToken)}</code>
      </div>`
    : "";

  return renderAdminPage({
    title: `${agent.name} — Shipwright Admin`,
    body: `${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header">
      <div>
        <a href="/admin/agents" style="font-size:13px;color:#6b7280;text-decoration:none">← Agents</a>
        <h1 class="page-title" style="margin-top:4px">${escapeHtml(agent.name)}</h1>
        <span style="font-size:13px;color:#6b7280">Type: <span class="mono">${escapeHtml(agent.typeName)}</span></span>
        ${agent.slackId ? `<span style="font-size:13px;color:#6b7280">Slack ID: <span class="mono">${escapeHtml(agent.slackId)}</span></span>` : ""}
      </div>
      ${
        agent.slackId
          ? `<div>
        <details>
          <summary class="btn btn-secondary" style="cursor:pointer;font-size:12px;list-style:none">Sync Manifest</summary>
          <div style="position:absolute;right:24px;margin-top:6px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08);z-index:10;min-width:320px">
            <p style="font-size:12px;color:#6b7280;margin:0 0 10px">Syncs the current manifest to the provisioned Slack app. Requires a Slack app configuration token (<span class="mono">xoxe.xoxp-</span>).</p>
            <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/sync-manifest" style="display:flex;flex-direction:column;gap:8px">
              <input
                name="xoxpToken"
                type="password"
                class="form-input mono"
                placeholder="xoxe.xoxp-..."
                required
                style="font-size:12px"
              />
              <button type="submit" class="btn btn-primary" style="font-size:12px;align-self:flex-start">Confirm Sync</button>
            </form>
          </div>
        </details>
      </div>`
          : ""
      }
    </div>
    ${errorHtml}
    ${successHtml}
    ${warningHtml}
    ${newTokenHtml}

    ${
      !agent.selfHosted
        ? `<div class="card" id="env-vars">
      <div class="card-title">Env Vars</div>
      ${
        agent.missingRequiredEnv.length > 0
          ? `<div class="alert alert-warning">
        Missing required env var${agent.missingRequiredEnv.length === 1 ? "" : "s"}:
        ${agent.missingRequiredEnv.map((key) => `<span class="badge badge-warning">${escapeHtml(key)}</span>`).join(" ")}
        — <a href="#env-vars">set ${agent.missingRequiredEnv.length === 1 ? "it" : "them"} below</a>.
      </div>`
          : ""
      }
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/envs" style="margin-bottom:16px">
        <div class="form-row" style="flex-wrap:wrap;gap:8px">
          <div class="form-group">
            <input name="key" type="text" class="form-input" placeholder="KEY" required />
          </div>
          <div class="form-group">
            <input name="value" type="password" class="form-input" placeholder="value" required />
          </div>
          <div class="form-group" style="display:flex;align-items:center;gap:6px;padding-bottom:2px">
            <input name="secret" type="checkbox" id="env-secret" value="true" checked />
            <label for="env-secret" class="form-label" style="margin-bottom:0">Mark as secret</label>
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${envRows}
          </tbody>
        </table>
      </div>
    </div>`
        : ""
    }

    <div class="card">
      <div class="card-title">Repos</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/repos/add" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="repo" type="text" class="form-input" placeholder="org/repo" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Repo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              agent.repos.length === 0
                ? `<tr><td colspan="2" class="empty-state">No repos configured.</td></tr>`
                : agent.repos
                    .map(
                      (repo) => `<tr>
            <td class="mono">${escapeHtml(repo)}</td>
            <td>
              <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/repos/delete" style="display:inline">
                <input type="hidden" name="repo" value="${escapeHtml(repo)}" />
                <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Remove</button>
              </form>
            </td>
          </tr>`,
                    )
                    .join("\n")
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Author allowlist (review)</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/review-author-allowlist/add" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="login" type="text" class="form-input" placeholder="octocat" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>GitHub login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              agent.authorAllowlist.length === 0
                ? `<tr><td colspan="2" class="empty-state">No author allowlist entries configured.</td></tr>`
                : agent.authorAllowlist
                    .map(
                      (login) => `<tr>
            <td class="mono">${escapeHtml(login)}</td>
            <td>
              <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/review-author-allowlist/delete" style="display:inline">
                <input type="hidden" name="login" value="${escapeHtml(login)}" />
                <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Remove</button>
              </form>
            </td>
          </tr>`,
                    )
                    .join("\n")
            }
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Author allowlist (patch)</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/patch-author-allowlist/add" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="login" type="text" class="form-input" placeholder="octocat" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>GitHub login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              (agent.patchAuthorAllowlist ?? []).length === 0
                ? `<tr><td colspan="2" class="empty-state">No patch author allowlist entries configured.</td></tr>`
                : (agent.patchAuthorAllowlist ?? [])
                    .map(
                      (login) => `<tr>
            <td class="mono">${escapeHtml(login)}</td>
            <td>
              <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/patch-author-allowlist/delete" style="display:inline">
                <input type="hidden" name="login" value="${escapeHtml(login)}" />
                <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Remove</button>
              </form>
            </td>
          </tr>`,
                    )
                    .join("\n")
            }
          </tbody>
        </table>
      </div>
    </div>

    ${
      isAdmin
        ? `<div class="card">
      <div class="card-title">Slack access</div>
      ${connectActionsHtml}
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/settings">
        <div class="form-group" style="display:flex;align-items:center;gap:6px">
          <input
            id="restrictSlackToMembers"
            name="restrictSlackToMembers"
            type="checkbox"
            value="true"
            ${agent.restrictSlackToMembers ? "checked" : ""}
          />
          <label class="form-label" for="restrictSlackToMembers" style="margin-bottom:0">Restrict Slack to members</label>
        </div>
        <p style="font-size:12px;color:#6b7280;margin:4px 0 12px">
          When enabled, only AgentMember emails may message this agent over Slack. If the agent has no
          members yet, enabling this will block all Slack senders.
        </p>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>`
        : ""
    }

    <div class="card">
      <div class="card-title">Cron Jobs</div>

      ${
        agent.selfHosted
          ? `<p style="font-size:13px;color:#6b7280;margin:0 0 16px">Crons fire only while the local agent service is running. Make sure your service is active before enabling crons.</p>`
          : ""
      }

      <div style="margin-bottom:20px">
        <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">System</div>
        <div class="data-table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Prompt</th>
                <th>Pre-check</th>
                <th>Target</th>
                <th>Status</th>
                <th>Last run</th>
                <th class="col-created">Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${systemCronRows}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Custom</div>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/crons" style="margin-bottom:12px">
          <div class="form-row" style="flex-wrap:wrap;gap:8px">
            <div class="form-group">
              <input name="schedule" type="text" class="form-input" placeholder="0 * * * *" required title="Cron expression (5 fields)" />
            </div>
            <div class="form-group" style="flex:1;min-width:200px">
              <input name="prompt" type="text" class="form-input" placeholder="Prompt" required />
            </div>
            <div class="form-group">
              <input name="channel" type="text" class="form-input" placeholder="Channel ID" />
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:6px;padding-bottom:2px">
              <input name="enabled" type="checkbox" id="cron-enabled" value="true" checked />
              <label for="cron-enabled" class="form-label" style="margin-bottom:0">Enabled</label>
            </div>
            <button type="submit" class="btn btn-primary">Add Cron</button>
          </div>
        </form>
        <div class="data-table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Prompt</th>
                <th>Pre-check</th>
                <th>Target</th>
                <th>Status</th>
                <th>Last run</th>
                <th class="col-created">Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${customCronRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Tools</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tools" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="pattern" type="text" class="form-input" placeholder="Bash(git:*)" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${toolRows}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Task Store Tokens</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tokens" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="label" type="text" class="form-input" placeholder="Label (optional)" />
          </div>
          <button type="submit" class="btn btn-primary">Create Token</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${tokenRows}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Plugins</div>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Package</th>
              <th>Version</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            ${pluginRows}
          </tbody>
        </table>
      </div>
    </div>

    ${isAdmin ? membersSection : ""}

    ${
      isAdmin
        ? `<!-- Danger Zone -->
    <div class="card" style="border:1px solid #fca5a5">
      <div class="card-title" style="color:#dc2626">Danger Zone</div>
      <p style="font-size:13px;color:#6b7280;margin-bottom:16px">
        Deleting this agent permanently removes all its data (env vars, crons, tools, tokens, plugins, members)
        and terminates its pod. This action cannot be undone.
      </p>
      <form id="delete-agent-form" method="POST" action="/admin/agents/${escapeHtml(agent.id)}/delete"
            data-agent-name="${escapeHtml(agent.name)}">
        <button type="submit" class="btn btn-danger">Delete agent</button>
      </form>
      <script>
        document.getElementById('delete-agent-form').addEventListener('submit', function(e) {
          var name = this.dataset.agentName;
          if (!confirm('Delete agent ' + name + '? This cannot be undone.')) {
            e.preventDefault();
          }
        });
      </script>
    </div>`
        : ""
    }

  </div>`,
  });
}

// ─── Provision pages ──────────────────────────────────────────────────────────

/**
 * Auto-submitting POST-redirect page for the GitHub "create a GitHub App
 * from a manifest" flow: https://docs.github.com/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app-from-a-manifest
 *
 * `githubOrg` must already be validated by the caller against the org-name
 * pattern before this function is called — it's interpolated directly into
 * the form's `action` URL.
 */
export function renderGithubAppManifestRedirectPage(
  userName: string,
  opts: { githubOrg: string; manifest: unknown },
): string {
  const actionUrl = `https://github.com/organizations/${encodeURIComponent(opts.githubOrg)}/settings/apps/new`;
  const manifestJson = JSON.stringify(opts.manifest);

  return renderAdminPage({
    title: "Provision Agent — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step active">1. Create Slack App</span>
      <span class="provision-step">2. Authorize</span>
      <span class="provision-step">3. Complete</span>
    </div>
    <div class="card">
      <p style="font-size:14px;margin-bottom:16px;color:#6b7280">
        Redirecting to GitHub to create the GitHub App under <strong>${escapeHtml(opts.githubOrg)}</strong>…
      </p>
      <form id="github-app-manifest-form" method="POST" action="${escapeHtml(actionUrl)}">
        <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}" />
        <button type="submit" class="btn btn-primary">Continue to GitHub →</button>
      </form>
      <script>
        document.getElementById('github-app-manifest-form').submit();
      </script>
    </div>
  </div>`,
  });
}

/**
 * Shown after GET /admin/provision/github-app/complete succeeds — links the
 * operator to GitHub's installations/new page for the newly created app.
 */
export function renderGithubAppInstallPage(
  userName: string,
  opts: { installUrl: string },
): string {
  return renderAdminPage({
    title: "Provision Agent — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step active">2. Install GitHub App</span>
      <span class="provision-step">3. Complete</span>
    </div>
    <div class="card">
      <div class="alert alert-success">
        <strong>GitHub App created!</strong> Click the link below to install it.
      </div>
      <a href="${escapeHtml(opts.installUrl)}" class="btn btn-primary" rel="noopener noreferrer">
        Install GitHub App →
      </a>
    </div>
  </div>`,
  });
}

/**
 * Shown after GET /admin/provision/github-app/installed succeeds or fails —
 * the manifest flow's `setup_url` target.
 */
export function renderGithubAppInstalledPage(
  userName: string,
  opts: { success: boolean; error?: string },
): string {
  const bodyHtml = opts.success
    ? `<div class="alert alert-success">
        <strong>GitHub App installed!</strong> — installation ID stored.
      </div>
      <a href="/admin/provision" class="btn btn-secondary">Back to Provisioning</a>`
    : `<div class="alert alert-error">${escapeHtml(opts.error ?? "GitHub App installation failed.")}</div>
      <a href="/admin/provision" class="btn btn-secondary">Try again</a>`;

  return renderAdminPage({
    title: "Provision Agent — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step">2. Install GitHub App</span>
      <span class="provision-step active">3. Complete</span>
    </div>
    <div class="card">
      ${bodyHtml}
    </div>
  </div>`,
  });
}

// xapp-token page shown after OAuth callback completes — user pastes the Socket Mode app token.
export function renderProvisionXappTokenPage(
  userName: string,
  opts: { agentId: string; error?: string; warning?: string },
): string {
  const errorHtml = opts.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";
  // Non-fatal warning (UAP-2.1) — e.g. a GitHub PAT that failed to store
  // during the combined create+connect flow. Surfaced here so the operator
  // isn't misled into believing GH_TOKEN was connected after finishing Slack.
  const warningHtml = opts.warning
    ? `<div class="alert alert-warning">${escapeHtml(opts.warning)}</div>`
    : "";

  return renderAdminPage({
    title: "Complete Provisioning — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step">2. Authorize</span>
      <span class="provision-step">3. Bot Token</span>
      <span class="provision-step active">4. Add Socket Token</span>
    </div>
    <div class="card">
      <p style="font-size:14px;margin-bottom:16px;color:#6b7280">
        Open your Slack App's <strong>Socket Mode</strong> settings, enable Socket Mode,
        and generate an <strong>App-Level Token</strong> with <code class="mono">connections:write</code> scope.
        Paste the <code class="mono">xapp-</code> token below.
      </p>
      ${warningHtml}
      ${errorHtml}
      <form method="POST" action="/admin/agents/${escapeHtml(opts.agentId)}/connect-slack/app-token">
        <div class="form-group">
          <label class="form-label" for="xappToken">App-Level Token (xapp-)</label>
          <input
            id="xappToken"
            name="xappToken"
            type="password"
            class="form-input"
            placeholder="xapp-..."
            required
          />
        </div>
        <button type="submit" class="btn btn-primary">Save Token →</button>
      </form>
    </div>
  </div>`,
  });
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

// ─── Tasks page ──────────────────────────────────────────────────────────────

// Shared by both the board (default) and table (?view=table) layouts.
const TASKS_PAGE_EXTRA_STYLES = `
    /* Same precedent as .chat-thread-page: .tasks-board-page has equal
       specificity to .vos-page's own max-width:960px rule, but wins the
       cascade tie because extraStyles renders after baseStyles() — so only
       the board (AXR-1.3's 5-column Kanban) stretches full width; table
       view and every other admin page stay capped. The
       @media (max-width:640px) padding rule for .vos-page (lib/web/toolbar.ts)
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
    <td>${readOnly ? escapeHtml(t.title) : `<a href="${detailHref}" style="color:inherit;text-decoration:none">${escapeHtml(t.title)}</a>`}${blockerBadges}</td>
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
        ${blockerBadges}${prBadge}
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
        ${joinedPr ? `
          <div style="border-top:1px solid #e8e8ee;padding-top:16px">
            <h3 style="font-size:13px;font-weight:600;margin-bottom:8px">Pull Request</h3>
            <div style="font-size:12px;color:#6b7280;margin-bottom:4px"><strong>Number:</strong> <a href="https://github.com/${escapeHtml(joinedPr.repo)}/pull/${joinedPr.prNumber}" style="color:#6366f1;text-decoration:none">#${joinedPr.prNumber}</a></div>
            <div style="font-size:12px;color:#6b7280;margin-bottom:4px"><strong>State:</strong> ${escapeHtml(joinedPr.state)}</div>
            <div style="font-size:12px;color:#6b7280;margin-bottom:4px"><strong>Review State:</strong> ${escapeHtml(joinedPr.reviewState)}</div>
            ${joinedPr.blocked ? `<div style="font-size:12px;color:#dc2626"><strong>Blocked:</strong> ${escapeHtml(joinedPr.blockedReason ?? "Yes")}</div>` : ""}
          </div>
        ` : ""}
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
export type TaskBoardColumn =
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
 * Selects the session's tasks that participate in a dependency edge —
 * either they declare a dependency, or another task in the session declares
 * them as one — and returns them as a flat, deterministically-ordered array
 * for the graph card (see `renderDependencyGraph`/`computeDependencyLayout`).
 * Tasks with no relationship are noise here and stay visible in the plain
 * task table above. Dependency ids outside the session (unknown to this task
 * list) aren't session tasks and have no status to classify by, so they
 * never get their own node — they still show up in a participating task's
 * `dependsOn` list, just unlinked.
 */
export function computeDependencyNodes(tasks: TaskItem[]): DependencyNode[] {
  const referencedIds = new Set<string>();
  for (const t of tasks) {
    for (const dep of t.dependencies ?? []) referencedIds.add(dep);
  }

  const nodes: DependencyNode[] = [];
  for (const t of tasks) {
    if ((t.dependencies?.length ?? 0) === 0 && !referencedIds.has(t.id)) {
      continue;
    }
    nodes.push({
      id: t.id,
      title: t.title,
      status: t.status,
      branch: t.branch ?? null,
      dependsOn: t.dependencies ?? [],
    });
  }
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

export interface DependencyLayoutPosition {
  x: number;
  y: number;
  depth: number;
}

export interface DependencyLayout {
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
 * `nodes` down to participating tasks (see `computeDependencyNodes`) — this
 * function does no filtering of its own.
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
): string {
  const degradedHtml = degraded
    ? `<div class="alert alert-warning">Task store unavailable — data shown may be stale or empty.</div>`
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
    </div>
    ${degradedHtml}
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      ${statCard("Total Tasks", String(totalTasks))}
      ${statCard("Est. Hours", String(totalHours))}
      ${statCard("Layers", String(distinctLayers))}
    </div>
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
  </div>`,
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
 * "stale" mirrors lib/claim-ttl.ts's `DEFAULT_CLAIM_TTL_MS` (the reaper's
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
  </div>`,
  });
}

// ─── Cron grouping for activity display ────────────────────────────────────

export interface CronGroupingInput {
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
// phase value (dev-task/review/patch/deploy) — a single neutral palette
// distinct from the outcome-style badges elsewhere on the queue & activity
// page, since phase here is informational, not a pass/fail signal.
const WORK_QUEUE_PHASE_BADGE_STYLE: Record<string, string> = {
  "dev-task": "background:#eef2ff;color:#4338ca",
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
  phase: "dev-task" | "review" | "patch" | "deploy";
  age: string;
}

export interface WorkQueueSnapshotItem {
  computedAt: Date;
  items: WorkQueueItem[];
}

export interface AgentOption {
  id: string;
  name: string;
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

  const durationCell = r.completedAt
    ? escapeHtml(
        fmtDuration(
          new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime(),
        ),
      )
    : "—";

  // Token totals are summed from the per-model breakdown rows — the sole
  // source of cron-run token data. A run with no breakdown shows an em-dash.
  const breakdown = r.modelBreakdown ?? [];
  const tokensCell =
    breakdown.length === 0
      ? "—"
      : (() => {
          const input = breakdown.reduce((sum, m) => sum + m.inputTokens, 0);
          const output = breakdown.reduce(
            (sum, m) => sum + m.outputTokens,
            0,
          );
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
 * annotateEligibility(), keyed on each agent's repos[]). Result is sorted
 * oldest-first by age, mirroring rankWorkItems()'s ordering convention
 * (agent/src/work-selector.ts) so the merged Upcoming table reads the same
 * way a single agent's own queue does.
 */
export function buildMergedWorkQueueRows(
  snapshots: { agentId: string; items: WorkQueueItem[] }[],
  agents: { id: string; repos: string[] }[],
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

  const queueTotalPages = Math.max(
    1,
    Math.ceil(workQueuePagination.total / workQueuePagination.limit),
  );
  const queuePage = workQueuePagination.page;
  const makeQueuePageUrl = (p: number) => {
    const params = new URLSearchParams();
    if (p > 1) params.set("queuePage", String(p));
    const qs = params.toString();
    return `/admin/queue-activity${qs ? `?${qs}` : ""}`;
  };
  const queueFrom =
    workQueuePagination.total === 0
      ? 0
      : (queuePage - 1) * workQueuePagination.limit + 1;
  const queueTo = Math.min(
    queuePage * workQueuePagination.limit,
    workQueuePagination.total,
  );
  const queuePaginationHtml =
    workQueuePagination.total === 0
      ? ""
      : `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0;font-size:12px;color:#6b7280">
      <span>${queueFrom}–${queueTo} of ${workQueuePagination.total}</span>
      <div style="display:flex;gap:4px">
        ${queuePage > 1 ? `<a href="${makeQueuePageUrl(queuePage - 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">← Prev</a>` : ""}
        ${queuePage < queueTotalPages ? `<a href="${makeQueuePageUrl(queuePage + 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">Next →</a>` : ""}
      </div>
    </div>`;

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

  const runsTotalPages = Math.max(
    1,
    Math.ceil(runsPagination.total / runsPagination.limit),
  );
  const runsPage = runsPagination.page;
  const makeRunsPageUrl = (p: number) => {
    const params = new URLSearchParams();
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/admin/queue-activity${qs ? `?${qs}` : ""}`;
  };
  const runsFrom =
    runsPagination.total === 0 ? 0 : (runsPage - 1) * runsPagination.limit + 1;
  const runsTo = Math.min(
    runsPage * runsPagination.limit,
    runsPagination.total,
  );
  const runsPaginationHtml =
    runsPagination.total === 0
      ? ""
      : `<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 0 0;font-size:12px;color:#6b7280">
      <span>${runsFrom}–${runsTo} of ${runsPagination.total}</span>
      <div style="display:flex;gap:4px">
        ${runsPage > 1 ? `<a href="${makeRunsPageUrl(runsPage - 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">← Prev</a>` : ""}
        ${runsPage < runsTotalPages ? `<a href="${makeRunsPageUrl(runsPage + 1)}" class="btn btn-secondary" style="font-size:11px;padding:3px 10px">Next →</a>` : ""}
      </div>
    </div>`;

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

export function renderProvisionCompletePage(
  userName: string,
  opts: {
    success: boolean;
    agentId?: string;
    error?: string;
  },
): string {
  const bodyHtml = opts.success
    ? `<div class="alert alert-success">
        <strong>Provisioning complete!</strong> — Slack app credentials and tokens stored.
      </div>
      <p style="font-size:14px;margin-bottom:16px;margin-top:16px">
        All credentials have been saved to the agent's env vars and system crons have been seeded.
        For a self-hosted agent, mint its own API key from the agent's detail page.
      </p>
      ${opts.agentId ? `<a href="/admin/agents/${escapeHtml(opts.agentId)}" class="btn btn-primary">View Agent →</a>` : ""}
      <a href="/admin/agents" class="btn btn-secondary" style="margin-left:8px">Back to Agents</a>`
    : `<div class="alert alert-error">${escapeHtml(opts.error ?? "Provisioning failed.")}</div>
      <a href="/admin/provision" class="btn btn-secondary">Try again</a>`;

  return renderAdminPage({
    title: "Provisioning Complete — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step">2. Authorize</span>
      <span class="provision-step">3. Bot Token</span>
      <span class="provision-step active">4. Complete</span>
    </div>
    <div class="card">
      ${bodyHtml}
    </div>
  </div>`,
  });
}

// ─── Chat page ─────────────────────────────────────────────────────────────────

/**
 * Renders the top-level /admin/chat page.
 *
 * @param agents       - list of agents for the dropdown
 * @param selectedAgentId - the currently selected agent (from ?agentId=X)
 * @param threads      - thread list (null = chatClient absent → degraded mode)
 * @param userName     - logged-in user's email for the toolbar
 */

const threadPaneStyles = `
    .thread-pane-list { display:flex;flex-direction:column;gap:4px;margin-top:8px }
    .thread-pane-link { display:block;padding:8px 12px;border-radius:6px;font-size:13px;color:#374151;text-decoration:none;background:#f9fafb;border:1px solid #e5e7eb }
    .thread-pane-link:hover { background:#eef2ff;color:#4f46e5 }
    .thread-pane-link.active { background:#eef2ff;color:#4f46e5;font-weight:600 }`;

const chatPageStyles = `
    .chat-sidebar-new-thread-input { font-size:12px }
    @media (max-width:${BREAKPOINT_MOBILE_MAX}px) {
      .chat-sidebar-new-thread-input { font-size:16px }
      .chat-list-layout { flex-direction:column }
      .chat-list-sidebar { width:100%;max-width:100%;min-width:0 }
      /* chat-thread-layout: flex wrapper for thread+message area; stacks to column on mobile */
      .chat-thread-layout { flex-direction:column }
      /* ─── Mobile thread drawer (CFB-3.2) ──────────────────────────────────
         The sidebar becomes an off-canvas drawer instead of display:none, so
         the thread list is reachable on mobile. It is translated off the left
         edge by default and slid in when the checkbox is :checked. A scrim
         dims/blocks the background and closes the drawer on tap. */
      .chat-thread-sidebar {
        position:fixed;top:0;left:0;bottom:0;z-index:102;
        width:80%;max-width:300px;min-width:0;
        margin:0;border-radius:0;overflow-y:auto;
        transform:translateX(-100%);
        transition:transform 0.2s ease;
      }
      .chat-drawer-toggle:checked ~ .chat-thread-sidebar { transform:translateX(0) }
      /* Scrim toggles display (not just opacity) so it's genuinely absent from
         the a11y/visibility tree when closed — Playwright's toBeVisible() (and
         assistive tech) treat an opacity:0 element as still visible. */
      .chat-drawer-scrim {
        display:none;position:fixed;inset:0;z-index:101;
        background:rgba(0,0,0,0.4);cursor:pointer;
      }
      .chat-drawer-toggle:checked ~ .chat-drawer-scrim { display:block }
      .chat-drawer-hamburger { display:inline-block }
      @media (prefers-reduced-motion: reduce) {
        .chat-thread-sidebar { transition:none }
      }
      /* Collapse the header to a compact ~48px control row + 16px meta line so
         the message stream sits above the fold at 375px (criterion #4). The
         title rides inline in the control row; the thread-id meta stays as the
         single 16px line. Per-thread token stats and the rename/delete
         disclosure are pushed off-header on mobile (still reachable via the
         drawer / desktop) to keep the header under 96px. */
      .chat-thread-header { padding-top:2px;padding-bottom:2px }
      .chat-thread-header-top { margin-bottom:2px !important }
      .chat-thread-header .chat-drawer-hamburger { padding:4px 8px }
      .chat-thread-header .btn { margin-bottom:0 !important;padding:4px 10px }
      .chat-thread-header .page-title { font-size:15px;line-height:1.2;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
      .chat-thread-header .chat-thread-meta { margin-top:2px !important }
      .chat-thread-header .chat-thread-stats { display:none }
      .chat-thread-header .chat-thread-actions { display:none }
      .chat-bubble-inner { max-width:90% }
      #message-input { font-size:16px }
      /* Composer row: let the textarea keep adequate width instead of being
         squeezed to ~160px next to the Attach/Send buttons at narrow widths. */
      .chat-composer-row { flex-wrap:wrap }
      .chat-message-input { flex-basis:100%; }
      /* .chat-thread-page combines with .vos-page (specificity 0,2,0), which
         otherwise beats .vos-page's own mobile padding rule (0,1,0) — pin the
         effective mobile padding here. The bottom padding is intentionally
         small: the sticky composer carries its own safe-area bottom inset, and
         a large page bottom padding would steal scarce vertical space when the
         keyboard shrinks the viewport (CFB-3.2 criterion #3). */
      .chat-thread-page { padding:8px 12px 8px }
      /* Tighten the gap between the header and the message column so the
         message stream starts higher (criterion #4). */
      .chat-thread-layout { margin-top:8px !important }
    }`;

// ─── Chat thread page — class-driven bubble/composer styling (CFB-1.3) ────────
// These class names are shared verbatim between the server-rendered HTML
// (renderMessageBubble()) and the inline JS bubble builder (addBubble()) so
// the two renderers physically cannot drift apart — see the interpolation of
// CHAT_BUBBLE_CLASS/CHAT_BUBBLE_INNER_CLASS into `inlineScript` below.
export const CHAT_BUBBLE_CLASS = "chat-bubble";
export const CHAT_BUBBLE_INNER_CLASS = "chat-bubble-inner";
export const CHAT_BUBBLE_INNER_WIDE_CLASS = "chat-bubble-inner--wide";

/** e.g. "chat-bubble--user" — role is attacker-controlled only via server data, never used unescaped in an attribute here since roles are a closed set (user/assistant/system/other). */
export function chatBubbleRoleClass(role: string): string {
  return `${CHAT_BUBBLE_CLASS}--${role}`;
}

// ─── Live progress (CFB-2.3) ──────────────────────────────────────────────────

/**
 * Human-readable label per errorKind. Single source of truth: used by the
 * server renderer (renderChatMessageBubble) AND serialized into the inline JS
 * (JSON.stringify(ERROR_KIND_LABELS)) so the client copy is generated from
 * this exact object and cannot drift — same pattern as CHAT_BUBBLE_CLASS.
 * A kind not present here falls back to DEFAULT_ERROR_LABEL.
 * `cancelled`/`incomplete`/`stalled` (CFB-2.4) are also retryable — see
 * RETRYABLE_ERROR_KINDS below.
 */
export const ERROR_KIND_LABELS: Record<string, string> = {
  "rate-limited": "Rate limited",
  upstream: "Request failed",
  timeout: "Timed out",
  cancelled: "Cancelled",
  incomplete: "Incomplete",
  stalled: "Stalled",
};
export const DEFAULT_ERROR_LABEL = "Error";

/** Resolve an errorKind to its label, with the shared default fallback. */
export function errorKindLabel(kind: string): string {
  return ERROR_KIND_LABELS[kind] ?? DEFAULT_ERROR_LABEL;
}

/**
 * Error kinds recoverable via the Retry button (CFB-2.4) — the reply never
 * really completed (cancelled via heartbeat tick, cut off mid-stream, or
 * stalled out), so re-sending the originating user message is safe and
 * likely to succeed. Kinds like rate-limited/timeout/upstream are excluded:
 * those already represent a completed, failed round-trip.
 */
export const RETRYABLE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "cancelled",
  "incomplete",
  "stalled",
]);

// Stable DOM id/class for the live status bubble (elapsed + milestone). The
// server renders one when the last user message is unreplied, and the inline
// ticker JS finds/updates/creates it by this exact id so the "just loaded,
// agent still working" and "just sent, agent now working" bubbles are one and
// the same element.
export const LIVE_STATUS_BUBBLE_ID = "live-status-bubble";
export const LIVE_STATUS_ELAPSED_ID = "live-status-elapsed";
export const LIVE_STATUS_MILESTONE_ID = "live-status-milestone";
export const STALL_INDICATOR_CLASS = "chat-stall-indicator";

/**
 * Layer-1 elapsed-timer guarantee: the client-side 1s ticker computes
 * `now - createdAt` with ZERO network dependency. Layer-2 milestone text
 * refreshes off the existing messages.json poll (adaptive 2s pending / 10s
 * idle). STALL_WARN_AFTER_MS is a *visible warning* (not a giveup) shown once
 * progressSeq has been unchanged for this long; ABSOLUTE_MAX_MS is the only
 * hard stop.
 */
export const STALL_WARN_AFTER_MS = 120_000;
// 65min — mirrors lib/claim-ttl.ts's DEFAULT_CLAIM_TTL_MS
// (DEFAULT_CLAUDE_TIMEOUT_MS 1hr + CLAIM_TTL_BUFFER_MS 5min). Inline JS can't
// import the lib file, so the value is hardcoded here with this reference.
export const ABSOLUTE_MAX_MS = 3_900_000;

/**
 * Module-level pure bubble renderer (hoisted out of renderChatThreadPage in
 * CFB-2.3). Returns the exact HTML the server emits on a full page load; the
 * same string is returned as `bubbleHtml` from messages.json so polled bubbles
 * are byte-identical to reloaded ones. Every message bubble carries a stable
 * `data-message-id` so the client can dedupe via an id-based renderedIds set.
 *
 * `retryBody` (CFB-2.4) is the body of the most recent preceding user message
 * — when set and `m.errorKind` is one of RETRYABLE_ERROR_KINDS, the error
 * badge also renders a Retry button that resends that exact text. Callers
 * iterating a message list should track the last-seen user body and pass it
 * through per-message (see renderChatThreadPage and the messages.json route).
 */
export function renderChatMessageBubble(
  m: ChatMessage,
  retryBody: string | null = null,
): string {
  const isUser = m.role === "user";
  const isAssistant = m.role === "assistant";
  const isSystem = m.role === "system";

  const bubbleRoleClass = chatBubbleRoleClass(
    isUser ? "user" : isAssistant ? "assistant" : isSystem ? "system" : "other",
  );
  const bubbleColor = isUser
    ? "#4f46e5"
    : isAssistant
      ? "#166534"
      : isSystem
        ? "#854d0e"
        : "#374151";
  const bubbleInnerClass = isSystem
    ? `${CHAT_BUBBLE_INNER_CLASS} ${CHAT_BUBBLE_INNER_WIDE_CLASS}`
    : CHAT_BUBBLE_INNER_CLASS;

  // Render error badge if errorKind is set. cancelled/incomplete/stalled are
  // recoverable states (CFB-2.4), so they also render a Retry action that
  // re-sends the originating user message.
  let errorBadge = "";
  if (m.errorKind) {
    const retryable =
      RETRYABLE_ERROR_KINDS.has(m.errorKind) && retryBody !== null;
    const retryAction = retryable
      ? `<button type="button" class="chat-retry-btn" data-retry-body="${escapeHtml(retryBody as string)}" style="margin-left:8px;padding:2px 8px;background:#fff;color:#b91c1c;border:1px solid #b91c1c;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer">Retry</button>`
      : "";
    errorBadge = `<div style="margin-top:6px;padding:4px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:12px;font-weight:600;display:inline-flex;align-items:center">${errorKindLabel(m.errorKind)}${retryAction}</div>`;
  }

  // Parse markers from assistant messages to extract URLs/paths and clean text
  let cleanedBody = m.body;
  let markerBadges = "";
  if (isAssistant) {
    const { cleaned, uploads, planUrls } = parseChatMarkers(m.body);
    cleanedBody = cleaned;

    // Render upload badges
    const uploadBadges = uploads
      .map((path) => {
        const filename = path.split("/").pop() || path;
        return `<div style="display:inline-block;margin-right:6px;margin-top:8px;padding:3px 8px;background:#e5e7eb;color:#374151;border-radius:6px;font-size:12px">📎 ${escapeHtml(filename)}</div>`;
      })
      .join("");

    // Render plan links
    const planLinks = planUrls
      .map(
        (url) =>
          `<a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;margin-right:6px;margin-top:8px;padding:3px 8px;background:#dbeafe;color:#1e40af;border-radius:6px;font-size:12px;text-decoration:none">View plan →</a>`,
      )
      .join("");

    markerBadges = uploadBadges + planLinks;
  }

  // Render body: assistant messages get markdown, others get escaped text
  const bodyHtml = isAssistant
    ? `<div style="font-size:14px;line-height:1.6;color:${bubbleColor}">${renderMarkdown(cleanedBody)}</div>`
    : `<div style="font-size:14px;white-space:pre-wrap;color:${bubbleColor}">${escapeHtml(m.body)}</div>`;

  // Attachment badge (metadata only — content is ephemeral, no re-download).
  const attachmentBadge = m.attachmentFilename
    ? `<div style="display:inline-block;margin-top:8px;padding:3px 8px;background:#e5e7eb;color:#374151;border-radius:6px;font-size:12px">📎 ${escapeHtml(m.attachmentFilename)}</div>`
    : "";

  let tokenBadge = "";
  if (isAssistant && m.tokens !== null && typeof m.tokens === "object") {
    const t = m.tokens as MessageTokens;
    const inTok = t.input_tokens ?? 0;
    const outTok = t.output_tokens ?? 0;
    const costPart = m.costUsd !== null ? ` · $${m.costUsd.toFixed(4)}` : "";
    tokenBadge = `<div style="font-size:11px;color:#6b7280;margin-top:4px">${escapeHtml(`${inTok} in / ${outTok} out${costPart}`)}</div>`;
  }

  return `<div class="${CHAT_BUBBLE_CLASS} ${bubbleRoleClass}" data-message-id="${escapeHtml(m.id)}">
      <div class="${bubbleInnerClass}">
        <div style="font-size:11px;font-weight:600;color:${bubbleColor};margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(m.role)}</div>
        ${bodyHtml}
        ${markerBadges}
        ${attachmentBadge}
        ${errorBadge}
        ${tokenBadge}
        <div style="font-size:11px;color:#9ca3af;margin-top:6px">${escapeHtml(new Date(m.createdAt).toLocaleString())}</div>
      </div>
    </div>`;
}

/**
 * Server-rendered live status bubble shown when the last user message is
 * unreplied (`role === 'user' && !repliedAt`). Renders the elapsed timer seed
 * and (optionally) the current milestone. Uses stable ids so the inline
 * ticker finds and updates it on load without fabricating one. `progressPhase`
 * null ⇒ no milestone text (heartbeat hasn't reported a phase yet). The
 * elapsed seed is 0s server-side; the client ticker takes over immediately
 * from `data-created-at` with zero network dependency.
 */
export function renderLiveStatusBubble(m: ChatMessage): string {
  const milestone =
    m.progressPhase &&
    PROGRESS_LABELS[m.progressPhase as keyof typeof PROGRESS_LABELS]
      ? PROGRESS_LABELS[m.progressPhase as keyof typeof PROGRESS_LABELS]
      : "";
  const milestoneHtml = `<span id="${LIVE_STATUS_MILESTONE_ID}">${escapeHtml(milestone)}</span>`;
  const createdAtMs = new Date(m.createdAt).getTime();
  const seq = m.progressSeq ?? 0;
  return `<div id="${LIVE_STATUS_BUBBLE_ID}" class="${CHAT_BUBBLE_CLASS} ${chatBubbleRoleClass("assistant")}" data-created-at="${createdAtMs}" data-progress-seq="${seq}">
      <div class="${CHAT_BUBBLE_INNER_CLASS}">
        <div style="font-size:14px;color:#166534;font-style:italic">
          ${milestoneHtml}
          <span id="${LIVE_STATUS_ELAPSED_ID}">working… (0s)</span>
        </div>
      </div>
    </div>`;
}

const chatThreadStyles = `
    /* The toolbar (.vos-toolbar) is a normal-flow sibling above .chat-thread-page,
       not fixed/absolute — so the page doesn't need to subtract a hardcoded
       toolbar height. Instead it grows to fill the remaining viewport via a
       flex-column body: min-height:100vh as a baseline, then min-height:100dvh
       as a progressive enhancement (dynamic viewport height accounts for
       mobile browser chrome that can grow the toolbar without breaking layout). */
    body { display:flex;flex-direction:column;min-height:100vh;min-height:100dvh;height:100dvh }
    .chat-thread-page { display:flex;flex-direction:column;flex:1;min-height:0;max-width:900px;margin:0 auto;padding:0 24px;width:100% }
    .chat-thread-header { padding-top:20px;padding-bottom:16px;flex-shrink:0 }
    /* Collapsed-by-default rename/delete disclosure (CFB-3.1 #5) — keeps the
       header compact above the fold regardless of viewport width. */
    .chat-thread-actions { margin-top:12px }
    .chat-thread-actions-summary { cursor:pointer;font-size:13px;color:#6b7280;user-select:none }
    .chat-thread-actions-summary:hover { color:#374151 }
    .chat-messages-container { flex:1;overflow-y:auto;overscroll-behavior:contain;padding:8px 0;min-height:0 }
    .${CHAT_BUBBLE_CLASS} { display:flex;margin-bottom:12px }
    .${chatBubbleRoleClass("user")} { justify-content:flex-end }
    .${chatBubbleRoleClass("assistant")} { justify-content:flex-start }
    .${chatBubbleRoleClass("system")} { justify-content:center }
    .${chatBubbleRoleClass("other")} { justify-content:flex-start }
    .${CHAT_BUBBLE_INNER_CLASS} { max-width:70%;border-radius:12px;padding:12px 16px;box-shadow:0 1px 2px rgba(0,0,0,0.06);overflow-wrap:anywhere }
    /* renderMarkdown emits <pre><code> for fenced blocks — let long code lines
       scroll horizontally inside the bubble instead of forcing the whole page
       to overflow. Scoped to the bubble so it doesn't affect other <pre>. */
    .${CHAT_BUBBLE_INNER_CLASS} pre { overflow-x:auto }
    .${CHAT_BUBBLE_INNER_CLASS}.${CHAT_BUBBLE_INNER_WIDE_CLASS} { max-width:80% }
    .${chatBubbleRoleClass("user")} .${CHAT_BUBBLE_INNER_CLASS} { background:#eef2ff }
    .${chatBubbleRoleClass("assistant")} .${CHAT_BUBBLE_INNER_CLASS} { background:#f0fdf4 }
    .${chatBubbleRoleClass("system")} .${CHAT_BUBBLE_INNER_CLASS} { background:#fef9c3 }
    .${chatBubbleRoleClass("other")} .${CHAT_BUBBLE_INNER_CLASS} { background:#f3f4f6 }
    /* Sticky composer: pins to the bottom of the scroll container so it stays
       reachable as messages grow. padding-bottom folds in the iOS safe-area
       inset plus --kb-inset (set by the visualViewport listener when the
       on-screen keyboard shrinks the visual viewport) so the composer isn't
       slid under the keyboard on iOS, where dvh does NOT shrink the layout. */
    .chat-composer-form { flex-shrink:0;position:sticky;bottom:0;background:#f7f7fb;padding:16px 0;padding-bottom:calc(12px + env(safe-area-inset-bottom) + var(--kb-inset, 0px));border-top:1px solid #e5e7eb;margin-top:8px }
    .chat-composer-row { display:flex;gap:8px;align-items:flex-end }
    .chat-message-input { flex:1;resize:vertical;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit;line-height:1.5;outline:none }
    .chat-composer-btn { flex-shrink:0;height:44px }
    .chat-composer-btn--attach { padding:0 16px }
    .chat-composer-btn--send { padding:0 20px }
    /* Live-progress stall state (CFB-2.3): when progressSeq hasn't advanced for
       STALL_WARN_AFTER_MS the status bubble gains .${STALL_INDICATOR_CLASS},
       which pulses to draw the eye. Motion is suppressed for users who ask for
       reduced motion — the amber colour still conveys the state statically. */
    .${STALL_INDICATOR_CLASS} { color:#b45309 }
    .${STALL_INDICATOR_CLASS} .${CHAT_BUBBLE_INNER_CLASS} { background:#fffbeb;animation:chat-stall-pulse 1.4s ease-in-out infinite }
    @keyframes chat-stall-pulse { 0%,100% { opacity:1 } 50% { opacity:0.55 } }
    @media (prefers-reduced-motion: reduce) {
      .${STALL_INDICATOR_CLASS} .${CHAT_BUBBLE_INNER_CLASS} { animation:none }
    }
    /* ─── Thread drawer (CFB-3.2) ────────────────────────────────────────────
       CSS-only collapsible sidebar mirroring the toolbar hamburger idiom. On
       desktop the sidebar is an ordinary flex column and the drawer chrome
       (toggle checkbox, scrim, hamburger) is inert/hidden — everything below
       only activates inside the mobile @media block in chatPageStyles. DOM
       order is load-bearing: the checkbox precedes the sidebar so the ~ sibling
       combinator can reach it. */
    .chat-drawer-toggle { position:absolute;opacity:0;width:1px;height:1px;pointer-events:none }
    .chat-drawer-hamburger { display:none;background:none;border:1px solid #e5e7eb;border-radius:6px;font-size:18px;line-height:1;padding:6px 10px;cursor:pointer;color:#374151 }
    .chat-drawer-hamburger:hover { color:#4f46e5 }
    .chat-drawer-scrim { display:none }`;

export function renderChatPage(
  agents: AgentOption[],
  selectedAgentId: string | undefined,
  threads: ChatThread[] | null,
  userName: string,
  q?: string,
): string {
  const activePath = "/admin/chat";

  const agentOptions = agents
    .map(
      (a) =>
        `<option value="${escapeHtml(a.id)}"${a.id === selectedAgentId ? " selected" : ""}>${escapeHtml(a.name)}</option>`,
    )
    .join("\n");

  const agentSelector = `
    <form method="GET" action="/admin/chat" class="form-row" style="margin-bottom:24px">
      <div class="form-group" style="max-width:320px">
        <label class="form-label" for="agentId">Agent</label>
        <select name="agentId" id="agentId" class="form-input" onchange="this.form.submit()">
          <option value="">— select an agent —</option>
          ${agentOptions}
        </select>
      </div>
    </form>`;

  let content: string;

  if (threads === null) {
    // Degraded mode — chat service not configured
    content = `
      <div class="alert alert-error">
        Chat service not configured. Set <code>SHIPWRIGHT_CHAT_SERVICE_URL</code> and
        <code>SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN</code> to enable this feature.
      </div>`;
  } else if (!selectedAgentId) {
    // No agent selected yet
    content = `
      <div class="empty-state">
        Select an agent above to view its threads.
      </div>`;
  } else {
    // Search box
    const searchForm = `
      <form method="GET" action="/admin/chat" class="form-row" style="margin-bottom:16px">
        <input type="hidden" name="agentId" value="${escapeHtml(selectedAgentId)}">
        <div class="form-group" style="max-width:320px">
          <input type="text" name="q" class="form-input" placeholder="Search threads…" value="${escapeHtml(q ?? "")}">
        </div>
        <button type="submit" class="btn btn-secondary">Search</button>
      </form>`;

    // New thread form (above the thread list)
    const newThreadForm = `
      <form method="POST" action="/admin/chat/${escapeHtml(selectedAgentId)}/threads" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group">
            <input type="text" name="title" class="form-input" placeholder="Thread title (optional)">
          </div>
          <button type="submit" class="btn btn-primary">New Thread</button>
        </div>
      </form>`;

    // Thread list pane
    const threadLinks =
      threads.length === 0
        ? `<div class="empty-state" style="padding:12px">No threads found.</div>`
        : threads
            .map((t) => {
              const title = escapeHtml(t.title ?? "Untitled");
              return `<a href="/admin/chat/${escapeHtml(selectedAgentId)}/threads/${escapeHtml(t.id)}" class="thread-pane-link">${title}</a>`;
            })
            .join("\n");

    content = `
      ${searchForm}
      <div class="chat-list-layout" style="display:flex;gap:24px;align-items:flex-start">
        <div class="card chat-list-sidebar" style="min-width:240px;max-width:300px;flex-shrink:0">
          <div class="card-title">Threads</div>
          ${newThreadForm}
          <div class="thread-pane-list">
            ${threadLinks}
          </div>
        </div>
        <div style="flex:1">
          <div class="empty-state">Select a thread from the list to view messages.</div>
        </div>
      </div>`;
  }

  return renderAdminPage({
    title: "Chat — Shipwright Admin",
    extraStyles: `${threadPaneStyles}${chatPageStyles}
  `,
    body: `${renderAdminToolbar(userName, activePath)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Chat</h1>
    </div>
    ${agentSelector}
    ${content}
  </div>`,
  });
}

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

/**
 * Renders a thread detail page at /admin/chat/:agentId/threads/:threadId.
 *
 * @param agentId  - agent ID
 * @param thread   - thread object (null = chatClient absent -> degraded mode)
 * @param messages - messages for the thread (null = degraded mode)
 * @param threads  - list of all threads for the sidebar pane (null = not available)
 * @param userName - logged-in user's email for the toolbar
 */
export function renderChatThreadPage(
  agentId: string,
  thread: ChatThread | null,
  messages: ChatMessage[] | null,
  threadsOrUserName: ChatThread[] | null | string,
  userNameArg?: string,
  stats?: ThreadStats | null,
  opts?: {
    stallWarnAfterMs?: number;
    // Push-notification toggle (CFB-4.2). When push is disabled server-side
    // (VAPID not fully configured), pushEnabled is false / vapidPublicKey is
    // absent, renderPushToggle returns "", and the page degrades to exactly the
    // CFB-3.2 page (acceptance criterion 6).
    pushEnabled?: boolean;
    vapidPublicKey?: string;
  },
): string {
  // The stall-warning threshold is normally the 120s production default, but
  // the e2e suite overrides it to a tiny value (via a query param the route
  // handler forwards here) so the stall-state assertion doesn't need a real
  // two-minute wait. Production behaviour is unaffected.
  const stallWarnAfterMs = opts?.stallWarnAfterMs ?? STALL_WARN_AFTER_MS;
  // Support both 4-arg (threads omitted) and 5-arg call signatures
  const threads: ChatThread[] | null =
    typeof threadsOrUserName === "string" ? null : threadsOrUserName;
  const userName: string =
    typeof threadsOrUserName === "string"
      ? threadsOrUserName
      : (userNameArg ?? "");
  const activePath = "/admin/chat";

  if (thread === null || messages === null) {
    return renderAdminPage({
      title: "Thread - Shipwright Admin",
      body: `${renderAdminToolbar(userName, activePath)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Thread</h1>
    </div>
    <div class="alert alert-error">
      Chat service not configured. Set <code>SHIPWRIGHT_CHAT_SERVICE_URL</code> and
      <code>SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN</code> to enable this feature.
    </div>
  </div>`,
    });
  }

  const threadId = thread.id;
  // rawTitle feeds renderAdminPage(), which HTML-escapes it itself; `title`
  // is the pre-escaped display string used inline in body markup below —
  // keep both to avoid double-escaping the <title> tag.
  const rawTitle = thread.title ?? "Untitled Thread";
  const title = thread.title ? escapeHtml(thread.title) : "Untitled Thread";

  // Track the most recent user message body while iterating so an error
  // reply's Retry button (CFB-2.4) can resend the exact text that triggered
  // it. renderChatMessageBubble is the module-level renderer (hoisted in
  // CFB-2.3) so the same retryBody-aware logic is shared with the
  // messages.json poll route.
  let lastUserBody: string | null = null;
  const messageBubbles = messages
    .map((m) => {
      const html = renderChatMessageBubble(m, lastUserBody);
      if (m.role === "user") lastUserBody = m.body;
      return html;
    })
    .join("\n");

  // Server-render the live status bubble when the last user message has no
  // reply yet — so a full-page reload mid-run shows the elapsed/milestone
  // immediately instead of a 3s-later blank until the first poll ticks in.
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const pendingMsg =
    lastMsg && lastMsg.role === "user" && !lastMsg.repliedAt ? lastMsg : null;
  const liveStatusBubble = pendingMsg ? renderLiveStatusBubble(pendingMsg) : "";

  const emptyState =
    messages.length === 0
      ? `<div class="empty-state" style="text-align:center;padding:48px 24px;color:#9ca3af">No messages in this thread yet. Send a message to get started.</div>`
      : "";

  const safeAgentId = escapeHtml(agentId);
  const safeThreadId = escapeHtml(threadId);

  const renameForm = `
    <form method="POST" action="/admin/chat/${escapeHtml(agentId)}/threads/${escapeHtml(threadId)}/rename" style="margin-top:12px">
      <div class="form-row" style="align-items:center;gap:8px">
        <input type="text" name="title" class="form-input" placeholder="New title…" style="max-width:240px" required>
        <button type="submit" class="btn btn-secondary" style="white-space:nowrap">Rename</button>
      </div>
    </form>`;

  const deleteForm = `
    <form method="POST" action="/admin/chat/${escapeHtml(agentId)}/threads/${escapeHtml(threadId)}/delete" style="margin-top:8px" onsubmit="return confirm('Delete this thread?')">
      <button type="submit" class="btn btn-danger">Delete Thread</button>
    </form>`;

  // Collapsed by default so rename/delete controls don't eat vertical space
  // above the fold before any conversation is visible on a short mobile
  // viewport — a plain <details>/<summary> disclosure, no JS required.
  const threadActionsDetails = `
    <details class="chat-thread-actions">
      <summary class="chat-thread-actions-summary">Thread actions</summary>
      ${renameForm}
      ${deleteForm}
    </details>`;

  // Inline JS for the send/poll/live-progress flow (CFB-2.3).
  //
  // Two layers, per the brief:
  //   Layer 1 — a 1s client-side ticker computing now - createdAt with ZERO
  //     network dependency. A dead agent, dead chat service or offline laptop
  //     still ticks; that is the actual "never go silent" guarantee.
  //   Layer 2 — milestone text refreshed off the messages.json poll, adaptive
  //     2s while pending / 10s idle. The milestone is content, not the
  //     guarantee.
  //
  // The live status bubble (${LIVE_STATUS_BUBBLE_ID}) is a single element the
  // server may have rendered (mid-run reload) or the client creates on send.
  // Its data-created-at drives the ticker; data-progress-seq drives skew-free
  // stall detection (compare poll counts since progressSeq last changed, never
  // wall clocks).
  const inlineScript = `
<script>
(function() {
  var form = document.getElementById('send-form');
  var input = document.getElementById('message-input');
  var sendBtn = document.getElementById('send-btn');
  var attachBtn = document.getElementById('attach-btn');
  var fileInput = document.getElementById('file-input');
  var fileName = document.getElementById('file-name');
  var container = document.getElementById('messages-container');
  var agentId = ${JSON.stringify(agentId)};
  var threadId = ${JSON.stringify(thread.id)};
  var messagesJsonUrl = '/admin/chat/' + encodeURIComponent(agentId) + '/threads/' + encodeURIComponent(threadId) + '/messages.json';
  var uploadUrl = '/admin/chat/' + encodeURIComponent(agentId) + '/threads/' + encodeURIComponent(threadId) + '/messages/upload';

  // errorKind → label, generated from the server's single source of truth so
  // the two copies cannot drift.
  var ERROR_KIND_LABELS = ${JSON.stringify(ERROR_KIND_LABELS)};
  var DEFAULT_ERROR_LABEL = ${JSON.stringify(DEFAULT_ERROR_LABEL)};
  function errorKindLabel(kind) {
    return ERROR_KIND_LABELS[kind] || DEFAULT_ERROR_LABEL;
  }

  // Milestone labels, likewise serialized from lib/progress-phases.ts.
  var PROGRESS_LABELS = ${JSON.stringify(PROGRESS_LABELS)};

  // Stall-warning threshold — 120s in prod; e2e overrides to a tiny value.
  var STALL_WARN_AFTER_MS = ${stallWarnAfterMs};
  // Hard ceiling: 65min, mirrors lib/claim-ttl.ts DEFAULT_CLAIM_TTL_MS
  // (1hr DEFAULT_CLAUDE_TIMEOUT_MS + 5min CLAIM_TTL_BUFFER_MS). Only hard stop.
  var ABSOLUTE_MAX_MS = ${ABSOLUTE_MAX_MS};

  var LIVE_STATUS_BUBBLE_ID = ${JSON.stringify(LIVE_STATUS_BUBBLE_ID)};
  var LIVE_STATUS_ELAPSED_ID = ${JSON.stringify(LIVE_STATUS_ELAPSED_ID)};
  var LIVE_STATUS_MILESTONE_ID = ${JSON.stringify(LIVE_STATUS_MILESTONE_ID)};
  var STALL_INDICATOR_CLASS = ${JSON.stringify(STALL_INDICATOR_CLASS)};
  var ASSISTANT_ROLE_CLASS = '${CHAT_BUBBLE_CLASS} ${chatBubbleRoleClass("assistant")}';

  // Poll cadence.
  var POLL_PENDING_MS = 2000; // adaptive fast poll while a reply is pending
  var POLL_IDLE_MS = 10000;   // slow idle poll for agent-initiated messages

  // Rendered-message dedupe: every server bubble carries data-message-id;
  // seed the set from what's already in the DOM so polls never double-render.
  var renderedIds = {};
  Array.prototype.forEach.call(
    container.querySelectorAll('[data-message-id]'),
    function(el) { renderedIds[el.getAttribute('data-message-id')] = true; }
  );

  var pollTimer = null;
  var tickerTimer = null;
  // Skew-free stall tracking: remember the progressSeq we last saw and the
  // wall-clock ms at which it last CHANGED (client clock only — never compared
  // against server timestamps).
  var lastProgressSeq = null;
  var lastProgressChangeMs = null;

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Optimistic user bubble (pre-round-trip; body is plain text, so no markdown
  // — matches the server's white-space:pre-wrap user rendering). Assistant and
  // reloaded bubbles are NEVER built here: they come from server bubbleHtml.
  function addUserBubble(body, attachmentName) {
    var color = '#4f46e5';
    var attachmentHtml = attachmentName
      ? '<div style="display:inline-block;margin-top:8px;padding:3px 8px;background:#e5e7eb;color:#374151;border-radius:6px;font-size:12px">📎 ' + escHtml(attachmentName) + '</div>'
      : '';
    var bubble = document.createElement('div');
    bubble.className = '${CHAT_BUBBLE_CLASS} ${CHAT_BUBBLE_CLASS}--user';
    bubble.innerHTML = '<div class="${CHAT_BUBBLE_INNER_CLASS}">'
      + '<div style="font-size:11px;font-weight:600;color:' + color + ';margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">user</div>'
      + '<div style="font-size:14px;white-space:pre-wrap;color:' + color + '">' + escHtml(body) + '</div>'
      + attachmentHtml
      + '</div>';
    insertBeforeLiveStatus(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
  }

  // Insert a bubble before the live-status bubble (so status stays at the
  // bottom) or append if there's no live-status bubble.
  function insertBeforeLiveStatus(node) {
    var live = document.getElementById(LIVE_STATUS_BUBBLE_ID);
    if (live) container.insertBefore(node, live);
    else container.appendChild(node);
  }

  // Insert a server-rendered bubbleHtml string, deduped by id.
  function renderServerBubble(m) {
    if (!m || !m.id || renderedIds[m.id]) return false;
    renderedIds[m.id] = true;
    if (!m.bubbleHtml) return false;
    var tpl = document.createElement('template');
    tpl.innerHTML = m.bubbleHtml.trim();
    var node = tpl.content.firstChild;
    if (node) insertBeforeLiveStatus(node);
    return true;
  }

  // Ensure the live status bubble exists (creating it on the client when the
  // user just sent a message and the server hasn't rendered one).
  function ensureLiveStatusBubble(createdAtMs) {
    var live = document.getElementById(LIVE_STATUS_BUBBLE_ID);
    if (live) return live;
    live = document.createElement('div');
    live.id = LIVE_STATUS_BUBBLE_ID;
    live.className = ASSISTANT_ROLE_CLASS;
    live.setAttribute('data-created-at', String(createdAtMs));
    live.setAttribute('data-progress-seq', '0');
    live.innerHTML = '<div class="${CHAT_BUBBLE_INNER_CLASS}">'
      + '<div style="font-size:14px;color:#166534;font-style:italic">'
      + '<span id="' + LIVE_STATUS_MILESTONE_ID + '"></span> '
      + '<span id="' + LIVE_STATUS_ELAPSED_ID + '">working… (0s)</span>'
      + '</div></div>';
    container.appendChild(live);
    container.scrollTop = container.scrollHeight;
    return live;
  }

  function removeLiveStatusBubble() {
    var live = document.getElementById(LIVE_STATUS_BUBBLE_ID);
    if (live && live.parentNode) live.parentNode.removeChild(live);
    lastProgressSeq = null;
    lastProgressChangeMs = null;
  }

  // Layer 1: the ZERO-network ticker. Runs every 1s off the live bubble's
  // data-created-at. Also applies the stall class when progressSeq has been
  // frozen past STALL_WARN_AFTER_MS, and hard-stops at ABSOLUTE_MAX_MS.
  function tick() {
    var live = document.getElementById(LIVE_STATUS_BUBBLE_ID);
    if (!live) return;
    var createdAtMs = Number(live.getAttribute('data-created-at')) || Date.now();
    var elapsedMs = Date.now() - createdAtMs;
    var elapsedSec = Math.max(0, Math.round(elapsedMs / 1000));
    var elapsedEl = document.getElementById(LIVE_STATUS_ELAPSED_ID);
    if (elapsedEl) elapsedEl.textContent = 'working… (' + elapsedSec + 's)';

    // Stall detection is time-since-progressSeq-last-changed, on the client
    // clock only. Seed the change time on first sight.
    if (lastProgressChangeMs === null) lastProgressChangeMs = Date.now();
    var stalledFor = Date.now() - lastProgressChangeMs;
    if (stalledFor >= STALL_WARN_AFTER_MS) {
      live.classList.add(STALL_INDICATOR_CLASS);
    } else {
      live.classList.remove(STALL_INDICATOR_CLASS);
    }

    if (elapsedMs >= ABSOLUTE_MAX_MS) {
      // Only hard stop: replace the live bubble with a terminal error and
      // stop everything.
      stopAll();
      removeLiveStatusBubble();
      var errBubble = document.createElement('div');
      errBubble.className = ASSISTANT_ROLE_CLASS;
      errBubble.innerHTML = '<div class="${CHAT_BUBBLE_INNER_CLASS}">'
        + '<div style="margin-top:0;padding:4px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:12px;font-weight:600">Request timed out. Please try again.</div>'
        + '</div>';
      container.appendChild(errBubble);
      enableSend();
    }
  }

  function startTicker() {
    if (tickerTimer) return;
    tick();
    tickerTimer = setInterval(tick, 1000);
  }

  function updateMilestone(phase) {
    var el = document.getElementById(LIVE_STATUS_MILESTONE_ID);
    if (!el) return;
    el.textContent = phase && PROGRESS_LABELS[phase] ? PROGRESS_LABELS[phase] : '';
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }
  function stopTicker() {
    if (tickerTimer) { clearInterval(tickerTimer); tickerTimer = null; }
  }
  function stopAll() { stopPolling(); stopTicker(); }

  function enableSend() {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }

  // Adaptive poll: fast while a reply is pending, slow while idle (so
  // agent-initiated messages still appear without a reload).
  function schedulePoll(delay) {
    stopPolling();
    pollTimer = setTimeout(poll, delay);
  }

  function poll() {
    fetch(messagesJsonUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var msgs = data.messages || [];

        // Render every new (un-rendered) message from the server, in order —
        // fixes "only the last reply appears" and "agent-initiated messages
        // need a reload". Assistant/user/system all go through server
        // bubbleHtml, which already includes any Retry button (CFB-2.4) since
        // the server computes retryBody per-message; wire up any new buttons
        // after insertion (see wireRetryButtons below).
        for (var i = 0; i < msgs.length; i++) {
          renderServerBubble(msgs[i]);
        }
        wireRetryButtons();

        // Determine whether a reply is still pending (last message is an
        // unreplied user message).
        var last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        var pending = last && last.role === 'user' && !last.repliedAt ? last : null;

        if (pending) {
          // Keep the live status bubble present and in sync.
          var createdAtMs = pending.createdAt ? new Date(pending.createdAt).getTime() : Date.now();
          var live = ensureLiveStatusBubble(createdAtMs);
          live.setAttribute('data-created-at', String(createdAtMs));
          startTicker();
          updateMilestone(pending.progressPhase);

          // Skew-free stall tracking: reset the change clock only when
          // progressSeq actually advances.
          var seq = typeof pending.progressSeq === 'number' ? pending.progressSeq : 0;
          if (lastProgressSeq === null || seq !== lastProgressSeq) {
            lastProgressSeq = seq;
            lastProgressChangeMs = Date.now();
          }
          live.setAttribute('data-progress-seq', String(seq));

          container.scrollTop = container.scrollHeight;
          schedulePoll(POLL_PENDING_MS);
        } else {
          // No reply pending: reply landed (or nothing in flight). Tear down
          // the live status bubble and re-enable send, then keep a slow idle
          // poll running so agent-initiated messages still show up live.
          removeLiveStatusBubble();
          stopTicker();
          enableSend();
          container.scrollTop = container.scrollHeight;
          schedulePoll(POLL_IDLE_MS);
        }
      })
      .catch(function() {
        // Network error — Layer 1 ticker keeps going untouched; just retry the
        // poll on the pending cadence.
        schedulePoll(POLL_PENDING_MS);
      });
  }

  // Attach-file button opens the hidden file input; show the chosen name.
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', function() {
      fileInput.click();
    });
    fileInput.addEventListener('change', function() {
      var f = fileInput.files && fileInput.files[0];
      fileName.textContent = f ? ('📎 ' + f.name) : '';
    });
  }

  function clearFile() {
    if (fileInput) fileInput.value = '';
    if (fileName) fileName.textContent = '';
  }

  function sendText(text, file) {
    if (!text && !file) return;

    // Disable send button
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';

    // Build multipart body before clearing the inputs
    var fd = new FormData();
    fd.append('body', text);
    if (file) fd.append('file', file);
    var attachmentName = file ? file.name : null;

    // Add user bubble optimistically (with attachment badge if present).
    addUserBubble(text, attachmentName);

    // Show the live status bubble + start the ticker immediately — Layer 1
    // begins ticking with zero network dependency.
    ensureLiveStatusBubble(Date.now());
    lastProgressSeq = null;
    lastProgressChangeMs = Date.now();
    startTicker();

    // POST multipart to the upload endpoint
    fetch(uploadUrl, {
      method: 'POST',
      body: fd
    }).then(function(r) {
      if (!r.ok) {
        return r.json().then(function(data) {
          stopAll();
          removeLiveStatusBubble();
          var errBubble = document.createElement('div');
          errBubble.className = ASSISTANT_ROLE_CLASS;
          errBubble.innerHTML = '<div class="${CHAT_BUBBLE_INNER_CLASS}">'
            + '<div style="margin-top:0;padding:4px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:12px;font-weight:600">' + escHtml((data && data.error) || 'Upload failed.') + '</div>'
            + '</div>';
          container.appendChild(errBubble);
          enableSend();
        });
      } else {
        // Success: parse response and seed renderedIds to prevent duplicate rendering
        return r.json().then(function(data) {
          if (data && data.message && data.message.id) {
            renderedIds[data.message.id] = true;
          }
        });
      }
    }).catch(function() {
      // POST failed — Layer 1 ticker keeps going; poll loop still starts.
    });

    // Start the fast poll loop.
    schedulePoll(POLL_PENDING_MS);
  }

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var text = input.value.trim();
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!text && !file) return;
    input.value = '';
    clearFile();
    sendText(text, file);
  });

  // Retry buttons (CFB-2.4) resend the exact user message body that
  // triggered the errored/cancelled/incomplete/stalled reply — rendered
  // server-side as a data attribute on each button (see
  // renderChatMessageBubble). Buttons can arrive either on initial page load
  // or later via renderServerBubble during a poll (which dedupes by
  // data-message-id, so a given button is only ever inserted into the DOM
  // once); re-running this after every render pass is therefore safe and
  // never double-wires a button.
  function wireRetryButtons() {
    document.querySelectorAll('.chat-retry-btn').forEach(function(btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', function() {
        if (btn.disabled) return;
        var body = btn.getAttribute('data-retry-body');
        if (!body) return;
        btn.disabled = true;
        sendText(body, null);
      });
    });
  }
  wireRetryButtons();

  // On load: if the server rendered a live status bubble (mid-run reload),
  // start the ticker immediately and begin polling on the pending cadence.
  // Otherwise begin a slow idle poll so agent-initiated messages appear live.
  var serverLive = document.getElementById(LIVE_STATUS_BUBBLE_ID);
  if (serverLive) {
    var seedSeq = Number(serverLive.getAttribute('data-progress-seq'));
    lastProgressSeq = isNaN(seedSeq) ? 0 : seedSeq;
    lastProgressChangeMs = Date.now();
    startTicker();
    schedulePoll(POLL_PENDING_MS);
  } else {
    schedulePoll(POLL_IDLE_MS);
  }

  // Scroll to bottom on load
  container.scrollTop = container.scrollHeight;
})();
</script>`;

  // Standalone drawer + keyboard-inset script (CFB-3.2). Deliberately emitted
  // as its OWN <script> block — NOT inside the progress IIFE above — so the two
  // concerns don't fight the ongoing live-progress rewrite. Three tiny jobs:
  //   1. visualViewport → --kb-inset: on iOS the on-screen keyboard shrinks the
  //      VISUAL viewport but leaves the LAYOUT viewport (and dvh) alone, sliding
  //      the sticky composer under the keyboard. Setting --kb-inset to the
  //      occluded height lets CSS pad the composer back into view. Guarded by
  //      `if (!vv) return` — no speculative fallback for browsers without it.
  //   2. aria-expanded sync on the hamburger, mirroring the toolbar idiom.
  //   3. Escape closes the drawer (a bare checkbox can't listen for keys).
  const drawerScript = `
<script>
(function() {
  var vv = window.visualViewport;
  if (!vv) return;
  var root = document.documentElement;
  function updateKbInset() {
    // Occluded height = layout viewport height minus the visual viewport
    // height (plus its offset). Clamp to >= 0. On Android where dvh already
    // shrinks the layout this stays ~0, which is correct.
    var occluded = window.innerHeight - vv.height - vv.offsetTop;
    root.style.setProperty('--kb-inset', (occluded > 0 ? occluded : 0) + 'px');
  }
  vv.addEventListener('resize', updateKbInset);
  vv.addEventListener('scroll', updateKbInset);
  updateKbInset();
})();
(function() {
  var toggle = document.getElementById('chat-drawer-toggle');
  if (!toggle) return;
  var burger = document.querySelector('.chat-drawer-hamburger');
  function syncAria() {
    if (burger) burger.setAttribute('aria-expanded', toggle.checked ? 'true' : 'false');
  }
  toggle.addEventListener('change', syncAria);
  document.addEventListener('keydown', function(e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && toggle.checked) {
      toggle.checked = false;
      syncAria();
    }
  });
})();
</script>`;

  // Thread list sidebar pane
  // NOTE: no inline font-size here — an inline style would beat the
  // .form-input mobile @media override by specificity and reintroduce the
  // iOS Safari zoom-on-focus defect. Sizing is handled entirely via the
  // .chat-sidebar-new-thread-input class below.
  const newThreadForm = `
    <form method="POST" action="/admin/chat/${escapeHtml(agentId)}/threads" style="margin-bottom:12px">
      <div class="form-row" style="gap:6px">
        <input type="text" name="title" class="form-input chat-sidebar-new-thread-input" placeholder="New thread title…">
        <button type="submit" class="btn btn-primary" style="white-space:nowrap;padding:6px 10px">New Thread</button>
      </div>
    </form>`;

  const threadLinks = threads
    ? threads.length === 0
      ? `<div class="empty-state" style="padding:12px">No threads.</div>`
      : threads
          .map((t) => {
            const tTitle = escapeHtml(t.title ?? "Untitled");
            const isActive = t.id === threadId;
            return `<a href="/admin/chat/${escapeHtml(agentId)}/threads/${escapeHtml(t.id)}" class="thread-pane-link${isActive ? " active" : ""}">${tTitle}</a>`;
          })
          .join("\n")
    : "";

  const sidebar =
    threads !== null
      ? `<div id="chat-thread-sidebar-panel" class="card chat-thread-sidebar" style="min-width:220px;max-width:280px;flex-shrink:0">
          <div class="card-title">Threads</div>
          ${newThreadForm}
          <div class="thread-pane-list">
            ${threadLinks}
          </div>
        </div>`
      : "";

  // Drawer chrome (CFB-3.2). Only render the CSS-only toggle + scrim + hamburger
  // when there's actually a sidebar to reveal — in degraded/no-threads mode the
  // sidebar ternary yields "" and the drawer would be an empty shell. DOM order
  // is load-bearing: the checkbox must precede the sidebar and scrim so the
  // `~` sibling combinator can reach them from `:checked`.
  const drawerToggle = sidebar
    ? `<input type="checkbox" id="chat-drawer-toggle" class="chat-drawer-toggle" aria-hidden="true">`
    : "";
  const drawerScrim = sidebar
    ? `<label for="chat-drawer-toggle" class="chat-drawer-scrim" aria-label="Close thread list"></label>`
    : "";
  // aria-controls references the revealed panel's own id (not the checkbox) —
  // matches the aria-controls="vos-nav-content" pattern in lib/web/toolbar.ts.
  const drawerHamburger = sidebar
    ? `<label for="chat-drawer-toggle" class="chat-drawer-hamburger" role="button" tabindex="0" aria-label="Toggle thread list" aria-expanded="false" aria-controls="chat-thread-sidebar-panel">☰</label>`
    : "";

  return renderAdminPage({
    title: `${rawTitle} - Shipwright Admin`,
    // NOTE: chatThreadStyles must be concatenated before chatPageStyles here —
    // chatPageStyles's mobile @media (max-width:640px) override for
    // .chat-bubble-inner has the same specificity as chatThreadStyles's
    // unconditional base rule, so whichever is concatenated *last* wins the
    // cascade. Putting chatPageStyles last ensures the mobile override
    // actually takes effect at ≤640px instead of being silently shadowed.
    extraStyles: `${threadPaneStyles}${chatThreadStyles}${chatPageStyles}
  `,
    body: `${renderAdminToolbar(userName, activePath)}
  <div class="vos-page chat-thread-page">
    <div class="page-header chat-thread-header">
      <div>
        <div class="chat-thread-header-top" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          ${drawerHamburger}
          <a href="/admin/chat?agentId=${safeAgentId}" class="btn btn-secondary">&larr; Back to threads</a>
        </div>
        <h1 class="page-title">${title}</h1>
        <div class="chat-thread-meta" style="font-size:12px;color:#9ca3af;margin-top:4px">Thread <span class="mono">${safeThreadId}</span></div>
        ${
          stats &&
          (
            stats.totalInputTokens > 0 ||
              stats.totalOutputTokens > 0 ||
              stats.totalCostUsd > 0
          )
            ? `<div class="chat-thread-stats" style="font-size:12px;color:#6b7280;margin-top:4px">${escapeHtml(`${formatTokenCount(stats.totalInputTokens)} in / ${formatTokenCount(stats.totalOutputTokens)} out | $${stats.totalCostUsd.toFixed(4)}`)}</div>`
            : ""
        }
        ${threadActionsDetails}
        ${renderPushToggle({
          pushEnabled: opts?.pushEnabled ?? false,
          vapidPublicKey: opts?.vapidPublicKey ?? "",
          agentId,
          threadId,
        })}
      </div>
    </div>
    <div class="chat-thread-layout" style="display:flex;gap:24px;flex:1;min-height:0;margin-top:16px">
      ${drawerToggle}
      ${sidebar}
      ${drawerScrim}
      <div style="flex:1;min-width:0;min-height:0;display:flex;flex-direction:column">
        <!-- Messages area (scrollable) -->
        <div id="messages-container" class="chat-messages-container">
          ${messageBubbles}
          ${liveStatusBubble}
          ${emptyState}
        </div>

        <!-- Send form -->
        <form id="send-form" enctype="multipart/form-data" class="chat-composer-form">
          <div class="chat-composer-row">
            <textarea
              id="message-input"
              name="body"
              rows="3"
              placeholder="Type a message..."
              class="chat-message-input"
            ></textarea>
            <input type="file" id="file-input" name="file" style="display:none" accept="text/*,image/*,application/pdf,application/json">
            <button
              type="button"
              id="attach-btn"
              class="btn btn-secondary chat-composer-btn chat-composer-btn--attach"
            >Attach file</button>
            <button
              type="submit"
              id="send-btn"
              class="btn btn-primary chat-composer-btn chat-composer-btn--send"
            >Send</button>
          </div>
          <div id="file-name" style="font-size:12px;color:#6b7280;margin-top:6px;min-height:16px"></div>
        </form>
      </div>
    </div>
  </div>`,
    bodyEnd: `${inlineScript}\n${drawerScript}`,
  });
}
