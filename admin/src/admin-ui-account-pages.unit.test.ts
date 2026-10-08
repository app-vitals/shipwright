/**
 * admin/src/admin-ui-account-pages.unit.test.ts
 * Pure render tests for the account page fragments (SSP-3.2).
 */

import { describe, expect, test } from "bun:test";
import {
  renderAccountPage,
  renderZeroQuotaNotice,
} from "./admin-ui-account-pages.ts";
import { renderAdminToolbar } from "./admin-ui-styles.ts";
import { runWithAccountNav } from "./admin-ui-account-nav.ts";

const d = new Date("2026-01-01T00:00:00Z");
const account = {
  id: "a1",
  name: "Acme <Co>",
  status: "active",
  maxAgents: 3,
  plan: null,
  trialExpiresAt: null,
  trialExpiryWarnedAt: null,
  createdAt: d,
  updatedAt: d,
};
const members = [
  { id: "m1", accountId: "a1", email: "o@x.com", role: "owner", createdAt: d },
  { id: "m2", accountId: "a1", email: "m@x.com", role: "member", createdAt: d },
];
const invites = [
  {
    id: "i1",
    accountId: "a1",
    email: "new@x.com",
    invitedBy: "o@x.com",
    acceptedAt: null,
    createdAt: d,
  },
];

function render(isOwner: boolean, error?: string) {
  return renderAccountPage({
    userEmail: isOwner ? "o@x.com" : "m@x.com",
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    account: account as any,
    agentCount: 2,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    members: members as any,
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
    invites: invites as any,
    isOwner,
    error,
  });
}

describe("renderAccountPage", () => {
  test("shows escaped name, quota used/max, members and pending invites", () => {
    const html = render(true);
    expect(html).toContain("Acme &lt;Co&gt;");
    expect(html).not.toContain("Acme <Co>");
    expect(html).toContain("2 / 3");
    expect(html).toContain("o@x.com");
    expect(html).toContain("new@x.com");
  });

  test("owner sees management forms", () => {
    const html = render(true);
    expect(html).toContain('action="/admin/account/invite"');
    expect(html).toContain('action="/admin/account/invites/revoke"');
    expect(html).toContain('action="/admin/account/members/remove"');
    expect(html).toContain('action="/admin/account/members/promote"');
    expect(html).toContain('action="/admin/account/members/demote"');
    expect(html).toContain('action="/admin/account/rename"');
  });

  test("member sees read-only page", () => {
    const html = render(false);
    expect(html).not.toContain('action="/admin/account/');
    expect(html).toContain("m@x.com");
  });

  test("renders an escaped error", () => {
    expect(render(true, "bad <b>")).toContain("bad &lt;b&gt;");
  });
});

describe("renderZeroQuotaNotice", () => {
  test("shows request-a-trial message with escaped contact address", () => {
    const html = renderZeroQuotaNotice("dan@app-vitals.com");
    expect(html).toContain("Email dan@app-vitals.com to request a trial");
  });
});

describe("renderAdminToolbar account nav", () => {
  test("no Account entry outside the account-nav context", () => {
    expect(renderAdminToolbar("u", "/admin/agents")).not.toContain(
      "/admin/account",
    );
  });
  test("Account entry inside the context", () => {
    const html = runWithAccountNav(true, () =>
      renderAdminToolbar("u", "/admin/agents"),
    );
    expect(html).toContain('href="/admin/account"');
  });
  test("no entry when context says false", () => {
    const html = runWithAccountNav(false, () =>
      renderAdminToolbar("u", "/admin/agents"),
    );
    expect(html).not.toContain("/admin/account");
  });
});
