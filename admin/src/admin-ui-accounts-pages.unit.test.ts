/**
 * admin/src/admin-ui-accounts-pages.unit.test.ts
 * Render tests for the admin Accounts pages + agents-list Account column (SSP-5.2).
 */

import { describe, expect, test } from "bun:test";
import {
  renderAccountDetailPage,
  renderAccountsListPage,
} from "./admin-ui-accounts-pages.ts";
import { renderAgentsPage } from "./admin-ui-pages.ts";

const d = new Date("2026-01-01T00:00:00Z");
const account = {
  id: "a1",
  name: "Acme <Co>",
  status: "active",
  maxAgents: 3,
  plan: "pro",
  trialExpiresAt: new Date("2026-03-05T00:00:00Z"),
  trialExpiryWarnedAt: null,
  createdAt: d,
  updatedAt: d,
  agentCount: 2,
  memberCount: 2,
};

describe("renderAccountsListPage", () => {
  test("renders row with owner, counts, status, dates; escapes name", () => {
    const html = renderAccountsListPage({
      userEmail: "a@x.com",
      accounts: [account],
      owners: new Map([["a1", ["o@x.com"]]]),
    });
    expect(html).toContain("Acme &lt;Co&gt;");
    expect(html).not.toContain("Acme <Co>");
    expect(html).toContain("o@x.com");
    expect(html).toContain("2 / 3");
    expect(html).toContain("2026-03-05");
    expect(html).toContain("/admin/accounts/a1");
  });

  test("empty state", () => {
    const html = renderAccountsListPage({
      userEmail: "a@x.com",
      accounts: [],
      owners: new Map(),
    });
    expect(html).toContain("No accounts.");
  });
});

describe("renderAccountDetailPage", () => {
  const base = {
    userEmail: "a@x.com",
    account,
    agents: [{ id: "g1", name: "Bot" }],
    members: [
      {
        id: "m1",
        accountId: "a1",
        email: "o@x.com",
        role: "owner",
        createdAt: d,
      },
      {
        id: "m2",
        accountId: "a1",
        email: "m@x.com",
        role: "member",
        createdAt: d,
      },
    ],
    invites: [
      {
        id: "i1",
        accountId: "a1",
        email: "new@x.com",
        invitedBy: "o@x.com",
        acceptedAt: null,
        createdAt: d,
      },
    ],
  };

  test("edit form, suspend button, agents, members, invites", () => {
    const html = renderAccountDetailPage(base);
    expect(html).toContain('action="/admin/accounts/a1/update"');
    expect(html).toContain('name="maxAgents"');
    expect(html).toContain('value="2026-03-05"');
    expect(html).toContain("/admin/accounts/a1/suspend");
    expect(html).not.toContain("/admin/accounts/a1/reactivate");
    expect(html).toContain("Bot");
    expect(html).toContain("/admin/accounts/a1/members/demote");
    expect(html).toContain("/admin/accounts/a1/members/promote");
    expect(html).toContain("/admin/accounts/a1/members/add");
    expect(html).toContain("new@x.com");
  });

  test("suspended shows reactivate; error is shown", () => {
    const html = renderAccountDetailPage({
      ...base,
      account: { ...account, status: "suspended" },
      error: "Boom <b>",
    });
    expect(html).toContain("/admin/accounts/a1/reactivate");
    expect(html).not.toContain("/admin/accounts/a1/suspend");
    expect(html).toContain("Boom &lt;b&gt;");
  });
});

describe("renderAgentsPage Account column", () => {
  const agents = [
    { id: "g1", name: "Bot", slackId: null, createdAt: d, accountId: "a1" },
  ];
  const accountNames = new Map([["a1", "Acme"]]);

  test("shown for admins when accountNames supplied", () => {
    const html = renderAgentsPage(agents, "a@x.com", true, "UTC", {
      accountNames,
    });
    expect(html).toContain("<th>Account</th>");
    expect(html).toContain("Acme");
  });

  test("never shown for non-admins even if accountNames passed", () => {
    const html = renderAgentsPage(agents, "u@x.com", false, "UTC", {
      accountNames,
    });
    expect(html).not.toContain("<th>Account</th>");
    expect(html).not.toContain("Acme");
  });

  test("absent without accountNames (flag off)", () => {
    const html = renderAgentsPage(agents, "a@x.com", true, "UTC");
    expect(html).not.toContain("<th>Account</th>");
  });
});
