/**
 * agent/src/admin-ui-pages.unit.test.ts
 * Pure unit tests for all render functions in admin-ui-pages.ts.
 *
 * Strategy: call render functions directly, assert on returned HTML strings.
 * No I/O, no Hono, no HTTP — pure string → string.
 */

import { describe, expect, test } from "bun:test";
import { renderZeroQuotaNotice } from "./admin-ui-account-pages.ts";
import {
  type AgentDetail,
  type AgentListItem,
  type CronJobItem,
  ERROR_KIND_LABELS,
  type MemberItem,
  type PluginItem,
  renderAddAnotherOrgAction,
  renderAgentDetailPage,
  renderAgentsPage,
  renderChatMessageBubble,
  renderChatPage,
  renderChatThreadPage,
  renderGithubAppInstalledPage,
  renderGithubAppInstallPage,
  renderGithubAppManifestRedirectPage,
  renderLoginPage,
  renderNewLocalAgentPage,
  renderProvisionCompletePage,
  renderProvisionXappTokenPage,
  type TokenItem,
  type ToolItem,
} from "./admin-ui-pages.ts";
import type { VerificationActivitySummary } from "./coding/admin-ui-verification-cards.ts";
import { baseStyles, renderAdminToolbar } from "./admin-ui-styles.ts";
import type { ChatMessage, ChatThread } from "./http-chat-client.ts";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const AGENT: AgentDetail = {
  id: "agent-123",
  name: "Test Agent",
  slackId: "U12345",
  selfHosted: false,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-02T00:00:00Z"),
  repos: [],
  authorAllowlist: [],
  patchAuthorAllowlist: [],
  restrictSlackToMembers: false,
  typeName: "coding",
  missingRequiredEnv: [],
  autoPostReviews: true,
  allowSelfReview: false,
  minConfidence: 75,
  maxFindings: 5,
  cleanupMergedWorktrees: true,
  cleanupAfterDays: 14,
};

const AGENT_LIST_ITEM: AgentListItem = {
  id: "agent-123",
  name: "Test Agent",
  slackId: "U12345",
  createdAt: new Date("2024-01-01T00:00:00Z"),
};

const ENV_VARS: Record<string, string> = {
  API_KEY: "secret-value",
  DB_HOST: "localhost",
};

const SYSTEM_CRON: CronJobItem = {
  id: "cron-sys-1",
  schedule: "0 * * * *",
  prompt: "System health check",
  channel: "C123",
  user: null,
  enabled: true,
  name: "health-check",
  system: true,
  parentCronId: null,
  preCheck: "shipwright:check-dev-task.ts",
  createdAt: new Date("2024-02-01T00:00:00Z"),
};

const CUSTOM_CRON: CronJobItem = {
  id: "cron-custom-1",
  schedule: "30 8 * * *",
  prompt: "Daily standup prompt",
  channel: null,
  user: "U99",
  enabled: false,
  name: null,
  system: false,
  parentCronId: null,
  createdAt: new Date("2024-02-15T00:00:00Z"),
};

const TOOL_ENABLED: ToolItem = {
  id: "tool-1",
  pattern: "Bash(git:*)",
  enabled: true,
  createdAt: new Date("2024-03-05T00:00:00Z"),
};

const TOOL_DISABLED: ToolItem = {
  id: "tool-2",
  pattern: "Read(**)",
  enabled: false,
  createdAt: new Date("2024-03-06T00:00:00Z"),
};

const TOKEN_ACTIVE: TokenItem = {
  id: "tok-1",
  label: "CI token",
  createdAt: new Date("2024-03-01T00:00:00Z"),
  revokedAt: null,
};

const TOKEN_REVOKED: TokenItem = {
  id: "tok-2",
  label: "old token",
  createdAt: new Date("2024-01-15T00:00:00Z"),
  revokedAt: new Date("2024-02-01T00:00:00Z"),
};

const PLUGIN_ENABLED: PluginItem = {
  id: "plug-1",
  name: "shipwright",
  version: "1.2.3",
  enabled: true,
  createdAt: new Date("2024-04-01T00:00:00Z"),
};

const PLUGIN_DISABLED: PluginItem = {
  id: "plug-2",
  name: "entropy-patrol",
  version: null,
  enabled: false,
  createdAt: new Date("2024-04-02T00:00:00Z"),
};

const USER_NAME = "alice";

// ─── renderLoginPage ──────────────────────────────────────────────────────────

describe("renderLoginPage", () => {
  test("returns a valid HTML document", () => {
    const html = renderLoginPage();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("includes the page title", () => {
    const html = renderLoginPage();
    expect(html).toContain("Admin Login");
  });

  test("includes Sign in with Google link pointing at /admin/auth/google", () => {
    const html = renderLoginPage();
    expect(html).toContain("Sign in with Google");
    expect(html).toContain('href="/admin/auth/google"');
  });

  test("no error div when no error provided", () => {
    const html = renderLoginPage();
    expect(html).not.toContain('class="alert alert-error"');
  });

  test("no error div when called with empty opts", () => {
    const html = renderLoginPage({});
    expect(html).not.toContain('class="alert alert-error"');
  });

  test("renders error div when error string provided", () => {
    const html = renderLoginPage({ error: "Invalid password" });
    expect(html).toContain('class="alert alert-error"');
    expect(html).toContain("Invalid password");
  });

  test("XSS: error string is escaped", () => {
    const html = renderLoginPage({ error: '<script>alert("xss")</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("does not show Sign in with Okta when oktaEnabled is not provided", () => {
    const html = renderLoginPage();
    expect(html).not.toContain("Sign in with Okta");
    expect(html).not.toContain('href="/admin/auth/okta"');
  });

  test("does not show Sign in with Okta when oktaEnabled is false", () => {
    const html = renderLoginPage({ oktaEnabled: false });
    expect(html).not.toContain("Sign in with Okta");
    expect(html).not.toContain('href="/admin/auth/okta"');
  });

  test("shows Sign in with Okta when oktaEnabled is true", () => {
    const html = renderLoginPage({ oktaEnabled: true });
    expect(html).toContain("Sign in with Okta");
    expect(html).toContain('href="/admin/auth/okta"');
  });

  test("includes returnTo query param in Okta href when provided", () => {
    const html = renderLoginPage({
      oktaEnabled: true,
      returnTo: "/admin/agents",
    });
    expect(html).toContain(
      'href="/admin/auth/okta?returnTo=%2Fadmin%2Fagents"',
    );
  });

  test("google off + okta on shows only the Okta button", () => {
    const html = renderLoginPage({ googleEnabled: false, oktaEnabled: true });
    expect(html).toContain("Sign in with Okta");
    expect(html).not.toContain("Sign in with Google");
    expect(html).not.toContain("No sign-in provider is configured");
  });

  test("both providers on shows both buttons", () => {
    const html = renderLoginPage({ googleEnabled: true, oktaEnabled: true });
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("Sign in with Okta");
    expect(html).not.toContain("No sign-in provider is configured");
  });

  test("neither provider on shows the misconfiguration notice and no buttons", () => {
    const html = renderLoginPage({ googleEnabled: false, oktaEnabled: false });
    expect(html).toContain("No sign-in provider is configured");
    expect(html).toContain("alert-error");
    expect(html).not.toContain("Sign in with Google");
    expect(html).not.toContain("Sign in with Okta");
  });

  test("returnTo is preserved on each rendered button", () => {
    const returnTo = "/admin/agents";
    const both = renderLoginPage({
      googleEnabled: true,
      oktaEnabled: true,
      returnTo,
    });
    expect(both).toContain(
      'href="/admin/auth/google?returnTo=%2Fadmin%2Fagents"',
    );
    expect(both).toContain(
      'href="/admin/auth/okta?returnTo=%2Fadmin%2Fagents"',
    );
    const googleOnly = renderLoginPage({ googleEnabled: true, returnTo });
    expect(googleOnly).toContain(
      'href="/admin/auth/google?returnTo=%2Fadmin%2Fagents"',
    );
    const oktaOnly = renderLoginPage({
      googleEnabled: false,
      oktaEnabled: true,
      returnTo,
    });
    expect(oktaOnly).toContain(
      'href="/admin/auth/okta?returnTo=%2Fadmin%2Fagents"',
    );
  });
});

// ─── renderAgentsPage ─────────────────────────────────────────────────────────

describe("renderAgentsPage", () => {
  test("returns a valid HTML document", () => {
    const html = renderAgentsPage([], USER_NAME, true, "UTC");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("empty agents array shows 'No agents yet' empty state", () => {
    const html = renderAgentsPage([], USER_NAME, true, "UTC");
    expect(html).toContain("No agents yet");
  });

  test("empty state links to /admin/agents/new (not the Slack wizard)", () => {
    const html = renderAgentsPage([], USER_NAME, true, "UTC");
    expect(html).toContain('href="/admin/agents/new"');
    expect(html).toContain("Create one");
  });

  test("admin: primary CTA is '+ New agent' → /admin/agents/new", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME, true, "UTC");
    expect(html).toContain("+ New agent");
    expect(html).toContain('href="/admin/agents/new"');
  });

  test("admin: only one CTA (no secondary Slack button)", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME, true, "UTC");
    // Should NOT have the secondary Slack app button in the page header
    expect(html).not.toContain("Connect Slack app");
    // Should have exactly one btn-primary (the + New agent button)
    const btnMatches = html.match(/class="btn btn-primary"/g);
    expect(btnMatches).toHaveLength(1);
  });

  test("agent name appears as a link", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME, true, "UTC");
    expect(html).toContain("Test Agent");
    expect(html).toContain('href="/admin/agents/agent-123"');
  });

  test("Manage button links to agent detail page", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME, true, "UTC");
    expect(html).toContain("Manage");
    expect(html).toContain(`/admin/agents/${AGENT_LIST_ITEM.id}`);
  });

  test("XSS: agent name is escaped", () => {
    const xssAgent: AgentListItem = {
      ...AGENT_LIST_ITEM,
      name: '<script>alert("xss")</script>',
    };
    const html = renderAgentsPage([xssAgent], USER_NAME, true, "UTC");
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: agent id used in href is escaped", () => {
    const xssAgent: AgentListItem = {
      ...AGENT_LIST_ITEM,
      id: 'agent-"><script>',
    };
    const html = renderAgentsPage([xssAgent], USER_NAME, true, "UTC");
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("multiple agents are all rendered", () => {
    const second: AgentListItem = {
      ...AGENT_LIST_ITEM,
      id: "agent-456",
      name: "Second Agent",
    };
    const html = renderAgentsPage(
      [AGENT_LIST_ITEM, second],
      USER_NAME,
      true,
      "UTC",
    );
    expect(html).toContain("Test Agent");
    expect(html).toContain("Second Agent");
  });

  test("no empty-state message when agents present", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME, true, "UTC");
    expect(html).not.toContain("No agents yet");
  });

  test("non-admin: create buttons are hidden", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME, false, "UTC");
    expect(html).not.toContain("+ New agent");
    expect(html).not.toContain("Connect Slack app");
  });

  test("non-admin: empty state shows 'No agents.' without a create link", () => {
    const html = renderAgentsPage([], USER_NAME, false, "UTC");
    expect(html).toContain("No agents.");
    expect(html).not.toContain("Create one");
  });

  test("createdAt date uses the provided timezone", () => {
    // 2025-01-15T20:00:00Z = Jan 15 in UTC but also Jan 15 in America/Los_Angeles (UTC-8)
    // However this specific UTC time is 12:00 PM Pacific — still Jan 15 in both.
    // Use a time that's Jan 15 in UTC but Jan 14 in Pacific: e.g. 2025-01-15T05:00:00Z = Jan 14 in Pacific (UTC-8)
    const agent: AgentListItem = {
      ...AGENT_LIST_ITEM,
      createdAt: new Date("2025-01-15T05:00:00Z"), // Jan 14 Pacific, Jan 15 UTC
    };
    const htmlUTC = renderAgentsPage([agent], USER_NAME, true, "UTC");
    const htmlPacific = renderAgentsPage(
      [agent],
      USER_NAME,
      true,
      "America/Los_Angeles",
    );
    // In UTC: 1/15/2025; in Pacific (UTC-8): 1/14/2025
    expect(htmlUTC).toContain("1/15/2025");
    expect(htmlPacific).toContain("1/14/2025");
  });
});

// ─── renderAgentDetailPage — members section ─────────────────────────────────

