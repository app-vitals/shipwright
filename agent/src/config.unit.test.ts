/**
 * Tests for agent/src/config.ts
 *
 * Strategy: call createConfig(agentHome) factory directly with a temp dir.
 * No mock.module() needed — the factory reads env vars at call time.
 * Uses SHIPWRIGHT_* env vars only.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "./config.ts";

const AGENT_HOME = join(
  tmpdir(),
  `shipwright-agent-config-test-${process.pid}`,
);
mkdirSync(AGENT_HOME, { recursive: true });

// Set env vars before calling createConfig
process.env.ANTHROPIC_MODEL = "claude-opus-4-6";
process.env.SHIPWRIGHT_API_URL = "https://api.shipwright.app";
process.env.SHIPWRIGHT_AGENT_API_KEY = "key-123";
process.env.SHIPWRIGHT_AGENT_ID = "agent-xyz";

const { config } = createConfig(AGENT_HOME);

afterAll(() => {
  rmSync(AGENT_HOME, { recursive: true, force: true });
});

// ─── config.claude ────────────────────────────────────────────────────────────

describe("config.claude", () => {
  test("model from ANTHROPIC_MODEL env var", () => {
    expect(config.claude.model).toBe("claude-opus-4-6");
  });

  test("fallbackModel from ANTHROPIC_FALLBACK_MODEL env var", () => {
    process.env.ANTHROPIC_FALLBACK_MODEL = "claude-sonnet-4-6";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.fallbackModel).toBe("claude-sonnet-4-6");
    process.env.ANTHROPIC_FALLBACK_MODEL = undefined;
  });

  test("fallbackModel is undefined when ANTHROPIC_FALLBACK_MODEL not set", () => {
    process.env.ANTHROPIC_FALLBACK_MODEL = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.fallbackModel).toBeUndefined();
  });

  test("effortLevel from ANTHROPIC_EFFORT_LEVEL env var", () => {
    process.env.ANTHROPIC_EFFORT_LEVEL = "xhigh";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.effortLevel).toBe("xhigh");
    process.env.ANTHROPIC_EFFORT_LEVEL = undefined;
  });

  test("effortLevel is undefined when ANTHROPIC_EFFORT_LEVEL not set", () => {
    process.env.ANTHROPIC_EFFORT_LEVEL = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.effortLevel).toBeUndefined();
  });

  test("anthropicApiKey from ANTHROPIC_API_KEY env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.anthropicApiKey).toBe("sk-ant-test-key");
    process.env.ANTHROPIC_API_KEY = undefined;
  });

  test("anthropicApiKey is undefined when ANTHROPIC_API_KEY not set", () => {
    process.env.ANTHROPIC_API_KEY = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.anthropicApiKey).toBeUndefined();
  });

  test("model defaults to claude-sonnet-4-6 when ANTHROPIC_MODEL not set", () => {
    const saved = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.model).toBe("claude-sonnet-4-6");
    process.env.ANTHROPIC_MODEL = saved;
  });

  test("timeoutMs defaults to 30m when SHIPWRIGHT_CLAUDE_TIMEOUT_MS not set", () => {
    expect(config.claude.timeoutMs).toBe(30 * 60 * 1000);
  });

  test("timeoutMs from SHIPWRIGHT_CLAUDE_TIMEOUT_MS env var", () => {
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "5400000";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.timeoutMs).toBe(5_400_000);
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = undefined;
  });

  test("timeoutMs falls back to default when non-numeric", () => {
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "not-a-number";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.timeoutMs).toBe(30 * 60 * 1000);
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = undefined;
  });

  test("timeoutMs falls back to default when zero or negative", () => {
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "0";
    expect(createConfig(AGENT_HOME).config.claude.timeoutMs).toBe(
      30 * 60 * 1000,
    );
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "-1000";
    expect(createConfig(AGENT_HOME).config.claude.timeoutMs).toBe(
      30 * 60 * 1000,
    );
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = undefined;
  });

  test("timeoutMs falls back to default when non-integer", () => {
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "1500.5";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.timeoutMs).toBe(30 * 60 * 1000);
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = undefined;
  });
});

// ─── config.shipwright ────────────────────────────────────────────────────────

describe("config.shipwright", () => {
  test("apiUrl from SHIPWRIGHT_API_URL", () => {
    expect(config.shipwright.apiUrl).toBe("https://api.shipwright.app");
  });

  test("apiKey from SHIPWRIGHT_AGENT_API_KEY", () => {
    expect(config.shipwright.apiKey).toBe("key-123");
  });

  test("agentId from SHIPWRIGHT_AGENT_ID", () => {
    expect(config.shipwright.agentId).toBe("agent-xyz");
  });

  test("apiUrl is undefined when SHIPWRIGHT_API_URL not set", () => {
    const saved = process.env.SHIPWRIGHT_API_URL;
    process.env.SHIPWRIGHT_API_URL = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.shipwright.apiUrl).toBeUndefined();
    process.env.SHIPWRIGHT_API_URL = saved;
  });
});

// ─── config.paths ─────────────────────────────────────────────────────────────

describe("config.paths", () => {
  test("home is agentHome", () => {
    expect(config.paths.home).toBe(AGENT_HOME);
  });

  test("workspace is inside agentHome", () => {
    expect(config.paths.workspace).toContain(AGENT_HOME);
    expect(config.paths.workspace).toContain("workspace");
  });

  test("sessions is agentHome/sessions.json", () => {
    expect(config.paths.sessions).toBe(join(AGENT_HOME, "sessions.json"));
  });
});

// ─── config.slack ─────────────────────────────────────────────────────────────

describe("config.slack", () => {
  test("botToken from SLACK_BOT_TOKEN", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-bot";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.botToken).toBe("xoxb-test-bot");
    process.env.SLACK_BOT_TOKEN = undefined;
  });

  test("botToken is undefined when SLACK_BOT_TOKEN not set", () => {
    process.env.SLACK_BOT_TOKEN = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.botToken).toBeUndefined();
  });

  test("appToken from SLACK_APP_TOKEN", () => {
    process.env.SLACK_APP_TOKEN = "xapp-test-token";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.appToken).toBe("xapp-test-token");
    process.env.SLACK_APP_TOKEN = undefined;
  });

  test("appToken is undefined when SLACK_APP_TOKEN not set", () => {
    process.env.SLACK_APP_TOKEN = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.appToken).toBeUndefined();
  });

  test("signingSecret from SLACK_SIGNING_SECRET", () => {
    process.env.SLACK_SIGNING_SECRET = "abc123secret";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.signingSecret).toBe("abc123secret");
    process.env.SLACK_SIGNING_SECRET = undefined;
  });

  test("signingSecret is undefined when SLACK_SIGNING_SECRET not set", () => {
    process.env.SLACK_SIGNING_SECRET = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.signingSecret).toBeUndefined();
  });

  test("adminToken from SLACK_ADMIN_TOKEN", () => {
    process.env.SLACK_ADMIN_TOKEN = "xoxp-admin-token";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.adminToken).toBe("xoxp-admin-token");
    process.env.SLACK_ADMIN_TOKEN = undefined;
  });

  test("adminToken is undefined when SLACK_ADMIN_TOKEN not set", () => {
    process.env.SLACK_ADMIN_TOKEN = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.adminToken).toBeUndefined();
  });
});

// ─── config.alerts ────────────────────────────────────────────────────────────

describe("config.alerts", () => {
  test("channel from SLACK_ALERT_CHANNEL", () => {
    process.env.SLACK_ALERT_CHANNEL = "#alerts";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.alerts.channel).toBe("#alerts");
    process.env.SLACK_ALERT_CHANNEL = undefined;
  });

  test("channel is undefined when SLACK_ALERT_CHANNEL not set", () => {
    process.env.SLACK_ALERT_CHANNEL = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.alerts.channel).toBeUndefined();
  });
});

// ─── config.owner ─────────────────────────────────────────────────────────────

describe("config.owner", () => {
  test("user from SLACK_OWNER_USER", () => {
    process.env.SLACK_OWNER_USER = "U012AB3CD";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.owner.user).toBe("U012AB3CD");
    process.env.SLACK_OWNER_USER = undefined;
  });

  test("user is undefined when SLACK_OWNER_USER not set", () => {
    process.env.SLACK_OWNER_USER = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.owner.user).toBeUndefined();
  });
});

// ─── config.voice ─────────────────────────────────────────────────────────────

describe("config.voice", () => {
  test("groqApiKey from GROQ_API_KEY", () => {
    process.env.GROQ_API_KEY = "gsk-test-key";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.groqApiKey).toBe("gsk-test-key");
    process.env.GROQ_API_KEY = undefined;
  });

  test("groqApiKey is undefined when GROQ_API_KEY not set", () => {
    process.env.GROQ_API_KEY = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.groqApiKey).toBeUndefined();
  });

  test("elevenLabsApiKey from ELEVENLABS_API_KEY", () => {
    process.env.ELEVENLABS_API_KEY = "eleven-test-key";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.elevenLabsApiKey).toBe("eleven-test-key");
    process.env.ELEVENLABS_API_KEY = undefined;
  });

  test("elevenLabsApiKey is undefined when ELEVENLABS_API_KEY not set", () => {
    process.env.ELEVENLABS_API_KEY = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.elevenLabsApiKey).toBeUndefined();
  });

  test("voiceId from ELEVENLABS_VOICE_ID", () => {
    process.env.ELEVENLABS_VOICE_ID = "voice-abc";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.voiceId).toBe("voice-abc");
    process.env.ELEVENLABS_VOICE_ID = undefined;
  });

  test("voiceId is undefined when ELEVENLABS_VOICE_ID not set", () => {
    process.env.ELEVENLABS_VOICE_ID = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.voiceId).toBeUndefined();
  });

  test("whisperServiceUrl from WHISPER_SERVICE_URL", () => {
    process.env.WHISPER_SERVICE_URL = "http://localhost:9000";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.whisperServiceUrl).toBe("http://localhost:9000");
    process.env.WHISPER_SERVICE_URL = undefined;
  });

  test("whisperServiceUrl is undefined when WHISPER_SERVICE_URL not set", () => {
    process.env.WHISPER_SERVICE_URL = undefined;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.whisperServiceUrl).toBeUndefined();
  });
});
