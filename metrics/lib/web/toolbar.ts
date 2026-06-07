/**
 * lib/web/toolbar.ts
 * Shared toolbar and base styles for authenticated Vitals OS web views.
 *
 * Exports:
 *   baseStyles()     — shared CSS reset + body styles for all authenticated pages
 *   renderToolbar()  — consistent top nav bar with wordmark, nav links, user + sign out
 */

export type ActivePage =
  | "hub"
  | "overview"
  | "time"
  | "profile"
  | "agents"
  | "clients"
  | "metrics"
  | "podcast"
  | "invoices";

export interface ToolbarOptions {
  userName: string;
  activePage: ActivePage;
  /** Defaults to true for backward compat. When false, Cal/Time/Metrics are hidden. */
  isOwner?: boolean;
}

// ─── Nav Structure ────────────────────────────────────────────────────────────

type NavView = { id: ActivePage; label: string; href: string };
type NavService = { label: string; defaultHref: string; views: NavView[] };

const NAV_SERVICES: NavService[] = [
  {
    label: "Accounts",
    defaultHref: "/accounts/profile",
    views: [
      {
        id: "profile",
        label: "Profile",
        href: "/accounts/profile",
      },
      { id: "agents", label: "Agents", href: "/accounts/agents" },
      { id: "clients", label: "Clients", href: "/accounts/web/clients" },
    ],
  },
  {
    label: "Cal",
    defaultHref: "/cal/hub",
    views: [
      { id: "hub", label: "Hub", href: "/cal/hub" },
      { id: "overview", label: "Overview", href: "/cal/overview" },
    ],
  },
  {
    label: "Time",
    defaultHref: "/time/week",
    views: [{ id: "time", label: "Time", href: "/time/week" }],
  },
  {
    label: "Billing",
    defaultHref: "/billing/invoices",
    views: [{ id: "invoices", label: "Invoices", href: "/billing/invoices" }],
  },
  {
    label: "Metrics",
    defaultHref: "/dashboard",
    views: [{ id: "metrics", label: "Metrics", href: "/dashboard" }],
  },
  {
    label: "Podcast",
    defaultHref: "/podcast",
    views: [{ id: "podcast", label: "Podcast", href: "/podcast" }],
  },
];

// ─── Base Styles ──────────────────────────────────────────────────────────────

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

    /* ─── Dropdown ──────────────────────────────────────── */
    .vos-dropdown {
      position: relative;
    }
    .vos-dropdown-menu {
      display: none;
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      background: #fff;
      border: 1px solid #e8e8ee;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      padding: 4px;
      min-width: 140px;
      z-index: 200;
    }
    .vos-dropdown:hover .vos-dropdown-menu { display: block; }
    .vos-dropdown-item {
      display: block;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      color: #6b7280;
      text-decoration: none;
      white-space: nowrap;
      transition: background 0.1s, color 0.1s;
    }
    .vos-dropdown-item:hover { background: #f3f4f6; color: #1a1a2e; }
    .vos-dropdown-item.active { background: #eef2ff; color: #4f46e5; font-weight: 600; }

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

// ─── Toolbar HTML ─────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderNavService(service: NavService, activePage: ActivePage): string {
  const isActive = service.views.some((v) => v.id === activePage);

  if (service.views.length === 1) {
    return `<a href="${service.defaultHref}" class="vos-nav-link${isActive ? " active" : ""}">${service.label}</a>`;
  }

  const items = service.views
    .map(
      ({ id, label, href }) =>
        `<a href="${href}" class="vos-dropdown-item${activePage === id ? " active" : ""}">${label}</a>`,
    )
    .join("\n        ");

  return `<div class="vos-dropdown">
      <a href="${service.defaultHref}" class="vos-nav-link${isActive ? " active" : ""}">${service.label} &#9662;</a>
      <div class="vos-dropdown-menu">
        ${items}
      </div>
    </div>`;
}

const OWNER_ONLY_SERVICES = new Set(["Cal", "Time", "Metrics", "Billing"]);

export function renderToolbar(opts: ToolbarOptions): string {
  const { userName, activePage, isOwner = true } = opts;

  const visibleServices = isOwner
    ? NAV_SERVICES
    : NAV_SERVICES.filter((s) => !OWNER_ONLY_SERVICES.has(s.label));

  const navItems = visibleServices
    .map((s) => renderNavService(s, activePage))
    .join("\n      ");

  return `<nav class="vos-toolbar" aria-label="Site navigation">
    <a href="/accounts/profile" class="vos-wordmark">Vitals OS</a>
    <div class="vos-nav">
      ${navItems}
    </div>
    <div class="vos-user">
      <span class="vos-username">${escapeHtml(userName)}</span>
      <form method="POST" action="/auth/logout" style="margin:0">
        <button type="submit" class="vos-signout-btn">Sign out</button>
      </form>
    </div>
  </nav>`;
}
