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
  type MemberItem,
  type PluginItem,
  type PrListItem,
  type PullRequestItem,
  type TaskItem,
  type TokenItem,
  type ToolItem,
  renderAgentDetailPage,
  renderAgentsPage,
  renderCronRunsPage,
  renderLoginPage,
  renderPrDetailPage,
  renderProvisionCompletePage,
  renderProvisionPasteForm,
  renderProvisionStartPage,
  renderPrsPage,
  renderTaskDetailPage,
  renderTasksPage,
  renderChatPage,
  renderChatThreadPage,
} from "./admin-ui-pages.ts";
import type { ChatMessage, ChatThread } from "./http-chat-client.ts";
import { renderAdminToolbar } from "./admin-ui-styles.ts";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const AGENT: AgentDetail = {
  id: "agent-123",
  name: "Test Agent",
  slackId: "U12345",
  selfHosted: false,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-02T00:00:00Z"),
  repos: [],
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
  preCheck: "shipwright:check-dev-task.ts",
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
};

const TOOL_ENABLED: ToolItem = {
  id: "tool-1",
  pattern: "Bash(git:*)",
  enabled: true,
};

const TOOL_DISABLED: ToolItem = {
  id: "tool-2",
  pattern: "Read(**)",
  enabled: false,
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
};

const PLUGIN_DISABLED: PluginItem = {
  id: "plug-2",
  name: "entropy-patrol",
  version: null,
  enabled: false,
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

  test("empty state includes link to /admin/provision", () => {
    const html = renderAgentsPage([], USER_NAME, true, "UTC");
    expect(html).toContain("/admin/provision");
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

  test("non-admin: provision button is hidden", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME, false, "UTC");
    expect(html).not.toContain("+ Provision agent");
  });

  test("non-admin: empty state shows 'No agents.' without provision link", () => {
    const html = renderAgentsPage([], USER_NAME, false, "UTC");
    expect(html).toContain("No agents.");
    expect(html).not.toContain("Provision one");
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
});

// ─── renderProvisionStartPage ────────────────────────────────────────────────

const AGENTS_FIXTURE = [
  { id: "agent-001", name: "Alpha Agent" },
  { id: "agent-002", name: "Beta Agent" },
];

describe("renderProvisionStartPage", () => {
  test("returns a valid HTML document", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("includes 'Provision Agent' page title", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).toContain("Provision Agent");
  });

  test("without oauthUrl: shows xoxp token form", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).toContain("xoxpToken");
  });

  test("without oauthUrl: form action is /admin/provision/start", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).toContain('action="/admin/provision/start"');
  });

  test("with oauthUrl: shows authorize link", () => {
    const html = renderProvisionStartPage(USER_NAME, [], {
      oauthUrl: "https://slack.com/oauth/v2/authorize?client_id=123",
    });
    expect(html).toContain("Authorize Slack App");
    expect(html).toContain(
      "https://slack.com/oauth/v2/authorize?client_id=123",
    );
  });

  test("with oauthUrl: does NOT show xoxp form", () => {
    const html = renderProvisionStartPage(USER_NAME, [], {
      oauthUrl: "https://slack.com/oauth/v2/authorize?client_id=123",
    });
    expect(html).not.toContain('action="/admin/provision/start"');
  });

  test("no error div when no error", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).not.toContain('class="alert alert-error"');
  });

  test("error shown when opts.error set", () => {
    const html = renderProvisionStartPage(USER_NAME, [], {
      error: "Invalid token",
    });
    expect(html).toContain('class="alert alert-error"');
    expect(html).toContain("Invalid token");
  });

  test("XSS: error is escaped", () => {
    const html = renderProvisionStartPage(USER_NAME, [], {
      error: "<script>xss()</script>",
    });
    expect(html).not.toContain("<script>xss()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("non-https oauthUrl: authorize href is empty (safe URL guard)", () => {
    const html = renderProvisionStartPage(USER_NAME, [], {
      oauthUrl: "javascript:alert(1)",
    });
    // safeOauthUrl is empty string when URL doesn't start with https://
    expect(html).toContain('href=""');
  });

  // ── new tests for agent selector + GitHub/Claude fields ──────────────────

  test("renders agent selector element", () => {
    const html = renderProvisionStartPage(USER_NAME, AGENTS_FIXTURE);
    expect(html).toContain('name="agentId"');
    expect(html).toContain("<select");
  });

  test("renders an option for each agent", () => {
    const html = renderProvisionStartPage(USER_NAME, AGENTS_FIXTURE);
    expect(html).toContain("agent-001");
    expect(html).toContain("Alpha Agent");
    expect(html).toContain("agent-002");
    expect(html).toContain("Beta Agent");
  });

  test("renders empty selector when agents=[]", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).toContain('name="agentId"');
    // no option values from agents
    expect(html).not.toContain('value="agent-001"');
  });

  test("XSS: agent name in select option is escaped", () => {
    const xssAgents = [{ id: "a1", name: "<script>evil()</script>" }];
    const html = renderProvisionStartPage(USER_NAME, xssAgents);
    expect(html).not.toContain("<script>evil()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("renders ghAuthMode radio buttons (pat and app)", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).toContain('name="ghAuthMode"');
    expect(html).toContain('value="pat"');
    expect(html).toContain('value="app"');
  });

  test("renders GitHub PAT password input", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).toContain('name="ghPat"');
  });

  test("renders GitHub App fields (ghAppId, ghAppInstallationId, ghAppPrivateKey)", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).toContain('name="ghAppId"');
    expect(html).toContain('name="ghAppInstallationId"');
    expect(html).toContain('name="ghAppPrivateKey"');
  });

  test("renders AI creds section (anthropicApiKey, claudeCodeOauthToken)", () => {
    const html = renderProvisionStartPage(USER_NAME, []);
    expect(html).toContain('name="anthropicApiKey"');
    expect(html).toContain('name="claudeCodeOauthToken"');
  });
});

