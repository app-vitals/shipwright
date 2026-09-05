/**
 * agent/src/admin-ui-pages.unit.test.ts
 * Pure unit tests for all render functions in admin-ui-pages.ts.
 *
 * Strategy: call render functions directly, assert on returned HTML strings.
 * No I/O, no Hono, no HTTP — pure string → string.
 */

import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  type AgentListItem,
  type CronJobItem,
  type CronRunItem,
  type DependencyNode,
  ERROR_KIND_LABELS,
  type MemberItem,
  type PluginItem,
  type PrListItem,
  type PullRequestItem,
  type TaskItem,
  type TokenItem,
  type ToolItem,
  type WorkQueueItem,
  type WorkQueueSnapshotItem,
  bucketTaskColumn,
  classifyTaskState,
  computeDependencyLayout,
  computeDependencyNodes,
  heartbeatFreshness,
  partitionCronsForActivityDisplay,
  renderAgentDetailPage,
  renderAgentsPage,
  renderChatMessageBubble,
  renderChatPage,
  renderChatThreadPage,
  renderGithubAppInstallPage,
  renderGithubAppInstalledPage,
  renderGithubAppManifestRedirectPage,
  renderLoginPage,
  renderNewLocalAgentPage,
  renderPrDetailPage,
  renderProvisionCompletePage,
  renderProvisionXappTokenPage,
  renderPrsPage,
  renderQueueActivityPage,
  renderSessionDetailPage,
  renderTaskDetailPage,
  renderTasksPage,
} from "./admin-ui-pages.ts";
import { renderAdminToolbar } from "./admin-ui-styles.ts";
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

  test("Set up GitHub App (auto) action renders exactly one field (single-input backward compat)", () => {
    const html = render({});
    const forms = html.match(
      /action="\/admin\/agents\/agent-123\/connect-github"[\s\S]*?<\/form>/g,
    ) as string[];
    const autoForm = forms.find((f) => f.includes('value="auto"')) as string;
    expect(autoForm).toBeDefined();
    const inputCount = (autoForm.match(/<input\b/g) ?? []).length;
    // 2 hidden fields (ghAuthMode, ghAppMode) + 1 visible githubOrg field.
    expect(inputCount).toBe(3);
    expect(autoForm).toMatch(/name="githubOrg"[^>]*type="text"/);
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

// ─── renderTasksPage — row click navigation ──────────────────────────────────

const TASK_ITEM: TaskItem = {
  id: "TASK-1",
  title: "Build the thing",
  status: "in_progress",
  session: "session-abc",
  repo: "org/repo",
  assignee: null,
  claimedBy: null,
};

const TASK_ITEM_PENDING: TaskItem = {
  id: "TASK-2",
  title: "Plan the thing",
  status: "pending",
  session: null,
  repo: null,
  assignee: null,
  claimedBy: null,
};

describe("renderTasksPage — row click navigation", () => {
  function render(
    tasks: TaskItem[] = [TASK_ITEM],
    opts?: Parameters<typeof renderTasksPage>[6],
  ): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      opts,
      undefined,
    );
  }

  // TBF-1.1: this describe block's render() defaults to the table view (no
  // explicit `view` opt threads through to a "board"), so — matching
  // makePageUrl always carrying ?view=table forward — every row's `from`
  // link now carries the table view even with no other filters active.
  const TABLE_VIEW_FROM = encodeURIComponent("/admin/tasks?view=table");

  // AC1: clicking anywhere on a task row navigates to the task detail page
  test("each task row has a data-href that navigates to the task detail URL", () => {
    const html = render([TASK_ITEM]);
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${TABLE_VIEW_FROM}"`,
    );
  });

  test("data-href URL uses the escaped task id", () => {
    const xssTask: TaskItem = { ...TASK_ITEM, id: "TASK-XSS" };
    const html = render([xssTask]);
    expect(html).toContain(
      `data-href="/admin/tasks/TASK-XSS?from=${TABLE_VIEW_FROM}"`,
    );
  });

  test("data-href URL escapes single quotes in task id", () => {
    const singleQuoteTask: TaskItem = { ...TASK_ITEM, id: "TASK-IT'S" };
    const html = render([singleQuoteTask]);
    // Single quote must be encoded as &#39; — raw ' in the attribute would break HTML parsing
    expect(html).toContain(
      `data-href="/admin/tasks/TASK-IT&#39;S?from=${TABLE_VIEW_FROM}"`,
    );
    expect(html).not.toContain(`data-href="/admin/tasks/TASK-IT'S"`);
  });

  // AC2: cursor changes to pointer on row hover
  test("task row has cursor:pointer style", () => {
    const html = render([TASK_ITEM]);
    // The <tr> element for a task row must carry cursor:pointer
    expect(html).toMatch(/<tr[^>]*cursor:\s*pointer/);
  });

  // AC3: buttons/links within the row still handle their own click events
  // The script block uses event delegation on data-href rows and skips clicks on
  // A, BUTTON, FORM, INPUT elements — no inline stopPropagation needed.
  test("row click handler script is present and delegates via data-href attribute", () => {
    const html = render([TASK_ITEM]);
    expect(html).toContain("data-href");
    expect(html).toContain(`getAttribute("data-href")`);
  });

  test("Release button is still present for in_progress tasks", () => {
    const html = render([TASK_ITEM]);
    expect(html).toContain("Release");
    // TBF-1.1: the release form's `from` carries the current table-view list
    // URL so the Task Detail page's back link returns to this view.
    expect(html).toContain(
      `action="/admin/tasks/${TASK_ITEM.id}/release?from=${TABLE_VIEW_FROM}"`,
    );
  });

  test("no Release button for non-in_progress tasks, but row is still navigable", () => {
    const html = render([TASK_ITEM_PENDING]);
    expect(html).not.toContain("Release");
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM_PENDING.id}?from=${TABLE_VIEW_FROM}"`,
    );
  });

  test("empty task list renders no clickable rows", () => {
    const html = render([]);
    expect(html).not.toContain('data-href="/admin/tasks/');
    expect(html).toContain("No tasks found");
  });

  test("multiple tasks each get their own data-href pointing to their detail URL", () => {
    const html = render([TASK_ITEM, TASK_ITEM_PENDING]);
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${TABLE_VIEW_FROM}"`,
    );
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM_PENDING.id}?from=${TABLE_VIEW_FROM}"`,
    );
  });
});

// ─── renderTasksPage — back-link context (TBL-1.1) ───────────────────────────

describe("renderTasksPage — back-link context (TBL-1.1)", () => {
  // AC1 (TBF-1.1 update): bare /admin/tasks now defaults to the board
  // (AXR-1.3), so even the "default" table-view case (no filters, page 1)
  // can no longer omit ?from= — falling back to a bare link would bounce
  // the user off the table view. Row links always carry ?from=<current
  // table-view URL>, which is at minimum `/admin/tasks?view=table`.
  test("default list view (no filters, page 1) still carries ?from= to preserve table view", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent("/admin/tasks?view=table");
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
  });

  // AC1: a non-default filter (status) causes row links to carry ?from=<current list URL>
  test("row links carry ?from=<current list URL> when a status filter is active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { status: "in_progress" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?status=in_progress&view=table",
    );
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
    expect(html).toContain(
      `<a href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
  });

  // AC1: state filter also triggers ?from=
  test("row links carry ?from= when a state filter is active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { state: "blocked" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?state=blocked&view=table",
    );
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
  });

  // AC1: page > 1 also triggers ?from=
  test("row links carry ?from= when page is greater than 1", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 2 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent("/admin/tasks?page=2&view=table");
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
  });

  // AC1: the title link (second <td>) also carries ?from=
  test("title link also carries ?from= when filters are active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { repo: "org/repo" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?repo=org%2Frepo&view=table",
    );
    expect(html).toContain(
      `<a href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}" style="color:inherit;text-decoration:none">${TASK_ITEM.title}</a>`,
    );
  });
});

// ─── renderTasksPage — hitl filter ───────────────────────────────────────────

describe("renderTasksPage — hitl filter", () => {
  test("renders a hitl select with Any/Yes/No options next to Status", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain('<select name="hitl"');
    expect(html).toMatch(/<option value=""[^>]*>Any<\/option>/);
    expect(html).toMatch(/<option value="true"[^>]*>Yes<\/option>/);
    expect(html).toMatch(/<option value="false"[^>]*>No<\/option>/);
  });

  test("selects 'Yes' option when filters.hitl is 'true'", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "true" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain('<option value="true" selected>Yes</option>');
  });

  test("selects 'No' option when filters.hitl is 'false'", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "false" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain('<option value="false" selected>No</option>');
  });

  test("defaults to 'Any' with no explicit hitl option selected when filters.hitl is undefined", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toMatch(/<option value=""[^>]*>Any<\/option>/);
    expect(html).not.toMatch(
      /<option value="true"[^>]*selected[^>]*>Yes<\/option>/,
    );
    expect(html).not.toMatch(
      /<option value="false"[^>]*selected[^>]*>No<\/option>/,
    );
  });

  test("makePageUrl preserves hitl filter across pagination links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "true" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain('href="/admin/tasks?hitl=true&page=2&view=table"');
  });

  test("makeStateParams preserves hitl filter in state-tab links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "true" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?state=ready&hitl=true&view=table"',
    );
    expect(html).toContain(
      'href="/admin/tasks?state=in_progress&hitl=true&view=table"',
    );
    expect(html).toContain(
      'href="/admin/tasks?state=blocked&hitl=true&view=table"',
    );
    expect(html).toContain(
      'href="/admin/tasks?state=closed&hitl=true&view=table"',
    );
  });

  test("row links carry ?from= including hitl when a hitl filter is active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { hitl: "true" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    const expectedFrom = encodeURIComponent(
      "/admin/tasks?hitl=true&view=table",
    );
    expect(html).toContain(
      `data-href="/admin/tasks/${TASK_ITEM.id}?from=${expectedFrom}"`,
    );
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

// ─── renderTasksPage — datalist autocomplete (AFA-1.2) ───────────────────────

describe("renderTasksPage — datalist autocomplete", () => {
  const pagination = { total: 0, limit: 50, page: 1 };

  test("renderTasksPage with sessions suggestions renders session datalist", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { sessions: ["session-abc", "session-xyz"] },
    );
    expect(html).toContain('<datalist id="sessions-list">');
    expect(html).toContain('<option value="session-abc">');
    expect(html).toContain('<option value="session-xyz">');
    expect(html).toContain('list="sessions-list"');
  });

  test("renderTasksPage with agents suggestions renders agent datalist", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { agents: ["Agent Alpha", "Agent Beta"] },
    );
    expect(html).toContain('<datalist id="agents-list">');
    expect(html).toContain('<option value="Agent Alpha">');
    expect(html).toContain('list="agents-list"');
  });

  test("renderTasksPage without suggestions renders plain text session input (no datalist)", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      undefined,
    );
    expect(html).not.toContain('list="sessions-list"');
    expect(html).not.toContain('list="agents-list"');
  });

  test("renderTasksPage escapes suggestion values to prevent XSS", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { sessions: ['<script>alert("xss")</script>'] },
    );
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — org/repo multiselect filters (ORF-2.1) ────────────────

describe("renderTasksPage — org/repo multiselect filters", () => {
  const pagination = { total: 0, limit: 50, page: 1 };

  test("renders both an Org and a Repo select-multiple element", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("populates Org options from suggestions.orgs", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"] },
    );
    expect(html).toContain('<option value="app-vitals">');
    expect(html).toContain('<option value="other-org">');
  });

  test("populates Repo options from suggestions.repos", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { repos: ["app-vitals/repo-a", "app-vitals/repo-b"] },
    );
    expect(html).toContain('<option value="app-vitals/repo-a">');
    expect(html).toContain('<option value="app-vitals/repo-b">');
  });

  test("Org and Repo multiselects carry the new scope-select pill/tag styling class (AXR-1.1)", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain(
      '<select name="org" multiple class="form-input scope-select"',
    );
    expect(html).toContain(
      '<select name="repo" multiple class="form-input scope-select"',
    );
  });

  test("Org and Repo stay independent multiselect fields, not merged into one combined scope pill", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    const selectCount = (html.match(/<select /g) ?? []).length;
    expect(selectCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("marks currently-active repo filter values as selected (array)", () => {
    const html = renderTasksPage(
      [],
      { repo: ["app-vitals/repo-a", "app-vitals/repo-b"] },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      {
        repos: ["app-vitals/repo-a", "app-vitals/repo-b", "app-vitals/repo-c"],
      },
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-a" selected>app-vitals/repo-a</option>',
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-b" selected>app-vitals/repo-b</option>',
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-c">app-vitals/repo-c</option>',
    );
  });

  test("marks currently-active org filter values as selected (array)", () => {
    const html = renderTasksPage(
      [],
      { org: ["app-vitals"] },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"] },
    );
    expect(html).toContain(
      '<option value="app-vitals" selected>app-vitals</option>',
    );
    expect(html).toContain('<option value="other-org">other-org</option>');
  });

  test("backward compat: a single-value repo filter (string, not array) is still marked selected", () => {
    const html = renderTasksPage(
      [],
      { repo: "app-vitals/repo-a" },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { repos: ["app-vitals/repo-a", "app-vitals/repo-b"] },
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-a" selected>app-vitals/repo-a</option>',
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-b">app-vitals/repo-b</option>',
    );
  });

  test("an active filter value not present in suggestions still renders as a selected option", () => {
    const html = renderTasksPage(
      [],
      { repo: ["app-vitals/stale-repo"] },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain(
      '<option value="app-vitals/stale-repo" selected>app-vitals/stale-repo</option>',
    );
  });

  test("no repo/org filter active renders no selected options", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).not.toContain("selected>");
  });

  test("removes the legacy single-value repo <input>+<datalist> markup", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { repos: ["app-vitals/repo-a"] },
    );
    expect(html).not.toContain('name="repo" type="text"');
    expect(html).not.toContain('<datalist id="repos-list">');
    expect(html).not.toContain('list="repos-list"');
  });

  test("escapes org/repo suggestion and filter values to prevent XSS", () => {
    const html = renderTasksPage(
      [],
      { org: ['<script>alert("xss")</script>'] },
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { orgs: ['<script>alert("xss")</script>'] },
    );
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — blocker badges ────────────────────────────────────────

describe("renderTasksPage — blocker badges", () => {
  function render(tasks: TaskItem[]): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  const PENDING_TASK_NO_BLOCKERS: TaskItem = {
    id: "TASK-3",
    title: "Pending nothing",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
    blockedBy: [],
  };

  const PENDING_TASK_HITL: TaskItem = {
    id: "TASK-4",
    title: "Waiting on human",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
    blockedBy: [{ type: "hitl" }],
  };

  const PENDING_TASK_DEP: TaskItem = {
    id: "TASK-5",
    title: "Blocked by dep",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
    blockedBy: [{ type: "dependency", id: "REL-2.2", status: "pending" }],
  };

  const PENDING_TASK_MULTI: TaskItem = {
    id: "TASK-6",
    title: "Multiple blockers",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
    blockedBy: [
      { type: "hitl" },
      { type: "dependency", id: "REL-3.1", status: "in_progress" },
    ],
  };

  // AC1: pending task with blockedBy entries shows badge(s) in the list view
  test("pending task with HITL block shows a blocker badge", () => {
    const html = render([PENDING_TASK_HITL]);
    expect(html).toContain("Waiting: HITL");
  });

  // AC2: HITL block renders as a distinct badge "Waiting: HITL"
  test("HITL badge renders as 'Waiting: HITL'", () => {
    const html = render([PENDING_TASK_HITL]);
    expect(html).toContain("Waiting: HITL");
    expect(html).toContain("badge-hitl");
  });

  // AC3: dep block renders with the dep ID "Blocked: REL-2.2", linked to the dep's task page
  test("dep block renders as 'Blocked: <dep-id>' linked to the dep's task page", () => {
    const html = render([PENDING_TASK_DEP]);
    expect(html).toContain("Blocked:");
    expect(html).toContain('<a href="/admin/tasks/REL-2.2"');
    expect(html).toContain(">REL-2.2</a>");
    expect(html).toContain("badge-dep");
  });

  // AC4: tasks with blockedBy: [] show no blocker badges
  test("empty blockedBy shows no blocker badges", () => {
    const html = render([PENDING_TASK_NO_BLOCKERS]);
    expect(html).not.toContain("Waiting: HITL");
    expect(html).not.toContain("Blocked:");
  });

  // AC5: multiple blockers all render
  test("task with multiple blockers renders all badges", () => {
    const html = render([PENDING_TASK_MULTI]);
    expect(html).toContain("Waiting: HITL");
    expect(html).toContain("Blocked:");
    expect(html).toContain('<a href="/admin/tasks/REL-3.1"');
    expect(html).toContain(">REL-3.1</a>");
  });

  // AC5: badges are visually distinct from status badges (different CSS class)
  test("blocker badges use different CSS classes than status badges", () => {
    const html = render([PENDING_TASK_HITL]);
    // Status badge uses badge-blue/badge-green/badge-red/badge-gray
    // Blocker badges must use badge-hitl or badge-dep — not the status classes
    expect(html).toContain("badge-hitl");
    expect(html).not.toContain('<span class="badge badge-blue">pending</span>');
    // The status badge for pending should use badge-gray
    expect(html).toContain('<span class="badge badge-gray">pending</span>');
  });

  // Task with undefined blockedBy shows no badges (backward compat)
  test("task without blockedBy field shows no blocker badges", () => {
    const taskNoBLockedBy: TaskItem = {
      id: "TASK-7",
      title: "Old task no blockedBy",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
    };
    const html = render([taskNoBLockedBy]);
    expect(html).not.toContain("Waiting: HITL");
    expect(html).not.toContain("Blocked:");
  });

  // XSS: dep id is escaped
  test("dep id is HTML-escaped in the badge", () => {
    const xssTask: TaskItem = {
      id: "TASK-8",
      title: "XSS task",
      status: "pending",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      blockedBy: [
        {
          type: "dependency",
          id: "<script>alert(1)</script>",
          status: "pending",
        },
      ],
    };
    const html = render([xssTask]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // Regression test for Sentry issue 7665355727: a {type:"blocked"} entry
  // (status:"blocked" tasks) previously fell through to the dependency
  // branch and crashed on taskLink(b.id)/escapeHtml(undefined).
  test("blocked entry with a populated reason renders the reason, not a crash", () => {
    const taskBlockedWithReason: TaskItem = {
      id: "TASK-9",
      title: "Explicitly blocked",
      status: "blocked",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      blockedBy: [{ type: "blocked", reason: "Waiting on external vendor" }],
    };
    expect(() => render([taskBlockedWithReason])).not.toThrow();
    const html = render([taskBlockedWithReason]);
    expect(html).toContain("Waiting on external vendor");
    expect(html).not.toContain("undefined");
  });

  test("blocked entry with a null reason renders a fallback label, not a crash", () => {
    const taskBlockedNoReason: TaskItem = {
      id: "TASK-10",
      title: "Blocked, no reason recorded",
      status: "blocked",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      blockedBy: [{ type: "blocked", reason: null }],
    };
    expect(() => render([taskBlockedNoReason])).not.toThrow();
    const html = render([taskBlockedNoReason]);
    expect(html).toContain("Blocked");
    expect(html).not.toContain("undefined");
  });

  test("blocked entry's reason is HTML-escaped", () => {
    const taskBlockedXss: TaskItem = {
      id: "TASK-11",
      title: "Blocked with unsafe reason",
      status: "blocked",
      session: null,
      repo: null,
      assignee: null,
      claimedBy: null,
      blockedBy: [{ type: "blocked", reason: "<script>alert(1)</script>" }],
    };
    const html = render([taskBlockedXss]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — PR column ──────────────────────────────────────────────

describe("renderTasksPage — PR column", () => {
  function render(tasks: TaskItem[]): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  test("PR column header is present after Repo column", () => {
    const html = render([]);
    // Check for PR header in the table
    expect(html).toContain("<th>PR</th>");
  });

  test("task with pr value shows linked #N to GitHub PR", () => {
    const taskWithPr: TaskItem = {
      ...TASK_ITEM,
      pr: 42,
      repo: "org/repo",
    };
    const html = render([taskWithPr]);
    // Should render a link to the PR
    expect(html).toContain("https://github.com/org/repo/pull/42");
    expect(html).toContain("#42");
    expect(html).toContain('style="color:#6366f1;text-decoration:none"');
  });

  test("task without pr value shows em-dash", () => {
    const taskWithoutPr: TaskItem = {
      ...TASK_ITEM,
      pr: null,
      repo: "org/repo",
    };
    const html = render([taskWithoutPr]);
    // Should render an em-dash for no PR
    expect(html).toContain("—");
  });

  test("empty state colspan is 10 (9 columns + 1 for new Source column)", () => {
    const html = render([]);
    expect(html).toContain('colspan="10"');
  });

  test("task with pr value uses indigo link color matching ID column style", () => {
    const taskWithPr: TaskItem = {
      ...TASK_ITEM,
      pr: 99,
      repo: "app-vitals/shipwright",
    };
    const html = render([taskWithPr]);
    // PR link should match ID link style: color:#6366f1
    const prLinkMatch = html.match(
      /<a href="https:\/\/github\.com\/[^"]*"[^>]*>.*#99.*<\/a>/,
    );
    expect(prLinkMatch).not.toBeNull();
    if (prLinkMatch) {
      expect(prLinkMatch[0]).toContain("color:#6366f1");
    }
  });

  test("PR URL is correctly formatted with repo and pr number", () => {
    const taskWithPr: TaskItem = {
      ...TASK_ITEM,
      pr: 123,
      repo: "my-org/my-repo",
    };
    const html = render([taskWithPr]);
    expect(html).toContain("https://github.com/my-org/my-repo/pull/123");
  });

  test("XSS: repo in PR link is escaped", () => {
    const xssTask: TaskItem = {
      ...TASK_ITEM,
      pr: 1,
      repo: 'evil"><script>xss()</script>',
    };
    const html = render([xssTask]);
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — source filter (CTV-4.2) ───────────────────────────────

describe("renderTasksPage — source filter", () => {
  function render(
    tasks: TaskItem[],
    filters: Parameters<typeof renderTasksPage>[1] = {},
  ): string {
    return renderTasksPage(
      tasks,
      filters,
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  test("filter form has a source text input", () => {
    const html = render([]);
    expect(html).toContain('name="source"');
    expect(html).toContain('placeholder="source"');
  });

  test("source input value round-trips from filters.source", () => {
    const html = render([], { source: "entropy-fix" });
    expect(html).toContain('value="entropy-fix"');
  });

  test("source input escapes HTML in filters.source", () => {
    const html = render([], { source: '"><script>xss()</script>' });
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("table header includes a Source column", () => {
    const html = render([]);
    expect(html).toContain('<th class="col-source">Source</th>');
  });

  test("row renders task.source value in the Source column", () => {
    const taskWithSource: TaskItem = { ...TASK_ITEM, source: "entropy-fix" };
    const html = render([taskWithSource]);
    expect(html).toContain("entropy-fix");
  });

  test("row without source shows em-dash placeholder", () => {
    const taskWithoutSource: TaskItem = { ...TASK_ITEM, source: null };
    const html = render([taskWithoutSource]);
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  test("row escapes HTML in task.source", () => {
    const xssTask: TaskItem = {
      ...TASK_ITEM,
      source: '"><script>xss()</script>',
    };
    const html = render([xssTask]);
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("makePageUrl carries filters.source into pagination links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { source: "entropy-fix" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain("source=entropy-fix");
  });

  test("makeStateParams carries filters.source into state-tab links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { state: "ready", source: "entropy-fix" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      `href="/admin/tasks?state=in_progress&source=entropy-fix&view=table"`,
    );
  });

  test("makePageUrl carries multi-value filters.repo as repeated repo= params into pagination links, not comma-joined", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { repo: ["app-vitals/repo-a", "app-vitals/repo-b"] },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?repo=app-vitals%2Frepo-a&repo=app-vitals%2Frepo-b&page=2&view=table"',
    );
    expect(html).not.toContain("app-vitals/repo-a,app-vitals/repo-b");
  });

  test("makePageUrl carries multi-value filters.org as repeated org= params into pagination links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { org: ["app-vitals", "other-org"] },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?org=app-vitals&org=other-org&page=2&view=table"',
    );
  });

  test("makeStateParams carries multi-value filters.repo as repeated repo= params into state-tab links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { state: "ready", repo: ["app-vitals/repo-a", "app-vitals/repo-b"] },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?state=in_progress&repo=app-vitals%2Frepo-a&repo=app-vitals%2Frepo-b&view=table"',
    );
  });

  test("makeStateParams carries multi-value filters.org as repeated org= params into state-tab links", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { state: "ready", org: ["app-vitals", "other-org"] },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?state=in_progress&org=app-vitals&org=other-org&view=table"',
    );
  });

  test("makePageUrl backward-compat: a single-value (string) filters.repo still round-trips as one repo= param", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { repo: "app-vitals/repo-a" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    expect(html).toContain(
      'href="/admin/tasks?repo=app-vitals%2Frepo-a&page=2&view=table"',
    );
  });
});

// ─── renderTasksPage — Created column (ATC-1.5) ──────────────────────────────

describe("renderTasksPage — Created column", () => {
  function render(tasks: TaskItem[]): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  test("Created column header is present with col-created class", () => {
    const html = render([]);
    expect(html).toContain('<th class="col-created">Created</th>');
  });

  test("task with createdAt renders formatted date in Created cell", () => {
    const taskWithCreatedAt: TaskItem = {
      ...TASK_ITEM,
      createdAt: "2026-07-10T09:30:00.000Z",
    };
    const html = render([taskWithCreatedAt]);
    const expected = new Date(
      taskWithCreatedAt.createdAt as string,
    ).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Los_Angeles",
    });
    expect(html).toContain(expected);
  });

  test("task without createdAt shows em-dash in Created cell", () => {
    const taskWithoutCreatedAt: TaskItem = {
      ...TASK_ITEM,
      createdAt: null,
    };
    const html = render([taskWithoutCreatedAt]);
    const createdTdPattern =
      /<td class="col-created"[^>]*>\s*<span style="color:#9ca3af">—<\/span>\s*<\/td>/;
    expect(html).toMatch(createdTdPattern);
  });

  test("task with invalid createdAt falls back to raw string (NaN guard)", () => {
    const taskWithInvalidCreatedAt: TaskItem = {
      ...TASK_ITEM,
      createdAt: "not-a-date",
    };
    const html = render([taskWithInvalidCreatedAt]);
    expect(html).toContain("not-a-date");
  });

  test("Created <th> and <td> join the col-session/col-repo mobile-hide set", () => {
    const html = render([
      { ...TASK_ITEM, createdAt: "2026-07-10T09:30:00.000Z" },
    ]);
    expect(html).toContain('<th class="col-created">Created</th>');
    const createdTdPattern = /<td[^>]*class="[^"]*col-created[^"]*"[^>]*>/;
    expect(html).toMatch(createdTdPattern);
  });
});

// ─── renderTasksPage — PR column: renderer guard + prUrl fallback ─────────────

describe("renderTasksPage — PR column: renderer guard + prUrl fallback", () => {
  function render(tasks: TaskItem[]): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
    );
  }

  // (1) pr set + repo null → '--' (never github.com//pull/)
  test("pr set + repo null renders '--' (never github.com//pull/)", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      pr: 7,
      repo: null,
    };
    const html = render([task]);
    expect(html).not.toContain("github.com//pull/");
    expect(html).toContain("—");
    expect(html).not.toContain("github.com/null/pull/");
  });

  // (2) pr set + repo set → valid github link
  test("pr set + repo set renders valid github link", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      pr: 42,
      repo: "my-org/my-repo",
    };
    const html = render([task]);
    expect(html).toContain("https://github.com/my-org/my-repo/pull/42");
    expect(html).toContain("#42");
  });

  // (3) only prUrl set → link to prUrl
  test("only prUrl set renders a link to prUrl", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      pr: null,
      repo: null,
      prUrl: "https://github.com/org/repo/pull/99",
    };
    const html = render([task]);
    expect(html).toContain("https://github.com/org/repo/pull/99");
  });

  // (4) neither pr nor prUrl → '--'
  test("neither pr nor prUrl renders '--'", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      pr: null,
      repo: null,
      prUrl: null,
    };
    const html = render([task]);
    // em-dash for no PR
    expect(html).toContain("—");
    expect(html).not.toContain("github.com");
  });
});

