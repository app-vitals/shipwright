/**
 * agent/src/entrypoint.integration.test.ts
 *
 * Integration tests for the agent startup sequence.
 * Uses RecordedShipwrightConfigClient (inline cassette) — no real network or fs mutations.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ShipwrightConfigClient } from "./shipwright-config-client.ts";
import type { AgentConfigResponse } from "./api.ts";
import { runStartup, type StartupDeps } from "./entrypoint-startup.ts";

// ─── Recorded config client ────────────────────────────────────────────────────

const CASSETTE: AgentConfigResponse = {
  env: {
    ANTHROPIC_API_KEY: "sk-ant-test-123",
    SLACK_BOT_TOKEN: "xoxb-test-token",
  },
  allowedTools: ["Read", "Write", "Bash"],
  plugins: [{ marketplace: "shipwright", plugin: "shipwright" }],
};

class RecordedShipwrightConfigClient implements ShipwrightConfigClient {
  readonly calls: string[] = [];

  async getAgentConfig(agentId: string): Promise<AgentConfigResponse> {
    this.calls.push(agentId);
    return {
      env: { ...CASSETTE.env },
      allowedTools: [...CASSETTE.allowedTools],
      plugins: CASSETTE.plugins.map((p) => ({ ...p })),
    };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

interface SpawnCall {
  cmd: string;
  args: string[];
}

function makeDeps(agentHome: string, homePath: string): {
  deps: StartupDeps;
  env: Record<string, string | undefined>;
  spawnCalls: SpawnCall[];
  writtenTokens: string[];
  configClient: RecordedShipwrightConfigClient;
} {
  const env: Record<string, string | undefined> = {};
  const spawnCalls: SpawnCall[] = [];
  const writtenTokens: string[] = [];
  const configClient = new RecordedShipwrightConfigClient();

  const deps: StartupDeps = {
    configClient,
    env,
    agentHome,
    homePath,
    spawnSync: (cmd, args, _opts) => {
      spawnCalls.push({ cmd, args });
      return { status: 0 };
    },
    writeToken: (token) => {
      writtenTokens.push(token);
    },
    tokenPath: path.join(homePath, "gh-token"),
    credentialHelperPath: "/usr/local/bin/git-credential-shipwright",
    createTokenManager: () => ({
      async getToken() { return "stub-token"; },
      startBackgroundRefresh() {},
    }),
    getBotIdentity: async () => ({
      slug: "stub-bot",
      name: "Stub Bot",
      userId: 0,
    }),
  };

  return { deps, env, spawnCalls, writtenTokens, configClient };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("runStartup (integration)", () => {
  let tmpDir: string;
  let agentHome: string;
  let homePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipwright-test-"));
    agentHome = path.join(tmpDir, "agent-home");
    homePath = path.join(tmpDir, "fake-home");
    fs.mkdirSync(agentHome, { recursive: true });
    fs.mkdirSync(homePath, { recursive: true });
  });

  it("fetches config for the given agentId", async () => {
    const { deps, configClient } = makeDeps(agentHome, homePath);
    await runStartup("agent-test-1", deps);
    expect(configClient.calls).toContain("agent-test-1");
  });

  it("applies env vars from the config bundle to the env object", async () => {
    const { deps, env } = makeDeps(agentHome, homePath);
    await runStartup("agent-test-1", deps);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test-123");
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-test-token");
  });

  it("sets AGENT_ALLOWED_TOOLS when allowedTools is non-empty", async () => {
    const { deps, env } = makeDeps(agentHome, homePath);
    await runStartup("agent-test-1", deps);
    expect(env.AGENT_ALLOWED_TOOLS).toBe("Read,Write,Bash");
  });

  it("does not set AGENT_ALLOWED_TOOLS when allowedTools is empty", async () => {
    const { deps, env, configClient } = makeDeps(agentHome, homePath);
    // Override client to return empty tools
    (configClient as unknown as { getAgentConfig: (id: string) => Promise<AgentConfigResponse> }).getAgentConfig = async () => ({
      env: {},
      allowedTools: [],
      plugins: [],
    });
    await runStartup("agent-test-1", deps);
    expect(env.AGENT_ALLOWED_TOOLS).toBeUndefined();
  });

  it("creates AGENT_HOME/dot-claude directory", async () => {
    const { deps } = makeDeps(agentHome, homePath);
    await runStartup("agent-test-1", deps);
    const dotClaudeDir = path.join(agentHome, "dot-claude");
    expect(fs.existsSync(dotClaudeDir)).toBe(true);
    expect(fs.statSync(dotClaudeDir).isDirectory()).toBe(true);
  });

  it("symlinks homePath/.claude to AGENT_HOME/dot-claude", async () => {
    const { deps } = makeDeps(agentHome, homePath);
    await runStartup("agent-test-1", deps);
    const symlinkPath = path.join(homePath, ".claude");
    expect(fs.existsSync(symlinkPath)).toBe(true);
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(symlinkPath)).toBe(path.join(agentHome, "dot-claude"));
  });

  it("symlinks homePath/.claude.json to AGENT_HOME/claude.json", async () => {
    const { deps } = makeDeps(agentHome, homePath);
    await runStartup("agent-test-1", deps);
    const symlinkPath = path.join(homePath, ".claude.json");
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(symlinkPath)).toBe(path.join(agentHome, "claude.json"));
  });

  it("re-runs without error when symlinks already exist (idempotent)", async () => {
    const { deps } = makeDeps(agentHome, homePath);
    await runStartup("agent-test-1", deps);
    // Second run should not throw
    await expect(runStartup("agent-test-1", deps)).resolves.toBeUndefined();
  });

  it("prepends agent scripts/bin to PATH", async () => {
    const { deps, env } = makeDeps(agentHome, homePath);
    env.PATH = "/usr/bin:/bin";
    await runStartup("agent-test-1", deps);
    expect(env.PATH?.startsWith("/")).toBe(true);
    expect(env.PATH).toContain("/bin");
  });
});