describe("renderAgentDetailPage — members section", () => {
  const MEMBER: MemberItem = {
    id: "m1",
    email: "member@example.com",
    createdAt: new Date("2025-01-15T00:00:00Z"),
  };

  test("admin sees the Members section", () => {
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    expect(html).toContain("Members");
  });

  test("non-admin does not see the Members section", () => {
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      false,
      { timezone: "UTC" },
    );
    expect(html).not.toContain("Members");
  });

  test("member email appears in the members table", () => {
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [MEMBER],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    expect(html).toContain("member@example.com");
  });

  test("member added date appears in the members table", () => {
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [MEMBER],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    // With timezone-aware formatting (UTC), 2025-01-15T00:00:00Z renders as 1/15/2025
    expect(html).toContain("1/15/2025");
  });

  test("member remove button posts to the delete route with memberId", () => {
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [MEMBER],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    expect(html).toContain(`/admin/agents/${AGENT.id}/members/delete`);
    expect(html).toContain('name="memberId"');
    expect(html).toContain(`value="${MEMBER.id}"`);
  });

  test("empty members list shows 'No members yet'", () => {
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    expect(html).toContain("No members yet");
  });

  test("Members table is wrapped in .data-table-wrapper", () => {
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [MEMBER],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    expect(html).toMatch(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>Email<\/th>/,
    );
  });

  test("XSS: member email is escaped", () => {
    const xssMember: MemberItem = {
      id: "m-xss",
      email: '<script>alert("xss")</script>',
      createdAt: new Date("2025-01-01"),
    };
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [xssMember],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    // The raw XSS payload must not appear unescaped in the output
    expect(html).not.toContain('alert("xss")');
    // The email content must be HTML-escaped
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderAgentDetailPage — overview ────────────────────────────────────────

describe("renderAgentDetailPage — overview", () => {
  function render(opts?: Parameters<typeof renderAgentDetailPage>[9]): string {
    return renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC", ...opts },
    );
  }

  test("returns a valid HTML document", () => {
    const html = render();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("page title includes agent name", () => {
    const html = render();
    expect(html).toContain("Test Agent");
  });

  test("XSS: agent name in title is escaped", () => {
    const xssAgent: AgentDetail = {
      ...AGENT,
      name: '<script>alert("xss")</script>',
    };
    const html = renderAgentDetailPage(
      xssAgent,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    // The raw XSS payload must not appear unescaped in the output
    expect(html).not.toContain('alert("xss")');
    // The agent name must be HTML-escaped wherever it appears
    expect(html).toContain("&lt;script&gt;");
  });

  test("no error alert when no error", () => {
    const html = render();
    expect(html).not.toContain('class="alert alert-error"');
  });

  test("error alert shown when opts.error set", () => {
    const html = render({ error: "Something went wrong" });
    expect(html).toContain('class="alert alert-error"');
    expect(html).toContain("Something went wrong");
  });

  test("XSS: error message is escaped", () => {
    const html = render({ error: "<script>bad()</script>" });
    // The opening script tag must not appear unescaped (would allow execution)
    expect(html).not.toContain("<script>bad()");
    expect(html).toContain("&lt;script&gt;");
  });

  test("no new-token alert when newToken not set", () => {
    const html = render();
    expect(html).not.toContain("Token created.");
  });

  test("new token alert shown when opts.newToken set", () => {
    const html = render({ newToken: "test-token-value" });
    expect(html).toContain("Token created.");
    expect(html).toContain("test-token-value");
  });

  test("XSS: new token value is escaped", () => {
    const html = render({ newToken: '<script>alert("xss")</script>' });
    // The raw XSS payload must not appear unescaped in the output
    expect(html).not.toContain('alert("xss")');
    expect(html).toContain("&lt;script&gt;");
  });

  test("back link to /admin/agents present", () => {
    const html = render();
    expect(html).toContain('href="/admin/agents"');
  });

  test("agent type name is displayed", () => {
    const html = render();
    expect(html).toContain("coding");
  });

  test("XSS: agent type name is escaped", () => {
    const xssAgent: AgentDetail = {
      ...AGENT,
      typeName: '<script>alert("xss")</script>',
    };
    const html = renderAgentDetailPage(
      xssAgent,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    expect(html).not.toContain('alert("xss")');
    expect(html).toContain("&lt;script&gt;");
  });

  test("danger zone: delete form uses data-agent-name attribute (XSS-safe)", () => {
    const xssAgent: AgentDetail = {
      ...AGENT,
      name: "O'Brien",
    };
    const html = renderAgentDetailPage(
      xssAgent,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    // Agent name stored as a data attribute; single quotes are encoded as &#39; for defense-in-depth
    expect(html).toContain('data-agent-name="O&#39;Brien"');
    // No inline onsubmit with unescaped single quotes
    expect(html).not.toContain("onsubmit");
  });

  test("danger zone: delete form absent for non-admins", () => {
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      false,
      { timezone: "UTC" },
    );
    expect(html).not.toContain("Danger Zone");
    expect(html).not.toContain("delete-agent-form");
  });

  test("renders a restrictSlackToMembers checkbox, unchecked when false", () => {
    const html = render();
    expect(html).toMatch(
      /<input[^>]*name="restrictSlackToMembers"[^>]*type="checkbox"[^>]*>/,
    );
    // AGENT fixture has restrictSlackToMembers: false — the input must not carry "checked"
    const match = html.match(/<input[^>]*name="restrictSlackToMembers"[^>]*>/);
    expect(match?.[0]).not.toContain("checked");
  });

  test("renders the restrictSlackToMembers checkbox checked when the agent has it enabled", () => {
    const restrictedAgent: AgentDetail = {
      ...AGENT,
      restrictSlackToMembers: true,
    };
    const html = renderAgentDetailPage(
      restrictedAgent,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    const match = html.match(/<input[^>]*name="restrictSlackToMembers"[^>]*>/);
    expect(match?.[0]).toContain("checked");
  });

  test("renders a warning banner when opts.warning is set", () => {
    const html = render({ warning: "this agent has no members" });
    expect(html).toContain('class="alert alert-warning"');
    expect(html).toContain("this agent has no members");
  });

  test("renders no warning banner when opts.warning is absent", () => {
    const html = render();
    expect(html).not.toContain("this agent has no members");
  });
});

describe("renderAgentDetailPage — Recent Verification Activity rollup", () => {
  function render(verificationActivity?: VerificationActivitySummary): string {
    return renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC", verificationActivity },
    );
  }

  test("no rollup card when verificationActivity is absent", () => {
    const html = render(undefined);
    expect(html).not.toContain("Recent Verification Activity");
  });

  test("renders rollup card with heading when verificationActivity is present", () => {
    const html = render({
      totalChecks: 12,
      itemCount: 3,
      counts: { ran_passed: 9, ran_failed: 2, skipped: 1 },
    });
    expect(html).toContain("Recent Verification Activity");
  });

  test("renders counts by status", () => {
    const html = render({
      totalChecks: 12,
      itemCount: 3,
      counts: { ran_passed: 9, ran_failed: 2, skipped: 1 },
    });
    expect(html).toContain("9");
    expect(html).toContain("passed");
    expect(html).toContain("2");
    expect(html).toContain("failed");
    expect(html).toContain("1");
    expect(html).toContain("skipped");
  });

  test("renders empty-state message when totalChecks is 0", () => {
    const html = render({ totalChecks: 0, itemCount: 0, counts: {} });
    expect(html).toContain("Recent Verification Activity");
    expect(html).toContain("No recent verification checks recorded");
  });

  test("renders per-checkName rows with their own status badges", () => {
    const html = render({
      totalChecks: 12,
      itemCount: 3,
      counts: { ran_passed: 9, ran_failed: 2, skipped: 1 },
      byCheckName: {
        unit: { ran_passed: 9 },
        lint: { ran_passed: 2, ran_failed: 1 },
      },
    });
    // Check-name labels present.
    expect(html).toContain("unit");
    expect(html).toContain("lint");
    // The "passed" label appears once for the aggregate line, once for the
    // "unit" row, and once for the "lint" row (3 total); "failed" appears
    // once for the aggregate line and once for the "lint" row (2 total).
    expect(html.split("passed").length - 1).toBe(3);
    expect(html.split("failed").length - 1).toBe(2);
  });

  test("renders per-repo status breakdown when byRepo spans multiple repos", () => {
    const html = render({
      totalChecks: 6,
      itemCount: 2,
      counts: { ran_passed: 4, skipped: 2 },
      byRepo: {
        "acme/widgets": { ran_passed: 3, skipped: 1 },
        "acme/gadgets": { ran_passed: 1, skipped: 1 },
      },
    });
    expect(html).toContain("acme/widgets");
    expect(html).toContain("acme/gadgets");
  });

  test("omits per-repo breakdown when byRepo spans only one repo", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
      byRepo: { "acme/widgets": { ran_passed: 4 } },
    });
    expect(html).not.toContain("acme/widgets");
  });

  test("omits per-repo breakdown when byRepo is absent", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
    });
    // No repo breakdown section should render at all without exploding.
    expect(html).toContain("Recent Verification Activity");
  });

  test("renders Environmental issues section with human-readable reasonCategory labels", () => {
    const html = render({
      totalChecks: 5,
      itemCount: 2,
      counts: { skipped: 3, timed_out: 2 },
      environmentalByRepo: {
        "acme/widgets": { missing_tool: 2, missing_secret: 1 },
        "acme/gadgets": { check_timeout: 2 },
      },
    });
    expect(html).toContain("Environmental issues");
    expect(html).toContain("missing tool");
    expect(html).toContain("missing secret");
    expect(html).toContain("check timed out");
    expect(html).not.toContain("No environmental issues in recent runs");
  });

  test("renders an explicit all-clear message when environmentalByRepo is empty", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
      environmentalByRepo: {},
    });
    expect(html).toContain("Environmental issues");
    expect(html).toContain("No environmental issues in recent runs");
  });

  test("renders an explicit all-clear message when environmentalByRepo entries are all-zero", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
      environmentalByRepo: { "acme/widgets": { missing_tool: 0 } },
    });
    expect(html).toContain("No environmental issues in recent runs");
  });

  test("renders an explicit all-clear message when environmentalByRepo is absent", () => {
    const html = render({
      totalChecks: 4,
      itemCount: 1,
      counts: { ran_passed: 4 },
    });
    expect(html).toContain("No environmental issues in recent runs");
  });
});

// ─── renderNewLocalAgentPage ──────────────────────────────────────────────────

describe("renderNewLocalAgentPage", () => {
  const CODING_TYPE = { name: "coding", displayName: "Coding Agent" };

  test("returns a valid HTML document", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("renders a required select[name=type]", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(
      /<select[^>]*name="type"[^>]*required[^>]*>|<select[^>]*required[^>]*name="type"[^>]*>/,
    );
  });

  test("renders exactly one option per registry type, value=name label=displayName", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toContain('<option value="coding">Coding Agent</option>');
    const optionMatches = html.match(/<option /g) ?? [];
    expect(optionMatches).toHaveLength(1);
  });

  test("renders multiple options when the registry has multiple types", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [
      CODING_TYPE,
      { name: "research", displayName: "Research Agent" },
    ]);
    expect(html).toContain('<option value="coding">Coding Agent</option>');
    expect(html).toContain('<option value="research">Research Agent</option>');
  });

  test("XSS: type name/displayName are escaped", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [
      { name: "coding", displayName: '<script>alert("xss")</script>' },
    ]);
    expect(html).not.toContain('alert("xss")');
    expect(html).toContain("&lt;script&gt;");
  });

  test("no error alert when no error", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).not.toContain('class="alert alert-error"');
  });

  test("error alert shown when error is passed", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      error: "Something went wrong",
    });
    expect(html).toContain('class="alert alert-error"');
    expect(html).toContain("Something went wrong");
  });

  test("renders an authorAllowlist textarea", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(/<textarea[^>]*name="authorAllowlist"[^>]*>/);
  });

  test("author allowlist label reads 'Author allowlist (review)'", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toContain(
      '<label class="form-label" for="authorAllowlist">Author allowlist (review) (optional, one GitHub login per line)</label>',
    );
  });

  test("renders a patchAuthorAllowlist textarea", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(/<textarea[^>]*name="patchAuthorAllowlist"[^>]*>/);
  });

  test("patch author allowlist label reads 'Patch author allowlist'", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toContain(
      '<label class="form-label" for="patchAuthorAllowlist">Patch author allowlist (optional, one GitHub login per line)</label>',
    );
  });

  test("renders a restrictSlackToMembers checkbox", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(
      /<input[^>]*name="restrictSlackToMembers"[^>]*type="checkbox"[^>]*>/,
    );
  });

  test("renders both runtime radios", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      canProvision: true,
    });
    expect(html).toMatch(
      /<input[^>]*name="runtime"[^>]*value="in-cluster"[^>]*>/,
    );
    expect(html).toMatch(
      /<input[^>]*name="runtime"[^>]*value="self-hosted"[^>]*>/,
    );
  });

  test("canProvision: true preselects in-cluster and leaves it enabled", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      canProvision: true,
    });
    const inCluster = html.match(
      /<input[^>]*value="in-cluster"[^>]*\/>/,
    )?.[0] as string;
    expect(inCluster).toContain("checked");
    expect(inCluster).not.toContain("disabled");
    const selfHosted = html.match(
      /<input[^>]*value="self-hosted"[^>]*\/>/,
    )?.[0] as string;
    expect(selfHosted).not.toContain("checked");
  });

  test("canProvision: false disables in-cluster, preselects self-hosted, and explains why", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      canProvision: false,
    });
    const inCluster = html.match(
      /<input[^>]*value="in-cluster"[^>]*\/>/,
    )?.[0] as string;
    expect(inCluster).toContain("disabled");
    expect(inCluster).not.toContain("checked");
    const selfHosted = html.match(
      /<input[^>]*value="self-hosted"[^>]*\/>/,
    )?.[0] as string;
    expect(selfHosted).toContain("checked");
    expect(html).toContain("SHIPWRIGHT_K8S_PROVISIONING");
  });

  test("omitted canProvision defaults to unavailable", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    const inCluster = html.match(
      /<input[^>]*value="in-cluster"[^>]*\/>/,
    )?.[0] as string;
    expect(inCluster).toContain("disabled");
  });

  test("renders an optional CLAUDE_CODE_OAUTH_TOKEN input", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(
      /<input[^>]*name="claudeCodeOauthToken"[^>]*type="password"[^>]*>/,
    );
    expect(html).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("points at the chat UI for agent conversation", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      canProvision: true,
    });
    expect(html).toContain("/admin/chat");
  });

  test("renders an optional ANTHROPIC_API_KEY input alongside the Claude token, matching the wizard's field", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(
      /<input[^>]*name="anthropicApiKey"[^>]*type="password"[^>]*>/,
    );
    expect(html).toContain('placeholder="sk-ant-..."');
  });

  test("renders a Connect Slack checkbox", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(
      /<input[^>]*name="connectSlack"[^>]*type="checkbox"[^>]*>/,
    );
  });

  test("renders an xoxpToken field inside a slack-fields block hidden by default", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(/<input[^>]*name="xoxpToken"[^>]*>/);
    // The xoxpToken field lives inside a container hidden until the
    // connectSlack checkbox is toggled on (progressive disclosure).
    const slackBlock = html.match(
      /<div id="slack-fields"[^>]*style="display:none[^>]*>[\s\S]*?xoxpToken/,
    );
    expect(slackBlock).not.toBeNull();
  });

  test("connectSlack checkbox onchange toggles the slack-fields block's display", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    const checkbox = html.match(
      /<input[^>]*name="connectSlack"[^>]*>/,
    )?.[0] as string;
    expect(checkbox).toContain("onchange");
    expect(checkbox).toContain("slack-fields");
  });

  test("renders a GitHub auth radio group with skip/pat/app options", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(/<input[^>]*name="ghAuthMode"[^>]*value="skip"[^>]*>/);
    expect(html).toMatch(/<input[^>]*name="ghAuthMode"[^>]*value="pat"[^>]*>/);
    expect(html).toMatch(/<input[^>]*name="ghAuthMode"[^>]*value="app"[^>]*>/);
    // UAP-5.3: two ghAuthMode="app" radios now exist (Create GitHub App /
    // Use existing GitHub App), disambiguated by a shared hidden ghAppMode
    // field the radios' onchange handlers set to "auto"/"manual".
    expect(html).toMatch(/id="ghAppMode"/);
    const appRadios = html.match(
      /<input[^>]*name="ghAuthMode"[^>]*value="app"[^>]*>/g,
    );
    expect(appRadios?.length).toBe(2);
  });

  // ── UAP-5.3: "Use existing GitHub App" as a 4th ghAuthMode option ─────────

  test("renders a 4th 'Use existing GitHub App' radio revealing App ID, Installation ID, and a PEM file upload", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toContain("Use existing GitHub App");
    const manualBlock = html.match(
      /<div id="gh-app-manual-fields"[^>]*style="display:none"[\s\S]*?<\/div>\s*<\/div>/,
    )?.[0] as string;
    expect(manualBlock).toBeDefined();
    expect(manualBlock).toMatch(/<input[^>]*name="ghAppId"[^>]*>/);
    expect(manualBlock).toMatch(/<input[^>]*name="ghAppInstallationId"[^>]*>/);
    expect(manualBlock).toMatch(
      /<input[^>]*name="ghAppPrivateKeyFile"[^>]*type="file"[^>]*accept="\.pem"[^>]*>/,
    );
  });

  test("the 'Use existing GitHub App' radio's onchange sets the hidden ghAppMode input to 'manual' and shows the manual fields block; 'Create GitHub App' sets it to 'auto'", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    const appRadios = html.match(
      /<input[^>]*name="ghAuthMode"[^>]*value="app"[^>]*\/>/g,
    ) as string[];
    expect(appRadios).toHaveLength(2);
    const [autoRadio, manualRadio] = appRadios;
    expect(autoRadio).toContain("ghAppMode').value='auto'");
    expect(manualRadio).toContain("ghAppMode').value='manual'");
    expect(manualRadio).toContain("gh-app-manual-fields");
  });

  test("the hidden ghAppMode input defaults to 'auto'", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    const hidden = html.match(
      /<input[^>]*type="hidden"[^>]*id="ghAppMode"[^>]*>/,
    )?.[0] as string;
    expect(hidden).toBeDefined();
    expect(hidden).toContain('name="ghAppMode"');
    expect(hidden).toContain('value="auto"');
  });

  test("the New Agent form gains enctype=multipart/form-data now that it contains a file input", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    const formTag = html.match(
      /<form method="POST" action="\/admin\/agents"[^>]*>/,
    )?.[0] as string;
    expect(formTag).toBeDefined();
    expect(formTag).toContain('enctype="multipart/form-data"');
  });

  test("skip is the default checked GitHub auth mode", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    const skipRadio = html.match(
      /<input[^>]*name="ghAuthMode"[^>]*value="skip"[^>]*\/>/,
    )?.[0] as string;
    expect(skipRadio).toContain("checked");
  });

  test("renders a ghPat field inside a gh-pat-fields block hidden by default", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(/<input[^>]*name="ghPat"[^>]*type="password"[^>]*>/);
    const patBlock = html.match(
      /<div id="gh-pat-fields"[^>]*style="display:none"[\s\S]*?ghPat/,
    );
    expect(patBlock).not.toBeNull();
  });

  test("renders a githubOrg field inside a gh-app-fields block hidden by default", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(/<input[^>]*name="githubOrg"[^>]*>/);
    const appBlock = html.match(
      /<div id="gh-app-fields"[^>]*style="display:none"[\s\S]*?githubOrg/,
    );
    expect(appBlock).not.toBeNull();
  });

  test("ghAuthMode radios toggle the pat/app field blocks via onchange", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    const patRadio = html.match(
      /<input[^>]*name="ghAuthMode"[^>]*value="pat"[^>]*>/,
    )?.[0] as string;
    expect(patRadio).toContain("onchange");
    expect(patRadio).toContain("gh-pat-fields");
    const appRadio = html.match(
      /<input[^>]*name="ghAuthMode"[^>]*value="app"[^>]*>/,
    )?.[0] as string;
    expect(appRadio).toContain("onchange");
    expect(appRadio).toContain("gh-app-fields");
  });

  // ── UAP-5.1: gate Slack/GitHub sections behind runtime=in-cluster ─────────

  test("canProvision: false (self-hosted preselected) hides the restrictSlackToMembers group, Slack fieldset, and GitHub Authentication fieldset", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      canProvision: false,
    });
    const restrictGroup = html.match(
      /<div id="restrict-slack-group"[^>]*>/,
    )?.[0] as string;
    expect(restrictGroup).toContain("display:none");
    const slackSection = html.match(
      /<fieldset id="slack-section"[^>]*>/,
    )?.[0] as string;
    expect(slackSection).toContain("display:none");
    const githubSection = html.match(
      /<fieldset id="github-section"[^>]*>/,
    )?.[0] as string;
    expect(githubSection).toContain("display:none");
  });

  test("canProvision: true (in-cluster preselected) shows the restrictSlackToMembers group, Slack fieldset, and GitHub Authentication fieldset", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      canProvision: true,
    });
    const restrictGroup = html.match(
      /<div id="restrict-slack-group"[^>]*>/,
    )?.[0] as string;
    expect(restrictGroup).not.toContain("display:none");
    const slackSection = html.match(
      /<fieldset id="slack-section"[^>]*>/,
    )?.[0] as string;
    expect(slackSection).not.toContain("display:none");
    const githubSection = html.match(
      /<fieldset id="github-section"[^>]*>/,
    )?.[0] as string;
    expect(githubSection).not.toContain("display:none");
  });

  test("omitted canProvision defaults to hidden Slack/GitHub sections (self-hosted preselected)", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    const slackSection = html.match(
      /<fieldset id="slack-section"[^>]*>/,
    )?.[0] as string;
    expect(slackSection).toContain("display:none");
    const githubSection = html.match(
      /<fieldset id="github-section"[^>]*>/,
    )?.[0] as string;
    expect(githubSection).toContain("display:none");
  });

  test("both runtime radios carry an onchange handler that toggles the restrict-slack-group, slack-section, and github-section ids", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      canProvision: true,
    });
    const inClusterRadio = html.match(
      /<input[^>]*name="runtime"[^>]*value="in-cluster"[^>]*\/>/,
    )?.[0] as string;
    expect(inClusterRadio).toContain("onchange");
    expect(inClusterRadio).toContain("restrict-slack-group");
    expect(inClusterRadio).toContain("slack-section");
    expect(inClusterRadio).toContain("github-section");

    const selfHostedRadio = html.match(
      /<input[^>]*name="runtime"[^>]*value="self-hosted"[^>]*\/>/,
    )?.[0] as string;
    expect(selfHostedRadio).toContain("onchange");
    expect(selfHostedRadio).toContain("restrict-slack-group");
    expect(selfHostedRadio).toContain("slack-section");
    expect(selfHostedRadio).toContain("github-section");
  });

  // ── UAP-5.2: inline member-email textarea for restrictSlackToMembers ──────

  test("renders a memberEmails textarea inside a member-emails-fields block hidden by default", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).toMatch(/<textarea[^>]*name="memberEmails"[^>]*>/);
    const memberEmailsBlock = html.match(
      /<div id="member-emails-fields"[^>]*style="display:none[^>]*>[\s\S]*?memberEmails/,
    );
    expect(memberEmailsBlock).not.toBeNull();
  });

  test("restrictSlackToMembers checkbox onchange toggles the member-emails-fields block's display", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    const checkbox = html.match(
      /<input[^>]*name="restrictSlackToMembers"[^>]*>/,
    )?.[0] as string;
    expect(checkbox).toContain("onchange");
    expect(checkbox).toContain("member-emails-fields");
  });
});

