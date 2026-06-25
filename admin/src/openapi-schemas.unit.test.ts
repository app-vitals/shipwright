/**
 * admin/src/openapi-schemas.unit.test.ts
 * Parse/reject tests for all Zod entity schemas in openapi-schemas.ts.
 * Tests validate that good input parses cleanly and bad input produces typed errors.
 */

import { describe, expect, test } from "bun:test";
import {
  type Agent,
  type AgentCronJob,
  AgentCronJobSchema,
  type AgentPlugin,
  AgentPluginSchema,
  AgentSchema,
  type AgentToken,
  AgentTokenSchema,
  type AgentTool,
  AgentToolSchema,
  ErrorSchema,
} from "./openapi-schemas.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date().toISOString();

const validAgent = {
  id: "cuid1",
  name: "Bodhi",
  slackId: "U01234567",
  selfHosted: false,
  createdAt: now,
  updatedAt: now,
};

const validCronJob = {
  id: "cuid2",
  agentId: "cuid1",
  schedule: "0 9 * * 1-5",
  prompt: "Run the morning brief",
  channel: "C01234567",
  user: null,
  silent: false,
  enabled: true,
  preCheck: null,
  name: "morning-brief",
  system: false,
  createdAt: now,
  updatedAt: now,
};

const validTool = {
  id: "cuid3",
  agentId: "cuid1",
  pattern: "Bash",
  enabled: true,
  createdAt: now,
};

const validToken = {
  id: "cuid4",
  agentId: "cuid1",
  label: "ci-token",
  createdAt: now,
  revokedAt: null,
};

const validPlugin = {
  id: "cuid5",
  agentId: "cuid1",
  name: "shipwright",
  version: "1.0.0",
  enabled: true,
  createdAt: now,
  updatedAt: now,
};

// ─── AgentSchema ─────────────────────────────────────────────────────────────

describe("AgentSchema", () => {
  test("parses valid agent with slackId", () => {
    const result = AgentSchema.safeParse(validAgent);
    expect(result.success).toBe(true);
    if (result.success) {
      const agent: Agent = result.data;
      expect(agent.id).toBe("cuid1");
      expect(agent.name).toBe("Bodhi");
      expect(agent.slackId).toBe("U01234567");
    }
  });

  test("parses valid agent without slackId", () => {
    const { slackId: _, ...agentNoSlack } = validAgent;
    const result = AgentSchema.safeParse(agentNoSlack);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.slackId).toBeUndefined();
    }
  });

  test("parses valid agent with null slackId", () => {
    const result = AgentSchema.safeParse({ ...validAgent, slackId: null });
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const { id: _, ...noId } = validAgent;
    const result = AgentSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  test("rejects missing name", () => {
    const { name: _, ...noName } = validAgent;
    const result = AgentSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });

  test("does not expose slackBotToken", () => {
    const withSecret = { ...validAgent, slackBotToken: "xoxb-secret" };
    const result = AgentSchema.safeParse(withSecret);
    // Should still parse (extra fields are stripped), but the type should not include it
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data as Record<string, unknown>).slackBotToken,
      ).toBeUndefined();
    }
  });

  test("does not expose anthropicApiKey", () => {
    const withSecret = { ...validAgent, anthropicApiKey: "sk-ant-secret" };
    const result = AgentSchema.safeParse(withSecret);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data as Record<string, unknown>).anthropicApiKey,
      ).toBeUndefined();
    }
  });
});

// ─── AgentCronJobSchema ───────────────────────────────────────────────────────

