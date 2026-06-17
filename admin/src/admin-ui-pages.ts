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
  preCheck?: string | null;
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
    return `<tr>
      <td class="mono">${escapeHtml(c.schedule)}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.name ? `${c.name}: ${c.prompt}` : c.prompt)}</td>
      <td class="mono" style="font-size:11px;color:#6b7280;max-width:170px;overflow:hidden;text-overflow:ellipsis">${c.preCheck ? escapeHtml(c.preCheck) : "—"}</td>
      <td>${c.channel ? escapeHtml(c.channel) : c.user ? escapeHtml(c.user) : "—"}</td>
      <td><span class="badge ${c.enabled ? "badge-green" : "badge-gray"}">${c.enabled ? "enabled" : "disabled"}</span></td>
      <td style="white-space:nowrap">${actions}${editForm}</td>
    </tr>`;
  }

  const systemCronRows =
    systemCrons.length === 0
      ? `<tr><td colspan="6" class="empty-state">No system crons configured.</td></tr>`
      : systemCrons.map(renderCronRow).join("\n");

  const customCronRows =
    customCrons.length === 0
      ? `<tr><td colspan="6" class="empty-state">No custom crons yet.</td></tr>`
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
              <th>Pre-check</th>
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
              <th>Pre-check</th>
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

export function renderProvisionCompletePage(
  userName: string,
  opts: { success: boolean; agentId?: string; error?: string; rawToken?: string },
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
