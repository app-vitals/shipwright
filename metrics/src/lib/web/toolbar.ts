/**
 * metrics/src/lib/web/toolbar.ts
 * Stub toolbar for the metrics dashboard.
 * SW-2.3 will replace this with the real implementation.
 */

export type ActivePage = "metrics";

export interface ToolbarOptions {
  userName: string;
  activePage: ActivePage;
  /** Defaults to true for backward compat. */
  isOwner?: boolean;
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
    .vos-nav {
      display: flex;
      align-items: center;
      gap: 4px;
      flex: 1;
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

    /* ─── Page body ─────────────────────────────────────── */
    .vos-page {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 24px 64px;
    }
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderToolbar(opts: ToolbarOptions): string {
  const { userName } = opts;
  return `<nav class="vos-toolbar" aria-label="Site navigation">
    <a href="/" class="vos-wordmark">Shipwright</a>
    <div class="vos-nav">
      <a href="/dashboard" class="vos-nav-link active">Metrics</a>
    </div>
    <div class="vos-user">
      <span class="vos-username">${escapeHtml(userName)}</span>
      <form method="POST" action="/auth/logout" style="margin:0">
        <button type="submit" class="vos-signout-btn">Sign out</button>
      </form>
    </div>
  </nav>`;
}
