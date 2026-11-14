/**
 * admin/src/coding/admin-ui-system-crons.ts
 * GET/POST /admin/settings/system-crons — admin-only settings page for the
 * task-store's system-cron definitions (SCR-1.4): an enable toggle and
 * editable title/description templates per definition, plus a banner linking
 * to /admin/settings/github-enterprise while the GitHub lookup App is not
 * configured (system crons fan out over the repos that App can see).
 *
 * A thin UI over the SCR-1.1 task-store endpoints (GET /system-crons, PATCH
 * /system-crons/:id, POST /system-crons/:id/{enable,disable}) via the injected
 * fetchers. Without them the page renders in degraded mode.
 *
 * "Lookup App configured" = the platform's GET /github-enterprise/apps status
 * reports a non-null `lookup` entry (the same signal the platform uses for its
 * access preview). With the API un-wired or erroring, it counts as missing.
 */

import type { AdminUIEnv } from "@app-vitals/agent-admin/admin-ui";
import { renderAdminPage } from "@app-vitals/agent-admin/admin-ui-layout";
import {
  escapeHtml,
  renderAdminToolbar,
} from "@app-vitals/agent-admin/admin-ui-styles";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { validateTemplateForm } from "./system-cron-form.ts";

export const SYSTEM_CRONS_SETTINGS_PATH = "/admin/settings/system-crons";
export const GITHUB_ENTERPRISE_SETTINGS_PATH =
  "/admin/settings/github-enterprise";

/** A system-cron definition as returned by the task-store. */
export interface SystemCronItem {
  id: string;
  name: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  titleTemplate: string;
  descriptionTemplate: string;
}

export interface SystemCronsFetchers {
  fetchSystemCrons?: () => Promise<{ systemCrons: SystemCronItem[] }>;
  patchSystemCron?: (
    id: string,
    patch: { titleTemplate?: string; descriptionTemplate?: string },
  ) => Promise<unknown>;
  setSystemCronEnabled?: (id: string, enabled: boolean) => Promise<unknown>;
}

