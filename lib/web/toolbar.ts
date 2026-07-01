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
  /** Full URL of the metrics dashboard. Defaults to "/dashboard". */
  metricsUrl?: string;
  /** Base URL of the admin service. Defaults to empty string (same origin). */
  adminBaseUrl?: string;
  /**
   * Public, unauthenticated variant. When true, render only the read-only
   * surfaces (Metrics dashboard + public task board) and no sign-out — the
   * authenticated /admin/* links and logout are omitted, since they 404 (and
   * aren't reachable) on the public proof host.
   */
  readOnly?: boolean;
  /** Public task board URL, used only in readOnly mode. Defaults to "/public/tasks". */
  tasksUrl?: string;
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

    /* ─── Hamburger button ──────────────────────────────── */
    .vos-hamburger {
      display: none;
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      color: #1a1a2e;
      padding: 4px 8px;
      margin-left: auto;
      line-height: 1;
      font-family: inherit;
    }
    .vos-hamburger:hover { color: #4f46e5; }

    @media (max-width: 640px) {
      .vos-toolbar { padding: 0 16px; gap: 12px; flex-wrap: wrap; height: auto; min-height: 52px; align-items: center; }
      .vos-username { display: none; }
      .vos-nav-link { padding: 5px 8px; }
      .vos-page { padding: 20px 16px 48px; }

      /* Hide nav links by default on mobile */
      .vos-nav {
        display: none;
        flex-direction: column;
        width: 100%;
        gap: 2px;
        padding: 8px 0;
        order: 3;
      }
      /* Show nav links when hamburger is toggled open */
      nav[data-open] .vos-nav {
        display: flex;
      }
      .vos-nav-link {
        display: block;
        padding: 10px 12px;
        border-radius: 6px;
        font-size: 14px;
      }
      .vos-nav-link.active {
        background: #eef2ff;
        color: #4f46e5;
        font-weight: 600;
      }
      /* Show hamburger on mobile */
      .vos-hamburger {
        display: block;
      }
      /* Hide user section sign-out on mobile when nav is closed */
      .vos-user {
        order: 2;
      }
    }

  `;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const hamburgerScript = `<script>
    (function() {
      var btn = document.querySelector('.vos-hamburger');
      var nav = btn && btn.closest('nav');
      if (btn && nav) {
        btn.addEventListener('click', function() {
          var open = nav.hasAttribute('data-open');
          if (open) {
            nav.removeAttribute('data-open');
            btn.setAttribute('aria-expanded', 'false');
          } else {
            nav.setAttribute('data-open', '');
            btn.setAttribute('aria-expanded', 'true');
          }
        });
      }
    })();
  <\/script>`;

export function renderShipwrightToolbar(
  opts: ShipwrightToolbarOptions,
): string {
  const { userName, activePath, logoutAction } = opts;
  const metricsUrl = opts.metricsUrl ?? "/dashboard";
  const adminBase = opts.adminBaseUrl ?? "";
  const active = (prefix: string) =>
    activePath.startsWith(prefix) ? " active" : "";

  // Public proof surface: only the read-only Metrics + Tasks views are routed and
  // reachable, so omit every /admin/* link and the sign-out form (they 404 on the
  // public host). The wordmark points at the dashboard instead of /admin/agents.
  if (opts.readOnly) {
    const tasksUrl = opts.tasksUrl ?? "/public/tasks";
    return `<nav class="vos-toolbar" aria-label="Site navigation">
    <a href="${metricsUrl}" class="vos-wordmark">Shipwright</a>
    <button class="vos-hamburger" aria-label="Toggle navigation" aria-expanded="false">☰</button>
    <div class="vos-nav">
      <a href="${metricsUrl}" class="vos-nav-link${active(metricsUrl)}">Metrics</a>
      <a href="${tasksUrl}" class="vos-nav-link${active(tasksUrl)}">Tasks</a>
    </div>
  </nav>
  ${hamburgerScript}`;
  }

  return `<nav class="vos-toolbar" aria-label="Site navigation">
    <a href="${adminBase}/admin/agents" class="vos-wordmark">Shipwright</a>
    <div class="vos-nav">
      <a href="${adminBase}/admin/agents" class="vos-nav-link${active("/admin/agents")}">Agents</a>
      <a href="${adminBase}/admin/provision" class="vos-nav-link${active("/admin/provision")}">Provision</a>
      <a href="${adminBase}/admin/tasks" class="vos-nav-link${active("/admin/tasks")}">Tasks</a>
      <a href="${adminBase}/admin/prs" class="vos-nav-link${active("/admin/prs")}">PRs</a>
      <a href="${adminBase}/admin/tokens" class="vos-nav-link${active("/admin/tokens")}">Task Store Tokens</a>
      <a href="${metricsUrl}" class="vos-nav-link${active(metricsUrl)}">Metrics</a>
    </div>
    <div class="vos-user">
      <span class="vos-username">${escapeHtml(userName)}</span>
      <form method="POST" action="${logoutAction}" style="margin:0">
        <button type="submit" class="vos-signout-btn">Sign out</button>
      </form>
    </div>
    <button class="vos-hamburger" aria-label="Toggle navigation" aria-expanded="false">☰</button>
  </nav>
  ${hamburgerScript}`;
}
