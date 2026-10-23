/**
 * agent/src/admin-ui-pages.ts
 * Pure HTML rendering functions for admin UI pages.
 * No Hono dependencies — pure string → string functions.
 *
 * Follows the same inline HTML template string pattern as
 * metrics/src/dashboard/dashboard-page.ts.
 *
 * Platform pages only: the coding agent's task/PR/session/queue pages live in
 * coding/ (AEP-3.2) and are mounted by the coding AdminExtension.
 */

import { PROGRESS_LABELS } from "@shipwright/lib/progress-phases";
import { renderAdminPage } from "./admin-ui-layout.ts";
import {
  BREAKPOINT_MOBILE_MAX,
  escapeHtml,
  renderAdminToolbar,
} from "./admin-ui-styles.ts";
import type { ManualStep } from "./agent-deletion-checklist.ts";
import type { SpecialtyOption } from "./specialty-manifest-loader.ts";
import { isAudioFilename } from "./attachment-validation.ts";
import { parseChatMarkers } from "./chat-markers.ts";
import type {
  ChatMessage,
  ChatThread,
  MessageTokens,
  ThreadStats,
} from "./http-chat-client.ts";
import { renderPushToggle } from "./push-toggle.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns a human-friendly relative timestamp.
 * Examples: "just now", "5 minutes ago", "2 hours ago", "3 days ago", "1 week ago"
 *
 * @param date - the timestamp to describe
 * @param now  - the reference "current" time (defaults to wall clock; override in tests for determinism)
 */
export function relativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return `${diffWeek} week${diffWeek === 1 ? "" : "s"} ago`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentListItem {
  id: string;
  name: string;
  slackId: string | null;
  createdAt: Date;
  selfHosted?: boolean;
  accountId?: string | null;
}

export interface AgentDetail {
  id: string;
  name: string;
  slackId: string | null;
  selfHosted: boolean;
  createdAt: Date;
  updatedAt: Date;
  repos: string[];
  authorAllowlist: string[];
  patchAuthorAllowlist: string[];
  /**
   * When true, only AgentMember emails may message this agent over Slack.
   * Rendered as a checkbox on both the create and edit forms.
   */
  restrictSlackToMembers: boolean;
  /** The agent's type name (e.g. "coding"), resolved at creation time. */
  typeName: string;
  /**
   * Required env keys declared by the agent's type manifest with no
   * corresponding AgentEnv row yet — key names only, never values. Always
   * present; purely informational (ATS-4.2), see renderAgentDetailPage's Env
   * Vars card.
   */
  missingRequiredEnv: string[];
  /**
   * APM-1.3: the six real agent-policy fields (APM-1.1 DB columns), surfaced
   * in the "Agent Policy" card. Callers resolve
   * Prisma-column defaults (`?? true`/`?? false`/`?? 75`/`?? 5`/`?? 14`)
   * before building this literal — see admin-ui.ts's two `agentDetail:
   * AgentDetail = {...}` build sites.
   */
  autoPostReviews: boolean;
  allowSelfReview: boolean;
  minConfidence: number;
  maxFindings: number;
  cleanupMergedWorktrees: boolean;
  cleanupAfterDays: number;
  /**
   * PAI-2.5: owner and Anthropic identity, shown in the "Owner & Anthropic
   * identity" card. Optional so literal builds that predate the fields stay
   * valid; null or absent renders an em dash placeholder.
   */
  ownerEmail?: string | null;
  anthropicIdentityName?: string | null;
  anthropicServiceAccountId?: string | null;
  anthropicFederationRuleId?: string | null;
}

export interface CronJobItem {
  id: string;
  schedule: string;
  prompt: string;
  channel: string | null;
  user: string | null;
  enabled: boolean;
  name: string | null;
  system: boolean;
  parentCronId: string | null;
  preCheck?: string | null;
  lastRun?: {
    startedAt: Date;
    completedAt: Date | null;
    skipped: boolean;
    outcome: string | null;
  } | null;
  runCountToday?: number;
  createdAt: Date;
}

// Inline CSS for cron-run outcome badges, keyed by outcome string.
// Shared by the cron rows on the agent detail page and the cron runs page.
const CRON_OUTCOME_STYLE: Record<string, string> = {
  posted: "background:#22c55e;color:white",
  dm: "background:#3b82f6;color:white",
  silent: "background:#9ca3af;color:white",
  skipped: "background:#f59e0b;color:white",
  error: "background:#ef4444;color:white",
};
const CRON_OUTCOME_STYLE_DEFAULT = "background:#9ca3af;color:white";

/** Resolve the badge style for a cron outcome, falling back to a neutral gray. */
export function cronOutcomeStyle(outcome: string | null | undefined): string {
  return CRON_OUTCOME_STYLE[outcome ?? ""] ?? CRON_OUTCOME_STYLE_DEFAULT;
}

/** Label for a cron run's outcome badge — "skipped" takes priority over outcome. */
export function cronRunOutcomeLabel(run: {
  skipped: boolean;
  outcome: string | null;
}): string {
  return run.skipped ? "skipped" : (run.outcome ?? "unknown");
}

export interface ToolItem {
  id: string;
  pattern: string;
  enabled: boolean;
  createdAt: Date;
}

