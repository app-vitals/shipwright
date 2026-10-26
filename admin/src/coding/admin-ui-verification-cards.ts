/**
 * admin/src/coding/admin-ui-verification-cards.ts
 * Verification-check rendering (LVB-5.x): the task/PR detail "Verification
 * Checks" card and the agent detail "Recent Verification Activity" rollup.
 * Moved out of admin-ui-pages.ts (AEP-3.2).
 */

import { escapeHtml } from "@app-vitals/agent-admin/admin-ui-styles";

// Inline type mirroring VerificationCheck fields (LVB-5.1,
// task-store/src/openapi-schemas.ts's VerificationCheckSchema) without
// cross-package coupling to @shipwright/task-store — same convention as the
// other inline type mirrors in this file (PrListItem, TaskItem, etc).
export interface VerificationCheckItem {
  id: string;
  taskId: string | null;
  prRecordId: string | null;
  repo: string;
  checkName: string;
  /** "ran_passed" | "ran_failed" | "skipped" | "timed_out" */
  status: string;
  reasonCategory: string | null;
  learnedFromCategory: string | null;
  durationMs: number | null;
  at: string;
  createdAt: string;
}

/**
 * Lightweight, pre-aggregated rollup of recent verification-check activity
 * across an agent's recently-dispatched tasks/PRs — backs the agent detail
 * page's "Recent Verification Activity" card (LVB-5.3 AC2). Computed by the
 * caller (admin-ui.ts's agent-detail route) from a bounded set of recent
 * cron-run dispatch targets; this module only renders it.
 */
export interface VerificationActivitySummary {
  /** Total verification-check rows counted across the sampled items. */
  totalChecks: number;
  /** Number of distinct tasks/PRs whose checks contributed to this rollup. */
  itemCount: number;
  /** Counts keyed by VerificationCheckStatus (e.g. "ran_passed": 9). */
  counts: Record<string, number>;
  /**
   * Same counts as `counts`, broken down per checkName (checkName ->
   * VerificationCheckStatus -> count) — lets the rollup card show a per-check
   * breakdown (e.g. "lint: 2 passed, 1 failed") alongside the aggregate line.
   * Optional for backward compatibility with existing callers/fixtures that
   * predate this field; buildVerificationActivityRollup always populates it.
   */
  byCheckName?: Record<string, Record<string, number>>;
  /**
   * Same counts as `counts`, broken down per repo (repo -> VerificationCheckStatus
   * -> count) — lets the rollup card show which repo an agent's verification
   * activity happened in when it spans more than one (VEA-1.1). Optional for
   * backward compatibility with existing callers/fixtures that predate this
   * field; buildVerificationActivityRollup always populates it.
   */
  byRepo?: Record<string, Record<string, number>>;
  /**
   * Environmental-cause breakdown (repo -> VerificationCheckReasonCategory ->
   * count), built only from rows where reasonCategory is non-null — i.e. only
   * `skipped`/`timed_out` rows (VEA-1.1). `ran_failed` rows never contribute
   * here: reasonCategory is guardrailed in
   * task-store/src/verification-check-service.ts to never be set on a
   * `ran_failed` row. Optional for backward compatibility with existing
   * callers/fixtures that predate this field; buildVerificationActivityRollup
   * always populates it.
   */
  environmentalByRepo?: Record<string, Record<string, number>>;
}

// Inline CSS + labels for verification-check status badges, keyed by the raw
// VerificationCheckStatus value. Shared by the task/PR detail "Verification
// Checks" card and the agent detail "Recent Verification Activity" rollup.
const VERIFICATION_STATUS_STYLE: Record<string, string> = {
  ran_passed: "background:#d1fae5;color:#065f46",
  ran_failed: "background:#fee2e2;color:#991b1b",
  skipped: "background:#f3f4f6;color:#6b7280",
  timed_out: "background:#fde68a;color:#92400e",
};
const VERIFICATION_STATUS_STYLE_DEFAULT = "background:#f3f4f6;color:#6b7280";
const VERIFICATION_STATUS_LABEL: Record<string, string> = {
  ran_passed: "passed",
  ran_failed: "failed",
  skipped: "skipped",
  timed_out: "timed out",
};
const VERIFICATION_STATUS_ORDER = [
  "ran_passed",
  "ran_failed",
  "skipped",
  "timed_out",
];

/** Human label for a verification-check status, falling back to the raw value for an unrecognized status. */
function verificationStatusLabel(status: string): string {
  return VERIFICATION_STATUS_LABEL[status] ?? status;
}