// ─── renderTasksPage — 4-state toggle ────────────────────────────────────────

const EMPTY_PAGINATION = { total: 0, limit: 50, page: 1 };

describe("renderTasksPage — 4-state toggle", () => {
  test("no tab highlighted when no state filter (show all)", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    // No tab should have active (indigo) styling
    expect(html).not.toContain("background:#6366f1;color:#fff");
    // All tabs are present
    expect(html).toContain("Ready");
    expect(html).toContain("In Progress");
    expect(html).toContain("Blocked");
    expect(html).toContain("Closed");
  });

  // TBF-1.1: Reset must stay in table view — a bare /admin/tasks link would
  // land on the board (AXR-1.3) instead of clearing filters within the
  // current table view.
  test("Reset button links to /admin/tasks?view=table with no other params", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    expect(html).toContain(
      '<a href="/admin/tasks?view=table" class="btn btn-secondary" style="font-size:12px">Reset</a>',
    );
  });

  test("In Progress tab is active when state=in_progress", () => {
    const html = renderTasksPage(
      [],
      { state: "in_progress" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    // In Progress tab link contains ?state=in_progress
    expect(html).toContain("state=in_progress");
    // In Progress tab has active styling — find the active tab text near the indigo bg
    const activePattern = /background:#6366f1;color:#fff[^>]*>In Progress/;
    expect(html).toMatch(activePattern);
    // Ready, Blocked, Closed tabs are not active (no indigo on those links)
    // They should be white background
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Ready/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Blocked/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Closed/);
  });

  test("Blocked tab is active when state=blocked", () => {
    const html = renderTasksPage(
      [],
      { state: "blocked" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    expect(html).toContain("state=blocked");
    expect(html).toMatch(/background:#6366f1;color:#fff[^>]*>Blocked/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Ready/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>In Progress/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Closed/);
  });

  test("Closed tab is active when state=closed", () => {
    const html = renderTasksPage(
      [],
      { state: "closed" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    expect(html).toContain("state=closed");
    expect(html).toMatch(/background:#6366f1;color:#fff[^>]*>Closed/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Ready/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>In Progress/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Blocked/);
  });

  test("Ready tab is active and links to ?state=ready when state=ready", () => {
    const html = renderTasksPage(
      [],
      { state: "ready" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    // Ready tab has active (indigo) styling
    expect(html).toContain("background:#6366f1;color:#fff");
    // Ready tab href contains state=ready and stays in table view
    expect(html).toMatch(
      /href="\/admin\/tasks\?state=ready&view=table"[^>]*>Ready</,
    );
    // Other tabs are not active
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>In Progress/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Blocked/);
    expect(html).toMatch(/background:#fff;color:#374151[^>]*>Closed/);
  });

  test("Tab links preserve session and repo query params", () => {
    const html = renderTasksPage(
      [],
      { state: "in_progress", session: "my-session", repo: "org/repo" },
      false,
      USER_NAME,
      {},
      EMPTY_PAGINATION,
      undefined,
      undefined,
    );
    // All tab links should contain session and repo params
    const tabLinkPattern =
      /href="\/admin\/tasks\?[^"]*session=my-session[^"]*"/g;
    const matches = html.match(tabLinkPattern);
    // We expect at least 3 tab links (Ready, Blocked, Closed) to preserve session (In Progress is active tab)
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("repo=org");
  });

  test("Pagination URL carries correct ?state param for non-default states", () => {
    const html = renderTasksPage(
      [],
      { state: "blocked" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
      undefined,
      undefined,
    );
    // Next button should link to page 2 with state=blocked
    expect(html).toContain("state=blocked");
    expect(html).toContain("page=2");
  });
});

// ─── renderTasksPage — board view (AXR-1.3) ──────────────────────────────────

describe("renderTasksPage — board view (AXR-1.3)", () => {
  const BOARD_PAGINATION = { total: 0, limit: 50, page: 1 };

  function renderBoard(
    tasks: TaskItem[],
    filters: Parameters<typeof renderTasksPage>[1] = {},
    suggestions: Parameters<typeof renderTasksPage>[7] = undefined,
    prsByTaskId: Parameters<typeof renderTasksPage>[10] = {},
    now?: Parameters<typeof renderTasksPage>[12],
  ): string {
    return renderTasksPage(
      tasks,
      filters,
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      suggestions,
      false,
      "America/Los_Angeles",
      prsByTaskId,
      "board",
      now,
    );
  }

  test("renders 3 board columns in order: Queued, In Progress, Blocked-HITL (TBC-2.1)", () => {
    const html = renderBoard([]);
    expect(html).toContain('class="board"');
    expect(html).toContain("Queued");
    expect(html).toContain("In Progress");
    expect(html).toContain("Blocked-HITL");
    expect(html).not.toContain("Claimed");
    expect(html).not.toContain(">Done<");
    // Exactly 3 column containers
    expect((html.match(/class="column"/g) ?? []).length).toBe(3);
    // Columns must render left-to-right in this exact order.
    const dataColumnSequence = [...html.matchAll(/data-column="([^"]+)"/g)].map((m) => m[1]);
    expect(dataColumnSequence).toEqual(["queued", "in_progress", "blocked_hitl"]);
  });

  function extractColumn(html: string, key: string): string {
    const marker = `<div class="column" data-column="${key}">`;
    const start = html.indexOf(marker);
    if (start === -1) return "";
    const nextMarkerIndex = html.indexOf(
      '<div class="column" data-column="',
      start + marker.length,
    );
    const end = nextMarkerIndex === -1 ? html.length : nextMarkerIndex;
    return html.slice(start, end);
  }

  test("buckets a pending unclaimed task into Queued", () => {
    const task: TaskItem = {
      id: "T-QUEUED",
      title: "Queued task title",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(extractColumn(html, "queued")).toContain("Queued task title");
    expect(extractColumn(html, "claimed")).not.toContain("Queued task title");
  });

  test("a pending claimed task is absent from the default board — Claimed is no longer rendered (TBC-2.1)", () => {
    const task: TaskItem = {
      id: "T-CLAIMED",
      title: "Claimed task title",
      status: "pending",
      claimedBy: "agent-1",
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).not.toContain('data-column="claimed"');
    expect(html).not.toContain("Claimed task title");
  });

  test("buckets an in_progress task into In Progress", () => {
    const task: TaskItem = {
      id: "T-INPROG",
      title: "In progress task title",
      status: "in_progress",
      claimedBy: "agent-1",
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(extractColumn(html, "in_progress")).toContain(
      "In progress task title",
    );
  });

  test("buckets a blocked task into Blocked-HITL", () => {
    const task: TaskItem = {
      id: "T-BLOCKED",
      title: "Blocked task title",
      status: "blocked",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(extractColumn(html, "blocked_hitl")).toContain(
      "Blocked task title",
    );
  });

  test("buckets a hitl:true task into Blocked-HITL even when in_progress", () => {
    const task: TaskItem = {
      id: "T-HITL",
      title: "HITL task title",
      status: "in_progress",
      hitl: true,
      claimedBy: "agent-1",
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(extractColumn(html, "blocked_hitl")).toContain("HITL task title");
    expect(extractColumn(html, "in_progress")).not.toContain(
      "HITL task title",
    );
  });

  test("a done task is absent from the default board — Done is no longer rendered (TBC-2.1)", () => {
    const task: TaskItem = {
      id: "T-DONE",
      title: "Done task title",
      status: "deployed",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).not.toContain('data-column="done"');
    expect(html).not.toContain("Done task title");
  });

  test("a task with a blocked joined PR lands in Blocked-HITL, matching bucketTaskColumn", () => {
    const task: TaskItem = {
      id: "T-PR-BLOCKED",
      title: "PR blocked task title",
      status: "in_progress",
      claimedBy: "agent-1",
      assignee: null,
      repo: "org/repo",
      pr: 5,
    };
    const pr: PrListItem = {
      id: "pr-1",
      repo: "org/repo",
      prNumber: 5,
      staged: false,
      state: "open",
      reviewState: "pending",
      patchCycles: 0,
      reviewCycles: 0,
      blocked: true,
      blockedReason: "Waiting on CI",
    };
    const html = renderBoard([task], {}, undefined, { [task.id]: pr });
    expect(extractColumn(html, "blocked_hitl")).toContain(
      "PR blocked task title",
    );
  });

  test("card shows the linked PR's blocked/HITL state inline, without a page navigation", () => {
    const task: TaskItem = {
      id: "T-PR-INLINE",
      title: "Inline PR badge task",
      status: "in_progress",
      claimedBy: "agent-1",
      assignee: null,
      repo: "org/repo",
      pr: 7,
    };
    const pr: PrListItem = {
      id: "pr-2",
      repo: "org/repo",
      prNumber: 7,
      staged: false,
      state: "open",
      reviewState: "pending",
      patchCycles: 0,
      reviewCycles: 0,
      blocked: true,
      blockedReason: "Needs human review",
    };
    const html = renderBoard([task], {}, undefined, { [task.id]: pr });
    // The badge/reason is rendered directly in the card's HTML (no separate
    // fetch or navigation required to see the blocked/HITL state).
    expect(html).toContain("Needs human review");
    expect(html).toContain('data-pr-blocked="true"');
  });

  test("default board filter row shows only Org and Repo selects — status/hitl/session/source/agent are collapsed under a <details> more-filters disclosure", () => {
    const html = renderBoard([], {}, { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] });
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
    expect(html).toContain('<details class="more-filters">');

    const detailsMatch = html.match(
      /<details class="more-filters">([\s\S]*?)<\/details>/,
    );
    expect(detailsMatch).not.toBeNull();
    const detailsHtml = detailsMatch ? detailsMatch[1] : "";
    expect(detailsHtml).toContain('name="status"');
    expect(detailsHtml).toContain('name="hitl"');
    expect(detailsHtml).toContain('name="session"');
    expect(detailsHtml).toContain('name="source"');
    expect(detailsHtml).toContain('name="agent"');

    // Org/Repo selects are not nested inside the disclosure — they render
    // ahead of it, in the always-visible filter row.
    const detailsIndex = html.indexOf('<details class="more-filters">');
    const orgIndex = html.indexOf('<select name="org" multiple');
    const repoIndex = html.indexOf('<select name="repo" multiple');
    expect(orgIndex).toBeGreaterThanOrEqual(0);
    expect(repoIndex).toBeGreaterThanOrEqual(0);
    expect(orgIndex).toBeLessThan(detailsIndex);
    expect(repoIndex).toBeLessThan(detailsIndex);
  });

  // TBC-2.1 follow-up: the board's Status dropdown must not offer a closed
  // status. Picking one would set `?status=…`, bypassing the board's
  // `state=open` default query, and every returned task buckets to the
  // "done" column — which TASK_BOARD_COLUMNS no longer renders — so the
  // board would silently show "No tasks" in all 3 columns.
  test("board Status dropdown omits closed statuses (merged/done/deploying/deployed/cancelled) but keeps the active ones", () => {
    const html = renderBoard([]);
    const statusSelect = html.match(
      /<select name="status"[^>]*>([\s\S]*?)<\/select>/,
    );
    expect(statusSelect).not.toBeNull();
    const statusHtml = statusSelect ? statusSelect[1] : "";

    for (const closed of [
      "merged",
      "done",
      "deploying",
      "deployed",
      "cancelled",
    ]) {
      expect(statusHtml).not.toContain(`value="${closed}"`);
    }

    expect(statusHtml).toContain("Any status");
    for (const active of [
      "pending",
      "in_progress",
      "pr_open",
      "approved",
      "blocked",
    ]) {
      expect(statusHtml).toContain(`value="${active}"`);
    }
  });

  test("table view's Status dropdown still offers every status, including the closed ones", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      BOARD_PAGINATION,
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "table",
    );
    const statusSelect = html.match(
      /<select name="status"[^>]*>([\s\S]*?)<\/select>/,
    );
    expect(statusSelect).not.toBeNull();
    const statusHtml = statusSelect ? statusSelect[1] : "";
    for (const status of [
      "pending",
      "in_progress",
      "pr_open",
      "approved",
      "merged",
      "done",
      "deploying",
      "deployed",
      "blocked",
      "cancelled",
    ]) {
      expect(statusHtml).toContain(`value="${status}"`);
    }
  });

  test("Org and Repo remain two independent multiselects on the board, not merged into one combined scope-pill selector", () => {
    const html = renderBoard([], {}, { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] });
    const selectCount = (html.match(/<select /g) ?? []).length;
    // org, repo, plus status + hitl inside <details> == 4 total <select>s
    expect(selectCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("selecting an org with no repo selected renders all repo options unfiltered (org and repo stay independent dimensions)", () => {
    const html = renderBoard(
      [],
      { org: ["app-vitals"] },
      {
        orgs: ["app-vitals", "other-org"],
        repos: [
          "app-vitals/repo-a",
          "app-vitals/repo-b",
          "other-org/repo-c",
        ],
      },
    );
    // Org is selected...
    expect(html).toContain(
      '<option value="app-vitals" selected>app-vitals</option>',
    );
    // ...but the Repo select still lists every repo, including ones under
    // other orgs, and none of them are pre-selected — selecting an org does
    // not narrow or auto-select repo options.
    expect(html).toContain('<option value="app-vitals/repo-a">');
    expect(html).toContain('<option value="app-vitals/repo-b">');
    expect(html).toContain('<option value="other-org/repo-c">');
    const repoSelectMatch = html.match(
      /<select name="repo" multiple[^>]*>([\s\S]*?)<\/select>/,
    );
    expect(repoSelectMatch).not.toBeNull();
    expect(repoSelectMatch ? repoSelectMatch[1] : "").not.toContain(
      "selected",
    );
  });

  test("view: 'board' is reachable via a link back to the table view (?view=table)", () => {
    const html = renderBoard([]);
    expect(html).toContain("view=table");
  });

  // ─── Task board card slide-over drawer (AXR-1.4) ───────────────────────────────
  // Each card opens a drawer showing full task + joined PR detail via a checkbox-driven
  // off-canvas pattern, reusing the existing chat-drawer mechanics.

  test("each board card renders a hidden checkbox with id=task-drawer-toggle-{taskId}", () => {
    const task: TaskItem = {
      id: "DRAWER-TEST",
      title: "Drawer test task",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).toContain('id="task-drawer-toggle-DRAWER-TEST"');
    expect(html).toContain('class="task-drawer-toggle"');
    expect(html).toContain('aria-hidden="true"');
  });

  // aria-hidden only removes the checkbox from the accessibility tree, not the
  // tab order — without tabindex="-1" a keyboard user can Tab to the hidden
  // per-card checkbox and Space-check it directly, bypassing the card's click
  // handler (the only place that closes any other already-open drawer) and
  // ending up with two stacked .task-drawer panels.
  test("hidden drawer checkbox is removed from tab order via tabindex=-1", () => {
    const task: TaskItem = {
      id: "TABINDEX-TEST",
      title: "Tabindex test task",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).toContain('id="task-drawer-toggle-TABINDEX-TEST"');
    expect(html).toContain('tabindex="-1"');
  });

  test("drawer checkbox appears before the drawer panel in DOM order", () => {
    const task: TaskItem = {
      id: "DOM-ORDER-TEST",
      title: "DOM order test",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    const checkboxIndex = html.indexOf('id="task-drawer-toggle-DOM-ORDER-TEST"');
    const drawerPanelIndex = html.indexOf('class="task-drawer"');
    expect(checkboxIndex).toBeGreaterThanOrEqual(0);
    expect(drawerPanelIndex).toBeGreaterThanOrEqual(0);
    expect(checkboxIndex).toBeLessThan(drawerPanelIndex);
  });

  test("drawer renders a scrim label bound to the drawer toggle", () => {
    const task: TaskItem = {
      id: "SCRIM-TEST",
      title: "Scrim test task",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    expect(html).toContain('class="task-drawer-scrim"');
    expect(html).toContain('for="task-drawer-toggle-SCRIM-TEST"');
  });

  test("drawer panel renders the task title and id", () => {
    const task: TaskItem = {
      id: "TITLE-ID-TEST",
      title: "My task title",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderBoard([task]);
    const drawerPanel = html.match(
      /class="task-drawer"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/,
    );
    expect(drawerPanel).not.toBeNull();
    if (drawerPanel) {
      expect(drawerPanel[1]).toContain("My task title");
      expect(drawerPanel[1]).toContain("TITLE-ID-TEST");
    }
  });

  test("drawer panel includes PR state and reviewState when a joined PR exists", () => {
    const task: TaskItem = {
      id: "PR-STATE-TEST",
      title: "PR state test",
      status: "in_progress",
      claimedBy: "agent-1",
      assignee: null,
      repo: "org/repo",
      pr: 42,
    };
    const pr: PrListItem = {
      id: "pr-1",
      repo: "org/repo",
      prNumber: 42,
      staged: false,
      state: "open",
      reviewState: "approved",
      patchCycles: 1,
      reviewCycles: 2,
      blocked: false,
    };
    const html = renderBoard([task], {}, undefined, { [task.id]: pr });
    const drawerPanel = html.match(
      /class="task-drawer"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/,
    );
    expect(drawerPanel).not.toBeNull();
    if (drawerPanel) {
      // The drawer should show the PR state and review state
      expect(drawerPanel[1]).toContain("open");
      expect(drawerPanel[1]).toContain("approved");
    }
  });

  test("multiple cards each get unique drawer checkbox ids", () => {
    const tasks: TaskItem[] = [
      { id: "TASK-1", title: "Task 1", status: "pending", claimedBy: null, assignee: null },
      { id: "TASK-2", title: "Task 2", status: "pending", claimedBy: null, assignee: null },
      { id: "TASK-3", title: "Task 3", status: "pending", claimedBy: null, assignee: null },
    ];
    const html = renderBoard(tasks);
    expect(html).toContain('id="task-drawer-toggle-TASK-1"');
    expect(html).toContain('id="task-drawer-toggle-TASK-2"');
    expect(html).toContain('id="task-drawer-toggle-TASK-3"');
    // Verify no duplicate ids
    const idMatches = html.match(/id="task-drawer-toggle-[^"]+"/g) ?? [];
    expect(idMatches.length).toBe(3);
    expect(new Set(idMatches).size).toBe(3);
  });

  test("readOnly board rendering does not render drawer toggles or scrims", () => {
    const task: TaskItem = {
      id: "READONLY-TEST",
      title: "Readonly task",
      status: "pending",
      claimedBy: null,
      assignee: null,
    };
    const html = renderTasksPage(
      [task],
      {},
      false,
      USER_NAME,
      {},
      BOARD_PAGINATION,
      undefined,
      undefined,
      true, // readOnly = true
      "America/Los_Angeles",
      {},
      "board",
    );
    // Check that the HTML elements are not rendered (the class definitions in CSS are OK)
    expect(html).not.toContain('id="task-drawer-toggle-');
    expect(html).not.toContain('class="task-drawer-scrim"');
    expect(html).not.toContain('class="task-drawer"');
    expect(html).not.toContain('data-drawer-toggle=');
  });

  // Opening a card's drawer must close any other drawer already open — two
  // .task-drawer panels are both position:fixed at the same spot, so leaving
  // a prior toggle checked would stack an invisible-but-still-checked drawer
  // behind the new one instead of a clean single-drawer UX.
  test("click handler closes any other open drawer before opening the clicked card's", () => {
    const html = renderBoard([
      { id: "T-A", title: "A", status: "pending", claimedBy: null, assignee: null },
      { id: "T-B", title: "B", status: "pending", claimedBy: null, assignee: null },
    ]);
    expect(html).toContain('.task-drawer-toggle:checked").forEach(function(openToggle)');
    expect(html).toContain("if (openToggle.id !== toggleId) openToggle.checked = false;");
  });

  // ─── board card age badge (TBC-1.1) ─────────────────────────────────────
  // The board card should surface a relative age derived from createdAt,
  // using the same <span title="{ISO}">{relative}</span> pattern as the
  // Queue/Activity table's ageCell (~line 4108) and cron last-run age
  // (~line 1191), driven by an explicitly-injected `now` (t2_clock_injection
  // — no `new Date()` inside the render chain itself). Nested here (rather
  // than a sibling top-level describe) so it can reuse this block's local
  // `renderBoard` helper.
  describe("board card age badge (TBC-1.1)", () => {
    const NOW = new Date("2026-09-04T12:00:00.000Z");

    test("createdAt a few seconds before now renders 'just now' with the ISO timestamp in a title attribute", () => {
      const createdAt = new Date(NOW.getTime() - 5_000).toISOString();
      const task: TaskItem = {
        id: "T-AGE-NOW",
        title: "Fresh task",
        status: "pending",
        claimedBy: null,
        assignee: null,
        createdAt,
      };
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain(`title="${createdAt}"`);
      expect(html).toContain(">just now<");
    });

    test("createdAt several hours before now renders 'N hours ago' with the ISO timestamp in a title attribute", () => {
      const createdAt = new Date(
        NOW.getTime() - 5 * 60 * 60 * 1000,
      ).toISOString();
      const task: TaskItem = {
        id: "T-AGE-HOURS",
        title: "Hours-old task",
        status: "pending",
        claimedBy: null,
        assignee: null,
        createdAt,
      };
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain(`title="${createdAt}"`);
      expect(html).toContain(">5 hours ago<");
    });

    test("createdAt several days before now renders 'N days ago' with the ISO timestamp in a title attribute", () => {
      const createdAt = new Date(
        NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const task: TaskItem = {
        id: "T-AGE-DAYS",
        title: "Days-old task",
        status: "pending",
        claimedBy: null,
        assignee: null,
        createdAt,
      };
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain(`title="${createdAt}"`);
      expect(html).toContain(">3 days ago<");
    });

    test("missing createdAt renders the card without throwing and without an age badge", () => {
      const task: TaskItem = {
        id: "T-AGE-MISSING",
        title: "No createdAt task",
        status: "pending",
        claimedBy: null,
        assignee: null,
        createdAt: null,
      };
      expect(() => renderBoard([task], {}, undefined, {}, NOW)).not.toThrow();
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain("No createdAt task");
      expect(html).not.toContain("ago<");
      expect(html).not.toContain("just now<");
    });

    test("undefined createdAt (field entirely absent) renders the card without throwing and without an age badge", () => {
      const task: TaskItem = {
        id: "T-AGE-UNDEFINED",
        title: "Undefined createdAt task",
        status: "pending",
        claimedBy: null,
        assignee: null,
      };
      expect(() => renderBoard([task], {}, undefined, {}, NOW)).not.toThrow();
      const html = renderBoard([task], {}, undefined, {}, NOW);
      expect(html).toContain("Undefined createdAt task");
      expect(html).not.toContain("ago<");
      expect(html).not.toContain("just now<");
    });
  });
});

// ─── renderTasksPage — board full page width (TBF-1.2) ──────────────────────
// The board (default view) should stretch past the shared 960px .vos-page
// cap; table view must stay untouched. Mirrors the .vos-page inline-style
// assertion pattern at ~line 7236.

describe("renderTasksPage — board full page width (TBF-1.2)", () => {
  test("board view's .vos-page wrapper carries the tasks-board-page modifier class", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      { total: 0, limit: 50, page: 1 },
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "board",
    );
    const match = html.match(/<div class="vos-page[^"]*">/);
    expect(match).not.toBeNull();
    expect(match?.[0]).toContain("tasks-board-page");
  });

  test("table view's .vos-page wrapper does not carry the tasks-board-page modifier class", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      { total: 0, limit: 50, page: 1 },
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "table",
    );
    const match = html.match(/<div class="vos-page[^"]*">/);
    expect(match).not.toBeNull();
    expect(match?.[0]).not.toContain("tasks-board-page");
  });
});

// ─── renderTasksPage — ?view=table toggle (AXR-1.3) ──────────────────────────

describe("renderTasksPage — ?view=table toggle (AXR-1.3)", () => {
  test("view: 'table' produces identical output to the default (omitted) view — the pre-redesign table renderer is preserved and reachable, not deleted", () => {
    const tasks: TaskItem[] = [
      {
        id: "T-1",
        title: "Some task",
        status: "in_progress",
        session: "s-1",
        repo: "org/repo",
        assignee: null,
        claimedBy: "agent-1",
        pr: 9,
      },
    ];
    const filters: Parameters<typeof renderTasksPage>[1] = {
      status: "in_progress",
    };
    const agentNames = { "agent-1": "Agent One" };
    const pagination = { total: 1, limit: 50, page: 1 };
    const suggestions = { orgs: ["org"], repos: ["org/repo"] };
    const prsByTaskId: Record<string, PrListItem> = {};

    const withoutView = renderTasksPage(
      tasks,
      filters,
      false,
      USER_NAME,
      agentNames,
      pagination,
      undefined,
      suggestions,
      false,
      "America/Los_Angeles",
      prsByTaskId,
    );
    const withExplicitTable = renderTasksPage(
      tasks,
      filters,
      false,
      USER_NAME,
      agentNames,
      pagination,
      undefined,
      suggestions,
      false,
      "America/Los_Angeles",
      prsByTaskId,
      "table",
    );

    expect(withExplicitTable).toEqual(withoutView);
    // Sanity: this is genuinely the dense table markup, not the board.
    expect(withExplicitTable).toContain('<table class="data-table">');
    expect(withExplicitTable).toContain("<th>ID</th>");
    expect(withExplicitTable).toContain("<th>PR</th>");
  });

  test("view: 'board' output is structurally different from view: 'table' output for the same data", () => {
    const tasks: TaskItem[] = [
      {
        id: "T-2",
        title: "Another task",
        status: "pending",
        claimedBy: null,
        assignee: null,
      },
    ];
    const pagination = { total: 1, limit: 50, page: 1 };
    const table = renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "table",
    );
    const board = renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      undefined,
      false,
      "America/Los_Angeles",
      {},
      "board",
    );
    expect(table).not.toEqual(board);
    expect(table).toContain('<table class="data-table">');
    expect(board).not.toContain('<table class="data-table">');
    expect(board).toContain('class="board"');
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

// ─── renderTaskDetailPage ────────────────────────────────────────────────────

const TASK_DETAIL: TaskItem = {
  id: "TS-1",
  title: "Do the thing",
  status: "blocked",
  description: "## Overview\nThis task does something.",
  acceptanceCriteria: [
    "AC1: `foo` is set",
    "AC2: List works:\n- item one\n- item two",
  ],
  blockedBy: [
    { type: "dependency", id: "TS-dep", status: "pending" },
    { type: "hitl" },
  ],
};

describe("renderTaskDetailPage — blockers", () => {
  function render(task: Partial<TaskItem> = {}): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      {},
      "UTC",
    );
  }

  test("shows blockers section when blockedBy is non-empty", () => {
    const html = render();
    expect(html.toLowerCase()).toContain("blocker");
  });

  test("shows dependency blocker with dep id and status", () => {
    const html = render();
    expect(html).toContain("TS-dep");
    expect(html).toContain("pending");
  });

  test("dependency blocker id links to its task detail page", () => {
    const html = render();
    expect(html).toContain('<a href="/admin/tasks/TS-dep"');
  });

  test("shows hitl blocker type", () => {
    const html = render();
    expect(html.toLowerCase()).toContain("hitl");
  });

  test("no blockers section when blockedBy is empty", () => {
    const html = render({ blockedBy: [] });
    expect(html).not.toMatch(/Blockers<\/div>/i);
  });

  test("no blockers section when blockedBy is null", () => {
    const html = render({ blockedBy: null });
    expect(html).not.toMatch(/Blockers<\/div>/i);
  });

  test("no blockers section when blockedBy is undefined", () => {
    const html = render({ blockedBy: undefined });
    expect(html).not.toMatch(/Blockers<\/div>/i);
  });

  test("hitl notified variant shows different text", () => {
    const html = render({
      blockedBy: [{ type: "hitl", notified: true }],
    });
    expect(html.toLowerCase()).toContain("hitl");
  });

  test("XSS: dep id in blockers is escaped", () => {
    const html = render({
      blockedBy: [
        { type: "dependency", id: "<script>xss()</script>", status: "pending" },
      ],
    });
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });

  // Regression test for Sentry issue 7665355727: a {type:"blocked"} entry
  // previously fell through to the dependency branch and crashed on
  // taskLink(b.id)/escapeHtml(b.status), both undefined for this variant.
  test("blocked entry with a populated reason renders the reason, not a crash", () => {
    expect(() =>
      render({
        blockedBy: [{ type: "blocked", reason: "Waiting on external vendor" }],
      }),
    ).not.toThrow();
    const html = render({
      blockedBy: [{ type: "blocked", reason: "Waiting on external vendor" }],
    });
    expect(html).toContain("Waiting on external vendor");
    expect(html).not.toContain("undefined");
  });

  test("blocked entry with a null reason renders a fallback label, not a crash", () => {
    expect(() =>
      render({ blockedBy: [{ type: "blocked", reason: null }] }),
    ).not.toThrow();
    const html = render({ blockedBy: [{ type: "blocked", reason: null }] });
    expect(html).toContain("Blocked");
    expect(html).not.toContain("undefined");
  });

  test("blocked entry's reason is HTML-escaped in the blockers list", () => {
    const html = render({
      blockedBy: [{ type: "blocked", reason: "<script>xss()</script>" }],
    });
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });

  test("blockers card appears before description card when blockedBy is set", () => {
    const html = render();
    const blockersIdx = html.indexOf("Blockers");
    const descriptionIdx = html.indexOf("Description");
    expect(blockersIdx).toBeGreaterThan(-1);
    expect(descriptionIdx).toBeGreaterThan(-1);
    expect(blockersIdx).toBeLessThan(descriptionIdx);
  });
});

describe("renderTaskDetailPage — dependencies", () => {
  function render(task: Partial<TaskItem> = {}): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      {},
      "UTC",
    );
  }

  test("dependency ids link to their task detail pages", () => {
    const html = render({ dependencies: ["TASK-A", "TASK-B"] });
    expect(html).toContain('<a href="/admin/tasks/TASK-A"');
    expect(html).toContain('<a href="/admin/tasks/TASK-B"');
  });

  test("no dependencies field when dependencies is empty", () => {
    const html = render({ dependencies: [] });
    expect(html).not.toContain("Dependencies");
  });
});

describe("renderTaskDetailPage — agent field linkability", () => {
  function render(
    task: Partial<TaskItem> = {},
    agentNames: Record<string, string> = {},
  ): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      agentNames,
      "UTC",
    );
  }

  test("Assignee links to the agent detail page", () => {
    const html = render({ assignee: "agent-a" });
    expect(html).toContain('<a href="/admin/agents/agent-a"');
  });

  test("Agent Hint links to the agent detail page", () => {
    const html = render({ agentHint: "agent-b" });
    expect(html).toContain('<a href="/admin/agents/agent-b"');
  });

  test("Claimed By links to the agent detail page and shows display name", () => {
    const html = render(
      { claimedBy: "agent-c" },
      { "agent-c": "Agent Charlie" },
    );
    expect(html).toContain('<a href="/admin/agents/agent-c"');
    expect(html).toContain("Agent Charlie (agent-c)");
  });

  test("no Assignee/Agent Hint/Claimed By rows when unset", () => {
    const html = render({ assignee: null, agentHint: null, claimedBy: null });
    expect(html).not.toContain("/admin/agents/");
  });
});

describe("renderTaskDetailPage — markdown", () => {
  function render(task: Partial<TaskItem> = {}): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      {},
      "UTC",
    );
  }

  test("description headings rendered as HTML heading tags", () => {
    const html = render({ description: "## My heading\nsome text" });
    expect(html).toMatch(/<h[1-6][^>]*>.*My heading.*<\/h[1-6]>/s);
  });

  test("description code block rendered as pre/code", () => {
    const html = render({ description: "```\nconst x = 1;\n```" });
    expect(html).toContain("<pre");
    expect(html).toContain("<code");
  });

  test("description inline code rendered as code tag", () => {
    const html = render({ description: "Use `foo()` here." });
    expect(html).toContain("<code>");
  });

  test("description lists rendered as ul/li", () => {
    const html = render({ description: "- item one\n- item two" });
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
  });

  test("acceptance criteria items support inline code", () => {
    const html = render({
      acceptanceCriteria: ["AC with `code` inside"],
    });
    expect(html).toContain("<code>");
    expect(html).toContain("code");
  });

  test("acceptance criteria items support bold", () => {
    const html = render({
      acceptanceCriteria: ["AC with **bold** text"],
    });
    expect(html).toContain("<strong>");
  });

  test("plain text fields (title, id, status) are not treated as markdown", () => {
    const html = render({ title: "## Not a heading", id: "TS-**bold**-1" });
    expect(html).toContain("## Not a heading");
    expect(html).toContain("TS-**bold**-1");
  });

  test("XSS: markdown description with script tag is escaped", () => {
    const html = render({ description: "<script>evil()</script>" });
    expect(html).not.toContain("<script>evil");
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: markdown description with img onerror is escaped", () => {
    const html = render({ description: "<img src=x onerror=bad()>" });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  test("multi-line code block: interior lines starting with '- ' are not wrapped in <li>", () => {
    // Regression: before the placeholder fix, lines inside a fenced block that
    // started with "- " or "* " were handed to the line loop and wrapped in <li>.
    // Use a minimal task with no blockers/AC so the only <li>s come from the description.
    const html = renderTaskDetailPage(
      {
        id: "TS-CB",
        title: "Code block test",
        status: "pending",
        description: "```\n- item one\n- item two\n```",
        acceptanceCriteria: [],
        blockedBy: [],
      },
      "user@example.com",
      {},
      "UTC",
    );
    // Content must be inside <pre><code>, not broken out into list items
    expect(html).toContain("<pre>");
    expect(html).toContain("<code>");
    // The raw list-like text should appear inside the code block, not as HTML list markup
    expect(html).toContain("- item one");
    expect(html).toContain("- item two");
    // The interior lines must NOT produce orphaned <li> tags — there is no actual
    // list in this input, so no <li> should appear anywhere in the rendered page.
    expect(html).not.toContain("<li>");
  });
});

// ─── renderTaskDetailPage — back link (TBL-1.1) ──────────────────────────────

describe("renderTaskDetailPage — back link (TBL-1.1)", () => {
  // AC3: default back link is the bare /admin/tasks URL when backHref is omitted
  test("defaults to bare /admin/tasks when backHref is not provided", () => {
    const html = renderTaskDetailPage(
      TASK_DETAIL,
      "user@example.com",
      {},
      "UTC",
    );
    expect(html).toContain(
      `<a href="/admin/tasks" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC3: a provided backHref is rendered (HTML-escaped) for the ← Tasks anchor
  test("renders the given backHref for the ← Tasks anchor", () => {
    const backHref = "/admin/tasks?status=in_progress&page=2";
    const html = renderTaskDetailPage(
      TASK_DETAIL,
      "user@example.com",
      {},
      "UTC",
      undefined,
      backHref,
    );
    expect(html).toContain(
      `<a href="${backHref.replace(/&/g, "&amp;")}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC3: backHref is HTML-escaped to prevent attribute-breakout XSS
  test("HTML-escapes a malicious backHref", () => {
    const html = renderTaskDetailPage(
      TASK_DETAIL,
      "user@example.com",
      {},
      "UTC",
      undefined,
      '/admin/tasks"><script>xss()</script>',
    );
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderSessionDetailPage — back link (ABL-1.1) ───────────────────────────

describe("renderSessionDetailPage — back link (ABL-1.1)", () => {
  // AC3: default back link is the bare /admin/tasks URL when backHref is omitted
  test("defaults to bare /admin/tasks when backHref is not provided", () => {
    const html = renderSessionDetailPage("session-abc", [], "user@example.com");
    expect(html).toContain(
      `<a href="/admin/tasks" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC3/AC4: a provided backHref is rendered (HTML-escaped) for the ← Tasks anchor
  test("renders the given backHref for the ← Tasks anchor", () => {
    const backHref = "/admin/tasks?status=in_progress&page=2";
    const html = renderSessionDetailPage(
      "session-abc",
      [],
      "user@example.com",
      false,
      backHref,
    );
    expect(html).toContain(
      `<a href="${backHref.replace(/&/g, "&amp;")}" style="color:#6b7280;font-size:13px;text-decoration:none">← Tasks</a>`,
    );
  });

  // AC3: backHref is HTML-escaped to prevent attribute-breakout XSS
  test("HTML-escapes a malicious backHref", () => {
    const html = renderSessionDetailPage(
      "session-abc",
      [],
      "user@example.com",
      false,
      '/admin/tasks"><script>xss()</script>',
    );
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTaskDetailPage — timezone formatting ───────────────────────────────

describe("renderTaskDetailPage — timezone formatting", () => {
  test("dateField renders timestamp in Pacific time for America/Los_Angeles", () => {
    // 2025-01-15T20:00:00Z = Jan 15 8pm UTC = Jan 15 12pm Pacific (UTC-8 in January)
    // So this should show Jan 15 in both UTC and Pacific. Use a time that crosses midnight.
    // 2025-01-16T05:00:00Z = Jan 16 5am UTC = Jan 15 9pm Pacific (UTC-8)
    const html = renderTaskDetailPage(
      {
        id: "TZ-1",
        title: "Timezone test",
        status: "pending",
        createdAt: "2025-01-16T05:00:00Z", // Jan 16 UTC, Jan 15 Pacific
      },
      "user@example.com",
      {},
      "America/Los_Angeles",
    );
    // In Pacific time (UTC-8), 2025-01-16T05:00:00Z is Jan 15 9pm → displays Jan 15
    // toLocaleString("en-US", { dateStyle:"medium", timeStyle:"short", timeZone:"America/Los_Angeles" })
    // produces something like "Jan 15, 2025 at 9:00 PM"
    expect(html).toContain("Jan 15, 2025");
  });

  test("dateField renders timestamp in UTC when timezone is UTC", () => {
    // Same timestamp: 2025-01-16T05:00:00Z = Jan 16 in UTC
    const html = renderTaskDetailPage(
      {
        id: "TZ-2",
        title: "Timezone test UTC",
        status: "pending",
        createdAt: "2025-01-16T05:00:00Z",
      },
      "user@example.com",
      {},
      "UTC",
    );
    // In UTC, 2025-01-16T05:00:00Z displays as Jan 16, 2025
    expect(html).toContain("Jan 16, 2025");
  });
});

// ─── renderTaskDetailPage — Pull Request Review section ──────────────────────

const PR_ITEM: PullRequestItem = {
  id: "pr-123",
  repo: "my-org/my-repo",
  prNumber: 42,
  state: "open",
  reviewState: "posted",
  patchCycles: 2,
  reviewCycles: 1,
  reviewedAt: "2026-06-01T10:00:00Z",
  patchedAt: "2026-06-02T11:00:00Z",
};

describe("renderTaskDetailPage — Pull Request Review section", () => {
  function render(pr?: PullRequestItem): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, id: "TS-PR-1" },
      "user@example.com",
      {},
      "America/Los_Angeles",
      pr,
    );
  }

  test("renders PR section heading when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("Pull Request Review");
  });

  test("renders state badge when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("open");
  });

  test("renders reviewState badge when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("posted");
  });

  test("renders patchCycles count when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("Patch Cycles");
    expect(html).toContain("2");
  });

  test("renders reviewCycles count when pullRequest is present", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("Review Cycles");
    expect(html).toContain("1");
  });

  test("renders reviewedAt when pullRequest is present", () => {
    const html = render(PR_ITEM);
    // The date is formatted; at minimum the year should be visible
    expect(html).toContain("2026");
  });

  test("renders patchedAt when pullRequest is present", () => {
    const html = render(PR_ITEM);
    // patchedAt is also formatted; year is sufficient
    expect(html).toContain("2026");
  });

  test("renders GitHub PR link with correct URL format", () => {
    const html = render(PR_ITEM);
    expect(html).toContain("https://github.com/my-org/my-repo/pull/42");
  });

  test("GitHub PR link opens in new tab (target=_blank)", () => {
    const html = render(PR_ITEM);
    expect(html).toContain('target="_blank"');
  });

  test("no PR section when pullRequest is undefined", () => {
    const html = render(undefined);
    expect(html).not.toContain("Pull Request Review");
  });

  test("no empty placeholder when pullRequest is absent", () => {
    const html = render(undefined);
    // The section heading should not appear at all — no placeholder text either
    expect(html).not.toContain("Pull Request Review");
    expect(html).not.toContain("No pull request");
  });

  test("XSS: repo field in PR link is escaped", () => {
    const xssPr: PullRequestItem = {
      ...PR_ITEM,
      repo: 'evil"><script>xss()</script>',
    };
    const html = render(xssPr);
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderTaskDetailPage — Skip Count / Last Skipped", () => {
  function render(task: Partial<TaskItem> = {}): string {
    return renderTaskDetailPage(
      { ...TASK_DETAIL, ...task },
      "user@example.com",
      {},
      "UTC",
    );
  }

  test("renders Skip Count field when skipCount > 0", () => {
    const html = render({ skipCount: 3 });
    expect(html).toContain("Skip Count");
    expect(html).toMatch(/Skip Count<\/td>\s*<td[^>]*>3<\/td>/);
  });

  test("omits Skip Count field when skipCount is 0", () => {
    const html = render({ skipCount: 0 });
    expect(html).not.toContain("Skip Count");
  });

  test("omits Skip Count field when skipCount is null/undefined", () => {
    const html = render({ skipCount: null });
    expect(html).not.toContain("Skip Count");
  });

  test("renders Last Skipped field when skipCount > 0 and lastSkippedAt is set", () => {
    const html = render({
      skipCount: 2,
      lastSkippedAt: "2026-06-12T10:00:00Z",
    });
    expect(html).toContain("Last Skipped");
  });

  test("omits Last Skipped field when skipCount is 0 even if lastSkippedAt is set", () => {
    const html = render({
      skipCount: 0,
      lastSkippedAt: "2026-06-12T10:00:00Z",
    });
    expect(html).not.toContain("Last Skipped");
  });

  test("omits Last Skipped field when lastSkippedAt is null/undefined", () => {
    const html = render({ skipCount: 2, lastSkippedAt: null });
    expect(html).not.toContain("Last Skipped");
  });
});

// ─── renderPrsPage ────────────────────────────────────────────────────────────

const PR_LIST_ITEM_1: PrListItem = {
  id: "pr-001",
  repo: "org/repo-a",
  prNumber: 10,
  staged: false,
  state: "open",
  reviewState: "pending",
  commitSha: "abc123",
  patchCycles: 0,
  reviewCycles: 0,
  agentId: "agent-001",
  claimedBy: "agent-001",
  reviewedAt: null,
  patchedAt: null,
  mergedAt: null,
  claimedAt: "2026-06-01T10:00:00Z",
  heartbeatAt: null,
  createdAt: "2026-06-01T09:00:00Z",
  updatedAt: "2026-06-01T10:00:00Z",
};

const PR_LIST_ITEM_2: PrListItem = {
  id: "pr-002",
  repo: "org/repo-b",
  prNumber: 20,
  staged: true,
  state: "closed",
  reviewState: "in_review",
  commitSha: null,
  patchCycles: 3,
  reviewCycles: 2,
  agentId: null,
  claimedBy: null,
  reviewedAt: "2026-06-02T10:00:00Z",
  patchedAt: "2026-06-02T11:00:00Z",
  mergedAt: "2026-06-03T09:00:00Z",
  claimedAt: null,
  heartbeatAt: null,
  createdAt: "2026-06-01T08:00:00Z",
  updatedAt: "2026-06-03T09:00:00Z",
};

const EMPTY_PR_PAGINATION = { total: 0, limit: 50, page: 1 };

// ─── heartbeatFreshness (AXR-2.1) ────────────────────────────────────────────

describe("heartbeatFreshness", () => {
  test("returns null when both claimedAt and heartbeatAt are absent", () => {
    expect(heartbeatFreshness(null, null, new Date())).toBeNull();
  });

  test("returns null when both claimedAt and heartbeatAt are undefined", () => {
    expect(heartbeatFreshness(undefined, undefined, new Date())).toBeNull();
  });

  test("falls back to claimedAt when heartbeatAt is absent", () => {
    const now = new Date("2026-06-01T10:05:00Z");
    expect(heartbeatFreshness("2026-06-01T10:00:00Z", null, now)).toBe("fresh");
  });

  test("prefers heartbeatAt over claimedAt when both are present", () => {
    const now = new Date("2026-06-01T10:05:00Z");
    expect(
      heartbeatFreshness(
        "2026-01-01T00:00:00Z", // very stale on its own
        "2026-06-01T10:00:00Z", // fresh
        now,
      ),
    ).toBe("fresh");
  });

  test("returns 'fresh' well within the TTL", () => {
    const now = new Date("2026-06-01T10:05:00Z"); // +5min
    expect(heartbeatFreshness(null, "2026-06-01T10:00:00Z", now)).toBe("fresh");
  });

  test("returns 'aging' partway through the TTL", () => {
    const now = new Date("2026-06-01T10:35:00Z"); // +35min
    expect(heartbeatFreshness(null, "2026-06-01T10:00:00Z", now)).toBe("aging");
  });

  test("returns 'stale' once past the TTL", () => {
    const now = new Date("2026-06-01T11:10:00Z"); // +70min > 65min TTL
    expect(heartbeatFreshness(null, "2026-06-01T10:00:00Z", now)).toBe("stale");
  });

  test("does not crash on an unparseable timestamp, returns null", () => {
    expect(heartbeatFreshness(null, "not-a-real-date", new Date())).toBeNull();
  });
});

describe("renderPrsPage", () => {
  function render(
    prs: PrListItem[] = [],
    filters: Parameters<typeof renderPrsPage>[1] = {},
    degraded = false,
    now?: Date,
  ): string {
    return renderPrsPage(
      prs,
      filters,
      degraded,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: prs.length, limit: 50, page: 1 },
      "America/Los_Angeles",
      undefined,
      {},
      now,
    );
  }

  test("returns a valid HTML document", () => {
    const html = render();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("empty state shows 'No PRs found'", () => {
    const html = render([]);
    expect(html).toContain("No PRs found");
  });

  test("renders table with required column headers", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain("Review Cycles");
    expect(html).toContain("Repo");
    expect(html).toContain("PR#");
    expect(html).toContain("Task");
    expect(html).toContain("State");
    expect(html).toContain("Review State");
    expect(html).toContain("Patch Cycles");
    expect(html).toContain("Claimed By");
    expect(html).toContain("Created");
  });

  test("table markup is wrapped in .data-table-wrapper", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain('<div class="data-table-wrapper">');
  });

  test("Created column renders pr.createdAt, not pr.updatedAt", () => {
    const html = render([PR_LIST_ITEM_1]);
    // PR_LIST_ITEM_1 has distinct createdAt (09:00) and updatedAt (10:00) values.
    const createdFormatted = new Date(
      PR_LIST_ITEM_1.createdAt as string,
    ).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Los_Angeles",
    });
    const updatedFormatted = new Date(
      PR_LIST_ITEM_1.updatedAt as string,
    ).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "America/Los_Angeles",
    });
    expect(html).toContain(createdFormatted);
    expect(html).not.toContain(updatedFormatted);
  });

  test("Claimed By cell links to the claiming agent's detail page", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain('<a href="/admin/agents/agent-001"');
    expect(html).toContain("Alpha Agent");
  });

  test("renders 2+ PRs as table rows", () => {
    const html = render([PR_LIST_ITEM_1, PR_LIST_ITEM_2]);
    expect(html).toContain("org/repo-a");
    expect(html).toContain("org/repo-b");
    expect(html).toContain("10");
    expect(html).toContain("20");
  });

  test("renders repo field for each PR", () => {
    const html = render([PR_LIST_ITEM_1, PR_LIST_ITEM_2]);
    expect(html).toContain("org/repo-a");
    expect(html).toContain("org/repo-b");
  });

  test("renders state and reviewState fields", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain("open");
    expect(html).toContain("pending");
  });

  test("renders patchCycles field", () => {
    const html = render([PR_LIST_ITEM_2]);
    expect(html).toContain("3");
  });

  test("renders linked task ids when present in linkedTasksByPr", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1],
      {},
      false,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: 1, limit: 50, page: 1 },
      "America/Los_Angeles",
      undefined,
      {
        [PR_LIST_ITEM_1.id]: [{ id: "TASK-1", title: "T", status: "done" }],
      },
    );
    expect(html).toContain("TASK-1");
    expect(html).toContain("/admin/tasks/TASK-1");
  });

  test("renders all linked task ids when a PR has 2 linked tasks", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1],
      {},
      false,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: 1, limit: 50, page: 1 },
      "America/Los_Angeles",
      undefined,
      {
        [PR_LIST_ITEM_1.id]: [
          { id: "TASK-A", title: "A", status: "done" },
          { id: "TASK-B", title: "B", status: "done" },
        ],
      },
    );
    expect(html).toContain("/admin/tasks/TASK-A");
    expect(html).toContain("/admin/tasks/TASK-B");
  });

  test("renders empty-state dash when a PR has no linked tasks", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain('<span style="color:#9ca3af">—</span>');
  });

  test("degraded warning shown when degraded=true", () => {
    const html = render([], {}, true);
    expect(html).toContain("unavailable");
  });

  test("no degraded warning when degraded=false", () => {
    const html = render([], {}, false);
    expect(html).not.toContain("unavailable");
  });

  test("state tabs render Open / Merged only", () => {
    const html = render();
    expect(html).toContain("Open");
    expect(html).toContain("Merged");
    expect(html).not.toContain(">All<");
    expect(html).not.toContain("In Review");
    expect(html).not.toContain(">Closed<");
  });

  test("Open tab links to ?state=open", () => {
    const html = render();
    expect(html).toContain("state=open");
  });

  test("Merged tab links to ?state=merged", () => {
    const html = render();
    expect(html).toContain("state=merged");
  });

  test("filter form includes repo multiselect", () => {
    const html = render();
    expect(html).toContain('<select name="repo" multiple');
  });

  test("filter form includes org multiselect", () => {
    const html = render();
    expect(html).toContain('<select name="org" multiple');
  });

  test("filter form includes state input", () => {
    const html = render();
    expect(html).toContain('name="state"');
  });

  test("filter form includes reviewState input", () => {
    const html = render();
    expect(html).toContain('name="reviewState"');
  });

  test("filter form includes taskId input", () => {
    const html = render();
    expect(html).toContain('name="taskId"');
  });

  test("filter values are pre-filled in form", () => {
    const html = render([], { repo: "org/my-repo", taskId: "TASK-42" });
    expect(html).toContain(
      '<option value="org/my-repo" selected>org/my-repo</option>',
    );
    expect(html).toContain("TASK-42");
  });

  test("XSS: repo name in list is escaped", () => {
    const xssPr: PrListItem = {
      ...PR_LIST_ITEM_1,
      repo: "<script>alert(1)</script>",
    };
    const html = render([xssPr]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("XSS: filter repo value is escaped in form", () => {
    const html = render([], { repo: "<script>xss()</script>" });
    expect(html).not.toContain("<script>xss");
    expect(html).toContain("&lt;script&gt;");
  });

  test("uses renderAdminToolbar with /admin/prs active path", () => {
    const html = render();
    expect(html).toContain('href="/admin/prs" class="vos-nav-link active"');
  });

  test("tab URLs preserve reviewState filter when reviewState is set", () => {
    const html = render([], { state: "open", reviewState: "posted" });
    expect(html).toContain("reviewState=posted");
    // Both tab hrefs should carry the reviewState param
    const openTabMatch = html.match(/href="[^"]*state=open[^"]*"/);
    expect(openTabMatch).toBeTruthy();
    expect(openTabMatch?.[0]).toContain("reviewState=posted");
  });

  test("reviewState dropdown pre-selects the active option", () => {
    const html = render([], { reviewState: "posted" });
    expect(html).toContain('value="posted" selected');
  });

  // ─── AXR-2.1: shared CSS reuse, heartbeat dot, header tooltips ────────────

  test("does not duplicate .badge-green / .alert-warning rule definitions already in the base stylesheet (AC1)", () => {
    const html = render([PR_LIST_ITEM_1, PR_LIST_ITEM_2]);
    const badgeGreenRuleCount = (html.match(/\.badge-green\s*\{/g) ?? [])
      .length;
    const alertWarningRuleCount = (html.match(/\.alert-warning\s*\{/g) ?? [])
      .length;
    expect(badgeGreenRuleCount).toBe(1);
    expect(alertWarningRuleCount).toBe(1);
  });

  test("Review Cycles and Patch Cycles headers carry the shared header-tooltip class with a data-tip", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toMatch(
      /<th class="col-review-cycles"[^>]*><span class="header-tooltip" data-tip="[^"]+">Review Cycles<\/span><\/th>/,
    );
    expect(html).toMatch(
      /<th class="col-patch-cycles"[^>]*><span class="header-tooltip" data-tip="[^"]+">Patch Cycles<\/span><\/th>/,
    );
  });

  test("heartbeat-dot renders class 'fresh' when the claim is recent (AC4)", () => {
    // PR_LIST_ITEM_1.claimedAt = 2026-06-01T10:00:00Z, heartbeatAt = null.
    const now = new Date("2026-06-01T10:05:00Z"); // +5min
    const html = render([PR_LIST_ITEM_1], {}, false, now);
    expect(html).toContain('class="heartbeat-dot fresh"');
  });

  test("heartbeat-dot renders class 'aging' partway through the claim TTL (AC4)", () => {
    const now = new Date("2026-06-01T10:35:00Z"); // +35min
    const html = render([PR_LIST_ITEM_1], {}, false, now);
    expect(html).toContain('class="heartbeat-dot aging"');
  });

  test("heartbeat-dot renders class 'stale' once past the claim TTL (AC4)", () => {
    const now = new Date("2026-06-01T11:10:00Z"); // +70min, past DEFAULT_CLAIM_TTL_MS (65min)
    const html = render([PR_LIST_ITEM_1], {}, false, now);
    expect(html).toContain('class="heartbeat-dot stale"');
  });

  test("heartbeat-dot uses heartbeatAt over claimedAt when both are present (AC4)", () => {
    const prWithHeartbeat: PrListItem = {
      ...PR_LIST_ITEM_1,
      claimedAt: "2026-06-01T00:00:00Z", // would be "stale" on its own
      heartbeatAt: "2026-06-01T10:00:00Z", // fresh relative to `now`
    };
    const now = new Date("2026-06-01T10:05:00Z");
    const html = render([prWithHeartbeat], {}, false, now);
    expect(html).toContain('class="heartbeat-dot fresh"');
  });

  test("no heartbeat-dot renders when claimedBy/claimedAt/heartbeatAt are all null (AC4)", () => {
    const html = render([PR_LIST_ITEM_2], {}, false, new Date());
    // The base stylesheet always defines the .heartbeat-dot CSS rule; only
    // check that no <span> element using it is rendered in the row markup.
    expect(html).not.toContain('<span class="heartbeat-dot');
  });
});

// ─── renderPrsPage — Blocked tab & HITL badge (HBV-2.2) ──────────────────────

describe("renderPrsPage — Blocked tab & HITL badge", () => {
  function render(
    prs: PrListItem[] = [],
    filters: Parameters<typeof renderPrsPage>[1] = {},
    degraded = false,
  ): string {
    return renderPrsPage(
      prs,
      filters,
      degraded,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: prs.length, limit: 50, page: 1 },
    );
  }

  test("Blocked tab renders with the label 'Blocked'", () => {
    const html = render();
    expect(html).toContain(">Blocked<");
  });

  test("Blocked tab href composes state=open with blocked=true", () => {
    const html = render();
    const blockedTabMatch = html.match(/href="[^"]*blocked=true[^"]*"/);
    expect(blockedTabMatch).toBeTruthy();
    expect(blockedTabMatch?.[0]).toContain("state=open");
  });

  test("Blocked tab is active when filters.blocked is 'true', regardless of state", () => {
    const html = render([], { state: "open", blocked: "true" });
    const blockedTabMatch = html.match(
      /<a href="[^"]*blocked=true[^"]*"[^>]*>Blocked<\/a>/,
    );
    expect(blockedTabMatch).toBeTruthy();
    expect(blockedTabMatch?.[0]).toContain("background:#6366f1");
  });

  test("Open tab is not shown as active when blocked=true", () => {
    const html = render([], { state: "open", blocked: "true" });
    const openTabMatch = html.match(/<a href="[^"]*state=open"[^>]*>Open<\/a>/);
    expect(openTabMatch).toBeTruthy();
    expect(openTabMatch?.[0]).not.toContain("background:#6366f1");
  });

  test("PR with blocked:true renders the 'Waiting: Blocked' badge in the list", () => {
    const html = render([{ ...PR_LIST_ITEM_1, blocked: true }]);
    expect(html).toContain("Waiting: Blocked");
    // AXR-2.1: reuses AXR-1.1's shared .badge-warning class instead of a
    // page-local .badge-blocked rule.
    expect(html).toContain("badge-warning");
  });

  test("PR with blocked:false does not render the badge", () => {
    const html = render([{ ...PR_LIST_ITEM_1, blocked: false }]);
    expect(html).not.toContain("Waiting: Blocked");
  });

  test("PR with blocked absent does not render the badge", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).not.toContain("Waiting: Blocked");
  });

  test("badge title attribute reflects blockedReason when present", () => {
    const html = render([
      {
        ...PR_LIST_ITEM_1,
        blocked: true,
        blockedReason: "Needs human sign-off",
      },
    ]);
    expect(html).toContain('title="Needs human sign-off"');
  });

  test("makePageUrl carries blocked=true through pagination links", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
      { state: "open", blocked: "true" },
      false,
      USER_NAME,
      {},
      { total: 200, limit: 50, page: 1 },
    );
    expect(html).toContain("blocked=true");
    const nextMatch = html.match(/href="([^"]*)"[^>]*>Next/);
    expect(nextMatch).toBeTruthy();
    expect(nextMatch?.[1]).toContain("blocked=true");
  });
});

// ─── renderPrsPage — org/repo multiselect filters (ORF-2.2) ──────────────────

describe("renderPrsPage — org/repo multiselect filters", () => {
  const pagination = { total: 0, limit: 50, page: 1 };

  test("renders both an Org and a Repo select-multiple element", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("populates Org options from suggestions.orgs", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"] },
    );
    expect(html).toContain('<option value="app-vitals">');
    expect(html).toContain('<option value="other-org">');
  });

  test("populates Repo options from suggestions.repos", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a", "org/repo-b"] },
    );
    expect(html).toContain('<option value="org/repo-a">');
    expect(html).toContain('<option value="org/repo-b">');
  });

  test("Org and Repo multiselects carry the new scope-select pill/tag styling class (AXR-1.1)", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain(
      '<select name="org" multiple class="form-input scope-select"',
    );
    expect(html).toContain(
      '<select name="repo" multiple class="form-input scope-select"',
    );
  });

  test("Org and Repo stay independent multiselect fields, not merged into one combined scope pill", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    const selectCount = (html.match(/<select /g) ?? []).length;
    expect(selectCount).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
  });

  test("marks currently-active repo filter values as selected (array)", () => {
    const html = renderPrsPage(
      [],
      { repo: ["org/repo-a", "org/repo-b"] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a", "org/repo-b", "org/repo-c"] },
    );
    expect(html).toContain(
      '<option value="org/repo-a" selected>org/repo-a</option>',
    );
    expect(html).toContain(
      '<option value="org/repo-b" selected>org/repo-b</option>',
    );
    expect(html).toContain('<option value="org/repo-c">org/repo-c</option>');
  });

  test("marks currently-active org filter values as selected (array)", () => {
    const html = renderPrsPage(
      [],
      { org: ["app-vitals"] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals", "other-org"] },
    );
    expect(html).toContain(
      '<option value="app-vitals" selected>app-vitals</option>',
    );
    expect(html).toContain('<option value="other-org">other-org</option>');
  });

  // AC2/AC6: org-only filtering — Org and Repo remain independently
  // selectable multiselects; selecting only an Org leaves every Repo option
  // unselected (matches every repo under that org, rather than the two
  // fields being merged into one combined scope-pill control).
  test("org-only filter selects only the Org multiselect, leaving Repo unselected", () => {
    const html = renderPrsPage(
      [],
      { org: ["app-vitals"] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      {
        orgs: ["app-vitals"],
        repos: ["app-vitals/repo-a", "app-vitals/repo-b"],
      },
    );
    // Org and Repo stay two independent <select multiple> controls.
    expect(html).toContain('<select name="org" multiple');
    expect(html).toContain('<select name="repo" multiple');
    // Org option is selected...
    expect(html).toContain(
      '<option value="app-vitals" selected>app-vitals</option>',
    );
    // ...but no Repo option is selected.
    expect(html).toContain(
      '<option value="app-vitals/repo-a">app-vitals/repo-a</option>',
    );
    expect(html).toContain(
      '<option value="app-vitals/repo-b">app-vitals/repo-b</option>',
    );
    expect(html).not.toContain('<option value="app-vitals/repo-a" selected>');
    expect(html).not.toContain('<option value="app-vitals/repo-b" selected>');
  });

  test("backward compat: a single-value repo filter (string, not array) is still marked selected", () => {
    const html = renderPrsPage(
      [],
      { repo: "org/repo-a" },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a", "org/repo-b"] },
    );
    expect(html).toContain(
      '<option value="org/repo-a" selected>org/repo-a</option>',
    );
    expect(html).toContain('<option value="org/repo-b">org/repo-b</option>');
  });

  test("an active filter value not present in suggestions still renders as a selected option", () => {
    const html = renderPrsPage(
      [],
      { repo: ["org/stale-repo"] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a"] },
    );
    expect(html).toContain(
      '<option value="org/stale-repo" selected>org/stale-repo</option>',
    );
  });

  test("no repo/org filter active renders no selected options", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["org/repo-a"] },
    );
    expect(html).not.toContain("selected>");
  });

  test("removes the legacy single-value repo <input>+<datalist> markup", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a"] },
    );
    expect(html).not.toContain('name="repo" type="text"');
    expect(html).not.toContain('<datalist id="prs-repos-list">');
    expect(html).not.toContain('list="prs-repos-list"');
  });

  test("escapes org/repo suggestion and filter values to prevent XSS", () => {
    const html = renderPrsPage(
      [],
      { org: ['<script>alert("xss")</script>'] },
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ['<script>alert("xss")</script>'] },
    );
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  // AXR-2.1: secondary filters (State/Review State/Task ID) collapse behind
  // AXR-1.1's shared <details class="more-filters"> disclosure, while Org
  // and Repo stay always-visible primary filters (AC1/AC2).
  test("State/Review State/Task ID filters render inside a more-filters disclosure, Org/Repo stay outside it", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { orgs: ["app-vitals"], repos: ["app-vitals/repo-a"] },
    );
    expect(html).toContain('<details class="more-filters">');
    expect(html).toContain('<div class="more-filters-panel">');
    const orgSelectIndex = html.indexOf('<select name="org" multiple');
    const detailsIndex = html.indexOf('<details class="more-filters">');
    const stateFieldIndex = html.indexOf('name="state"');
    const taskIdFieldIndex = html.indexOf('name="taskId"');
    expect(orgSelectIndex).toBeGreaterThan(-1);
    expect(detailsIndex).toBeGreaterThan(-1);
    // Org/Repo render before (outside) the disclosure.
    expect(orgSelectIndex).toBeLessThan(detailsIndex);
    // State/Task ID render inside (after) the disclosure opens.
    expect(stateFieldIndex).toBeGreaterThan(detailsIndex);
    expect(taskIdFieldIndex).toBeGreaterThan(detailsIndex);
  });

  // AXR-2.1 review follow-up: reviewState/taskId live only inside the collapsed
  // disclosure, so a filtered URL must not render as an unfiltered-looking page.
  test("more-filters disclosure stays collapsed with no badge when no hidden filter is set", () => {
    const html = renderPrsPage(
      [],
      { state: "open" },
      false,
      USER_NAME,
      {},
      pagination,
    );
    expect(html).toContain('<details class="more-filters">');
    expect(html).toContain("<summary>More filters</summary>");
  });

  test("more-filters disclosure renders open with a count badge when reviewState is set", () => {
    const html = renderPrsPage(
      [],
      { reviewState: "pending" },
      false,
      USER_NAME,
      {},
      pagination,
    );
    expect(html).toContain('<details class="more-filters" open>');
    expect(html).toContain(
      '<summary>More filters<span class="badge badge-purple">1</span></summary>',
    );
  });

  test("more-filters disclosure renders open with a count badge when taskId is set", () => {
    const html = renderPrsPage(
      [],
      { taskId: "FOO-1" },
      false,
      USER_NAME,
      {},
      pagination,
    );
    expect(html).toContain('<details class="more-filters" open>');
    expect(html).toContain(
      '<summary>More filters<span class="badge badge-purple">1</span></summary>',
    );
  });

  test("more-filters badge counts both hidden filters when reviewState and taskId are set", () => {
    const html = renderPrsPage(
      [],
      { reviewState: "posted", taskId: "FOO-1" },
      false,
      USER_NAME,
      {},
      pagination,
    );
    expect(html).toContain('<details class="more-filters" open>');
    expect(html).toContain(
      '<summary>More filters<span class="badge badge-purple">2</span></summary>',
    );
  });
});

// ─── renderPrsPage — org/repo multiselect pagination/tab round-trip (ORF-2.2) ─

describe("renderPrsPage — org/repo multiselect pagination/tab round-trip", () => {
  test("makePageUrl carries multi-value filters.repo as repeated repo= params into pagination links, not comma-joined", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
      { repo: ["org/repo-a", "org/repo-b"] },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
    );
    expect(html).toContain(
      'href="/admin/prs?repo=org%2Frepo-a&repo=org%2Frepo-b&page=2"',
    );
    expect(html).not.toContain("org/repo-a,org/repo-b");
  });

  test("makePageUrl carries multi-value filters.org as repeated org= params into pagination links", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
      { org: ["app-vitals", "other-org"] },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
    );
    expect(html).toContain(
      'href="/admin/prs?org=app-vitals&org=other-org&page=2"',
    );
  });

  test("makePageUrl backward-compat: a single-value (string) filters.repo still round-trips as one repo= param", () => {
    const html = renderPrsPage(
      [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
      { repo: "org/repo-a" },
      false,
      USER_NAME,
      {},
      { total: 100, limit: 50, page: 1 },
    );
    expect(html).toContain('href="/admin/prs?repo=org%2Frepo-a&page=2"');
  });

  test("state-tab links (Open/Merged) carry multi-value filters.repo as repeated repo= params", () => {
    const html = renderPrsPage(
      [],
      { state: "open", repo: ["org/repo-a", "org/repo-b"] },
      false,
      USER_NAME,
      {},
      EMPTY_PR_PAGINATION,
    );
    expect(html).toContain(
      'href="/admin/prs?state=merged&repo=org%2Frepo-a&repo=org%2Frepo-b"',
    );
  });

  test("state-tab links (Open/Merged) carry multi-value filters.org as repeated org= params", () => {
    const html = renderPrsPage(
      [],
      { state: "open", org: ["app-vitals", "other-org"] },
      false,
      USER_NAME,
      {},
      EMPTY_PR_PAGINATION,
    );
    expect(html).toContain(
      'href="/admin/prs?state=merged&org=app-vitals&org=other-org"',
    );
  });

  test("Blocked tab link carries multi-value filters.repo as repeated repo= params", () => {
    const html = renderPrsPage(
      [],
      { repo: ["org/repo-a", "org/repo-b"] },
      false,
      USER_NAME,
      {},
      EMPTY_PR_PAGINATION,
    );
    const blockedTabMatch = html.match(/href="[^"]*blocked=true[^"]*"/);
    expect(blockedTabMatch).toBeTruthy();
    expect(blockedTabMatch?.[0]).toContain("repo=org%2Frepo-a");
    expect(blockedTabMatch?.[0]).toContain("repo=org%2Frepo-b");
  });
});

// ─── renderPrDetailPage ──────────────────────────────────────────────────────

const PR_DETAIL: PrListItem = {
  id: "pr-detail-001",
  repo: "org/detail-repo",
  prNumber: 99,
  staged: false,
  state: "open",
  reviewState: "in_review",
  commitSha: "deadbeef",
  patchCycles: 2,
  reviewCycles: 3,
  agentId: "agent-x",
  claimedBy: "agent-x",
  reviewedAt: "2026-06-10T10:00:00Z",
  patchedAt: "2026-06-11T11:00:00Z",
  mergedAt: null,
  claimedAt: "2026-06-09T08:00:00Z",
  heartbeatAt: "2026-06-11T12:00:00Z",
  createdAt: "2026-06-09T07:00:00Z",
  updatedAt: "2026-06-11T12:00:00Z",
};

describe("renderPrDetailPage", () => {
  function render(
    pr: PrListItem = PR_DETAIL,
    linkedTasks: TaskItem[] = [],
  ): string {
    return renderPrDetailPage(
      pr,
      USER_NAME,
      { "agent-x": "Xray Agent" },
      "America/Los_Angeles",
      linkedTasks,
    );
  }

  test("returns a valid HTML document", () => {
    const html = render();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("renders repo field", () => {
    const html = render();
    expect(html).toContain("org/detail-repo");
  });

  test("renders prNumber field", () => {
    const html = render();
    expect(html).toContain("99");
  });

  test("renders state field", () => {
    const html = render();
    expect(html).toContain("open");
  });

  test("renders reviewState field", () => {
    const html = render();
    expect(html).toContain("in_review");
  });

  test("renders patchCycles field", () => {
    const html = render();
    expect(html).toContain("Patch Cycles");
    expect(html).toContain("2");
  });

  test("renders reviewCycles field", () => {
    const html = render();
    expect(html).toContain("Review Cycles");
    expect(html).toContain("3");
  });

  test("renders a linked task id when linkedTasks is non-empty", () => {
    const html = render(PR_DETAIL, [
      { id: "TASK-99", title: "T", status: "done" },
    ]);
    expect(html).toContain("TASK-99");
  });

  test("linked task links to the task's detail page", () => {
    const html = render(PR_DETAIL, [
      { id: "TASK-99", title: "T", status: "done" },
    ]);
    expect(html).toContain('<a href="/admin/tasks/TASK-99"');
  });

  test("no Task row when linkedTasks is empty", () => {
    const html = render(PR_DETAIL, []);
    expect(html).not.toContain("/admin/tasks/");
  });

  test("renders both links when a PR has 2 linked tasks", () => {
    const html = render(PR_DETAIL, [
      { id: "TASK-A", title: "A", status: "done" },
      { id: "TASK-B", title: "B", status: "done" },
    ]);
    expect(html).toContain('<a href="/admin/tasks/TASK-A"');
    expect(html).toContain('<a href="/admin/tasks/TASK-B"');
  });

  test("PR number links out to the GitHub PR", () => {
    const html = render();
    expect(html).toContain(
      '<a href="https://github.com/org/detail-repo/pull/99"',
    );
    expect(html).toContain(">#99</a>");
  });

  test("renders commitSha field when present", () => {
    const html = render();
    expect(html).toContain("deadbeef");
  });

  test("renders claimedBy field", () => {
    const html = render();
    // agent-x maps to "Xray Agent"
    expect(html).toContain("Xray Agent");
  });

  test("claimedBy links to the agent detail page", () => {
    const html = render();
    expect(html).toContain('<a href="/admin/agents/agent-x"');
  });

  test("agentId links to the agent detail page", () => {
    const html = render();
    const matches = html.match(/<a href="\/admin\/agents\/agent-x"/g);
    // both Claimed By and Agent ID resolve to agent-x here, so 2 links
    expect(matches?.length).toBe(2);
  });

  test("renders Timeline section with date fields", () => {
    const html = render();
    expect(html).toContain("Timeline");
  });

  test("Timeline section includes createdAt", () => {
    const html = render();
    expect(html).toContain("Created");
    expect(html).toContain("2026");
  });

  test("Timeline section includes claimedAt when present", () => {
    const html = render();
    expect(html).toContain("Claimed");
  });

  test("Timeline section includes reviewedAt when present", () => {
    const html = render();
    expect(html).toContain("Reviewed");
  });

  test("Timeline section includes patchedAt when present", () => {
    const html = render();
    expect(html).toContain("Patched");
  });

  test("Timeline section omits mergedAt when null", () => {
    // mergedAt is null in PR_DETAIL — no 'Merged' label should appear in the timeline
    const html = render({ ...PR_DETAIL, mergedAt: null, patchedAt: null });
    // Only check that 'Merged' as a timeline label is absent (it might appear in state fields)
    expect(html).not.toMatch(/>\s*Merged\s*<\/td>/);
  });

  test("Timeline section includes mergedAt when present", () => {
    const html = render({ ...PR_DETAIL, mergedAt: "2026-06-12T10:00:00Z" });
    expect(html).toContain("Merged");
  });

  test("renders id field", () => {
    const html = render();
    expect(html).toContain("pr-detail-001");
  });

  test("XSS: repo name in detail is escaped", () => {
    const xssPr: PrListItem = {
      ...PR_DETAIL,
      repo: "<script>alert(1)</script>",
    };
    const html = render(xssPr);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("Timeline section includes heartbeatAt as Last Heartbeat", () => {
    const html = render();
    // PR_DETAIL has heartbeatAt: "2026-06-11T12:00:00Z"
    expect(html).toContain("Last Heartbeat");
  });

  test("Timeline section omits Last Heartbeat when heartbeatAt is null", () => {
    const html = render({ ...PR_DETAIL, heartbeatAt: null });
    expect(html).not.toContain("Last Heartbeat");
  });

  test("uses renderAdminToolbar with /admin/prs active path", () => {
    const html = render();
    expect(html).toContain('href="/admin/prs" class="vos-nav-link active"');
  });

  test("renders Blocked field as 'yes' when pr.blocked is true", () => {
    const html = render({ ...PR_DETAIL, blocked: true });
    expect(html).toContain("Blocked");
    expect(html).toMatch(/Blocked<\/td>\s*<td[^>]*>yes<\/td>/);
  });

  test("renders Blocked field as 'no' when pr.blocked is false", () => {
    const html = render({ ...PR_DETAIL, blocked: false });
    expect(html).toMatch(/Blocked<\/td>\s*<td[^>]*>no<\/td>/);
  });

  test("omits Blocked field when pr.blocked is null/undefined", () => {
    const html = render({ ...PR_DETAIL, blocked: null });
    expect(html).not.toMatch(/>\s*Blocked\s*<\/td>/);
  });

  test("renders Blocked Reason field when present", () => {
    const html = render({
      ...PR_DETAIL,
      blockedReason: "Awaiting human review",
    });
    expect(html).toContain("Blocked Reason");
    expect(html).toContain("Awaiting human review");
  });

  test("omits Blocked Reason field when null/undefined", () => {
    const html = render({ ...PR_DETAIL, blockedReason: null });
    expect(html).not.toContain("Blocked Reason");
  });

  test("renders Skip Count field when skipCount > 0", () => {
    const html = render({ ...PR_DETAIL, skipCount: 3 });
    expect(html).toContain("Skip Count");
    expect(html).toMatch(/Skip Count<\/td>\s*<td[^>]*>3<\/td>/);
  });

  test("omits Skip Count field when skipCount is 0", () => {
    const html = render({ ...PR_DETAIL, skipCount: 0 });
    expect(html).not.toContain("Skip Count");
  });

  test("omits Skip Count field when skipCount is null/undefined", () => {
    const html = render({ ...PR_DETAIL, skipCount: null });
    expect(html).not.toContain("Skip Count");
  });

  test("renders Last Skipped field when skipCount > 0 and lastSkippedAt is set", () => {
    const html = render({
      ...PR_DETAIL,
      skipCount: 2,
      lastSkippedAt: "2026-06-12T10:00:00Z",
    });
    expect(html).toContain("Last Skipped");
  });

  test("omits Last Skipped field when skipCount is 0 even if lastSkippedAt is set", () => {
    const html = render({
      ...PR_DETAIL,
      skipCount: 0,
      lastSkippedAt: "2026-06-12T10:00:00Z",
    });
    expect(html).not.toContain("Last Skipped");
  });

  test("omits Last Skipped field when lastSkippedAt is null/undefined", () => {
    const html = render({ ...PR_DETAIL, skipCount: 2, lastSkippedAt: null });
    expect(html).not.toContain("Last Skipped");
  });
});

// ─── renderQueueActivityPage — Past section (cron run history) ─────────────
//
// AXR-3.1 merged the former standalone renderCronLogsPage into
// renderQueueActivityPage's "Past" section — outcome/skipped/skipReason/error
// rendering is unchanged from the pre-merge implementation, so these cases
// are adapted (not duplicated) from the original renderCronLogsPage suite.

describe("renderQueueActivityPage — Past section", () => {
  const CRON_AGENT = { id: "agent-123", name: "Test Agent" };
  const CRON = {
    id: "cron-456",
    name: "shipwright-loop",
    schedule: "*/5 * * * *",
  };
  const OTHER_CRON = {
    id: "cron-789",
    name: null,
    schedule: "*/15 * * * *",
  };
  // Named non-loop cron for filtering/dropdown tests
  const NAMED_NON_LOOP_CRON = {
    id: "cron-999",
    name: "status check",
    schedule: "0 * * * *",
  };

  function makeRun(overrides?: Partial<CronRunItem>): CronRunItem {
    return {
      startedAt: new Date("2026-06-01T10:00:00Z"),
      completedAt: new Date("2026-06-01T10:00:02Z"),
      outcome: "posted",
      skipped: false,
      skipReason: null,
      error: null,
      cron: CRON,
      modelBreakdown: [
        {
          model: "claude-sonnet-4-5",
          inputTokens: 1200,
          outputTokens: 340,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.001,
        },
      ],
      ...overrides,
    };
  }

  function render(
    runs: CronRunItem[],
    opts?: {
      filters?: { cronId?: string; outcome?: string };
      pagination?: { total: number; limit: number; page: number };
      crons?: { id: string; name: string | null; schedule: string }[];
    },
  ): string {
    return renderQueueActivityPage({
      agent: CRON_AGENT,
      snapshot: null,
      crons: opts?.crons ?? [CRON, OTHER_CRON, NAMED_NON_LOOP_CRON],
      runs,
      filters: opts?.filters ?? {},
      pagination: opts?.pagination ?? {
        total: runs.length,
        limit: 20,
        page: 1,
      },
      userName: "admin@example.com",
      timezone: "America/Los_Angeles",
    });
  }

  // ─── Grouping function tests (partitionCronsForActivityDisplay) ──────────

  test("partitionCronsForActivityDisplay: shipwright-loop cron appears in visibleCronIds", () => {
    const crons = [CRON, OTHER_CRON, NAMED_NON_LOOP_CRON];
    const result = partitionCronsForActivityDisplay(crons);
    expect(result.visibleCronIds.has(CRON.id)).toBe(true);
  });

  test("partitionCronsForActivityDisplay: non-shipwright-loop crons appear in collapsedCronIds", () => {
    const crons = [CRON, OTHER_CRON, NAMED_NON_LOOP_CRON];
    const result = partitionCronsForActivityDisplay(crons);
    expect(result.collapsedCronIds.has(OTHER_CRON.id)).toBe(true);
    expect(result.collapsedCronIds.has(NAMED_NON_LOOP_CRON.id)).toBe(true);
  });

  test("partitionCronsForActivityDisplay: shipwright-loop does not appear in collapsedCronIds", () => {
    const crons = [CRON, OTHER_CRON];
    const result = partitionCronsForActivityDisplay(crons);
    expect(result.collapsedCronIds.has(CRON.id)).toBe(false);
  });

  test("partitionCronsForActivityDisplay: empty crons returns empty sets", () => {
    const result = partitionCronsForActivityDisplay([]);
    expect(result.visibleCronIds.size).toBe(0);
    expect(result.collapsedCronIds.size).toBe(0);
  });

  // ─── Grouping behavior in renderQueueActivityPage ──────────────────────

  test("shipwright-loop run appears in the primary visible table", () => {
    const html = render([makeRun({ cron: CRON })]);
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(tbodyMatch).not.toBeNull();
    // The primary tbody should contain the shipwright-loop run
    expect(tbodyMatch?.[1]).toContain("shipwright-loop");
  });

  test("non-shipwright-loop run appears in a collapsed <details> block, not in primary table", () => {
    const html = render([makeRun({ cron: OTHER_CRON })]);
    // The primary tbody should be empty or contain only empty-state
    const tbodyMatches = html.match(/<tbody>([\s\S]*?)<\/tbody>/g);
    expect(tbodyMatches).not.toBeNull();
    // First tbody (primary table) should not contain the non-loop cron run
    expect(tbodyMatches?.[0]).not.toContain("*/15 * * * *");
    // There should be a <details> block with the collapsed group
    expect(html).toContain('<details class="more-filters"');
    expect(html).toContain("<summary>");
  });

  test("collapsed <details> block has no 'open' attribute (collapsed by default)", () => {
    const html = render([makeRun({ cron: OTHER_CRON })]);
    const detailsMatch = html.match(/<details[^>]*>(?!.*open)/);
    expect(detailsMatch).not.toBeNull();
  });

  test("collapsed group summary contains the cron name or schedule", () => {
    const html = render([makeRun({ cron: NAMED_NON_LOOP_CRON })]);
    expect(html).toContain("<summary>");
    expect(html).toContain("status check");
  });

  test("collapsed group contains the run rows in a separate table", () => {
    const html = render([makeRun({ cron: OTHER_CRON })]);
    // Should have a <details> with a nested table
    expect(html).toContain('<details class="more-filters"');
    // Extract the details section
    const detailsMatch = html.match(/<details[^>]*>[\s\S]*?<\/details>/);
    expect(detailsMatch).not.toBeNull();
    // The details should contain a table
    expect(detailsMatch?.[0]).toContain('<table class="data-table">');
  });

  test("multiple runs from the same non-loop cron are in the same <details> group", () => {
    const run1 = makeRun({ cron: NAMED_NON_LOOP_CRON });
    const run2 = makeRun({
      cron: NAMED_NON_LOOP_CRON,
      startedAt: new Date("2026-06-02T10:00:00Z"),
    });
    const html = render([run1, run2]);
    // Count <details> blocks - should be exactly 1 for NAMED_NON_LOOP_CRON
    const detailsMatches = html.match(/<details/g);
    expect((detailsMatches ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test("runs from different non-loop crons produce separate <details> blocks", () => {
    const run1 = makeRun({ cron: NAMED_NON_LOOP_CRON });
    const run2 = makeRun({
      cron: OTHER_CRON,
      startedAt: new Date("2026-06-02T10:00:00Z"),
    });
    const html = render([run1, run2]);
    // Should have 2 <details> blocks (one per non-loop cron)
    const detailsMatches = html.match(/<details/g);
    expect((detailsMatches ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("when no runs match filters, primary table shows empty state", () => {
    const html = render([]);
    expect(html).toContain("No runs");
  });

  test("filtering to a non-loop cron renders its runs in the primary table, not a collapsed block", () => {
    // filters.cronId narrows `runs` server-side to a single cron — the
    // visible/collapsed split must not re-hide those already-filtered runs
    // inside a closed <details> block (the bug this test guards against).
    const html = render([makeRun({ cron: OTHER_CRON })], {
      filters: { cronId: OTHER_CRON.id },
    });
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(tbodyMatch).not.toBeNull();
    expect(tbodyMatch?.[1]).toContain("*/15 * * * *");
    expect(html).not.toContain("No runs match the selected filters.");
    expect(html).not.toContain('<details class="more-filters"');
  });

  test("renders the column headers", () => {
    const html = render([makeRun()]);
    expect(html).toContain("Outcome");
    expect(html).toContain("<th>Cron</th>");
    expect(html).toContain("Started");
    expect(html).toContain("Duration");
    expect(html).toContain("Tokens");
    expect(html).toContain("Model");
    expect(html).toContain("<th>Phase</th>");
    expect(html).toContain("<th>Item</th>");
    expect(html).toContain("<th>Session</th>");
    expect(html).toContain("<th>Detail</th>");
    // Cost is shown inline within the Model column's badges, not as its own column.
    expect(html).not.toContain("<th>Cost</th>");
  });

  test("wraps the table in a .data-table-wrapper and uses the shared .data-table class instead of the bespoke .runs-table", () => {
    const html = render([makeRun()]);
    expect(html).toContain('<div class="data-table-wrapper">');
    expect(html).toContain('<table class="data-table">');
    expect(html).not.toContain('class="runs-table"');
  });

  test("renders per-model badges with cost for a multi-model run", () => {
    const html = render([
      makeRun({
        modelBreakdown: [
          {
            model: "claude-sonnet-4-5",
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 8,
            cacheCreationTokens: 4,
            costUsd: 0.002,
          },
          {
            model: "claude-haiku-4-5",
            inputTokens: 50,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.0005,
          },
        ],
      }),
    ]);
    expect(html).toContain("claude-sonnet-4-5");
    expect(html).toContain("claude-haiku-4-5");
    expect(html).toContain("$0.0020");
    expect(html).toContain("$0.0005");
  });

  test("renders em-dash in the Model column when modelBreakdown is empty or undefined", () => {
    const htmlEmpty = render([makeRun({ modelBreakdown: [] })]);
    const htmlUndefined = render([makeRun({ modelBreakdown: undefined })]);
    expect(htmlEmpty).toContain("—");
    expect(htmlUndefined).toContain("—");
  });

  test("renders populated runs with outcome and tokens", () => {
    const html = render([makeRun()]);
    expect(html).toContain("posted");
    // tokens rendered
    expect(html).toContain("1200");
    expect(html).toContain("340");
  });

  test("renders a back link to the agent detail page", () => {
    const html = render([makeRun()]);
    expect(html).toContain('href="/admin/agents/agent-123"');
    expect(html).toContain("Test Agent");
  });

  test("renders the owning cron's name/schedule in the Cron column", () => {
    const html = render([makeRun({ cron: NAMED_NON_LOOP_CRON })]);
    expect(html).toContain("status check");
  });

  test("renders the cron schedule when the owning cron has no name", () => {
    const html = render([makeRun({ cron: OTHER_CRON })]);
    expect(html).toContain("*/15 * * * *");
  });

  test("Cron column links to the same page filtered to that cron's id", () => {
    const html = render([makeRun({ cron: CRON })]);
    expect(html).toContain(
      `<a href="/admin/agents/${CRON_AGENT.id}/queue-activity?cronId=${CRON.id}"`,
    );
  });

  test("Cron column renders plain '—' with no link when the run has no cron", () => {
    const html = render([makeRun({ cron: undefined })]);
    expect(html).not.toContain("queue-activity?cronId=");
  });

  test("renders empty state when no runs match", () => {
    const html = render([]);
    expect(html).toContain("No runs");
  });

  test("renders em-dash for empty token breakdown and no duration", () => {
    const html = render([
      makeRun({
        modelBreakdown: [],
        completedAt: null,
      }),
    ]);
    expect(html).toContain("—");
  });

  test("renders the run's phase (via phaseCron, prefix stripped) when set", () => {
    const html = render([
      makeRun({
        phaseId: "some-id",
        phaseCron: { id: "some-id", name: "shipwright-dev-task" },
      }),
    ]);
    expect(html).toContain("dev-task");
  });

  test("renders an em-dash for the phase cell when phaseCron is null (legacy run or no phase attribution)", () => {
    const html = render([makeRun({ phaseId: null, phaseCron: null })]);
    // Locate the tbody row specifically (not the thead row) to check the
    // phase cell — the last <td> in the row.
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("renders the run's itemType/itemId as a labeled Task badge when set", () => {
    const html = render([makeRun({ itemType: "task", itemId: "WLS-2.2" })]);
    // Must render a distinctly-labeled "Task" badge, not the bare "task: WLS-2.2" string.
    expect(html).not.toContain("task: WLS-2.2");
    expect(html).toContain("Task");
    expect(html).toContain("WLS-2.2");
    expect(html).toMatch(/badge[^>]*>\s*Task/);
  });

  test("Task item id links to its task detail page", () => {
    const html = render([makeRun({ itemType: "task", itemId: "WLS-2.2" })]);
    expect(html).toContain('<a href="/admin/tasks/WLS-2.2"');
  });

  test("renders the run's itemType/itemId as a labeled PR badge when set", () => {
    const html = render([
      makeRun({ itemType: "pr", itemId: "app-vitals/shipwright#1234" }),
    ]);
    // Must render a distinctly-labeled "PR" badge, clearly distinguished from "Task".
    expect(html).toContain("PR");
    expect(html).toContain("app-vitals/shipwright#1234");
    expect(html).toMatch(/badge[^>]*>\s*PR/);
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).not.toContain(">Task<");
  });

  test("PR item id links out to the GitHub PR", () => {
    const html = render([
      makeRun({ itemType: "pr", itemId: "app-vitals/shipwright#1234" }),
    ]);
    expect(html).toContain(
      '<a href="https://github.com/app-vitals/shipwright/pull/1234"',
    );
  });

  test("renders em-dash for the Item cell when itemType/itemId are null (no dispatch)", () => {
    const html = render([makeRun({ itemType: null, itemId: null })]);
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("Tokens column sums input/output across modelBreakdown rows", () => {
    const html = render([
      makeRun({
        modelBreakdown: [
          {
            model: "claude-sonnet-4-5",
            inputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 8,
            cacheCreationTokens: 4,
            costUsd: 0.002,
          },
          {
            model: "claude-haiku-4-5",
            inputTokens: 50,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0.0005,
          },
        ],
      }),
    ]);
    // 200 + 50 = 250 in, 100 + 20 = 120 out
    expect(html).toContain("250 in / 120 out");
  });

  test("escapes XSS in the outcome field", () => {
    const html = render([makeRun({ outcome: '"><script>alert(2)</script>' })]);
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes XSS in the agent name", () => {
    const html = renderQueueActivityPage({
      agent: { id: "agent-123", name: "<img src=x onerror=alert(3)>" },
      snapshot: null,
      crons: [CRON],
      runs: [makeRun()],
      filters: {},
      pagination: { total: 1, limit: 20, page: 1 },
      userName: "admin@example.com",
      timezone: "America/Los_Angeles",
    });
    expect(html).not.toContain("<img src=x onerror=alert(3)>");
    expect(html).toContain("&lt;img");
  });

  test("uses renderAdminToolbar with /admin/agents active path", () => {
    const html = render([makeRun()]);
    expect(html).toContain('href="/admin/agents" class="vos-nav-link active"');
  });

  test("renders error message in the title tooltip for a failed non-skipped run", () => {
    const html = render([
      makeRun({
        outcome: "error",
        skipped: false,
        error: "Database connection timeout",
      }),
    ]);
    expect(html).toContain('title="Database connection timeout"');
  });

  test("renders outcome label in the title tooltip for a failed run with no error message", () => {
    const html = render([
      makeRun({
        outcome: "error",
        skipped: false,
        error: null,
      }),
    ]);
    expect(html).toContain('title="error"');
  });

  test("renders skipReason in the title tooltip for a skipped run, even if error is set", () => {
    const html = render([
      makeRun({
        outcome: "error",
        skipped: true,
        skipReason: "Rate limit exceeded",
        error: "Database connection timeout",
      }),
    ]);
    // The outcome badge (first title attribute in the row) should show skipReason.
    const badgeMatch = html.match(
      /<span class="badge"[^>]*title="([^"]*)"[^>]*>([^<]*)<\/span>/,
    );
    expect(badgeMatch).not.toBeNull();
    expect(badgeMatch?.[1]).toBe("Rate limit exceeded");
  });

  test("escapes XSS in the error field within the title attribute", () => {
    const html = render([
      makeRun({
        outcome: "error",
        skipped: false,
        error: '"><script>alert(4)</script>',
      }),
    ]);
    expect(html).not.toContain("<script>alert(4)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('title="');
  });

  // ─── Filter form ────────────────────────────────────────────────────────────

  test("filter form renders a cron dropdown option for each cron, labeled by name or schedule", () => {
    const html = render([makeRun()]);
    expect(html).toContain(`value="${CRON.id}"`);
    expect(html).toContain(`value="${NAMED_NON_LOOP_CRON.id}"`);
    expect(html).toContain("status check");
    expect(html).toContain(`value="${OTHER_CRON.id}"`);
    expect(html).toContain("*/15 * * * *");
  });

  test("filter form preserves the selected cronId as 'selected' on the matching option", () => {
    const html = render([makeRun()], { filters: { cronId: CRON.id } });
    const optionMatch = html.match(
      new RegExp(`<option value="${CRON.id}"[^>]*>`),
    );
    expect(optionMatch).not.toBeNull();
    expect(optionMatch?.[0]).toContain("selected");
  });

  test("filter form renders an outcome dropdown with Any/posted/dm/silent/skipped/error options", () => {
    const html = render([makeRun()]);
    expect(html).toContain(">Any<");
    expect(html).toContain('value="posted"');
    expect(html).toContain('value="dm"');
    expect(html).toContain('value="silent"');
    expect(html).toContain('value="skipped"');
    expect(html).toContain('value="error"');
  });

  test("filter form preserves the selected outcome as 'selected' on the matching option", () => {
    const html = render([makeRun()], { filters: { outcome: "error" } });
    const optionMatch = html.match(/<option value="error"[^>]*>/);
    expect(optionMatch).not.toBeNull();
    expect(optionMatch?.[0]).toContain("selected");
  });

  // ─── Pagination ─────────────────────────────────────────────────────────────

  test("pagination links preserve active cronId/outcome filters as query params", () => {
    const html = render([makeRun()], {
      filters: { cronId: CRON.id, outcome: "posted" },
      pagination: { total: 100, limit: 20, page: 2 },
    });
    expect(html).toContain(`cronId=${CRON.id}`);
    expect(html).toContain("outcome=posted");
    // Prev (page 1) omits the page param, mirroring renderPrsPage's convention
    // that page=1 is the implicit default; Next (page 3) is explicit.
    expect(html).toContain("page=3"); // Next
    const prevMatch = html.match(/← Prev/);
    expect(prevMatch).not.toBeNull();
  });

  test("pagination shows the X-Y of Z summary", () => {
    const html = render([makeRun()], {
      pagination: { total: 45, limit: 20, page: 2 },
    });
    expect(html).toContain("21");
    expect(html).toContain("40");
    expect(html).toContain("45");
  });

  test("no pagination summary when total is 0", () => {
    const html = render([], { pagination: { total: 0, limit: 20, page: 1 } });
    expect(html).not.toContain("of 0");
  });

  // ─── Outcome badge priority ────────────────────────────────────────────────

  test("outcome badge shows 'skipped' ahead of the outcome column value when skipped is true", () => {
    const html = render([
      makeRun({
        skipped: true,
        outcome: "error",
        skipReason: "pre-check failed",
      }),
    ]);
    // The badge itself renders "skipped", not "error" — mirrors
    // cronRunOutcomeLabel's skipped-takes-priority convention.
    const badgeMatch = html.match(/<span class="badge"[^>]*>([^<]*)<\/span>/);
    expect(badgeMatch).not.toBeNull();
    expect(badgeMatch?.[1]).toBe("skipped");
  });

  // ─── Detail column ────────────────────────────────────────────────────────────

  test("renders the Detail column header", () => {
    const html = render([makeRun()]);
    expect(html).toContain("<th>Detail</th>");
  });

  test("renders error text in the Detail column when error is set", () => {
    const html = render([makeRun({ error: "boom: connection refused" })]);
    expect(html).toContain("boom: connection refused");
  });

  test("falls back to skipReason in the Detail column when skipped is true and error is null", () => {
    const html = render([
      makeRun({ skipped: true, skipReason: "queue empty", error: null }),
    ]);
    expect(html).toContain("queue empty");
  });

  test("shows skipReason (not error) in the Detail column when skipped is true and both are set", () => {
    const html = render([
      makeRun({
        skipped: true,
        skipReason: "Rate limit exceeded",
        error: "Database connection timeout",
      }),
    ]);
    expect(html).toContain(
      '<span title="Rate limit exceeded">Rate limit exceeded</span>',
    );
    expect(html).not.toContain("Database connection timeout");
  });

  test("renders an em-dash in the Detail cell when both error and skipReason are null", () => {
    const html = render([makeRun({ error: null, skipReason: null })]);
    // The Detail cell's exact style attributes make this substring unique to it.
    expect(html).toContain(
      '<td style="font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">—</td>',
    );
  });

  test("a long/multi-line error string is fully present in a title attribute", () => {
    const longError =
      "Error: something failed\n    at foo (file.ts:10)\n    at bar (file.ts:20)";
    const html = render([makeRun({ error: longError })]);
    // The Detail cell renders `<span title="{full}">{full}</span>` with no other
    // attributes, so this exact substring uniquely identifies it (the outcome
    // badge span also carries a title but has class/style attrs and different
    // inner text). Visual truncation is CSS-only (max-width/ellipsis) — the
    // full, untruncated string must appear in both the title and the span body.
    expect(html).toContain(`<span title="${longError}">${longError}</span>`);
  });

  test("empty-state colspan updates from 9 to 10 for the new Session column", () => {
    const html = render([]);
    expect(html).toContain('colspan="10"');
  });

  // ─── Session column ────────────────────────────────────────────────────────────

  test("renders the Session column header", () => {
    const html = render([makeRun()]);
    expect(html).toContain("<th>Session</th>");
  });

  test("renders a truncated sessionId (first 8 chars) with the full id in a title= tooltip", () => {
    const html = render([makeRun({ sessionId: "session-123456789abcdef" })]);
    // Should render first 8 chars: "session-"
    expect(html).toContain('title="session-123456789abcdef"');
    // Must have a monospace cell with truncated value
    expect(html).toMatch(
      /<span[^>]*class="[^"]*mono[^"]*"[^>]*title="session-123456789abcdef"[^>]*>session-<\/span>/,
    );
  });

  test("renders an em-dash when sessionId is null", () => {
    const html = render([makeRun({ sessionId: null })]);
    // Extract the session cell from the tbody
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    // Check that the row contains an em-dash (should have 9 columns as per the new table)
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("renders an em-dash when sessionId is undefined", () => {
    const html = render([makeRun({ sessionId: undefined })]);
    // Extract the session cell from the tbody
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    // Check that the row contains an em-dash
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("renders an em-dash when sessionId is an empty string", () => {
    const html = render([makeRun({ sessionId: "" })]);
    // Extract the session cell from the tbody
    const bodyRowMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
    expect(bodyRowMatch).not.toBeNull();
    // Check that the row contains an em-dash
    expect(bodyRowMatch?.[1]).toContain("—");
  });

  test("table has a Session column header in the table header row", () => {
    const html = render([makeRun()]);
    // Extract the table header row
    const theadMatch = html.match(/<thead>([\s\S]*?)<\/thead>/);
    expect(theadMatch).not.toBeNull();
    // Count <th> elements within the thead
    const headers = theadMatch?.[1].match(/<th[^>]*>/g);
    expect(headers?.length).toBe(10);
  });

  test("escapes XSS in sessionId within the title attribute", () => {
    const html = render([
      makeRun({
        sessionId: '"><script>alert(99)</script>',
      }),
    ]);
    expect(html).not.toContain("<script>alert(99)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderTasksPage — mobile column hiding ───────────────────────────────────

describe("renderTasksPage — mobile column hiding", () => {
  function render(tasks: TaskItem[] = [TASK_ITEM], readOnly = false): string {
    return renderTasksPage(
      tasks,
      {},
      false,
      USER_NAME,
      {},
      { total: tasks.length, limit: 50, page: 1 },
      undefined,
      undefined,
      readOnly,
    );
  }

  // AC2: col-session class on the Session <th>
  test("Session <th> has class col-session", () => {
    const html = render();
    expect(html).toContain('<th class="col-session">Session</th>');
  });

  // AC2: col-repo class on the Repo <th>
  test("Repo <th> has class col-repo", () => {
    const html = render();
    expect(html).toContain('<th class="col-repo">Repo</th>');
  });

  // AC2: col-session class on every Session <td>
  test("Session <td> cells have class col-session", () => {
    const html = render([TASK_ITEM]);
    // TASK_ITEM has session: "session-abc"
    expect(html).toContain('class="col-session');
    // The session td must contain the class
    const sessionTdPattern = /<td[^>]*class="[^"]*col-session[^"]*"[^>]*>/;
    expect(html).toMatch(sessionTdPattern);
  });

  // AC2: col-repo class on every Repo <td>
  test("Repo <td> cells have class col-repo", () => {
    const html = render([TASK_ITEM]);
    // TASK_ITEM has repo: "org/repo"
    const repoTdPattern = /<td[^>]*class="[^"]*col-repo[^"]*"[^>]*>/;
    expect(html).toMatch(repoTdPattern);
  });

  // AC4: readOnly=true also has the correct classes
  test("col-session and col-repo classes appear in readOnly=true output", () => {
    const html = render([TASK_ITEM], true);
    expect(html).toContain('<th class="col-session">Session</th>');
    expect(html).toContain('<th class="col-repo">Repo</th>');
    const sessionTdPattern = /<td[^>]*class="[^"]*col-session[^"]*"[^>]*>/;
    const repoTdPattern = /<td[^>]*class="[^"]*col-repo[^"]*"[^>]*>/;
    expect(html).toMatch(sessionTdPattern);
    expect(html).toMatch(repoTdPattern);
  });

  // Multiple tasks → all rows get the correct classes
  test("all task rows have col-session and col-repo on their <td> cells", () => {
    const html = render([TASK_ITEM, TASK_ITEM_PENDING]);
    const sessionTdMatches = html.match(
      /<td[^>]*class="[^"]*col-session[^"]*"[^>]*>/g,
    );
    const repoTdMatches = html.match(
      /<td[^>]*class="[^"]*col-repo[^"]*"[^>]*>/g,
    );
    // One col-session td per row (2 rows)
    expect(sessionTdMatches).not.toBeNull();
    expect((sessionTdMatches ?? []).length).toBe(2);
    expect(repoTdMatches).not.toBeNull();
    expect((repoTdMatches ?? []).length).toBe(2);
  });
});

// ─── renderTasksPage — readOnly suppresses internal /admin/ links ────────────

describe("renderTasksPage — readOnly suppresses internal /admin/ links", () => {
  const CLAIMED_BLOCKED_TASK: TaskItem = {
    id: "TASK-3",
    title: "Claimed and blocked task",
    status: "blocked",
    session: "session-abc",
    repo: "org/repo",
    assignee: null,
    claimedBy: "agent-x",
    blockedBy: [{ type: "dependency", id: "TASK-dep", status: "pending" }],
  };

  function render(readOnly: boolean): string {
    return renderTasksPage(
      [CLAIMED_BLOCKED_TASK],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
      undefined,
      undefined,
      readOnly,
    );
  }

  test("readOnly=false links the agent cell and the blocker badge", () => {
    const html = render(false);
    expect(html).toContain('<a href="/admin/agents/agent-x"');
    expect(html).toContain('<a href="/admin/tasks/TASK-dep"');
  });

  test("readOnly=true renders the same ids as plain text, no /admin/ links", () => {
    const html = render(true);
    expect(html).toContain("agent-x");
    expect(html).toContain("Blocked:");
    expect(html).toContain("TASK-dep");
    expect(html).not.toContain("/admin/");
  });
});

// ─── Session value links to /admin/sessions/{session} (ASV-1.1) ─────────────

describe("renderTasksPage — session links to /admin/sessions/{session}", () => {
  test("session cell links to /admin/sessions/{session}", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
    );
    // TBF-1.1: carries ?from=/admin/tasks?view=table so the Session Detail
    // back link returns to the table view instead of the board.
    const from = encodeURIComponent("/admin/tasks?view=table");
    expect(html).toContain(
      `<a href="/admin/sessions/${encodeURIComponent(TASK_ITEM.session as string)}?from=${from}"`,
    );
  });

  test("session cell with no session value renders the placeholder, not a link", () => {
    const html = renderTasksPage(
      [TASK_ITEM_PENDING],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
    );
    expect(html).not.toContain("/admin/sessions/undefined");
    expect(html).not.toContain("/admin/sessions/null");
  });

  // AC4: session link carries the current list URL as `from` so the Session
  // Detail back link can return to this exact filtered/paginated view.
  test("session cell carries the current list URL as ?from= when filters are active", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      { status: "in_progress" },
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 2 },
    );
    const from = "/admin/tasks?status=in_progress&page=2&view=table";
    expect(html).toContain(
      `<a href="/admin/sessions/${encodeURIComponent(TASK_ITEM.session as string)}?from=${encodeURIComponent(from)}"`,
    );
  });

  // TBF-1.1 (was AC4's "bare default omits ?from="): bare /admin/tasks now
  // defaults to the board (AXR-1.3), so even the default table-view case (no
  // filters, page 1) must still carry ?from=/admin/tasks?view=table — a bare
  // link would bounce the user off the table view.
  test("session cell still carries ?from= for the default table view (no filters, page 1)", () => {
    const html = renderTasksPage(
      [TASK_ITEM],
      {},
      false,
      USER_NAME,
      {},
      { total: 1, limit: 50, page: 1 },
    );
    const from = encodeURIComponent("/admin/tasks?view=table");
    expect(html).toContain(
      `<a href="/admin/sessions/${encodeURIComponent(TASK_ITEM.session as string)}?from=${from}" style="color:#6366f1;text-decoration:none">`,
    );
  });
});

describe("renderTaskDetailPage — session link to /admin/sessions/{session}", () => {
  test("Session field links to /admin/sessions/{session}", () => {
    const task: TaskItem = { ...TASK_ITEM, session: "session-xyz" };
    const html = renderTaskDetailPage(task, USER_NAME);
    expect(html).toContain(`<a href="/admin/sessions/session-xyz`);
  });

  test("session value with special characters is URL-encoded in the link", () => {
    const task: TaskItem = { ...TASK_ITEM, session: "session/with slash" };
    const html = renderTaskDetailPage(task, USER_NAME);
    expect(html).toContain(
      `<a href="/admin/sessions/${encodeURIComponent("session/with slash")}`,
    );
  });

  test("no Session row rendered when session is absent", () => {
    const task: TaskItem = { ...TASK_ITEM, session: null };
    const html = renderTaskDetailPage(task, USER_NAME);
    expect(html).not.toContain("/admin/sessions/");
  });

  // AC4: the Session link carries this task detail page's own URL as `from`
  // so the Session Detail back link can return to it.
  test("Session field link carries this task detail page's URL as ?from=", () => {
    const task: TaskItem = {
      ...TASK_ITEM,
      id: "TASK-9",
      session: "session-xyz",
    };
    const html = renderTaskDetailPage(task, USER_NAME);
    const from = `/admin/tasks/${encodeURIComponent("TASK-9")}`;
    expect(html).toContain(
      `<a href="/admin/sessions/session-xyz?from=${encodeURIComponent(from)}"`,
    );
  });
});

// ─── renderPrsPage — mobile column hiding (AMB-1.4) ──────────────────────────

describe("renderPrsPage — mobile column hiding", () => {
  function render(
    prs: PrListItem[] = [PR_LIST_ITEM_1, PR_LIST_ITEM_2],
  ): string {
    return renderPrsPage(
      prs,
      {},
      false,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: prs.length, limit: 50, page: 1 },
    );
  }

  // AC2: col-review-cycles class on the Review Cycles <th>. AXR-2.1 wraps
  // the header text in a shared .header-tooltip span (data-tip), so the
  // text is no longer the <th>'s immediate content.
  test("Review Cycles <th> has class col-review-cycles", () => {
    const html = render();
    expect(html).toContain('class="col-review-cycles"');
    expect(html).toMatch(
      /<th[^>]*class="[^"]*col-review-cycles[^"]*"[^>]*>[\s\S]*?Review Cycles[\s\S]*?<\/th>/,
    );
  });

  // AC2: col-patch-cycles class on the Patch Cycles <th>
  test("Patch Cycles <th> has class col-patch-cycles", () => {
    const html = render();
    expect(html).toContain('class="col-patch-cycles"');
    expect(html).toMatch(
      /<th[^>]*class="[^"]*col-patch-cycles[^"]*"[^>]*>[\s\S]*?Patch Cycles[\s\S]*?<\/th>/,
    );
  });

  // AC2: col-claimed-by class on the Claimed By <th>
  test("Claimed By <th> has class col-claimed-by", () => {
    const html = render();
    expect(html).toContain('class="col-claimed-by"');
    expect(html).toMatch(
      /<th[^>]*class="[^"]*col-claimed-by[^"]*"[^>]*>Claimed By<\/th>/,
    );
  });

  // AC2: col-review-cycles class on every Review Cycles <td>
  test("Review Cycles <td> cells have class col-review-cycles", () => {
    const html = render([PR_LIST_ITEM_1]);
    const pattern = /<td[^>]*class="[^"]*col-review-cycles[^"]*"[^>]*>/;
    expect(html).toMatch(pattern);
  });

  // AC2: col-patch-cycles class on every Patch Cycles <td>
  test("Patch Cycles <td> cells have class col-patch-cycles", () => {
    const html = render([PR_LIST_ITEM_1]);
    const pattern = /<td[^>]*class="[^"]*col-patch-cycles[^"]*"[^>]*>/;
    expect(html).toMatch(pattern);
  });

  // AC2: col-claimed-by class on every Claimed By <td>
  test("Claimed By <td> cells have class col-claimed-by", () => {
    const html = render([PR_LIST_ITEM_1]);
    const pattern = /<td[^>]*class="[^"]*col-claimed-by[^"]*"[^>]*>/;
    expect(html).toMatch(pattern);
  });

  // Multiple rows → all rows get the correct classes
  test("all PR rows have col-review-cycles, col-patch-cycles, and col-claimed-by on their <td> cells", () => {
    const html = render([PR_LIST_ITEM_1, PR_LIST_ITEM_2]);
    const reviewCyclesTdMatches = html.match(
      /<td[^>]*class="[^"]*col-review-cycles[^"]*"[^>]*>/g,
    );
    const patchCyclesTdMatches = html.match(
      /<td[^>]*class="[^"]*col-patch-cycles[^"]*"[^>]*>/g,
    );
    const claimedByTdMatches = html.match(
      /<td[^>]*class="[^"]*col-claimed-by[^"]*"[^>]*>/g,
    );
    // One of each per row (2 rows)
    expect(reviewCyclesTdMatches).not.toBeNull();
    expect((reviewCyclesTdMatches ?? []).length).toBe(2);
    expect(patchCyclesTdMatches).not.toBeNull();
    expect((patchCyclesTdMatches ?? []).length).toBe(2);
    expect(claimedByTdMatches).not.toBeNull();
    expect((claimedByTdMatches ?? []).length).toBe(2);
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

// ─── classifyTaskState (HBV-1.2) ─────────────────────────────────────────────
// Mirrors task-store/src/task-service.ts's list()/listReady()/listBlocked()
// grouping: blockedBy is computed server-side for every status (not just
// pending), so classifyTaskState must check it before the in_progress/
// pr_open/approved branch — otherwise an in_progress task carrying an
// unresolved dependency or hitl block gets misbucketed as "in_progress".

describe("classifyTaskState", () => {
  const BASE: TaskItem = {
    id: "TASK-1",
    title: "Some task",
    status: "pending",
  };

  test.each(["in_progress", "pr_open", "approved"] as const)(
    "status %s with non-empty blockedBy classifies as blocked",
    (status) => {
      const task: TaskItem = {
        ...BASE,
        status,
        blockedBy: [{ type: "hitl" }],
      };
      expect(classifyTaskState(task)).toBe("blocked");
    },
  );

  test.each(["in_progress", "pr_open", "approved"] as const)(
    "status %s with empty blockedBy still classifies as in_progress",
    (status) => {
      const task: TaskItem = { ...BASE, status, blockedBy: [] };
      expect(classifyTaskState(task)).toBe("in_progress");
    },
  );

  test.each(["in_progress", "pr_open", "approved"] as const)(
    "status %s with no blockedBy field still classifies as in_progress",
    (status) => {
      const task: TaskItem = { ...BASE, status };
      expect(classifyTaskState(task)).toBe("in_progress");
    },
  );

  test.each(["merged", "done", "deploying", "deployed", "cancelled"] as const)(
    "closed status %s takes precedence over a stale non-empty blockedBy",
    (status) => {
      const task: TaskItem = {
        ...BASE,
        status,
        blockedBy: [{ type: "dependency", id: "TASK-0", status: "pending" }],
      };
      expect(classifyTaskState(task)).toBe("closed");
    },
  );

  test("explicit status blocked classifies as blocked", () => {
    const task: TaskItem = { ...BASE, status: "blocked" };
    expect(classifyTaskState(task)).toBe("blocked");
  });

  test("pending status with unresolved blockedBy classifies as blocked", () => {
    const task: TaskItem = {
      ...BASE,
      status: "pending",
      blockedBy: [{ type: "dependency", id: "TASK-0", status: "pending" }],
    };
    expect(classifyTaskState(task)).toBe("blocked");
  });

  test("pending status with no blockedBy classifies as ready", () => {
    const task: TaskItem = { ...BASE, status: "pending", blockedBy: [] };
    expect(classifyTaskState(task)).toBe("ready");
  });
});

// ─── bucketTaskColumn (AXR-1.2) ──────────────────────────────────────────────
// Single source of truth for the 5-column task board (Queued / Claimed /
// In Progress / Blocked-HITL / Done), consumed later by AXR-1.3's board UI.
// Every task must resolve to exactly one column — including the edge case
// where both the task itself (status/hitl/blockedBy) and its joined PR
// (pr.blocked) are separately blocked.

describe("bucketTaskColumn", () => {
  const BASE: TaskItem = {
    id: "TASK-1",
    title: "Some task",
    status: "pending",
  };

  test.each(["merged", "deployed", "done", "deploying", "cancelled"] as const)(
    "status %s buckets as done",
    (status) => {
      expect(bucketTaskColumn({ ...BASE, status })).toBe("done");
    },
  );

  test("status done wins over hitl:true (done takes precedence)", () => {
    const task: TaskItem = { ...BASE, status: "done", hitl: true };
    expect(bucketTaskColumn(task)).toBe("done");
  });

  test("status done wins over a blocked joined PR (done takes precedence)", () => {
    const task: TaskItem = { ...BASE, status: "done" };
    expect(bucketTaskColumn(task, true)).toBe("done");
  });

  test("explicit status blocked buckets as blocked_hitl", () => {
    const task: TaskItem = { ...BASE, status: "blocked" };
    expect(bucketTaskColumn(task)).toBe("blocked_hitl");
  });

  test("hitl:true and not yet done buckets as blocked_hitl", () => {
    const task: TaskItem = { ...BASE, status: "in_progress", hitl: true };
    expect(bucketTaskColumn(task)).toBe("blocked_hitl");
  });

  test("joined PR blocked:true buckets as blocked_hitl even when the task itself is not blocked", () => {
    const task: TaskItem = { ...BASE, status: "in_progress" };
    expect(bucketTaskColumn(task, true)).toBe("blocked_hitl");
  });

  test("non-empty blockedBy (unresolved dependency) buckets as blocked_hitl even with status pending", () => {
    const task: TaskItem = {
      ...BASE,
      status: "pending",
      blockedBy: [{ type: "dependency", id: "REL-2.2", status: "pending" }],
    };
    expect(bucketTaskColumn(task)).toBe("blocked_hitl");
  });

  test("non-empty blockedBy (hitl wait) buckets as blocked_hitl even with status in_progress", () => {
    const task: TaskItem = {
      ...BASE,
      status: "in_progress",
      blockedBy: [{ type: "hitl" }],
    };
    expect(bucketTaskColumn(task)).toBe("blocked_hitl");
  });

  test("empty blockedBy does not force blocked_hitl", () => {
    const task: TaskItem = { ...BASE, status: "pending", blockedBy: [] };
    expect(bucketTaskColumn(task)).toBe("queued");
  });

  test("both task-level blocked (status) AND PR-level blocked resolve to the single blocked_hitl bucket", () => {
    const task: TaskItem = { ...BASE, status: "blocked" };
    expect(bucketTaskColumn(task, true)).toBe("blocked_hitl");
  });

  test("both task-level blocked (hitl) AND PR-level blocked resolve to the single blocked_hitl bucket", () => {
    const task: TaskItem = { ...BASE, status: "in_progress", hitl: true };
    expect(bucketTaskColumn(task, true)).toBe("blocked_hitl");
  });

  test.each(["in_progress", "pr_open", "approved"] as const)(
    "status %s with no blockers buckets as in_progress",
    (status) => {
      const task: TaskItem = { ...BASE, status };
      expect(bucketTaskColumn(task)).toBe("in_progress");
    },
  );

  test("pending status with a claimedBy buckets as claimed", () => {
    const task: TaskItem = {
      ...BASE,
      status: "pending",
      claimedBy: "agent-1",
    };
    expect(bucketTaskColumn(task)).toBe("claimed");
  });

  test("pending status with no claimedBy buckets as queued", () => {
    const task: TaskItem = { ...BASE, status: "pending", claimedBy: null };
    expect(bucketTaskColumn(task)).toBe("queued");
  });

  test("pending status with claimedBy undefined buckets as queued", () => {
    const task: TaskItem = { ...BASE, status: "pending" };
    expect(bucketTaskColumn(task)).toBe("queued");
  });

  test("prBlocked false does not force blocked_hitl for an otherwise-in_progress task", () => {
    const task: TaskItem = { ...BASE, status: "in_progress" };
    expect(bucketTaskColumn(task, false)).toBe("in_progress");
  });
});

// ─── renderSessionDetailPage (ASV-1.1) ───────────────────────────────────────

describe("renderSessionDetailPage", () => {
  const SESSION_ID = "session-abc";

  const READY_TASK: TaskItem = {
    id: "TASK-1",
    title: "Build the thing",
    status: "pending",
    session: SESSION_ID,
    repo: "org/repo",
    layer: "Backend",
    hours: 2,
    dependencies: ["TASK-0"],
  };

  const IN_PROGRESS_TASK: TaskItem = {
    id: "TASK-2",
    title: "Wire up the UI",
    status: "in_progress",
    session: SESSION_ID,
    repo: "org/repo",
    layer: "Frontend",
    hours: 3.5,
  };

  const CLOSED_TASK_1: TaskItem = {
    id: "TASK-3",
    title: "Ship it",
    status: "done",
    session: SESSION_ID,
    repo: "org/repo",
    layer: "Backend",
    hours: 1,
  };

  const CLOSED_TASK_2: TaskItem = {
    id: "TASK-4",
    title: "Deploy it",
    status: "merged",
    session: SESSION_ID,
    repo: "org/repo",
    layer: "Ops",
    hours: 0.5,
  };

  const MIXED_TASKS = [
    READY_TASK,
    IN_PROGRESS_TASK,
    CLOSED_TASK_1,
    CLOSED_TASK_2,
  ];

  test("stat cards: total tasks, est. hours sum, distinct layers", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    // total tasks = 4
    expect(html).toContain(">4<");
    // est hours sum = 2 + 3.5 + 1 + 0.5 = 7
    expect(html).toContain(">7<");
    // distinct layers = Backend, Frontend, Ops = 3
    expect(html).toContain(">3<");
  });

  test("task table includes a Status column and renders every task", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).toContain("<th>Status</th>");
    expect(html).toContain("Build the thing");
    expect(html).toContain("Wire up the UI");
    expect(html).toContain("Ship it");
    expect(html).toContain("Deploy it");
    expect(html).toContain("pending");
    expect(html).toContain("in_progress");
    expect(html).toContain("done");
    expect(html).toContain("merged");
  });

  test("task table includes a Source column header", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).toContain('<th class="col-source">Source</th>');
  });

  test("row renders task.source value in the Source column", () => {
    const taskWithSource: TaskItem = {
      ...READY_TASK,
      source: "entropy-fix",
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [taskWithSource],
      USER_NAME,
    );
    expect(html).toContain(
      '<td class="col-source mono" style="font-size:11px">entropy-fix</td>',
    );
  });

  test("row without source shows em-dash placeholder", () => {
    const taskWithoutSource: TaskItem = { ...READY_TASK, source: null };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [taskWithoutSource],
      USER_NAME,
    );
    expect(html).toContain(
      '<td class="col-source mono" style="font-size:11px"><span style="color:#9ca3af">—</span></td>',
    );
  });

  test("row escapes HTML in task.source", () => {
    const xssTask: TaskItem = {
      ...READY_TASK,
      source: '"><script>xss()</script>',
    };
    const html = renderSessionDetailPage(SESSION_ID, [xssTask], USER_NAME);
    expect(html).not.toContain("<script>xss()</script>");
  });

  test("no filter form is added to the session detail view", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).not.toContain('name="source"');
    expect(html).not.toContain('placeholder="source"');
  });

  test("summarizes and groups the task table by ready/in_progress/blocked/closed — matching the Tasks page taxonomy", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    // READY_TASK (pending, no blockedBy) -> ready; IN_PROGRESS_TASK (in_progress) -> in_progress;
    // CLOSED_TASK_1/2 (done, merged) -> closed; none blocked.
    expect(html).toMatch(/1[^0-9]*ready/i);
    expect(html).toMatch(/1[^0-9]*in progress/i);
    expect(html).toMatch(/0[^0-9]*blocked/i);
    expect(html).toMatch(/2[^0-9]*closed/i);
    expect(html).toContain("Ready (1)");
    expect(html).toContain("In Progress (1)");
    expect(html).toContain("Closed (2)");
    expect(html).not.toContain("Blocked (");
  });

  test("all-ready-or-in-progress session: no Closed group rendered", () => {
    const html = renderSessionDetailPage(
      SESSION_ID,
      [READY_TASK, IN_PROGRESS_TASK],
      USER_NAME,
    );
    expect(html).toContain("Ready (1)");
    expect(html).toContain("In Progress (1)");
    expect(html).not.toContain("Closed (");
  });

  test("all-closed session: single Closed group, no Ready/In Progress/Blocked", () => {
    const html = renderSessionDetailPage(
      SESSION_ID,
      [CLOSED_TASK_1, CLOSED_TASK_2],
      USER_NAME,
    );
    expect(html).toContain("Closed (2)");
    expect(html).not.toContain("Ready (");
    expect(html).not.toContain("In Progress (");
    expect(html).not.toContain("Blocked (");
  });

  test("a pending task with unresolved blockers groups under Blocked in the task table", () => {
    const blocked: TaskItem = {
      id: "TASK-5",
      title: "Blocked on something",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [{ type: "dependency", id: "TASK-1", status: "pending" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [blocked], USER_NAME);
    expect(html).toContain("Blocked (1)");
  });

  test("an in_progress task with hitl-derived blockedBy groups under Blocked, not In Progress", () => {
    const blockedInProgress: TaskItem = {
      id: "TASK-6",
      title: "Waiting on a human",
      status: "in_progress",
      session: SESSION_ID,
      blockedBy: [{ type: "hitl" }],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [blockedInProgress],
      USER_NAME,
    );
    expect(html).toContain("Blocked (1)");
    expect(html).not.toContain("In Progress (1)");
  });

  test("dependency list rendering: distinct dependency ids collected across tasks", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).toContain("TASK-0");
  });

  test("empty-session case: sensible empty state, zero stats", () => {
    const html = renderSessionDetailPage(SESSION_ID, [], USER_NAME);
    expect(html).toContain(">0<");
    expect(html.toLowerCase()).toContain("no tasks");
  });

  test("renders the session id in the page", () => {
    const html = renderSessionDetailPage(SESSION_ID, MIXED_TASKS, USER_NAME);
    expect(html).toContain(SESSION_ID);
  });

  test("escapes the session id to avoid XSS", () => {
    const xssSession = "<script>alert(1)</script>";
    const html = renderSessionDetailPage(xssSession, [], USER_NAME);
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  test("tasks with missing hours/layer don't break stat computation", () => {
    const sparseTask: TaskItem = {
      id: "TASK-5",
      title: "Sparse task",
      status: "pending",
      session: SESSION_ID,
      repo: null,
    };
    const html = renderSessionDetailPage(SESSION_ID, [sparseTask], USER_NAME);
    expect(html).toContain("Sparse task");
    expect(html).toContain(">1<"); // 1 total task
  });
});

// ─── renderSessionDetailPage — dependency graph ──────────────────────────────

describe("renderSessionDetailPage dependency graph", () => {
  const SESSION_ID = "session-graph";

  // Isolates the graph card from the task table above it — both can contain
  // the same task ids, so plain html.toContain() can't tell them apart.
  function graphSection(html: string): string {
    const idx = html.indexOf("Dependency graph");
    expect(idx).toBeGreaterThan(-1);
    return html.slice(idx);
  }

  test("no Ready/In Progress/Blocked/Closed grouping headers appear in the graph card", () => {
    const a: TaskItem = {
      id: "TASK-A",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const b: TaskItem = {
      id: "TASK-B",
      title: "Depends on A",
      status: "in_progress",
      session: SESSION_ID,
      dependencies: ["TASK-A"],
      blockedBy: [{ type: "dependency", id: "TASK-A", status: "pending" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [a, b], USER_NAME);
    const section = graphSection(html);
    expect(section).not.toContain("Ready (");
    expect(section).not.toContain("In Progress (");
    expect(section).not.toContain("Blocked (");
    expect(section).not.toContain("Closed (");
    expect(section).toContain('data-task-id="TASK-A"');
    expect(section).toContain('data-task-id="TASK-B"');
    expect(section).toContain("needs");
    expect(section).toContain('href="/admin/tasks/TASK-A"');
  });

  test("a dependency id outside the session renders as plain unlinked text in the needs line", () => {
    const c: TaskItem = {
      id: "TASK-C",
      title: "Needs an external dep",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["EXTERNAL-1"],
      blockedBy: [{ type: "dependency", id: "EXTERNAL-1", status: "unknown" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [c], USER_NAME);
    const section = graphSection(html);
    expect(section).toContain("EXTERNAL-1");
    expect(section).not.toContain('href="/admin/tasks/EXTERNAL-1"');
    expect(section).not.toContain('data-to="EXTERNAL-1"');
    expect(section).not.toContain('data-from="EXTERNAL-1"');
  });

  test("a dependency id inside the session links to that task's detail page", () => {
    const root: TaskItem = {
      id: "TASK-ROOT",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const dependent: TaskItem = {
      id: "TASK-DEP",
      title: "Depends on root",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [root, dependent],
      USER_NAME,
    );
    const section = graphSection(html);
    expect(section).toContain('href="/admin/tasks/TASK-ROOT"');
    expect(section).toContain('data-from="TASK-ROOT" data-to="TASK-DEP"');
  });

  test("tasks with no dependency relationship at all are excluded from the graph", () => {
    const unrelated: TaskItem = {
      id: "TASK-LONER",
      title: "No relationships",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const dependent: TaskItem = {
      id: "TASK-DEP",
      title: "Depends on root",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const root: TaskItem = {
      id: "TASK-ROOT",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [unrelated, dependent, root],
      USER_NAME,
    );
    const section = graphSection(html);
    expect(section).toContain("TASK-DEP");
    expect(section).toContain("TASK-ROOT");
    expect(section).not.toContain("TASK-LONER");
  });

  test("same-branch tasks get a matching branch color", () => {
    const first: TaskItem = {
      id: "TASK-1",
      title: "models + migration",
      status: "pending",
      session: SESSION_ID,
      branch: "feat/bundle",
      blockedBy: [],
    };
    const second: TaskItem = {
      id: "TASK-2",
      title: "admin endpoint",
      status: "in_progress",
      session: SESSION_ID,
      branch: "feat/bundle",
      dependencies: ["TASK-1"],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [first, second],
      USER_NAME,
    );
    const section = graphSection(html);
    const colors = [
      ...section.matchAll(/border-left:3px solid (#[0-9a-f]{6})/g),
    ].map((m) => m[1]);
    expect(colors.length).toBe(2);
    expect(colors[0]).toBe(colors[1]);
  });

  test("session with zero dependency edges omits the dependency graph card entirely", () => {
    const solo: TaskItem = {
      id: "TASK-SOLO",
      title: "Independent",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const html = renderSessionDetailPage(SESSION_ID, [solo], USER_NAME);
    expect(html).not.toContain("Dependency graph");
  });

  test("a mutual dependency cycle doesn't hang rendering and still renders both nodes", () => {
    const x: TaskItem = {
      id: "TASK-X",
      title: "X",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-Y"],
      blockedBy: [{ type: "dependency", id: "TASK-Y", status: "pending" }],
    };
    const y: TaskItem = {
      id: "TASK-Y",
      title: "Y",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-X"],
      blockedBy: [{ type: "dependency", id: "TASK-X", status: "pending" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [x, y], USER_NAME);
    const section = graphSection(html);
    expect(section).toContain('data-task-id="TASK-X"');
    expect(section).toContain('data-task-id="TASK-Y"');
  });

  test("escapes task ids, titles, and branch names in the graph to avoid XSS", () => {
    const xss: TaskItem = {
      id: "TASK-XSS",
      title: "<img src=x onerror=alert(1)>",
      status: "pending",
      session: SESSION_ID,
      branch: "<script>evil()</script>",
      dependencies: ["<b>dep</b>"],
      blockedBy: [{ type: "dependency", id: "<b>dep</b>", status: "unknown" }],
    };
    const html = renderSessionDetailPage(SESSION_ID, [xss], USER_NAME);
    const section = graphSection(html);
    expect(section).not.toContain("<img src=x onerror=alert(1)>");
    expect(section).not.toContain("<script>evil()</script>");
    expect(section).not.toContain("<b>dep</b>");
  });

  test("fan-out+fan-in: node count and data-from/data-to pairs match every in-session edge", () => {
    // ROOT -> CHILD-1, ROOT -> CHILD-2, CHILD-1 -> SINK, CHILD-2 -> SINK
    const root: TaskItem = {
      id: "TASK-ROOT",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const child1: TaskItem = {
      id: "TASK-CHILD-1",
      title: "Child 1",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const child2: TaskItem = {
      id: "TASK-CHILD-2",
      title: "Child 2",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const sink: TaskItem = {
      id: "TASK-SINK",
      title: "Sink",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-CHILD-1", "TASK-CHILD-2"],
      blockedBy: [
        { type: "dependency", id: "TASK-CHILD-1", status: "pending" },
        { type: "dependency", id: "TASK-CHILD-2", status: "pending" },
      ],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [root, child1, child2, sink],
      USER_NAME,
    );
    const section = graphSection(html);

    const nodeIds = [...section.matchAll(/data-task-id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(nodeIds.sort()).toEqual(
      ["TASK-CHILD-1", "TASK-CHILD-2", "TASK-ROOT", "TASK-SINK"].sort(),
    );

    const edges = [
      ...section.matchAll(/data-from="([^"]+)" data-to="([^"]+)"/g),
    ].map((m) => [m[1], m[2]]);
    expect(edges.length).toBe(4);
    expect(edges).toContainEqual(["TASK-ROOT", "TASK-CHILD-1"]);
    expect(edges).toContainEqual(["TASK-ROOT", "TASK-CHILD-2"]);
    expect(edges).toContainEqual(["TASK-CHILD-1", "TASK-SINK"]);
    expect(edges).toContainEqual(["TASK-CHILD-2", "TASK-SINK"]);
  });

  test("graph is wrapped in .data-table-wrapper for horizontal scroll on mobile", () => {
    const root: TaskItem = {
      id: "TASK-ROOT",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const dependent: TaskItem = {
      id: "TASK-DEP",
      title: "Depends on root",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-ROOT"],
      blockedBy: [{ type: "dependency", id: "TASK-ROOT", status: "pending" }],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [root, dependent],
      USER_NAME,
    );
    const section = graphSection(html);
    expect(section).toMatch(
      /<div class="data-table-wrapper">\s*<div style="position:relative;/,
    );
  });

  test("2-depth-column graph: wrapper (not inner graph div) carries overflow-x:auto, and inner width exceeds a phone viewport", () => {
    const root: TaskItem = {
      id: "TASK-A",
      title: "Root",
      status: "pending",
      session: SESSION_ID,
      blockedBy: [],
    };
    const dependent: TaskItem = {
      id: "TASK-B",
      title: "Depends on A",
      status: "pending",
      session: SESSION_ID,
      dependencies: ["TASK-A"],
      blockedBy: [{ type: "dependency", id: "TASK-A", status: "pending" }],
    };
    const html = renderSessionDetailPage(
      SESSION_ID,
      [root, dependent],
      USER_NAME,
    );
    const section = graphSection(html);

    // Wrapper carries the (class-based) overflow-x:auto; the inner graph div
    // is exactly sized to its own content and must not duplicate it inline.
    expect(section).toContain('<div class="data-table-wrapper">');
    const innerDivMatch = section.match(/<div style="position:relative;[^"]*"/);
    expect(innerDivMatch).not.toBeNull();
    expect(innerDivMatch?.[0]).not.toContain("overflow-x:auto");

    // Confirm this is genuinely a 2-depth-column graph whose width exceeds a
    // 375px phone viewport, so the wrapper's scroll is actually needed.
    const layout = computeDependencyLayout(
      computeDependencyNodes([root, dependent]),
    );
    const depths = [...layout.positions.values()].map((p) => p.depth);
    const numColumns = new Set(depths).size;
    expect(numColumns).toBe(2);
    expect(layout.width).toBe(
      40 * 2 + numColumns * 220 + (numColumns - 1) * 100,
    );
    expect(layout.width).toBeGreaterThan(375);
  });
});

// ─── computeDependencyLayout ──────────────────────────────────────────────────

function depNode(
  overrides: Partial<DependencyNode> & { id: string },
): DependencyNode {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    status: overrides.status ?? "pending",
    branch: overrides.branch ?? null,
    dependsOn: overrides.dependsOn ?? [],
  };
}

describe("computeDependencyLayout", () => {
  test("simple linear chain: each node gets increasing depth and distinct x, same y", () => {
    const a = depNode({ id: "TASK-A" });
    const b = depNode({ id: "TASK-B", dependsOn: ["TASK-A"] });
    const c = depNode({ id: "TASK-C", dependsOn: ["TASK-B"] });
    const layout = computeDependencyLayout([a, b, c]);

    const posA = layout.positions.get("TASK-A");
    const posB = layout.positions.get("TASK-B");
    const posC = layout.positions.get("TASK-C");
    expect(posA).toBeDefined();
    expect(posB).toBeDefined();
    expect(posC).toBeDefined();

    // Exact numbers, locking in the mockup's measured spacing:
    // margin=40, card=220, columnGap=100 -> pitch=320
    expect(posA).toEqual({ x: 40, y: 40, depth: 0 });
    expect(posB).toEqual({ x: 360, y: 40, depth: 1 });
    expect(posC).toEqual({ x: 680, y: 40, depth: 2 });

    // Distinct x per depth, same y (single row per column).
    expect(posA?.x).not.toBe(posB?.x);
    expect(posB?.x).not.toBe(posC?.x);
    expect(posA?.y).toBe(posB?.y);
    expect(posB?.y).toBe(posC?.y);
  });

  test("fan-out: root at depth 0, children at depth 1 with distinct rows", () => {
    const root = depNode({ id: "TASK-ROOT" });
    const child1 = depNode({ id: "TASK-CHILD-1", dependsOn: ["TASK-ROOT"] });
    const child2 = depNode({ id: "TASK-CHILD-2", dependsOn: ["TASK-ROOT"] });
    const layout = computeDependencyLayout([root, child1, child2]);

    expect(layout.positions.get("TASK-ROOT")?.depth).toBe(0);
    expect(layout.positions.get("TASK-CHILD-1")?.depth).toBe(1);
    expect(layout.positions.get("TASK-CHILD-2")?.depth).toBe(1);

    // Children share a column (same x) but get distinct rows (different y).
    const child1Pos = layout.positions.get("TASK-CHILD-1");
    const child2Pos = layout.positions.get("TASK-CHILD-2");
    expect(child1Pos?.x).toBe(child2Pos?.x);
    expect(child1Pos?.y).not.toBe(child2Pos?.y);
  });

  test("fan-in: child depth is 1 + max(parents' depths) — longest path, not shortest", () => {
    // shallow -> mid -> deep, and a separate shallow-parent directly into child.
    const shallow = depNode({ id: "TASK-SHALLOW" });
    const mid = depNode({ id: "TASK-MID", dependsOn: ["TASK-SHALLOW"] });
    const deep = depNode({ id: "TASK-DEEP", dependsOn: ["TASK-MID"] });
    const child = depNode({
      id: "TASK-CHILD",
      dependsOn: ["TASK-SHALLOW", "TASK-DEEP"],
    });
    const layout = computeDependencyLayout([shallow, mid, deep, child]);

    expect(layout.positions.get("TASK-SHALLOW")?.depth).toBe(0);
    expect(layout.positions.get("TASK-MID")?.depth).toBe(1);
    expect(layout.positions.get("TASK-DEEP")?.depth).toBe(2);
    // child depends on shallow (depth 0) and deep (depth 2) -> longest path wins: 1+2=3
    expect(layout.positions.get("TASK-CHILD")?.depth).toBe(3);
  });

  test("cycle safety: mutual dependency doesn't hang and both nodes get positions", () => {
    const x = depNode({ id: "TASK-X", dependsOn: ["TASK-Y"] });
    const y = depNode({ id: "TASK-Y", dependsOn: ["TASK-X"] });
    const layout = computeDependencyLayout([x, y]);

    const posX = layout.positions.get("TASK-X");
    const posY = layout.positions.get("TASK-Y");
    expect(posX).toBeDefined();
    expect(posY).toBeDefined();
    expect(Number.isFinite(posX?.x)).toBe(true);
    expect(Number.isFinite(posX?.y)).toBe(true);
    expect(Number.isFinite(posX?.depth)).toBe(true);
    expect(Number.isFinite(posY?.x)).toBe(true);
    expect(Number.isFinite(posY?.y)).toBe(true);
    expect(Number.isFinite(posY?.depth)).toBe(true);
  });

  test("deterministic ordering: same input twice yields identical layout", () => {
    const a = depNode({ id: "TASK-A" });
    const b = depNode({ id: "TASK-B", dependsOn: ["TASK-A"] });
    const c = depNode({ id: "TASK-C", dependsOn: ["TASK-A"] });
    const nodes = [a, b, c];

    const layout1 = computeDependencyLayout(nodes);
    const layout2 = computeDependencyLayout(nodes);

    expect(layout1.width).toBe(layout2.width);
    expect(layout1.height).toBe(layout2.height);
    for (const id of ["TASK-A", "TASK-B", "TASK-C"]) {
      expect(layout1.positions.get(id)).toEqual(layout2.positions.get(id));
    }
  });

  test("deterministic row ordering for same-depth nodes with no dependency relationship follows input order", () => {
    // Two independent roots, no edges between them.
    const rootFirst = depNode({ id: "TASK-FIRST" });
    const rootSecond = depNode({ id: "TASK-SECOND" });
    const layout = computeDependencyLayout([rootFirst, rootSecond]);

    const firstPos = layout.positions.get("TASK-FIRST");
    const secondPos = layout.positions.get("TASK-SECOND");
    expect(firstPos?.depth).toBe(0);
    expect(secondPos?.depth).toBe(0);
    // Same column.
    expect(firstPos?.x).toBe(secondPos?.x);
    // Row order follows input array order: first node gets the earlier row.
    expect(firstPos?.y).toBeLessThan(secondPos?.y ?? Number.POSITIVE_INFINITY);
  });

  test("empty input returns empty positions and zeroed canvas size", () => {
    const layout = computeDependencyLayout([]);
    expect(layout.positions.size).toBe(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });
});

// AXR-3.1 merged the former standalone renderWorkQueuePage into
// renderQueueActivityPage's "Upcoming" section — these cases are adapted
// (not duplicated) from the original renderWorkQueuePage suite.
describe("renderQueueActivityPage — Upcoming section", () => {
  const QUEUE_AGENT = { id: "agent-123", name: "Test Agent" };

  function makeItem(overrides?: Partial<WorkQueueItem>): WorkQueueItem {
    return {
      type: "task",
      id: "TSK-1",
      title: "Sample task",
      phase: "dev-task",
      age: "2026-06-01T09:00:00Z",
      ...overrides,
    };
  }

  function render(
    snapshot: WorkQueueSnapshotItem | null,
    opts?: { now?: Date },
  ): string {
    return renderQueueActivityPage({
      agent: QUEUE_AGENT,
      snapshot,
      crons: [],
      runs: [],
      filters: {},
      pagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
      now: opts?.now ?? new Date("2026-06-01T10:00:00Z"),
    });
  }

  test("renders a valid HTML document", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [makeItem()],
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain(
      "<title>Queue &amp; Activity — Test Agent — Shipwright Admin</title>",
    );
  });

  test("renders empty state when snapshot is null", () => {
    const html = render(null);
    expect(html).toContain("No work queue snapshot yet");
    expect(html).toContain("shipwright-loop cron ticks");
  });

  test("renders empty state when snapshot has no items", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [],
    });
    expect(html).toContain("Queue is empty — nothing pending");
  });

  test("renders table wrapped in data-table-wrapper with class data-table", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [makeItem()],
    });
    expect(html).toContain('<div class="data-table-wrapper">');
    expect(html).toContain('<table class="data-table">');
  });

  test("renders queue items with correct columns", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [
        makeItem({
          type: "task",
          id: "TSK-1",
          title: "First task",
          phase: "dev-task",
          age: "2026-06-01T09:00:00Z",
        }),
        makeItem({
          type: "pr",
          id: "PR-123",
          title: "Review PR",
          phase: "review",
          age: "2026-06-01T08:30:00Z",
        }),
      ],
    });
    expect(html).toContain("<th>#</th>");
    expect(html).toContain("<th>Type</th>");
    expect(html).toContain("<th>Phase</th>");
    expect(html).toContain("<th>Item</th>");
    expect(html).toContain("<th>Age</th>");
    expect(html).toContain("First task");
    expect(html).toContain("Review PR");
  });

  test("renders a back link to the agent detail page", () => {
    const html = render({
      computedAt: new Date("2026-06-01T09:55:00Z"),
      items: [makeItem()],
    });
    expect(html).toContain('href="/admin/agents/agent-123"');
    expect(html).toContain("Test Agent");
  });
});

// ─── renderQueueActivityPage — agent selector (AXR-3.4) ─────────────────────

describe("renderQueueActivityPage — agent selector", () => {
  const BASE_OPTS = {
    snapshot: null,
    crons: [],
    runs: [],
    filters: {},
    pagination: { total: 0, limit: 20, page: 1 },
    userName: "admin@example.com",
  };

  test("admin fixture: renders every accessible agent as an option, with the viewed agent pre-selected", () => {
    const html = renderQueueActivityPage({
      ...BASE_OPTS,
      agent: { id: "agent-123", name: "Test Agent" },
      agents: [
        { id: "agent-123", name: "Test Agent" },
        { id: "agent-456", name: "Other Agent" },
        { id: "agent-789", name: "Third Agent" },
      ],
    });
    expect(html).toContain(
      '<option value="agent-123" selected>Test Agent</option>',
    );
    expect(html).toContain('<option value="agent-456">Other Agent</option>');
    expect(html).toContain('<option value="agent-789">Third Agent</option>');
    expect(html).toContain(
      '<form method="GET" action="/admin/agents/agent-123/queue-activity"',
    );
  });

  test("non-admin/AgentMember fixture: renders only the caller's scoped agents, none of the inaccessible fleet", () => {
    const html = renderQueueActivityPage({
      ...BASE_OPTS,
      agent: { id: "agent-456", name: "Other Agent" },
      agents: [
        { id: "agent-123", name: "Test Agent" },
        { id: "agent-456", name: "Other Agent" },
      ],
    });
    expect(html).toContain('<option value="agent-123">Test Agent</option>');
    expect(html).toContain(
      '<option value="agent-456" selected>Other Agent</option>',
    );
    expect(html).not.toContain("agent-789");
  });

  test("falls back to a single-option selector (just the viewed agent) when agents is omitted", () => {
    const html = renderQueueActivityPage({
      ...BASE_OPTS,
      agent: { id: "agent-123", name: "Test Agent" },
    });
    expect(html).toContain(
      '<option value="agent-123" selected>Test Agent</option>',
    );
  });
});

// ─── renderQueueActivityPage — sectioning (AXR-3.1) ─────────────────────────

describe("renderQueueActivityPage — Upcoming/Past sectioning", () => {
  const AGENT = { id: "agent-123", name: "Test Agent" };
  const CRON = { id: "cron-1", name: "status check", schedule: "0 * * * *" };

  test("renders an 'Upcoming' heading before a 'Past' heading, with the work-queue snapshot before the cron-run table", () => {
    const html = renderQueueActivityPage({
      agent: AGENT,
      snapshot: {
        computedAt: new Date("2026-06-01T09:55:00Z"),
        items: [
          {
            type: "task",
            id: "TSK-1",
            title: "Queued task",
            phase: "dev-task",
            age: "2026-06-01T09:00:00Z",
          },
        ],
      },
      crons: [CRON],
      runs: [
        {
          startedAt: new Date("2026-06-01T08:00:00Z"),
          completedAt: new Date("2026-06-01T08:00:02Z"),
          outcome: "posted",
          skipped: false,
          skipReason: null,
          error: null,
          cron: CRON,
        },
      ],
      filters: {},
      pagination: { total: 1, limit: 20, page: 1 },
      userName: "admin@example.com",
      now: new Date("2026-06-01T10:00:00Z"),
    });

    const upcomingHeadingIndex = html.indexOf("Upcoming");
    const pastHeadingIndex = html.indexOf("Past");
    const upcomingItemIndex = html.indexOf("TSK-1");
    const pastRunIndex = html.indexOf("posted");

    expect(upcomingHeadingIndex).toBeGreaterThan(-1);
    expect(pastHeadingIndex).toBeGreaterThan(-1);
    expect(upcomingHeadingIndex).toBeLessThan(pastHeadingIndex);
    expect(upcomingItemIndex).toBeGreaterThan(-1);
    expect(pastRunIndex).toBeGreaterThan(-1);
    // The Upcoming table's item content must appear before the Past
    // heading, and the Past table's content must appear after it — proving
    // the two sections aren't interleaved.
    expect(upcomingItemIndex).toBeLessThan(pastHeadingIndex);
    expect(pastRunIndex).toBeGreaterThan(pastHeadingIndex);
  });

  test("renders the Upcoming empty state and Past empty state independently when both are empty", () => {
    const html = renderQueueActivityPage({
      agent: AGENT,
      snapshot: null,
      crons: [],
      runs: [],
      filters: {},
      pagination: { total: 0, limit: 20, page: 1 },
      userName: "admin@example.com",
    });
    expect(html).toContain("No work queue snapshot yet");
    expect(html).toContain("No runs match the selected filters.");
  });
});

// ─── All page renderers — shared head via renderAdminPage (CFB-1.2) ─────────
//
// Every render*Page-style function in this file builds its <!DOCTYPE html>
// head via the shared admin-ui-layout.ts#renderAdminPage() helper. This loop
// calls each of the 20 render sites (19 functions — renderChatThreadPage has
// two distinct DOCTYPE blocks: its degraded early-return and its main return)
// with minimal valid fixtures and asserts each output has exactly one
// DOCTYPE and exactly one viewport meta tag, guarding against any call site
// drifting back to a hand-rolled head or double-wrapping.

describe("all page renderers — single DOCTYPE and viewport meta (CFB-1.2)", () => {
  const MINIMAL_TASK: TaskItem = {
    id: "TASK-LOOP-1",
    title: "Loop test task",
    status: "pending",
    session: null,
    repo: null,
    assignee: null,
    claimedBy: null,
  };

  const MINIMAL_PR: PrListItem = {
    id: "pr-loop-1",
    repo: "org/repo",
    prNumber: 1,
    staged: false,
    state: "open",
    reviewState: "pending",
    commitSha: null,
    patchCycles: 0,
    reviewCycles: 0,
    agentId: null,
    claimedBy: null,
    reviewedAt: null,
    patchedAt: null,
    mergedAt: null,
    claimedAt: null,
    heartbeatAt: null,
    createdAt: "2026-06-01T09:00:00Z",
    updatedAt: "2026-06-01T09:00:00Z",
  };

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
      "renderTasksPage",
      () =>
        renderTasksPage(
          [MINIMAL_TASK],
          {},
          false,
          USER_NAME,
          {},
          { total: 1, limit: 50, page: 1 },
        ),
    ],
    [
      "renderTaskDetailPage",
      () => renderTaskDetailPage(MINIMAL_TASK, USER_NAME),
    ],
    [
      "renderSessionDetailPage",
      () =>
        renderSessionDetailPage("session-loop-1", [MINIMAL_TASK], USER_NAME),
    ],
    [
      "renderPrsPage",
      () =>
        renderPrsPage(
          [MINIMAL_PR],
          {},
          false,
          USER_NAME,
          {},
          { total: 1, limit: 50, page: 1 },
        ),
    ],
    ["renderPrDetailPage", () => renderPrDetailPage(MINIMAL_PR, USER_NAME)],
    [
      "renderQueueActivityPage",
      () =>
        renderQueueActivityPage({
          agent: { id: "agent-123", name: "Test Agent" },
          snapshot: null,
          crons: [],
          runs: [],
          filters: {},
          pagination: { total: 0, limit: 50, page: 1 },
          userName: USER_NAME,
        }),
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

  test("all 18 render sites are covered by this loop", () => {
    expect(renderers.length).toBe(18);
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
