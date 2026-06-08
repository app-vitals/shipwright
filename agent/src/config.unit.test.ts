/**
 * Tests for agent/src/config.ts
 *
 * Strategy: call createConfig(agentHome) factory directly with a temp dir.
 * No mock.module() needed — the factory reads env vars at call time.
 * Uses SHIPWRIGHT_* env vars (not VITALS_OS_*).
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
process.env.SHIPWRIGHT_INTERNAL_API_KEY = "key-123";
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
});

// ─── config.shipwright ────────────────────────────────────────────────────────

describe("config.shipwright", () => {
  test("apiUrl from SHIPWRIGHT_API_URL", () => {
    expect(config.shipwright.apiUrl).toBe("https://api.shipwright.app");
  });

  test("apiKey from SHIPWRIGHT_INTERNAL_API_KEY", () => {
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
