/**
 * agent/src/admin-ui-styles.ts
 * Base CSS for the admin UI pages.
 * Extends the shared toolbar styles from metrics/src/lib/web/toolbar.ts.
 */

export function baseStyles(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-size: 16px; -webkit-font-smoothing: antialiased; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f7f7fb;
      color: #1a1a2e;
      min-height: 100vh;
    }

    /* ─── Toolbar ───────────────────────────────────────── */
    .vos-toolbar {
      background: #fff;
      border-bottom: 1px solid #e8e8ee;
      height: 52px;
      display: flex;
      align-items: center;
      padding: 0 24px;
      gap: 24px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .vos-wordmark {
      font-size: 15px;
      font-weight: 700;
      color: #1a1a2e;
      text-decoration: none;
      letter-spacing: -0.3px;
      flex-shrink: 0;
    }
    .vos-nav {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 1;
    }
    .vos-nav-link {
      font-size: 13px;
      font-weight: 500;
      color: #6b7280;
      text-decoration: none;
      padding: 6px 10px;
      border-radius: 6px;
    }
    .vos-nav-link:hover,
    .vos-nav-link.active {
      color: #1a1a2e;
      background: #f3f4f6;
    }
    .vos-user {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
      margin-left: auto;
    }
    .vos-username {
      font-size: 13px;
      color: #6b7280;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }
    .vos-signout-btn {
      font-size: 13px;
      font-weight: 500;
      color: #6b7280;
      background: none;
      border: 1px solid #e8e8ee;
      border-radius: 6px;
      padding: 5px 12px;
      cursor: pointer;
      font-family: inherit;
    }
    .vos-signout-btn:hover {
      background: #f3f4f6;
    }

    /* ─── Page body ─────────────────────────────────────── */
    .vos-page {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }

    /* ─── Page header ───────────────────────────────────── */
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .page-title {
      font-size: 22px;
      font-weight: 700;
      color: #1a1a2e;
    }

    /* ─── Buttons ───────────────────────────────────────── */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 500;
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid transparent;
      cursor: pointer;
      font-family: inherit;
      text-decoration: none;
    }
    .btn-primary {
      background: #1a1a2e;
      color: #fff;
      border-color: #1a1a2e;
    }
    .btn-primary:hover { background: #2d2d4e; }
    .btn-secondary {
      background: #fff;
      color: #1a1a2e;
      border-color: #e8e8ee;
    }
    .btn-secondary:hover { background: #f3f4f6; }
    .btn-danger {
      background: #fff;
      color: #dc2626;
      border-color: #fee2e2;
    }
    .btn-danger:hover { background: #fee2e2; }

    /* ─── Cards / panels ────────────────────────────────── */
    .card {
      background: #fff;
      border: 1px solid #e8e8ee;
      border-radius: 10px;
      padding: 20px 24px;
      margin-bottom: 16px;
    }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: #1a1a2e;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid #f3f4f6;
    }

    /* ─── Tables ────────────────────────────────────────── */
    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .data-table th {
      text-align: left;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #9ca3af;
      padding: 8px 12px;
      border-bottom: 1px solid #f3f4f6;
    }
    .data-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #f3f4f6;
      color: #374151;
      vertical-align: middle;
    }
    .data-table tr:last-child td {
      border-bottom: none;
    }
    .data-table tr:hover td {
      background: #fafafa;
    }

    /* ─── Agent list ────────────────────────────────────── */
    .agent-link {
      font-weight: 500;
      color: #1a1a2e;
      text-decoration: none;
    }
    .agent-link:hover { text-decoration: underline; }

    /* ─── Forms ─────────────────────────────────────────── */
    .form-group {
      margin-bottom: 16px;
    }
    .form-label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: #374151;
      margin-bottom: 6px;
    }
    .form-input {
      width: 100%;
      padding: 8px 12px;
      font-size: 14px;
      font-family: inherit;
      border: 1px solid #e8e8ee;
      border-radius: 6px;
      background: #fff;
      color: #1a1a2e;
    }
    .form-input:focus {
      outline: none;
      border-color: #1a1a2e;
    }
    .form-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    .form-row .form-group {
      flex: 1;
      margin-bottom: 0;
    }

    /* ─── Login page ────────────────────────────────────── */
    .login-wrapper {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-card {
      background: #fff;
      border: 1px solid #e8e8ee;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    .login-title {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .login-subtitle {
      font-size: 13px;
      color: #6b7280;
      margin-bottom: 28px;
    }

    /* ─── Alerts ────────────────────────────────────────── */
    .alert {
      padding: 10px 14px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .alert-error {
      background: #fee2e2;
      color: #dc2626;
      border: 1px solid #fecaca;
    }
    .alert-success {
      background: #d1fae5;
      color: #065f46;
      border: 1px solid #a7f3d0;
    }

    /* ─── Badges ────────────────────────────────────────── */
    .badge {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 9999px;
    }
    .badge-green {
      background: #d1fae5;
      color: #065f46;
    }
    .badge-gray {
      background: #f3f4f6;
      color: #6b7280;
    }

    /* ─── Provision page ────────────────────────────────── */
    .provision-steps {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
    }
    .provision-step {
      font-size: 12px;
      font-weight: 500;
      color: #9ca3af;
      padding: 4px 10px;
      border-radius: 4px;
      background: #f3f4f6;
    }
    .provision-step.active {
      background: #1a1a2e;
      color: #fff;
    }
    .oauth-url-box {
      word-break: break-all;
      background: #f9fafb;
      border: 1px solid #e8e8ee;
      border-radius: 6px;
      padding: 12px 14px;
      font-size: 13px;
      font-family: monospace;
      margin-bottom: 16px;
    }

    /* ─── Empty states ──────────────────────────────────── */
    .empty-state {
      text-align: center;
      padding: 32px;
      color: #9ca3af;
      font-size: 13px;
    }

    /* ─── Code / monospace ──────────────────────────────── */
    .mono {
      font-family: "SF Mono", "Fira Code", Menlo, monospace;
      font-size: 12px;
    }
  `;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderAdminToolbar(userName: string): string {
  return `<nav class="vos-toolbar" aria-label="Site navigation">
    <a href="/admin/agents" class="vos-wordmark">Shipwright Admin</a>
    <div class="vos-nav">
      <a href="/admin/agents" class="vos-nav-link active">Agents</a>
      <a href="/admin/provision" class="vos-nav-link">Provision</a>
    </div>
    <div class="vos-user">
      <span class="vos-username">${escapeHtml(userName)}</span>
      <form method="POST" action="/admin/logout" style="margin:0">
        <button type="submit" class="vos-signout-btn">Sign out</button>
      </form>
    </div>
  </nav>`;
}