// ─── renderAgentDetailPage — connect-later actions (UAP-2.3 / UAP-5.4) ───────

describe("renderAgentDetailPage — connect-later actions", () => {
  function render(envVars: Record<string, string>): string {
    return renderAgentDetailPage(
      AGENT,
      envVars,
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("Connect Slack action renders exactly one field (single-input backward compat)", () => {
    const html = render({});
    expect(html).toContain("Connect Slack");
    const slackForm = html.match(
      /action="\/admin\/agents\/agent-123\/connect-slack"[\s\S]*?<\/form>/,
    )?.[0] as string;
    expect(slackForm).toBeDefined();
    const inputCount = (slackForm.match(/<input\b/g) ?? []).length;
    expect(inputCount).toBe(1);
    expect(slackForm).toMatch(/name="xoxpToken"[^>]*type="password"/);
  });

  test("Connect Slack action is hidden once SLACK_APP_TOKEN is set", () => {
    const html = render({ SLACK_APP_TOKEN: "xoxe.xoxp-abc" });
    expect(html).not.toContain("Connect Slack<");
  });

  test("Set up GitHub App (auto) action renders githubOrg plus the public-App checkbox", () => {
    const html = render({});
    const forms = html.match(
      /action="\/admin\/agents\/agent-123\/connect-github"[\s\S]*?<\/form>/g,
    ) as string[];
    const autoForm = forms.find((f) => f.includes('value="auto"')) as string;
    expect(autoForm).toBeDefined();
    const inputCount = (autoForm.match(/<input\b/g) ?? []).length;
    // 2 hidden fields (ghAuthMode, ghAppMode) + githubOrg + ghAppPublic checkbox.
    expect(inputCount).toBe(4);
    expect(autoForm).toMatch(/name="githubOrg"[^>]*type="text"/);
    expect(autoForm).toMatch(/name="ghAppPublic" type="checkbox"/);
  });

  test("Add GitHub PAT action renders exactly one field (single-input backward compat)", () => {
    const html = render({});
    const forms = html.match(
      /action="\/admin\/agents\/agent-123\/connect-github"[\s\S]*?<\/form>/g,
    ) as string[];
    const patForm = forms.find((f) => f.includes('name="ghPat"')) as string;
    expect(patForm).toBeDefined();
    // 1 hidden field (ghAuthMode=pat) + 1 visible ghPat field.
    const inputCount = (patForm.match(/<input\b/g) ?? []).length;
    expect(inputCount).toBe(2);
    expect(patForm).toMatch(/name="ghPat"[^>]*type="password"/);
  });

  test("Set up GitHub App and Add GitHub PAT are both hidden once GH_APP_ID/GH_TOKEN are set", () => {
    const html = render({ GH_APP_ID: "12345", GH_TOKEN: "ghp_abc" });
    expect(html).not.toContain("Set up GitHub App<");
    expect(html).not.toContain("Add GitHub PAT<");
  });

  test("'Use existing GitHub App' action appears when GH_APP_ID is not set", () => {
    const html = render({});
    expect(html).toContain("Use existing GitHub App");
  });

  test("'Use existing GitHub App' action is hidden once GH_APP_ID is set (same gate as auto flow)", () => {
    const html = render({ GH_APP_ID: "12345" });
    expect(html).not.toContain("Use existing GitHub App");
  });

  test("'Use existing GitHub App' action posts to connect-github with hidden ghAuthMode=app/ghAppMode=manual", () => {
    const html = render({});
    const forms = html.match(
      /action="\/admin\/agents\/agent-123\/connect-github"[\s\S]*?<\/form>/g,
    ) as string[];
    const manualForm = forms.find(
      (f) => f.includes('value="manual"') && f.includes("ghAppId"),
    ) as string;
    expect(manualForm).toBeDefined();
    expect(manualForm).toMatch(
      /<input[^>]*type="hidden"[^>]*name="ghAuthMode"[^>]*value="app"[^>]*>/,
    );
    expect(manualForm).toMatch(
      /<input[^>]*type="hidden"[^>]*name="ghAppMode"[^>]*value="manual"[^>]*>/,
    );
  });

  test("'Use existing GitHub App' action renders three fields: App ID text, Installation ID text, Private Key file", () => {
    const html = render({});
    const forms = html.match(
      /action="\/admin\/agents\/agent-123\/connect-github"[\s\S]*?<\/form>/g,
    ) as string[];
    const manualForm = forms.find(
      (f) => f.includes('value="manual"') && f.includes("ghAppId"),
    ) as string;
    expect(manualForm).toMatch(/name="ghAppId"[^>]*type="text"/);
    expect(manualForm).toMatch(/name="ghAppInstallationId"[^>]*type="text"/);
    expect(manualForm).toMatch(/name="ghAppPrivateKeyFile"[^>]*type="file"/);
    // The <form> itself must allow file uploads.
    expect(manualForm).toContain('enctype="multipart/form-data"');
  });
});

// ─── renderAgentDetailPage — env vars section ────────────────────────────────

describe("renderAgentDetailPage — env vars", () => {
  function render(envVars: Record<string, string>): string {
    return renderAgentDetailPage(
      AGENT,
      envVars,
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("empty envVars shows 'No env vars set.' empty state", () => {
    const html = render({});
    expect(html).toContain("No env vars set.");
  });

  test("env key is rendered", () => {
    const html = render(ENV_VARS);
    expect(html).toContain("API_KEY");
    expect(html).toContain("DB_HOST");
  });

  test("env value is masked — shows •••••••• not the raw value", () => {
    const html = render({ SHORT: "abc" });
    expect(html).toContain("••••••••");
    expect(html).not.toContain("abc");
  });

  test("long env value is masked — not shown even when long", () => {
    const longVal = "x".repeat(45);
    const html = render({ LONG: longVal });
    expect(html).toContain("••••••••");
    expect(html).not.toContain(longVal.slice(0, 40));
  });

  test("delete form action points to /admin/agents/{agentId}/envs/delete", () => {
    const html = render(ENV_VARS);
    expect(html).toContain(`action="/admin/agents/${AGENT.id}/envs/delete"`);
  });

  test("delete form contains hidden key input", () => {
    const html = render({ MY_KEY: "myval" });
    expect(html).toContain('name="key"');
    expect(html).toContain('value="MY_KEY"');
  });

  test("add env var form action points to /admin/agents/{agentId}/envs", () => {
    const html = render({});
    expect(html).toContain(`action="/admin/agents/${AGENT.id}/envs"`);
  });

  test("XSS: env key is escaped", () => {
    const html = render({ "<script>": "val" });
    // The raw XSS payload must not appear as a live tag in the output
    expect(html).not.toContain("<script>val");
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: env value is masked — raw value never reaches HTML", () => {
    const html = render({ SAFE_KEY: "<img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror=alert");
    expect(html).toContain("••••••••");
  });

  test("Env Vars table is wrapped in .data-table-wrapper", () => {
    const html = render(ENV_VARS);
    expect(html).toMatch(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>Key<\/th>/,
    );
  });
});

// ─── renderAgentDetailPage — missingRequiredEnv badge (ATS-4.2) ──────────────

describe("renderAgentDetailPage — missingRequiredEnv badge", () => {
  function render(missingRequiredEnv: string[]): string {
    const agent: AgentDetail = { ...AGENT, missingRequiredEnv };
    return renderAgentDetailPage(
      agent,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("missing required env key renders a badge/callout referencing the key name", () => {
    const html = render(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(html).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(html).toContain('class="badge badge-warning"');
    expect(html).toContain('class="alert alert-warning"');
  });

  test("badge links to the env editor card", () => {
    const html = render(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(html).toContain('id="env-vars"');
    expect(html).toContain('href="#env-vars"');
  });

  test("multiple missing keys are all listed", () => {
    const html = render(["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"]);
    expect(html).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(html).toContain("GH_TOKEN");
  });

  test("empty missingRequiredEnv renders no badge/callout", () => {
    const html = render([]);
    expect(html).not.toContain('class="badge badge-warning"');
    expect(html).not.toContain("Missing required env var");
  });

  test("no env values ever appear alongside the badge — key names only", () => {
    const html = render(["CLAUDE_CODE_OAUTH_TOKEN"]);
    // The rendered badge must carry only the key name, never a value —
    // there is no value to render here since AgentDetail.missingRequiredEnv
    // is string[] of key names (secrets_in_logs).
    expect(html).not.toContain("secret-value");
  });

  test("XSS: missing env key names are escaped", () => {
    const html = render(['<script>alert("xss")</script>']);
    expect(html).not.toContain('alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderAgentDetailPage — crons section ───────────────────────────────────

describe("renderAgentDetailPage — crons", () => {
  function render(crons: CronJobItem[]): string {
    return renderAgentDetailPage(
      AGENT,
      {},
      crons,
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("empty crons: 'No system crons configured.' shown", () => {
    const html = render([]);
    expect(html).toContain("No system crons configured.");
  });

  test("empty crons: 'No custom crons yet.' shown", () => {
    const html = render([]);
    expect(html).toContain("No custom crons yet.");
  });

  test("system cron: toggle form action present", () => {
    const html = render([SYSTEM_CRON]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/crons/${SYSTEM_CRON.id}/toggle"`,
    );
  });

  test("system cron: NO delete form (system crons cannot be deleted)", () => {
    const html = render([SYSTEM_CRON]);
    expect(html).not.toContain(
      `action="/admin/agents/${AGENT.id}/crons/${SYSTEM_CRON.id}/delete"`,
    );
  });

  test("custom cron: toggle form action present", () => {
    const html = render([CUSTOM_CRON]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/crons/${CUSTOM_CRON.id}/toggle"`,
    );
  });

  test("custom cron: delete form action present", () => {
    const html = render([CUSTOM_CRON]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/crons/${CUSTOM_CRON.id}/delete"`,
    );
  });

  test("custom cron: full edit form posts to /update with prefilled fields", () => {
    const html = render([CUSTOM_CRON]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/crons/${CUSTOM_CRON.id}/update"`,
    );
    // full edit — schedule, prompt, channel, preCheck all editable
    expect(html).toContain('name="schedule"');
    expect(html).toContain('name="prompt"');
    expect(html).toContain('name="channel"');
    expect(html).toContain('name="preCheck"');
  });

  test("system cron: NO edit form (contents owned by reconcile)", () => {
    const html = render([SYSTEM_CRON]);
    expect(html).not.toContain(
      `action="/admin/agents/${AGENT.id}/crons/${SYSTEM_CRON.id}/update"`,
    );
  });

  test("cron: preCheck column header + value rendered (system cron, read-only)", () => {
    const html = render([SYSTEM_CRON]);
    expect(html).toContain("Pre-check");
    expect(html).toContain("shipwright:check-dev-task.ts");
  });

  test("enabled cron: badge-green and 'enabled' text shown", () => {
    const html = render([SYSTEM_CRON]); // SYSTEM_CRON is enabled
    expect(html).toContain("badge-green");
    expect(html).toContain(">enabled<");
  });

  test("disabled cron: badge-gray and 'disabled' text shown", () => {
    const html = render([CUSTOM_CRON]); // CUSTOM_CRON is disabled
    expect(html).toContain("badge-gray");
    expect(html).toContain(">disabled<");
  });

  test("cron create form action points to /admin/agents/{agentId}/crons", () => {
    const html = render([]);
    expect(html).toContain(`action="/admin/agents/${AGENT.id}/crons"`);
  });

  test("cron schedule is rendered", () => {
    const html = render([CUSTOM_CRON]);
    expect(html).toContain("30 8 * * *");
  });

  test("cron prompt is rendered", () => {
    const html = render([CUSTOM_CRON]);
    expect(html).toContain("Daily standup prompt");
  });

  test("named system cron renders name prefix in prompt cell", () => {
    const html = render([SYSTEM_CRON]);
    expect(html).toContain("health-check:");
    expect(html).toContain("System health check");
  });

  test("XSS: cron schedule is escaped", () => {
    const xssCron: CronJobItem = {
      ...CUSTOM_CRON,
      schedule: "<script>bad()</script>",
    };
    const html = render([xssCron]);
    // The raw XSS payload must not appear unescaped in the output
    expect(html).not.toContain(">bad()<");
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: cron prompt is escaped", () => {
    const xssCron: CronJobItem = {
      ...CUSTOM_CRON,
      prompt: "<img src=x onerror=bad()>",
    };
    const html = render([xssCron]);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("renderCronRow with lastRun: shows relative time and outcome badge", () => {
    // Use a fixed reference time so the test is deterministic at any wall-clock instant.
    const fixedNow = new Date("2024-06-01T12:00:00Z");
    const twoHoursAgo = new Date(fixedNow.getTime() - 2 * 3600 * 1000);
    const cronWithLastRun: CronJobItem = {
      ...CUSTOM_CRON,
      lastRun: {
        startedAt: twoHoursAgo,
        completedAt: new Date(twoHoursAgo.getTime() + 60000),
        skipped: false,
        outcome: "posted",
      },
      runCountToday: 3,
    };
    // Pass now via opts so relativeTime uses a fixed reference — deterministic at any wall-clock instant.
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [cronWithLastRun],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { now: fixedNow, timezone: "UTC" },
    );
    expect(html).toContain("hours ago");
    expect(html).toContain("posted");
    expect(html).toContain("3 runs");
  });

  test("renderCronRow without lastRun: shows 'never'", () => {
    const html = render([CUSTOM_CRON]);
    expect(html).toContain("never");
  });

  test("renderCronRow today count: 1 run (singular)", () => {
    const fixedNow = new Date("2024-06-01T12:00:00Z");
    const twoHoursAgo = new Date(fixedNow.getTime() - 2 * 3600 * 1000);
    const cronWithOneRun: CronJobItem = {
      ...CUSTOM_CRON,
      lastRun: {
        startedAt: twoHoursAgo,
        completedAt: new Date(twoHoursAgo.getTime() + 60000),
        skipped: false,
        outcome: "posted",
      },
      runCountToday: 1,
    };
    // Pass now via opts so relativeTime uses a fixed reference — deterministic at any wall-clock instant.
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [cronWithOneRun],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { now: fixedNow, timezone: "UTC" },
    );
    expect(html).toContain("1 run");
  });

  test("renderCronRow with lastRun skipped: shows 'skipped' badge (not 'unknown')", () => {
    const fixedNow = new Date("2024-06-01T12:00:00Z");
    const twoHoursAgo = new Date(fixedNow.getTime() - 2 * 3600 * 1000);
    const cronWithSkippedRun: CronJobItem = {
      ...CUSTOM_CRON,
      lastRun: {
        startedAt: twoHoursAgo,
        completedAt: new Date(twoHoursAgo.getTime() + 1000),
        skipped: true,
        outcome: null,
      },
      runCountToday: 0,
    };
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [cronWithSkippedRun],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { now: fixedNow, timezone: "UTC" },
    );
    expect(html).toContain(">skipped<");
    expect(html).not.toContain(">unknown<");
  });

  test("System Crons table is wrapped in .data-table-wrapper", () => {
    const html = render([SYSTEM_CRON]);
    expect(html).toMatch(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>Schedule<\/th>/,
    );
  });

  test("Custom Crons table is wrapped in .data-table-wrapper", () => {
    const html = render([CUSTOM_CRON]);
    // Both System and Custom crons tables share the same header shape —
    // assert there are two independent wrapper+table+Schedule occurrences.
    const matches = html.match(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>Schedule<\/th>/g,
    );
    expect(matches?.length).toBe(2);
  });

  test("System/Custom Crons table has a 'Created' column header", () => {
    const html = render([SYSTEM_CRON]);
    const createdHeaderCount = (
      html.match(/<th class="col-created">Created<\/th>/g) ?? []
    ).length;
    expect(createdHeaderCount).toBeGreaterThanOrEqual(2);
  });

  test("System/Custom Crons table still has 'Last run' column header alongside Created", () => {
    const html = render([SYSTEM_CRON]);
    expect(html).toContain("<th>Last run</th>");
    expect(html).toContain('<th class="col-created">Created</th>');
  });

  test("cron createdAt renders in the Created column", () => {
    const html = render([SYSTEM_CRON]);
    // SYSTEM_CRON.createdAt = 2024-02-01T00:00:00Z formatted en-US/UTC
    expect(html).toContain(
      new Date(SYSTEM_CRON.createdAt).toLocaleDateString("en-US", {
        timeZone: "UTC",
      }),
    );
  });
});

// ─── renderAgentDetailPage — tools section ───────────────────────────────────

describe("renderAgentDetailPage — tools", () => {
  function render(tools: ToolItem[]): string {
    return renderAgentDetailPage(
      AGENT,
      {},
      [],
      tools,
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("empty tools: 'No tools configured.' empty state", () => {
    const html = render([]);
    expect(html).toContain("No tools configured.");
  });

  test("tool pattern is rendered", () => {
    const html = render([TOOL_ENABLED]);
    expect(html).toContain("Bash(git:*)");
  });

  test("toggle form action: /admin/agents/{agentId}/tools/{toolId}/toggle", () => {
    const html = render([TOOL_ENABLED]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/tools/${TOOL_ENABLED.id}/toggle"`,
    );
  });

  test("delete form action: /admin/agents/{agentId}/tools/{toolId}/delete", () => {
    const html = render([TOOL_ENABLED]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/tools/${TOOL_ENABLED.id}/delete"`,
    );
  });

  test("enabled tool: badge-green and 'enabled' text", () => {
    const html = render([TOOL_ENABLED]);
    expect(html).toContain("badge-green");
    expect(html).toContain(">enabled<");
  });

  test("disabled tool: badge-gray and 'disabled' text", () => {
    const html = render([TOOL_DISABLED]);
    expect(html).toContain("badge-gray");
    expect(html).toContain(">disabled<");
  });

  test("add tool form action: /admin/agents/{agentId}/tools", () => {
    const html = render([]);
    expect(html).toContain(`action="/admin/agents/${AGENT.id}/tools"`);
  });

  test("XSS: tool pattern is escaped", () => {
    const xssTool: ToolItem = {
      ...TOOL_ENABLED,
      pattern: "<script>alert(1)</script>",
    };
    const html = render([xssTool]);
    // The raw XSS payload must not appear unescaped in the output
    expect(html).not.toContain(">alert(1)<");
    expect(html).toContain("&lt;script&gt;");
  });

  test("Tools table is wrapped in .data-table-wrapper", () => {
    const html = render([TOOL_ENABLED]);
    expect(html).toMatch(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>Pattern<\/th>/,
    );
  });

  test("Tools table has a 'Created' column header", () => {
    const html = render([TOOL_ENABLED]);
    expect(html).toContain("<th>Created</th>");
  });

  test("tool createdAt renders in the Created column", () => {
    const html = render([TOOL_ENABLED]);
    expect(html).toContain(
      new Date(TOOL_ENABLED.createdAt).toLocaleDateString("en-US", {
        timeZone: "UTC",
      }),
    );
  });
});

// ─── renderAgentDetailPage — tokens section ──────────────────────────────────

describe("renderAgentDetailPage — tokens", () => {
  function render(tokens: TokenItem[]): string {
    return renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      tokens,
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("empty tokens: 'No tokens created.' empty state", () => {
    const html = render([]);
    expect(html).toContain("No tokens created.");
  });

  test("active token: badge-green and 'Active' shown", () => {
    const html = render([TOKEN_ACTIVE]);
    expect(html).toContain("badge-green");
    expect(html).toContain(">Active<");
  });

  test("active token: Revoke form present", () => {
    const html = render([TOKEN_ACTIVE]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/tokens/${TOKEN_ACTIVE.id}/revoke"`,
    );
  });

  test("revoked token: badge-gray and 'Revoked' shown", () => {
    const html = render([TOKEN_REVOKED]);
    expect(html).toContain("badge-gray");
    expect(html).toContain("Revoked");
  });

  test("revoked token: NO revoke form", () => {
    const html = render([TOKEN_REVOKED]);
    expect(html).not.toContain(
      `action="/admin/agents/${AGENT.id}/tokens/${TOKEN_REVOKED.id}/revoke"`,
    );
  });

  test("token create form action: /admin/agents/{agentId}/tokens", () => {
    const html = render([]);
    expect(html).toContain(`action="/admin/agents/${AGENT.id}/tokens"`);
  });

  test("revoke form action: /admin/agents/{agentId}/tokens/{tokenId}/revoke", () => {
    const html = render([TOKEN_ACTIVE]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/tokens/${TOKEN_ACTIVE.id}/revoke"`,
    );
  });

  test("token label is rendered", () => {
    const html = render([TOKEN_ACTIVE]);
    expect(html).toContain("CI token");
  });

  test("null label renders dash placeholder", () => {
    const noLabel: TokenItem = { ...TOKEN_ACTIVE, label: null };
    const html = render([noLabel]);
    // The template renders a grey dash span when label is null
    expect(html).toContain("color:#9ca3af");
  });

  test("XSS: token label is escaped", () => {
    const xssToken: TokenItem = {
      ...TOKEN_ACTIVE,
      label: "<script>steal()</script>",
    };
    const html = render([xssToken]);
    // The raw XSS payload must not appear unescaped in the output
    expect(html).not.toContain(">steal()<");
    expect(html).toContain("&lt;script&gt;");
  });

  test("Task Store Tokens table is wrapped in .data-table-wrapper", () => {
    const html = render([TOKEN_ACTIVE]);
    expect(html).toMatch(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>Label<\/th>/,
    );
  });
});

// ─── renderAgentDetailPage — plugins section ─────────────────────────────────

describe("renderAgentDetailPage — plugins", () => {
  function render(plugins: PluginItem[]): string {
    return renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      plugins,
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("empty plugins: 'No plugins installed.' empty state", () => {
    const html = render([]);
    expect(html).toContain("No plugins installed.");
  });

  test("plugin name is rendered", () => {
    const html = render([PLUGIN_ENABLED]);
    expect(html).toContain("shipwright");
  });

  test("plugin version is rendered when present", () => {
    const html = render([PLUGIN_ENABLED]);
    expect(html).toContain("1.2.3");
  });

  test("null version renders 'latest'", () => {
    const html = render([PLUGIN_DISABLED]); // PLUGIN_DISABLED has version: null
    expect(html).toContain("latest");
  });

  test("enabled plugin: badge-green and 'enabled' text", () => {
    const html = render([PLUGIN_ENABLED]);
    expect(html).toContain("badge-green");
    expect(html).toContain(">enabled<");
  });

  test("disabled plugin: badge-gray and 'disabled' text", () => {
    const html = render([PLUGIN_DISABLED]);
    expect(html).toContain("badge-gray");
    expect(html).toContain(">disabled<");
  });

  test("XSS: plugin name is escaped", () => {
    const xssPlugin: PluginItem = {
      ...PLUGIN_ENABLED,
      name: "<script>bad()</script>",
    };
    const html = render([xssPlugin]);
    // The raw XSS payload must not appear unescaped in the output
    expect(html).not.toContain(">bad()<");
    expect(html).toContain("&lt;script&gt;");
  });

  test("Plugins table is wrapped in .data-table-wrapper", () => {
    const html = render([PLUGIN_ENABLED]);
    expect(html).toMatch(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>Package<\/th>/,
    );
  });

  test("Plugins table has a 'Created' column header", () => {
    const html = render([PLUGIN_ENABLED]);
    expect(html).toContain("<th>Created</th>");
  });

  test("plugin createdAt renders in the Created column", () => {
    const html = render([PLUGIN_ENABLED]);
    expect(html).toContain(
      new Date(PLUGIN_ENABLED.createdAt).toLocaleDateString("en-US", {
        timeZone: "UTC",
      }),
    );
  });
});

// ─── renderProvisionCompletePage ─────────────────────────────────────────────

describe("renderProvisionCompletePage", () => {
  test("returns a valid HTML document", () => {
    const html = renderProvisionCompletePage(USER_NAME, { success: true });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("success: shows success alert", () => {
    const html = renderProvisionCompletePage(USER_NAME, {
      success: true,
      agentId: "agent-new",
    });
    expect(html).toContain('class="alert alert-success"');
  });

  test("success: 'View Agent' link includes agentId", () => {
    const html = renderProvisionCompletePage(USER_NAME, {
      success: true,
      agentId: "agent-new",
    });
    expect(html).toContain("View Agent");
    expect(html).toContain("/admin/agents/agent-new");
  });

  test("success without agentId: no 'View Agent' link", () => {
    const html = renderProvisionCompletePage(USER_NAME, { success: true });
    expect(html).not.toContain("View Agent");
  });

  test("failure: shows error alert", () => {
    const html = renderProvisionCompletePage(USER_NAME, {
      success: false,
      error: "Provisioning failed: bad token",
    });
    expect(html).toContain('class="alert alert-error"');
    expect(html).toContain("Provisioning failed: bad token");
  });

  test("failure: shows 'Try again' link", () => {
    const html = renderProvisionCompletePage(USER_NAME, { success: false });
    expect(html).toContain("Try again");
    expect(html).toContain("/admin/provision");
  });

  test("failure with no error: shows default 'Provisioning failed.' message", () => {
    const html = renderProvisionCompletePage(USER_NAME, { success: false });
    expect(html).toContain("Provisioning failed.");
  });

  test("XSS: error message is escaped", () => {
    const html = renderProvisionCompletePage(USER_NAME, {
      success: false,
      error: "<script>steal()</script>",
    });
    expect(html).not.toContain("<script>steal()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: agentId in View Agent link is escaped", () => {
    const html = renderProvisionCompletePage(USER_NAME, {
      success: true,
      agentId: '"><script>xss()</script>',
    });
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderAgentDetailPage — repos section ───────────────────────────────────

describe("renderAgentDetailPage — repos", () => {
  function render(repos: string[]): string {
    const agent: AgentDetail = { ...AGENT, repos };
    return renderAgentDetailPage(
      agent,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("renders empty repos state", () => {
    const html = render([]);
    expect(html).toContain("No repos configured.");
  });

  test("renders repos list", () => {
    const html = render(["my-org/my-repo"]);
    expect(html).toContain("my-org/my-repo");
  });

  test("repos section has add form", () => {
    const html = render([]);
    expect(html).toContain(`action="/admin/agents/${AGENT.id}/repos/add"`);
    expect(html).toContain('name="repo"');
  });

  test("repos section has remove button for existing repo", () => {
    const html = render(["my-org/my-repo"]);
    expect(html).toContain(`action="/admin/agents/${AGENT.id}/repos/delete"`);
    expect(html).toContain('value="my-org/my-repo"');
  });

  test("Repos table is wrapped in .data-table-wrapper", () => {
    const html = render(["my-org/my-repo"]);
    expect(html).toMatch(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>Repo<\/th>/,
    );
  });
});

// ─── renderAgentDetailPage — author allowlist section ────────────────────────

describe("renderAgentDetailPage — author allowlist", () => {
  function render(authorAllowlist: string[]): string {
    const agent: AgentDetail = { ...AGENT, authorAllowlist };
    return renderAgentDetailPage(
      agent,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("renders empty author allowlist state", () => {
    const html = render([]);
    expect(html).toContain("No author allowlist entries configured.");
  });

  test("renders author allowlist list", () => {
    const html = render(["octocat"]);
    expect(html).toContain("octocat");
  });

  test("card title reads 'Author allowlist (review)'", () => {
    const html = render([]);
    expect(html).toContain(
      '<div class="card-title">Author allowlist (review)</div>',
    );
  });

  test("author allowlist section has add form", () => {
    const html = render([]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/review-author-allowlist/add"`,
    );
    expect(html).toContain('name="login"');
  });

  test("author allowlist section has remove button for existing login", () => {
    const html = render(["octocat"]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/review-author-allowlist/delete"`,
    );
    expect(html).toContain('value="octocat"');
  });

  test("Author allowlist table is wrapped in .data-table-wrapper", () => {
    const html = render(["octocat"]);
    expect(html).toMatch(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>GitHub login<\/th>/,
    );
  });
});

// ─── renderAgentDetailPage — patch author allowlist section ──────────────────

describe("renderAgentDetailPage — patch author allowlist", () => {
  function render(patchAuthorAllowlist: string[]): string {
    const agent: AgentDetail = { ...AGENT, patchAuthorAllowlist };
    return renderAgentDetailPage(
      agent,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
  }

  test("renders empty patch author allowlist state", () => {
    const html = render([]);
    expect(html).toContain("No patch author allowlist entries configured.");
  });

  test("renders patch author allowlist list", () => {
    const html = render(["octocat"]);
    expect(html).toContain("octocat");
  });

  test("card title reads 'Author allowlist (patch)'", () => {
    const html = render([]);
    expect(html).toContain(
      '<div class="card-title">Author allowlist (patch)</div>',
    );
  });

  test("patch author allowlist section has add form", () => {
    const html = render([]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/patch-author-allowlist/add"`,
    );
    expect(html).toContain('name="login"');
  });

  test("patch author allowlist section has remove button for existing login", () => {
    const html = render(["octocat"]);
    expect(html).toContain(
      `action="/admin/agents/${AGENT.id}/patch-author-allowlist/delete"`,
    );
    expect(html).toContain('value="octocat"');
  });

  test("patch author allowlist table is wrapped in .data-table-wrapper", () => {
    const html = render(["octocat"]);
    expect(html).toMatch(
      /<div class="data-table-wrapper">\s*<table class="data-table">\s*<thead>\s*<tr>\s*<th>GitHub login<\/th>/,
    );
  });
});

// ─── renderAgentDetailPage — accordion groups (AGA-1.1) ──────────────────────

describe("renderAgentDetailPage — accordion groups", () => {
  /**
   * All 4 group `<details class="group">` blocks, in document order.
   * A naive non-greedy `[\s\S]*?<\/details>` regex breaks here because
   * several cards (e.g. Slack access's "Connect Slack" popover) nest their
   * own unrelated `<details>` inside a group's body — this walks nesting
   * depth so each group's true closing tag is found.
   */
  function extractGroups(html: string): string[] {
    const groups: string[] = [];
    const openTagRe = /<details class="group">/g;
    let match: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-loop idiom
    while ((match = openTagRe.exec(html)) !== null) {
      const start = match.index;
      let depth = 1;
      let cursor = start + match[0].length;
      const tagRe = /<details\b[^>]*>|<\/details>/g;
      tagRe.lastIndex = cursor;
      let tagMatch: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-loop idiom
      while ((tagMatch = tagRe.exec(html)) !== null) {
        if (tagMatch[0] === "</details>") {
          depth--;
        } else {
          depth++;
        }
        if (depth === 0) {
          cursor = tagRe.lastIndex;
          break;
        }
      }
      groups.push(html.slice(start, cursor));
    }
    return groups;
  }

  function render(opts?: Parameters<typeof renderAgentDetailPage>[9]): string {
    return renderAgentDetailPage(
      AGENT,
      {},
      [SYSTEM_CRON, CUSTOM_CRON],
      [TOOL_ENABLED, TOOL_DISABLED],
      [TOKEN_ACTIVE, TOKEN_REVOKED],
      [PLUGIN_ENABLED, PLUGIN_DISABLED],
      [
        {
          id: "m1",
          email: "member@example.com",
          createdAt: new Date("2025-01-01"),
        },
      ],
      USER_NAME,
      true,
      { timezone: "UTC", ...opts },
    );
  }

  test('renders exactly 4 <details class="group"> elements', () => {
    const html = render();
    expect(extractGroups(html)).toHaveLength(4);
  });

  test("groups are named Automation, Configuration, Access, Plugins & Tools in that order", () => {
    const html = render();
    const groups = extractGroups(html);
    expect(groups[0]).toContain('<span class="group-title">Automation</span>');
    expect(groups[1]).toContain(
      '<span class="group-title">Configuration</span>',
    );
    expect(groups[2]).toContain('<span class="group-title">Access</span>');
    expect(groups[3]).toContain(
      '<span class="group-title">Plugins &amp; Tools</span>',
    );
  });

  test("all 4 groups render collapsed (no `open` attribute) by default", () => {
    const html = render();
    const groupTags = html.match(/<details class="group"[^>]*>/g) ?? [];
    expect(groupTags).toHaveLength(4);
    for (const tag of groupTags) {
      expect(tag).not.toContain("open");
    }
  });

  test("groups stay collapsed even when agent.missingRequiredEnv is non-empty", () => {
    const agent: AgentDetail = { ...AGENT, missingRequiredEnv: ["GH_TOKEN"] };
    const html = renderAgentDetailPage(
      agent,
      {},
      [SYSTEM_CRON],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    const groupTags = html.match(/<details class="group"[^>]*>/g) ?? [];
    expect(groupTags).toHaveLength(4);
    for (const tag of groupTags) {
      expect(tag).not.toContain("open");
    }
  });

  test("Automation group contains the Cron Jobs card", () => {
    const html = render();
    const groups = extractGroups(html);
    expect(groups[0]).toContain('<div class="card-title">Cron Jobs</div>');
    expect(groups[0]).not.toContain("Env Vars");
  });

  test("Configuration group contains Env Vars and Repos cards", () => {
    const html = render();
    const groups = extractGroups(html);
    expect(groups[1]).toContain('id="env-vars"');
    expect(groups[1]).toContain('<div class="card-title">Repos</div>');
    expect(groups[1]).not.toContain("Cron Jobs");
  });

  test("Access group contains Members, both author allowlists, Slack access, and Task Store Tokens cards", () => {
    const html = render();
    const groups = extractGroups(html);
    expect(groups[2]).toContain("member@example.com");
    expect(groups[2]).toContain(
      '<div class="card-title">Author allowlist (review)</div>',
    );
    expect(groups[2]).toContain(
      '<div class="card-title">Author allowlist (patch)</div>',
    );
    expect(groups[2]).toContain('<div class="card-title">Slack access</div>');
    expect(groups[2]).toContain(
      '<div class="card-title">Task Store Tokens</div>',
    );
  });

  test("Plugins & Tools group contains Tools and Plugins cards", () => {
    const html = render();
    const groups = extractGroups(html);
    expect(groups[3]).toContain('<div class="card-title">Tools</div>');
    expect(groups[3]).toContain('<div class="card-title">Plugins</div>');
  });

  test("Danger Zone stays a bare .card outside any group, after the last group", () => {
    const html = render();
    const lastGroupEnd = html.lastIndexOf("</details>");
    const dangerZoneIndex = html.indexOf("Danger Zone");
    expect(dangerZoneIndex).toBeGreaterThan(lastGroupEnd);
    // Sits in its own .card, not nested in a .group-body.
    const dangerZoneCardIndex = html.indexOf(
      '<div class="card" style="border:1px solid #fca5a5">',
    );
    expect(dangerZoneCardIndex).toBeGreaterThan(lastGroupEnd);
  });

  test("Danger Zone absent for non-admins, groups still render", () => {
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [],
      [],
      [],
      [],
      [],
      USER_NAME,
      false,
      { timezone: "UTC" },
    );
    expect(html).not.toContain("Danger Zone");
    expect(extractGroups(html)).toHaveLength(4);
  });

  test("each group's summary wraps the toggle+title in one span, separate from the stat span", () => {
    const html = render();
    const groups = extractGroups(html);
    for (const group of groups) {
      // Exactly one flush-left title span and one flush-right stat span
      // inside the summary -- not a ::before on <summary> itself.
      expect(group).toMatch(
        /<summary class="group-summary">\s*<span class="group-title">[^<]*<\/span>\s*<span class="group-sub">[^<]*<\/span>\s*<\/summary>/,
      );
    }
  });

  test("Automation group's stat string reflects system/custom cron counts", () => {
    const html = render();
    const groups = extractGroups(html);
    expect(groups[0]).toContain(
      '<span class="group-sub">1 system · 1 custom</span>',
    );
  });

  test("Plugins & Tools group's stat string reflects tool/plugin counts", () => {
    const html = render();
    const groups = extractGroups(html);
    expect(groups[3]).toContain(
      '<span class="group-sub">2 tools · 2 plugins</span>',
    );
  });

  test("CSS: toggle glyph is a ::before on .group-title, not on the flex .group-summary", () => {
    const styles = baseStyles();
    expect(styles).toContain(".group-title::before");
    expect(styles).not.toMatch(/\.group-summary\s*::before/);
  });

  test("CSS: .group-summary is a 2-sided flex row (space-between)", () => {
    const styles = baseStyles();
    const match = styles.match(/\.group-summary\s*\{[^}]*\}/);
    expect(match).not.toBeNull();
    expect(match?.[0]).toContain("display: flex");
    expect(match?.[0]).toContain("justify-content: space-between");
  });

  test("Expand all button is present and renders as a real <button> element", () => {
    const html = render();
    expect(html).toContain("<button");
    expect(html).toContain("Expand all");
  });

  test("Collapse all button is present and renders as a real <button> element", () => {
    const html = render();
    expect(html).toContain("<button");
    expect(html).toContain("Collapse all");
  });

  test("inline script with expand/collapse logic is present in the rendered HTML", () => {
    const html = render();
    expect(html).toContain("<script>");
    expect(html).toContain("document.querySelectorAll");
    expect(html).toContain(".group");
  });

  test("inline script sets open=true on all .group elements when Expand all is clicked", () => {
    const html = render();
    expect(html).toContain("querySelectorAll");
    expect(html).toContain(".group");
    expect(html).toContain("el.open = true");
  });

  test("inline script sets open=false on all .group elements when Collapse all is clicked", () => {
    const html = render();
    expect(html).toContain("querySelectorAll");
    expect(html).toContain(".group");
    expect(html).toContain("el.open = false");
  });
});

// ─── renderAgentDetailPage — stat strip (AGA-1.2) ────────────────────────────

describe("renderAgentDetailPage — stat strip", () => {
  function render(opts?: Parameters<typeof renderAgentDetailPage>[9]): string {
    return renderAgentDetailPage(
      AGENT,
      {},
      [SYSTEM_CRON, CUSTOM_CRON],
      [TOOL_ENABLED, TOOL_DISABLED],
      [TOKEN_ACTIVE, TOKEN_REVOKED],
      [PLUGIN_ENABLED, PLUGIN_DISABLED],
      [
        {
          id: "m1",
          email: "member@example.com",
          createdAt: new Date("2025-01-01"),
        },
      ],
      USER_NAME,
      true,
      { timezone: "UTC", ...opts },
    );
  }

  test("stat strip renders exactly 4 stat tiles", () => {
    const html = render();
    const tiles = html.match(/<div class="stat-tile"[^>]*>/g) ?? [];
    expect(tiles).toHaveLength(4);
  });

  test("stat tiles appear in order: crons active, missing env vars, members, repos", () => {
    const html = render();
    const cronsIndex = html.indexOf("crons active");
    const envIndex = html.indexOf("missing env vars");
    const membersIndex = html.indexOf("members");
    const reposIndex = html.indexOf("repos");

    expect(cronsIndex).toBeGreaterThan(-1);
    expect(envIndex).toBeGreaterThan(-1);
    expect(membersIndex).toBeGreaterThan(-1);
    expect(reposIndex).toBeGreaterThan(-1);
    expect(cronsIndex < envIndex).toBe(true);
    expect(envIndex < membersIndex).toBe(true);
    expect(membersIndex < reposIndex).toBe(true);
  });

  test("crons-active count equals enabled rows across system and custom cron tables", () => {
    // SYSTEM_CRON is enabled: true, CUSTOM_CRON is enabled: false
    // So 1 enabled total
    const html = render();
    expect(html).toMatch(
      /<div class="stat-tile"[^>]*>[\s\S]*?crons active[\s\S]*?<span[^>]*>\s*1\s*<\/span>/,
    );
  });

  test("crons-active count correctly reflects enabled crons from different configurations", () => {
    // Test with multiple enabled/disabled crons
    const enabledCron: CronJobItem = {
      ...SYSTEM_CRON,
      id: "cron-sys-2",
      enabled: true,
    };
    const disabledCron: CronJobItem = {
      ...CUSTOM_CRON,
      id: "cron-custom-2",
      enabled: false,
    };
    const html = renderAgentDetailPage(
      AGENT,
      {},
      [SYSTEM_CRON, enabledCron, CUSTOM_CRON, disabledCron],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    // Should have 2 enabled crons (SYSTEM_CRON and enabledCron)
    expect(html).toMatch(
      /<div class="stat-tile"[^>]*>[\s\S]*?crons active[\s\S]*?<span[^>]*>\s*2\s*<\/span>/,
    );
  });

  test("missing-env-vars count equals agent.missingRequiredEnv.length", () => {
    const html = render();
    // AGENT fixture has missingRequiredEnv: []
    expect(html).toMatch(
      /<div class="stat-tile"[^>]*>[\s\S]*?missing env vars[\s\S]*?<span[^>]*>\s*0\s*<\/span>/,
    );
  });

  test("missing-env-vars count shows correct value when missingRequiredEnv is non-empty", () => {
    const agent: AgentDetail = {
      ...AGENT,
      missingRequiredEnv: ["GH_TOKEN", "SLACK_APP_TOKEN"],
    };
    const html = renderAgentDetailPage(
      agent,
      {},
      [SYSTEM_CRON, CUSTOM_CRON],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    expect(html).toMatch(
      /<div class="stat-tile"[^>]*>[\s\S]*?missing env vars[\s\S]*?<span[^>]*>\s*2\s*<\/span>/,
    );
  });

  test("members count equals members array length", () => {
    const html = render();
    // render() passes 1 member
    expect(html).toMatch(
      /<div class="stat-tile"[^>]*>[\s\S]*?members[\s\S]*?<span[^>]*>\s*1\s*<\/span>/,
    );
  });

  test("repos count equals agent.repos.length", () => {
    const agent: AgentDetail = {
      ...AGENT,
      repos: ["owner/repo1", "owner/repo2", "owner/repo3"],
    };
    const html = renderAgentDetailPage(
      agent,
      {},
      [SYSTEM_CRON, CUSTOM_CRON],
      [],
      [],
      [],
      [
        {
          id: "m1",
          email: "member@example.com",
          createdAt: new Date("2025-01-01"),
        },
      ],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    expect(html).toMatch(
      /<div class="stat-tile"[^>]*>[\s\S]*?repos[\s\S]*?<span[^>]*>\s*3\s*<\/span>/,
    );
  });

  test("missing-env-vars tile has warning styling when count > 0", () => {
    const agent: AgentDetail = {
      ...AGENT,
      missingRequiredEnv: ["GH_TOKEN"],
    };
    const html = renderAgentDetailPage(
      agent,
      {},
      [SYSTEM_CRON, CUSTOM_CRON],
      [],
      [],
      [],
      [],
      USER_NAME,
      true,
      { timezone: "UTC" },
    );
    // Should contain warning class styling
    expect(html).toMatch(/stat-tile-warning[\s\S]*?missing env vars/);
  });

  test("missing-env-vars tile has default styling when count is 0", () => {
    const html = render();
    // AGENT fixture has empty missingRequiredEnv
    const tileSectionMatch = html.match(
      /<div class="stat-tile"[^>]*>[\s\S]*?missing env vars[\s\S]*?<\/div>\s*<\/div>/,
    );
    expect(tileSectionMatch).not.toBeNull();
    // Should NOT have stat-tile-warning class
    const tileSection = tileSectionMatch?.[0] ?? "";
    expect(tileSection).not.toContain("stat-tile-warning");
  });

  test("stat strip renders before accordion groups", () => {
    const html = render();
    const statStripIndex = html.indexOf('class="stat-strip"');
    const automationGroupIndex = html.indexOf(
      '<span class="group-title">Automation</span>',
    );

    expect(statStripIndex).toBeGreaterThan(-1);
    expect(automationGroupIndex).toBeGreaterThan(-1);
    expect(statStripIndex < automationGroupIndex).toBe(true);
  });

  test("CSS: .stat-strip and .stat-tile classes exist in baseStyles", () => {
    const styles = baseStyles();
    expect(styles).toContain(".stat-strip");
    expect(styles).toContain(".stat-tile");
  });

  test("CSS: .stat-tile-warning class exists for warning styling", () => {
    const styles = baseStyles();
    expect(styles).toContain(".stat-tile-warning");
  });
});

// ─── renderAdminToolbar — active nav highlight ────────────────────────────────

describe("renderAdminToolbar — active nav highlight", () => {
  test("activePath /admin/agents: Agents link is active", () => {
    const html = renderAdminToolbar(USER_NAME, "/admin/agents");
    expect(html).toContain('href="/admin/agents" class="vos-nav-link active"');
  });

  test("activePath sub-path /admin/agents/agent-id: Agents link is still active (startsWith)", () => {
    const html = renderAdminToolbar(USER_NAME, "/admin/agents/agent-id");
    expect(html).toContain('href="/admin/agents" class="vos-nav-link active"');
  });

  test("activePath '' (default): neither link is active", () => {
    const html = renderAdminToolbar(USER_NAME);
    expect(html).not.toContain('class="vos-nav-link active"');
    expect(html).toContain('href="/admin/agents" class="vos-nav-link"');
  });
});

// ─── renderChatPage ───────────────────────────────────────────────────────────

describe("renderChatPage", () => {
  const AGENTS = [
    { id: "agent-1", name: "Agent One" },
    { id: "agent-2", name: "Agent Two" },
  ];

  const THREADS: ChatThread[] = [
    {
      id: "thread-1",
      agentId: "agent-1",
      title: "First Thread",
      memberId: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ];

  test("renders agent selector", () => {
    const html = renderChatPage(AGENTS, undefined, null, "alice");
    expect(html).toContain("Agent One");
    expect(html).toContain("Agent Two");
  });

  test("degraded mode: renders not-configured notice when threads is null", () => {
    const html = renderChatPage(AGENTS, "agent-1", null, "alice");
    expect(html).toContain("SHIPWRIGHT_CHAT_SERVICE_URL");
  });

  test("renders thread list when threads are provided", () => {
    const html = renderChatPage(AGENTS, "agent-1", THREADS, "alice");
    expect(html).toContain("First Thread");
  });

  test("responsive: page includes a @media CSS rule for mobile", () => {
    const html = renderChatPage(AGENTS, "agent-1", THREADS, "alice");
    expect(html).toContain("@media");
  });

  test("responsive: layout wrapper has chat-list-layout class", () => {
    const html = renderChatPage(AGENTS, "agent-1", THREADS, "alice");
    expect(html).toContain("chat-list-layout");
  });
});

// ─── renderChatThreadPage ─────────────────────────────────────────────────────

describe("renderChatThreadPage", () => {
  const THREAD: ChatThread = {
    id: "thread-abc",
    agentId: "agent-xyz",
    title: "My Test Thread",
    memberId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  const USER_MSG: ChatMessage = {
    id: "msg-1",
    threadId: "thread-abc",
    role: "user",
    body: "Hello, agent!",
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  const ASSISTANT_MSG: ChatMessage = {
    id: "msg-2",
    threadId: "thread-abc",
    role: "assistant",
    body: "Here is **bold text** and `inline code`.",
    createdAt: "2024-01-01T00:01:00.000Z",
    claimedBy: null,
    repliedAt: "2024-01-01T00:01:05.000Z",
    tokens: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    costUsd: 0.001,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  const ERROR_MSG: ChatMessage = {
    id: "msg-3",
    threadId: "thread-abc",
    role: "assistant",
    body: "",
    createdAt: "2024-01-01T00:02:00.000Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: "rate-limited",
    attachmentFilename: null,
    attachmentSize: null,
  };

  test("degraded mode: renders not-configured notice when thread is null", () => {
    const html = renderChatThreadPage("agent-xyz", null, null, "alice");
    expect(html.toLowerCase()).toMatch(/not configured|unavailable|degraded/);
  });

  test("renders thread title in page", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("My Test Thread");
  });

  test("renders user message body", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("Hello, agent!");
  });

  test("user messages are right-aligned with indigo/blue background", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    // right-aligned and indigo/blue background (#eef2ff)
    expect(html).toContain("#eef2ff");
    expect(html).toContain("flex-end");
  });

  test("assistant messages are left-aligned with green background", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [ASSISTANT_MSG],
      "alice",
    );
    expect(html).toContain("#f0fdf4");
    expect(html).toContain("flex-start");
  });

  test("assistant messages render markdown: bold text becomes <strong>", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [ASSISTANT_MSG],
      "alice",
    );
    expect(html).toContain("<strong>bold text</strong>");
  });

  test("assistant messages render markdown: inline code becomes <code>", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [ASSISTANT_MSG],
      "alice",
    );
    expect(html).toContain("<code>inline code</code>");
  });

  test("errorKind rate-limited shows human-readable error state", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [ERROR_MSG],
      "alice",
    );
    expect(html).toContain("Rate limited");
  });

  test("errorKind message renders a red/error badge or indicator", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [ERROR_MSG],
      "alice",
    );
    // should have some red / error styling
    expect(html.toLowerCase()).toMatch(/error|#ef4444|#fee2e2|#b91c1c|#dc2626/);
  });

  test("errorKind cancelled renders a human-readable 'Cancelled' badge", () => {
    const msg: ChatMessage = { ...ERROR_MSG, errorKind: "cancelled" };
    const html = renderChatThreadPage("agent-xyz", THREAD, [msg], "alice");
    expect(html).toContain("Cancelled");
  });

  test("errorKind incomplete renders a human-readable 'Incomplete' badge", () => {
    const msg: ChatMessage = { ...ERROR_MSG, errorKind: "incomplete" };
    const html = renderChatThreadPage("agent-xyz", THREAD, [msg], "alice");
    expect(html).toContain("Incomplete");
  });

  test("errorKind stalled renders a human-readable 'Stalled' badge", () => {
    const msg: ChatMessage = { ...ERROR_MSG, errorKind: "stalled" };
    const html = renderChatThreadPage("agent-xyz", THREAD, [msg], "alice");
    expect(html).toContain("Stalled");
  });

  test("cancelled/incomplete/stalled errorKinds render a Retry action wired to resend the originating user message", () => {
    for (const kind of ["cancelled", "incomplete", "stalled"]) {
      const errMsg: ChatMessage = { ...ERROR_MSG, errorKind: kind };
      const html = renderChatThreadPage(
        "agent-xyz",
        THREAD,
        [USER_MSG, errMsg],
        "alice",
      );
      expect(html).toContain("Retry");
      expect(html).toContain('class="chat-retry-btn"');
      expect(html).toContain(`data-retry-body="${USER_MSG.body}"`);
    }
  });

  test("Retry action is omitted when there is no preceding user message to resend", () => {
    const errMsg: ChatMessage = { ...ERROR_MSG, errorKind: "cancelled" };
    const html = renderChatThreadPage("agent-xyz", THREAD, [errMsg], "alice");
    // The inline JS statically wires up any '.chat-retry-btn' elements that
    // exist, so it always contains the class name — assert no button element
    // with that class was actually rendered into the message markup instead.
    expect(html).not.toContain('class="chat-retry-btn"');
  });

  test("Retry click handler resends the button's data-retry-body via the shared send path", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [USER_MSG, { ...ERROR_MSG, errorKind: "stalled" }],
      "alice",
    );
    expect(html).toContain("querySelectorAll('.chat-retry-btn')");
    expect(html).toContain("getAttribute('data-retry-body')");
    expect(html).toContain("sendText(body, null)");
  });

  test("empty thread shows empty state message", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [], "alice");
    expect(html).toContain("No messages");
  });

  test("page includes messages-container element for JS polling", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("messages-container");
  });

  test("page includes the live status bubble id in the inline JS", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("live-status-bubble");
  });

  test("page includes send-btn id for send button", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("send-btn");
  });

  test("page includes messages.json polling endpoint reference in JS", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("messages.json");
  });

  test("page's poll loop uses the CFB-2.3 stall/absolute-max model, not the old poll-count timeouts", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    // The new millisecond-based model replaces the old poll-count constants.
    expect(html).toContain("STALL_WARN_AFTER_MS");
    expect(html).toContain("ABSOLUTE_MAX_MS");
    expect(html).not.toContain("IDLE_TIMEOUT_POLLS");
    expect(html).not.toContain("ABSOLUTE_MAX_POLLS");
  });

  test("XSS: user message body is escaped", () => {
    const xssMsg: ChatMessage = {
      ...USER_MSG,
      body: '<script>alert("xss")</script>',
    };
    const html = renderChatThreadPage("agent-xyz", THREAD, [xssMsg], "alice");
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders [upload:/path/file] marker as artifact badge with filename", () => {
    const msgWithUpload: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "Here is the report [upload:/tmp/report.pdf]",
    };
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [msgWithUpload],
      "alice",
    );
    // [upload:...] should be stripped from body text
    expect(html).not.toContain("[upload:");
    // Filename "report.pdf" should appear (not the full path)
    expect(html).toContain("report.pdf");
    // Should show as a badge (check for artifact/attachment styling)
    expect(html).toContain("📎");
  });

  test("renders [plan:url] marker as clickable link", () => {
    const msgWithPlan: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "See the plan [plan:https://example.com/plan]",
    };
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [msgWithPlan],
      "alice",
    );
    // [plan:...] should be stripped from body text
    expect(html).not.toContain("[plan:");
    // Should render as a link
    expect(html).toContain("href=");
    expect(html).toContain("https://example.com/plan");
    // Should show link text
    expect(html).toContain("View plan");
  });

  test("strips [silent] marker from displayed text", () => {
    const msgWithSilent: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "All done [silent]",
    };
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [msgWithSilent],
      "alice",
    );
    expect(html).not.toContain("[silent]");
    expect(html).toContain("All done");
  });

  test("strips [react:emoji] marker from displayed text", () => {
    const msgWithReact: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "Great work [react:thumbsup]",
    };
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [msgWithReact],
      "alice",
    );
    expect(html).not.toContain("[react:");
    expect(html).not.toContain("thumbsup");
    expect(html).toContain("Great work");
  });

  test("strips [speak:text] marker from displayed text", () => {
    const msgWithSpeak: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "Done with the task [speak:all work complete]",
    };
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [msgWithSpeak],
      "alice",
    );
    expect(html).not.toContain("[speak:");
    expect(html).not.toContain("all work complete");
    expect(html).toContain("Done with the task");
  });

  test("HTML-escapes marker content (XSS protection on paths/URLs)", () => {
    const msgWithXss: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "File saved [upload:/tmp/file<script>.pdf]",
    };
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [msgWithXss],
      "alice",
    );
    // The raw XSS payload must not appear verbatim
    expect(html).not.toContain("file<script>.pdf");
    // Should still show the filename (escaped)
    expect(html).toContain("&lt;script&gt;");
  });

  test("handles multiple markers in one message", () => {
    const msgWithMultiple: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "Report: [upload:/tmp/report.pdf] Plan: [plan:https://example.com/plan] [react:eyes] [silent]",
    };
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [msgWithMultiple],
      "alice",
    );
    // All markers should be stripped
    expect(html).not.toContain("[upload:");
    expect(html).not.toContain("[plan:");
    expect(html).not.toContain("[react:");
    expect(html).not.toContain("[silent]");
    // But content should be present
    expect(html).toContain("report.pdf");
    expect(html).toContain("https://example.com/plan");
    expect(html).toContain("Report:");
    expect(html).toContain("Plan:");
  });

  test("renders multiple uploads and plans from one message", () => {
    const msgWithMultipleMarkers: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "[upload:/a.pdf] [upload:/b.pdf] [plan:http://x] [plan:http://y]",
    };
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [msgWithMultipleMarkers],
      "alice",
    );
    // Should render both filenames
    expect(html).toContain("a.pdf");
    expect(html).toContain("b.pdf");
    // Should render both links
    expect(html).toContain("http://x");
    expect(html).toContain("http://y");
  });

  test("responsive: page includes a @media CSS rule for mobile", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("@media");
  });

  test("responsive: thread sidebar has chat-thread-sidebar class", () => {
    const THREADS_LIST: ChatThread[] = [
      {
        id: "thread-other",
        agentId: "agent-xyz",
        title: "Other Thread",
        memberId: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ];
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [USER_MSG],
      THREADS_LIST,
      "alice",
    );
    expect(html).toContain("chat-thread-sidebar");
  });
});

