/**
 * agent/src/admin-ui-templates.ts
 * Pure HTML rendering functions for the Admin UI.
 * No external dependencies — vanilla HTML/CSS only.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentSummary {
  id: string;
  name: string;
  slackId: string | null;
  createdAt: Date;
  envCount: number;
  cronCount: number;
  toolCount: number;
  tokenCount: number;
  pluginCount: number;
}

export interface AgentCronSummary {
  id: string;
  schedule: string;
  prompt: string;
  channel: string | null;
  user: string | null;
  enabled: boolean;
  name: string | null;
}

export interface AgentToolSummary {
  id: string;
  pattern: string;
  enabled: boolean;
}

export interface AgentTokenSummary {
  id: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AgentPluginSummary {
  id: string;
  name: string;
  version: string | null;
  enabled: boolean;
}

export interface AgentDetail {
  id: string;
  name: string;
  slackId: string | null;
  createdAt: Date;
  updatedAt: Date;
  envVars: Record<string, string>;
  crons: AgentCronSummary[];
  tools: AgentToolSummary[];
  tokens: AgentTokenSummary[];
  plugins: AgentPluginSummary[];
}

// ─── HTML escaping ────────────────────────────────────────────────────────────

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Shared layout ────────────────────────────────────────────────────────────

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — Shipwright Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f5; color: #333; }
    .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
    header { background: #1a1a2e; color: #fff; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; }
    header a { color: #eee; text-decoration: none; font-weight: 600; font-size: 1.1rem; }
    header nav a { color: #ccc; font-size: 0.9rem; margin-left: 16px; }
    header nav a:hover { color: #fff; }
    h1 { font-size: 1.5rem; margin-bottom: 20px; }
    h2 { font-size: 1.1rem; margin-bottom: 12px; color: #444; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
    .card { background: #fff; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 20px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eee; }
    th { color: #666; font-weight: 600; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; }
    tr:last-child td { border-bottom: none; }
    a { color: #0066cc; }
    .badge { display: inline-block; background: #e8f4fd; color: #0066cc; border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; }
    .badge.disabled { background: #f0f0f0; color: #999; }
    .badge.revoked { background: #fff0f0; color: #cc3300; }
    .btn { display: inline-block; padding: 6px 14px; border-radius: 4px; font-size: 0.85rem; cursor: pointer; border: 1px solid #ccc; background: #fff; color: #333; text-decoration: none; }
    .btn:hover { background: #f5f5f5; }
    .btn-primary { background: #0066cc; color: #fff; border-color: #0066cc; }
    .btn-primary:hover { background: #0052a3; }
    .btn-danger { background: #dc3545; color: #fff; border-color: #dc3545; }
    .btn-danger:hover { background: #b02a37; }
    .btn-sm { padding: 3px 8px; font-size: 0.8rem; }
    .form-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input[type="text"], input[type="password"] { border: 1px solid #ccc; border-radius: 4px; padding: 6px 10px; font-size: 0.9rem; width: 100%; }
    .login-box { max-width: 360px; margin: 80px auto; }
    .login-box h1 { text-align: center; margin-bottom: 24px; }
    .error-msg { background: #fff0f0; color: #cc0000; border: 1px solid #ffcccc; border-radius: 4px; padding: 10px 14px; margin-bottom: 16px; font-size: 0.9rem; }
    label { font-size: 0.85rem; font-weight: 600; color: #555; display: block; margin-bottom: 4px; }
    .form-group { margin-bottom: 16px; }
    .empty { color: #999; font-style: italic; font-size: 0.9rem; }
    .meta { color: #666; font-size: 0.8rem; }
    code { font-family: monospace; background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
    .slack-connect-form { margin-top: 12px; padding-top: 12px; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <header>
    <a href="/admin/agents">Shipwright Admin</a>
    <nav>
      <a href="/admin/agents">Agents</a>
      <form method="POST" action="/admin/logout" style="display:inline">
        <button type="submit" style="background:none;border:none;color:#ccc;cursor:pointer;font-size:0.9rem;margin-left:16px;">Logout</button>
      </form>
    </nav>
  </header>
  <div class="container">
    ${body}
  </div>
</body>
</html>`;
}

// ─── Login page ───────────────────────────────────────────────────────────────

export function renderLoginPage(opts?: { error?: string }): string {
  const errorHtml = opts?.error
    ? `<div class="error-msg">${esc(opts.error)}</div>`
    : "";

  const body = `
<div class="login-box">
  <h1>Shipwright Admin</h1>
  <div class="card">
    ${errorHtml}
    <form method="POST" action="/admin/login">
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%">Sign In</button>
    </form>
  </div>
</div>`;

  return layout("Login", body);
}

// ─── Agents list page ─────────────────────────────────────────────────────────

export function renderAgentsPage(agents: AgentSummary[]): string {
  const rows =
    agents.length === 0
      ? `<tr><td colspan="7" class="empty" style="padding:20px;text-align:center">No agents found.</td></tr>`
      : agents
          .map(
            (a) => `
    <tr>
      <td><a href="/admin/agents/${esc(a.id)}">${esc(a.name)}</a></td>
      <td><code>${esc(a.id)}</code></td>
      <td>${a.slackId ? `<code>${esc(a.slackId)}</code>` : '<span class="meta">—</span>'}</td>
      <td class="meta">${a.envCount}</td>
      <td class="meta">${a.cronCount}</td>
      <td class="meta">${a.pluginCount}</td>
      <td><a href="/admin/agents/${esc(a.id)}" class="btn btn-sm">View</a></td>
    </tr>`,
          )
          .join("");

  const body = `
<h1>Agents</h1>
<div class="card">
  <table>
    <thead>
      <tr>
        <th>Name</th><th>ID</th><th>Slack ID</th><th>Envs</th><th>Crons</th><th>Plugins</th><th></th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;

  return layout("Agents", body);
}

// ─── Agent detail page ────────────────────────────────────────────────────────

export function renderAgentDetailPage(agent: AgentDetail): string {
  // Env vars section
  const envRows =
    Object.entries(agent.envVars).length === 0
      ? `<p class="empty">No env vars set.</p>`
      : `<table>
      <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
      <tbody>
        ${Object.entries(agent.envVars)
          .map(
            ([k, v]) => `
        <tr>
          <td><code>${esc(k)}</code></td>
          <td><code>${esc(v)}</code></td>
          <td>
            <form method="POST" action="/admin/agents/${esc(agent.id)}/envs/delete" style="display:inline">
              <input type="hidden" name="key" value="${esc(k)}">
              <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Delete ${esc(k)}?')">Delete</button>
            </form>
          </td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  const envSection = `
<div class="card">
  <h2>Environment Variables</h2>
  ${envRows}
  <div class="slack-connect-form">
    <form method="POST" action="/admin/agents/${esc(agent.id)}/envs">
      <div class="form-row">
        <input type="text" name="key" placeholder="KEY" style="width:180px" required>
        <input type="text" name="value" placeholder="value" style="flex:1" required>
        <button type="submit" class="btn btn-primary btn-sm">Add / Update</button>
      </div>
    </form>
  </div>
</div>`;

  // Crons section
  const cronRows =
    agent.crons.length === 0
      ? `<p class="empty">No cron jobs.</p>`
      : `<table>
      <thead><tr><th>Schedule</th><th>Prompt</th><th>Channel/User</th><th>Status</th></tr></thead>
      <tbody>
        ${agent.crons
          .map(
            (c) => `
        <tr>
          <td><code>${esc(c.schedule)}</code></td>
          <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.prompt)}</td>
          <td>${c.channel ? `<code>${esc(c.channel)}</code>` : c.user ? `<code>${esc(c.user)}</code>` : "—"}</td>
          <td><span class="badge${c.enabled ? "" : " disabled"}">${c.enabled ? "enabled" : "disabled"}</span></td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  // Tools section
  const toolRows =
    agent.tools.length === 0
      ? `<p class="empty">No tools configured.</p>`
      : `<table>
      <thead><tr><th>Pattern</th><th>Status</th></tr></thead>
      <tbody>
        ${agent.tools
          .map(
            (t) => `
        <tr>
          <td><code>${esc(t.pattern)}</code></td>
          <td><span class="badge${t.enabled ? "" : " disabled"}">${t.enabled ? "allowed" : "disabled"}</span></td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  // Tokens section
  const tokenRows =
    agent.tokens.length === 0
      ? `<p class="empty">No API tokens.</p>`
      : `<table>
      <thead><tr><th>Label</th><th>Created</th><th>Status</th></tr></thead>
      <tbody>
        ${agent.tokens
          .map(
            (t) => `
        <tr>
          <td>${t.label ? esc(t.label) : '<span class="meta">unlabeled</span>'}</td>
          <td class="meta">${esc(t.createdAt.toISOString().slice(0, 10))}</td>
          <td><span class="badge${t.revokedAt ? " revoked" : ""}">${t.revokedAt ? "revoked" : "active"}</span></td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  // Plugins section
  const pluginRows =
    agent.plugins.length === 0
      ? `<p class="empty">No plugins installed.</p>`
      : `<table>
      <thead><tr><th>Name</th><th>Version</th><th>Status</th></tr></thead>
      <tbody>
        ${agent.plugins
          .map(
            (p) => `
        <tr>
          <td><code>${esc(p.name)}</code></td>
          <td class="meta">${p.version ? esc(p.version) : "latest"}</td>
          <td><span class="badge${p.enabled ? "" : " disabled"}">${p.enabled ? "enabled" : "disabled"}</span></td>
        </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;

  // Slack connect section
  const slackSection = `
<div class="card">
  <h2>Slack OAuth Provisioning</h2>
  <p class="meta" style="margin-bottom:12px">Provide a user OAuth token (xoxp-) to create a Slack app via the Manifest API and start the OAuth flow.</p>
  <form method="POST" action="/admin/agents/${esc(agent.id)}/slack-connect">
    <div class="form-row">
      <input type="text" name="xoxpToken" placeholder="xoxp-..." style="flex:1" required>
      <button type="submit" class="btn btn-primary">Connect Slack</button>
    </div>
  </form>
</div>`;

  const body = `
<h1>${esc(agent.name)}</h1>
<p class="meta" style="margin-bottom:20px">ID: <code>${esc(agent.id)}</code>${agent.slackId ? ` &nbsp;·&nbsp; Slack: <code>${esc(agent.slackId)}</code>` : ""}</p>

<div class="card">
  <h2>Cron Jobs</h2>
  ${cronRows}
</div>

<div class="card">
  <h2>Tools</h2>
  ${toolRows}
</div>

<div class="card">
  <h2>API Tokens</h2>
  ${tokenRows}
</div>

<div class="card">
  <h2>Plugins</h2>
  ${pluginRows}
</div>

${envSection}
${slackSection}`;

  return layout(agent.name, body);
}

export function renderErrorPage(message: string): string {
  return layout(
    "Error",
    `<div class="card"><p style="color:#dc2626">${esc(message)}</p><p style="margin-top:12px"><a href="/admin/agents">← Back to agents</a></p></div>`,
  );
}
