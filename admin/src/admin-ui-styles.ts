import {
  escapeHtml,
  renderShipwrightToolbar,
  baseStyles as toolbarBaseStyles,
} from "@shipwright/lib/web/toolbar.ts";

export { escapeHtml };

/**
 * Shared responsive breakpoint constants (px), interpolated into `@media`
 * template strings across admin-ui-styles.ts and admin-ui-pages.ts so tests
 * can assert against the actual numeric constant instead of grepping for a
 * hardcoded literal like "640px" in the rendered HTML string.
 */
export const BREAKPOINT_MOBILE_MAX = 640;
export const BREAKPOINT_TABLET_MAX = 960;

export function baseStyles(): string {
  return `${toolbarBaseStyles()}
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
    .alert-warning {
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #fde68a;
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
    .badge-warning {
      background: #fde68a;
      color: #92400e;
    }

    /* ─── Scope pills (filter chips) ────────────────────── */
    .scope-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 500;
      padding: 3px 10px;
      border-radius: 9999px;
      background: #f3f4f6;
      color: #374151;
      border: 1px solid #e5e7eb;
    }
    .scope-pill.active {
      background: #eef2ff;
      color: #4338ca;
      border-color: #c7d2fe;
    }
    .scope-pill-remove {
      cursor: pointer;
      color: #9ca3af;
      font-weight: 700;
      line-height: 1;
    }
    .scope-pill-remove:hover { color: #374151; }

    /* Org/Repo multiselect filters (renderRepoOrgFilterFields) restyled as
       pill/tag-style fields (AXR-1.1). These stay two independent
       <select multiple> controls -- not merged into one combined pill. */
    .scope-select-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .scope-select {
      border-radius: 10px;
      background: #f9fafb;
    }
    .scope-select option:checked {
      background: #eef2ff;
      color: #4338ca;
    }

    /* ─── Board / column / card layout ──────────────────── */
    .board {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      overflow-x: auto;
      padding-bottom: 8px;
    }
    .column {
      flex: 0 0 280px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: #f9fafb;
      border: 1px solid #e8e8ee;
      border-radius: 10px;
      padding: 12px;
    }
    .column-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .column-count {
      font-size: 11px;
      font-weight: 600;
      color: #9ca3af;
      background: #fff;
      border: 1px solid #e8e8ee;
      border-radius: 9999px;
      padding: 1px 8px;
    }
    /* Individual board items reuse .card for the panel look; this modifier
       tightens padding/margins for the denser board context. */
    .column .card {
      margin-bottom: 0;
      padding: 12px 14px;
    }

    /* ─── Additional badge variants (beyond badge-hitl/badge-dep) ───────── */
    .badge-purple {
      background: #ede9fe;
      color: #5b21b6;
    }
    .badge-teal {
      background: #ccfbf1;
      color: #0f766e;
    }

    /* ─── Header tooltip (hover, data-tip attribute) ────── */
    .header-tooltip {
      position: relative;
      cursor: help;
      border-bottom: 1px dotted #9ca3af;
    }
    .header-tooltip[data-tip]:hover::after {
      content: attr(data-tip);
      position: absolute;
      bottom: 125%;
      left: 50%;
      transform: translateX(-50%);
      white-space: nowrap;
      background: #1a1a2e;
      color: #fff;
      font-size: 11px;
      font-weight: 500;
      padding: 4px 8px;
      border-radius: 6px;
      z-index: 10;
      pointer-events: none;
    }

    /* ─── Heartbeat status dots (fresh/aging/stale) ─────── */
    .heartbeat-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 9999px;
      background: #d1d5db;
    }
    .heartbeat-dot.fresh { background: #22c55e; }
    .heartbeat-dot.aging { background: #f59e0b; }
    .heartbeat-dot.stale { background: #ef4444; }

    /* ─── More filters disclosure ───────────────────────── */
    .more-filters {
      margin-top: 8px;
    }
    .more-filters summary {
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      color: #6b7280;
      list-style: none;
    }
    .more-filters summary::-webkit-details-marker { display: none; }
    .more-filters summary::before {
      content: "▸";
      display: inline-block;
      margin-right: 4px;
      transition: transform 0.15s ease;
    }
    .more-filters[open] summary::before {
      transform: rotate(90deg);
    }
    .more-filters[open] summary {
      color: #1a1a2e;
    }
    .more-filters-panel {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
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

    /* ─── Responsive ────────────────────────────────────── */
    html, body {
      overflow-x: hidden;
      max-width: 100%;
    }
    .data-table-wrapper {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      /* Scroll-shadow: fades appear at edges when content overflows */
      background-color: #fff;
      background-image:
        linear-gradient(to right, #fff, #fff),
        linear-gradient(to right, rgba(0,0,0,0.05), transparent),
        linear-gradient(to left, #fff, #fff),
        linear-gradient(to left, rgba(0,0,0,0.05), transparent);
      background-position: left, left, right, right;
      background-size: 20px 100%, 20px 100%, 24px 100%, 24px 100%;
      background-repeat: no-repeat;
      background-attachment: local, scroll, local, scroll;
    }
    .state-tab { padding: 5px 14px; }

    @media (max-width: ${BREAKPOINT_MOBILE_MAX}px) {
      .col-session, .col-repo, .col-source, .col-created { display: none; }
      .col-review-cycles, .col-patch-cycles, .col-claimed-by { display: none; }
      .col-tokens, .col-model { display: none; }
      .state-tab { padding: 13px 14px; }
      .vos-page {
        padding: 16px 12px 48px;
      }
      .card {
        padding: 14px 12px;
      }
      .form-row {
        flex-wrap: wrap;
      }
      .vos-toolbar {
        padding: 0 12px;
        gap: 12px;
      }
      .data-table-wrapper .data-table th,
      .data-table-wrapper .data-table td {
        white-space: nowrap;
      }
      /* Let the table bleed to card edges on mobile so scroll shadow aligns */
      .card .data-table-wrapper {
        margin: 0 -12px;
        padding: 0 12px;
      }
      .detail-table td:first-child {
        display: block;
        width: auto;
        white-space: normal;
      }
      .detail-table td:last-child {
        display: block;
        width: auto;
        padding-top: 0;
      }

      /* iOS Safari zooms in on focus for any input under 16px font-size. */
      .form-input,
      input[type="text"],
      input[type="search"],
      input[type="email"],
      input[type="password"],
      input[type="number"],
      textarea,
      select {
        font-size: 16px;
      }

      /* Touch targets: 44px minimum. .data-table .btn is excluded — a full
         44px target there would make the tasks/PRs tables absurdly tall —
         via an explicit override pinning it back to its current ~36px.
         Both selectors are specificity 0,2,0 vs 0,1,0, so .data-table .btn
         always wins regardless of declaration order within this block. */
      .btn {
        min-height: 44px;
        align-items: center;
      }
      .data-table .btn {
        min-height: 36px;
      }
      .thread-pane-link {
        min-height: 44px;
        display: flex;
        align-items: center;
      }
    }

    /* ─── Tablet band (641–${BREAKPOINT_TABLET_MAX}px) ──────────────── */
    @media (min-width: ${BREAKPOINT_MOBILE_MAX + 1}px) and (max-width: ${BREAKPOINT_TABLET_MAX}px) {
      .vos-page {
        padding: 24px 20px 56px;
      }
      .card {
        padding: 16px 18px;
      }
    }
  `;
}

export function renderAdminToolbar(userName: string, activePath = ""): string {
  return renderShipwrightToolbar({
    userName,
    activePath,
    logoutAction: "/admin/logout",
    metricsUrl: process.env.METRICS_DASHBOARD_URL ?? "/dashboard",
  });
}
