/**
 * lib/web/toolbar.ts
 * Shared Shipwright toolbar — used by both the metrics dashboard and the admin UI.
 */

export interface ShipwrightToolbarOptions {
  userName: string;
  /** Current request path, used to highlight the active nav link. */
  activePath: string;
  /** Form action for the sign-out button (differs per service). */
  logoutAction: string;
  /** Full URL of the metrics dashboard. Defaults to "/sw/dashboard". */
  metricsUrl?: string;
  /** Base URL of the admin service. Defaults to empty string (same origin). */
  adminBaseUrl?: string;
}

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
    .vos-wordmark:hover { color: #4f46e5; }
    .vos-nav {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 1;
    }
    .vos-nav-link {
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      color: #6b7280;
      text-decoration: none;
      transition: background 0.1s, color 0.1s;
      white-space: nowrap;
    }
    .vos-nav-link:hover { background: #f3f4f6; color: #1a1a2e; }
    .vos-nav-link.active {
      background: #eef2ff;
      color: #4f46e5;
      font-weight: 600;
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
      transition: background 0.1s, color 0.1s, border-color 0.1s;
      white-space: nowrap;
    }
    .vos-signout-btn:hover { background: #f7f7fb; color: #1a1a2e; border-color: #d1d5db; }

    /* ─── Page body ─────────────────────────────────────── */
    .vos-page {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }

    @media (max-width: 640px) {
      .vos-toolbar { padding: 0 16px; gap: 12px; }
      .vos-username { display: none; }
      .vos-nav-link { padding: 5px 8px; }
      .vos-page { padding: 20px 16px 48px; }
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

export function renderShipwrightToolbar(
  opts: ShipwrightToolbarOptions,
): string {
  const { userName, activePath, logoutAction } = opts;
  const metricsUrl = opts.metricsUrl ?? "/sw/dashboard";
  const adminBase = opts.adminBaseUrl ?? "";
  const active = (prefix: string) =>
    activePath.startsWith(prefix) ? " active" : "";
  return `<nav class="vos-toolbar" aria-label="Site navigation">
    <a href="${adminBase}/admin/agents" class="vos-wordmark">Shipwright</a>
    <div class="vos-nav">
      <a href="${adminBase}/admin/agents" class="vos-nav-link${active("/admin/agents")}">Agents</a>
      <a href="${adminBase}/admin/provision" class="vos-nav-link${active("/admin/provision")}">Provision</a>
      <a href="${metricsUrl}" class="vos-nav-link${active(metricsUrl)}">Metrics</a>
    </div>
    <div class="vos-user">
      <span class="vos-username">${escapeHtml(userName)}</span>
      <form method="POST" action="${logoutAction}" style="margin:0">
        <button type="submit" class="vos-signout-btn">Sign out</button>
      </form>
    </div>
  </nav>`;
}
