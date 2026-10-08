/**
 * admin/src/admin-ui-account-pages.ts
 * Render functions for the self-serve account page and the zero-quota notice
 * (SSP-3.2). Pure string -> string; routes live in admin-ui-account.ts.
 */

import type { AccountInvite } from "./account-invites.ts";
import type { AccountMember } from "./account-members.ts";
import type { Account } from "./accounts.ts";
import { renderAdminPage } from "./admin-ui-layout.ts";
import { escapeHtml, renderAdminToolbar } from "./admin-ui-styles.ts";

export const ACCOUNT_PATH = "/admin/account";

export interface AccountPageOpts {
  userEmail: string;
  account: Account;
  agentCount: number;
  members: AccountMember[];
  invites: AccountInvite[];
  /** True when the viewer is an owner; members get a read-only page. */
  isOwner: boolean;
  error?: string;
}

function emailForm(
  action: string,
  email: string,
  label: string,
  danger = false,
): string {
  return `<form method="POST" action="${ACCOUNT_PATH}/${action}" style="display:inline;margin:0">
    <input type="hidden" name="email" value="${escapeHtml(email)}" />
    <button type="submit" class="btn ${danger ? "btn-danger" : "btn-secondary"}" style="font-size:12px;padding:4px 10px">${label}</button>
  </form>`;
}

function renderMemberRow(m: AccountMember, isOwner: boolean): string {
  const actions = isOwner
    ? [
        m.role === "owner"
          ? emailForm("members/demote", m.email, "Demote")
          : emailForm("members/promote", m.email, "Make owner"),
        emailForm("members/remove", m.email, "Remove", true),
      ].join(" ")
    : "";
  return `<tr>
    <td>${escapeHtml(m.email)}</td>
    <td><span class="badge ${m.role === "owner" ? "badge-purple" : "badge-gray"}">${escapeHtml(m.role)}</span></td>
    ${isOwner ? `<td style="text-align:right">${actions}</td>` : ""}
  </tr>`;
}

function renderInviteRow(i: AccountInvite, isOwner: boolean): string {
  return `<tr>
    <td>${escapeHtml(i.email)}</td>
    <td>${escapeHtml(i.invitedBy)}</td>
    ${isOwner ? `<td style="text-align:right">${emailForm("invites/revoke", i.email, "Revoke", true)}</td>` : ""}
  </tr>`;
}

export function renderAccountPage(opts: AccountPageOpts): string {
  const { account, isOwner } = opts;
  const errorHtml = opts.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";
  const actionTh = isOwner ? "<th></th>" : "";

  const memberRows = opts.members
    .map((m) => renderMemberRow(m, isOwner))
    .join("\n");
  const inviteRows =
    opts.invites.length === 0
      ? `<tr><td colspan="${isOwner ? 3 : 2}" class="empty-state">No pending invites.</td></tr>`
      : opts.invites.map((i) => renderInviteRow(i, isOwner)).join("\n");

  const renameForm = isOwner
    ? `<form method="POST" action="${ACCOUNT_PATH}/rename" style="display:flex;gap:8px;margin-top:12px">
        <input name="name" class="form-input" maxlength="100" required value="${escapeHtml(account.name)}" style="max-width:280px" />
        <button type="submit" class="btn btn-secondary">Rename</button>
      </form>`
    : "";
  const inviteForm = isOwner
    ? `<form method="POST" action="${ACCOUNT_PATH}/invite" style="display:flex;gap:8px;margin-top:12px">
        <input name="email" type="email" class="form-input" required placeholder="teammate@example.com" style="max-width:280px" />
        <button type="submit" class="btn btn-primary">Invite</button>
      </form>`
    : "";

  return renderAdminPage({
    title: "Account — Shipwright Admin",
    body: `${renderAdminToolbar(opts.userEmail, ACCOUNT_PATH)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(account.name)}</h1>
    </div>
    ${errorHtml}
    <div class="card">
      <div class="card-title">Account</div>
      <p>Agents: <strong>${opts.agentCount} / ${account.maxAgents}</strong></p>
      ${renameForm}
    </div>
    <div class="card">
      <div class="card-title">Members</div>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead><tr><th>Email</th><th>Role</th>${actionTh}</tr></thead>
          <tbody>${memberRows}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Pending invites</div>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead><tr><th>Email</th><th>Invited by</th>${actionTh}</tr></thead>
          <tbody>${inviteRows}</tbody>
        </table>
      </div>
      ${inviteForm}
    </div>
  </div>`,
  });
}

/** Shown on /admin/agents in place of the create button when maxAgents = 0. */
export function renderZeroQuotaNotice(contactEmail: string): string {
  const email = escapeHtml(contactEmail);
  return `<div class="alert alert-warning" id="zero-quota-notice">Email ${email} to request a trial</div>
    <button type="button" class="btn btn-primary" disabled aria-disabled="true">+ New agent</button>`;
}
