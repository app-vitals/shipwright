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

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Login page ───────────────────────────────────────────────────────────────

export function renderLoginPage(opts?: {
  error?: string;
  returnTo?: string;
}): string {
  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const googleHref =
    opts?.returnTo
      ? `/auth/google?returnTo=${encodeURIComponent(opts.returnTo)}`
      : "/auth/google";

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
): string {
  const rows =
    agents.length === 0
      ? `<tr><td colspan="4" class="empty-state">No agents yet. <a href="/admin/provision">Provision one →</a></td></tr>`
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agents — Shipwright Admin</title>
  <style>${baseStyles()}</style>
</head>
<body>
  ${renderAdminToolbar(userName)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Agents</h1>
      <a href="/admin/provision" class="btn btn-primary">+ Provision agent</a>
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
  userName: string,
  opts?: { error?: string; newToken?: string },
): string {

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
    return `<tr>
      <td class="mono">${escapeHtml(c.schedule)}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.name ? `${c.name}: ${c.prompt}` : c.prompt)}</td>
      <td>${c.channel ? escapeHtml(c.channel) : c.user ? escapeHtml(c.user) : "—"}</td>
      <td><span class="badge ${c.enabled ? "badge-green" : "badge-gray"}">${c.enabled ? "enabled" : "disabled"}</span></td>
      <td style="white-space:nowrap">${actions}</td>
    </tr>`;
  }

  const systemCronRows =
    systemCrons.length === 0
      ? `<tr><td colspan="5" class="empty-state">No system crons configured.</td></tr>`
      : systemCrons.map(renderCronRow).join("\n");

  const customCronRows =
    customCrons.length === 0
      ? `<tr><td colspan="5" class="empty-state">No custom crons yet.</td></tr>`
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

  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
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
  ${renderAdminToolbar(userName)}
  <div class="vos-page">
    <div class="page-header">
      <div>
        <a href="/admin/agents" style="font-size:13px;color:#6b7280;text-decoration:none">← Agents</a>
        <h1 class="page-title" style="margin-top:4px">${escapeHtml(agent.name)}</h1>
        ${agent.slackId ? `<span style="font-size:13px;color:#6b7280">Slack ID: <span class="mono">${escapeHtml(agent.slackId)}</span></span>` : ""}
      </div>
    </div>
    ${errorHtml}
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
              <th>Target</th>
              <th>Status</th>
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
              <th>Target</th>
              <th>Status</th>
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

  </div>
</body>
</html>`;
}

// ─── Provision pages ──────────────────────────────────────────────────────────

export function renderProvisionStartPage(
  userName: string,
  opts?: { oauthUrl?: string; error?: string },
): string {
  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const safeOauthUrl = opts?.oauthUrl?.startsWith("https://")
    ? opts.oauthUrl
    : "";
  const oauthSection = opts?.oauthUrl
    ? `<div class="alert alert-success">
        <strong>App created!</strong> Click the link below to authorize the Slack app.
      </div>
      <div class="oauth-url-box">${escapeHtml(opts.oauthUrl)}</div>
      <a href="${escapeHtml(safeOauthUrl)}" class="btn btn-primary" target="_blank" rel="noopener noreferrer">
        Authorize Slack App →
      </a>
      <p style="margin-top:16px;font-size:13px;color:#6b7280">
        After authorizing, paste the app-level token in the next step.
      </p>`
    : `<form method="POST" action="/admin/provision/start">
        <div class="form-group">
          <label class="form-label" for="xoxpToken">Slack User OAuth Token (xoxp-)</label>
          <input
            id="xoxpToken"
            name="xoxpToken"
            type="password"
            class="form-input"
            placeholder="xoxp-..."
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
  ${renderAdminToolbar(userName)}
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
  ${renderAdminToolbar(userName)}
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

export function renderProvisionCompletePage(
  userName: string,
  opts: { success: boolean; agentId?: string; error?: string },
): string {
  const bodyHtml = opts.success
    ? `<div class="alert alert-success">
        <strong>success</strong> — Slack app provisioned and credentials stored.
      </div>
      <p style="font-size:14px;margin-bottom:16px">
        The <code class="mono">SLACK_APP_ID</code> and <code class="mono">SLACK_SIGNING_SECRET</code>
        have been saved to the agent's env vars.
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
  ${renderAdminToolbar(userName)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step">2. Authorize</span>
      <span class="provision-step active">3. Complete</span>
    </div>
    <div class="card">
      ${bodyHtml}
    </div>
  </div>
</body>
</html>`;
}
