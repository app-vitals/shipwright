/**
 * admin/src/coding/admin-ui-system-crons.ts
 * GET/POST /admin/settings/system-crons — admin-only settings page for the
 * task-store's system-cron definitions (SCR-1.4): an enable toggle and
 * editable title/description templates per definition, plus a banner linking
 * to /admin/settings/github-enterprise while the GitHub lookup App is not
 * configured (system crons fan out over the repos that App can see).
 *
 * Each definition also lists its last 5 triggers (SCR-1.10) via the SCR-1.9
 * GET /system-crons/:id/triggers; a failed fetch renders an inline note for
 * that cron only. Skipped ticks are not shown: with the lookup App missing,
 * the banner above is the signal.
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
  getSettingsNav,
  renderSettingsLayout,
  type SettingsNav,
} from "@app-vitals/agent-admin/admin-ui-settings-layout";
import { escapeHtml } from "@app-vitals/agent-admin/admin-ui-styles";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { validateScopeForm, validateTemplateForm } from "./system-cron-form.ts";
import {
  formatTriggerRow,
  RECENT_RUNS_LIMIT,
  recentTriggers,
  type SystemCronTrigger,
} from "./system-cron-runs.ts";

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
  /** CRS-2.2 — owning account; selects which account's repo listing feeds the checklist. */
  accountId?: string | null;
  /** CRS-1.1; absent on older stores, which means 'all'. */
  repoScope?: "all" | "selected";
  repos?: string[];
}

/** Structural match for the platform's GithubLookupService (listRepositories). */
export interface RepositoryLookup {
  listRepositories(accountId?: string | null): Promise<{
    configured: boolean;
    repos: { fullName: string; archived: boolean }[];
    /** Cache state; absent on older platform versions (treated as ready). */
    syncState?: "syncing" | "ready" | "stale" | "failed";
    fetchedAt?: string | number | Date | null;
    progress?: { reposSeen: number; totalCount?: number | null } | null;
  }>;
}

type RepoEntry = { fullName: string; archived: boolean };

/** What the checklist knows about an account's repo listing. */
export type RepoListing =
  | { state: "unconfigured" | "failed" }
  | {
      state: "ready" | "syncing" | "stale";
      repos: RepoEntry[];
      fetchedAt?: string | number | Date | null;
      progress?: { reposSeen: number; totalCount?: number | null } | null;
    };

/** Maps a lookup result onto a RepoListing; unknown/absent syncState means ready. */
export function toRepoListing(
  r: Awaited<ReturnType<RepositoryLookup["listRepositories"]>>,
): RepoListing {
  if (!r.configured) return { state: "unconfigured" };
  if (r.syncState === "failed" && r.repos.length === 0)
    return { state: "failed" };
  const state =
    r.syncState === "syncing" || r.syncState === "stale"
      ? r.syncState
      : r.syncState === "failed"
        ? "stale"
        : "ready";
  return {
    state,
    repos: r.repos,
    fetchedAt: r.fetchedAt,
    progress: r.progress,
  };
}