// ─── renderChatThreadPage — inline styles moved to classes (CFB-1.3) ────────
// Migrated elements must carry the new classes and no longer carry a `style=`
// attribute of their own (background/text styling on nested badges etc. is
// out of scope and untouched).

describe("renderChatThreadPage — CFB-1.3 class migration", () => {
  const THREAD: ChatThread = {
    id: "thread-abc",
    agentId: "agent-xyz",
    title: "My Test Thread",
    memberId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  const USER_MSG: ChatMessage = {
    id: "msg-1",
    threadId: "thread-abc",
    role: "user",
    body: "Hello, agent!",
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  const SYSTEM_MSG: ChatMessage = {
    id: "msg-sys",
    threadId: "thread-abc",
    role: "system",
    body: "System notice",
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  test("page wrapper (.vos-page) carries no inline style attribute", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    const match = html.match(/<div class="vos-page[^"]*"[^>]*>/);
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("style=");
    expect(match?.[0]).toContain("chat-thread-page");
  });

  test("header (.page-header) carries no inline style attribute", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    const match = html.match(/<div class="page-header[^"]*"[^>]*>/);
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("style=");
  });

  test("messages container carries no inline style attribute", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    const match = html.match(/<div id="messages-container"[^>]*>/);
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("style=");
  });

  test("bubble wrapper carries chat-bubble + chat-bubble--user classes, no inline style", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    const match = html.match(
      /<div class="chat-bubble chat-bubble--user"[^>]*>/,
    );
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("style=");
  });

  test("bubble wrapper for assistant role carries chat-bubble--assistant class", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [{ ...USER_MSG, id: "msg-a", role: "assistant" }],
      "alice",
    );
    const match = html.match(
      /<div class="chat-bubble chat-bubble--assistant"[^>]*>/,
    );
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("style=");
  });

  test("bubble wrapper for system role carries chat-bubble--system class", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [SYSTEM_MSG],
      "alice",
    );
    const match = html.match(
      /<div class="chat-bubble chat-bubble--system"[^>]*>/,
    );
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("style=");
  });

  test("bubble inner carries chat-bubble-inner class and no inline max-width", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    const match = html.match(/<div class="chat-bubble-inner[^"]*"[^>]*>/);
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("max-width");
  });

  test("no inline max-width appears in any server-rendered bubble wrapper/inner", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [USER_MSG, SYSTEM_MSG],
      "alice",
    );
    const bubbleMatches = html.match(/<div class="chat-bubble[^>]*>/g) ?? [];
    expect(bubbleMatches.length).toBeGreaterThan(0);
    for (const bubbleTag of bubbleMatches) {
      expect(bubbleTag).not.toContain("max-width");
    }
  });

  test("composer form and row carry no inline style attribute", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    const formMatch = html.match(/<form id="send-form"[^>]*>/);
    expect(formMatch).not.toBeNull();
    expect(formMatch?.[0]).not.toContain("style=");
  });

  test("message input carries no inline style attribute", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    const match = html.match(/<textarea[^>]*id="message-input"[^>]*>/);
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("style=");
  });

  test("attach and send buttons carry no inline style attribute", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    const attachMatch = html.match(/<button[^>]*id="attach-btn"[^>]*>/);
    const sendMatch = html.match(/<button[^>]*id="send-btn"[^>]*>/);
    expect(attachMatch).not.toBeNull();
    expect(sendMatch).not.toBeNull();
    expect(attachMatch?.[0]).not.toContain("style=");
    expect(sendMatch?.[0]).not.toContain("style=");
  });

  test("chatThreadStyles is included in extraStyles and defines chat-bubble rules", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain(".chat-bubble--user");
    expect(html).toContain(".chat-bubble--assistant");
    expect(html).toContain("justify-content:flex-end");
    expect(html).toContain("justify-content:flex-start");
  });

  test("inline JS optimistic user bubble uses the same chat-bubble class constants as the server renderer", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    // The class names baked into server-rendered HTML must also appear inside
    // the inline <script> block, proving both come from the same source.
    expect(html).toContain(
      "bubble.className = 'chat-bubble chat-bubble--user';",
    );
    expect(html).toContain('class="chat-bubble-inner"');
    expect(html).not.toContain("bubble.style.cssText");
  });
});