// Inline labels for VerificationCheck.reasonCategory values — the closed set
// of environmental causes a `skipped`/`timed_out` row can carry (see
// task-store/src/openapi-schemas.ts's VerificationCheckSchema). Mirrors the
// VERIFICATION_STATUS_LABEL pattern above. `ran_passed`/`ran_failed` rows
// never carry a reasonCategory (write-path guardrail in
// task-store/src/verification-check-service.ts), so this map only ever
// backs the "Environmental issues" sub-section, never a status badge.
const VERIFICATION_REASON_CATEGORY_LABEL: Record<string, string> = {
  missing_tool: "missing tool",
  missing_secret: "missing secret",
  missing_dependency: "missing dependency",
  not_configured: "not configured",
  check_timeout: "check timed out",
  install_timeout: "install timed out",
  resource_limit: "resource limit hit",
  learned_skip: "learned skip",
};
const VERIFICATION_REASON_CATEGORY_ORDER = [
  "missing_tool",
  "missing_secret",
  "missing_dependency",
  "not_configured",
  "check_timeout",
  "install_timeout",
  "resource_limit",
  "learned_skip",
];
const VERIFICATION_REASON_CATEGORY_STYLE = "background:#fde68a;color:#92400e";

/** Human label for a reasonCategory value, falling back to the raw value for an unrecognized one. */
function verificationReasonCategoryLabel(reasonCategory: string): string {
  return VERIFICATION_REASON_CATEGORY_LABEL[reasonCategory] ?? reasonCategory;
}

/** Renders one badge per non-zero reasonCategory count, in VERIFICATION_REASON_CATEGORY_ORDER. */
function renderReasonCategoryCountBadges(
  counts: Record<string, number>,
): string {
  return VERIFICATION_REASON_CATEGORY_ORDER.map((reasonCategory) => {
    const count = counts[reasonCategory] ?? 0;
    if (count === 0) return "";
    return `<span style="margin-right:12px;font-size:13px"><span class="badge" style="${VERIFICATION_REASON_CATEGORY_STYLE}">${escapeHtml(verificationReasonCategoryLabel(reasonCategory))}</span> ${count}</span>`;
  })
    .filter(Boolean)
    .join("");
}

/** Renders a status badge for a verification-check row, styled by status. */
function verificationStatusBadge(status: string): string {
  const style =
    VERIFICATION_STATUS_STYLE[status] ?? VERIFICATION_STATUS_STYLE_DEFAULT;
  return `<span class="badge" style="${style}">${escapeHtml(verificationStatusLabel(status))}</span>`;
}

/**
 * Reduces a task/PR's verification-check history down to the most recent run
 * per checkName (a task/PR can have many rows per checkName, one per run over
 * time — see task-store/src/routes/verification-checks.ts). Sorted by
 * checkName for stable, deterministic rendering.
 */
export function mostRecentVerificationChecksByCheckName(
  checks: VerificationCheckItem[],
): VerificationCheckItem[] {
  const latestByName = new Map<string, VerificationCheckItem>();
  for (const check of checks) {
    const existing = latestByName.get(check.checkName);
    if (
      !existing ||
      new Date(check.at).getTime() > new Date(existing.at).getTime()
    ) {
      latestByName.set(check.checkName, check);
    }
  }
  return [...latestByName.values()].sort((a, b) =>
    a.checkName.localeCompare(b.checkName),
  );
}

/**
 * Renders the "Verification Checks" card shared by the task detail and PR
 * detail pages (LVB-5.3 AC1) — one row per checkName, showing only the most
 * recent run's status + reason. Returns "" when there are no checks, so
 * tasks/PRs predating LVB-5.1 (or not yet reported by LVB-5.2) render exactly
 * as before, no empty card.
 */
export function renderVerificationChecksCard(
  checks: VerificationCheckItem[],
  timezone: string,
): string {
  const mostRecent = mostRecentVerificationChecksByCheckName(checks);
  if (mostRecent.length === 0) return "";
  const rows = mostRecent
    .map((check) => {
      const d = new Date(check.at);
      const fmt = Number.isNaN(d.getTime())
        ? check.at
        : d.toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: timezone,
          });
      const reasonHtml = check.reasonCategory
        ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px">${escapeHtml(check.reasonCategory)}</div>`
        : "";
      return `<tr>
      <td style="width:170px;padding:8px 12px;color:#6b7280;font-size:12px;font-weight:500;vertical-align:top;white-space:nowrap;font-family:monospace">${escapeHtml(check.checkName)}</td>
      <td style="padding:8px 12px;font-size:13px">${verificationStatusBadge(check.status)}${reasonHtml}</td>
      <td style="padding:8px 12px;font-size:13px;color:#6b7280" title="${escapeHtml(check.at)}">${escapeHtml(fmt)}</td>
    </tr>`;
    })
    .join("");
  return `<div class="card" style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Verification Checks</div>
      <table class="detail-table"><tbody>
        ${rows}
      </tbody></table>
    </div>`;
}

