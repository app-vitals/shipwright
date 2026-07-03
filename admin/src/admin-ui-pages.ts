/**
 * agent/src/admin-ui-pages.ts
 * Pure HTML rendering functions for admin UI pages.
 * No Hono dependencies — pure string → string functions.
 *
 * Follows the same inline HTML template string pattern as
 * metrics/src/dashboard/dashboard-page.ts.
 */

import {
  baseStyles,
  escapeHtml,
  renderAdminToolbar,
} from "./admin-ui-styles.ts";
import type {
  ChatMessage,
  ChatThread,
  MessageTokens,
  ThreadStats,
} from "./http-chat-client.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  | { type: "dependency"; id: string; status: string };

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
  taskId?: string | null;
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
  preCheck?: string | null;
  lastRun?: {
    startedAt: Date;
    completedAt: Date | null;
    skipped: boolean;
    outcome: string | null;
  } | null;
  runCountToday?: number;
}

export interface CronRunItem {
  id?: string;
  startedAt: Date;
  completedAt: Date | null;
  outcome: string | null;
  skipped: boolean;
  skipReason: string | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
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

export interface ToolItem {
  id: string;
  pattern: string;
  enabled: boolean;
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
  addedAt?: string | null;
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
}

// Token shape returned by the task-store /tokens endpoint (admin token only).
// Mirrors TaskToken fields relevant to the admin UI; avoids cross-package coupling.
export interface TaskStoreTokenItem {
  id: string;
  label: string | null;
  agentId: string | null;
  token: string;
  createdAt: Date | string;
  revokedAt: Date | string | null;
  rawToken?: string;
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
}): string {
  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const googleHref = opts?.returnTo
    ? `/admin/auth/google?returnTo=${encodeURIComponent(opts.returnTo)}`
    : "/admin/auth/google";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin Login — Shipwright</title>
  <style>${baseStyles()}</style>
</head>
<body>
  <div class="login-wrapper">
    <div class="login-card">
      <h1 class="login-title">Shipwright Admin</h1>
      <p class="login-subtitle">Sign in to manage your agents.</p>
      ${errorHtml}
      <a href="${googleHref}" class="btn btn-primary" style="width:100%;justify-content:center;text-decoration:none">Sign in with Google</a>
    </div>
  </div>
</body>
</html>`;
}

// ─── Agents list page ─────────────────────────────────────────────────────────

export function renderAgentsPage(
  agents: AgentListItem[],
  userName: string,
  isAdmin: boolean,
  timezone: string,
): string {
  const rows =
    agents.length === 0
      ? `<tr><td colspan="4" class="empty-state">${isAdmin ? 'No agents yet. <a href="/admin/provision">Provision one →</a>' : "No agents."}</td></tr>`
      : agents
          .map(
            (a) => `<tr>
    <td><a href="/admin/agents/${escapeHtml(a.id)}" class="agent-link">${escapeHtml(a.name)}</a></td>
    <td class="mono">${a.slackId ? escapeHtml(a.slackId) : '<span style="color:#9ca3af">—</span>'}</td>
    <td>${escapeHtml(new Date(a.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
    <td><a href="/admin/agents/${escapeHtml(a.id)}" class="btn btn-secondary" style="font-size:12px;padding:4px 10px">Manage</a></td>
  </tr>`,
          )
          .join("\n");

  const provisionButton = isAdmin
    ? `<a href="/admin/provision" class="btn btn-primary">+ Provision agent</a>
      <a href="/admin/agents/new" class="btn btn-secondary" style="margin-left:8px">+ New local agent</a>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agents — Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Agents</h1>
      ${provisionButton}
    </div>
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
  </div>
</body>
</html>`;
}

// ─── New local agent page ─────────────────────────────────────────────────────

export function renderNewLocalAgentPage(
  userName: string,
  error?: string,
): string {
  const errorHtml = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>New Local Agent — Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header">
      <div>
        <a href="/admin/agents" style="font-size:13px;color:#6b7280;text-decoration:none">← Agents</a>
        <h1 class="page-title" style="margin-top:4px">New Local Agent</h1>
      </div>
    </div>
    ${errorHtml}
    <div class="card">
      <p style="font-size:14px;color:#6b7280;margin-bottom:20px">
        Create a self-hosted agent. The agent will run on your own infrastructure.
        Slack provisioning can be done separately from the agent detail page.
      </p>
      <form method="POST" action="/admin/agents" style="display:flex;flex-direction:column;gap:16px">
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
        <div>
          <button type="submit" class="btn btn-primary">Create agent →</button>
          <a href="/admin/agents" class="btn btn-secondary" style="margin-left:8px">Cancel</a>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// ─── Agent detail page ────────────────────────────────────────────────────────

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

  const systemCrons = crons.filter((c) => c.system);
  const customCrons = crons.filter((c) => !c.system);

  function renderCronRow(c: CronJobItem): string {
    const toggleLabel = c.enabled ? "Disable" : "Enable";
    const toggleTarget = c.enabled ? "false" : "true";
    const actions = `
      <a href="/admin/agents/${escapeHtml(agent.id)}/crons/${escapeHtml(c.id)}/runs" class="btn btn-secondary" style="font-size:11px;padding:3px 8px;margin-right:4px;text-decoration:none">Logs</a>
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
    const lastRunHtml = c.lastRun?.startedAt
      ? `
      <div style="font-size:11px;color:#6b7280;margin-bottom:4px">${relativeTime(c.lastRun.startedAt, now)}</div>
      <div>
        <span class="badge" style="${cronOutcomeStyle(c.lastRun.outcome)}">${escapeHtml(c.lastRun.outcome || "unknown")}</span>
      </div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${c.runCountToday ?? 0} run${(c.runCountToday ?? 0) === 1 ? "" : "s"}</div>`
      : `<div style="color:#d1d5db">never</div>`;

    return `<tr>
      <td class="mono">${escapeHtml(c.schedule)}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.name ? `${c.name}: ${c.prompt}` : c.prompt)}</td>
      <td class="mono" style="font-size:11px;color:#6b7280;max-width:170px;overflow:hidden;text-overflow:ellipsis">${c.preCheck ? escapeHtml(c.preCheck) : "—"}</td>
      <td>${c.channel ? escapeHtml(c.channel) : c.user ? escapeHtml(c.user) : "—"}</td>
      <td><span class="badge ${c.enabled ? "badge-green" : "badge-gray"}">${c.enabled ? "enabled" : "disabled"}</span></td>
      <td style="font-size:11px">${lastRunHtml}</td>
      <td style="white-space:nowrap">${actions}${editForm}</td>
    </tr>`;
  }

  const systemCronRows =
    systemCrons.length === 0
      ? `<tr><td colspan="7" class="empty-state">No system crons configured.</td></tr>`
      : systemCrons.map(renderCronRow).join("\n");

  const customCronRows =
    customCrons.length === 0
      ? `<tr><td colspan="7" class="empty-state">No custom crons yet.</td></tr>`
      : customCrons.map(renderCronRow).join("\n");

  const toolRows =
    tools.length === 0
      ? `<tr><td colspan="3" class="empty-state">No tools configured.</td></tr>`
      : tools
          .map(
            (t) => `<tr>
      <td class="mono">${escapeHtml(t.pattern)}</td>
      <td><span class="badge ${t.enabled ? "badge-green" : "badge-gray"}">${t.enabled ? "enabled" : "disabled"}</span></td>
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
      ? `<tr><td colspan="3" class="empty-state">No plugins installed.</td></tr>`
      : plugins
          .map(
            (p) => `<tr>
      <td class="mono">${escapeHtml(p.name)}</td>
      <td class="mono">${p.version ? escapeHtml(p.version) : "latest"}</td>
      <td><span class="badge ${p.enabled ? "badge-green" : "badge-gray"}">${p.enabled ? "enabled" : "disabled"}</span></td>
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
    </div>`;

  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const successHtml = opts?.successMsg
    ? `<div class="alert alert-success">${escapeHtml(opts.successMsg)}</div>`
    : "";

  const newTokenHtml = opts?.newToken
    ? `<div class="alert alert-success">
        <strong>Token created.</strong> Copy it now — it will not be shown again.<br />
        <code class="mono" style="display:block;margin-top:8px;font-size:13px;word-break:break-all">${escapeHtml(opts.newToken)}</code>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(agent.name)} — Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header">
      <div>
        <a href="/admin/agents" style="font-size:13px;color:#6b7280;text-decoration:none">← Agents</a>
        <h1 class="page-title" style="margin-top:4px">${escapeHtml(agent.name)}</h1>
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
    ${newTokenHtml}

    ${
      !agent.selfHosted
        ? `<div class="card">
      <div class="card-title">Env Vars</div>
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

    <div class="card">
      <div class="card-title">Cron Jobs</div>

      ${
        agent.selfHosted
          ? `<p style="font-size:13px;color:#6b7280;margin:0 0 16px">Crons fire only while the local agent service is running. Make sure your service is active before enabling crons.</p>`
          : ""
      }

      <div style="margin-bottom:20px">
        <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">System</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Schedule</th>
              <th>Prompt</th>
              <th>Pre-check</th>
              <th>Target</th>
              <th>Status</th>
              <th>Last run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${systemCronRows}
          </tbody>
        </table>
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
        <table class="data-table">
          <thead>
            <tr>
              <th>Schedule</th>
              <th>Prompt</th>
              <th>Pre-check</th>
              <th>Target</th>
              <th>Status</th>
              <th>Last run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${customCronRows}
          </tbody>
        </table>
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
      <table class="data-table">
        <thead>
          <tr>
            <th>Pattern</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${toolRows}
        </tbody>
      </table>
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

    ${
      agent.selfHosted
        ? `<div class="card">
      <div class="card-title">Local CLI Access</div>
      <p style="font-size:13px;color:#6b7280;margin-bottom:12px">
        This agent runs locally. Use an API token to authenticate the local agent process with the admin service.
      </p>
      <a href="/admin/tokens?agentId=${escapeHtml(agent.id)}" class="btn btn-secondary" style="font-size:13px">
        Manage Tokens →
      </a>
    </div>`
        : ""
    }

    <div class="card">
      <div class="card-title">Plugins</div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Package</th>
            <th>Version</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${pluginRows}
        </tbody>
      </table>
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

  </div>
</body>
</html>`;
}

// ─── Provision pages ──────────────────────────────────────────────────────────

export function renderProvisionStartPage(
  userName: string,
  agents: { id: string; name: string }[],
  opts?: { oauthUrl?: string; error?: string },
): string {
  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const safeOauthUrl = opts?.oauthUrl?.startsWith("https://")
    ? opts.oauthUrl
    : "";

  const agentOptions = agents
    .map(
      (a) =>
        `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name)}</option>`,
    )
    .join("\n          ");

  const oauthSection = opts?.oauthUrl
    ? `<div class="alert alert-success">
        <strong>App created!</strong> Click the link below to authorize the Slack app.
      </div>
      <div class="oauth-url-box">${escapeHtml(opts.oauthUrl)}</div>
      <a href="${escapeHtml(safeOauthUrl)}" class="btn btn-primary" target="_blank" rel="noopener noreferrer">
        Authorize Slack App →
      </a>
      <p style="margin-top:16px;font-size:13px;color:#6b7280">
        After authorizing, the app credentials have been saved for your agent.
      </p>`
    : `<form method="POST" action="/admin/provision/start">
        <div class="form-group">
          <label class="form-label" for="agentId">Agent</label>
          <select id="agentId" name="agentId" class="form-input" required>
            <option value="">— select an agent —</option>
          ${agentOptions}
          </select>
        </div>

        <fieldset style="border:1px solid #e8e8ee;border-radius:8px;padding:16px;margin-bottom:16px">
          <legend style="font-size:13px;font-weight:600;padding:0 8px">GitHub Authentication</legend>
          <div class="form-group" style="margin-bottom:12px">
            <label style="font-size:13px;font-weight:500;margin-right:16px">
              <input type="radio" name="ghAuthMode" value="pat" checked
                onchange="document.getElementById('gh-pat-fields').style.display='block';document.getElementById('gh-app-fields').style.display='none'"
              /> Personal Access Token
            </label>
            <label style="font-size:13px;font-weight:500">
              <input type="radio" name="ghAuthMode" value="app"
                onchange="document.getElementById('gh-pat-fields').style.display='none';document.getElementById('gh-app-fields').style.display='block'"
              /> GitHub App
            </label>
          </div>
          <div id="gh-pat-fields">
            <div class="form-group">
              <label class="form-label" for="ghPat">Personal Access Token</label>
              <input id="ghPat" name="ghPat" type="password" class="form-input" placeholder="ghp_..." />
            </div>
          </div>
          <div id="gh-app-fields" style="display:none">
            <div class="form-group">
              <label class="form-label" for="ghAppId">App ID</label>
              <input id="ghAppId" name="ghAppId" type="text" class="form-input" placeholder="123456" />
            </div>
            <div class="form-group">
              <label class="form-label" for="ghAppInstallationId">Installation ID</label>
              <input id="ghAppInstallationId" name="ghAppInstallationId" type="text" class="form-input" placeholder="987654" />
            </div>
            <div class="form-group">
              <label class="form-label" for="ghAppPrivateKey">Private Key (PEM)</label>
              <textarea id="ghAppPrivateKey" name="ghAppPrivateKey" class="form-input" rows="6"
                placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"></textarea>
            </div>
          </div>
        </fieldset>

        <fieldset style="border:1px solid #e8e8ee;border-radius:8px;padding:16px;margin-bottom:16px">
          <legend style="font-size:13px;font-weight:600;padding:0 8px">AI Credentials (optional)</legend>
          <div class="form-group">
            <label class="form-label" for="anthropicApiKey">Anthropic API Key</label>
            <input id="anthropicApiKey" name="anthropicApiKey" type="password" class="form-input" placeholder="sk-ant-..." />
          </div>
          <div class="form-group">
            <label class="form-label" for="claudeCodeOauthToken">Claude Code OAuth Token</label>
            <input id="claudeCodeOauthToken" name="claudeCodeOauthToken" type="password" class="form-input" />
          </div>
        </fieldset>

        <div class="form-group">
          <label class="form-label" for="xoxpToken">Slack App Configuration Token</label>
          <input
            id="xoxpToken"
            name="xoxpToken"
            type="password"
            class="form-input"
            placeholder="xoxe.xoxp-..."
            required
          />
          <p style="font-size:12px;color:#6b7280;margin-top:6px">
            This token is used once to create the Slack app manifest. It is not stored.
          </p>
        </div>
        <button type="submit" class="btn btn-primary">Create Slack App →</button>
      </form>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Provision Agent — Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step ${!opts?.oauthUrl ? "active" : ""}">1. Create Slack App</span>
      <span class="provision-step ${opts?.oauthUrl ? "active" : ""}">2. Authorize</span>
      <span class="provision-step">3. Complete</span>
    </div>
    <div class="card">
      ${errorHtml}
      ${oauthSection}
    </div>
  </div>
</body>
</html>`;
}

// xapp-token page shown after OAuth callback completes — user pastes the Socket Mode app token.
export function renderProvisionXappTokenPage(
  userName: string,
  opts: { agentId: string; error?: string },
): string {
  const errorHtml = opts.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Complete Provisioning — Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/provision")}
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
      ${errorHtml}
      <form method="POST" action="/admin/provision/xapp-token">
        <input type="hidden" name="agentId" value="${escapeHtml(opts.agentId)}" />
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
  </div>
</body>
</html>`;
}

// Paste form shown after OAuth callback — user enters SLACK_APP_ID and SLACK_SIGNING_SECRET
// from the Slack App Credentials page (signing secret is not returned by Slack's OAuth API).
export function renderProvisionPasteForm(
  userName: string,
  opts?: { agentId?: string; error?: string },
): string {
  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Complete Provisioning — Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step">2. Authorize</span>
      <span class="provision-step active">3. Paste Credentials</span>
    </div>
    <div class="card">
      <p style="font-size:14px;margin-bottom:16px;color:#6b7280">
        Open your Slack App's <strong>Basic Information</strong> page and paste the credentials below.
      </p>
      ${errorHtml}
      <form method="POST" action="/admin/provision/complete">
        <input type="hidden" name="agentId" value="${escapeHtml(opts?.agentId ?? "")}" />
        <div class="form-group">
          <label class="form-label" for="appId">App ID</label>
          <input id="appId" name="appId" type="text" class="form-input" placeholder="AXXXXXXXXXX" required />
        </div>
        <div class="form-group">
          <label class="form-label" for="signingSecret">Signing Secret</label>
          <input id="signingSecret" name="signingSecret" type="password" class="form-input" placeholder="Paste from App Credentials" required />
        </div>
        <button type="submit" class="btn btn-primary">Save Credentials →</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

// ─── Tasks page ──────────────────────────────────────────────────────────────

export function renderTasksPage(
  tasks: TaskItem[],
  filters: {
    status?: string;
    state?: "ready" | "in_progress" | "blocked" | "closed";
    session?: string;
    repo?: string;
    agent?: string;
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
  suggestions?: { sessions?: string[]; repos?: string[]; agents?: string[] },
  readOnly = false,
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

  const statusBadgeClass = (s: string) => {
    if (s === "in_progress" || s === "pr_open" || s === "approved")
      return "badge-blue";
    if (s === "done" || s === "deployed" || s === "merged")
      return "badge-green";
    if (s === "blocked" || s === "cancelled") return "badge-red";
    return "badge-gray";
  };

  const renderBlockerBadges = (
    blockedBy: BlockedByEntry[] | null | undefined,
  ): string => {
    if (!blockedBy || blockedBy.length === 0) return "";
    return blockedBy
      .map((b) => {
        if (b.type === "hitl") {
          return `<span class="badge badge-hitl" style="font-size:10px;margin-left:6px">Waiting: HITL</span>`;
        }
        return `<span class="badge badge-dep" style="font-size:10px;margin-left:6px">Blocked: ${escapeHtml(b.id)}</span>`;
      })
      .join("");
  };

  const rows =
    tasks.length === 0
      ? `<tr><td colspan="8" class="empty-state">No tasks found.</td></tr>`
      : tasks
          .map((t) => {
            const agentId = t.claimedBy ?? t.assignee;
            const agentCell = agentId
              ? escapeHtml(agentNames[agentId] ?? agentId)
              : '<span style="color:#9ca3af">—</span>';
            const blockerBadges = renderBlockerBadges(t.blockedBy);
            const prCell =
              t.pr && t.repo
                ? `<a href="https://github.com/${escapeHtml(t.repo)}/pull/${t.pr}" style="color:#6366f1;text-decoration:none" title="View PR">#${t.pr}</a>`
                : t.prUrl
                  ? `<a href="${escapeHtml(t.prUrl)}" style="color:#6366f1;text-decoration:none" title="View PR">#${t.pr ?? "PR"}</a>`
                  : '<span style="color:#9ca3af">—</span>';
            return `<tr${readOnly ? "" : ` data-href="/admin/tasks/${escapeHtml(t.id)}" style="cursor:pointer"`}>
    <td class="mono" style="font-size:11px">${readOnly ? escapeHtml(t.id) : `<a href="/admin/tasks/${escapeHtml(t.id)}" style="color:#6366f1;text-decoration:none" title="View details">${escapeHtml(t.id)}</a>`}</td>
    <td>${readOnly ? escapeHtml(t.title) : `<a href="/admin/tasks/${escapeHtml(t.id)}" style="color:inherit;text-decoration:none">${escapeHtml(t.title)}</a>`}${blockerBadges}</td>
    <td><span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status)}</span></td>
    <td style="font-size:12px">${agentCell}</td>
    <td class="col-session mono" style="font-size:11px">${t.session ? escapeHtml(t.session) : '<span style="color:#9ca3af">—</span>'}</td>
    <td class="col-repo mono" style="font-size:11px">${t.repo ? escapeHtml(t.repo) : '<span style="color:#9ca3af">—</span>'}</td>
    <td class="mono" style="font-size:11px">${prCell}</td>
    ${
      readOnly
        ? ""
        : `<td>${
            t.status === "in_progress"
              ? `<form method="POST" action="/admin/tasks/${escapeHtml(t.id)}/release" style="display:inline">
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
    if (filters.repo) p.set("repo", filters.repo);
    if (filters.agent) p.set("agent", filters.agent);
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

  // Pagination
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
    if (filters.repo) params.set("repo", filters.repo);
    if (filters.agent) params.set("agent", filters.agent);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/admin/tasks${qs ? `?${qs}` : ""}`;
  };

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tasks — Shipwright</title>
  <style>${baseStyles()}
    .badge-blue { background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe; }
    .badge-green { background:#dcfce7;color:#166534;border:1px solid #bbf7d0; }
    .badge-red { background:#fee2e2;color:#991b1b;border:1px solid #fecaca; }
    .badge-hitl { background:#fff7ed;color:#c2410c;border:1px solid #fed7aa; }
    .badge-dep { background:#fefce8;color:#a16207;border:1px solid #fde047; }
    .alert-warning { background:#fefce8;color:#854d0e;border:1px solid #fde047;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:13px; }
  </style>
</head>
<body>
  ${readOnly ? "" : renderAdminToolbar(userName, "/admin/tasks")}
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
        ${filters.state && !filters.status ? `<input type="hidden" name="state" value="${escapeHtml(filters.state)}" />` : ""}
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Status</label>
          <select name="status" class="form-input" style="font-size:12px;padding:4px 8px">${statusOptions}</select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Session</label>
          <input name="session" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.session ?? "")}" placeholder="session-id"${suggestions?.sessions?.length ? ' list="sessions-list"' : ""} />
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Repo</label>
          <input name="repo" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.repo ?? "")}" placeholder="org/repo"${suggestions?.repos?.length ? ' list="repos-list"' : ""} />
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Agent</label>
          <input name="agent" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.agent ?? "")}" placeholder="agent name"${suggestions?.agents?.length ? ' list="agents-list"' : ""} />
        </div>
        <button type="submit" class="btn btn-secondary" style="font-size:12px">Filter</button>
        <a href="/admin/tasks" class="btn btn-secondary" style="font-size:12px">Reset</a>
        ${suggestions?.sessions?.length ? `<datalist id="sessions-list">${suggestions.sessions.map((s) => `<option value="${escapeHtml(s)}">`).join("")}</datalist>` : ""}
        ${suggestions?.repos?.length ? `<datalist id="repos-list">${suggestions.repos.map((r) => `<option value="${escapeHtml(r)}">`).join("")}</datalist>` : ""}
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
              <th>PR</th>
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
  </div>
  ${
    readOnly
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
  </script>`
  }
</body>
</html>`;
}

// ─── Task detail page ────────────────────────────────────────────────────────

export function renderTaskDetailPage(
  task: TaskItem,
  userName: string,
  agentNames: Record<string, string> = {},
  timezone = "America/Los_Angeles",
  pullRequest?: PullRequestItem,
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

  function listField(label: string, items: string[] | undefined): string {
    if (!items || items.length === 0) return "";
    const listItems = items
      .map(
        (i) =>
          `<li style="font-size:13px;margin-bottom:4px">${escapeHtml(i)}</li>`,
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
                return `<li style="font-size:14px;line-height:1.6;margin-bottom:4px">dep:${escapeHtml(b.id)} (${escapeHtml(b.status)})</li>`;
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
    field(
      "Assignee",
      task.assignee
        ? agentNames[task.assignee]
          ? `${agentNames[task.assignee]} (${task.assignee})`
          : task.assignee
        : null,
      true,
    ),
    field(
      "Agent Hint",
      task.agentHint
        ? agentNames[task.agentHint]
          ? `${agentNames[task.agentHint]} (${task.agentHint})`
          : task.agentHint
        : null,
      true,
    ),
    field(
      "Claimed By",
      task.claimedBy
        ? agentNames[task.claimedBy]
          ? `${agentNames[task.claimedBy]} (${task.claimedBy})`
          : task.claimedBy
        : null,
      true,
    ),
    field("Session", task.session, true),
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
    field("Note", task.note),
    field("Blocked Reason", task.blockedReason),
    field("Merge Commit", task.mergeCommit, true),
  ]
    .filter(Boolean)
    .join("\n");

  const datesRows = [
    dateField("Added", task.addedAt),
    dateField("Started", task.startedAt),
    dateField("Claimed", task.claimedAt),
    dateField("Last Heartbeat", task.heartbeatAt),
    dateField("Blocked", task.blockedAt),
    dateField("Completed", task.completedAt),
    dateField("Created", task.createdAt),
    dateField("Updated", task.updatedAt),
  ]
    .filter(Boolean)
    .join("\n");

  const depsSection =
    task.dependencies && task.dependencies.length > 0
      ? listField("Dependencies", task.dependencies)
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(task.title)} — Tasks — Shipwright Admin</title>
  <style>${baseStyles()}
    .badge-blue { background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe; }
    .detail-table { width:100%;border-collapse:collapse; }
    .detail-table tr:not(:last-child) td { border-bottom:1px solid #f3f4f6; }
    .markdown-body pre { background:#f3f4f6; border-radius:4px; padding:12px; overflow-x:auto; font-size:12px; }
    .markdown-body code { background:#f3f4f6; border-radius:3px; padding:1px 4px; font-size:12px; }
    .markdown-body pre code { background:none; padding:0; }
    .markdown-body ul, .markdown-body ol { padding-left:20px; margin:8px 0; }
    .markdown-body li { margin-bottom:4px; }
  </style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/tasks")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <a href="/admin/tasks" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>
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
  </div>
</body>
</html>`;
}

export function renderPrsPage(
  prs: PrListItem[],
  filters: {
    repo?: string;
    state?: string;
    reviewState?: string;
    taskId?: string;
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
  suggestions?: { repos?: string[] },
): string {
  const degradedHtml = degraded
    ? `<div class="alert alert-warning">PR store unavailable — data shown may be stale or empty.</div>`
    : "";

  const prStateBadgeClass = (s: string) => {
    if (s === "open") return "badge-blue";
    if (s === "closed" || s === "merged") return "badge-green";
    return "badge-gray";
  };

  const reviewStateBadgeClass = (s: string) => {
    if (s === "in_progress" || s === "posted") return "badge-blue";
    if (s === "approved") return "badge-green";
    return "badge-gray";
  };

  const rows =
    prs.length === 0
      ? `<tr><td colspan="9" class="empty-state">No PRs found.</td></tr>`
      : prs
          .map((pr) => {
            const claimedCell = pr.claimedBy
              ? escapeHtml(agentNames[pr.claimedBy] ?? pr.claimedBy)
              : '<span style="color:#9ca3af">—</span>';
            const taskCell = pr.taskId
              ? `<a href="/admin/tasks/${escapeHtml(pr.taskId)}" style="color:#6366f1;text-decoration:none">${escapeHtml(pr.taskId)}</a>`
              : '<span style="color:#9ca3af">—</span>';
            const updatedCell = pr.updatedAt
              ? escapeHtml(
                  (() => {
                    const d = new Date(pr.updatedAt);
                    return Number.isNaN(d.getTime())
                      ? pr.updatedAt
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
    <td><span class="badge ${prStateBadgeClass(pr.state)}">${escapeHtml(pr.state)}</span></td>
    <td><span class="badge ${reviewStateBadgeClass(pr.reviewState)}">${escapeHtml(pr.reviewState)}</span></td>
    <td class="col-review-cycles" style="font-size:12px;text-align:center">${escapeHtml(String(pr.reviewCycles))}</td>
    <td class="col-patch-cycles" style="font-size:12px;text-align:center">${escapeHtml(String(pr.patchCycles))}</td>
    <td class="col-claimed-by" style="font-size:12px">${claimedCell}</td>
    <td style="font-size:12px">${updatedCell}</td>
  </tr>`;
          })
          .join("\n");

  // State tab helpers
  const activeState = filters.state;

  const makeTabParams = (tabState: string): string => {
    const p = new URLSearchParams();
    p.set("state", tabState);
    if (filters.repo) p.set("repo", filters.repo);
    if (filters.taskId) p.set("taskId", filters.taskId);
    if (filters.reviewState) p.set("reviewState", filters.reviewState);
    return `?${p.toString()}`;
  };

  const tabStyle = (tabState: string) =>
    activeState === tabState
      ? "background:#6366f1;color:#fff;font-weight:600"
      : "background:#fff;color:#374151";

  const stateToggle = `
    <div style="display:flex;gap:0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;width:fit-content">
      <a href="/admin/prs${makeTabParams("open")}"
         style="padding:5px 14px;font-size:12px;text-decoration:none;${tabStyle("open")}">Open</a>
      <a href="/admin/prs${makeTabParams("merged")}"
         style="padding:5px 14px;font-size:12px;text-decoration:none;border-left:1px solid #e5e7eb;${tabStyle("merged")}">Merged</a>
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
    if (filters.repo) params.set("repo", filters.repo);
    if (filters.taskId) params.set("taskId", filters.taskId);
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PRs — Shipwright Admin</title>
  <style>${baseStyles()}
    .badge-blue { background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe; }
    .badge-green { background:#dcfce7;color:#166534;border:1px solid #bbf7d0; }
    .badge-red { background:#fee2e2;color:#991b1b;border:1px solid #fecaca; }
    .alert-warning { background:#fefce8;color:#854d0e;border:1px solid #fde047;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:13px; }
  </style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/prs")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <h1 class="page-title" style="margin:0">PRs</h1>
      ${stateToggle}
    </div>
    ${degradedHtml}
    <div class="card" style="margin-bottom:16px">
      <form method="GET" action="/admin/prs" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div class="form-group" style="margin-bottom:0">
          <label class="form-label" style="font-size:11px">Repo</label>
          <input name="repo" type="text" class="form-input" style="font-size:12px;padding:4px 8px" value="${escapeHtml(filters.repo ?? "")}" placeholder="org/repo" ${suggestions?.repos?.length ? 'list="prs-repos-list"' : ""} />
          ${suggestions?.repos?.length ? `<datalist id="prs-repos-list">${suggestions.repos.map((r) => `<option value="${escapeHtml(r)}"></option>`).join("")}</datalist>` : ""}
        </div>
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
        <button type="submit" class="btn btn-secondary" style="font-size:12px;padding:4px 12px">Filter</button>
        <a href="/admin/prs" class="btn btn-secondary" style="font-size:12px;padding:4px 12px">Reset</a>
      </form>
    </div>
    <div class="card">
      <table class="data-table" style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">PR#</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Repo</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Task</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">State</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Review State</th>
            <th class="col-review-cycles" style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Review Cycles</th>
            <th class="col-patch-cycles" style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Patch Cycles</th>
            <th class="col-claimed-by" style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Claimed By</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Updated</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
      ${paginationHtml}
    </div>
  </div>
  <script>
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
  </script>
</body>
</html>`;
}

export function renderPrDetailPage(
  pr: PrListItem,
  userName: string,
  agentNames: Record<string, string> = {},
  timezone = "America/Los_Angeles",
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

  const claimedByDisplay = pr.claimedBy
    ? agentNames[pr.claimedBy]
      ? `${agentNames[pr.claimedBy]} (${pr.claimedBy})`
      : pr.claimedBy
    : null;

  const metaRows = [
    field("ID", pr.id, true),
    field("Repo", pr.repo),
    field("PR Number", String(pr.prNumber)),
    field("Task", pr.taskId),
    field("State", pr.state),
    field("Review State", pr.reviewState),
    field("Review Cycles", String(pr.reviewCycles)),
    field("Patch Cycles", String(pr.patchCycles)),
    field("Commit SHA", pr.commitSha, true),
    field("Staged", pr.staged ? "yes" : "no"),
    field("Claimed By", claimedByDisplay, true),
    field("Agent ID", pr.agentId, true),
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
    dateField("Updated", pr.updatedAt),
  ]
    .filter(Boolean)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PR #${escapeHtml(String(pr.prNumber))} — ${escapeHtml(pr.repo)} — Shipwright Admin</title>
  <style>${baseStyles()}
    .badge-blue { background:#dbeafe;color:#1d4ed8;border:1px solid #bfdbfe; }
    .badge-green { background:#dcfce7;color:#166534;border:1px solid #bbf7d0; }
    .badge-gray { background:#f3f4f6;color:#374151;border:1px solid #e5e7eb; }
    .detail-table { width:100%;border-collapse:collapse; }
    .detail-table tr:not(:last-child) td { border-bottom:1px solid #f3f4f6; }
  </style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/prs")}
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
  </div>
</body>
</html>`;
}

export function renderCronRunsPage(opts: {
  agent: { id: string; name: string };
  cron: { id: string; name: string | null; schedule: string };
  runs: CronRunItem[];
  userName: string;
  timezone?: string;
}): string {
  const { agent, cron, runs, userName } = opts;
  const timezone = opts.timezone ?? "America/Los_Angeles";

  function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const totalSec = ms / 1000;
    if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
    const min = Math.floor(totalSec / 60);
    const sec = Math.round(totalSec % 60);
    return `${min}m ${sec}s`;
  }

  function row(r: CronRunItem): string {
    const outcomeLabel = r.skipped ? "skipped" : (r.outcome ?? "unknown");
    const badgeStyle = cronOutcomeStyle(outcomeLabel);
    const badgeTitle = r.skipped && r.skipReason ? r.skipReason : outcomeLabel;
    const outcomeCell = `<span class="badge" style="${badgeStyle}" title="${escapeHtml(badgeTitle)}">${escapeHtml(outcomeLabel)}</span>`;

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

    const tokensCell =
      r.inputTokens === null && r.outputTokens === null
        ? "—"
        : `${escapeHtml(String(r.inputTokens ?? 0))} in / ${escapeHtml(String(r.outputTokens ?? 0))} out`;

    return `<tr>
      <td>${outcomeCell}</td>
      <td style="font-size:12px">${startedCell}</td>
      <td class="mono" style="font-size:12px">${durationCell}</td>
      <td class="mono" style="font-size:12px">${tokensCell}</td>
    </tr>`;
  }

  const bodyRows =
    runs.length === 0
      ? `<tr><td colspan="4" class="empty-state">No runs recorded yet.</td></tr>`
      : runs.map(row).join("\n");

  const cronLabel = cron.name ?? cron.schedule;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cron Runs — ${escapeHtml(cronLabel)} — Shipwright Admin</title>
  <style>${baseStyles()}
    .runs-table { width:100%;border-collapse:collapse; }
    .runs-table th { text-align:left;padding:8px 12px;font-size:12px;color:#6b7280;font-weight:600;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:.05em; }
    .runs-table td { padding:8px 12px;border-bottom:1px solid #f3f4f6; }
  </style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <a href="/admin/agents/${escapeHtml(agent.id)}" style="color:#6b7280;font-size:13px;text-decoration:none">← ${escapeHtml(agent.name)}</a>
      <h1 class="page-title" style="margin:0;flex:1">Cron Runs — ${escapeHtml(cronLabel)}</h1>
    </div>
    <div style="margin-top:4px;margin-bottom:16px;font-family:monospace;font-size:11px;color:#9ca3af">${escapeHtml(cron.schedule)}</div>

    <div class="card">
      <table class="runs-table">
        <thead>
          <tr>
            <th>Outcome</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Tokens</th>
          </tr>
        </thead>
        <tbody>
          ${bodyRows}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
}

export function renderProvisionCompletePage(
  userName: string,
  opts: {
    success: boolean;
    agentId?: string;
    error?: string;
    rawToken?: string;
  },
): string {
  const rawTokenHtml = opts.rawToken
    ? `<div class="alert alert-success" style="margin-top:16px">
        <strong>Internal API Key — copy it now, it will not be shown again.</strong><br />
        <code
          id="raw-token"
          class="mono"
          style="display:block;margin-top:8px;font-size:13px;word-break:break-all;padding:8px;background:#f0fdf4;border-radius:4px"
        >${escapeHtml(opts.rawToken)}</code>
        <button
          type="button"
          onclick="navigator.clipboard.writeText(document.getElementById('raw-token').textContent)"
          class="btn btn-secondary"
          style="margin-top:8px;font-size:12px"
        >Copy to clipboard</button>
        <p style="font-size:12px;color:#6b7280;margin-top:8px">
          Store this as <code class="mono">SHIPWRIGHT_AGENT_API_KEY</code> in your agent configuration.
        </p>
      </div>`
    : "";

  const bodyHtml = opts.success
    ? `<div class="alert alert-success">
        <strong>Provisioning complete!</strong> — Slack app credentials and tokens stored.
      </div>
      ${rawTokenHtml}
      <p style="font-size:14px;margin-bottom:16px;margin-top:16px">
        All credentials have been saved to the agent's env vars and system crons have been seeded.
      </p>
      ${opts.agentId ? `<a href="/admin/agents/${escapeHtml(opts.agentId)}" class="btn btn-primary">View Agent →</a>` : ""}
      <a href="/admin/agents" class="btn btn-secondary" style="margin-left:8px">Back to Agents</a>`
    : `<div class="alert alert-error">${escapeHtml(opts.error ?? "Provisioning failed.")}</div>
      <a href="/admin/provision" class="btn btn-secondary">Try again</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Provisioning Complete — Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName, "/admin/provision")}
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
  </div>
</body>
</html>`;
}

// ─── Task-store tokens page ────────────────────────────────────────────────────

export function renderTokensPage(
  tokens: TaskStoreTokenItem[],
  degraded: boolean,
  userName: string,
  activePath = "/admin/tokens",
  rawToken?: string,
  timezone?: string,
  error?: string,
  agents?: Array<{ id: string; name: string }>,
  selectedAgentId?: string,
  taskStoreBaseUrl?: string,
): string {
  const tz = timezone ?? "America/Los_Angeles";
  const fmt = (d: Date | string | null | undefined) => {
    if (!d) return "—";
    const date = d instanceof Date ? d : new Date(d);
    return date.toLocaleString("en-US", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    });
  };

  const degradedBanner = degraded
    ? `<div class="alert alert-warning">Token store unavailable — configure SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN.</div>`
    : "";

  const errorBanner = error
    ? `<div class="alert alert-danger" style="margin-bottom:16px">${escapeHtml(error)}</div>`
    : "";

  const envBlock =
    rawToken && taskStoreBaseUrl
      ? `<pre style="background:#f3f4f6;border-radius:4px;padding:12px;margin-top:12px;font-size:12px;font-family:monospace;overflow-x:auto">export SHIPWRIGHT_TASK_STORE_URL=${escapeHtml(taskStoreBaseUrl)}
export SHIPWRIGHT_TASK_STORE_TOKEN=${escapeHtml(rawToken)}</pre>`
      : "";

  const rawTokenBanner = rawToken
    ? `<div class="alert alert-success" style="margin-bottom:16px">
        <strong>Token created.</strong> Copy it now — it will not be shown again.<br>
        <code id="raw-token" style="display:block;margin-top:8px;font-size:13px;word-break:break-all">${escapeHtml(rawToken)}</code>
        <button type="button" class="btn btn-sm btn-secondary" style="margin-top:8px"
          onclick="navigator.clipboard.writeText(document.getElementById('raw-token').textContent)">
          Copy
        </button>
        ${envBlock}
      </div>`
    : "";

  const rows =
    tokens.length === 0
      ? `<tr><td colspan="6" class="empty-state">No tokens found.</td></tr>`
      : tokens
          .map(
            (t) => `<tr>
          <td style="font-size:12px;color:#6b7280;font-family:monospace">${escapeHtml(t.id)}</td>
          <td>${escapeHtml(t.label ?? "—")}</td>
          <td style="font-size:12px;color:#6b7280;font-family:monospace">${escapeHtml(t.agentId ?? "(admin)")}</td>
          <td>${fmt(t.createdAt)}</td>
          <td>${t.revokedAt ? `<span style="color:#dc2626">Revoked ${fmt(t.revokedAt)}</span>` : '<span style="color:#16a34a">Active</span>'}</td>
          <td>
            ${
              t.revokedAt
                ? ""
                : `<form method="POST" action="/admin/tokens/${encodeURIComponent(t.id)}/revoke" style="margin:0" onsubmit="return confirm('Revoke this token?')">
                    <button type="submit" class="btn btn-sm btn-danger">Revoke</button>
                  </form>`
            }
          </td>
        </tr>`,
          )
          .join("");

  const agentOptions = [
    `<option value="">— admin token —</option>`,
    ...(agents ?? []).map(
      (a) =>
        `<option value="${escapeHtml(a.id)}"${a.id === selectedAgentId ? " selected" : ""}>${escapeHtml(a.name)}</option>`,
    ),
  ].join("");

  const createForm = !degraded
    ? `<div class="card" style="margin-top:24px">
        <h2 style="font-size:15px;font-weight:600;margin-bottom:12px">Create token</h2>
        <form method="POST" action="/admin/tokens" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div>
            <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px">Label <span style="color:#dc2626">*</span></label>
            <input type="text" name="label" placeholder="e.g. ci-pipeline" class="form-input" style="width:220px" required>
          </div>
          <div>
            <label style="display:block;font-size:12px;color:#6b7280;margin-bottom:4px">Agent (optional — blank for admin token)</label>
            <select name="agentId" class="form-input" style="width:220px">${agentOptions}</select>
          </div>
          <button type="submit" class="btn btn-primary">Create</button>
        </form>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Task Store Tokens — Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName, activePath)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Task Store Tokens</h1>
    </div>
    ${degradedBanner}
    ${errorBanner}
    ${rawTokenBanner}
    <div class="card" style="overflow:auto">
      <table class="data-table" style="width:100%">
        <thead>
          <tr>
            <th>ID</th>
            <th>Label</th>
            <th>Agent</th>
            <th>Created</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${createForm}
  </div>
</body>
</html>`;
}

// ─── Chat page ─────────────────────────────────────────────────────────────────

export interface AgentOption {
  id: string;
  name: string;
}

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
    @media (max-width:640px) {
      .chat-list-layout { flex-direction:column }
      .chat-list-sidebar { width:100%;max-width:100%;min-width:0 }
      /* chat-thread-layout: flex wrapper for thread+message area; stacks to column on mobile */
      .chat-thread-layout { flex-direction:column }
      .chat-thread-sidebar { display:none }
      .chat-bubble-inner { max-width:90% !important }
      #message-input { font-size:16px }
    }`;

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Chat — Shipwright Admin</title>
  <style>${baseStyles()}${threadPaneStyles}${chatPageStyles}
  </style>
</head>
<body>
  ${renderAdminToolbar(userName, activePath)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Chat</h1>
    </div>
    ${agentSelector}
    ${content}
  </div>
</body>
</html>`;
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
): string {
  // Support both 4-arg (threads omitted) and 5-arg call signatures
  const threads: ChatThread[] | null =
    typeof threadsOrUserName === "string" ? null : threadsOrUserName;
  const userName: string =
    typeof threadsOrUserName === "string"
      ? threadsOrUserName
      : (userNameArg ?? "");
  const activePath = "/admin/chat";

  if (thread === null || messages === null) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Thread - Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName, activePath)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Thread</h1>
    </div>
    <div class="alert alert-error">
      Chat service not configured. Set <code>SHIPWRIGHT_CHAT_SERVICE_URL</code> and
      <code>SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN</code> to enable this feature.
    </div>
  </div>
</body>
</html>`;
  }

  const threadId = thread.id;
  const title = thread.title ? escapeHtml(thread.title) : "Untitled Thread";

  function renderMessageBubble(m: ChatMessage): string {
    const isUser = m.role === "user";
    const isAssistant = m.role === "assistant";
    const isSystem = m.role === "system";

    const align = isUser ? "flex-end" : isSystem ? "center" : "flex-start";
    const bubbleBg = isUser
      ? "#eef2ff"
      : isAssistant
        ? "#f0fdf4"
        : isSystem
          ? "#fef9c3"
          : "#f3f4f6";
    const bubbleColor = isUser
      ? "#4f46e5"
      : isAssistant
        ? "#166534"
        : isSystem
          ? "#854d0e"
          : "#374151";
    const maxWidth = isSystem ? "80%" : "70%";

    // Render error badge if errorKind is set
    let errorBadge = "";
    if (m.errorKind) {
      const errorLabel =
        m.errorKind === "rate-limited"
          ? "Rate limited"
          : m.errorKind === "upstream"
            ? "Request failed"
            : m.errorKind === "timeout"
              ? "Timed out"
              : "Error";
      errorBadge = `<div style="margin-top:6px;padding:4px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:12px;font-weight:600">${errorLabel}</div>`;
    }

    // Render body: assistant messages get markdown, others get escaped text
    const bodyHtml = isAssistant
      ? `<div style="font-size:14px;line-height:1.6;color:${bubbleColor}">${renderMarkdown(m.body)}</div>`
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
      const costPart = m.costUsd !== null
        ? ` · $${m.costUsd.toFixed(4)}`
        : "";
      tokenBadge = `<div style="font-size:11px;color:#6b7280;margin-top:4px">${escapeHtml(`${inTok} in / ${outTok} out${costPart}`)}</div>`;
    }

    return `<div style="display:flex;justify-content:${align};margin-bottom:12px">
      <div class="chat-bubble-inner" style="max-width:${maxWidth};background:${bubbleBg};border-radius:12px;padding:12px 16px;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
        <div style="font-size:11px;font-weight:600;color:${bubbleColor};margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(m.role)}</div>
        ${bodyHtml}
        ${attachmentBadge}
        ${errorBadge}
        ${tokenBadge}
        <div style="font-size:11px;color:#9ca3af;margin-top:6px">${escapeHtml(new Date(m.createdAt).toLocaleString())}</div>
      </div>
    </div>`;
  }

  const messageBubbles = messages.map(renderMessageBubble).join("\n");

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

  // Inline JS for the send/poll flow
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

  var pollTimer = null;
  var pollCount = 0;
  var MAX_POLLS = 30; // 90 seconds at 3s intervals
  var lastUserMessageTime = null;

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function simpleMarkdown(text) {
    var escaped = escHtml(text);
    // Bold: **text**
    escaped = escaped.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    // Inline code: \`code\`
    escaped = escaped.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    return escaped;
  }

  function addBubble(role, body, isError, attachmentName) {
    var isUser = role === 'user';
    var align = isUser ? 'flex-end' : 'flex-start';
    var bg = isUser ? '#eef2ff' : '#f0fdf4';
    var color = isUser ? '#4f46e5' : '#166534';
    var bodyHtml = isUser
      ? '<div style="font-size:14px;white-space:pre-wrap;color:' + color + '">' + escHtml(body) + '</div>'
      : '<div style="font-size:14px;line-height:1.6;color:' + color + '">' + simpleMarkdown(body) + '</div>';
    var errorHtml = isError
      ? '<div style="margin-top:6px;padding:4px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:12px;font-weight:600">' + escHtml(body) + '</div>'
      : '';
    var attachmentHtml = attachmentName
      ? '<div style="display:inline-block;margin-top:8px;padding:3px 8px;background:#e5e7eb;color:#374151;border-radius:6px;font-size:12px">📎 ' + escHtml(attachmentName) + '</div>'
      : '';
    var bubble = document.createElement('div');
    bubble.style.cssText = 'display:flex;justify-content:' + align + ';margin-bottom:12px';
    bubble.innerHTML = '<div style="max-width:70%;background:' + bg + ';border-radius:12px;padding:12px 16px;box-shadow:0 1px 2px rgba(0,0,0,0.06)">'
      + '<div style="font-size:11px;font-weight:600;color:' + color + ';margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">' + escHtml(role) + '</div>'
      + (isError ? errorHtml : bodyHtml)
      + attachmentHtml
      + '</div>';
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
  }

  function addThinkingIndicator() {
    var div = document.createElement('div');
    div.id = 'thinking-indicator';
    div.style.cssText = 'display:flex;justify-content:flex-start;margin-bottom:12px';
    div.innerHTML = '<div style="max-width:70%;background:#f0fdf4;border-radius:12px;padding:12px 16px;box-shadow:0 1px 2px rgba(0,0,0,0.06)">'
      + '<div style="font-size:14px;color:#166534;font-style:italic">thinking…</div>'
      + '</div>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function removeThinkingIndicator() {
    var el = document.getElementById('thinking-indicator');
    if (el) el.parentNode.removeChild(el);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    pollCount = 0;
  }

  function enableSend() {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }

  function poll() {
    pollCount++;
    if (pollCount > MAX_POLLS) {
      stopPolling();
      removeThinkingIndicator();
      addBubble('assistant', 'Request timed out. Please try again.', true);
      enableSend();
      return;
    }
    fetch(messagesJsonUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var msgs = data.messages || [];
        var cutoff = lastUserMessageTime;
        var replies = msgs.filter(function(m) {
          return m.role === 'assistant' && new Date(m.createdAt) > cutoff;
        });
        if (replies.length > 0) {
          stopPolling();
          removeThinkingIndicator();
          var reply = replies[replies.length - 1];
          if (reply.errorKind) {
            var label = reply.errorKind === 'rate-limited' ? 'Rate limited'
              : reply.errorKind === 'upstream' ? 'Request failed'
              : reply.errorKind === 'timeout' ? 'Timed out'
              : 'Error';
            addBubble('assistant', label, true);
          } else {
            addBubble('assistant', reply.body, false);
          }
          enableSend();
        }
      })
      .catch(function() {
        // network error — keep polling
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

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var text = input.value.trim();
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!text && !file) return;

    // Disable send button
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';

    // Record the time before sending so we can filter replies
    lastUserMessageTime = new Date();

    // Build multipart body before clearing the inputs
    var fd = new FormData();
    fd.append('body', text);
    if (file) fd.append('file', file);
    var attachmentName = file ? file.name : null;

    // Clear inputs
    input.value = '';

    // Add user bubble optimistically (with attachment badge if present)
    addBubble('user', text, false, attachmentName);
    clearFile();

    // Show thinking indicator
    addThinkingIndicator();

    // POST multipart to the upload endpoint
    fetch(uploadUrl, {
      method: 'POST',
      body: fd
    }).then(function(r) {
      if (!r.ok) {
        return r.json().then(function(data) {
          stopPolling();
          removeThinkingIndicator();
          addBubble('assistant', (data && data.error) || 'Upload failed.', true);
          enableSend();
        });
      }
    }).catch(function() {
      // POST failed — still start polling for a reply
    });

    // Start polling every 3 seconds
    pollCount = 0;
    pollTimer = setInterval(poll, 3000);
  });

  // Scroll to bottom on load
  container.scrollTop = container.scrollHeight;
})();
</script>`;

  // Thread list sidebar pane
  const newThreadForm = `
    <form method="POST" action="/admin/chat/${escapeHtml(agentId)}/threads" style="margin-bottom:12px">
      <div class="form-row" style="gap:6px">
        <input type="text" name="title" class="form-input" placeholder="New thread title…" style="font-size:12px">
        <button type="submit" class="btn btn-primary" style="white-space:nowrap;font-size:12px;padding:6px 10px">New Thread</button>
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
      ? `<div class="card chat-thread-sidebar" style="min-width:220px;max-width:280px;flex-shrink:0">
          <div class="card-title">Threads</div>
          ${newThreadForm}
          <div class="thread-pane-list">
            ${threadLinks}
          </div>
        </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} - Shipwright Admin</title>
  <style>${baseStyles()}${threadPaneStyles}${chatPageStyles}
  </style>
</head>
<body>
  ${renderAdminToolbar(userName, activePath)}
  <div class="vos-page" style="display:flex;flex-direction:column;height:calc(100vh - 52px);max-width:900px;margin:0 auto;padding:0 24px">
    <div class="page-header" style="padding-top:20px;padding-bottom:16px;flex-shrink:0">
      <div>
        <a href="/admin/chat?agentId=${safeAgentId}" class="btn btn-secondary" style="margin-bottom:8px">&larr; Back to threads</a>
        <h1 class="page-title">${title}</h1>
        <div style="font-size:12px;color:#9ca3af;margin-top:4px">Thread <span class="mono">${safeThreadId}</span></div>
        ${
          stats && (stats.totalInputTokens > 0 || stats.totalOutputTokens > 0 || stats.totalCostUsd > 0)
            ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">${escapeHtml(`${formatTokenCount(stats.totalInputTokens)} in / ${formatTokenCount(stats.totalOutputTokens)} out | $${stats.totalCostUsd.toFixed(4)}`)}</div>`
            : ""
        }
        ${renameForm}
        ${deleteForm}
      </div>
    </div>
    <div class="chat-thread-layout" style="display:flex;gap:24px;flex:1;min-height:0;margin-top:16px">
      ${sidebar}
      <div style="flex:1;min-width:0;display:flex;flex-direction:column">
        <!-- Messages area (scrollable) -->
        <div id="messages-container" style="flex:1;overflow-y:auto;padding:8px 0;min-height:0">
          ${messageBubbles}
          ${emptyState}
        </div>

        <!-- Send form -->
        <form id="send-form" enctype="multipart/form-data" style="flex-shrink:0;padding:16px 0;border-top:1px solid #e5e7eb;margin-top:8px">
          <div style="display:flex;gap:8px;align-items:flex-end">
            <textarea
              id="message-input"
              name="body"
              rows="3"
              placeholder="Type a message..."
              style="flex:1;resize:vertical;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit;line-height:1.5;outline:none"
            ></textarea>
            <input type="file" id="file-input" name="file" style="display:none" accept="text/*,image/*,application/pdf,application/json">
            <button
              type="button"
              id="attach-btn"
              class="btn btn-secondary"
              style="flex-shrink:0;height:44px;padding:0 16px"
            >Attach file</button>
            <button
              type="submit"
              id="send-btn"
              class="btn btn-primary"
              style="flex-shrink:0;height:44px;padding:0 20px"
            >Send</button>
          </div>
          <div id="file-name" style="font-size:12px;color:#6b7280;margin-top:6px;min-height:16px"></div>
        </form>
      </div>
    </div>
  </div>
  ${inlineScript}
</body>
</html>`;
}
