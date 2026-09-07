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
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ANTHROPIC_FALLBACK_MODEL;
  });

  test("fallbackModel is undefined when ANTHROPIC_FALLBACK_MODEL not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ANTHROPIC_FALLBACK_MODEL;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.fallbackModel).toBeUndefined();
  });

  test("effortLevel from ANTHROPIC_EFFORT_LEVEL env var", () => {
    process.env.ANTHROPIC_EFFORT_LEVEL = "xhigh";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.effortLevel).toBe("xhigh");
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ANTHROPIC_EFFORT_LEVEL;
  });

  test("effortLevel is undefined when ANTHROPIC_EFFORT_LEVEL not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ANTHROPIC_EFFORT_LEVEL;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.effortLevel).toBeUndefined();
  });

  test("anthropicApiKey from ANTHROPIC_API_KEY env var", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.anthropicApiKey).toBe("sk-ant-test-key");
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ANTHROPIC_API_KEY;
  });

  test("anthropicApiKey is undefined when ANTHROPIC_API_KEY not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ANTHROPIC_API_KEY;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.anthropicApiKey).toBeUndefined();
  });

  test("model defaults to claude-sonnet-4-6 when ANTHROPIC_MODEL not set", () => {
    const saved = process.env.ANTHROPIC_MODEL;
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ANTHROPIC_MODEL;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.model).toBe("claude-sonnet-4-6");
    process.env.ANTHROPIC_MODEL = saved;
  });

  test("timeoutMs defaults to 1hr when SHIPWRIGHT_CLAUDE_TIMEOUT_MS not set", () => {
    expect(config.claude.timeoutMs).toBe(3_600_000);
  });

  test("timeoutMs from SHIPWRIGHT_CLAUDE_TIMEOUT_MS env var", () => {
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "5400000";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.timeoutMs).toBe(5_400_000);
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS;
  });

  test("timeoutMs falls back to default when non-numeric", () => {
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "not-a-number";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.timeoutMs).toBe(3_600_000);
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS;
  });

  test("timeoutMs falls back to default when zero or negative", () => {
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "0";
    expect(createConfig(AGENT_HOME).config.claude.timeoutMs).toBe(3_600_000);
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "-1000";
    expect(createConfig(AGENT_HOME).config.claude.timeoutMs).toBe(3_600_000);
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS;
  });

  test("timeoutMs falls back to default when non-integer", () => {
    process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS = "1500.5";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.timeoutMs).toBe(3_600_000);
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CLAUDE_TIMEOUT_MS;
  });

  test("idleTimeoutMs defaults to 25min when SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS not set", () => {
    expect(config.claude.idleTimeoutMs).toBe(1_500_000);
  });

  test("idleTimeoutMs from SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS env var", () => {
    process.env.SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS = "900000";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.idleTimeoutMs).toBe(900_000);
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS;
  });

  test("idleTimeoutMs falls back to default when non-numeric", () => {
    process.env.SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS = "not-a-number";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.idleTimeoutMs).toBe(1_500_000);
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS;
  });

  test("idleTimeoutMs falls back to default when zero or negative", () => {
    process.env.SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS = "0";
    expect(createConfig(AGENT_HOME).config.claude.idleTimeoutMs).toBe(
      1_500_000,
    );
    process.env.SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS = "-1000";
    expect(createConfig(AGENT_HOME).config.claude.idleTimeoutMs).toBe(
      1_500_000,
    );
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS;
  });

  test("idleTimeoutMs falls back to default when non-integer", () => {
    process.env.SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS = "1500.5";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.claude.idleTimeoutMs).toBe(1_500_000);
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS;
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
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SHIPWRIGHT_API_URL;
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
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_BOT_TOKEN;
  });

  test("botToken is undefined when SLACK_BOT_TOKEN not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_BOT_TOKEN;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.botToken).toBeUndefined();
  });

  test("appToken from SLACK_APP_TOKEN", () => {
    process.env.SLACK_APP_TOKEN = "xapp-test-token";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.appToken).toBe("xapp-test-token");
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_APP_TOKEN;
  });

  test("appToken is undefined when SLACK_APP_TOKEN not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_APP_TOKEN;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.appToken).toBeUndefined();
  });

  test("signingSecret from SLACK_SIGNING_SECRET", () => {
    process.env.SLACK_SIGNING_SECRET = "abc123secret";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.signingSecret).toBe("abc123secret");
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_SIGNING_SECRET;
  });

  test("signingSecret is undefined when SLACK_SIGNING_SECRET not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_SIGNING_SECRET;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.signingSecret).toBeUndefined();
  });

  test("adminToken from SLACK_ADMIN_TOKEN", () => {
    process.env.SLACK_ADMIN_TOKEN = "xoxp-admin-token";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.slack.adminToken).toBe("xoxp-admin-token");
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_ADMIN_TOKEN;
  });

  test("adminToken is undefined when SLACK_ADMIN_TOKEN not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_ADMIN_TOKEN;
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
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_ALERT_CHANNEL;
  });

  test("channel is undefined when SLACK_ALERT_CHANNEL not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_ALERT_CHANNEL;
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
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_OWNER_USER;
  });

  test("user is undefined when SLACK_OWNER_USER not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.SLACK_OWNER_USER;
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
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.GROQ_API_KEY;
  });

  test("groqApiKey is undefined when GROQ_API_KEY not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.GROQ_API_KEY;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.groqApiKey).toBeUndefined();
  });

  test("elevenLabsApiKey from ELEVENLABS_API_KEY", () => {
    process.env.ELEVENLABS_API_KEY = "eleven-test-key";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.elevenLabsApiKey).toBe("eleven-test-key");
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ELEVENLABS_API_KEY;
  });

  test("elevenLabsApiKey is undefined when ELEVENLABS_API_KEY not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ELEVENLABS_API_KEY;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.elevenLabsApiKey).toBeUndefined();
  });

  test("voiceId from ELEVENLABS_VOICE_ID", () => {
    process.env.ELEVENLABS_VOICE_ID = "voice-abc";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.voiceId).toBe("voice-abc");
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ELEVENLABS_VOICE_ID;
  });

  test("voiceId is undefined when ELEVENLABS_VOICE_ID not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.ELEVENLABS_VOICE_ID;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.voiceId).toBeUndefined();
  });

  test("piperVoice from PIPER_VOICE", () => {
    process.env.PIPER_VOICE = "en_GB-alan-medium";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.piperVoice).toBe("en_GB-alan-medium");
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.PIPER_VOICE;
  });

  test("piperVoice is undefined when PIPER_VOICE not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.PIPER_VOICE;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.piperVoice).toBeUndefined();
  });

  test("whisperServiceUrl from WHISPER_SERVICE_URL", () => {
    process.env.WHISPER_SERVICE_URL = "http://localhost:9000";
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.whisperServiceUrl).toBe("http://localhost:9000");
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.WHISPER_SERVICE_URL;
  });

  test("whisperServiceUrl is undefined when WHISPER_SERVICE_URL not set", () => {
    // biome-ignore lint/performance/noDelete: process.env deletion is intentional — assignment stringifies to "undefined"
    delete process.env.WHISPER_SERVICE_URL;
    const { config: cfg } = createConfig(AGENT_HOME);
    expect(cfg.voice.whisperServiceUrl).toBeUndefined();
  });
});