export interface TokenItem {
  id: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface PluginItem {
  id: string;
  name: string;
  version: string | null;
  enabled: boolean;
  createdAt: Date;
}

export interface MemberItem {
  id: string;
  email: string;
  createdAt: Date;
}

// ─── Inline markdown renderer ─────────────────────────────────────────────────

/**
 * Render a markdown string to safe HTML.
 * HTML is escaped FIRST to prevent XSS, then markdown patterns are applied
 * to generate a known-safe set of HTML tags.
 */
export function renderMarkdown(text: string): string {
  // Step 1: escape all HTML entities so raw user input can't inject tags
  let out = escapeHtml(text);

  // Step 2: extract code blocks into placeholder tokens before line processing
  // so that interior lines of a fenced block are never handed to the line loop.
  const codeBlocks: string[] = [];
  // Use Unicode Private Use Area sentinels — never appear in HTML-escaped markdown,
  // and are not control characters (biome noControlCharactersInRegex safe).
  const PLACEHOLDER_PREFIX = "CODE_BLOCK_";
  const PLACEHOLDER_SUFFIX = "";
  const placeholder = (n: number) =>
    `${PLACEHOLDER_PREFIX}${n}${PLACEHOLDER_SUFFIX}`;
  const PLACEHOLDER_RE = /^CODE_BLOCK_(\d+)$/;

  // Multi-line fenced blocks: ```\n...\n```
  out = out.replace(/```[\r\n]([\s\S]*?)[\r\n]```/g, (_m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return placeholder(idx);
  });
  // Same-line fenced blocks: ```code```
  out = out.replace(/```([^`\n]+)```/g, (_m, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${code}</code></pre>`);
    return placeholder(idx);
  });

  // Step 3: process line-by-line for block-level elements
  const lines = out.split("\n");
  const result: string[] = [];
  let inUl = false;
  let inOl = false;

  const closeList = () => {
    if (inUl) {
      result.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      result.push("</ol>");
      inOl = false;
    }
  };

  for (const line of lines) {
    // Placeholder lines are pre-rendered code blocks — emit as-is
    const placeholderMatch = PLACEHOLDER_RE.exec(line);
    if (placeholderMatch) {
      closeList();
      result.push(codeBlocks[Number.parseInt(placeholderMatch[1], 10)]);
      continue;
    }

    // Headings
    const h3 = line.match(/^### (.+)$/);
    const h2 = line.match(/^## (.+)$/);
    const h1 = line.match(/^# (.+)$/);

    if (h3) {
      closeList();
      result.push(`<h3>${applyInline(h3[1])}</h3>`);
    } else if (h2) {
      closeList();
      result.push(`<h2>${applyInline(h2[1])}</h2>`);
    } else if (h1) {
      closeList();
      result.push(`<h1>${applyInline(h1[1])}</h1>`);
    } else if (/^[-*] /.test(line)) {
      // Unordered list item
      if (inOl) {
        closeList();
      }
      if (!inUl) {
        result.push("<ul>");
        inUl = true;
      }
      result.push(`<li>${applyInline(line.replace(/^[-*] /, ""))}</li>`);
    } else if (/^\d+\. /.test(line)) {
      // Ordered list item
      if (inUl) {
        closeList();
      }
      if (!inOl) {
        result.push("<ol>");
        inOl = true;
      }
      result.push(`<li>${applyInline(line.replace(/^\d+\. /, ""))}</li>`);
    } else if (line.trim() === "") {
      closeList();
      result.push("");
    } else {
      closeList();
      result.push(applyInline(line));
    }
  }
  closeList();

  return result.join("\n");
}

/** Apply inline markdown transforms (bold, inline code) to an already-escaped string. */
function applyInline(s: string): string {
  // Inline code: `code` — must come before bold to avoid double-processing
  const withCode = s.replace(
    /`([^`]+)`/g,
    (_m, code) => `<code>${code}</code>`,
  );
  // Bold: **text**
  return withCode.replace(
    /\*\*([^*]+)\*\*/g,
    (_m, text) => `<strong>${text}</strong>`,
  );
}

// ─── Login page ───────────────────────────────────────────────────────────────

export function renderLoginPage(opts?: {
  error?: string;
  returnTo?: string;
  googleEnabled?: boolean;
  oktaEnabled?: boolean;
}): string {
  const googleEnabled = opts?.googleEnabled ?? true;
  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const googleHref = opts?.returnTo
    ? `/admin/auth/google?returnTo=${encodeURIComponent(opts.returnTo)}`
    : "/admin/auth/google";

  const oktaHref = opts?.returnTo
    ? `/admin/auth/okta?returnTo=${encodeURIComponent(opts.returnTo)}`
    : "/admin/auth/okta";

  const googleButtonHtml = googleEnabled
    ? `<a href="${googleHref}" class="btn btn-primary" style="width:100%;justify-content:center;text-decoration:none">Sign in with Google</a>`
    : "";

  const oktaButtonHtml = opts?.oktaEnabled
    ? `<a href="${oktaHref}" class="btn btn-primary" style="width:100%;justify-content:center;text-decoration:none">Sign in with Okta</a>`
    : "";

  const noProviderHtml =
    !googleEnabled && !opts?.oktaEnabled
      ? `<div class="alert alert-error">No sign-in provider is configured. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or OKTA_*.</div>`
      : "";

  return renderAdminPage({
    title: "Admin Login — Shipwright",
    body: `<div class="login-wrapper">
    <div class="login-card">
      <h1 class="login-title">Shipwright Admin</h1>
      <p class="login-subtitle">Sign in to manage your agents.</p>
      ${errorHtml}
      ${noProviderHtml}
      ${googleButtonHtml}
      ${oktaButtonHtml}
    </div>
  </div>`,
  });
}

// ─── Agents list page ─────────────────────────────────────────────────────────

export function renderAgentsPage(
  agents: AgentListItem[],
  userName: string,
  isAdmin: boolean,
  timezone: string,
  opts?: {
    successMsg?: string;
    manualSteps?: ManualStep[];
    /** Pre-rendered zero-quota notice + disabled button (replaces the CTA). */
    zeroQuotaNotice?: string;
    /**
     * accountId -> name. Admin-only (SSP-5.2): when set AND isAdmin, an
     * Account column is rendered. Ignored for non-admins.
     */
    accountNames?: Map<string, string>;
    /**
     * Render the Queue & Activity button (AEP-3.6). Only the coding extension
     * mounts /admin/agents/:id/queue-activity; absent/false omits the link.
     */
    queueActivityLinks?: boolean;
  },
): string {
  const showAccount = isAdmin && opts?.accountNames !== undefined;
  const accountCell = (a: AgentListItem): string => {
    if (!showAccount) return "";
    const name = a.accountId ? opts?.accountNames?.get(a.accountId) : undefined;
    return `<td>${a.accountId && name ? `<a href="/admin/accounts/${escapeHtml(a.accountId)}">${escapeHtml(name)}</a>` : '<span style="color:#9ca3af">—</span>'}</td>`;
  };
  const successHtml = opts?.successMsg
    ? `<div class="alert alert-success">${escapeHtml(opts.successMsg)}</div>`
    : "";

  const manualStepsHtml =
    opts?.manualSteps && opts.manualSteps.length > 0
      ? `<div class="alert alert-warning" id="manual-steps-panel" style="position:relative;padding-right:32px">
      <button type="button" onclick="document.getElementById('manual-steps-panel').style.display='none'"
              style="position:absolute;top:8px;right:10px;background:none;border:none;cursor:pointer;font-size:14px;color:inherit" aria-label="Dismiss">×</button>
      <strong>Manual cleanup required:</strong>
      <ul style="margin:8px 0 0 20px">
        ${opts.manualSteps.map((s) => `<li>${escapeHtml(s.message)}</li>`).join("\n        ")}
      </ul>
    </div>`
      : "";

  const rows =
    agents.length === 0
      ? `<tr><td colspan="${showAccount ? 5 : 4}" class="empty-state">${isAdmin ? 'No agents yet. <a href="/admin/agents/new">Create one →</a>' : "No agents."}</td></tr>`
      : agents
          .map(
            (a) => `<tr>
    <td><a href="/admin/agents/${escapeHtml(a.id)}" class="agent-link">${escapeHtml(a.name)}</a></td>
    <td class="mono">${a.slackId ? escapeHtml(a.slackId) : '<span style="color:#9ca3af">—</span>'}</td>
    ${accountCell(a)}
    <td>${escapeHtml(new Date(a.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
    <td>
      <a href="/admin/agents/${escapeHtml(a.id)}" class="btn btn-secondary" style="font-size:12px;padding:4px 10px">Manage</a>${
        opts?.queueActivityLinks
          ? `
      <a href="/admin/agents/${escapeHtml(a.id)}/queue-activity" class="btn btn-secondary" style="font-size:12px;padding:4px 10px;margin-left:4px">Queue &amp; Activity</a>`
          : ""
      }
    </td>
  </tr>`,
          )
          .join("\n");

  // Single CTA to create an agent — the /admin/agents/new page handles agent
  // creation and provides inline options to connect Slack/GitHub if desired.
  const createAgentButtons = opts?.zeroQuotaNotice
    ? opts.zeroQuotaNotice
    : isAdmin
      ? `<a href="/admin/agents/new" class="btn btn-primary">+ New agent</a>`
      : "";

  return renderAdminPage({
    title: "Agents — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Agents</h1>
      ${createAgentButtons}
    </div>
    ${successHtml}
    ${manualStepsHtml}
    <div class="card">
      <table class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Slack ID</th>
            ${showAccount ? "<th>Account</th>" : ""}
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </div>`,
  });
}

// ─── New agent page ───────────────────────────────────────────────────────────

// The three Slack/GitHub sections (restrict-slack-group, slack-section,
// github-section) are meaningless for self-hosted agents — self-hosted uses
// local git config for GitHub auth, not admin-managed provisioning — so they
// are shown only when "Provisioned in-cluster" is selected. `display` is
// either "" (visible) or "none" (hidden).
function runtimeSectionsOnchange(display: "" | "none"): string {
  const ids = ["restrict-slack-group", "slack-section", "github-section"];
  return ids
    .map((id) => `document.getElementById('${id}').style.display='${display}'`)
    .join(";");
}

export function renderNewLocalAgentPage(
  userName: string,
  types: SpecialtyOption[],
  opts?: {
    error?: string;
    canProvision?: boolean;
    /** WIF-2.1: hide the Claude credential fields (federation supplies auth). */
    anthropicFederationEnabled?: boolean;
    /**
     * Set for self-serve account users (SSP-4.2): shows the account's
     * remaining agent quota and the prerequisites, and pins the type to
     * "coding" (the server forces it regardless).
     */
    selfServe?: { remaining: number; max: number; contactEmail: string };
  },
): string {
  const error = opts?.error;
  const selfServe = opts?.selfServe;
  // WIF-2.1: with Anthropic federation enabled the server rejects these
  // credentials for in-cluster agents, so don't offer the fields at all.
  const claudeCredentialFields = opts?.anthropicFederationEnabled
    ? ""
    : `        <div class="form-group">
          <label class="form-label" for="claudeCodeOauthToken">Claude Code OAuth Token (optional)</label>
          <input
            id="claudeCodeOauthToken"
            name="claudeCodeOauthToken"
            type="password"
            class="form-input"
            placeholder="sk-ant-oat01-..."
          />
          <p style="font-size:12px;color:#6b7280;margin-top:4px">
            Stored as the agent's <span class="mono">CLAUDE_CODE_OAUTH_TOKEN</span>. Required for the agent
            to run — set it here or from the agent detail page.
          </p>
        </div>
        <div class="form-group">
          <label class="form-label" for="anthropicApiKey">Anthropic API Key (optional)</label>
          <input
            id="anthropicApiKey"
            name="anthropicApiKey"
            type="password"
            class="form-input"
            placeholder="sk-ant-..."
          />
          <p style="font-size:12px;color:#6b7280;margin-top:4px">
            Stored as the agent's <span class="mono">ANTHROPIC_API_KEY</span>.
          </p>
        </div>`;
  // Whether the admin service can actually create cluster resources. When it
  // can't (NoopAgentProvisioner — SHIPWRIGHT_K8S_PROVISIONING unset), offering
  // "in-cluster" would silently produce an agent row with no pod, so the option
  // is rendered disabled and self-hosted is preselected.
  const canProvision = opts?.canProvision ?? false;
  // Slack/GitHub sections are only relevant to in-cluster (admin-provisioned)
  // agents — self-hosted agents use local git config for GitHub auth. Their
  // initial visibility must match whichever runtime radio is preselected
  // above (canProvision===true → in-cluster preselected → visible).
  const runtimeSectionsDisplay: "" | "none" = canProvision ? "" : "none";
  const errorHtml = error
    ? `<div class="alert alert-error">${escapeHtml(error)}</div>`
    : "";
  const typeOptions = types
    .map(
      (t) =>
        `<option value="${escapeHtml(t.name)}">${escapeHtml(t.displayName)}</option>`,
    )
    .join("\n");
  const selfServeHtml = selfServe
    ? `<div class="card" style="margin-bottom:16px">
      <p style="font-size:14px;font-weight:600;margin-bottom:8px">
        Agent quota: ${selfServe.remaining} of ${selfServe.max} remaining
      </p>
      ${
        selfServe.remaining <= 0
          ? `<p style="font-size:13px;color:#b91c1c;margin-bottom:8px">
        This account has reached its agent limit. Delete an agent to free a slot,
        or contact <a href="mailto:${escapeHtml(selfServe.contactEmail)}">${escapeHtml(selfServe.contactEmail)}</a> for more.
      </p>`
          : ""
      }
      <p style="font-size:13px;color:#6b7280;margin-bottom:4px">Have these ready before you start:</p>
      <ul style="font-size:13px;color:#6b7280;margin-left:20px">
        <li>A Slack App Configuration Token</li>
        <li>A GitHub org with an App, or a personal access token (PAT)</li>
        <li>A Claude API key or OAuth token</li>
      </ul>
    </div>`
    : "";
  const typeFieldHtml = selfServe
    ? `<input type="hidden" name="type" value="coding" />`
    : `<div class="form-group">
          <label class="form-label" for="type">Specialty <span style="color:#ef4444">*</span></label>
          <select id="type" name="type" class="form-input" required>
            ${typeOptions}
          </select>
        </div>`;
  return renderAdminPage({
    title: "New Agent — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header">
      <div>
        <a href="/admin/agents" style="font-size:13px;color:#6b7280;text-decoration:none">← Agents</a>
        <h1 class="page-title" style="margin-top:4px">New Agent</h1>
      </div>
    </div>
    ${errorHtml}
    ${selfServeHtml}
    <div class="card">
      <p style="font-size:14px;color:#6b7280;margin-bottom:20px">
        Create an agent and choose where it runs. Slack and GitHub connections
        below are optional — you can always talk to the agent from the
        <a href="/admin/chat">Chat</a> tab first and connect them later from
        the agent detail page.
      </p>
      <form method="POST" action="/admin/agents" enctype="multipart/form-data" style="display:flex;flex-direction:column;gap:16px">
        <div class="form-group">
          <label class="form-label" for="name">Agent name <span style="color:#ef4444">*</span></label>
          <input
            id="name"
            name="name"
            type="text"
            class="form-input"
            placeholder="my-agent"
            required
            autofocus
          />
        </div>
        ${typeFieldHtml}
        <fieldset style="border:1px solid #e8e8ee;border-radius:8px;padding:16px">
          <legend style="font-size:13px;font-weight:600;padding:0 8px">Runtime</legend>
          <div class="form-group" style="margin-bottom:0">
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">
              <input type="radio" name="runtime" value="in-cluster" ${canProvision ? "checked" : "disabled"}
                onchange="${runtimeSectionsOnchange("")}"
              />
              Provisioned in-cluster
              <span style="font-weight:400;color:#6b7280">
                — the admin service creates the Deployment, Secret, and PVC for you.
              </span>
            </label>
            <label style="display:block;font-size:13px;font-weight:500">
              <input type="radio" name="runtime" value="self-hosted" ${canProvision ? "" : "checked"}
                onchange="${runtimeSectionsOnchange("none")}"
              />
              Self-hosted
              <span style="font-weight:400;color:#6b7280">
                — you run the container yourself (<span class="mono">task stack</span>, local Docker).
              </span>
            </label>
            ${
              canProvision
                ? ""
                : `<p style="font-size:12px;color:#6b7280;margin-top:8px">
              In-cluster provisioning is unavailable — <span class="mono">SHIPWRIGHT_K8S_PROVISIONING</span> is not enabled on this admin service.
            </p>`
            }
          </div>
        </fieldset>
        ${claudeCredentialFields}
        <div class="form-group">
          <label class="form-label" for="repos">Repos (optional, one per line)</label>
          <textarea
            id="repos"
            name="repos"
            class="form-input"
            rows="4"
            placeholder="my-org/repo-one&#10;my-org/repo-two"
          ></textarea>
          <p style="font-size:12px;color:#6b7280;margin-top:4px">Format: <span class="mono">org/repo</span></p>
        </div>
        <div class="form-group">
          <label class="form-label" for="authorAllowlist">Author allowlist (review) (optional, one GitHub login per line)</label>
          <textarea
            id="authorAllowlist"
            name="authorAllowlist"
            class="form-input"
            rows="4"
            placeholder="octocat&#10;another-user"
          ></textarea>
          <p style="font-size:12px;color:#6b7280;margin-top:4px">GitHub login, one per line</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="patchAuthorAllowlist">Patch author allowlist (optional, one GitHub login per line)</label>
          <textarea
            id="patchAuthorAllowlist"
            name="patchAuthorAllowlist"
            class="form-input"
            rows="4"
            placeholder="octocat&#10;another-user"
          ></textarea>
          <p style="font-size:12px;color:#6b7280;margin-top:4px">GitHub login, one per line</p>
        </div>
        <div id="restrict-slack-group" style="display:${runtimeSectionsDisplay}">
          <div class="form-group" style="display:flex;align-items:center;gap:6px">
            <input
              id="restrictSlackToMembers"
              name="restrictSlackToMembers"
              type="checkbox"
              value="true"
              onchange="document.getElementById('member-emails-fields').style.display=this.checked?'block':'none'"
            />
            <label class="form-label" for="restrictSlackToMembers" style="margin-bottom:0">Restrict Slack to members</label>
          </div>
          <p style="font-size:12px;color:#6b7280;margin-top:-12px">
            When enabled, only AgentMember emails may message this agent over Slack. If the agent has no
            members yet, enabling this will block all Slack senders.
          </p>
          <div id="member-emails-fields" style="display:none;margin-top:12px">
            <div class="form-group">
              <label class="form-label" for="memberEmails">Member emails (optional, one per line)</label>
              <textarea
                id="memberEmails"
                name="memberEmails"
                class="form-input"
                rows="4"
                placeholder="alice@example.com&#10;bob@example.com"
              ></textarea>
              <p style="font-size:12px;color:#6b7280;margin-top:4px">Email address, one per line</p>
            </div>
          </div>
        </div>
        <fieldset id="slack-section" style="display:${runtimeSectionsDisplay};border:1px solid #e8e8ee;border-radius:8px;padding:16px">
          <legend style="font-size:13px;font-weight:600;padding:0 8px">Slack (optional)</legend>
          <div class="form-group" style="display:flex;align-items:center;gap:6px;margin-bottom:0">
            <input
              id="connectSlack"
              name="connectSlack"
              type="checkbox"
              value="true"
              onchange="document.getElementById('slack-fields').style.display=this.checked?'block':'none'"
            />
            <label class="form-label" for="connectSlack" style="margin-bottom:0">Connect Slack</label>
          </div>
          <div id="slack-fields" style="display:none;margin-top:12px">
            <div class="form-group">
              <label class="form-label" for="xoxpToken">Slack App Configuration Token</label>
              <input
                id="xoxpToken"
                name="xoxpToken"
                type="password"
                class="form-input"
                placeholder="xoxe.xoxp-..."
              />
              <p style="font-size:12px;color:#6b7280;margin-top:4px">
                This token is used once to create the Slack app manifest. It is not stored. After
                creating the agent you'll be redirected to authorize the Slack app.
              </p>
            </div>
          </div>
        </fieldset>
        <fieldset id="github-section" style="display:${runtimeSectionsDisplay};border:1px solid #e8e8ee;border-radius:8px;padding:16px">
          <legend style="font-size:13px;font-weight:600;padding:0 8px">GitHub Authentication (optional)</legend>
          <!--
            ghAppMode disambiguates the two ghAuthMode="app" radios below
            (Create GitHub App = auto, Use existing GitHub App = manual).
            Each app-mode radio's onchange sets this hidden field alongside
            showing/hiding its own fields block; it defaults to "auto" so a
            plain ghAuthMode=app submission (the historical default) is
            unaffected. See UAP-5.3.
          -->
          <input type="hidden" id="ghAppMode" name="ghAppMode" value="auto" />
          <div class="form-group" style="margin-bottom:12px">
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">
              <input type="radio" name="ghAuthMode" value="skip" checked
                onchange="document.getElementById('gh-pat-fields').style.display='none';document.getElementById('gh-app-fields').style.display='none';document.getElementById('gh-app-manual-fields').style.display='none'"
              /> Skip
              <span style="font-weight:400;color:#6b7280">
                — connect GitHub later from the agent detail page.
              </span>
            </label>
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">
              <input type="radio" name="ghAuthMode" value="pat"
                onchange="document.getElementById('gh-pat-fields').style.display='block';document.getElementById('gh-app-fields').style.display='none';document.getElementById('gh-app-manual-fields').style.display='none'"
              /> Personal Access Token
            </label>
            <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">
              <input type="radio" name="ghAuthMode" value="app"
                onchange="document.getElementById('ghAppMode').value='auto';document.getElementById('gh-pat-fields').style.display='none';document.getElementById('gh-app-fields').style.display='block';document.getElementById('gh-app-manual-fields').style.display='none'"
              /> Create GitHub App
            </label>
            <label style="display:block;font-size:13px;font-weight:500">
              <input type="radio" name="ghAuthMode" value="app"
                onchange="document.getElementById('ghAppMode').value='manual';document.getElementById('gh-pat-fields').style.display='none';document.getElementById('gh-app-fields').style.display='none';document.getElementById('gh-app-manual-fields').style.display='block'"
              /> Use existing GitHub App
              <span style="font-weight:400;color:#6b7280">
                — connect a GitHub App you've already created.
              </span>
            </label>
          </div>
          <div id="gh-pat-fields" style="display:none">
            <div class="form-group">
              <label class="form-label" for="ghPat">Personal Access Token</label>
              <input id="ghPat" name="ghPat" type="password" class="form-input" placeholder="ghp_..." />
            </div>
          </div>
          <div id="gh-app-fields" style="display:none">
            <div class="form-group">
              <label class="form-label" for="githubOrg">GitHub org</label>
              <input id="githubOrg" name="githubOrg" type="text" class="form-input" placeholder="my-org" />
              <p style="font-size:12px;color:#6b7280;margin-top:4px">
                You'll be redirected to GitHub to create the App under this organization from a manifest.
              </p>
            </div>
          </div>
          <div id="gh-app-manual-fields" style="display:none">
            <div class="form-group">
              <label class="form-label" for="ghAppId">GitHub App ID</label>
              <input id="ghAppId" name="ghAppId" type="text" class="form-input" placeholder="App ID" />
            </div>
            <div class="form-group">
              <label class="form-label" for="ghAppInstallationId">Installation ID</label>
              <input id="ghAppInstallationId" name="ghAppInstallationId" type="text" class="form-input" placeholder="Installation ID" />
            </div>
            <div class="form-group">
              <label class="form-label" for="ghAppPrivateKeyFile">Private Key (.pem)</label>
              <input id="ghAppPrivateKeyFile" name="ghAppPrivateKeyFile" type="file" accept=".pem" class="form-input" />
              <p style="font-size:12px;color:#6b7280;margin-top:4px">
                Upload the private key <span class="mono">.pem</span> file you downloaded when creating the GitHub App.
              </p>
            </div>
          </div>
        </fieldset>
        <div>
          <button type="submit" class="btn btn-primary">Create agent →</button>
          <a href="/admin/agents" class="btn btn-secondary" style="margin-left:8px">Cancel</a>
        </div>
      </form>
    </div>
  </div>`,
  });
}

// ─── Agent detail page ────────────────────────────────────────────────────────

/**
 * A single "connect later" action on the agent detail page (Connect Slack /
 * Set up GitHub App / Add GitHub PAT / Use existing GitHub App) — a
 * `<details>/<summary>` popover mirroring the "Sync Manifest" pattern.
 * `envKey` is the per-agent AgentEnv key whose presence in `envVars` means
 * this integration is already configured, hiding the action.
 *
 * `inputs` is an array so an action can collect more than one field (e.g.
 * the manual GitHub App connect needs App ID + Installation ID + a Private
 * Key file upload) — every existing action still supplies exactly one entry.
 */
interface ConnectActionConfig {
  envKey: string;
  label: string;
  description: string;
  action: string;
  hiddenFields?: Record<string, string>;
  inputs: Array<{
    name: string;
    type: "text" | "password" | "file" | "checkbox";
    placeholder?: string;
    mono?: boolean;
    /** Checkbox only: visible label text; `value` is submitted when checked. */
    label?: string;
    value?: string;
  }>;
}

function renderConnectAction(
  envVars: Record<string, string>,
  cfg: ConnectActionConfig,
): string {
  if (cfg.envKey in envVars) return "";
  const hiddenInputs = Object.entries(cfg.hiddenFields ?? {})
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`,
    )
    .join("\n              ");
  const hasFileInput = cfg.inputs.some((input) => input.type === "file");
  const visibleInputs = cfg.inputs
    .map((input) =>
      input.type === "checkbox"
        ? `<label style="font-size:12px;display:flex;gap:6px;align-items:center">
                <input name="${escapeHtml(input.name)}" type="checkbox" value="${escapeHtml(input.value ?? "true")}" />
                ${escapeHtml(input.label ?? input.name)}
              </label>`
        : `<input
                name="${escapeHtml(input.name)}"
                type="${input.type}"
                class="form-input${input.mono ? " mono" : ""}"
                ${input.placeholder ? `placeholder="${escapeHtml(input.placeholder)}"` : ""}
                required
                style="font-size:12px"
              />`,
    )
    .join("\n              ");
  return `<details style="position:relative">
          <summary class="btn btn-secondary" style="cursor:pointer;font-size:12px;list-style:none">${escapeHtml(cfg.label)}</summary>
          <div style="position:absolute;left:0;margin-top:6px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08);z-index:10;min-width:320px">
            <p style="font-size:12px;color:#6b7280;margin:0 0 10px">${cfg.description}</p>
            <form method="POST" action="${cfg.action}"${hasFileInput ? ' enctype="multipart/form-data"' : ""} style="display:flex;flex-direction:column;gap:8px">
              ${hiddenInputs}
              ${visibleInputs}
              <button type="submit" class="btn btn-primary" style="font-size:12px;align-self:flex-start">${escapeHtml(cfg.label)}</button>
            </form>
          </div>
        </details>`;
}

/**
 * Renders one collapsible accordion section on the agent detail page
 * (AGA-1.1) — a `<details class="group">` wrapping a fixed subset of the
 * page's existing cards. Always renders collapsed (no `open` attribute),
 * including when `agent.missingRequiredEnv` is non-empty — there is no
 * auto-open behavior for any group.
 *
 * `stat` is a short, pre-formatted, trusted (non-user-controlled) string
 * (e.g. "5 system · 7 custom") rendered flush-right in the summary row.
 * `name` (also trusted/static) is the group title, rendered flush-left.
 * The toggle indicator (▸/▾) is a `::before` on the `.group-title` span
 * itself — NOT on the flex `.group-summary` — so it stays part of that one
 * flex child instead of becoming its own third flex item, which would break
 * the flush-left/flush-right 2-sided layout into an uneven 3-way split.
 */
function renderGroup(name: string, stat: string, bodyHtml: string): string {
  return `<details class="group">
      <summary class="group-summary">
        <span class="group-title">${name}</span>
        <span class="group-sub">${stat}</span>
      </summary>
      <div class="group-body">
        ${bodyHtml}
      </div>
    </details>`;
}

export function renderAgentDetailPage(
  agent: AgentDetail,
  envResult:
    | { env: Record<string, string>; secretKeys: string[] }
    | Record<string, string>,
  crons: CronJobItem[],
  tools: ToolItem[],
  tokens: TokenItem[],
  plugins: PluginItem[],
  members: MemberItem[],
  userName: string,
  isAdmin: boolean,
  opts?: {
    /**
     * SSP-4.3: render the Members / Slack access / Danger Zone cards. Defaults
     * to isAdmin; the caller passes true for agent-access holders when
     * self-serve is enabled.
     */
    canManage?: boolean;
    error?: string;
    newToken?: string;
    successMsg?: string;
    /**
     * Non-blocking warning surfaced when restrictSlackToMembers was just set
     * to true on an agent with zero AgentMember rows — the save already
     * succeeded, this is purely informational.
     */
    warning?: string;
    now?: Date;
    timezone?: string;
    /**
     * Pre-rendered extension card HTML for the "header" placement (AEP-2.1,
     * admin-extension.ts), rendered in order above the stat strip. Absent or
     * empty adds no card.
     */
    extensionCardsHtml?: readonly string[];
    /**
     * Pre-rendered extension card HTML for the "configuration" placement
     * (AEP-3.2), rendered in order inside the Configuration group between
     * Repos and Agent Policy. Absent or empty adds no card.
     */
    configurationCardsHtml?: readonly string[];
    /**
     * Render each cron's Logs link (AEP-3.6). Only the coding extension mounts
     * /admin/agents/:id/queue-activity; absent/false omits the link.
     */
    queueActivityLinks?: boolean;
  },
): string {
  // Reference time for relative timestamps — injected by tests for determinism,
  // defaults to wall clock in production.
  const now = opts?.now ?? new Date();
  const timezone = opts?.timezone ?? "America/Los_Angeles";

  // Normalise envResult — accept both the new {env, secretKeys} shape and the
  // legacy Record<string,string> shape for backward compatibility.
  const envVars =
    envResult &&
    "env" in envResult &&
    typeof (envResult as { env: unknown }).env === "object"
      ? (envResult as { env: Record<string, string>; secretKeys: string[] }).env
      : (envResult as Record<string, string>);
  const secretKeySet = new Set<string>(
    envResult && "secretKeys" in envResult
      ? (envResult as { secretKeys: string[] }).secretKeys
      : [],
  );

  const envRows =
    Object.keys(envVars).length === 0
      ? `<tr><td colspan="3" class="empty-state">No env vars set.</td></tr>`
      : Object.entries(envVars)
          .map(
            ([k]) => `<tr>
      <td class="mono">${escapeHtml(k)}${secretKeySet.has(k) ? ' <span title="Secret">🔒</span>' : ""}</td>
      <td class="mono" style="color:#6b7280">••••••••</td>
      <td>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/envs/delete" style="display:inline">
          <input type="hidden" name="key" value="${escapeHtml(k)}" />
          <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Delete</button>
        </form>
      </td>
    </tr>`,
          )
          .join("\n");

  // "Connect later" actions (UAP-2.3) — each hidden once its AgentEnv key is
  // already set, mirroring the "Sync Manifest" visibility pattern.
  const connectActionConfigs: ConnectActionConfig[] = [
    {
      envKey: "SLACK_APP_TOKEN",
      label: "Connect Slack",
      description: `Connects this agent to a Slack app. Requires a Slack app configuration token (<span class="mono">xoxe.xoxp-</span>).`,
      action: `/admin/agents/${escapeHtml(agent.id)}/connect-slack`,
      inputs: [
        {
          name: "xoxpToken",
          type: "password",
          placeholder: "xoxe.xoxp-...",
          mono: true,
        },
      ],
    },
    {
      envKey: "GH_APP_ID",
      label: "Set up GitHub App",
      description:
        "Creates a GitHub App for this agent from a manifest. You'll be redirected to GitHub to finish creating it under the chosen org.",
      action: `/admin/agents/${escapeHtml(agent.id)}/connect-github`,
      hiddenFields: { ghAuthMode: "app", ghAppMode: "auto" },
      inputs: [
        { name: "githubOrg", type: "text", placeholder: "my-org" },
        {
          name: "ghAppPublic",
          type: "checkbox",
          value: "true",
          label: "Installable on multiple orgs (public App)",
        },
      ],
    },
    {
      envKey: "GH_APP_ID",
      label: "Use existing GitHub App",
      description:
        "Connects an existing GitHub App you've already created — paste its App ID and Installation ID, and upload its private key (PEM file).",
      action: `/admin/agents/${escapeHtml(agent.id)}/connect-github`,
      hiddenFields: { ghAuthMode: "app", ghAppMode: "manual" },
      inputs: [
        { name: "ghAppId", type: "text", placeholder: "App ID" },
        {
          name: "ghAppInstallationId",
          type: "text",
          placeholder: "Installation ID",
        },
        { name: "ghAppPrivateKeyFile", type: "file" },
      ],
    },
    {
      envKey: "GH_TOKEN",
      label: "Add GitHub PAT",
      description:
        "Connects this agent to GitHub using a personal access token.",
      action: `/admin/agents/${escapeHtml(agent.id)}/connect-github`,
      hiddenFields: { ghAuthMode: "pat" },
      inputs: [
        {
          name: "ghPat",
          type: "password",
          placeholder: "ghp_...",
          mono: true,
        },
      ],
    },
  ];
  const connectActions = [
    ...connectActionConfigs.map((cfg) => renderConnectAction(envVars, cfg)),
    renderAddAnotherOrgAction(agent.id, envVars),
  ].filter(Boolean);

  const connectActionsHtml =
    connectActions.length === 0
      ? ""
      : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
        ${connectActions.join("\n        ")}
      </div>`;

  // Top-level rows exclude any cron parented under another (e.g. shipwright-loop's
  // dev-task/review/patch/deploy phases) — those render nested beneath their
  // parent instead. `crons` (unfiltered) stays available below to look up each
  // top-level cron's children by parentCronId.
  const topLevelCrons = crons.filter((c) => !c.parentCronId);
  const systemCrons = topLevelCrons.filter((c) => c.system);
  const customCrons = topLevelCrons.filter((c) => !c.system);

  /** Renders the reusable Logs/Toggle[/Delete] action cell shared by top-level and nested cron rows. */
  function renderCronActions(c: CronJobItem): string {
    const toggleLabel = c.enabled ? "Disable" : "Enable";
    const toggleTarget = c.enabled ? "false" : "true";
    const logsLink = opts?.queueActivityLinks
      ? `
      <a href="/admin/agents/${escapeHtml(agent.id)}/queue-activity?cronId=${escapeHtml(c.id)}" class="btn btn-secondary" style="font-size:11px;padding:3px 8px;margin-right:4px;text-decoration:none">Logs</a>`
      : "";
    return `${logsLink}
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/crons/${escapeHtml(c.id)}/toggle" style="display:inline">
        <input type="hidden" name="enabled" value="${toggleTarget}" />
        <button type="submit" class="btn btn-secondary" style="font-size:11px;padding:3px 8px">${toggleLabel}</button>
      </form>
      ${
        !c.system
          ? `<form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/crons/${escapeHtml(c.id)}/delete" style="display:inline;margin-left:4px">
        <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Delete</button>
      </form>`
          : ""
      }`;
  }

  /**
   * Renders the nested "Phases of <parent>" block for a top-level cron's
   * children (e.g. shipwright-loop's dev-task/review/patch/deploy phases).
   * Returns "" when there are no children, so parents without phases (all
   * custom crons, and any system cron other than shipwright-loop) render
   * exactly as before — no empty block.
   */
  function renderNestedPhasesRow(
    parent: CronJobItem,
    children: CronJobItem[],
  ): string {
    if (children.length === 0) return "";
    const parentLabel = parent.name ?? parent.id;
    const childRows = children
      .map((child) => {
        const lastRunOutcomeLabel = child.lastRun
          ? cronRunOutcomeLabel(child.lastRun)
          : null;
        return `<tr>
          <td style="padding-left:20px">${escapeHtml(child.name ? `${child.name}: ${child.prompt}` : child.prompt)}</td>
          <td class="mono">${escapeHtml(child.schedule)}</td>
          <td><span class="badge ${child.enabled ? "badge-green" : "badge-gray"}">${child.enabled ? "enabled" : "disabled"}</span></td>
          <td style="font-size:11px">${
            child.lastRun?.startedAt
              ? `<span class="badge" style="${cronOutcomeStyle(lastRunOutcomeLabel)}">${escapeHtml(lastRunOutcomeLabel ?? "unknown")}</span>`
              : `<span style="color:#d1d5db">never</span>`
          }</td>
          <td style="white-space:nowrap">${renderCronActions(child)}</td>
        </tr>`;
      })
      .join("\n");
    return `<tr>
      <td colspan="8" style="background:#f9fafb;padding:12px 12px 12px 32px">
        <div style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Phases of ${escapeHtml(parentLabel)}</div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Phase</th>
              <th>Schedule</th>
              <th>Status</th>
              <th>Last run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${childRows}
          </tbody>
        </table>
      </td>
    </tr>`;
  }

  function renderCronRow(c: CronJobItem): string {
    const actions = renderCronActions(c);
    // Full inline edit (schedule, prompt, channel, preCheck), collapsed behind a
    // <details> so the table stays readable. Posts to /update → cronService.update.
    // System crons get NO edit form — their contents are owned by
    // reconcileSystemCrons and the /update route rejects them (mirrors delete).
    const editForm = c.system
      ? ""
      : `
      <details style="margin-top:6px">
        <summary style="cursor:pointer;font-size:11px;color:#6b7280">Edit</summary>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/crons/${escapeHtml(c.id)}/update" style="display:flex;flex-direction:column;gap:4px;margin-top:6px;min-width:240px">
          <input name="schedule" type="text" class="form-input mono" style="font-size:11px;padding:3px 6px" value="${escapeHtml(c.schedule)}" placeholder="0 * * * *" required title="Cron expression (5 fields)" />
          <textarea name="prompt" class="form-input" style="font-size:11px;padding:3px 6px;min-height:48px" placeholder="Prompt" required>${escapeHtml(c.prompt)}</textarea>
          <input name="channel" type="text" class="form-input" style="font-size:11px;padding:3px 6px" value="${escapeHtml(c.channel ?? "")}" placeholder="Channel ID (optional)" />
          <input name="preCheck" type="text" class="form-input mono" style="font-size:11px;padding:3px 6px" value="${escapeHtml(c.preCheck ?? "")}" placeholder="plugin:check.ts or ./path.ts (optional)" />
          <button type="submit" class="btn btn-primary" style="font-size:11px;padding:3px 8px;align-self:flex-start">Save</button>
        </form>
      </details>`;
    const lastRunOutcomeLabel = c.lastRun
      ? cronRunOutcomeLabel(c.lastRun)
      : null;
    const lastRunHtml = c.lastRun?.startedAt
      ? `
      <div style="font-size:11px;color:#6b7280;margin-bottom:4px">${relativeTime(c.lastRun.startedAt, now)}</div>
      <div>
        <span class="badge" style="${cronOutcomeStyle(lastRunOutcomeLabel)}">${escapeHtml(lastRunOutcomeLabel ?? "unknown")}</span>
      </div>
      <div style="font-size:11px;color:#6b7280;margin-top:4px">${c.runCountToday ?? 0} run${(c.runCountToday ?? 0) === 1 ? "" : "s"}</div>`
      : `<div style="color:#d1d5db">never</div>`;

    const children = crons.filter((child) => child.parentCronId === c.id);
    const nestedPhasesRow = renderNestedPhasesRow(c, children);

    return `<tr>
      <td class="mono">${escapeHtml(c.schedule)}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(c.name ? `${c.name}: ${c.prompt}` : c.prompt)}</td>
      <td class="mono" style="font-size:11px;color:#6b7280;max-width:170px;overflow:hidden;text-overflow:ellipsis">${c.preCheck ? escapeHtml(c.preCheck) : "—"}</td>
      <td>${c.channel ? escapeHtml(c.channel) : c.user ? escapeHtml(c.user) : "—"}</td>
      <td><span class="badge ${c.enabled ? "badge-green" : "badge-gray"}">${c.enabled ? "enabled" : "disabled"}</span></td>
      <td style="font-size:11px">${lastRunHtml}</td>
      <td class="col-created">${escapeHtml(new Date(c.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
      <td style="white-space:nowrap">${actions}${editForm}</td>
    </tr>
    ${nestedPhasesRow}`;
  }

  const systemCronRows =
    systemCrons.length === 0
      ? `<tr><td colspan="8" class="empty-state">No system crons configured.</td></tr>`
      : systemCrons.map(renderCronRow).join("\n");

  const customCronRows =
    customCrons.length === 0
      ? `<tr><td colspan="8" class="empty-state">No custom crons yet.</td></tr>`
      : customCrons.map(renderCronRow).join("\n");

  const toolRows =
    tools.length === 0
      ? `<tr><td colspan="4" class="empty-state">No tools configured.</td></tr>`
      : tools
          .map(
            (t) => `<tr>
      <td class="mono">${escapeHtml(t.pattern)}</td>
      <td><span class="badge ${t.enabled ? "badge-green" : "badge-gray"}">${t.enabled ? "enabled" : "disabled"}</span></td>
      <td>${escapeHtml(new Date(t.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
      <td style="white-space:nowrap">
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tools/${escapeHtml(t.id)}/toggle" style="display:inline">
          <input type="hidden" name="enabled" value="${t.enabled ? "false" : "true"}" />
          <button type="submit" class="btn btn-secondary" style="font-size:11px;padding:3px 8px">${t.enabled ? "Disable" : "Enable"}</button>
        </form>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tools/${escapeHtml(t.id)}/delete" style="display:inline;margin-left:4px">
          <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Delete</button>
        </form>
      </td>
    </tr>`,
          )
          .join("\n");

  const tokenRows =
    tokens.length === 0
      ? `<tr><td colspan="4" class="empty-state">No tokens created.</td></tr>`
      : tokens
          .map(
            (t) => `<tr>
      <td>${t.label ? escapeHtml(t.label) : '<span style="color:#9ca3af">—</span>'}</td>
      <td>${escapeHtml(new Date(t.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
      <td>${t.revokedAt ? `<span class="badge badge-gray">Revoked ${escapeHtml(new Date(t.revokedAt).toLocaleDateString("en-US", { timeZone: timezone }))}</span>` : '<span class="badge badge-green">Active</span>'}</td>
      <td>${
        !t.revokedAt
          ? `<form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tokens/${escapeHtml(t.id)}/revoke" style="display:inline">
          <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Revoke</button>
        </form>`
          : ""
      }</td>
    </tr>`,
          )
          .join("\n");

  const pluginRows =
    plugins.length === 0
      ? `<tr><td colspan="4" class="empty-state">No plugins installed.</td></tr>`
      : plugins
          .map(
            (p) => `<tr>
      <td class="mono">${escapeHtml(p.name)}</td>
      <td class="mono">${p.version ? escapeHtml(p.version) : "latest"}</td>
      <td><span class="badge ${p.enabled ? "badge-green" : "badge-gray"}">${p.enabled ? "enabled" : "disabled"}</span></td>
      <td>${escapeHtml(new Date(p.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
    </tr>`,
          )
          .join("\n");

  const memberRows =
    members.length === 0
      ? `<tr><td colspan="3" class="empty-state">No members yet.</td></tr>`
      : members
          .map(
            (m) => `<tr>
      <td>${escapeHtml(m.email)}</td>
      <td>${escapeHtml(new Date(m.createdAt).toLocaleDateString("en-US", { timeZone: timezone }))}</td>
      <td>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/members/delete" style="display:inline">
          <input type="hidden" name="memberId" value="${escapeHtml(m.id)}" />
          <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Remove</button>
        </form>
      </td>
    </tr>`,
          )
          .join("\n");

  const membersSection = `
    <div class="card">
      <div class="card-title">Members</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/members" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="email" type="email" class="form-input" placeholder="user@example.com" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Added</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${memberRows}
          </tbody>
        </table>
      </div>
    </div>`;

  const errorHtml = opts?.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const successHtml = opts?.successMsg
    ? `<div class="alert alert-success">${escapeHtml(opts.successMsg)}</div>`
    : "";

  const warningHtml = opts?.warning
    ? `<div class="alert alert-warning">${escapeHtml(opts.warning)}</div>`
    : "";

  const newTokenHtml = opts?.newToken
    ? `<div class="alert alert-success">
        <strong>Token created.</strong> Copy it now — it will not be shown again.<br />
        <code class="mono" style="display:block;margin-top:8px;font-size:13px;word-break:break-all">${escapeHtml(opts.newToken)}</code>
      </div>`
    : "";

  const envVarsSection = !agent.selfHosted
    ? `<div class="card" id="env-vars">
      <div class="card-title">Env Vars</div>
      ${
        agent.missingRequiredEnv.length > 0
          ? `<div class="alert alert-warning">
        Missing required env var${agent.missingRequiredEnv.length === 1 ? "" : "s"}:
        ${agent.missingRequiredEnv.map((key) => `<span class="badge badge-warning">${escapeHtml(key)}</span>`).join(" ")}
        — <a href="#env-vars">set ${agent.missingRequiredEnv.length === 1 ? "it" : "them"} below</a>.
      </div>`
          : ""
      }
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/envs" style="margin-bottom:16px">
        <div class="form-row" style="flex-wrap:wrap;gap:8px">
          <div class="form-group">
            <input name="key" type="text" class="form-input" placeholder="KEY" required />
          </div>
          <div class="form-group">
            <input name="value" type="password" class="form-input" placeholder="value" required />
          </div>
          <div class="form-group" style="display:flex;align-items:center;gap:6px;padding-bottom:2px">
            <input name="secret" type="checkbox" id="env-secret" value="true" checked />
            <label for="env-secret" class="form-label" style="margin-bottom:0">Mark as secret</label>
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${envRows}
          </tbody>
        </table>
      </div>
    </div>`
    : "";

  const reposSection = `<div class="card">
      <div class="card-title">Repos</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/repos/add" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="repo" type="text" class="form-input" placeholder="org/repo" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Repo</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              agent.repos.length === 0
                ? `<tr><td colspan="2" class="empty-state">No repos configured.</td></tr>`
                : agent.repos
                    .map(
                      (repo) => `<tr>
            <td class="mono">${escapeHtml(repo)}</td>
            <td>
              <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/repos/delete" style="display:inline">
                <input type="hidden" name="repo" value="${escapeHtml(repo)}" />
                <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Remove</button>
              </form>
            </td>
          </tr>`,
                    )
                    .join("\n")
            }
          </tbody>
        </table>
      </div>
    </div>`;

  const authorAllowlistReviewSection = `<div class="card">
      <div class="card-title">Author allowlist (review)</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/review-author-allowlist/add" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="login" type="text" class="form-input" placeholder="octocat" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>GitHub login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              agent.authorAllowlist.length === 0
                ? `<tr><td colspan="2" class="empty-state">No author allowlist entries configured.</td></tr>`
                : agent.authorAllowlist
                    .map(
                      (login) => `<tr>
            <td class="mono">${escapeHtml(login)}</td>
            <td>
              <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/review-author-allowlist/delete" style="display:inline">
                <input type="hidden" name="login" value="${escapeHtml(login)}" />
                <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Remove</button>
              </form>
            </td>
          </tr>`,
                    )
                    .join("\n")
            }
          </tbody>
        </table>
      </div>
    </div>`;

  const authorAllowlistPatchSection = `<div class="card">
      <div class="card-title">Author allowlist (patch)</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/patch-author-allowlist/add" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="login" type="text" class="form-input" placeholder="octocat" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>GitHub login</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              (agent.patchAuthorAllowlist ?? []).length === 0
                ? `<tr><td colspan="2" class="empty-state">No patch author allowlist entries configured.</td></tr>`
                : (agent.patchAuthorAllowlist ?? [])
                    .map(
                      (login) => `<tr>
            <td class="mono">${escapeHtml(login)}</td>
            <td>
              <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/patch-author-allowlist/delete" style="display:inline">
                <input type="hidden" name="login" value="${escapeHtml(login)}" />
                <button type="submit" class="btn btn-danger" style="font-size:11px;padding:3px 8px">Remove</button>
              </form>
            </td>
          </tr>`,
                    )
                    .join("\n")
            }
          </tbody>
        </table>
      </div>
    </div>`;

  const canManage = opts?.canManage ?? isAdmin;

  const slackAccessSection = canManage
    ? `<div class="card">
      <div class="card-title">Slack access</div>
      ${connectActionsHtml}
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/settings">
        <div class="form-group" style="display:flex;align-items:center;gap:6px">
          <input
            id="restrictSlackToMembers"
            name="restrictSlackToMembers"
            type="checkbox"
            value="true"
            ${agent.restrictSlackToMembers ? "checked" : ""}
          />
          <!-- Hidden fallback: unchecked checkboxes are omitted from FormData
               entirely, so this "false" entry is what a submission of THIS
               form sends when unchecked. It also lets the shared /settings
               route (posted to by both this form and the Agent Policy form
               below) tell "this form was submitted with the box unchecked"
               apart from "a different form was submitted, this field is
               absent" — see admin-ui.ts's POST /admin/agents/:id/settings. -->
          <input type="hidden" name="restrictSlackToMembers" value="false" />
          <label class="form-label" for="restrictSlackToMembers" style="margin-bottom:0">Restrict Slack to members</label>
        </div>
        <p style="font-size:12px;color:#6b7280;margin:4px 0 12px">
          When enabled, only AgentMember emails may message this agent over Slack. If the agent has no
          members yet, enabling this will block all Slack senders.
        </p>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>`
    : "";

  const cronJobsSection = `<div class="card">
      <div class="card-title">Cron Jobs</div>

      ${
        agent.selfHosted
          ? `<p style="font-size:13px;color:#6b7280;margin:0 0 16px">Crons fire only while the local agent service is running. Make sure your service is active before enabling crons.</p>`
          : ""
      }

      <div style="margin-bottom:20px">
        <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">System</div>
        <div class="data-table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Prompt</th>
                <th>Pre-check</th>
                <th>Target</th>
                <th>Status</th>
                <th>Last run</th>
                <th class="col-created">Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${systemCronRows}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">Custom</div>
        <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/crons" style="margin-bottom:12px">
          <div class="form-row" style="flex-wrap:wrap;gap:8px">
            <div class="form-group">
              <input name="schedule" type="text" class="form-input" placeholder="0 * * * *" required title="Cron expression (5 fields)" />
            </div>
            <div class="form-group" style="flex:1;min-width:200px">
              <input name="prompt" type="text" class="form-input" placeholder="Prompt" required />
            </div>
            <div class="form-group">
              <input name="channel" type="text" class="form-input" placeholder="Channel ID" />
            </div>
            <div class="form-group" style="display:flex;align-items:center;gap:6px;padding-bottom:2px">
              <input name="enabled" type="checkbox" id="cron-enabled" value="true" checked />
              <label for="cron-enabled" class="form-label" style="margin-bottom:0">Enabled</label>
            </div>
            <button type="submit" class="btn btn-primary">Add Cron</button>
          </div>
        </form>
        <div class="data-table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>Schedule</th>
                <th>Prompt</th>
                <th>Pre-check</th>
                <th>Target</th>
                <th>Status</th>
                <th>Last run</th>
                <th class="col-created">Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${customCronRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  const toolsSection = `<div class="card">
      <div class="card-title">Tools</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tools" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="pattern" type="text" class="form-input" placeholder="Bash(git:*)" required />
          </div>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Pattern</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${toolRows}
          </tbody>
        </table>
      </div>
    </div>`;

  const tokensSection = `<div class="card">
      <div class="card-title">Task Store Tokens</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/tokens" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group" style="flex:1">
            <input name="label" type="text" class="form-input" placeholder="Label (optional)" />
          </div>
          <button type="submit" class="btn btn-primary">Create Token</button>
        </div>
      </form>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Created</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${tokenRows}
          </tbody>
        </table>
      </div>
    </div>`;

  const pluginsSection = `<div class="card">
      <div class="card-title">Plugins</div>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>Package</th>
              <th>Version</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            ${pluginRows}
          </tbody>
        </table>
      </div>
    </div>`;

  // PAI-2.5: read-only trace from this agent to its Anthropic identity. Values
  // are user data (owner email) or provider IDs, so every one is escaped.
  const identityPlaceholder = '<span style="color:#9ca3af">—</span>';
  const identityRow = (
    label: string,
    value: string | null | undefined,
    mono: boolean,
  ): string =>
    `<tr><td style="color:#6b7280;width:200px">${label}</td><td${mono ? ' class="mono"' : ""}>${value ? escapeHtml(value) : identityPlaceholder}</td></tr>`;
  const identitySection = `<div class="card">
      <div class="card-title">Owner &amp; Anthropic identity</div>
      <table class="detail-table"><tbody>
        ${identityRow("Owner email", agent.ownerEmail, false)}
        ${identityRow("Anthropic identity name", agent.anthropicIdentityName, true)}
        ${identityRow("Service account ID", agent.anthropicServiceAccountId, true)}
        ${identityRow("Federation rule ID", agent.anthropicFederationRuleId, true)}
      </tbody></table>
    </div>`;

  const agentPolicySection = `<div class="card">
      <div class="card-title">Agent Policy</div>
      <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/settings">
        <div class="form-group" style="display:flex;align-items:center;gap:6px">
          <input
            id="autoPostReviews"
            name="autoPostReviews"
            type="checkbox"
            value="true"
            ${agent.autoPostReviews ? "checked" : ""}
          />
          <!-- Hidden "false" fallback so an unchecked box still submits a
               value (see the Slack access card's checkbox above for why). -->
          <input type="hidden" name="autoPostReviews" value="false" />
          <label class="form-label" for="autoPostReviews" style="margin-bottom:0">Auto-post reviews</label>
        </div>
        <p style="font-size:12px;color:#6b7280;margin:4px 0 12px">
          Off stages reviews to state/reviews/ + Slack notify instead of posting directly to GitHub.
        </p>
        <div class="form-group" style="display:flex;align-items:center;gap:6px">
          <input
            id="allowSelfReview"
            name="allowSelfReview"
            type="checkbox"
            value="true"
            ${agent.allowSelfReview ? "checked" : ""}
          />
          <input type="hidden" name="allowSelfReview" value="false" />
          <label class="form-label" for="allowSelfReview" style="margin-bottom:0">Allow self-review</label>
        </div>
        <p style="font-size:12px;color:#6b7280;margin:4px 0 12px">
          Whether the agent may review its own open PRs.
        </p>
        <div class="form-group" style="display:flex;align-items:center;gap:6px">
          <input
            id="cleanupMergedWorktrees"
            name="cleanupMergedWorktrees"
            type="checkbox"
            value="true"
            ${agent.cleanupMergedWorktrees ? "checked" : ""}
          />
          <input type="hidden" name="cleanupMergedWorktrees" value="false" />
          <label class="form-label" for="cleanupMergedWorktrees" style="margin-bottom:0">Cleanup merged worktrees</label>
        </div>
        <p style="font-size:12px;color:#6b7280;margin:4px 0 12px">
          Remove worktrees for merged PRs each cron cycle.
        </p>
        <div class="form-group">
          <label class="form-label" for="minConfidence">Min confidence (0-100)</label>
          <input id="minConfidence" name="minConfidence" type="number" value="${agent.minConfidence}" class="form-input" />
          <p style="font-size:12px;color:#6b7280;margin-top:4px">Minimum finding confidence to surface in a review.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="maxFindings">Max findings</label>
          <input id="maxFindings" name="maxFindings" type="number" value="${agent.maxFindings}" class="form-input" />
          <p style="font-size:12px;color:#6b7280;margin-top:4px">Max findings surfaced per review.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="cleanupAfterDays">Cleanup after days</label>
          <input id="cleanupAfterDays" name="cleanupAfterDays" type="number" value="${agent.cleanupAfterDays}" class="form-input" />
          <p style="font-size:12px;color:#6b7280;margin-top:4px">Remove worktrees older than N days even if the PR is still open.</p>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
      </form>
    </div>`;

  const dangerZoneSection = canManage
    ? `<!-- Danger Zone -->
    <div class="card" style="border:1px solid #fca5a5">
      <div class="card-title" style="color:#dc2626">Danger Zone</div>
      <p style="font-size:13px;color:#6b7280;margin-bottom:16px">
        Deleting this agent permanently removes all its data (env vars, crons, tools, tokens, plugins, members)
        and terminates its pod. This action cannot be undone.
      </p>
      <form id="delete-agent-form" method="POST" action="/admin/agents/${escapeHtml(agent.id)}/delete"
            data-agent-name="${escapeHtml(agent.name)}">
        <button type="submit" class="btn btn-danger">Delete agent</button>
      </form>
      <script>
        document.getElementById('delete-agent-form').addEventListener('submit', function(e) {
          var name = this.dataset.agentName;
          if (!confirm('Delete agent ' + name + '? This cannot be undone.')) {
            e.preventDefault();
          }
        });
      </script>
    </div>`
    : "";

  // ─── Accordion groups (AGA-1.1) ────────────────────────────────────────
  // The cards below are grouped into 4 collapsed-by-default
  // <details class="group"> sections. Grouping is purely presentational —
  // every card's internal markup/ids/form actions are unchanged, they're
  // just composed into a new order. Agent Policy (added after this task was
  // originally scoped) lands in Configuration alongside Env Vars/Repos since
  // it is agent-level configuration, as do extension cards placed there
  // (the coding extension's Phase Methodology card) — this keeps every card
  // inside exactly one of the 4 groups, with no stray bare cards besides
  // Danger Zone.
  const automationStat = `${systemCrons.length} system · ${customCrons.length} custom`;
  const configurationStat = `${Object.keys(envVars).length} env vars · ${agent.repos.length} repos`;
  const activeTokenCount = tokens.filter((t) => !t.revokedAt).length;
  const accessStat = `${members.length} members · ${activeTokenCount} active tokens`;
  const pluginsToolsStat = `${tools.length} tools · ${plugins.length} plugins`;

  // ─── Stat strip (AGA-1.2) ──────────────────────────────────────────────
  // 4-tile stat strip rendered above the 4 accordion groups. Each tile
  // derives its count from parameters already passed into this function.
  const cronsActiveCount = topLevelCrons.filter((c) => c.enabled).length;
  const missingEnvVarsCount = agent.missingRequiredEnv.length;
  const membersCount = members.length;
  const reposCount = agent.repos.length;

  const statStripHtml = `<div class="stat-strip">
    <div class="stat-tile">
      <div class="stat-tile-label">crons active</div>
      <div class="stat-tile-value"><span>${cronsActiveCount}</span></div>
    </div>
    <div class="stat-tile${missingEnvVarsCount > 0 ? " stat-tile-warning" : ""}">
      <div class="stat-tile-label">missing env vars</div>
      <div class="stat-tile-value"><span>${missingEnvVarsCount}</span></div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile-label">members</div>
      <div class="stat-tile-value"><span>${membersCount}</span></div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile-label">repos</div>
      <div class="stat-tile-value"><span>${reposCount}</span></div>
    </div>
  </div>`;

  const automationGroup = renderGroup(
    "Automation",
    automationStat,
    cronJobsSection,
  );
  const configurationGroup = renderGroup(
    "Configuration",
    configurationStat,
    `${envVarsSection}${reposSection}${(opts?.configurationCardsHtml ?? []).join("")}${agentPolicySection}`,
  );
  const accessGroup = renderGroup(
    "Access",
    accessStat,
    `${identitySection}${canManage ? membersSection : ""}${authorAllowlistReviewSection}${authorAllowlistPatchSection}${slackAccessSection}${tokensSection}`,
  );
  const pluginsToolsGroup = renderGroup(
    "Plugins &amp; Tools",
    pluginsToolsStat,
    `${toolsSection}${pluginsSection}`,
  );

  const expandCollapseControls = `
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <button type="button" class="btn btn-secondary" id="expand-all-btn">Expand all</button>
      <button type="button" class="btn btn-secondary" id="collapse-all-btn">Collapse all</button>
    </div>
    <script>
      (function() {
        var expandBtn = document.getElementById('expand-all-btn');
        var collapseBtn = document.getElementById('collapse-all-btn');
        if (expandBtn) {
          expandBtn.addEventListener('click', function() {
            document.querySelectorAll('.group').forEach(function(el) {
              el.open = true;
            });
          });
        }
        if (collapseBtn) {
          collapseBtn.addEventListener('click', function() {
            document.querySelectorAll('.group').forEach(function(el) {
              el.open = false;
            });
          });
        }
      })();
    </script>
  `;

  return renderAdminPage({
    title: `${agent.name} — Shipwright Admin`,
    body: `${renderAdminToolbar(userName, "/admin/agents")}
  <div class="vos-page">
    <div class="page-header">
      <div>
        <a href="/admin/agents" style="font-size:13px;color:#6b7280;text-decoration:none">← Agents</a>
        <h1 class="page-title" style="margin-top:4px">${escapeHtml(agent.name)}</h1>
        <span style="font-size:13px;color:#6b7280">Type: <span class="mono">${escapeHtml(agent.typeName)}</span></span>
        ${agent.slackId ? `<span style="font-size:13px;color:#6b7280">Slack ID: <span class="mono">${escapeHtml(agent.slackId)}</span></span>` : ""}
      </div>
      ${
        agent.slackId
          ? `<div>
        <details>
          <summary class="btn btn-secondary" style="cursor:pointer;font-size:12px;list-style:none">Sync Manifest</summary>
          <div style="position:absolute;right:24px;margin-top:6px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px;box-shadow:0 4px 12px rgba(0,0,0,0.08);z-index:10;min-width:320px">
            <p style="font-size:12px;color:#6b7280;margin:0 0 10px">Syncs the current manifest to the provisioned Slack app. Requires a Slack app configuration token (<span class="mono">xoxe.xoxp-</span>).</p>
            <form method="POST" action="/admin/agents/${escapeHtml(agent.id)}/sync-manifest" style="display:flex;flex-direction:column;gap:8px">
              <input
                name="xoxpToken"
                type="password"
                class="form-input mono"
                placeholder="xoxe.xoxp-..."
                required
                style="font-size:12px"
              />
              <button type="submit" class="btn btn-primary" style="font-size:12px;align-self:flex-start">Confirm Sync</button>
            </form>
          </div>
        </details>
      </div>`
          : ""
      }
    </div>
    ${errorHtml}
    ${successHtml}
    ${warningHtml}
    ${newTokenHtml}
    ${(opts?.extensionCardsHtml ?? []).join("\n    ")}

    ${statStripHtml}

    ${expandCollapseControls}
    ${automationGroup}
    ${configurationGroup}
    ${accessGroup}
    ${pluginsToolsGroup}

    ${dangerZoneSection}

  </div>`,
  });
}

// ─── Provision pages ──────────────────────────────────────────────────────────

/**
 * Auto-submitting POST-redirect page for the GitHub "create a GitHub App
 * from a manifest" flow: https://docs.github.com/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app-from-a-manifest
 *
 * `githubOrg` must already be validated by the caller against the org-name
 * pattern before this function is called — it's interpolated directly into
 * the form's `action` URL.
 */
export function renderGithubAppManifestRedirectPage(
  userName: string,
  opts: { githubOrg: string; manifest: unknown },
): string {
  const actionUrl = `https://github.com/organizations/${encodeURIComponent(opts.githubOrg)}/settings/apps/new`;
  const manifestJson = JSON.stringify(opts.manifest);

  return renderAdminPage({
    title: "Provision Agent — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step active">1. Create Slack App</span>
      <span class="provision-step">2. Authorize</span>
      <span class="provision-step">3. Complete</span>
    </div>
    <div class="card">
      <p style="font-size:14px;margin-bottom:16px;color:#6b7280">
        Redirecting to GitHub to create the GitHub App under <strong>${escapeHtml(opts.githubOrg)}</strong>…
      </p>
      <form id="github-app-manifest-form" method="POST" action="${escapeHtml(actionUrl)}">
        <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}" />
        <button type="submit" class="btn btn-primary">Continue to GitHub →</button>
      </form>
      <script>
        document.getElementById('github-app-manifest-form').submit();
      </script>
    </div>
  </div>`,
  });
}

/**
 * Shown after GET /admin/provision/github-app/complete succeeds — links the
 * operator to GitHub's installations/new page for the newly created app.
 */
export function renderGithubAppInstallPage(
  userName: string,
  opts: { installUrl: string },
): string {
  return renderAdminPage({
    title: "Provision Agent — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step active">2. Install GitHub App</span>
      <span class="provision-step">3. Complete</span>
    </div>
    <div class="card">
      <div class="alert alert-success">
        <strong>GitHub App created!</strong> Click the link below to install it.
      </div>
      <a href="${escapeHtml(opts.installUrl)}" class="btn btn-primary" rel="noopener noreferrer">
        Install GitHub App →
      </a>
    </div>
  </div>`,
  });
}

/**
 * "Add another org" action for the agent detail page. Hidden until the agent
 * has a GitHub App (GH_APP_ID); links to the add-org redirect when GH_APP_SLUG
 * is stored, otherwise points at the docs.
 */
export function renderAddAnotherOrgAction(
  agentId: string,
  envVars: Record<string, string>,
): string {
  if (!("GH_APP_ID" in envVars)) return "";
  if (envVars.GH_APP_SLUG) {
    return `<a href="/admin/agents/${escapeHtml(agentId)}/connect-github/add-org" class="btn btn-secondary" style="font-size:12px" rel="noopener noreferrer">Add another org</a>`;
  }
  return `<span style="font-size:12px;color:#6b7280">To install this App on another org, see <a href="https://github.com/app-vitals/shipwright/blob/main/docs/configuration-agent.md" rel="noopener noreferrer">the docs</a> (GH_APP_SLUG).</span>`;
}

/**
 * Shown after GET /admin/provision/github-app/installed succeeds or fails —
 * the manifest flow's `setup_url` target.
 */
export function renderGithubAppInstalledPage(
  userName: string,
  opts: {
    success: boolean;
    error?: string;
    /** Stored installation ID was kept; this was an additional-org install. */
    alreadyStored?: boolean;
  },
): string {
  const bodyHtml = opts.success
    ? `<div class="alert alert-success">
        ${
          opts.alreadyStored
            ? "<strong>Install received.</strong> — the agent's existing installation ID was left unchanged."
            : "<strong>GitHub App installed!</strong> — installation ID stored."
        }
      </div>
      <a href="/admin/provision" class="btn btn-secondary">Back to Provisioning</a>`
    : `<div class="alert alert-error">${escapeHtml(opts.error ?? "GitHub App installation failed.")}</div>
      <a href="/admin/provision" class="btn btn-secondary">Try again</a>`;

  return renderAdminPage({
    title: "Provision Agent — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step">2. Install GitHub App</span>
      <span class="provision-step active">3. Complete</span>
    </div>
    <div class="card">
      ${bodyHtml}
    </div>
  </div>`,
  });
}

// xapp-token page shown after OAuth callback completes — user pastes the Socket Mode app token.
export function renderProvisionXappTokenPage(
  userName: string,
  opts: { agentId: string; error?: string; warning?: string },
): string {
  const errorHtml = opts.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";
  // Non-fatal warning (UAP-2.1) — e.g. a GitHub PAT that failed to store
  // during the combined create+connect flow. Surfaced here so the operator
  // isn't misled into believing GH_TOKEN was connected after finishing Slack.
  const warningHtml = opts.warning
    ? `<div class="alert alert-warning">${escapeHtml(opts.warning)}</div>`
    : "";

  return renderAdminPage({
    title: "Complete Provisioning — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step">2. Authorize</span>
      <span class="provision-step">3. Bot Token</span>
      <span class="provision-step active">4. Add Socket Token</span>
    </div>
    <div class="card">
      <p style="font-size:14px;margin-bottom:16px;color:#6b7280">
        Open your Slack App's <strong>Socket Mode</strong> settings, enable Socket Mode,
        and generate an <strong>App-Level Token</strong> with <code class="mono">connections:write</code> scope.
        Paste the <code class="mono">xapp-</code> token below.
      </p>
      ${warningHtml}
      ${errorHtml}
      <form method="POST" action="/admin/agents/${escapeHtml(opts.agentId)}/connect-slack/app-token">
        <div class="form-group">
          <label class="form-label" for="xappToken">App-Level Token (xapp-)</label>
          <input
            id="xappToken"
            name="xappToken"
            type="password"
            class="form-input"
            placeholder="xapp-..."
            required
          />
        </div>
        <button type="submit" class="btn btn-primary">Save Token →</button>
      </form>
    </div>
  </div>`,
  });
}

export interface AgentOption {
  id: string;
  name: string;
}

export function renderProvisionCompletePage(
  userName: string,
  opts: {
    success: boolean;
    agentId?: string;
    error?: string;
  },
): string {
  const bodyHtml = opts.success
    ? `<div class="alert alert-success">
        <strong>Provisioning complete!</strong> — Slack app credentials and tokens stored.
      </div>
      <p style="font-size:14px;margin-bottom:16px;margin-top:16px">
        All credentials have been saved to the agent's env vars and system crons have been seeded.
        For a self-hosted agent, mint its own API key from the agent's detail page.
      </p>
      ${opts.agentId ? `<a href="/admin/agents/${escapeHtml(opts.agentId)}" class="btn btn-primary">View Agent →</a>` : ""}
      <a href="/admin/agents" class="btn btn-secondary" style="margin-left:8px">Back to Agents</a>`
    : `<div class="alert alert-error">${escapeHtml(opts.error ?? "Provisioning failed.")}</div>
      <a href="/admin/provision" class="btn btn-secondary">Try again</a>`;

  return renderAdminPage({
    title: "Provisioning Complete — Shipwright Admin",
    body: `${renderAdminToolbar(userName, "/admin/provision")}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Provision Agent</h1>
    </div>
    <div class="provision-steps">
      <span class="provision-step">1. Create Slack App</span>
      <span class="provision-step">2. Authorize</span>
      <span class="provision-step">3. Bot Token</span>
      <span class="provision-step active">4. Complete</span>
    </div>
    <div class="card">
      ${bodyHtml}
    </div>
  </div>`,
  });
}

// ─── Chat page ─────────────────────────────────────────────────────────────────

/**
 * Renders the top-level /admin/chat page.
 *
 * @param agents       - list of agents for the dropdown
 * @param selectedAgentId - the currently selected agent (from ?agentId=X)
 * @param threads      - thread list (null = chatClient absent → degraded mode)
 * @param userName     - logged-in user's email for the toolbar
 */

const threadPaneStyles = `
    .thread-pane-list { display:flex;flex-direction:column;gap:4px;margin-top:8px }
    .thread-pane-link { display:block;padding:8px 12px;border-radius:6px;font-size:13px;color:#374151;text-decoration:none;background:#f9fafb;border:1px solid #e5e7eb }
    .thread-pane-link:hover { background:#eef2ff;color:#4f46e5 }
    .thread-pane-link.active { background:#eef2ff;color:#4f46e5;font-weight:600 }`;

const chatPageStyles = `
    .chat-sidebar-new-thread-input { font-size:12px }
    @media (max-width:${BREAKPOINT_MOBILE_MAX}px) {
      .chat-sidebar-new-thread-input { font-size:16px }
      .chat-list-layout { flex-direction:column }
      .chat-list-sidebar { width:100%;max-width:100%;min-width:0 }
      /* chat-thread-layout: flex wrapper for thread+message area; stacks to column on mobile */
      .chat-thread-layout { flex-direction:column }
      /* ─── Mobile thread drawer (CFB-3.2) ──────────────────────────────────
         The sidebar becomes an off-canvas drawer instead of display:none, so
         the thread list is reachable on mobile. It is translated off the left
         edge by default and slid in when the checkbox is :checked. A scrim
         dims/blocks the background and closes the drawer on tap. */
      .chat-thread-sidebar {
        position:fixed;top:0;left:0;bottom:0;z-index:102;
        width:80%;max-width:300px;min-width:0;
        margin:0;border-radius:0;overflow-y:auto;
        transform:translateX(-100%);
        transition:transform 0.2s ease;
      }
      .chat-drawer-toggle:checked ~ .chat-thread-sidebar { transform:translateX(0) }
      /* Scrim toggles display (not just opacity) so it's genuinely absent from
         the a11y/visibility tree when closed — Playwright's toBeVisible() (and
         assistive tech) treat an opacity:0 element as still visible. */
      .chat-drawer-scrim {
        display:none;position:fixed;inset:0;z-index:101;
        background:rgba(0,0,0,0.4);cursor:pointer;
      }
      .chat-drawer-toggle:checked ~ .chat-drawer-scrim { display:block }
      .chat-drawer-hamburger { display:inline-block }
      @media (prefers-reduced-motion: reduce) {
        .chat-thread-sidebar { transition:none }
      }
      /* Collapse the header to a compact ~48px control row + 16px meta line so
         the message stream sits above the fold at 375px (criterion #4). The
         title rides inline in the control row; the thread-id meta stays as the
         single 16px line. Per-thread token stats and the rename/delete
         disclosure are pushed off-header on mobile (still reachable via the
         drawer / desktop) to keep the header under 96px. */
      .chat-thread-header { padding-top:2px;padding-bottom:2px }
      .chat-thread-header-top { margin-bottom:2px !important }
      .chat-thread-header .chat-drawer-hamburger { padding:4px 8px }
      .chat-thread-header .btn { margin-bottom:0 !important;padding:4px 10px }
      .chat-thread-header .page-title { font-size:15px;line-height:1.2;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis }
      .chat-thread-header .chat-thread-meta { margin-top:2px !important }
      .chat-thread-header .chat-thread-stats { display:none }
      .chat-thread-header .chat-thread-actions { display:none }
      .chat-bubble-inner { max-width:90% }
      #message-input { font-size:16px }
      /* Composer row: let the textarea keep adequate width instead of being
         squeezed to ~160px next to the Attach/Send buttons at narrow widths. */
      .chat-composer-row { flex-wrap:wrap }
      .chat-message-input { flex-basis:100%; }
      /* .chat-thread-page combines with .vos-page (specificity 0,2,0), which
         otherwise beats .vos-page's own mobile padding rule (0,1,0) — pin the
         effective mobile padding here. The bottom padding is intentionally
         small: the sticky composer carries its own safe-area bottom inset, and
         a large page bottom padding would steal scarce vertical space when the
         keyboard shrinks the viewport (CFB-3.2 criterion #3). */
      .chat-thread-page { padding:8px 12px 8px }
      /* Tighten the gap between the header and the message column so the
         message stream starts higher (criterion #4). */
      .chat-thread-layout { margin-top:8px !important }
    }`;

// ─── Chat thread page — class-driven bubble/composer styling (CFB-1.3) ────────
// These class names are shared verbatim between the server-rendered HTML
// (renderMessageBubble()) and the inline JS bubble builder (addBubble()) so
// the two renderers physically cannot drift apart — see the interpolation of
// CHAT_BUBBLE_CLASS/CHAT_BUBBLE_INNER_CLASS into `inlineScript` below.
const CHAT_BUBBLE_CLASS = "chat-bubble";
const CHAT_BUBBLE_INNER_CLASS = "chat-bubble-inner";
const CHAT_BUBBLE_INNER_WIDE_CLASS = "chat-bubble-inner--wide";

/** e.g. "chat-bubble--user" — role is attacker-controlled only via server data, never used unescaped in an attribute here since roles are a closed set (user/assistant/system/other). */
function chatBubbleRoleClass(role: string): string {
  return `${CHAT_BUBBLE_CLASS}--${role}`;
}

// ─── Live progress (CFB-2.3) ──────────────────────────────────────────────────

/**
 * Human-readable label per errorKind. Single source of truth: used by the
 * server renderer (renderChatMessageBubble) AND serialized into the inline JS
 * (JSON.stringify(ERROR_KIND_LABELS)) so the client copy is generated from
 * this exact object and cannot drift — same pattern as CHAT_BUBBLE_CLASS.
 * A kind not present here falls back to DEFAULT_ERROR_LABEL.
 * `cancelled`/`incomplete`/`stalled` (CFB-2.4) are also retryable — see
 * RETRYABLE_ERROR_KINDS below.
 */
export const ERROR_KIND_LABELS: Record<string, string> = {
  "rate-limited": "Rate limited",
  upstream: "Request failed",
  timeout: "Timed out",
  cancelled: "Cancelled",
  incomplete: "Incomplete",
  stalled: "Stalled",
};
const DEFAULT_ERROR_LABEL = "Error";

/** Resolve an errorKind to its label, with the shared default fallback. */
function errorKindLabel(kind: string): string {
  return ERROR_KIND_LABELS[kind] ?? DEFAULT_ERROR_LABEL;
}

/**
 * Error kinds recoverable via the Retry button (CFB-2.4) — the reply never
 * really completed (cancelled via heartbeat tick, cut off mid-stream, or
 * stalled out), so re-sending the originating user message is safe and
 * likely to succeed. Kinds like rate-limited/timeout/upstream are excluded:
 * those already represent a completed, failed round-trip.
 */
const RETRYABLE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "cancelled",
  "incomplete",
  "stalled",
]);

// Stable DOM id/class for the live status bubble (elapsed + milestone). The
// server renders one when the last user message is unreplied, and the inline
// ticker JS finds/updates/creates it by this exact id so the "just loaded,
// agent still working" and "just sent, agent now working" bubbles are one and
// the same element.
const LIVE_STATUS_BUBBLE_ID = "live-status-bubble";
const LIVE_STATUS_ELAPSED_ID = "live-status-elapsed";
const LIVE_STATUS_MILESTONE_ID = "live-status-milestone";
const STALL_INDICATOR_CLASS = "chat-stall-indicator";

/**
 * Layer-1 elapsed-timer guarantee: the client-side 1s ticker computes
 * `now - createdAt` with ZERO network dependency. Layer-2 milestone text
 * refreshes off the existing messages.json poll (adaptive 2s pending / 10s
 * idle). STALL_WARN_AFTER_MS is a *visible warning* (not a giveup) shown once
 * progressSeq has been unchanged for this long; ABSOLUTE_MAX_MS is the only
 * hard stop.
 */
export const STALL_WARN_AFTER_MS = 120_000;
// 65min — mirrors lib/claim-ttl.ts's DEFAULT_CLAIM_TTL_MS
// (DEFAULT_CLAUDE_TIMEOUT_MS 1hr + CLAIM_TTL_BUFFER_MS 5min). Inline JS can't
// import the lib file, so the value is hardcoded here with this reference.
export const ABSOLUTE_MAX_MS = 3_900_000;

/**
 * Module-level pure bubble renderer (hoisted out of renderChatThreadPage in
 * CFB-2.3). Returns the exact HTML the server emits on a full page load; the
 * same string is returned as `bubbleHtml` from messages.json so polled bubbles
 * are byte-identical to reloaded ones. Every message bubble carries a stable
 * `data-message-id` so the client can dedupe via an id-based renderedIds set.
 *
 * `retryBody` (CFB-2.4) is the body of the most recent preceding user message
 * — when set and `m.errorKind` is one of RETRYABLE_ERROR_KINDS, the error
 * badge also renders a Retry button that resends that exact text. Callers
 * iterating a message list should track the last-seen user body and pass it
 * through per-message (see renderChatThreadPage and the messages.json route).
 *
 * `agentId` (VM-3.1) is needed to build the attachment-proxy URL
 * (`/admin/chat/:agentId/threads/:threadId/messages/:id/attachment`) used as
 * an audio attachment's `<audio src>` — defaults to "" for callers/tests that
 * don't pass it and don't care about attachment rendering.
 */
export function renderChatMessageBubble(
  m: ChatMessage,
  retryBody: string | null = null,
  agentId = "",
): string {
  const isUser = m.role === "user";
  const isAssistant = m.role === "assistant";
  const isSystem = m.role === "system";

  const bubbleRoleClass = chatBubbleRoleClass(
    isUser ? "user" : isAssistant ? "assistant" : isSystem ? "system" : "other",
  );
  const bubbleColor = isUser
    ? "#4f46e5"
    : isAssistant
      ? "#166534"
      : isSystem
        ? "#854d0e"
        : "#374151";
  const bubbleInnerClass = isSystem
    ? `${CHAT_BUBBLE_INNER_CLASS} ${CHAT_BUBBLE_INNER_WIDE_CLASS}`
    : CHAT_BUBBLE_INNER_CLASS;

  // Render error badge if errorKind is set. cancelled/incomplete/stalled are
  // recoverable states (CFB-2.4), so they also render a Retry action that
  // re-sends the originating user message.
  let errorBadge = "";
  if (m.errorKind) {
    const retryable =
      RETRYABLE_ERROR_KINDS.has(m.errorKind) && retryBody !== null;
    const retryAction = retryable
      ? `<button type="button" class="chat-retry-btn" data-retry-body="${escapeHtml(retryBody as string)}" style="margin-left:8px;padding:2px 8px;background:#fff;color:#b91c1c;border:1px solid #b91c1c;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer">Retry</button>`
      : "";
    errorBadge = `<div style="margin-top:6px;padding:4px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:12px;font-weight:600;display:inline-flex;align-items:center">${errorKindLabel(m.errorKind)}${retryAction}</div>`;
  }

  // Parse markers from assistant messages to extract URLs/paths and clean text
  let cleanedBody = m.body;
  let markerBadges = "";
  if (isAssistant) {
    const { cleaned, uploads, planUrls } = parseChatMarkers(m.body);
    cleanedBody = cleaned;

    // Render upload badges
    const uploadBadges = uploads
      .map((path) => {
        const filename = path.split("/").pop() || path;
        return `<div style="display:inline-block;margin-right:6px;margin-top:8px;padding:3px 8px;background:#e5e7eb;color:#374151;border-radius:6px;font-size:12px">📎 ${escapeHtml(filename)}</div>`;
      })
      .join("");

    // Render plan links
    const planLinks = planUrls
      .map(
        (url) =>
          `<a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;margin-right:6px;margin-top:8px;padding:3px 8px;background:#dbeafe;color:#1e40af;border-radius:6px;font-size:12px;text-decoration:none">View plan →</a>`,
      )
      .join("");

    markerBadges = uploadBadges + planLinks;
  }

  // Render body: assistant messages get markdown, others get escaped text
  const bodyHtml = isAssistant
    ? `<div style="font-size:14px;line-height:1.6;color:${bubbleColor}">${renderMarkdown(cleanedBody)}</div>`
    : `<div style="font-size:14px;white-space:pre-wrap;color:${bubbleColor}">${escapeHtml(m.body)}</div>`;

  // Attachment: an inline <audio> player for audio attachments (VM-3.1) —
  // mic-recorded user messages and VM-2.1's TTS-authored assistant replies —
  // otherwise the plain filename badge. Audio-ness is inferred from the
  // filename extension (see attachment-validation.ts's isAudioFilename); the
  // src hits the admin attachment-proxy route, which streams the message's
  // bytes from the chat service with a real audio/* Content-Type.
  const attachmentMedia = m.attachmentFilename
    ? isAudioFilename(m.attachmentFilename)
      ? `<audio controls style="display:block;margin-top:8px;max-width:100%" src="${escapeHtml(`/admin/chat/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(m.threadId)}/messages/${encodeURIComponent(m.id)}/attachment`)}"></audio>`
      : `<div style="display:inline-block;margin-top:8px;padding:3px 8px;background:#e5e7eb;color:#374151;border-radius:6px;font-size:12px">📎 ${escapeHtml(m.attachmentFilename)}</div>`
    : "";

  let tokenBadge = "";
  if (isAssistant && m.tokens !== null && typeof m.tokens === "object") {
    const t = m.tokens as MessageTokens;
    const inTok = t.input_tokens ?? 0;
    const outTok = t.output_tokens ?? 0;
    const costPart = m.costUsd !== null ? ` · $${m.costUsd.toFixed(4)}` : "";
    tokenBadge = `<div style="font-size:11px;color:#6b7280;margin-top:4px">${escapeHtml(`${inTok} in / ${outTok} out${costPart}`)}</div>`;
  }

  return `<div class="${CHAT_BUBBLE_CLASS} ${bubbleRoleClass}" data-message-id="${escapeHtml(m.id)}">
      <div class="${bubbleInnerClass}">
        <div style="font-size:11px;font-weight:600;color:${bubbleColor};margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(m.role)}</div>
        ${bodyHtml}
        ${markerBadges}
        ${attachmentMedia}
        ${errorBadge}
        ${tokenBadge}
        <div style="font-size:11px;color:#9ca3af;margin-top:6px">${escapeHtml(new Date(m.createdAt).toLocaleString())}</div>
      </div>
    </div>`;
}

/**
 * Server-rendered live status bubble shown when the last user message is
 * unreplied (`role === 'user' && !repliedAt`). Renders the elapsed timer seed
 * and (optionally) the current milestone. Uses stable ids so the inline
 * ticker finds and updates it on load without fabricating one. `progressPhase`
 * null ⇒ no milestone text (heartbeat hasn't reported a phase yet). The
 * elapsed seed is 0s server-side; the client ticker takes over immediately
 * from `data-created-at` with zero network dependency.
 */
function renderLiveStatusBubble(m: ChatMessage): string {
  const milestone =
    m.progressPhase &&
    PROGRESS_LABELS[m.progressPhase as keyof typeof PROGRESS_LABELS]
      ? PROGRESS_LABELS[m.progressPhase as keyof typeof PROGRESS_LABELS]
      : "";
  const milestoneHtml = `<span id="${LIVE_STATUS_MILESTONE_ID}">${escapeHtml(milestone)}</span>`;
  const createdAtMs = new Date(m.createdAt).getTime();
  const seq = m.progressSeq ?? 0;
  return `<div id="${LIVE_STATUS_BUBBLE_ID}" class="${CHAT_BUBBLE_CLASS} ${chatBubbleRoleClass("assistant")}" data-created-at="${createdAtMs}" data-progress-seq="${seq}">
      <div class="${CHAT_BUBBLE_INNER_CLASS}">
        <div style="font-size:14px;color:#166534;font-style:italic">
          ${milestoneHtml}
          <span id="${LIVE_STATUS_ELAPSED_ID}">working… (0s)</span>
        </div>
      </div>
    </div>`;
}

const chatThreadStyles = `
    /* The toolbar (.vos-toolbar) is a normal-flow sibling above .chat-thread-page,
       not fixed/absolute — so the page doesn't need to subtract a hardcoded
       toolbar height. Instead it grows to fill the remaining viewport via a
       flex-column body: min-height:100vh as a baseline, then min-height:100dvh
       as a progressive enhancement (dynamic viewport height accounts for
       mobile browser chrome that can grow the toolbar without breaking layout). */
    body { display:flex;flex-direction:column;min-height:100vh;min-height:100dvh;height:100dvh }
    .chat-thread-page { display:flex;flex-direction:column;flex:1;min-height:0;max-width:900px;margin:0 auto;padding:0 24px;width:100% }
    .chat-thread-header { padding-top:20px;padding-bottom:16px;flex-shrink:0 }
    /* Collapsed-by-default rename/delete disclosure (CFB-3.1 #5) — keeps the
       header compact above the fold regardless of viewport width. */
    .chat-thread-actions { margin-top:12px }
    .chat-thread-actions-summary { cursor:pointer;font-size:13px;color:#6b7280;user-select:none }
    .chat-thread-actions-summary:hover { color:#374151 }
    .chat-messages-container { flex:1;overflow-y:auto;overscroll-behavior:contain;padding:8px 0;min-height:0 }
    .${CHAT_BUBBLE_CLASS} { display:flex;margin-bottom:12px }
    .${chatBubbleRoleClass("user")} { justify-content:flex-end }
    .${chatBubbleRoleClass("assistant")} { justify-content:flex-start }
    .${chatBubbleRoleClass("system")} { justify-content:center }
    .${chatBubbleRoleClass("other")} { justify-content:flex-start }
    .${CHAT_BUBBLE_INNER_CLASS} { max-width:70%;border-radius:12px;padding:12px 16px;box-shadow:0 1px 2px rgba(0,0,0,0.06);overflow-wrap:anywhere }
    /* renderMarkdown emits <pre><code> for fenced blocks — let long code lines
       scroll horizontally inside the bubble instead of forcing the whole page
       to overflow. Scoped to the bubble so it doesn't affect other <pre>. */
    .${CHAT_BUBBLE_INNER_CLASS} pre { overflow-x:auto }
    .${CHAT_BUBBLE_INNER_CLASS}.${CHAT_BUBBLE_INNER_WIDE_CLASS} { max-width:80% }
    .${chatBubbleRoleClass("user")} .${CHAT_BUBBLE_INNER_CLASS} { background:#eef2ff }
    .${chatBubbleRoleClass("assistant")} .${CHAT_BUBBLE_INNER_CLASS} { background:#f0fdf4 }
    .${chatBubbleRoleClass("system")} .${CHAT_BUBBLE_INNER_CLASS} { background:#fef9c3 }
    .${chatBubbleRoleClass("other")} .${CHAT_BUBBLE_INNER_CLASS} { background:#f3f4f6 }
    /* Sticky composer: pins to the bottom of the scroll container so it stays
       reachable as messages grow. padding-bottom folds in the iOS safe-area
       inset plus --kb-inset (set by the visualViewport listener when the
       on-screen keyboard shrinks the visual viewport) so the composer isn't
       slid under the keyboard on iOS, where dvh does NOT shrink the layout. */
    .chat-composer-form { flex-shrink:0;position:sticky;bottom:0;background:#f7f7fb;padding:16px 0;padding-bottom:calc(12px + env(safe-area-inset-bottom) + var(--kb-inset, 0px));border-top:1px solid #e5e7eb;margin-top:8px }
    .chat-composer-row { display:flex;gap:8px;align-items:flex-end }
    .chat-message-input { flex:1;resize:vertical;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit;line-height:1.5;outline:none }
    .chat-composer-btn { flex-shrink:0;height:44px }
    .chat-composer-btn--attach { padding:0 16px }
    .chat-composer-btn--mic { padding:0 16px }
    .chat-composer-btn--mic.chat-mic-recording { background:#fee2e2;color:#b91c1c;border-color:#b91c1c }
    .chat-composer-btn--send { padding:0 20px }
    /* Live-progress stall state (CFB-2.3): when progressSeq hasn't advanced for
       STALL_WARN_AFTER_MS the status bubble gains .${STALL_INDICATOR_CLASS},
       which pulses to draw the eye. Motion is suppressed for users who ask for
       reduced motion — the amber colour still conveys the state statically. */
    .${STALL_INDICATOR_CLASS} { color:#b45309 }
    .${STALL_INDICATOR_CLASS} .${CHAT_BUBBLE_INNER_CLASS} { background:#fffbeb;animation:chat-stall-pulse 1.4s ease-in-out infinite }
    @keyframes chat-stall-pulse { 0%,100% { opacity:1 } 50% { opacity:0.55 } }
    @media (prefers-reduced-motion: reduce) {
      .${STALL_INDICATOR_CLASS} .${CHAT_BUBBLE_INNER_CLASS} { animation:none }
    }
    /* ─── Thread drawer (CFB-3.2) ────────────────────────────────────────────
       CSS-only collapsible sidebar mirroring the toolbar hamburger idiom. On
       desktop the sidebar is an ordinary flex column and the drawer chrome
       (toggle checkbox, scrim, hamburger) is inert/hidden — everything below
       only activates inside the mobile @media block in chatPageStyles. DOM
       order is load-bearing: the checkbox precedes the sidebar so the ~ sibling
       combinator can reach it. */
    .chat-drawer-toggle { position:absolute;opacity:0;width:1px;height:1px;pointer-events:none }
    .chat-drawer-hamburger { display:none;background:none;border:1px solid #e5e7eb;border-radius:6px;font-size:18px;line-height:1;padding:6px 10px;cursor:pointer;color:#374151 }
    .chat-drawer-hamburger:hover { color:#4f46e5 }
    .chat-drawer-scrim { display:none }`;

export function renderChatPage(
  agents: AgentOption[],
  selectedAgentId: string | undefined,
  threads: ChatThread[] | null,
  userName: string,
  q?: string,
): string {
  const activePath = "/admin/chat";

  const agentOptions = agents
    .map(
      (a) =>
        `<option value="${escapeHtml(a.id)}"${a.id === selectedAgentId ? " selected" : ""}>${escapeHtml(a.name)}</option>`,
    )
    .join("\n");

  const agentSelector = `
    <form method="GET" action="/admin/chat" class="form-row" style="margin-bottom:24px">
      <div class="form-group" style="max-width:320px">
        <label class="form-label" for="agentId">Agent</label>
        <select name="agentId" id="agentId" class="form-input" onchange="this.form.submit()">
          <option value="">— select an agent —</option>
          ${agentOptions}
        </select>
      </div>
    </form>`;

  let content: string;

  if (threads === null) {
    // Degraded mode — chat service not configured
    content = `
      <div class="alert alert-error">
        Chat service not configured. Set <code>SHIPWRIGHT_CHAT_SERVICE_URL</code> and
        <code>SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN</code> to enable this feature.
      </div>`;
  } else if (!selectedAgentId) {
    // No agent selected yet
    content = `
      <div class="empty-state">
        Select an agent above to view its threads.
      </div>`;
  } else {
    // Search box
    const searchForm = `
      <form method="GET" action="/admin/chat" class="form-row" style="margin-bottom:16px">
        <input type="hidden" name="agentId" value="${escapeHtml(selectedAgentId)}">
        <div class="form-group" style="max-width:320px">
          <input type="text" name="q" class="form-input" placeholder="Search threads…" value="${escapeHtml(q ?? "")}">
        </div>
        <button type="submit" class="btn btn-secondary">Search</button>
      </form>`;

    // New thread form (above the thread list)
    const newThreadForm = `
      <form method="POST" action="/admin/chat/${escapeHtml(selectedAgentId)}/threads" style="margin-bottom:16px">
        <div class="form-row">
          <div class="form-group">
            <input type="text" name="title" class="form-input" placeholder="Thread title (optional)">
          </div>
          <button type="submit" class="btn btn-primary">New Thread</button>
        </div>
      </form>`;

    // Thread list pane
    const threadLinks =
      threads.length === 0
        ? `<div class="empty-state" style="padding:12px">No threads found.</div>`
        : threads
            .map((t) => {
              const title = escapeHtml(t.title ?? "Untitled");
              return `<a href="/admin/chat/${escapeHtml(selectedAgentId)}/threads/${escapeHtml(t.id)}" class="thread-pane-link">${title}</a>`;
            })
            .join("\n");

    content = `
      ${searchForm}
      <div class="chat-list-layout" style="display:flex;gap:24px;align-items:flex-start">
        <div class="card chat-list-sidebar" style="min-width:240px;max-width:300px;flex-shrink:0">
          <div class="card-title">Threads</div>
          ${newThreadForm}
          <div class="thread-pane-list">
            ${threadLinks}
          </div>
        </div>
        <div style="flex:1">
          <div class="empty-state">Select a thread from the list to view messages.</div>
        </div>
      </div>`;
  }

  return renderAdminPage({
    title: "Chat — Shipwright Admin",
    extraStyles: `${threadPaneStyles}${chatPageStyles}
  `,
    body: `${renderAdminToolbar(userName, activePath)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Chat</h1>
    </div>
    ${agentSelector}
    ${content}
  </div>`,
  });
}

function formatTokenCount(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

/**
 * Renders a thread detail page at /admin/chat/:agentId/threads/:threadId.
 *
 * @param agentId  - agent ID
 * @param thread   - thread object (null = chatClient absent -> degraded mode)
 * @param messages - messages for the thread (null = degraded mode)
 * @param threads  - list of all threads for the sidebar pane (null = not available)
 * @param userName - logged-in user's email for the toolbar
 */
export function renderChatThreadPage(
  agentId: string,
  thread: ChatThread | null,
  messages: ChatMessage[] | null,
  threadsOrUserName: ChatThread[] | null | string,
  userNameArg?: string,
  stats?: ThreadStats | null,
  opts?: {
    stallWarnAfterMs?: number;
    // Push-notification toggle (CFB-4.2). When push is disabled server-side
    // (VAPID not fully configured), pushEnabled is false / vapidPublicKey is
    // absent, renderPushToggle returns "", and the page degrades to exactly the
    // CFB-3.2 page (acceptance criterion 6).
    pushEnabled?: boolean;
    vapidPublicKey?: string;
  },
): string {
  // The stall-warning threshold is normally the 120s production default, but
  // the e2e suite overrides it to a tiny value (via a query param the route
  // handler forwards here) so the stall-state assertion doesn't need a real
  // two-minute wait. Production behaviour is unaffected.
  const stallWarnAfterMs = opts?.stallWarnAfterMs ?? STALL_WARN_AFTER_MS;
  // Support both 4-arg (threads omitted) and 5-arg call signatures
  const threads: ChatThread[] | null =
    typeof threadsOrUserName === "string" ? null : threadsOrUserName;
  const userName: string =
    typeof threadsOrUserName === "string"
      ? threadsOrUserName
      : (userNameArg ?? "");
  const activePath = "/admin/chat";

  if (thread === null || messages === null) {
    return renderAdminPage({
      title: "Thread - Shipwright Admin",
      body: `${renderAdminToolbar(userName, activePath)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">Thread</h1>
    </div>
    <div class="alert alert-error">
      Chat service not configured. Set <code>SHIPWRIGHT_CHAT_SERVICE_URL</code> and
      <code>SHIPWRIGHT_CHAT_SERVICE_ADMIN_TOKEN</code> to enable this feature.
    </div>
  </div>`,
    });
  }

  const threadId = thread.id;
  // rawTitle feeds renderAdminPage(), which HTML-escapes it itself; `title`
  // is the pre-escaped display string used inline in body markup below —
  // keep both to avoid double-escaping the <title> tag.
  const rawTitle = thread.title ?? "Untitled Thread";
  const title = thread.title ? escapeHtml(thread.title) : "Untitled Thread";

  // Track the most recent user message body while iterating so an error
  // reply's Retry button (CFB-2.4) can resend the exact text that triggered
  // it. renderChatMessageBubble is the module-level renderer (hoisted in
  // CFB-2.3) so the same retryBody-aware logic is shared with the
  // messages.json poll route.
  let lastUserBody: string | null = null;
  const messageBubbles = messages
    .map((m) => {
      const html = renderChatMessageBubble(m, lastUserBody, agentId);
      if (m.role === "user") lastUserBody = m.body;
      return html;
    })
    .join("\n");

  // Server-render the live status bubble when the last user message has no
  // reply yet — so a full-page reload mid-run shows the elapsed/milestone
  // immediately instead of a 3s-later blank until the first poll ticks in.
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const pendingMsg =
    lastMsg && lastMsg.role === "user" && !lastMsg.repliedAt ? lastMsg : null;
  const liveStatusBubble = pendingMsg ? renderLiveStatusBubble(pendingMsg) : "";

  const emptyState =
    messages.length === 0
      ? `<div class="empty-state" style="text-align:center;padding:48px 24px;color:#9ca3af">No messages in this thread yet. Send a message to get started.</div>`
      : "";

  const safeAgentId = escapeHtml(agentId);
  const safeThreadId = escapeHtml(threadId);

  const renameForm = `
    <form method="POST" action="/admin/chat/${escapeHtml(agentId)}/threads/${escapeHtml(threadId)}/rename" style="margin-top:12px">
      <div class="form-row" style="align-items:center;gap:8px">
        <input type="text" name="title" class="form-input" placeholder="New title…" style="max-width:240px" required>
        <button type="submit" class="btn btn-secondary" style="white-space:nowrap">Rename</button>
      </div>
    </form>`;

  const deleteForm = `
    <form method="POST" action="/admin/chat/${escapeHtml(agentId)}/threads/${escapeHtml(threadId)}/delete" style="margin-top:8px" onsubmit="return confirm('Delete this thread?')">
      <button type="submit" class="btn btn-danger">Delete Thread</button>
    </form>`;

  // Collapsed by default so rename/delete controls don't eat vertical space
  // above the fold before any conversation is visible on a short mobile
  // viewport — a plain <details>/<summary> disclosure, no JS required.
  const threadActionsDetails = `
    <details class="chat-thread-actions">
      <summary class="chat-thread-actions-summary">Thread actions</summary>
      ${renameForm}
      ${deleteForm}
    </details>`;

  // Inline JS for the send/poll/live-progress flow (CFB-2.3).
  //
  // Two layers, per the brief:
  //   Layer 1 — a 1s client-side ticker computing now - createdAt with ZERO
  //     network dependency. A dead agent, dead chat service or offline laptop
  //     still ticks; that is the actual "never go silent" guarantee.
  //   Layer 2 — milestone text refreshed off the messages.json poll, adaptive
  //     2s while pending / 10s idle. The milestone is content, not the
  //     guarantee.
  //
  // The live status bubble (${LIVE_STATUS_BUBBLE_ID}) is a single element the
  // server may have rendered (mid-run reload) or the client creates on send.
  // Its data-created-at drives the ticker; data-progress-seq drives skew-free
  // stall detection (compare poll counts since progressSeq last changed, never
  // wall clocks).
  const inlineScript = `
<script>
(function() {
  var form = document.getElementById('send-form');
  var input = document.getElementById('message-input');
  var sendBtn = document.getElementById('send-btn');
  var attachBtn = document.getElementById('attach-btn');
  var fileInput = document.getElementById('file-input');
  var fileName = document.getElementById('file-name');
  var micBtn = document.getElementById('mic-btn');
  var container = document.getElementById('messages-container');
  var agentId = ${JSON.stringify(agentId)};
  var threadId = ${JSON.stringify(thread.id)};
  var messagesJsonUrl = '/admin/chat/' + encodeURIComponent(agentId) + '/threads/' + encodeURIComponent(threadId) + '/messages.json';
  var uploadUrl = '/admin/chat/' + encodeURIComponent(agentId) + '/threads/' + encodeURIComponent(threadId) + '/messages/upload';

  // errorKind → label, generated from the server's single source of truth so
  // the two copies cannot drift.
  var ERROR_KIND_LABELS = ${JSON.stringify(ERROR_KIND_LABELS)};
  var DEFAULT_ERROR_LABEL = ${JSON.stringify(DEFAULT_ERROR_LABEL)};
  function errorKindLabel(kind) {
    return ERROR_KIND_LABELS[kind] || DEFAULT_ERROR_LABEL;
  }

  // Milestone labels, likewise serialized from lib/progress-phases.ts.
  var PROGRESS_LABELS = ${JSON.stringify(PROGRESS_LABELS)};

  // Stall-warning threshold — 120s in prod; e2e overrides to a tiny value.
  var STALL_WARN_AFTER_MS = ${stallWarnAfterMs};
  // Hard ceiling: 65min, mirrors lib/claim-ttl.ts DEFAULT_CLAIM_TTL_MS
  // (1hr DEFAULT_CLAUDE_TIMEOUT_MS + 5min CLAIM_TTL_BUFFER_MS). Only hard stop.
  var ABSOLUTE_MAX_MS = ${ABSOLUTE_MAX_MS};

  var LIVE_STATUS_BUBBLE_ID = ${JSON.stringify(LIVE_STATUS_BUBBLE_ID)};
  var LIVE_STATUS_ELAPSED_ID = ${JSON.stringify(LIVE_STATUS_ELAPSED_ID)};
  var LIVE_STATUS_MILESTONE_ID = ${JSON.stringify(LIVE_STATUS_MILESTONE_ID)};
  var STALL_INDICATOR_CLASS = ${JSON.stringify(STALL_INDICATOR_CLASS)};
  var ASSISTANT_ROLE_CLASS = '${CHAT_BUBBLE_CLASS} ${chatBubbleRoleClass("assistant")}';

  // Poll cadence.
  var POLL_PENDING_MS = 2000; // adaptive fast poll while a reply is pending
  var POLL_IDLE_MS = 10000;   // slow idle poll for agent-initiated messages

  // Rendered-message dedupe: every server bubble carries data-message-id;
  // seed the set from what's already in the DOM so polls never double-render.
  var renderedIds = {};
  Array.prototype.forEach.call(
    container.querySelectorAll('[data-message-id]'),
    function(el) { renderedIds[el.getAttribute('data-message-id')] = true; }
  );

  var pollTimer = null;
  var tickerTimer = null;
  // Skew-free stall tracking: remember the progressSeq we last saw and the
  // wall-clock ms at which it last CHANGED (client clock only — never compared
  // against server timestamps).
  var lastProgressSeq = null;
  var lastProgressChangeMs = null;

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Optimistic user bubble (pre-round-trip; body is plain text, so no markdown
  // — matches the server's white-space:pre-wrap user rendering). Assistant and
  // reloaded bubbles are NEVER built here: they come from server bubbleHtml.
  // \`file\` (VM-3.1) may be a picked file OR a mic-recorded Blob/File — for
  // an audio file this renders an inline <audio> player immediately, using a
  // local object URL (no round-trip needed to preview what was just
  // recorded); everything else still gets the plain filename badge.
  function addUserBubble(body, file) {
    var color = '#4f46e5';
    var attachmentHtml = '';
    if (file) {
      if (file.type && file.type.indexOf('audio/') === 0) {
        attachmentHtml = '<audio controls style="display:block;margin-top:8px;max-width:100%" src="' + URL.createObjectURL(file) + '"></audio>';
      } else {
        attachmentHtml = '<div style="display:inline-block;margin-top:8px;padding:3px 8px;background:#e5e7eb;color:#374151;border-radius:6px;font-size:12px">📎 ' + escHtml(file.name) + '</div>';
      }
    }
    var bubble = document.createElement('div');
    bubble.className = '${CHAT_BUBBLE_CLASS} ${CHAT_BUBBLE_CLASS}--user';
    bubble.innerHTML = '<div class="${CHAT_BUBBLE_INNER_CLASS}">'
      + '<div style="font-size:11px;font-weight:600;color:' + color + ';margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">user</div>'
      + '<div style="font-size:14px;white-space:pre-wrap;color:' + color + '">' + escHtml(body) + '</div>'
      + attachmentHtml
      + '</div>';
    insertBeforeLiveStatus(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
  }

  // Insert a bubble before the live-status bubble (so status stays at the
  // bottom) or append if there's no live-status bubble.
  function insertBeforeLiveStatus(node) {
    var live = document.getElementById(LIVE_STATUS_BUBBLE_ID);
    if (live) container.insertBefore(node, live);
    else container.appendChild(node);
  }

  // Insert a server-rendered bubbleHtml string, deduped by id.
  function renderServerBubble(m) {
    if (!m || !m.id || renderedIds[m.id]) return false;
    renderedIds[m.id] = true;
    if (!m.bubbleHtml) return false;
    var tpl = document.createElement('template');
    tpl.innerHTML = m.bubbleHtml.trim();
    var node = tpl.content.firstChild;
    if (node) insertBeforeLiveStatus(node);
    return true;
  }

  // True when the user is within ~80px of the bottom, i.e. hasn't scrolled up
  // to read history. Polls only auto-scroll in that case.
  function isNearBottom() {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  }

  // Ensure the live status bubble exists (creating it on the client when the
  // user just sent a message and the server hasn't rendered one). Scrolls to
  // the bottom unless noScroll is true (poll with the user scrolled up).
  function ensureLiveStatusBubble(createdAtMs, noScroll) {
    var live = document.getElementById(LIVE_STATUS_BUBBLE_ID);
    if (live) return live;
    live = document.createElement('div');
    live.id = LIVE_STATUS_BUBBLE_ID;
    live.className = ASSISTANT_ROLE_CLASS;
    live.setAttribute('data-created-at', String(createdAtMs));
    live.setAttribute('data-progress-seq', '0');
    live.innerHTML = '<div class="${CHAT_BUBBLE_INNER_CLASS}">'
      + '<div style="font-size:14px;color:#166534;font-style:italic">'
      + '<span id="' + LIVE_STATUS_MILESTONE_ID + '"></span> '
      + '<span id="' + LIVE_STATUS_ELAPSED_ID + '">working… (0s)</span>'
      + '</div></div>';
    container.appendChild(live);
    if (!noScroll) container.scrollTop = container.scrollHeight;
    return live;
  }

  function removeLiveStatusBubble() {
    var live = document.getElementById(LIVE_STATUS_BUBBLE_ID);
    if (live && live.parentNode) live.parentNode.removeChild(live);
    lastProgressSeq = null;
    lastProgressChangeMs = null;
  }

  // Layer 1: the ZERO-network ticker. Runs every 1s off the live bubble's
  // data-created-at. Also applies the stall class when progressSeq has been
  // frozen past STALL_WARN_AFTER_MS, and hard-stops at ABSOLUTE_MAX_MS.
  function tick() {
    var live = document.getElementById(LIVE_STATUS_BUBBLE_ID);
    if (!live) return;
    var createdAtMs = Number(live.getAttribute('data-created-at')) || Date.now();
    var elapsedMs = Date.now() - createdAtMs;
    var elapsedSec = Math.max(0, Math.round(elapsedMs / 1000));
    var elapsedEl = document.getElementById(LIVE_STATUS_ELAPSED_ID);
    if (elapsedEl) elapsedEl.textContent = 'working… (' + elapsedSec + 's)';

    // Stall detection is time-since-progressSeq-last-changed, on the client
    // clock only. Seed the change time on first sight.
    if (lastProgressChangeMs === null) lastProgressChangeMs = Date.now();
    var stalledFor = Date.now() - lastProgressChangeMs;
    if (stalledFor >= STALL_WARN_AFTER_MS) {
      live.classList.add(STALL_INDICATOR_CLASS);
    } else {
      live.classList.remove(STALL_INDICATOR_CLASS);
    }

    if (elapsedMs >= ABSOLUTE_MAX_MS) {
      // Only hard stop: replace the live bubble with a terminal error and
      // stop everything.
      stopAll();
      removeLiveStatusBubble();
      var errBubble = document.createElement('div');
      errBubble.className = ASSISTANT_ROLE_CLASS;
      errBubble.innerHTML = '<div class="${CHAT_BUBBLE_INNER_CLASS}">'
        + '<div style="margin-top:0;padding:4px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:12px;font-weight:600">Request timed out. Please try again.</div>'
        + '</div>';
      container.appendChild(errBubble);
      enableSend();
    }
  }

  function startTicker() {
    if (tickerTimer) return;
    tick();
    tickerTimer = setInterval(tick, 1000);
  }

  function updateMilestone(phase) {
    var el = document.getElementById(LIVE_STATUS_MILESTONE_ID);
    if (!el) return;
    el.textContent = phase && PROGRESS_LABELS[phase] ? PROGRESS_LABELS[phase] : '';
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }
  function stopTicker() {
    if (tickerTimer) { clearInterval(tickerTimer); tickerTimer = null; }
  }
  function stopAll() { stopPolling(); stopTicker(); }

  function enableSend() {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    if (micBtn) micBtn.disabled = false;
  }

  // Adaptive poll: fast while a reply is pending, slow while idle (so
  // agent-initiated messages still appear without a reload).
  function schedulePoll(delay) {
    stopPolling();
    pollTimer = setTimeout(poll, delay);
  }

  function poll() {
    fetch(messagesJsonUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var msgs = data.messages || [];

        // Capture before rendering new bubbles grows scrollHeight.
        var stickToBottom = isNearBottom();

        // Render every new (un-rendered) message from the server, in order —
        // fixes "only the last reply appears" and "agent-initiated messages
        // need a reload". Assistant/user/system all go through server
        // bubbleHtml, which already includes any Retry button (CFB-2.4) since
        // the server computes retryBody per-message; wire up any new buttons
        // after insertion (see wireRetryButtons below).
        for (var i = 0; i < msgs.length; i++) {
          renderServerBubble(msgs[i]);
        }
        wireRetryButtons();

        // Determine whether a reply is still pending (last message is an
        // unreplied user message).
        var last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        var pending = last && last.role === 'user' && !last.repliedAt ? last : null;

        if (pending) {
          // Keep the live status bubble present and in sync.
          var createdAtMs = pending.createdAt ? new Date(pending.createdAt).getTime() : Date.now();
          var live = ensureLiveStatusBubble(createdAtMs, !stickToBottom);
          live.setAttribute('data-created-at', String(createdAtMs));
          startTicker();
          updateMilestone(pending.progressPhase);

          // Skew-free stall tracking: reset the change clock only when
          // progressSeq actually advances.
          var seq = typeof pending.progressSeq === 'number' ? pending.progressSeq : 0;
          if (lastProgressSeq === null || seq !== lastProgressSeq) {
            lastProgressSeq = seq;
            lastProgressChangeMs = Date.now();
          }
          live.setAttribute('data-progress-seq', String(seq));

          if (stickToBottom) container.scrollTop = container.scrollHeight;
          schedulePoll(POLL_PENDING_MS);
        } else {
          // No reply pending: reply landed (or nothing in flight). Tear down
          // the live status bubble and re-enable send, then keep a slow idle
          // poll running so agent-initiated messages still show up live.
          removeLiveStatusBubble();
          stopTicker();
          enableSend();
          if (stickToBottom) container.scrollTop = container.scrollHeight;
          schedulePoll(POLL_IDLE_MS);
        }
      })
      .catch(function() {
        // Network error — Layer 1 ticker keeps going untouched; just retry the
        // poll on the pending cadence.
        schedulePoll(POLL_PENDING_MS);
      });
  }

  // Attach-file button opens the hidden file input; show the chosen name.
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', function() {
      fileInput.click();
    });
    fileInput.addEventListener('change', function() {
      var f = fileInput.files && fileInput.files[0];
      fileName.textContent = f ? ('📎 ' + f.name) : '';
    });
  }

  // Mic-record button (VM-3.1): records via MediaRecorder and submits the
  // resulting Blob through the SAME sendText()/upload flow as a picked file
  // — no separate endpoint. Click once to start, click again (or the button
  // relabels to a stop icon) to stop and send. Candidate MIME types are
  // ordered by preference; attachment-validation.ts's allowlist accepts all
  // three so whichever the browser actually supports still uploads cleanly.
  var MIC_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg', 'audio/mp4'];
  var mediaRecorder = null;
  var micStream = null;
  var recordedChunks = [];

  function micSupported() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function stopMicStream() {
    if (micStream) {
      micStream.getTracks().forEach(function(t) { t.stop(); });
      micStream = null;
    }
  }

  function setMicRecordingUI(recording) {
    if (!micBtn) return;
    micBtn.textContent = recording ? '⏹' : '🎤';
    micBtn.classList.toggle('chat-mic-recording', recording);
    micBtn.setAttribute('aria-label', recording ? 'Stop recording' : 'Record a voice message');
  }

  if (micBtn) {
    if (!micSupported()) {
      // Graceful degradation: no MediaRecorder/getUserMedia in this browser
      // (or non-HTTPS context) — hide the button rather than offer a dead
      // control.
      micBtn.style.display = 'none';
    } else {
      micBtn.addEventListener('click', function() {
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
          return;
        }
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
          micStream = stream;
          recordedChunks = [];
          var mimeType = '';
          for (var i = 0; i < MIC_MIME_CANDIDATES.length; i++) {
            if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(MIC_MIME_CANDIDATES[i])) {
              mimeType = MIC_MIME_CANDIDATES[i];
              break;
            }
          }
          try {
            mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
          } catch (e) {
            stopMicStream();
            return;
          }
          mediaRecorder.addEventListener('dataavailable', function(e) {
            if (e.data && e.data.size > 0) recordedChunks.push(e.data);
          });
          mediaRecorder.addEventListener('stop', function() {
            stopMicStream();
            setMicRecordingUI(false);
            var rawType = mediaRecorder.mimeType || mimeType || 'audio/webm';
            // Chromium reports audio-only recordings as video/webm; normalize so
            // the File is never non-audio/*.
            var blobType = rawType.indexOf('audio/') === 0 ? rawType : rawType.replace(/^[^;/]*/, 'audio');
            var blob = new Blob(recordedChunks, { type: blobType });
            recordedChunks = [];
            if (blob.size === 0) return;
            var ext = blobType.indexOf('ogg') !== -1 ? 'ogg' : blobType.indexOf('mp4') !== -1 ? 'm4a' : 'webm';
            var file = new File([blob], 'recording-' + Date.now() + '.' + ext, { type: blobType });
            sendText('', file);
          });
          mediaRecorder.start();
          setMicRecordingUI(true);
        }).catch(function() {
          // Permission denied, no mic, or blocked context — no-op; the
          // button simply stays in its idle state.
        });
      });
    }
  }

  function clearFile() {
    if (fileInput) fileInput.value = '';
    if (fileName) fileName.textContent = '';
  }

  function sendText(text, file) {
    if (!text && !file) return;

    // Disable send button (and mic — no recording mid-send)
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    if (micBtn) micBtn.disabled = true;

    // Build multipart body before clearing the inputs
    var fd = new FormData();
    fd.append('body', text);
    if (file) fd.append('file', file);

    // Add user bubble optimistically (with attachment preview if present).
    addUserBubble(text, file);

    // Show the live status bubble + start the ticker immediately — Layer 1
    // begins ticking with zero network dependency.
    ensureLiveStatusBubble(Date.now());
    lastProgressSeq = null;
    lastProgressChangeMs = Date.now();
    startTicker();

    // POST multipart to the upload endpoint
    fetch(uploadUrl, {
      method: 'POST',
      body: fd
    }).then(function(r) {
      if (!r.ok) {
        return r.json().then(function(data) {
          stopAll();
          removeLiveStatusBubble();
          var errBubble = document.createElement('div');
          errBubble.className = ASSISTANT_ROLE_CLASS;
          errBubble.innerHTML = '<div class="${CHAT_BUBBLE_INNER_CLASS}">'
            + '<div style="margin-top:0;padding:4px 8px;background:#fee2e2;color:#b91c1c;border-radius:4px;font-size:12px;font-weight:600">' + escHtml((data && data.error) || 'Upload failed.') + '</div>'
            + '</div>';
          container.appendChild(errBubble);
          enableSend();
        });
      } else {
        // Success: parse response and seed renderedIds to prevent duplicate rendering
        return r.json().then(function(data) {
          if (data && data.message && data.message.id) {
            renderedIds[data.message.id] = true;
          }
        });
      }
    }).catch(function() {
      // POST failed — Layer 1 ticker keeps going; poll loop still starts.
    });

    // Start the fast poll loop.
    schedulePoll(POLL_PENDING_MS);
  }

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var text = input.value.trim();
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!text && !file) return;
    input.value = '';
    clearFile();
    sendText(text, file);
  });

  // Retry buttons (CFB-2.4) resend the exact user message body that
  // triggered the errored/cancelled/incomplete/stalled reply — rendered
  // server-side as a data attribute on each button (see
  // renderChatMessageBubble). Buttons can arrive either on initial page load
  // or later via renderServerBubble during a poll (which dedupes by
  // data-message-id, so a given button is only ever inserted into the DOM
  // once); re-running this after every render pass is therefore safe and
  // never double-wires a button.
  function wireRetryButtons() {
    document.querySelectorAll('.chat-retry-btn').forEach(function(btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', function() {
        if (btn.disabled) return;
        var body = btn.getAttribute('data-retry-body');
        if (!body) return;
        btn.disabled = true;
        sendText(body, null);
      });
    });
  }
  wireRetryButtons();

  // On load: if the server rendered a live status bubble (mid-run reload),
  // start the ticker immediately and begin polling on the pending cadence.
  // Otherwise begin a slow idle poll so agent-initiated messages appear live.
  var serverLive = document.getElementById(LIVE_STATUS_BUBBLE_ID);
  if (serverLive) {
    var seedSeq = Number(serverLive.getAttribute('data-progress-seq'));
    lastProgressSeq = isNaN(seedSeq) ? 0 : seedSeq;
    lastProgressChangeMs = Date.now();
    startTicker();
    schedulePoll(POLL_PENDING_MS);
  } else {
    schedulePoll(POLL_IDLE_MS);
  }

  // Scroll to bottom on load
  container.scrollTop = container.scrollHeight;
})();
</script>`;

  // Standalone drawer + keyboard-inset script (CFB-3.2). Deliberately emitted
  // as its OWN <script> block — NOT inside the progress IIFE above — so the two
  // concerns don't fight the ongoing live-progress rewrite. Three tiny jobs:
  //   1. visualViewport → --kb-inset: on iOS the on-screen keyboard shrinks the
  //      VISUAL viewport but leaves the LAYOUT viewport (and dvh) alone, sliding
  //      the sticky composer under the keyboard. Setting --kb-inset to the
  //      occluded height lets CSS pad the composer back into view. Guarded by
  //      `if (!vv) return` — no speculative fallback for browsers without it.
  //   2. aria-expanded sync on the hamburger, mirroring the toolbar idiom.
  //   3. Escape closes the drawer (a bare checkbox can't listen for keys).
  const drawerScript = `
<script>
(function() {
  var vv = window.visualViewport;
  if (!vv) return;
  var root = document.documentElement;
  function updateKbInset() {
    // Occluded height = layout viewport height minus the visual viewport
    // height (plus its offset). Clamp to >= 0. On Android where dvh already
    // shrinks the layout this stays ~0, which is correct.
    var occluded = window.innerHeight - vv.height - vv.offsetTop;
    root.style.setProperty('--kb-inset', (occluded > 0 ? occluded : 0) + 'px');
  }
  vv.addEventListener('resize', updateKbInset);
  vv.addEventListener('scroll', updateKbInset);
  updateKbInset();
})();
(function() {
  var toggle = document.getElementById('chat-drawer-toggle');
  if (!toggle) return;
  var burger = document.querySelector('.chat-drawer-hamburger');
  function syncAria() {
    if (burger) burger.setAttribute('aria-expanded', toggle.checked ? 'true' : 'false');
  }
  toggle.addEventListener('change', syncAria);
  document.addEventListener('keydown', function(e) {
    if ((e.key === 'Escape' || e.key === 'Esc') && toggle.checked) {
      toggle.checked = false;
      syncAria();
    }
  });
})();
</script>`;

  // Thread list sidebar pane
  // NOTE: no inline font-size here — an inline style would beat the
  // .form-input mobile @media override by specificity and reintroduce the
  // iOS Safari zoom-on-focus defect. Sizing is handled entirely via the
  // .chat-sidebar-new-thread-input class below.
  const newThreadForm = `
    <form method="POST" action="/admin/chat/${escapeHtml(agentId)}/threads" style="margin-bottom:12px">
      <div class="form-row" style="gap:6px">
        <input type="text" name="title" class="form-input chat-sidebar-new-thread-input" placeholder="New thread title…">
        <button type="submit" class="btn btn-primary" style="white-space:nowrap;padding:6px 10px">New Thread</button>
      </div>
    </form>`;

  const threadLinks = threads
    ? threads.length === 0
      ? `<div class="empty-state" style="padding:12px">No threads.</div>`
      : threads
          .map((t) => {
            const tTitle = escapeHtml(t.title ?? "Untitled");
            const isActive = t.id === threadId;
            return `<a href="/admin/chat/${escapeHtml(agentId)}/threads/${escapeHtml(t.id)}" class="thread-pane-link${isActive ? " active" : ""}">${tTitle}</a>`;
          })
          .join("\n")
    : "";

  const sidebar =
    threads !== null
      ? `<div id="chat-thread-sidebar-panel" class="card chat-thread-sidebar" style="min-width:220px;max-width:280px;flex-shrink:0">
          <div class="card-title">Threads</div>
          ${newThreadForm}
          <div class="thread-pane-list">
            ${threadLinks}
          </div>
        </div>`
      : "";

  // Drawer chrome (CFB-3.2). Only render the CSS-only toggle + scrim + hamburger
  // when there's actually a sidebar to reveal — in degraded/no-threads mode the
  // sidebar ternary yields "" and the drawer would be an empty shell. DOM order
  // is load-bearing: the checkbox must precede the sidebar and scrim so the
  // `~` sibling combinator can reach them from `:checked`.
  const drawerToggle = sidebar
    ? `<input type="checkbox" id="chat-drawer-toggle" class="chat-drawer-toggle" aria-hidden="true">`
    : "";
  const drawerScrim = sidebar
    ? `<label for="chat-drawer-toggle" class="chat-drawer-scrim" aria-label="Close thread list"></label>`
    : "";
  // aria-controls references the revealed panel's own id (not the checkbox) —
  // matches the aria-controls="vos-nav-content" pattern in lib/web/toolbar.ts.
  const drawerHamburger = sidebar
    ? `<label for="chat-drawer-toggle" class="chat-drawer-hamburger" role="button" tabindex="0" aria-label="Toggle thread list" aria-expanded="false" aria-controls="chat-thread-sidebar-panel">☰</label>`
    : "";

  return renderAdminPage({
    title: `${rawTitle} - Shipwright Admin`,
    // NOTE: chatThreadStyles must be concatenated before chatPageStyles here —
    // chatPageStyles's mobile @media (max-width:640px) override for
    // .chat-bubble-inner has the same specificity as chatThreadStyles's
    // unconditional base rule, so whichever is concatenated *last* wins the
    // cascade. Putting chatPageStyles last ensures the mobile override
    // actually takes effect at ≤640px instead of being silently shadowed.
    extraStyles: `${threadPaneStyles}${chatThreadStyles}${chatPageStyles}
  `,
    body: `${renderAdminToolbar(userName, activePath)}
  <div class="vos-page chat-thread-page">
    <div class="page-header chat-thread-header">
      <div>
        <div class="chat-thread-header-top" style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          ${drawerHamburger}
          <a href="/admin/chat?agentId=${safeAgentId}" class="btn btn-secondary">&larr; Back to threads</a>
        </div>
        <h1 class="page-title">${title}</h1>
        <div class="chat-thread-meta" style="font-size:12px;color:#9ca3af;margin-top:4px">Thread <span class="mono">${safeThreadId}</span></div>
        ${
          stats &&
          (
            stats.totalInputTokens > 0 ||
              stats.totalOutputTokens > 0 ||
              stats.totalCostUsd > 0
          )
            ? `<div class="chat-thread-stats" style="font-size:12px;color:#6b7280;margin-top:4px">${escapeHtml(`${formatTokenCount(stats.totalInputTokens)} in / ${formatTokenCount(stats.totalOutputTokens)} out | $${stats.totalCostUsd.toFixed(4)}`)}</div>`
            : ""
        }
        ${threadActionsDetails}
        ${renderPushToggle({
          pushEnabled: opts?.pushEnabled ?? false,
          vapidPublicKey: opts?.vapidPublicKey ?? "",
          agentId,
          threadId,
        })}
      </div>
    </div>
    <div class="chat-thread-layout" style="display:flex;gap:24px;flex:1;min-height:0;margin-top:16px">
      ${drawerToggle}
      ${sidebar}
      ${drawerScrim}
      <div style="flex:1;min-width:0;min-height:0;display:flex;flex-direction:column">
        <!-- Messages area (scrollable) -->
        <div id="messages-container" class="chat-messages-container">
          ${messageBubbles}
          ${liveStatusBubble}
          ${emptyState}
        </div>

        <!-- Send form -->
        <form id="send-form" enctype="multipart/form-data" class="chat-composer-form">
          <div class="chat-composer-row">
            <textarea
              id="message-input"
              name="body"
              rows="3"
              placeholder="Type a message..."
              class="chat-message-input"
            ></textarea>
            <input type="file" id="file-input" name="file" style="display:none" accept="text/*,image/*,application/pdf,application/json">
            <button
              type="button"
              id="mic-btn"
              class="btn btn-secondary chat-composer-btn chat-composer-btn--mic"
              aria-label="Record a voice message"
              title="Record a voice message"
            >🎤</button>
            <button
              type="button"
              id="attach-btn"
              class="btn btn-secondary chat-composer-btn chat-composer-btn--attach"
            >Attach file</button>
            <button
              type="submit"
              id="send-btn"
              class="btn btn-primary chat-composer-btn chat-composer-btn--send"
            >Send</button>
          </div>
          <div id="file-name" style="font-size:12px;color:#6b7280;margin-top:6px;min-height:16px"></div>
        </form>
      </div>
    </div>
  </div>`,
    bodyEnd: `${inlineScript}\n${drawerScript}`,
  });
}
