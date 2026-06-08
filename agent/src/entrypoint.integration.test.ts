/**
 * agent/src/entrypoint.integration.test.ts
 *
 * Integration tests for the startup sequence in entrypoint.ts.
 * Uses RecordedShipwrightConfigClient (cassette-backed) — no real HTTP.
 * Isolation contract: no mock.module(), no global overrides.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfigResponse } from "./api.ts";
import { runEntrypoint } from "./entrypoint.ts";
import type { EntrypointDeps } from "./entrypoint.ts";
import type { ShipwrightConfigClient } from "./shipwright-config-client.ts";
import { RecordedShipwrightConfigClient } from "./shipwright-config-client.ts";

// ─── Test fixtures ─────────────────────────────────────────────────────────────

const SAMPLE_CONFIG: AgentConfigResponse = {
  env: {
    ANTHROPIC_MODEL: "claude-sonnet-4-6",
    CUSTOM_VAR: "custom-value",
  },
  allowedTools: ["Read", "Write", "Bash"],
  plugins: [{ marketplace: "my-market", plugin: "my-plugin" }],
};

// ─── Temp dir helpers ──────────────────────────────────────────────────────────

const TMP_BASE = "/tmp/test-entrypoint-home";
let testHome: string;
let testClaudeTarget: string;

beforeEach(() => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  testHome = `${TMP_BASE}-${id}`;
  testClaudeTarget = `${testHome}/dot-claude`;
  mkdirSync(testHome, { recursive: true });
  mkdirSync(testClaudeTarget, { recursive: true });
});

afterEach(() => {
  if (existsSync(testHome)) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

interface SpawnCall {
  cmd: string;
  args: string[];
}

interface SetupGitHubAuthCall {
  called: boolean;
}

function makeDeps(
  configClient: ShipwrightConfigClient,
  overrides: Partial<EntrypointDeps> = {},
): {
  deps: EntrypointDeps;
  spawnCalls: SpawnCall[];
  appliedEnv: Record<string, string>;
  symlinkCalls: Array<{ target: string; linkPath: string }>;
  githubAuthCalled: SetupGitHubAuthCall;
  miseCalls: string[][];
  pluginCalls: string[];
  exitCodes: number[];
} {
  const spawnCalls: SpawnCall[] = [];
  const appliedEnv: Record<string, string> = {};
  const symlinkCalls: Array<{ target: string; linkPath: string }> = [];
  const githubAuthCalled: SetupGitHubAuthCall = { called: false };
  const miseCalls: string[][] = [];
  const pluginCalls: string[] = [];
  const exitCodes: number[] = [];

  const deps: EntrypointDeps = {
    agentId: "test-agent-id",
    apiUrl: "https://api.test.com",
    apiKey: "test-key",
    agentHome: testHome,
    configClient,
    applyEnv: (env: Record<string, string>) => {
      Object.assign(appliedEnv, env);
    },
    symlinkDotClaude: (target: string, linkPath: string) => {
      symlinkCalls.push({ target, linkPath });
    },
    setupGitHubAuth: async () => {
      githubAuthCalled.called = true;
    },
    runMiseStartup: async (_home: string, execFn) => {
      miseCalls.push(["runMiseStartup", _home]);
      return Promise.resolve();
    },
    installPlugins: async (_execFn, _cwd, plugins) => {
      pluginCalls.push(...(plugins ?? []).map((p) => p.plugin));
      return Promise.resolve();
    },
    spawnAgentServer: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
    },
    exit: (code: number) => {
      exitCodes.push(code);
    },
    ...overrides,
  };

  return {
    deps,
    spawnCalls,
    appliedEnv,
    symlinkCalls,
    githubAuthCalled,
    miseCalls,
    pluginCalls,
    exitCodes,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runEntrypoint — happy path", () => {
  it("fetches config and applies env vars from the bundle", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, appliedEnv } = makeDeps(configClient);

    await runEntrypoint(deps);

    expect(appliedEnv.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(appliedEnv.CUSTOM_VAR).toBe("custom-value");
  });

  it("symlinks ~/.claude to $AGENT_HOME/dot-claude", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, symlinkCalls } = makeDeps(configClient);

    await runEntrypoint(deps);

    expect(symlinkCalls.length).toBe(1);
    expect(symlinkCalls[0].target).toBe(join(testHome, "dot-claude"));
  });

  it("calls setupGitHubAuth", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, githubAuthCalled } = makeDeps(configClient);

    await runEntrypoint(deps);

    expect(githubAuthCalled.called).toBe(true);
  });

  it("calls runMiseStartup with agentHome", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, miseCalls } = makeDeps(configClient);

    await runEntrypoint(deps);

    expect(miseCalls.length).toBe(1);
    expect(miseCalls[0][1]).toBe(testHome);
  });

  it("calls installPlugins with plugins from config", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, pluginCalls } = makeDeps(configClient);

    await runEntrypoint(deps);

    expect(pluginCalls).toContain("my-plugin");
  });

  it("spawns the agent server after setup completes", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, spawnCalls } = makeDeps(configClient);

    await runEntrypoint(deps);

    expect(spawnCalls.length).toBe(1);
  });

  it("does not call exit on success", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, exitCodes } = makeDeps(configClient);

    await runEntrypoint(deps);

    expect(exitCodes.length).toBe(0);
  });
});

describe("runEntrypoint — missing required vars", () => {
  it("exits non-zero when agentId is missing", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, exitCodes } = makeDeps(configClient, { agentId: undefined });

    await runEntrypoint(deps);

    expect(exitCodes.length).toBe(1);
    expect(exitCodes[0]).not.toBe(0);
  });

  it("exits non-zero when apiUrl is missing", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, exitCodes } = makeDeps(configClient, { apiUrl: undefined });

    await runEntrypoint(deps);

    expect(exitCodes.length).toBe(1);
    expect(exitCodes[0]).not.toBe(0);
  });

  it("exits non-zero when apiKey is missing", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    const { deps, exitCodes } = makeDeps(configClient, { apiKey: undefined });

    await runEntrypoint(deps);

    expect(exitCodes.length).toBe(1);
    expect(exitCodes[0]).not.toBe(0);
  });

  it("does not fetch config when required vars are missing", async () => {
    const configClient = new RecordedShipwrightConfigClient(SAMPLE_CONFIG);
    let fetchCalled = false;
    const trackingClient: ShipwrightConfigClient = {
      getConfig: async (agentId: string) => {
        fetchCalled = true;
        return configClient.getConfig(agentId);
      },
    };
    const { deps } = makeDeps(trackingClient, { agentId: undefined });

    await runEntrypoint(deps);

    expect(fetchCalled).toBe(false);
  });
});

describe("runEntrypoint — config with empty env", () => {
  it("handles config with no env vars gracefully", async () => {
    const emptyConfig: AgentConfigResponse = {
      env: {},
      allowedTools: [],
      plugins: [],
    };
    const configClient = new RecordedShipwrightConfigClient(emptyConfig);
    const { deps, exitCodes, spawnCalls } = makeDeps(configClient);

    await runEntrypoint(deps);

    expect(exitCodes.length).toBe(0);
    expect(spawnCalls.length).toBe(1);
  });
});