// ─── renderProvisionPasteForm ─────────────────────────────────────────────────

describe("renderProvisionPasteForm", () => {
  test("returns a valid HTML document", () => {
    const html = renderProvisionPasteForm(USER_NAME);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("form action is /admin/provision/complete", () => {
    const html = renderProvisionPasteForm(USER_NAME);
    expect(html).toContain('action="/admin/provision/complete"');
  });

  test("agentId in hidden input when provided", () => {
    const html = renderProvisionPasteForm(USER_NAME, { agentId: "agent-abc" });
    expect(html).toContain('name="agentId"');
    expect(html).toContain('value="agent-abc"');
  });

  test("hidden agentId input empty when not provided", () => {
    const html = renderProvisionPasteForm(USER_NAME);
    expect(html).toContain('name="agentId"');
    expect(html).toContain('value=""');
  });

  test("XSS: agentId in hidden input is escaped", () => {
    const html = renderProvisionPasteForm(USER_NAME, {
      agentId: '"><script>xss()</script>',
    });
    expect(html).not.toContain('"><script>xss()</script>');
    expect(html).toContain("&lt;script&gt;");
  });

  test("no error div when no error", () => {
    const html = renderProvisionPasteForm(USER_NAME);
    expect(html).not.toContain('class="alert alert-error"');
  });

  test("error shown when opts.error set", () => {
    const html = renderProvisionPasteForm(USER_NAME, {
      error: "Missing credentials",
    });
    expect(html).toContain('class="alert alert-error"');
    expect(html).toContain("Missing credentials");
  });

  test("XSS: error is escaped", () => {
    const html = renderProvisionPasteForm(USER_NAME, {
      error: "<script>bad()</script>",
    });
    expect(html).not.toContain("<script>bad()</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("includes App ID and Signing Secret fields", () => {
    const html = renderProvisionPasteForm(USER_NAME);
    expect(html).toContain('name="appId"');
    expect(html).toContain('name="signingSecret"');
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

  // AC1: clicking anywhere on a task row navigates to the task detail page
  test("each task row has a data-href that navigates to the task detail URL", () => {
    const html = render([TASK_ITEM]);
    expect(html).toContain(`data-href="/admin/tasks/${TASK_ITEM.id}"`);
  });

  test("data-href URL uses the escaped task id", () => {
    const xssTask: TaskItem = { ...TASK_ITEM, id: "TASK-XSS" };
    const html = render([xssTask]);
    expect(html).toContain(`data-href="/admin/tasks/TASK-XSS"`);
  });

  test("data-href URL escapes single quotes in task id", () => {
    const singleQuoteTask: TaskItem = { ...TASK_ITEM, id: "TASK-IT'S" };
    const html = render([singleQuoteTask]);
    // Single quote must be encoded as &#39; — raw ' in the attribute would break HTML parsing
    expect(html).toContain(`data-href="/admin/tasks/TASK-IT&#39;S"`);
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
    expect(html).toContain(`/admin/tasks/${TASK_ITEM.id}/release`);
  });

  test("no Release button for non-in_progress tasks, but row is still navigable", () => {
    const html = render([TASK_ITEM_PENDING]);
    expect(html).not.toContain("Release");
    expect(html).toContain(`data-href="/admin/tasks/${TASK_ITEM_PENDING.id}"`);
  });

  test("empty task list renders no clickable rows", () => {
    const html = render([]);
    expect(html).not.toContain('data-href="/admin/tasks/');
    expect(html).toContain("No tasks found");
  });

  test("multiple tasks each get their own data-href pointing to their detail URL", () => {
    const html = render([TASK_ITEM, TASK_ITEM_PENDING]);
    expect(html).toContain(`data-href="/admin/tasks/${TASK_ITEM.id}"`);
    expect(html).toContain(`data-href="/admin/tasks/${TASK_ITEM_PENDING.id}"`);
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

  test("renderTasksPage with repos suggestions renders repo datalist", () => {
    const html = renderTasksPage(
      [],
      {},
      false,
      "user@test.com",
      {},
      pagination,
      undefined,
      { repos: ["org/repo-a", "org/repo-b"] },
    );
    expect(html).toContain('<datalist id="repos-list">');
    expect(html).toContain('<option value="org/repo-a">');
    expect(html).toContain('list="repos-list"');
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

  test("renderTasksPage without suggestions renders plain text inputs (no datalists)", () => {
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
    expect(html).not.toContain("<datalist");
    expect(html).not.toContain('list="sessions-list"');
    expect(html).not.toContain('list="repos-list"');
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

  // AC3: dep block renders with the dep ID "Blocked: REL-2.2"
  test("dep block renders as 'Blocked: <dep-id>'", () => {
    const html = render([PENDING_TASK_DEP]);
    expect(html).toContain("Blocked: REL-2.2");
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
    expect(html).toContain("Blocked: REL-3.1");
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

  test("empty state colspan is 8 (7 columns + 1 for new PR column)", () => {
    const html = render([]);
    expect(html).toContain('colspan="8"');
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

  test("Reset button links to /admin/tasks with no params", () => {
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
    expect(html).toContain('href="/admin/tasks"');
    expect(html).toContain("Reset");
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
    // Ready tab href contains state=ready
    expect(html).toMatch(/href="\/admin\/tasks\?state=ready"[^>]*>Ready</);
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

// ─── renderAdminToolbar — active nav highlight ────────────────────────────────

describe("renderAdminToolbar — active nav highlight", () => {
  test("activePath /admin/agents: Agents link is active, Provision is not", () => {
    const html = renderAdminToolbar(USER_NAME, "/admin/agents");
    expect(html).toContain('href="/admin/agents" class="vos-nav-link active"');
    expect(html).toContain('href="/admin/provision" class="vos-nav-link"');
    expect(html).not.toContain(
      'href="/admin/provision" class="vos-nav-link active"',
    );
  });

  test("activePath sub-path /admin/agents/agent-id: Agents link is still active (startsWith)", () => {
    const html = renderAdminToolbar(USER_NAME, "/admin/agents/agent-id");
    expect(html).toContain('href="/admin/agents" class="vos-nav-link active"');
    expect(html).not.toContain(
      'href="/admin/provision" class="vos-nav-link active"',
    );
  });

  test("activePath /admin/provision: Provision link is active, Agents is not", () => {
    const html = renderAdminToolbar(USER_NAME, "/admin/provision");
    expect(html).toContain(
      'href="/admin/provision" class="vos-nav-link active"',
    );
    expect(html).toContain('href="/admin/agents" class="vos-nav-link"');
    expect(html).not.toContain(
      'href="/admin/agents" class="vos-nav-link active"',
    );
  });

  test("activePath '' (default): neither link is active", () => {
    const html = renderAdminToolbar(USER_NAME);
    expect(html).not.toContain('class="vos-nav-link active"');
    expect(html).toContain('href="/admin/agents" class="vos-nav-link"');
    expect(html).toContain('href="/admin/provision" class="vos-nav-link"');
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

  test("blockers card appears before description card when blockedBy is set", () => {
    const html = render();
    const blockersIdx = html.indexOf("Blockers");
    const descriptionIdx = html.indexOf("Description");
    expect(blockersIdx).toBeGreaterThan(-1);
    expect(descriptionIdx).toBeGreaterThan(-1);
    expect(blockersIdx).toBeLessThan(descriptionIdx);
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
        addedAt: "2025-01-16T05:00:00Z", // Jan 16 UTC, Jan 15 Pacific
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
        addedAt: "2025-01-16T05:00:00Z",
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

// ─── renderPrsPage ────────────────────────────────────────────────────────────

const PR_LIST_ITEM_1: PrListItem = {
  id: "pr-001",
  repo: "org/repo-a",
  prNumber: 10,
  taskId: "TASK-1",
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
  taskId: null,
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

describe("renderPrsPage", () => {
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
    expect(html).toContain("Updated");
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

  test("renders taskId when present", () => {
    const html = render([PR_LIST_ITEM_1]);
    expect(html).toContain("TASK-1");
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

  test("filter form includes repo input", () => {
    const html = render();
    expect(html).toContain('name="repo"');
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
    expect(html).toContain("org/my-repo");
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
});

// ─── renderPrsPage — datalist autocomplete (AFP-1.2) ─────────────────────────

describe("renderPrsPage — datalist autocomplete", () => {
  const pagination = { total: 0, limit: 50, page: 1 };

  test("renderPrsPage with repos suggestions renders repo datalist", () => {
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
    expect(html).toContain('<datalist id="prs-repos-list">');
    expect(html).toContain('<option value="org/repo-a">');
    expect(html).toContain('<option value="org/repo-b">');
    expect(html).toContain('list="prs-repos-list"');
  });

  test("renderPrsPage without suggestions renders plain text input (no datalist)", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      undefined,
    );
    expect(html).not.toContain("<datalist");
    expect(html).not.toContain('list="prs-repos-list"');
  });

  test("renderPrsPage escapes repo suggestion values to prevent XSS", () => {
    const html = renderPrsPage(
      [],
      {},
      false,
      USER_NAME,
      {},
      pagination,
      undefined,
      { repos: ['<script>alert("xss")</script>'] },
    );
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderPrDetailPage ──────────────────────────────────────────────────────

const PR_DETAIL: PrListItem = {
  id: "pr-detail-001",
  repo: "org/detail-repo",
  prNumber: 99,
  taskId: "TASK-99",
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
  function render(pr: PrListItem = PR_DETAIL): string {
    return renderPrDetailPage(pr, USER_NAME, { "agent-x": "Xray Agent" });
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

  test("renders taskId field when present", () => {
    const html = render();
    expect(html).toContain("TASK-99");
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
});

// ─── renderCronRunsPage ──────────────────────────────────────────────────────

describe("renderCronRunsPage", () => {
  const CRON_AGENT = { id: "agent-123", name: "Test Agent" };
  const CRON = {
    id: "cron-456",
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
      inputTokens: 1200,
      outputTokens: 340,
      ...overrides,
    };
  }

  function render(runs: CronRunItem[]): string {
    return renderCronRunsPage({
      agent: CRON_AGENT,
      cron: CRON,
      runs,
      userName: "admin@example.com",
      timezone: "America/Los_Angeles",
    });
  }

  test("renders the column headers", () => {
    const html = render([makeRun()]);
    expect(html).toContain("Outcome");
    expect(html).toContain("Started");
    expect(html).toContain("Duration");
    expect(html).toContain("Tokens");
    expect(html).toContain("<th>Model</th>");
    // Cost is shown inline within the Model column's badges, not as its own column.
    expect(html).not.toContain("<th>Cost</th>");
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

  test("renders the cron name in the header", () => {
    const html = render([makeRun()]);
    expect(html).toContain("status check");
  });

  test("renders empty state when no runs exist", () => {
    const html = render([]);
    expect(html).toContain("No runs recorded yet.");
  });

  test("renders em-dash for null tokens and no duration", () => {
    const html = render([
      makeRun({
        inputTokens: null,
        outputTokens: null,
        completedAt: null,
      }),
    ]);
    expect(html).toContain("—");
  });

  test("escapes XSS in the outcome field", () => {
    const html = render([makeRun({ outcome: '"><script>alert(2)</script>' })]);
    expect(html).not.toContain("<script>alert(2)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes XSS in the cron and agent names", () => {
    const html = renderCronRunsPage({
      agent: { id: "agent-123", name: "<img src=x onerror=alert(3)>" },
      cron: { id: "cron-456", name: "<b>evil</b>", schedule: "0 * * * *" },
      runs: [makeRun()],
      userName: "admin@example.com",
      timezone: "America/Los_Angeles",
    });
    expect(html).not.toContain("<img src=x onerror=alert(3)>");
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;b&gt;evil");
  });

  test("uses renderAdminToolbar with /admin/agents active path", () => {
    const html = render([makeRun()]);
    expect(html).toContain('href="/admin/agents" class="vos-nav-link active"');
  });
});

// ─── renderTasksPage — mobile column hiding ───────────────────────────────────

describe("renderTasksPage — mobile column hiding", () => {
  function render(
    tasks: TaskItem[] = [TASK_ITEM],
    readOnly = false,
  ): string {
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
    const sessionTdMatches = html.match(/<td[^>]*class="[^"]*col-session[^"]*"[^>]*>/g);
    const repoTdMatches = html.match(/<td[^>]*class="[^"]*col-repo[^"]*"[^>]*>/g);
    // One col-session td per row (2 rows)
    expect(sessionTdMatches).not.toBeNull();
    expect((sessionTdMatches ?? []).length).toBe(2);
    expect(repoTdMatches).not.toBeNull();
    expect((repoTdMatches ?? []).length).toBe(2);
  });
});

// ─── renderPrsPage — mobile column hiding (AMB-1.4) ──────────────────────────

describe("renderPrsPage — mobile column hiding", () => {
  function render(prs: PrListItem[] = [PR_LIST_ITEM_1, PR_LIST_ITEM_2]): string {
    return renderPrsPage(
      prs,
      {},
      false,
      USER_NAME,
      { "agent-001": "Alpha Agent" },
      { total: prs.length, limit: 50, page: 1 },
    );
  }

  // AC2: col-review-cycles class on the Review Cycles <th>
  test("Review Cycles <th> has class col-review-cycles", () => {
    const html = render();
    expect(html).toContain('class="col-review-cycles"');
    expect(html).toMatch(/<th[^>]*class="[^"]*col-review-cycles[^"]*"[^>]*>Review Cycles<\/th>/);
  });

  // AC2: col-patch-cycles class on the Patch Cycles <th>
  test("Patch Cycles <th> has class col-patch-cycles", () => {
    const html = render();
    expect(html).toContain('class="col-patch-cycles"');
    expect(html).toMatch(/<th[^>]*class="[^"]*col-patch-cycles[^"]*"[^>]*>Patch Cycles<\/th>/);
  });

  // AC2: col-claimed-by class on the Claimed By <th>
  test("Claimed By <th> has class col-claimed-by", () => {
    const html = render();
    expect(html).toContain('class="col-claimed-by"');
    expect(html).toMatch(/<th[^>]*class="[^"]*col-claimed-by[^"]*"[^>]*>Claimed By<\/th>/);
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
    const reviewCyclesTdMatches = html.match(/<td[^>]*class="[^"]*col-review-cycles[^"]*"[^>]*>/g);
    const patchCyclesTdMatches = html.match(/<td[^>]*class="[^"]*col-patch-cycles[^"]*"[^>]*>/g);
    const claimedByTdMatches = html.match(/<td[^>]*class="[^"]*col-claimed-by[^"]*"[^>]*>/g);
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

  test("responsive: sidebar has chat-list-sidebar class for mobile styling", () => {
    const html = renderChatPage(AGENTS, "agent-1", THREADS, "alice");
    expect(html).toContain("chat-list-sidebar");
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
    tokens: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
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
    const html = renderChatThreadPage("agent-xyz", THREAD, [ASSISTANT_MSG], "alice");
    expect(html).toContain("#f0fdf4");
    expect(html).toContain("flex-start");
  });

  test("assistant messages render markdown: bold text becomes <strong>", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [ASSISTANT_MSG], "alice");
    expect(html).toContain("<strong>bold text</strong>");
  });

  test("assistant messages render markdown: inline code becomes <code>", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [ASSISTANT_MSG], "alice");
    expect(html).toContain("<code>inline code</code>");
  });

  test("errorKind rate-limited shows human-readable error state", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [ERROR_MSG], "alice");
    expect(html).toContain("Rate limited");
  });

  test("errorKind message renders a red/error badge or indicator", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [ERROR_MSG], "alice");
    // should have some red / error styling
    expect(html.toLowerCase()).toMatch(/error|#ef4444|#fee2e2|#b91c1c|#dc2626/);
  });

  test("empty thread shows empty state message", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [], "alice");
    expect(html).toContain("No messages");
  });

  test("page includes messages-container element for JS polling", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("messages-container");
  });

  test("page includes thinking-indicator id in the inline JS", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("thinking-indicator");
  });

  test("page includes send-btn id for send button", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("send-btn");
  });

  test("page includes messages.json polling endpoint reference in JS", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("messages.json");
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
    const html = renderChatThreadPage("agent-xyz", THREAD, [msgWithUpload], "alice");
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
    const html = renderChatThreadPage("agent-xyz", THREAD, [msgWithPlan], "alice");
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
    const html = renderChatThreadPage("agent-xyz", THREAD, [msgWithSilent], "alice");
    expect(html).not.toContain("[silent]");
    expect(html).toContain("All done");
  });

  test("strips [react:emoji] marker from displayed text", () => {
    const msgWithReact: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "Great work [react:thumbsup]",
    };
    const html = renderChatThreadPage("agent-xyz", THREAD, [msgWithReact], "alice");
    expect(html).not.toContain("[react:");
    expect(html).not.toContain("thumbsup");
    expect(html).toContain("Great work");
  });

  test("strips [speak:text] marker from displayed text", () => {
    const msgWithSpeak: ChatMessage = {
      ...ASSISTANT_MSG,
      body: "Done with the task [speak:all work complete]",
    };
    const html = renderChatThreadPage("agent-xyz", THREAD, [msgWithSpeak], "alice");
    expect(html).not.toContain("[speak:");
    expect(html).not.toContain("all work complete");
    expect(html).toContain("Done with the task");
  });

  test("HTML-escapes marker content (XSS protection on paths/URLs)", () => {
    const msgWithXss: ChatMessage = {
      ...ASSISTANT_MSG,
      body: 'File saved [upload:/tmp/file<script>.pdf]',
    };
    const html = renderChatThreadPage("agent-xyz", THREAD, [msgWithXss], "alice");
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
    const html = renderChatThreadPage("agent-xyz", THREAD, [msgWithMultiple], "alice");
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
    const html = renderChatThreadPage("agent-xyz", THREAD, [msgWithMultipleMarkers], "alice");
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
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], THREADS_LIST, "alice");
    expect(html).toContain("chat-thread-sidebar");
  });

  test("responsive: message bubble has chat-bubble-inner class for width overrides", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("chat-bubble-inner");
  });

  test("responsive: main content wrapper has chat-thread-layout class for mobile reflow", () => {
    const html = renderChatThreadPage("agent-xyz", THREAD, [USER_MSG], "alice");
    expect(html).toContain("chat-thread-layout");
  });
});