// ─── VM-3.1 — mic-record button + SSR audio-player rendering ────────────────

describe("renderChatThreadPage — mic input + audio playback (VM-3.1)", () => {
  const THREAD: ChatThread = {
    id: "thread-vm31",
    agentId: "agent-vm31",
    title: "Voice Thread",
    memberId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  const USER_MSG: ChatMessage = {
    id: "msg-1",
    threadId: "thread-vm31",
    role: "user",
    body: "Hello, agent!",
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  test("renders a mic-record button beside the hidden file input", () => {
    const html = renderChatThreadPage(
      "agent-vm31",
      THREAD,
      [USER_MSG],
      "alice",
    );
    expect(html).toContain('id="mic-btn"');
    const fileInputIdx = html.indexOf('id="file-input"');
    const micBtnIdx = html.indexOf('id="mic-btn"');
    const sendFormEndIdx = html.indexOf('id="send-form"');
    expect(fileInputIdx).toBeGreaterThan(-1);
    expect(micBtnIdx).toBeGreaterThan(fileInputIdx);
    expect(sendFormEndIdx).toBeGreaterThan(-1);
  });

  test("mic handler offers audio/mp4, uses .m4a, and normalizes non-audio types (VMF-1.1)", () => {
    const html = renderChatThreadPage(
      "agent-vm31",
      THREAD,
      [USER_MSG],
      "alice",
    );
    expect(html).toContain("'audio/mp4'");
    expect(html).toContain("'m4a'");
    expect(html).toContain("rawType.replace(");
  });

  test("inline script references MediaRecorder / getUserMedia for the mic flow", () => {
    const html = renderChatThreadPage(
      "agent-vm31",
      THREAD,
      [USER_MSG],
      "alice",
    );
    expect(html).toContain("MediaRecorder");
    expect(html).toContain("getUserMedia");
  });

  test("SSR-rendered bubble for a user message with an audio attachment uses the attachment-proxy URL for this agent/thread", () => {
    const html = renderChatThreadPage(
      "agent-vm31",
      THREAD,
      [{ ...USER_MSG, attachmentFilename: "recording-123.webm" }],
      "alice",
    );
    expect(html).toContain("<audio");
    expect(html).toContain(
      "/admin/chat/agent-vm31/threads/thread-vm31/messages/msg-1/attachment",
    );
  });

  test("SSR-rendered bubble for a non-audio attachment still uses the filename badge", () => {
    const html = renderChatThreadPage(
      "agent-vm31",
      THREAD,
      [{ ...USER_MSG, attachmentFilename: "report.pdf" }],
      "alice",
    );
    // The page's own inline <script> legitimately contains the literal
    // "<audio" (the mic-recording preview markup) regardless of this
    // message's attachment — so assert on the rendered message bubble
    // specifically, not page-wide absence.
    const bubbleMatch = html.match(
      /<div class="chat-bubble[^>]*data-message-id="msg-1"[\s\S]*?<\/div>\s*<\/div>/,
    );
    expect(bubbleMatch).not.toBeNull();
    expect(bubbleMatch?.[0]).toContain("📎 report.pdf");
    expect(bubbleMatch?.[0]).not.toContain("<audio");
  });
});

// ─── CFB-2.3 — live progress, elapsed timer, stall state ─────────────────────

describe("renderChatMessageBubble (hoisted module-level renderer)", () => {
  const BASE_MSG: ChatMessage = {
    id: "msg-cfb23-1",
    threadId: "thread-abc",
    role: "assistant",
    body: "Here is **bold** and `code`.",
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: null,
    repliedAt: "2024-01-01T00:00:05.000Z",
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  test("renders a data-message-id attribute for id-based dedupe", () => {
    const html = renderChatMessageBubble(BASE_MSG);
    expect(html).toContain('data-message-id="msg-cfb23-1"');
  });

  test("assistant markdown is rendered (bold → <strong>, code → <code>)", () => {
    const html = renderChatMessageBubble(BASE_MSG);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  test("user body is escaped, not markdown-rendered", () => {
    const html = renderChatMessageBubble({
      ...BASE_MSG,
      role: "user",
      body: "<script>alert(1)</script> **not bold**",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    // user bodies are plain-text/pre-wrap — no markdown conversion
    expect(html).not.toContain("<strong>not bold</strong>");
  });

  test("errorKind uses the shared ERROR_KIND_LABELS mapping", () => {
    for (const [kind, label] of Object.entries(ERROR_KIND_LABELS)) {
      const html = renderChatMessageBubble({ ...BASE_MSG, errorKind: kind });
      expect(html).toContain(label);
    }
  });

  test("unknown errorKind falls back to the default label", () => {
    const html = renderChatMessageBubble({
      ...BASE_MSG,
      errorKind: "something-weird",
    });
    expect(html).toContain("Error");
  });
});

// ─── VM-3.1 — mic input + audio playback: audio-vs-badge rendering branch ────
// renderChatMessageBubble is the single hoisted renderer shared by BOTH the
// SSR thread-detail page (renderChatThreadPage) and the polled bubbleHtml
// path (messages.json, in admin-ui.ts) — see the module comment above this
// function. Testing it directly therefore covers both render paths at once;
// renderChatThreadPage is also exercised below to confirm the SSR call site
// actually threads agentId through.

describe("renderChatMessageBubble — audio attachment vs. filename badge (VM-3.1)", () => {
  const BASE_MSG: ChatMessage = {
    id: "msg-vm31-1",
    threadId: "thread-vm31",
    role: "user",
    body: "voice note",
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  test("a .webm attachment (mic recording) renders an inline <audio> player, not a badge", () => {
    const html = renderChatMessageBubble(
      { ...BASE_MSG, attachmentFilename: "recording-123.webm" },
      null,
      "agent-1",
    );
    expect(html).toContain("<audio");
    expect(html).toContain("controls");
    expect(html).not.toContain("📎");
  });

  test("a .ogg attachment renders an inline <audio> player", () => {
    const html = renderChatMessageBubble(
      { ...BASE_MSG, attachmentFilename: "recording-123.ogg" },
      null,
      "agent-1",
    );
    expect(html).toContain("<audio");
  });

  test("a .wav assistant-reply attachment (VM-2.1 TTS) renders an inline <audio> player", () => {
    const html = renderChatMessageBubble(
      {
        ...BASE_MSG,
        role: "assistant",
        attachmentFilename: "1700000000000-response.wav",
      },
      null,
      "agent-1",
    );
    expect(html).toContain("<audio");
    expect(html).not.toContain("📎");
  });

  test("the <audio> src points at the per-message attachment proxy route, using agentId + threadId + id", () => {
    const html = renderChatMessageBubble(
      { ...BASE_MSG, attachmentFilename: "recording-123.webm" },
      null,
      "agent-1",
    );
    expect(html).toContain(
      "/admin/chat/agent-1/threads/thread-vm31/messages/msg-vm31-1/attachment",
    );
  });

  test("a non-audio attachment (e.g. a PDF) still renders as the plain filename badge", () => {
    const html = renderChatMessageBubble(
      { ...BASE_MSG, attachmentFilename: "report.pdf" },
      null,
      "agent-1",
    );
    expect(html).toContain("📎 report.pdf");
    expect(html).not.toContain("<audio");
  });

  test("no attachment renders neither an audio player nor a badge", () => {
    const html = renderChatMessageBubble(BASE_MSG, null, "agent-1");
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("📎");
  });

  test("works without an agentId argument (back-compat with existing call sites/tests)", () => {
    expect(() => renderChatMessageBubble(BASE_MSG)).not.toThrow();
  });
});

describe("renderChatThreadPage — CFB-3.2 mobile drawer", () => {
  const THREAD: ChatThread = {
    id: "thread-abc",
    agentId: "agent-xyz",
    title: "Drawer Thread",
    memberId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  const USER_MSG: ChatMessage = {
    id: "msg-1",
    threadId: "thread-abc",
    role: "user",
    body: "Hello",
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  const THREADS_LIST: ChatThread[] = [
    {
      id: "thread-other",
      agentId: "agent-xyz",
      title: "Other Thread",
      memberId: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
  ];

  // Criterion #2: DOM order is load-bearing — the ~ sibling combinator that
  // reveals the drawer off its :checked state requires the checkbox to appear
  // BEFORE the sidebar in source order.
  test("drawer checkbox appears before the sidebar in DOM order", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [USER_MSG],
      THREADS_LIST,
      "alice",
    );
    const checkboxIndex = html.indexOf('id="chat-drawer-toggle"');
    // Match the sidebar's rendered markup, not the class name in the <style>
    // block (which always appears earlier). The sidebar div carries both the
    // `card` and `chat-thread-sidebar` classes in the body.
    const sidebarIndex = html.indexOf('class="card chat-thread-sidebar"');
    expect(checkboxIndex).toBeGreaterThanOrEqual(0);
    expect(sidebarIndex).toBeGreaterThanOrEqual(0);
    expect(checkboxIndex).toBeLessThan(sidebarIndex);
  });

  test("renders a scrim label bound to the drawer toggle", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [USER_MSG],
      THREADS_LIST,
      "alice",
    );
    // The scrim is a <label> in the body bound to the toggle; assert on the
    // rendered element, not the class name that also appears in the <style>.
    expect(html).toContain('class="chat-drawer-scrim"');
    expect(html).toContain('for="chat-drawer-toggle"');
  });

  test("mobile media block no longer hides the sidebar with display:none", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [USER_MSG],
      THREADS_LIST,
      "alice",
    );
    expect(html).not.toContain(".chat-thread-sidebar { display:none }");
  });

  test("emits a standalone keyboard-inset script separate from the progress IIFE", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [USER_MSG],
      THREADS_LIST,
      "alice",
    );
    // The visualViewport listener sets a --kb-inset custom property and must
    // guard on visualViewport absence exactly as the brief specifies.
    expect(html).toContain("--kb-inset");
    expect(html).toContain("window.visualViewport");
  });

  test("composer applies sticky positioning and safe-area padding", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [USER_MSG],
      THREADS_LIST,
      "alice",
    );
    expect(html).toContain("position:sticky");
    expect(html).toContain("env(safe-area-inset-bottom)");
  });

  test("bubble inner wraps long words and code fences scroll horizontally", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [USER_MSG],
      THREADS_LIST,
      "alice",
    );
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("overflow-x:auto");
  });

  // Degraded/no-threads mode: sidebar ternary yields "" — the drawer chrome
  // (checkbox/scrim/hamburger) must not render orphaned without a sidebar.
  test("omits drawer chrome when there is no thread list", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    // The drawer input/scrim/hamburger elements must not render without a
    // sidebar (the class names still appear in the always-emitted <style>).
    expect(html).not.toContain('id="chat-drawer-toggle"');
    expect(html).not.toContain('class="chat-drawer-scrim"');
    expect(html).not.toContain('class="chat-drawer-hamburger"');
  });
});

