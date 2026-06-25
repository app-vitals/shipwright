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
  reviewedAt?: string | null;
  patchedAt?: string | null;
}

export interface AgentListItem {
  id: string;
  name: string;
  slackId: string | null;
  createdAt: Date;
}

export interface AgentDetail {
  id: string;
  name: string;
  slackId: string | null;
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
): string {
  const rows =
    agents.length === 0
      ? `<tr><td colspan="4" class="empty-state">${isAdmin ? 'No agents yet. <a href="/admin/provision">Provision one →</a>' : "No agents."}</td></tr>`
      : agents
          .map(
            (a) => `<tr>
    <td><a href="/admin/agents/${escapeHtml(a.id)}" class="agent-link">${escapeHtml(a.name)}</a></td>
    <td class="mono">${a.slackId ? escapeHtml(a.slackId) : '<span style="color:#9ca3af">—</span>'}</td>
    <td>${escapeHtml(a.createdAt.toISOString().split("T")[0])}</td>
    <td><a href="/admin/agents/${escapeHtml(a.id)}" class="btn btn-secondary" style="font-size:12px;padding:4px 10px">Manage</a></td>
  </tr>`,
          )
          .join("\n");

  const provisionButton = isAdmin
    ? `<a href="/admin/provision" class="btn btn-primary">+ Provision agent</a>`
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

// ─── Agent detail page ────────────────────────────────────────────────────────

export function renderAgentDetailPage(
  agent: AgentDetail,
  envVars: Record<string, string>,
  crons: CronJobItem[],
  tools: ToolItem[],
  tokens: TokenItem[],
  plugins: PluginItem[],
  members: MemberItem[],
  userName: string,
  isAdmin: boolean,
  opts?: { error?: string; newToken?: string; successMsg?: string; now?: Date },
): string {
  // Reference time for relative timestamps — injected by tests for determinism,
  // defaults to wall clock in production.
  const now = opts?.now ?? new Date();
  const envRows =
    Object.keys(envVars).length === 0
      ? `<tr><td colspan="3" class="empty-state">No env vars set.</td></tr>`
      : Object.entries(envVars)
          .map(
            ([k]) => `<tr>
      <td class="mono">${escapeHtml(k)}</td>
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
    const outcomeStyle: Record<string, string> = {
      posted: "background:#22c55e;color:white",
      dm: "background:#3b82f6;color:white",
      silent: "background:#9ca3af;color:white",
      skipped: "background:#f59e0b;color:white",
      error: "background:#ef4444;color:white",
    };

    const lastRunHtml = c.lastRun?.startedAt
      ? `
      <div style="font-size:11px;color:#6b7280;margin-bottom:4px">${relativeTime(c.lastRun.startedAt, now)}</div>
      <div>
        <span class="badge" style="${outcomeStyle[c.lastRun.outcome ?? ""] ?? "background:#9ca3af;color:white"}">${escapeHtml(c.lastRun.outcome || "unknown")}</span>
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
      <td>${escapeHtml(t.createdAt.toISOString().split("T")[0])}</td>
      <td>${t.revokedAt ? `<span class="badge badge-gray">Revoked ${escapeHtml(t.revokedAt.toISOString().split("T")[0])}</span>` : '<span class="badge badge-green">Active</span>'}</td>
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
      <td>${escapeHtml(m.createdAt.toISOString().split("T")[0])}</td>
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
      <div>
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
      </div>
    </div>
    ${errorHtml}
    ${successHtml}
    ${newTokenHtml}

    <!-- Env Vars -->
    <div class="card">
      <div class="card-title">Env Vars</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/envs" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group">
            <input name="key" type="text" class="form-input" placeholder="KEY" required />
          </div>
          <div class="form-group">
            <input name="value" type="text" class="form-input" placeholder="value" required />
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
    </div>

    <!-- Repos -->
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

    <!-- Cron Jobs -->
    <div class="card">
      <div class="card-title">Cron Jobs</div>

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

    <!-- Tools -->
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

    <!-- Tokens -->
    <div class="card">
      <div class="card-title">Tokens</div>
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

    <!-- Plugins -->
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
      ? `<tr><td colspan="7" class="empty-state">No tasks found.</td></tr>`
      : tasks
          .map((t) => {
            const agentId = t.claimedBy ?? t.assignee;
            const agentCell = agentId
              ? escapeHtml(agentNames[agentId] ?? agentId)
              : '<span style="color:#9ca3af">—</span>';
            const blockerBadges = renderBlockerBadges(t.blockedBy);
            return `<tr data-href="/admin/tasks/${escapeHtml(t.id)}" style="cursor:pointer">
    <td class="mono" style="font-size:11px"><a href="/admin/tasks/${escapeHtml(t.id)}" style="color:#6366f1;text-decoration:none" title="View details">${escapeHtml(t.id)}</a></td>
    <td><a href="/admin/tasks/${escapeHtml(t.id)}" style="color:inherit;text-decoration:none">${escapeHtml(t.title)}</a>${blockerBadges}</td>
    <td><span class="badge ${statusBadgeClass(t.status)}">${escapeHtml(t.status)}</span></td>
    <td style="font-size:12px">${agentCell}</td>
    <td class="mono" style="font-size:11px">${t.session ? escapeHtml(t.session) : '<span style="color:#9ca3af">—</span>'}</td>
    <td class="mono" style="font-size:11px">${t.repo ? escapeHtml(t.repo) : '<span style="color:#9ca3af">—</span>'}</td>
    <td>${
      t.status === "in_progress"
        ? `<form method="POST" action="/admin/tasks/${escapeHtml(t.id)}/release" style="display:inline">
        <button type="submit" class="btn btn-secondary" style="font-size:11px;padding:3px 8px">Release</button>
      </form>`
        : ""
    }</td>
  </tr>`;
          })
          .join("\n");

  // State toggle params (preserve other filters, reset page)
  const makeStateParams = (newState: string) => {
    const p = new URLSearchParams();
    if (newState !== "ready") p.set("state", newState);
    if (filters.session) p.set("session", filters.session);
    if (filters.repo) p.set("repo", filters.repo);
    if (filters.agent) p.set("agent", filters.agent);
    const qs = p.toString();
    return qs ? `?${qs}` : "";
  };

  const activeState = filters.state ?? "ready";
  const tabStyle = (state: string) =>
    activeState === state
      ? "background:#6366f1;color:#fff;font-weight:600"
      : "background:#fff;color:#374151";
  const stateToggle = `
    <div style="display:flex;gap:0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;width:fit-content">
      <a href="/admin/tasks${makeStateParams("ready")}"
         style="padding:5px 14px;font-size:12px;text-decoration:none;${tabStyle("ready")}">Ready</a>
      <a href="/admin/tasks${makeStateParams("in_progress")}"
         style="padding:5px 14px;font-size:12px;text-decoration:none;border-left:1px solid #e5e7eb;${tabStyle("in_progress")}">In Progress</a>
      <a href="/admin/tasks${makeStateParams("blocked")}"
         style="padding:5px 14px;font-size:12px;text-decoration:none;border-left:1px solid #e5e7eb;${tabStyle("blocked")}">Blocked</a>
      <a href="/admin/tasks${makeStateParams("closed")}"
         style="padding:5px 14px;font-size:12px;text-decoration:none;border-left:1px solid #e5e7eb;${tabStyle("closed")}">Closed</a>
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
    else if (filters.state && filters.state !== "ready")
      params.set("state", filters.state);
    if (filters.session) params.set("session", filters.session);
    if (filters.repo) params.set("repo", filters.repo);
    if (filters.agent) params.set("agent", filters.agent);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return `/admin/tasks${qs ? `?${qs}` : ""}`;
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
  <title>Tasks — Shipwright Admin</title>
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
  ${renderAdminToolbar(userName, "/admin/tasks")}
  <div class="vos-page">
    <div class="page-header" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <h1 class="page-title" style="margin:0">Tasks</h1>
      ${stateToggle}
    </div>
    ${errorHtml}
    ${degradedHtml}
    ${agentFilterHtml}
    <div class="card" style="margin-bottom:16px">
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
        ${suggestions?.sessions?.length ? `<datalist id="sessions-list">${suggestions.sessions.map((s) => `<option value="${escapeHtml(s)}">`).join("")}</datalist>` : ""}
        ${suggestions?.repos?.length ? `<datalist id="repos-list">${suggestions.repos.map((r) => `<option value="${escapeHtml(r)}">`).join("")}</datalist>` : ""}
        ${suggestions?.agents?.length ? `<datalist id="agents-list">${suggestions.agents.map((a) => `<option value="${escapeHtml(a)}">`).join("")}</datalist>` : ""}
      </form>
    </div>
    <div class="card">
      <table class="data-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Title</th>
            <th>Status</th>
            <th>Assignee</th>
            <th>Session</th>
            <th>Repo</th>
            <th></th>
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

// ─── Task detail page ────────────────────────────────────────────────────────

export function renderTaskDetailPage(
  task: TaskItem,
  userName: string,
  agentNames: Record<string, string> = {},
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
      : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top">${escapeHtml(label)}</td>
      <td style="padding:8px 12px;font-size:13px" title="${escapeHtml(iso)}">${escapeHtml(fmt)}</td>
    </tr>`;
  }

  const prSection = pullRequest
    ? (() => {
        const prUrl = `https://github.com/${pullRequest.repo}/pull/${pullRequest.prNumber}`;
        const reviewedFmt = pullRequest.reviewedAt ? dateField("Reviewed", pullRequest.reviewedAt) : "";
        const patchedFmt = pullRequest.patchedAt ? dateField("Patched", pullRequest.patchedAt) : "";
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

    ${descriptionSection}
    ${acSection}
    ${blockersSection}

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
