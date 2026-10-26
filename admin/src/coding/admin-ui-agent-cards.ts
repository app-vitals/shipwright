/**
 * admin/src/coding/admin-ui-agent-cards.ts
 * The coding extension's agent detail page cards (Recent Verification
 * Activity, GitHub installations, phase methodology) and the card slots that
 * contribute them through AdminExtension.agentDetailCards. Moved out of
 * admin-ui-pages.ts / admin-ui.ts's agent detail route (AEP-3.2).
 */

import type { AgentDetailCardSlot } from "@app-vitals/agent-admin/admin-extension";
import { escapeHtml } from "@app-vitals/agent-admin/admin-ui-styles";
import type { AgentCronRunService } from "@app-vitals/agent-admin/agent-cron-runs";
import type { AgentGitHubInstallationsService } from "@app-vitals/agent-admin/agent-github-installations";
import { AGENT_PHASES } from "@app-vitals/agent-admin/openapi-schemas";
import { DEFAULT_ACCOUNT_ID } from "@app-vitals/agent-lib/default-account";
import {
  renderVerificationActivityCard,
  type VerificationCheckItem,
} from "./admin-ui-verification-cards.ts";
import type { PrListItem } from "./admin-ui-work-item-pages.ts";
import type { AgentPhaseMethodologyService } from "./agent-phase-methodology.ts";
import { buildVerificationActivityRollup } from "./verification-checks.ts";

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
 * passes in; renderPhaseMethodologyCard merges against the fixed AGENT_PHASES
 * set to show "default" for phases with no row here).
 */
export interface PhaseMethodologyItem {
  phase: string;
  subagentType: string | null;
}

/**
 * The Phase Methodology card (PMC-1.2): one row per fixed AGENT_PHASES entry,
 * each with a Save form posting to the coding UI's phase-methodology route.
 * Only overridden phases need to be present in `phaseMethodology`; any phase
 * absent there renders "default".
 */
export function renderPhaseMethodologyCard(
  agentId: string,
  phaseMethodology: readonly PhaseMethodologyItem[],
): string {
  const phaseMethodologyByPhase = new Map(
    phaseMethodology.map((pm) => [pm.phase, pm.subagentType]),
  );
  const phaseMethodologyRows = AGENT_PHASES.map((phase) => {
    const subagentType = phaseMethodologyByPhase.get(phase) ?? null;
    return `<tr>
      <td class="mono">${escapeHtml(phase)}</td>
      <td>${subagentType ? escapeHtml(subagentType) : '<span style="color:#9ca3af">default</span>'}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/agents/${escapeHtml(agentId)}/phase-methodology/${escapeHtml(phase)}" style="display:flex;gap:4px">
          <input name="subagentType" type="text" class="form-input" style="font-size:11px;padding:3px 6px" placeholder="default" value="${subagentType ? escapeHtml(subagentType) : ""}" />
          <button type="submit" class="btn btn-secondary" style="font-size:11px;padding:3px 8px">Save</button>
        </form>
      </td>
    </tr>`;
  }).join("\n");

  return `<div class="card">
      <div class="card-title">Phase Methodology</div>
      <p style="font-size:12px;color:#6b7280;margin-bottom:12px">
        Override which subagent type handles each pipeline phase. Clear the field and Save to fall back to the default.
      </p>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Phase</th>
              <th>Subagent Type</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${phaseMethodologyRows}
          </tbody>
        </table>
      </div>
    </div>`;
}

/** Deps for the coding extension's agent detail card slots. */
export interface CodingAgentDetailCardDeps {
  agentCronRunService: Pick<AgentCronRunService, "listForAgent">;
  agentPhaseMethodologyService: Pick<AgentPhaseMethodologyService, "list">;
  /** Absent → the GitHub installations card renders nothing. */
  agentGitHubInstallationsService?: Pick<
    AgentGitHubInstallationsService,
    "get"
  >;
  /** Absent → the verification activity card renders nothing. */
  fetchVerificationChecks?: (
    params: URLSearchParams,
    accountId?: string,
  ) => Promise<{ checks: VerificationCheckItem[]; total?: number }>;
  fetchTaskStorePrs?: (
    params: URLSearchParams,
    accountId?: string,
  ) => Promise<{ prs: PrListItem[] }>;
}

/**
 * The coding extension's cards on the agent detail page, in page order:
 * Recent Verification Activity and GitHub Installations in the header, Phase
 * Methodology in the Configuration group. Each slot always renders (possibly
 * an empty string) so the header keeps its fixed layout.
 */
export function codingAgentDetailCards(
  deps: CodingAgentDetailCardDeps,
): AgentDetailCardSlot[] {
  return [
    {
      name: "verification-activity",
      // Lightweight rollup of recent verification-check activity (LVB-5.3 AC2)
      // across this agent's recently-dispatched tasks/PRs — see
      // buildVerificationActivityRollup()'s doc comment for why this reuses
      // cron-run dispatch targets rather than a dedicated task-store query.
      // SSP-6.8: a non-admin's rollup reads only the agent's own account, so
      // a repo#number shared with another account can't surface its checks.
      render: async (ctx) => {
        const recentRuns = await deps.agentCronRunService.listForAgent(
          ctx.agentId,
          { limit: 20 },
        );
        const accountId = ctx.isAdmin
          ? undefined
          : (ctx.accountId ?? DEFAULT_ACCOUNT_ID);
        const { fetchVerificationChecks, fetchTaskStorePrs } = deps;
        const verificationActivity = await buildVerificationActivityRollup(
          recentRuns.items,
          fetchVerificationChecks &&
            ((params) => fetchVerificationChecks(params, accountId)),
          fetchTaskStorePrs &&
            ((params) => fetchTaskStorePrs(params, accountId)),
        );
        return renderVerificationActivityCard(verificationActivity);
      },
    },
    {
      name: "github-installations",
      // Stored snapshot only — admin never calls GitHub or the agent here.
      // A read failure just omits the card.
      render: async (ctx) => {
        const githubInstallations =
          (await deps.agentGitHubInstallationsService
            ?.get(ctx.agentId)
            .catch(() => null)) ?? null;
        return renderGitHubInstallationsCard(
          githubInstallations && {
            reportedAt: githubInstallations.reportedAt,
            installations:
              githubInstallations.installations as GitHubInstallationsCardData["installations"],
          },
          new Date(),
          ctx.timezone ?? "UTC",
        );
      },
    },
    {
      name: "phase-methodology",
      placement: "configuration",
      render: async (ctx) => {
        const phaseMethodology = await deps.agentPhaseMethodologyService.list(
          ctx.agentId,
        );
        return renderPhaseMethodologyCard(
          ctx.agentId,
          phaseMethodology.map((pm) => ({
            phase: pm.phase,
            subagentType: pm.subagentType,
          })),
        );
      },
    },
  ];
}