describe("renderChatThreadPage — CFB-2.3 live progress inline JS + status bubble", () => {
  const THREAD: ChatThread = {
    id: "thread-abc",
    agentId: "agent-xyz",
    title: "Live Progress Thread",
    memberId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  const PENDING_USER_MSG: ChatMessage = {
    id: "msg-pending-1",
    threadId: "thread-abc",
    role: "user",
    body: "do a thing",
    createdAt: "2024-01-01T00:00:00.000Z",
    claimedBy: "agent-xyz",
    claimedAt: "2024-01-01T00:00:01.000Z",
    heartbeatAt: "2024-01-01T00:00:02.000Z",
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
    progressPhase: "reading",
    progressSeq: 3,
    cancelRequestedAt: null,
  };

  const REPLIED_MSG: ChatMessage = {
    ...PENDING_USER_MSG,
    id: "msg-replied-1",
    repliedAt: "2024-01-01T00:00:10.000Z",
  };

  test("simpleMarkdown is deleted from the inline JS", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [REPLIED_MSG], "u");
    expect(html).not.toContain("simpleMarkdown");
  });

  test("inline JS contains a 1s ticker (setInterval(..., 1000)) for the elapsed timer", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [REPLIED_MSG], "u");
    expect(html).toContain("setInterval(tick, 1000)");
  });

  test("inline JS uses an id-based renderedIds dedupe set", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [REPLIED_MSG], "u");
    expect(html).toContain("renderedIds");
    expect(html).toContain("data-message-id");
  });

  test("inline JS seeds renderedIds from the upload response", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [REPLIED_MSG], "u");
    // The success branch of the fetch handler should parse JSON and seed renderedIds
    // from data.message.id to prevent duplicate rendering.
    expect(html).toContain("renderedIds[data.message.id]");
  });

  test("inline JS renders every new server message, not just the last", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [REPLIED_MSG], "u");
    // renderServerBubble is called in a loop over all msgs (the old code took
    // replies[replies.length - 1]).
    expect(html).toContain("renderServerBubble");
    expect(html).not.toContain("replies[replies.length - 1]");
  });

  test("inline JS serializes ERROR_KIND_LABELS from the shared source", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [REPLIED_MSG], "u");
    expect(html).toContain("var ERROR_KIND_LABELS =");
    expect(html).toContain(JSON.stringify(ERROR_KIND_LABELS));
  });

  test("STALL_WARN_AFTER_MS defaults to 120000 and ABSOLUTE_MAX_MS to 3900000", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [REPLIED_MSG], "u");
    expect(html).toContain("var STALL_WARN_AFTER_MS = 120000");
    expect(html).toContain("var ABSOLUTE_MAX_MS = 3900000");
  });

  test("stallWarnAfterMs override is threaded into the inline JS", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [REPLIED_MSG],
      null,
      "u",
      null,
      { stallWarnAfterMs: 500 },
    );
    expect(html).toContain("var STALL_WARN_AFTER_MS = 500");
  });

  test("server-renders the live status bubble when the last user message is unreplied", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [PENDING_USER_MSG],
      "u",
    );
    expect(html).toContain('id="live-status-bubble"');
    // milestone from the progressPhase label + elapsed seed
    expect(html).toContain("Reading files");
    expect(html).toContain('id="live-status-elapsed"');
    // data-created-at drives the zero-network ticker
    expect(html).toContain("data-created-at=");
    expect(html).toContain("data-progress-seq=");
  });

  test("no live status bubble when the last message is already replied", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [REPLIED_MSG], "u");
    expect(html).not.toContain('id="live-status-bubble"');
  });

  test("pending message with null progressPhase renders elapsed but no milestone text", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [{ ...PENDING_USER_MSG, progressPhase: null }],
      "u",
    );
    expect(html).toContain('id="live-status-bubble"');
    expect(html).toContain('id="live-status-elapsed"');
    // milestone span present but empty
    expect(html).toContain('id="live-status-milestone"></span>');
  });

  test("stall CSS honors prefers-reduced-motion", () => {
    const html = renderChatThreadPage(
      "agent-xyz",
      THREAD,
      [PENDING_USER_MSG],
      "u",
    );
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).toContain("chat-stall-indicator");
  });
});