describe("AgentCronJobSchema", () => {
  test("parses valid cron job", () => {
    const result = AgentCronJobSchema.safeParse(validCronJob);
    expect(result.success).toBe(true);
    if (result.success) {
      const cron: AgentCronJob = result.data;
      expect(cron.schedule).toBe("0 9 * * 1-5");
      expect(cron.silent).toBe(false);
      expect(cron.system).toBe(false);
    }
  });

  test("parses cron job with user instead of channel", () => {
    const userCron = { ...validCronJob, channel: null, user: "U01234567" };
    const result = AgentCronJobSchema.safeParse(userCron);
    expect(result.success).toBe(true);
  });

  test("parses cron job with all optional fields absent", () => {
    const minimal = {
      id: "cuid2",
      agentId: "cuid1",
      schedule: "0 9 * * *",
      prompt: "Do something",
      channel: null,
      user: null,
      silent: true,
      enabled: true,
      preCheck: null,
      name: null,
      system: false,
      createdAt: now,
      updatedAt: now,
    };
    const result = AgentCronJobSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  test("rejects missing schedule", () => {
    const { schedule: _, ...noSchedule } = validCronJob;
    const result = AgentCronJobSchema.safeParse(noSchedule);
    expect(result.success).toBe(false);
  });

  test("rejects missing prompt", () => {
    const { prompt: _, ...noPrompt } = validCronJob;
    const result = AgentCronJobSchema.safeParse(noPrompt);
    expect(result.success).toBe(false);
  });
});

// ─── AgentToolSchema ──────────────────────────────────────────────────────────

describe("AgentToolSchema", () => {
  test("parses valid tool", () => {
    const result = AgentToolSchema.safeParse(validTool);
    expect(result.success).toBe(true);
    if (result.success) {
      const tool: AgentTool = result.data;
      expect(tool.pattern).toBe("Bash");
      expect(tool.enabled).toBe(true);
    }
  });

  test("rejects missing pattern", () => {
    const { pattern: _, ...noPattern } = validTool;
    const result = AgentToolSchema.safeParse(noPattern);
    expect(result.success).toBe(false);
  });

  test("rejects missing agentId", () => {
    const { agentId: _, ...noAgentId } = validTool;
    const result = AgentToolSchema.safeParse(noAgentId);
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean enabled", () => {
    const result = AgentToolSchema.safeParse({ ...validTool, enabled: "yes" });
    expect(result.success).toBe(false);
  });
});

// ─── AgentTokenSchema ─────────────────────────────────────────────────────────

describe("AgentTokenSchema", () => {
  test("parses valid token metadata", () => {
    const result = AgentTokenSchema.safeParse(validToken);
    expect(result.success).toBe(true);
    if (result.success) {
      const token: AgentToken = result.data;
      expect(token.label).toBe("ci-token");
      expect(token.revokedAt).toBeNull();
    }
  });

  test("parses token without label", () => {
    const { label: _, ...noLabel } = validToken;
    const result = AgentTokenSchema.safeParse(noLabel);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.label).toBeUndefined();
    }
  });

  test("parses token with null label", () => {
    const result = AgentTokenSchema.safeParse({ ...validToken, label: null });
    expect(result.success).toBe(true);
  });

  test("parses revoked token with revokedAt set", () => {
    const revoked = { ...validToken, revokedAt: now };
    const result = AgentTokenSchema.safeParse(revoked);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.revokedAt).toBe(now);
    }
  });

  test("does not expose token hash", () => {
    const withHash = { ...validToken, token: "sha256hash" };
    const result = AgentTokenSchema.safeParse(withHash);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).token).toBeUndefined();
    }
  });

  test("rejects missing id", () => {
    const { id: _, ...noId } = validToken;
    const result = AgentTokenSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });
});

// ─── AgentPluginSchema ────────────────────────────────────────────────────────

describe("AgentPluginSchema", () => {
  test("parses valid plugin", () => {
    const result = AgentPluginSchema.safeParse(validPlugin);
    expect(result.success).toBe(true);
    if (result.success) {
      const plugin: AgentPlugin = result.data;
      expect(plugin.name).toBe("shipwright");
      expect(plugin.version).toBe("1.0.0");
    }
  });

  test("parses plugin without version", () => {
    const { version: _, ...noVersion } = validPlugin;
    const result = AgentPluginSchema.safeParse(noVersion);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBeUndefined();
    }
  });

  test("parses plugin with null version (latest)", () => {
    const result = AgentPluginSchema.safeParse({
      ...validPlugin,
      version: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing name", () => {
    const { name: _, ...noName } = validPlugin;
    const result = AgentPluginSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });

  test("rejects non-boolean enabled", () => {
    const result = AgentPluginSchema.safeParse({ ...validPlugin, enabled: 1 });
    expect(result.success).toBe(false);
  });
});

// ─── ErrorSchema ─────────────────────────────────────────────────────────────

describe("ErrorSchema", () => {
  test("parses valid error response", () => {
    const result = ErrorSchema.safeParse({ error: "Not found" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error).toBe("Not found");
    }
  });

  test("rejects missing error string", () => {
    const result = ErrorSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