/**
 * Renders the "Recent Verification Activity" rollup card on the agent detail
 * page (LVB-5.3 AC2) — a lightweight counts-by-status summary, not a full
 * history browser. Returns "" only when the summary is absent (the fetcher
 * isn't configured, so there is nothing to show); a zero-check summary
 * renders an explicit empty state rather than hiding the card.
 */
/** Renders one badge per non-zero status count, in VERIFICATION_STATUS_ORDER. */
function renderStatusCountBadges(counts: Record<string, number>): string {
  return VERIFICATION_STATUS_ORDER.map((status) => {
    const count = counts[status] ?? 0;
    if (count === 0) return "";
    return `<span style="margin-right:12px;font-size:13px">${verificationStatusBadge(status)} ${count}</span>`;
  })
    .filter(Boolean)
    .join("");
}

export function renderVerificationActivityCard(
  summary?: VerificationActivitySummary,
): string {
  if (!summary) return "";
  if (summary.totalChecks === 0) {
    return `<div class="card">
      <div class="card-title">Recent Verification Activity</div>
      <div style="font-size:13px;color:#6b7280">No recent verification checks recorded</div>
    </div>`;
  }
  const badges = renderStatusCountBadges(summary.counts);
  const byCheckName = summary.byCheckName ?? {};
  const checkNameRows = Object.keys(byCheckName)
    .sort()
    .map((checkName) => {
      const checkBadges = renderStatusCountBadges(byCheckName[checkName]);
      return `<div style="margin-bottom:6px">
        <span style="display:inline-block;min-width:100px;font-size:12px;font-family:monospace;color:#6b7280">${escapeHtml(checkName)}</span>
        ${checkBadges}
      </div>`;
    })
    .join("");

  // Per-repo status breakdown — only worth its own sub-section once the
  // rollup spans more than one repo; a single-repo rollup is already fully
  // covered by the top-line summary above.
  const byRepo = summary.byRepo ?? {};
  const repoKeys = Object.keys(byRepo);
  const repoSection =
    repoKeys.length > 1
      ? `<div style="font-size:11px;font-weight:600;color:#374151;margin:12px 0 6px;text-transform:uppercase;letter-spacing:.05em">By repo</div>
      <div>${repoKeys
        .sort()
        .map((repo) => {
          const repoBadges = renderStatusCountBadges(byRepo[repo]);
          return `<div style="margin-bottom:6px">
        <span style="display:inline-block;min-width:140px;font-size:12px;font-family:monospace;color:#6b7280">${escapeHtml(repo)}</span>
        ${repoBadges}
      </div>`;
        })
        .join("")}</div>`
      : "";

  // Environmental issues — the WHY behind skipped/timed_out rows (VEA-1.1).
  // Always rendered, including an explicit all-clear line, so "no
  // environmental issues" is a visible, actionable signal rather than an
  // absent section that reads as "not checked".
  const environmentalByRepo = summary.environmentalByRepo ?? {};
  const environmentalRepoKeys = Object.keys(environmentalByRepo).filter(
    (repo) =>
      Object.values(environmentalByRepo[repo]).some((count) => count > 0),
  );
  const environmentalRows =
    environmentalRepoKeys.length > 0
      ? environmentalRepoKeys
          .sort()
          .map((repo) => {
            const reasonBadges = renderReasonCategoryCountBadges(
              environmentalByRepo[repo],
            );
            return `<div style="margin-bottom:6px">
        <span style="display:inline-block;min-width:140px;font-size:12px;font-family:monospace;color:#6b7280">${escapeHtml(repo)}</span>
        ${reasonBadges}
      </div>`;
          })
          .join("")
      : `<div style="font-size:13px;color:#6b7280">No environmental issues in recent runs</div>`;
  const environmentalSection = `<div style="font-size:11px;font-weight:600;color:#374151;margin:12px 0 6px;text-transform:uppercase;letter-spacing:.05em">Environmental issues</div>
      <div>${environmentalRows}</div>`;

  return `<div class="card">
      <div class="card-title">Recent Verification Activity</div>
      <div style="font-size:13px;color:#6b7280;margin-bottom:10px">${summary.totalChecks} check${summary.totalChecks === 1 ? "" : "s"} across ${summary.itemCount} recent item${summary.itemCount === 1 ? "" : "s"}</div>
      <div style="margin-bottom:10px">${badges}</div>
      <div>${checkNameRows}</div>
      ${repoSection}
      ${environmentalSection}
    </div>`;
}