// ─── Drawer/scrim z-index vs sticky toolbar (DNZ-1.1) ─────────────────────────
//
// Drawers and their scrims must render above the sticky toolbar (z-index: 100)
// so they're never obscured by the sticky top nav. Each drawer's scrim should
// render below the drawer itself (z-index: scrim < drawer), but both must be
// above the toolbar (z-index > 100). Toolbar z-index is 100 per lib/web/toolbar.ts.

describe("drawer z-index above sticky toolbar (DNZ-1.1)", () => {
  const TOOLBAR_ZINDEX = 100;

  const THREAD: ChatThread = {
    id: "thread-dnz-1",
    agentId: "agent-xyz",
    title: "DNZ-1 Thread",
    memberId: null,
    createdAt: "2026-06-01T09:00:00Z",
    updatedAt: "2026-06-01T09:00:00Z",
  };

  const MSG: ChatMessage = {
    id: "msg-dnz-1",
    threadId: "thread-dnz-1",
    role: "user",
    body: "test",
    createdAt: "2026-06-01T09:00:00Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    errorKind: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  test("chat thread sidebar and scrim z-indexes are above toolbar (> 100) with scrim < sidebar", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [MSG], USER_NAME);

    const sidebarMatch = html.match(
      /\.chat-thread-sidebar\s*\{[^}]*z-index:(\d+)/,
    );
    const scrimMatch = html.match(/\.chat-drawer-scrim\s*\{[^}]*z-index:(\d+)/);

    expect(sidebarMatch).not.toBeNull();
    expect(scrimMatch).not.toBeNull();

    const sidebarZIndex = sidebarMatch
      ? Number.parseInt(sidebarMatch[1], 10)
      : 0;
    const scrimZIndex = scrimMatch ? Number.parseInt(scrimMatch[1], 10) : 0;

    expect(sidebarZIndex).toBeGreaterThan(TOOLBAR_ZINDEX);
    expect(scrimZIndex).toBeGreaterThan(TOOLBAR_ZINDEX);
    expect(scrimZIndex).toBeLessThan(sidebarZIndex);
  });
});

