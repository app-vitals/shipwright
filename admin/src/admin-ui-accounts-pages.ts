/**
 * admin/src/admin-ui-accounts-pages.ts
 * Render functions for the platform-admin Accounts pages (SSP-5.2). Pure
 * string -> string; routes live in admin-ui-accounts.ts.
 */

import type { AccountInvite } from "./account-invites.ts";
import type { AccountMember } from "./account-members.ts";
import type { AccountWithCounts } from "./accounts.ts";
import { renderAdminPage } from "./admin-ui-layout.ts";
import { escapeHtml, renderAdminToolbar } from "./admin-ui-styles.ts";

export const ADMIN_ACCOUNTS_PATH = "/admin/accounts";

export interface AccountAgentRef {
  id: string;
  name: string;
}

function dateOnly(d: Date | null | undefined): string {
  return d ? new Date(d).toISOString().slice(0, 10) : "";
}

function statusBadge(status: string): string {
  const cls =
    status === "active"
      ? "badge-green"
      : status === "suspended"
        ? "badge-red"
        : "badge-gray";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

export interface AccountsListPageOpts {
  userEmail: string;
  accounts: AccountWithCounts[];
  /** accountId -> owner emails. */
  owners: Map<string, string[]>;
}

export function renderAccountsListPage(opts: AccountsListPageOpts): string {
  const rows =
    opts.accounts.length === 0
      ? `<tr><td colspan="8" class="empty-state">No accounts.</td></tr>`
      : opts.accounts
          .map((a) => {
            const owners = opts.owners.get(a.id) ?? [];
            return `<tr>
    <td><a href="${ADMIN_ACCOUNTS_PATH}/${escapeHtml(a.id)}" class="agent-link">${escapeHtml(a.name)}</a></td>
    <td>${owners.length ? owners.map(escapeHtml).join(", ") : "—"}</td>
    <td>${a.memberCount}</td>
    <td>${a.agentCount} / ${a.maxAgents}</td>
    <td>${statusBadge(a.status)}</td>
    <td>${a.trialExpiresAt ? escapeHtml(dateOnly(a.trialExpiresAt)) : "—"}</td>
    <td>${escapeHtml(dateOnly(a.createdAt))}</td>
    <td><a href="${ADMIN_ACCOUNTS_PATH}/${escapeHtml(a.id)}" class="btn btn-secondary" style="font-size:12px;padding:4px 10px">Manage</a></td>
  </tr>`;
          })
          .join("\n");

  return renderAdminPage({
    title: "Accounts — Shipwright Admin",
    body: `${renderAdminToolbar(opts.userEmail, ADMIN_ACCOUNTS_PATH)}
  <div class="vos-page">
    <div class="page-header"><h1 class="page-title">Accounts</h1></div>
    <div class="card">
      <table class="data-table">
        <thead><tr><th>Name</th><th>Owner</th><th>Members</th><th>Agents</th><th>Status</th><th>Trial expires</th><th>Created</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`,
  });
}

export interface AccountDetailPageOpts {
  userEmail: string;
  account: AccountWithCounts;
  agents: AccountAgentRef[];
  members: AccountMember[];
  invites: AccountInvite[];
  error?: string;
}

function postForm(
  accountId: string,
  action: string,
  fields: Record<string, string>,
  label: string,
  danger = false,
): string {
  const hidden = Object.entries(fields)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`,
    )
    .join("");
  return `<form method="POST" action="${ADMIN_ACCOUNTS_PATH}/${escapeHtml(accountId)}/${action}" style="display:inline;margin:0">${hidden}
    <button type="submit" class="btn ${danger ? "btn-danger" : "btn-secondary"}" style="font-size:12px;padding:4px 10px">${label}</button>
  </form>`;
}

export function renderAccountDetailPage(opts: AccountDetailPageOpts): string {
  const { account } = opts;
  const id = account.id;
  const base = `${ADMIN_ACCOUNTS_PATH}/${escapeHtml(id)}`;
  const errorHtml = opts.error
    ? `<div class="alert alert-error">${escapeHtml(opts.error)}</div>`
    : "";

  const statusAction =
    account.status === "active"
      ? postForm(id, "suspend", {}, "Suspend", true)
      : postForm(id, "reactivate", {}, "Reactivate");

  const memberRows = opts.members
    .map(
      (m) => `<tr>
    <td>${escapeHtml(m.email)}</td>
    <td><span class="badge ${m.role === "owner" ? "badge-purple" : "badge-gray"}">${escapeHtml(m.role)}</span></td>
    <td style="text-align:right">${[
      m.role === "owner"
        ? postForm(id, "members/demote", { email: m.email }, "Demote")
        : postForm(id, "members/promote", { email: m.email }, "Make owner"),
      postForm(id, "members/remove", { email: m.email }, "Remove", true),
    ].join(" ")}</td>
  </tr>`,
    )
    .join("\n");

  const agentRows =
    opts.agents.length === 0
      ? `<tr><td class="empty-state">No agents.</td></tr>`
      : opts.agents
          .map(
            (a) =>
              `<tr><td><a href="/admin/agents/${escapeHtml(a.id)}" class="agent-link">${escapeHtml(a.name)}</a></td></tr>`,
          )
          .join("\n");

  const inviteRows =
    opts.invites.length === 0
      ? `<tr><td colspan="2" class="empty-state">No pending invites.</td></tr>`
      : opts.invites
          .map(
            (i) =>
              `<tr><td>${escapeHtml(i.email)}</td><td>${escapeHtml(i.invitedBy)}</td></tr>`,
          )
          .join("\n");

  return renderAdminPage({
    title: `${account.name} — Accounts — Shipwright Admin`,
    body: `${renderAdminToolbar(opts.userEmail, ADMIN_ACCOUNTS_PATH)}
  <div class="vos-page">
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(account.name)} ${statusBadge(account.status)}</h1>
      ${statusAction}
    </div>
    <p><a href="${ADMIN_ACCOUNTS_PATH}">&larr; All accounts</a></p>
    ${errorHtml}
    <div class="card">
      <div class="card-title">Settings</div>
      <p>Agents: <strong>${account.agentCount} / ${account.maxAgents}</strong></p>
      <form method="POST" action="${base}/update" style="display:grid;gap:8px;max-width:360px;margin-top:12px">
        <label>Name <input name="name" class="form-input" maxlength="100" required value="${escapeHtml(account.name)}" /></label>
        <label>Max agents <input name="maxAgents" type="number" min="0" step="1" class="form-input" required value="${account.maxAgents}" /></label>
        <label>Plan <input name="plan" class="form-input" value="${escapeHtml(account.plan ?? "")}" /></label>
        <label>Trial expires <input name="trialExpiresAt" type="date" class="form-input" value="${escapeHtml(dateOnly(account.trialExpiresAt))}" /></label>
        <div><button type="submit" class="btn btn-primary">Save</button></div>
      </form>
    </div>
    <div class="card">
      <div class="card-title">Agents</div>
      <table class="data-table"><tbody>${agentRows}</tbody></table>
    </div>
    <div class="card">
      <div class="card-title">Members</div>
      <table class="data-table">
        <thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
        <tbody>${memberRows}</tbody>
      </table>
      <form method="POST" action="${base}/members/add" style="display:flex;gap:8px;margin-top:12px">
        <input name="email" type="email" class="form-input" required placeholder="user@example.com" style="max-width:280px" />
        <select name="role" class="form-input" style="max-width:120px"><option value="member">member</option><option value="owner">owner</option></select>
        <button type="submit" class="btn btn-primary">Add</button>
      </form>
    </div>
    <div class="card">
      <div class="card-title">Pending invites</div>
      <table class="data-table">
        <thead><tr><th>Email</th><th>Invited by</th></tr></thead>
        <tbody>${inviteRows}</tbody>
      </table>
    </div>
  </div>`,
  });
}
