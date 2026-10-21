/**
 * admin/src/coding/admin-ui-agent-cards.ts
 * The coding extension's agent detail page cards (GitHub installations,
 * phase methodology). Moved out of admin-ui-pages.ts (AEP-3.2).
 */

import { escapeHtml } from "../admin-ui-styles.ts";

export interface GitHubInstallationsCardData {
  reportedAt: Date | string;
  installations: Array<{
    owner: string;
    installationId: number;
    state: string;
    lastError?: string | null;
  }>;
}

/** A snapshot older than this renders a stale warning (MGI-4.3). */
const GITHUB_INSTALLATIONS_STALE_MS = 90 * 60 * 1000;

function githubInstallationStateBadge(state: string): string {
  switch (state) {
    case "ok":
    case "active":
    case "in_scope":
      return '<span class="badge badge-green">in scope</span>';
    case "not_in_scope":
    case "discovered":
      return '<span class="badge badge-gray">discovered, not in scope</span>';
    case "broken":
      return '<span class="badge badge-warning">broken</span>';
    case "pinned":
      return '<span class="badge badge-teal">pinned</span>';
    default:
      return `<span class="badge badge-gray">${escapeHtml(state)}</span>`;
  }
}

/**
 * Renders the "GitHub Installations" card on the agent detail page (MGI-4.3)
 * from the snapshot the agent last pushed. Returns "" when there is no
 * snapshot. Read-only: admin never calls GitHub or the agent for this.
 */
export function renderGitHubInstallationsCard(
  snapshot: GitHubInstallationsCardData | null | undefined,
  now: Date,
  timezone: string,
): string {
  if (!snapshot) return "";
  const reported = new Date(snapshot.reportedAt);
  const validDate = !Number.isNaN(reported.getTime());
  const fmt = validDate
    ? reported.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: timezone,
      })
    : String(snapshot.reportedAt);
  const stale =
    validDate &&
    now.getTime() - reported.getTime() > GITHUB_INSTALLATIONS_STALE_MS;
  const staleHtml = stale
    ? `<div class="alert alert-warning">Stale: last reported ${escapeHtml(fmt)} (over 90 minutes ago). The agent may be down or unable to reach admin.</div>`
    : "";
  const rows =
    snapshot.installations.length === 0
      ? `<tr><td colspan="3" style="padding:8px 12px;color:#9ca3af;font-size:13px">No installations reported.</td></tr>`
      : snapshot.installations
          .map(
            (i) => `<tr>
      <td style="padding:8px 12px;font-size:13px;font-family:monospace">${escapeHtml(i.owner)}</td>
      <td style="padding:8px 12px;font-size:13px">${githubInstallationStateBadge(i.state)}</td>
      <td style="padding:8px 12px;font-size:13px;color:#6b7280">${i.lastError ? escapeHtml(i.lastError) : ""}</td>
    </tr>`,
          )
          .join("");
  return `<div class="card" id="github-installations" style="margin-bottom:16px">
      <div class="card-title">GitHub Installations</div>
      ${staleHtml}
      <table class="detail-table"><thead><tr><th>Owner</th><th>State</th><th>Last error</th></tr></thead><tbody>
        ${rows}
      </tbody></table>
      <div style="font-size:11px;color:#9ca3af;margin-top:8px" title="${escapeHtml(String(snapshot.reportedAt instanceof Date ? snapshot.reportedAt.toISOString() : snapshot.reportedAt))}">Reported ${escapeHtml(fmt)}</div>
    </div>`;
}

/**
 * View-model row for the Phase Methodology panel — one per configured
 * override (unconfigured phases are simply absent from the list the caller
 * passes in; renderAgentDetailPage merges against the fixed AGENT_PHASES set
 * to show "default" for phases with no row here).
 */
export interface PhaseMethodologyItem {
  phase: string;
  subagentType: string | null;
}