export interface SystemCronsDeps extends SystemCronsFetchers {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  html: (content: string, opts?: { status?: number }) => Response;
  /** The platform's GHE API (`.request`); absent → lookup App counts as missing. */
  githubEnterpriseApi?: (
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response>;
}

const NOTICES: Record<string, string> = {
  enabled: "System cron enabled.",
  disabled: "System cron disabled.",
  saved: "Templates saved.",
};

const ERRORS: Record<string, string> = {
  task_store_unavailable: "The task store is not configured.",
  not_found: "That system cron no longer exists.",
  update_failed: "The task store rejected the update.",
};

// ─── Rendering ────────────────────────────────────────────────────────────────

interface PageOpts {
  userEmail: string;
  crons: SystemCronItem[];
  degraded: boolean;
  lookupConfigured: boolean;
  notice?: string;
  error?: string;
  warnings?: string[];
  /** Submitted-but-invalid values, keyed by cron id, to re-fill the form. */
  draft?: { id: string; titleTemplate: string; descriptionTemplate: string };
}

function renderCronCard(c: SystemCronItem, opts: PageOpts): string {
  const id = encodeURIComponent(c.id);
  const draft = opts.draft?.id === c.id ? opts.draft : undefined;
  const title = draft?.titleTemplate ?? c.titleTemplate;
  const description = draft?.descriptionTemplate ?? c.descriptionTemplate;
  const toggleLabel = c.enabled ? "Disable" : "Enable";
  return `<div class="card" data-system-cron="${escapeHtml(c.id)}">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <span>${escapeHtml(c.name)} <code style="font-size:12px;color:#6b7280">${escapeHtml(c.id)}</code></span>
      <span style="display:flex;align-items:center;gap:8px">
        <span class="badge">${c.enabled ? "Enabled" : "Disabled"}</span>
        <form method="POST" action="${SYSTEM_CRONS_SETTINGS_PATH}/${id}/${c.enabled ? "disable" : "enable"}" style="margin:0">
          <button type="submit" class="btn btn-secondary" style="font-size:12px">${toggleLabel}</button>
        </form>
      </span>
    </div>
    <p style="font-size:12px;color:#6b7280;margin:0 0 12px">Schedule <code>${escapeHtml(c.schedule)}</code> (${escapeHtml(c.timezone)})</p>
    <form method="POST" action="${SYSTEM_CRONS_SETTINGS_PATH}/${id}">
      <div class="form-group">
        <label class="form-label" for="titleTemplate-${escapeHtml(c.id)}">Title template</label>
        <input id="titleTemplate-${escapeHtml(c.id)}" name="titleTemplate" type="text" class="form-input" value="${escapeHtml(title)}" />
      </div>
      <div class="form-group">
        <label class="form-label" for="descriptionTemplate-${escapeHtml(c.id)}">Description template</label>
        <textarea id="descriptionTemplate-${escapeHtml(c.id)}" name="descriptionTemplate" class="form-input" rows="4">${escapeHtml(description)}</textarea>
        <p style="font-size:12px;color:#6b7280;margin:4px 0 0"><code>{repo}</code> is replaced with the org/repo; nothing else is evaluated.</p>
      </div>
      <button type="submit" class="btn btn-primary">Save templates</button>
    </form>
  </div>`;
}

export function renderSystemCronsPage(opts: PageOpts): string {
  const banner = opts.lookupConfigured
    ? ""
    : `<div class="alert alert-warning" data-banner="lookup-app-missing">The GitHub lookup App is not configured, so system crons cannot resolve repositories. <a href="${GITHUB_ENTERPRISE_SETTINGS_PATH}">Configure it in GitHub Enterprise settings</a>.</div>`;
  const degraded = opts.degraded
    ? `<div class="alert alert-warning">The task store is not configured — system crons are unavailable.</div>`
    : "";
  const notice = opts.notice
    ? `<div class="alert alert-success">${escapeHtml(opts.notice)}</div>`
    : "";
  const error = opts.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";
  const warnings = (opts.warnings ?? [])
    .map((w) => `<div class="alert alert-warning">${escapeHtml(w)}</div>`)
    .join("");
  const cards =
    opts.crons.length === 0
      ? opts.degraded
        ? ""
        : `<div class="card"><p class="empty-state">No system crons are defined.</p></div>`
      : opts.crons.map((c) => renderCronCard(c, opts)).join("\n");

  return renderAdminPage({
    title: "System Crons — Shipwright Admin",
    body: `${renderAdminToolbar(opts.userEmail, SYSTEM_CRONS_SETTINGS_PATH)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">System crons</h1>
      <p style="font-size:13px;color:#6b7280;margin:4px 0 0"><a href="${GITHUB_ENTERPRISE_SETTINGS_PATH}">GitHub Enterprise settings</a></p>
    </div>
    ${banner}${degraded}${notice}${error}${warnings}
    ${cards}
  </div>`,
  });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export function registerSystemCronsRoutes(
  app: Hono<AdminUIEnv>,
  deps: SystemCronsDeps,
): void {
  const requireAdmin: MiddlewareHandler<AdminUIEnv> = async (c, next) =>
    c.var.isAdmin === true
      ? next()
      : new Response("Forbidden", { status: 403 });

  async function lookupAppConfigured(c: Context<AdminUIEnv>): Promise<boolean> {
    if (!deps.githubEnterpriseApi) return false;
    try {
      const cookie = c.req.header("cookie");
      const res = await deps.githubEnterpriseApi("/github-enterprise/apps", {
        method: "GET",
        headers: cookie ? { cookie } : {},
      });
      if (!res.ok) return false;
      const status = (await res.json()) as { lookup?: unknown };
      return status.lookup != null;
    } catch {
      return false;
    }
  }

  async function renderPage(
    c: Context<AdminUIEnv>,
    flash: Pick<PageOpts, "notice" | "error" | "warnings" | "draft"> & {
      status?: number;
    } = {},
  ): Promise<Response> {
    const { status, ...rest } = flash;
    let crons: SystemCronItem[] = [];
    let error = rest.error;
    const degraded = !deps.fetchSystemCrons;
    if (deps.fetchSystemCrons) {
      try {
        crons = (await deps.fetchSystemCrons()).systemCrons;
      } catch {
        error ??= "Could not load system crons from the task store.";
      }
    }
    const noticeKey = c.req.query("notice");
    const errorKey = c.req.query("error");
    return deps.html(
      renderSystemCronsPage({
        userEmail: c.var.userEmail,
        crons,
        degraded,
        lookupConfigured: await lookupAppConfigured(c),
        ...rest,
        notice: rest.notice ?? (noticeKey ? NOTICES[noticeKey] : undefined),
        error: error ?? (errorKey ? ERRORS[errorKey] : undefined),
      }),
      { status },
    );
  }

  const fail = (code: keyof typeof ERRORS) =>
    new Response(null, {
      status: 302,
      headers: { Location: `${SYSTEM_CRONS_SETTINGS_PATH}?error=${code}` },
    });
  const ok = (notice: keyof typeof NOTICES) =>
    new Response(null, {
      status: 302,
      headers: { Location: `${SYSTEM_CRONS_SETTINGS_PATH}?notice=${notice}` },
    });

  app.get(SYSTEM_CRONS_SETTINGS_PATH, deps.requireAuth, requireAdmin, (c) =>
    renderPage(c),
  );

  for (const enabled of [true, false]) {
    const verb = enabled ? "enable" : "disable";
    app.post(
      `${SYSTEM_CRONS_SETTINGS_PATH}/:id/${verb}`,
      deps.requireAuth,
      requireAdmin,
      async (c) => {
        if (!deps.setSystemCronEnabled) return fail("task_store_unavailable");
        try {
          const result = await deps.setSystemCronEnabled(
            c.req.param("id"),
            enabled,
          );
          if (result === null) return fail("not_found");
        } catch {
          return fail("update_failed");
        }
        return ok(enabled ? "enabled" : "disabled");
      },
    );
  }

  app.post(
    `${SYSTEM_CRONS_SETTINGS_PATH}/:id`,
    deps.requireAuth,
    requireAdmin,
    async (c) => {
      if (!deps.patchSystemCron) return fail("task_store_unavailable");
      const id = c.req.param("id");
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        form = new FormData();
      }
      const raw = {
        titleTemplate: form.get("titleTemplate")?.toString(),
        descriptionTemplate: form.get("descriptionTemplate")?.toString(),
      };
      const result = validateTemplateForm(raw);
      if (!result.ok) {
        return renderPage(c, {
          error: result.errors.join(" "),
          draft: {
            id,
            titleTemplate: raw.titleTemplate ?? "",
            descriptionTemplate: raw.descriptionTemplate ?? "",
          },
          status: 400,
        });
      }
      try {
        const updated = await deps.patchSystemCron(id, result.value);
        if (updated === null) return fail("not_found");
      } catch {
        return fail("update_failed");
      }
      return ok("saved");
    },
  );
}
