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
  type PluginItem,
  type TokenItem,
  type ToolItem,
  renderAgentDetailPage,
  renderAgentsPage,
  renderLoginPage,
  renderProvisionCompletePage,
  renderProvisionPasteForm,
  renderProvisionStartPage,
} from "./admin-ui-pages.ts";
import { renderAdminToolbar } from "./admin-ui-styles.ts";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const AGENT: AgentDetail = {
  id: "agent-123",
  name: "Test Agent",
  slackId: "U12345",
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-02T00:00:00Z"),
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
    const html = renderAgentsPage([], USER_NAME);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  test("empty agents array shows 'No agents yet' empty state", () => {
    const html = renderAgentsPage([], USER_NAME);
    expect(html).toContain("No agents yet");
  });

  test("empty state includes link to /admin/provision", () => {
    const html = renderAgentsPage([], USER_NAME);
    expect(html).toContain("/admin/provision");
  });

  test("agent name appears as a link", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME);
    expect(html).toContain("Test Agent");
    expect(html).toContain('href="/admin/agents/agent-123"');
  });

  test("Manage button links to agent detail page", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME);
    expect(html).toContain("Manage");
    expect(html).toContain(`/admin/agents/${AGENT_LIST_ITEM.id}`);
  });

  test("XSS: agent name is escaped", () => {
    const xssAgent: AgentListItem = {
      ...AGENT_LIST_ITEM,
      name: '<script>alert("xss")</script>',
    };
    const html = renderAgentsPage([xssAgent], USER_NAME);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: agent id used in href is escaped", () => {
    const xssAgent: AgentListItem = {
      ...AGENT_LIST_ITEM,
      id: 'agent-"><script>',
    };
    const html = renderAgentsPage([xssAgent], USER_NAME);
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("multiple agents are all rendered", () => {
    const second: AgentListItem = {
      ...AGENT_LIST_ITEM,
      id: "agent-456",
      name: "Second Agent",
    };
    const html = renderAgentsPage([AGENT_LIST_ITEM, second], USER_NAME);
    expect(html).toContain("Test Agent");
    expect(html).toContain("Second Agent");
  });

  test("no empty-state message when agents present", () => {
    const html = renderAgentsPage([AGENT_LIST_ITEM], USER_NAME);
    expect(html).not.toContain("No agents yet");
  });
});

// ─── renderAgentDetailPage — overview ────────────────────────────────────────

describe("renderAgentDetailPage — overview", () => {
  function render(opts?: Parameters<typeof renderAgentDetailPage>[7]): string {
    return renderAgentDetailPage(AGENT, {}, [], [], [], [], USER_NAME, opts);
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
    const html = renderAgentDetailPage(xssAgent, {}, [], [], [], [], USER_NAME);
    expect(html).not.toContain("<script>");
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
    expect(html).not.toContain("<script>");
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
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("back link to /admin/agents present", () => {
    const html = render();
    expect(html).toContain('href="/admin/agents"');
  });
});

// ─── renderAgentDetailPage — env vars section ────────────────────────────────

describe("renderAgentDetailPage — env vars", () => {
  function render(envVars: Record<string, string>): string {
    return renderAgentDetailPage(AGENT, envVars, [], [], [], [], USER_NAME);
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
    expect(html).not.toContain("<script>");
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
    return renderAgentDetailPage(AGENT, {}, crons, [], [], [], USER_NAME);
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
    expect(html).not.toContain("<script>");
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
});

// ─── renderAgentDetailPage — tools section ───────────────────────────────────

describe("renderAgentDetailPage — tools", () => {
  function render(tools: ToolItem[]): string {
    return renderAgentDetailPage(AGENT, {}, [], tools, [], [], USER_NAME);
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
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderAgentDetailPage — tokens section ──────────────────────────────────

describe("renderAgentDetailPage — tokens", () => {
  function render(tokens: TokenItem[]): string {
    return renderAgentDetailPage(AGENT, {}, [], [], tokens, [], USER_NAME);
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
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderAgentDetailPage — plugins section ─────────────────────────────────

describe("renderAgentDetailPage — plugins", () => {
  function render(plugins: PluginItem[]): string {
    return renderAgentDetailPage(AGENT, {}, [], [], [], plugins, USER_NAME);
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
    expect(html).not.toContain("<script>");
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
    expect(html).not.toContain("<script>");
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
    const xssAgents = [{ id: "a1", name: '<script>evil()</script>' }];
    const html = renderProvisionStartPage(USER_NAME, xssAgents);
    expect(html).not.toContain("<script>");
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
    expect(html).not.toContain("<script>");
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
    expect(html).not.toContain("<script>");
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
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("XSS: agentId in View Agent link is escaped", () => {
    const html = renderProvisionCompletePage(USER_NAME, {
      success: true,
      agentId: '"><script>xss()</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// ─── renderAdminToolbar — active nav highlight ────────────────────────────────

describe("renderAdminToolbar — active nav highlight", () => {
  test("activePath /admin/agents: Agents link is active, Provision is not", () => {
    const html = renderAdminToolbar(USER_NAME, "/admin/agents");
    expect(html).toContain('href="/admin/agents" class="vos-nav-link active"');
    expect(html).toContain('href="/admin/provision" class="vos-nav-link"');
    expect(html).not.toContain('href="/admin/provision" class="vos-nav-link active"');
  });

  test("activePath sub-path /admin/agents/agent-id: Agents link is still active (startsWith)", () => {
    const html = renderAdminToolbar(USER_NAME, "/admin/agents/agent-id");
    expect(html).toContain('href="/admin/agents" class="vos-nav-link active"');
    expect(html).not.toContain('href="/admin/provision" class="vos-nav-link active"');
  });

  test("activePath /admin/provision: Provision link is active, Agents is not", () => {
    const html = renderAdminToolbar(USER_NAME, "/admin/provision");
    expect(html).toContain('href="/admin/provision" class="vos-nav-link active"');
    expect(html).toContain('href="/admin/agents" class="vos-nav-link"');
    expect(html).not.toContain('href="/admin/agents" class="vos-nav-link active"');
  });

  test("activePath '' (default): neither link is active", () => {
    const html = renderAdminToolbar(USER_NAME);
    expect(html).not.toContain('class="vos-nav-link active"');
    expect(html).toContain('href="/admin/agents" class="vos-nav-link"');
    expect(html).toContain('href="/admin/provision" class="vos-nav-link"');
  });
});