function ago(at: string | number | Date | null | undefined, now: number) {
  const t = at == null ? Number.NaN : new Date(at).getTime();
  if (Number.isNaN(t)) return "a while ago";
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export interface SystemCronsFetchers {
  fetchSystemCrons?: () => Promise<{ systemCrons: SystemCronItem[] }>;
  patchSystemCron?: (
    id: string,
    patch: {
      titleTemplate?: string;
      descriptionTemplate?: string;
      repoScope?: "all" | "selected";
      repos?: string[];
    },
  ) => Promise<unknown>;
  setSystemCronEnabled?: (id: string, enabled: boolean) => Promise<unknown>;
  fetchSystemCronTriggers?: (
    id: string,
    limit: number,
  ) => Promise<{ triggers: SystemCronTrigger[] }>;
}

/** A cron's recent triggers, or `null` when the fetch failed (or isn't wired). */
export type RecentRuns = SystemCronTrigger[] | null;

export interface SystemCronsDeps extends SystemCronsFetchers {
  requireAuth: MiddlewareHandler<AdminUIEnv>;
  html: (content: string, opts?: { status?: number }) => Response;
  /** The platform's GHE API (`.request`); absent → lookup App counts as missing. */
  githubEnterpriseApi?: (
    path: string,
    init?: RequestInit,
  ) => Response | Promise<Response>;
  /** Feeds the repo checklist (CRS-1.3); absent/unconfigured → degraded checklist. */
  githubLookup?: RepositoryLookup;
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
  nav: SettingsNav;
  crons: SystemCronItem[];
  /** Recent triggers keyed by cron id; a missing/null entry renders the fetch-failure note. */
  recentRuns?: Record<string, RecentRuns>;
  degraded: boolean;
  lookupConfigured: boolean;
  notice?: string;
  error?: string;
  warnings?: string[];
  /** Submitted-but-invalid values, keyed by cron id, to re-fill the form. */
  draft?: {
    id: string;
    titleTemplate: string;
    descriptionTemplate: string;
    repoScope?: string;
    repos?: string[];
  };
  /**
   * Repos the lookup App can see, keyed by account (CRS-2.2; `""` is the
   * deployment-wide listing for a cron without an accountId). A missing
   * entry means no lookup is wired.
   */
  repoListings?: Record<string, RepoListing>;
}

const accountKey = (c: Pick<SystemCronItem, "accountId">): string =>
  c.accountId ?? "";

function scopeSummary(c: SystemCronItem): string {
  if ((c.repoScope ?? "all") === "all") return "All repositories";
  const n = c.repos?.length ?? 0;
  return `${n} ${n === 1 ? "repo" : "repos"}`;
}

function repoListNote(listing: RepoListing | undefined): string {
  const style =
    "font-size:12px;color:var(--vos-text-muted, #6b7280);margin:4px 0";
  if (!listing || listing.state === "unconfigured") return "";
  if (listing.state === "failed")
    return `<p data-repo-list="failed" class="alert alert-warning" style="margin:4px 0">The last repository refresh failed, so the list is unavailable; only the current selection is shown.</p>`;
  if (listing.state === "syncing") {
    const p = listing.progress;
    const prog = p ? ` (${p.reposSeen} of ${p.totalCount ?? "?"})` : "";
    return `<p data-repo-list="syncing" class="alert alert-info" style="margin:4px 0">Syncing repositories${prog}; the list below is partial.</p>`;
  }
  if (listing.state === "stale")
    return `<p data-repo-list="stale" style="${style}">Stale, synced ${escapeHtml(ago(listing.fetchedAt, Date.now()))}.</p>`;
  return "";
}

function renderScopeControl(
  c: SystemCronItem,
  draft: PageOpts["draft"],
  listing: RepoListing | undefined,
): string {
  const cid = escapeHtml(c.id);
  const scope = (draft?.repoScope ?? c.repoScope ?? "all") as string;
  const selected = new Set(draft?.repos ?? c.repos ?? []);
  const list = listing && "repos" in listing ? listing.repos : null;
  const known = new Map((list ?? []).map((r) => [r.fullName, r]));
  // Selected repos absent from the listing stay visible (and flagged) so a
  // save never silently drops them. With no listing, the selection is all we have.
  const missing = [...selected].filter((r) => !known.has(r));
  const rows = [
    ...missing.map((r) => ({
      fullName: r,
      archived: false,
      flag:
        list && listing?.state === "ready" ? "not in the current listing" : "",
    })),
    ...(list ?? []).map((r) => ({ ...r, flag: "" })),
  ]
    .map((r) => {
      const flags = [
        r.flag
          ? `<span class="badge" data-repo-flag="missing">${escapeHtml(r.flag)}</span>`
          : "",
        r.archived ? `<span class="badge badge-gray">archived</span>` : "",
      ].join(" ");
      return `<label data-repo-row data-repo-name="${escapeHtml(r.fullName.toLowerCase())}" style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:13px"><input type="checkbox" name="repos" value="${escapeHtml(r.fullName)}"${selected.has(r.fullName) ? " checked" : ""} /> <span>${escapeHtml(r.fullName)}</span> ${flags}</label>`;
    })
    .join("");
  const note = repoListNote(listing);
  const unusedNote =
    list || listing?.state === "failed"
      ? ""
      : `<p data-repo-list="unavailable" style="font-size:12px;color:var(--vos-text-muted, #6b7280);margin:4px 0">The repository list is unavailable until the GitHub lookup App is configured; only the current selection is shown.</p>`;
  return `<fieldset class="form-group" data-repo-scope="${cid}" style="border:0;padding:0;margin:0 0 12px">
    <legend class="form-label">Repositories</legend>
    <label style="display:block;font-size:13px"><input type="radio" name="repoScope" value="all"${scope === "all" ? " checked" : ""} /> All repositories <span style="color:var(--vos-text-muted, #6b7280)">(current and future)</span></label>
    <label style="display:block;font-size:13px"><input type="radio" name="repoScope" value="selected"${scope === "selected" ? " checked" : ""} /> Only select repositories</label>
    <div data-repo-checklist style="margin-top:8px">
      <input type="search" class="form-input" data-repo-search placeholder="Search repositories" aria-label="Search repositories" />
      ${note}${unusedNote}
      <div style="max-height:200px;overflow:auto;margin-top:6px">${rows || `<p class="empty-state" style="margin:4px 0">No repositories to show.</p>`}</div>
    </div>
  </fieldset>`;
}

const SCOPE_SCRIPT = `<script>
(function() {
  function sync(fs) {
    var sel = fs.querySelector('input[name="repoScope"][value="selected"]');
    var box = fs.querySelector('[data-repo-checklist]');
    if (box && sel) box.style.display = sel.checked ? '' : 'none';
  }
  var sets = document.querySelectorAll('[data-repo-scope]');
  for (var i = 0; i < sets.length; i++) sync(sets[i]);
  document.addEventListener('change', function(e) {
    var fs = e.target && e.target.closest && e.target.closest('[data-repo-scope]');
    if (fs) sync(fs);
  });
  document.addEventListener('input', function(e) {
    var t = e.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-repo-search')) return;
    var q = t.value.toLowerCase();
    var rows = t.closest('[data-repo-checklist]').querySelectorAll('[data-repo-row]');
    for (var i = 0; i < rows.length; i++) {
      rows[i].style.display = rows[i].getAttribute('data-repo-name').indexOf(q) === -1 ? 'none' : 'flex';
    }
  });
})();
</script>`;

function renderRecentRuns(runs: RecentRuns | undefined): string {
  const heading = `<div class="form-label" style="margin-top:16px">Recent runs</div>`;
  if (!runs) {
    return `<div data-recent-runs="error">${heading}<p style="font-size:12px;color:var(--vos-text-muted, #6b7280);margin:4px 0 0">Recent runs are unavailable right now.</p></div>`;
  }
  if (runs.length === 0) {
    return `<div data-recent-runs="empty">${heading}<p class="empty-state" style="margin:4px 0 0">This cron has not fired yet.</p></div>`;
  }
  const rows = recentTriggers(runs)
    .map((t) => `<li>${escapeHtml(formatTriggerRow(t))}</li>`)
    .join("");
  return `<div data-recent-runs="list">${heading}<ul style="font-size:13px;margin:4px 0 0;padding-left:20px">${rows}</ul></div>`;
}

function renderCronCard(c: SystemCronItem, opts: PageOpts): string {
  const id = encodeURIComponent(c.id);
  const draft = opts.draft?.id === c.id ? opts.draft : undefined;
  const title = draft?.titleTemplate ?? c.titleTemplate;
  const description = draft?.descriptionTemplate ?? c.descriptionTemplate;
  const toggleLabel = c.enabled ? "Disable" : "Enable";
  return `<div class="card" data-system-cron="${escapeHtml(c.id)}">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
      <span>${escapeHtml(c.name)} <code style="font-size:12px;color:var(--vos-text-muted, #6b7280)">${escapeHtml(c.id)}</code></span>
      <span style="display:flex;align-items:center;gap:8px">
        <span class="badge">${c.enabled ? "Enabled" : "Disabled"}</span>
        <form method="POST" action="${SYSTEM_CRONS_SETTINGS_PATH}/${id}/${c.enabled ? "disable" : "enable"}" style="margin:0">
          <button type="submit" class="btn btn-secondary" style="font-size:12px">${toggleLabel}</button>
        </form>
      </span>
    </div>
    <p style="font-size:12px;color:var(--vos-text-muted, #6b7280);margin:0 0 12px">Schedule <code>${escapeHtml(c.schedule)}</code> (${escapeHtml(c.timezone)}) · Scope <span data-scope-summary>${escapeHtml(scopeSummary(c))}</span></p>
    <form method="POST" action="${SYSTEM_CRONS_SETTINGS_PATH}/${id}">
      <div class="form-group">
        <label class="form-label" for="titleTemplate-${escapeHtml(c.id)}">Title template</label>
        <input id="titleTemplate-${escapeHtml(c.id)}" name="titleTemplate" type="text" class="form-input" value="${escapeHtml(title)}" />
      </div>
      <div class="form-group">
        <label class="form-label" for="descriptionTemplate-${escapeHtml(c.id)}">Description template</label>
        <textarea id="descriptionTemplate-${escapeHtml(c.id)}" name="descriptionTemplate" class="form-input" rows="4">${escapeHtml(description)}</textarea>
        <p style="font-size:12px;color:var(--vos-text-muted, #6b7280);margin:4px 0 0"><code>{repo}</code> is replaced with the org/repo; nothing else is evaluated.</p>
      </div>
      ${renderScopeControl(c, draft, opts.repoListings?.[accountKey(c)])}
      <button type="submit" class="btn btn-primary">Save</button>
    </form>
    ${renderRecentRuns(opts.recentRuns?.[c.id])}
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
    body: renderSettingsLayout({
      userName: opts.userEmail,
      title: "System crons",
      nav: opts.nav,
      active: SYSTEM_CRONS_SETTINGS_PATH,
      isAdmin: true,
      body: `${banner}${degraded}${notice}${error}${warnings}
    ${cards}${opts.crons.length > 0 ? SCOPE_SCRIPT : ""}`,
    }),
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
    const recentRuns: Record<string, RecentRuns> = {};
    const fetchTriggers = deps.fetchSystemCronTriggers;
    await Promise.all(
      crons.map(async (cron) => {
        try {
          recentRuns[cron.id] = fetchTriggers
            ? (await fetchTriggers(cron.id, RECENT_RUNS_LIMIT)).triggers
            : null;
        } catch {
          recentRuns[cron.id] = null;
        }
      }),
    );
    // One listing per distinct account; each cron's checklist renders from its own.
    const repoListings: NonNullable<PageOpts["repoListings"]> = {};
    const lookup = deps.githubLookup;
    if (lookup) {
      await Promise.all(
        [...new Set(crons.map((cron) => cron.accountId ?? null))].map(
          async (accountId) => {
            try {
              repoListings[accountId ?? ""] = toRepoListing(
                await lookup.listRepositories(accountId),
              );
            } catch {
              repoListings[accountId ?? ""] = { state: "failed" };
            }
          },
        ),
      );
    }
    const noticeKey = c.req.query("notice");
    const errorKey = c.req.query("error");
    return deps.html(
      renderSystemCronsPage({
        userEmail: c.var.userEmail,
        nav: getSettingsNav(c) ?? { sections: [] },
        crons,
        recentRuns,
        repoListings,
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
      const rawScope = {
        repoScope: form.get("repoScope")?.toString(),
        repos: form.getAll("repos").map((r) => r.toString()),
      };
      const result = validateTemplateForm(raw);
      const scope = validateScopeForm(rawScope);
      if (!result.ok || !scope.ok) {
        return renderPage(c, {
          error: [
            ...(result.ok ? [] : result.errors),
            ...(scope.ok ? [] : scope.errors),
          ].join(" "),
          draft: {
            id,
            titleTemplate: raw.titleTemplate ?? "",
            descriptionTemplate: raw.descriptionTemplate ?? "",
            repoScope: rawScope.repoScope,
            repos: rawScope.repos,
          },
          status: 400,
        });
      }
      try {
        const updated = await deps.patchSystemCron(id, {
          ...result.value,
          ...scope.value,
        });
        if (updated === null) return fail("not_found");
      } catch {
        return fail("update_failed");
      }
      return ok("saved");
    },
  );
}