// ─── All page renderers — shared head via renderAdminPage (CFB-1.2) ─────────
//
// Every render*Page-style function in this file builds its <!DOCTYPE html>
// head via the shared admin-ui-layout.ts#renderAdminPage() helper. This loop
// calls each of the platform render sites (renderChatThreadPage has two
// distinct DOCTYPE blocks: its degraded early-return and its main return;
// the coding pages' sites are covered in coding/admin-ui-work-item-pages.unit.test.ts)
// with minimal valid fixtures and asserts each output has exactly one
// DOCTYPE and exactly one viewport meta tag, guarding against any call site
// drifting back to a hand-rolled head or double-wrapping.

describe("all page renderers — single DOCTYPE and viewport meta (CFB-1.2)", () => {
  const MINIMAL_THREAD: ChatThread = {
    id: "thread-loop-1",
    agentId: "agent-123",
    title: "Loop thread",
    memberId: null,
    createdAt: "2026-06-01T09:00:00Z",
    updatedAt: "2026-06-01T09:00:00Z",
  };

  const MINIMAL_MSG: ChatMessage = {
    id: "msg-loop-1",
    threadId: "thread-loop-1",
    role: "user",
    body: "hello",
    createdAt: "2026-06-01T09:00:00Z",
    claimedBy: null,
    repliedAt: null,
    tokens: null,
    costUsd: null,
    attachmentFilename: null,
    attachmentSize: null,
  };

  const renderers: Array<[string, () => string]> = [
    ["renderLoginPage", () => renderLoginPage()],
    ["renderAgentsPage", () => renderAgentsPage([], USER_NAME, true, "UTC")],
    [
      "renderNewLocalAgentPage",
      () =>
        renderNewLocalAgentPage(USER_NAME, [
          { name: "coding", displayName: "Coding Agent" },
        ]),
    ],
    [
      "renderAgentDetailPage",
      () =>
        renderAgentDetailPage(AGENT, {}, [], [], [], [], [], USER_NAME, true, {
          timezone: "UTC",
        }),
    ],
    [
      "renderGithubAppManifestRedirectPage",
      () =>
        renderGithubAppManifestRedirectPage(USER_NAME, {
          githubOrg: "acme",
          manifest: { name: "shipwright" },
        }),
    ],
    [
      "renderGithubAppInstallPage",
      () =>
        renderGithubAppInstallPage(USER_NAME, {
          installUrl: "https://github.com/apps/shipwright/installations/new",
        }),
    ],
    [
      "renderGithubAppInstalledPage",
      () => renderGithubAppInstalledPage(USER_NAME, { success: true }),
    ],
    [
      "renderProvisionXappTokenPage",
      () => renderProvisionXappTokenPage(USER_NAME, { agentId: "agent-123" }),
    ],
    [
      "renderProvisionCompletePage",
      () => renderProvisionCompletePage(USER_NAME, { success: true }),
    ],
    ["renderChatPage", () => renderChatPage([], undefined, null, USER_NAME)],
    [
      "renderChatThreadPage (degraded — thread/messages null)",
      () => renderChatThreadPage("agent-123", null, null, USER_NAME),
    ],
    [
      "renderChatThreadPage (main)",
      () =>
        renderChatThreadPage(
          "agent-123",
          MINIMAL_THREAD,
          [MINIMAL_MSG],
          USER_NAME,
        ),
    ],
  ];

  test("all 12 render sites are covered by this loop", () => {
    expect(renderers.length).toBe(12);
  });

  for (const [name, render] of renderers) {
    test(`${name}: exactly one DOCTYPE and one viewport meta tag`, () => {
      const html = render();
      const doctypeMatches = html.match(/<!DOCTYPE html>/g) ?? [];
      const viewportMatches = html.match(/<meta name="viewport"/g) ?? [];
      expect(doctypeMatches.length).toBe(1);
      expect(viewportMatches.length).toBe(1);
      expect(html).toContain(
        'content="width=device-width, initial-scale=1, viewport-fit=cover"',
      );
    });
  }
});

describe("renderAddAnotherOrgAction", () => {
  test("links to the add-org route when GH_APP_SLUG is set", () => {
    const out = renderAddAnotherOrgAction("a1", {
      GH_APP_ID: "1",
      GH_APP_SLUG: "my-app",
    });
    expect(out).toContain("/admin/agents/a1/connect-github/add-org");
    expect(out).toContain("Add another org");
  });

  test("points at the docs when GH_APP_SLUG is absent", () => {
    const out = renderAddAnotherOrgAction("a1", { GH_APP_ID: "1" });
    expect(out).not.toContain("connect-github/add-org");
    expect(out).toContain("configuration-agent.md");
  });

  test("renders nothing without a GitHub App", () => {
    expect(renderAddAnotherOrgAction("a1", {})).toBe("");
  });
});

describe("renderChatThreadPage — poll auto-scroll (CSR-1.1)", () => {
  const THREAD: ChatThread = {
    id: "thread-abc",
    agentId: "agent-xyz",
    title: "T",
    memberId: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };

  // Runs the page's inline script against an injected stub DOM/fetch (no
  // global overrides) and returns the messages container plus the first poll.
  function boot(scrollTop: number) {
    const html = renderChatThreadPage("agent-xyz", THREAD, [], "alice");
    const script = html.match(
      /<script>\n\(function\(\) \{[\s\S]*?\n<\/script>/,
    );
    if (!script) throw new Error("inline chat script not found");
    const code = script[0].replace(/^<script>/, "").replace(/<\/script>$/, "");

    const makeEl = (): Record<string, unknown> => ({
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      setAttribute() {},
      getAttribute: () => null,
      appendChild() {},
      insertBefore() {},
      querySelectorAll: () => [],
      querySelector: () => null,
    });
    const container = {
      ...makeEl(),
      scrollTop,
      scrollHeight: 1000,
      clientHeight: 400,
    };
    const document = {
      getElementById: (id: string) =>
        id === "messages-container"
          ? container
          : id === "live-status-bubble"
            ? null
            : makeEl(),
      createElement: makeEl,
      querySelectorAll: () => [],
    };
    const fetchStub = () =>
      Promise.resolve({ json: () => Promise.resolve({ messages: [] }) });
    const timers: Array<() => void> = [];
    new Function(
      "document",
      "fetch",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "window",
      code,
    )(
      document,
      fetchStub,
      (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      () => {},
      () => 0,
      () => {},
      { addEventListener() {} },
    );
    return { container, timers };
  }

  test("user scrolled up -> poll leaves scrollTop unchanged", async () => {
    const { container, timers } = boot(100);
    container.scrollTop = 100; // user scrolled up (900 - 100 gap > 80px)
    timers[timers.length - 1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.scrollTop).toBe(100);
  });

  test("near bottom -> poll scrolls to bottom", async () => {
    const { container, timers } = boot(0);
    container.scrollTop = 560; // 1000 - 560 - 400 = 40px from bottom
    timers[timers.length - 1]();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.scrollTop).toBe(1000);
  });

  test("initial page load still scrolls to the bottom unconditionally", () => {
    const { container } = boot(0);
    expect(container.scrollTop).toBe(1000);
  });
});

describe("renderAgentDetailPage — canManage gating (SSP-4.3)", () => {
  const render = (
    isAdmin: boolean,
    opts?: Parameters<typeof renderAgentDetailPage>[9],
  ) =>
    renderAgentDetailPage(
      AGENT,
      { env: {}, secretKeys: [] },
      [],
      [],
      [],
      [],
      [],
      "user@example.com",
      isAdmin,
      opts,
    );

  test("non-admin without canManage: no Danger Zone / Slack access / Members cards", () => {
    const html = render(false);
    expect(html).not.toContain("Danger Zone");
    expect(html).not.toContain('<div class="card-title">Slack access</div>');
    expect(html).not.toContain("/members");
  });

  test("non-admin with canManage: all three cards render", () => {
    const html = render(false, { canManage: true });
    expect(html).toContain("Danger Zone");
    expect(html).toContain('<div class="card-title">Slack access</div>');
    expect(html).toContain(`/admin/agents/${AGENT.id}/members`);
  });

  test("admin defaults to canManage", () => {
    expect(render(true)).toContain("Danger Zone");
  });
});

describe("renderNewLocalAgentPage — self-serve account user (SSP-4.2)", () => {
  const CODING_TYPE = { name: "coding", displayName: "Coding Agent" };
  const selfServe = { remaining: 2, max: 3, contactEmail: "help@example.com" };

  test("shows remaining quota and the credential prerequisites", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      selfServe,
    });
    expect(html).toContain("2 of 3");
    expect(html).toContain("Slack App Configuration Token");
    expect(html).toContain("GitHub");
    expect(html).toContain("Claude API key");
  });

  test("forces the coding type via a hidden input instead of a type select", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      selfServe,
    });
    expect(html).toContain('<input type="hidden" name="type" value="coding"');
    expect(html).not.toMatch(/<select[^>]*name="type"/);
  });

  test("at zero remaining, explains the limit and points at the contact email", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE], {
      selfServe: { ...selfServe, remaining: 0 },
    });
    expect(html).toContain("agent limit");
    expect(html).toContain("help@example.com");
  });

  test("admin form (no selfServe opt) is unchanged", () => {
    const html = renderNewLocalAgentPage(USER_NAME, [CODING_TYPE]);
    expect(html).not.toContain("Agent quota");
    expect(html).toMatch(/<select[^>]*name="type"/);
  });
});

describe("renderAgentsPage zero-quota notice (SSP-3.2)", () => {
  test("replaces the create CTA with the notice and a disabled button", () => {
    const html = renderAgentsPage([], "u@x.com", true, "UTC", {
      zeroQuotaNotice: renderZeroQuotaNotice("dan@app-vitals.com"),
    });
    expect(html).toContain("Email dan@app-vitals.com to request a trial");
    expect(html).toContain("disabled");
    expect(html).not.toContain(
      '<a href="/admin/agents/new" class="btn btn-primary">',
    );
  });
});

describe("renderNewLocalAgentPage — Anthropic federation (WIF-2.1)", () => {
  const types = [{ name: "coding", displayName: "Coding Agent" }];

  test("shows the Claude credential fields by default", () => {
    const html = renderNewLocalAgentPage(USER_NAME, types);
    expect(html).toContain('name="claudeCodeOauthToken"');
    expect(html).toContain('name="anthropicApiKey"');
  });

  test("omits the Claude credential fields when federation is enabled", () => {
    const html = renderNewLocalAgentPage(USER_NAME, types, {
      anthropicFederationEnabled: true,
    });
    expect(html).not.toContain('name="claudeCodeOauthToken"');
    expect(html).not.toContain('name="anthropicApiKey"');
  });
});

// ─── renderAgentDetailPage — extension card slots (AEP-2.1) ──────────────────

describe("renderAgentDetailPage — extension card slots", () => {
  const render = (extensionCardsHtml?: string[]) =>
    renderAgentDetailPage(AGENT, {}, [], [], [], [], [], USER_NAME, true, {
      timezone: "UTC",
      now: new Date("2025-01-15T00:00:00Z"),
      ...(extensionCardsHtml ? { extensionCardsHtml } : {}),
    });

  test("no or empty extension cards renders the page byte-identically", () => {
    expect(render([])).toBe(render());
  });

  test("extension cards render in order", () => {
    const html = render([
      '<div class="card">ext-one</div>',
      '<div class="card">ext-two</div>',
    ]);
    expect(html).toContain("ext-one");
    expect(html.indexOf("ext-one")).toBeLessThan(html.indexOf("ext-two"));
  });
});
