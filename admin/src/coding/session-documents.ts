/**
 * admin/src/coding/session-documents.ts
 * Pure helpers and render fragments for a session's planning documents and
 * owner: the document link, the compact list summary, the Mine/All default,
 * and the detail page's Documents block. Rendering never calls GitHub — links
 * are derived from the document's own fields.
 */

import { escapeHtml } from "@app-vitals/agent-admin/admin-ui-styles";
import type { components } from "./task-store-types.ts";

/** The slice of the task-store PlanDocument this UI reads. */
export type SessionDocument = Pick<
  components["schemas"]["PlanDocument"],
  | "kind"
  | "number"
  | "repo"
  | "path"
  | "owner"
  | "prUrl"
  | "state"
  | "commitSha"
  | "plannedAt"
>;

/** Owner/home repo/documents fields carried by a session from GET /sessions. */
export interface SessionOwnership {
  owner?: string | null;
  homeRepo?: string | null;
  documents?: SessionDocument[];
}

const UNMERGED_STATES = new Set(["draft", "pr_open", "abandoned"]);

/**
 * Where a document can be read: its GitHub file (home repo + path, pinned to
 * commitSha when known) once merged, else its docs PR. Null when there is
 * nothing safe to link to.
 */
export function documentLink(doc: SessionDocument): string | null {
  if (doc.state === "merged") {
    return `https://github.com/${doc.repo}/blob/${doc.commitSha ?? "main"}/${doc.path}`;
  }
  return doc.prUrl && /^https?:\/\//i.test(doc.prUrl) ? doc.prUrl : null;
}

export function documentsSummary(documents: SessionDocument[] | undefined): {
  specCount: number;
  needsAttention: boolean;
} {
  const docs = documents ?? [];
  return {
    specCount: docs.filter((d) => d.kind === "spec").length,
    needsAttention: docs.some((d) => UNMERGED_STATES.has(d.state)),
  };
}

export type OwnerView =
  | { mode: "mine"; owner: string }
  | { mode: "all" }
  | { mode: "owner"; owner: string };

/**
 * Resolves the sessions list's owner view from the `?owner=` param. Absent
 * param: Mine when the signed-in user owns anything, else All. An empty value
 * or `all` is an explicit All; the user's own email is Mine; any other value
 * filters to that owner.
 */
export function resolveOwnerView(
  ownerParam: string | undefined,
  userEmail: string,
  ownsAny: boolean,
): OwnerView {
  const me = userEmail.trim();
  if (ownerParam === undefined) {
    return me && ownsAny ? { mode: "mine", owner: me } : { mode: "all" };
  }
  const owner = ownerParam.trim();
  if (owner === "" || owner.toLowerCase() === "all") return { mode: "all" };
  if (me && owner.toLowerCase() === me.toLowerCase()) {
    return { mode: "mine", owner: me };
  }
  return { mode: "owner", owner };
}

/** The `?owner=` value that reproduces a view (`all` or the owner's email). */
export function ownerViewParam(view: OwnerView): string {
  return view.mode === "all" ? "all" : view.owner;
}

/**
 * The Mine / All switch shared by the sessions and tasks lists. `makeUrl`
 * builds the list URL for a given `?owner=` value; Mine is only offered when
 * the signed-in identity is known.
 */
export function renderOwnerSwitch(
  view: OwnerView,
  userEmail: string,
  makeUrl: (owner: string) => string,
): string {
  const tab = (label: string, active: boolean, href: string) =>
    `<a href="${escapeHtml(href)}" class="btn ${active ? "btn-primary" : "btn-secondary"}" style="font-size:12px"${active ? ' aria-current="true"' : ""}>${label}</a>`;
  const other =
    view.mode === "owner"
      ? `<span class="badge badge-gray">Owner: ${escapeHtml(view.owner)}</span>`
      : "";
  return `<div id="owner-switch" style="display:flex;gap:6px;align-items:center;margin-bottom:16px">
      ${userEmail ? tab("Mine", view.mode === "mine", makeUrl(userEmail)) : ""}
      ${tab("All", view.mode === "all", makeUrl("all"))}
      ${other}
    </div>`;
}

const STATE_BADGE: Record<SessionDocument["state"], string> = {
  draft: "badge-gray",
  pr_open: "badge-blue",
  merged: "badge-green",
  abandoned: "badge-red",
};

const DASH = '<span style="color:var(--vos-text-faint, #9ca3af)">—</span>';

function documentRow(doc: SessionDocument): string {
  const label = `${doc.kind === "plan" ? "Plan" : `Spec ${doc.number}`}`;
  const link = documentLink(doc);
  const linkHtml = link
    ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" style="color:var(--vos-brand, #6366f1);text-decoration:none">${escapeHtml(doc.state === "merged" ? "File" : "PR")}</a>`
    : DASH;
  const planned =
    doc.kind === "spec" ? (doc.plannedAt ? "Planned" : "Not planned") : DASH;
  return `<tr>
      <td>${escapeHtml(doc.kind)}</td>
      <td>${escapeHtml(label)}</td>
      <td style="font-size:12px">${doc.owner ? escapeHtml(doc.owner) : DASH}</td>
      <td><span class="badge ${STATE_BADGE[doc.state] ?? "badge-gray"}">${escapeHtml(doc.state)}</span></td>
      <td style="font-size:12px">${planned}</td>
      <td class="mono" style="font-size:11px">${escapeHtml(doc.path)}</td>
      <td>${linkHtml}</td>
    </tr>`;
}

/** The session detail Documents block; empty string when there are none. */
export function renderDocumentsBlock(
  documents: SessionDocument[] | undefined,
): string {
  if (!documents || documents.length === 0) return "";
  return `<div class="card" id="session-documents" style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;color:var(--vos-text-body, #374151);margin-bottom:12px;text-transform:uppercase;letter-spacing:.05em">Documents</div>
      <div class="data-table-wrapper">
        <table class="data-table">
          <thead>
            <tr><th>Kind</th><th>Document</th><th>Owner</th><th>State</th><th>Planned</th><th>Path</th><th>Link</th></tr>
          </thead>
          <tbody>
            ${documents.map(documentRow).join("\n")}
          </tbody>
        </table>
      </div>
    </div>`;
}

/** Owner and repos line for the session detail header; empty when neither. */
export function renderOwnershipHeader(
  info: SessionOwnership | undefined,
  repos: string[] = [],
): string {
  if (!info) return "";
  const allRepos = [
    ...new Set([...(info.homeRepo ? [info.homeRepo] : []), ...repos]),
  ];
  const parts: string[] = [];
  if (info.owner) {
    parts.push(
      `<span>Owner: <strong>${escapeHtml(info.owner)}</strong></span>`,
    );
  }
  if (allRepos.length > 0) {
    parts.push(
      `<span>Repos: ${allRepos.map((r) => `<span class="badge badge-purple" style="margin-right:4px">${escapeHtml(r)}</span>`).join("")}</span>`,
    );
  }
  if (parts.length === 0) return "";
  return `<div id="session-ownership" style="font-size:13px;color:var(--vos-text-body, #374151);margin-bottom:12px;display:flex;gap:16px;flex-wrap:wrap">${parts.join("")}</div>`;
}
