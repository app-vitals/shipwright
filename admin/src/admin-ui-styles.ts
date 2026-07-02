import {
  escapeHtml,
  renderShipwrightToolbar,
  baseStyles as toolbarBaseStyles,
} from "@shipwright/lib/web/toolbar.ts";

export { escapeHtml };

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
    @media (max-width: 640px) {
      .col-session, .col-repo { display: none; }
      .col-review-cycles, .col-patch-cycles, .col-claimed-by { display: none; }
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
