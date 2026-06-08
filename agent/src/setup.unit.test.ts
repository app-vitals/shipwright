/**
 * Unit tests for agent/src/setup.ts
 *
 * Tests use injected execFn — no real claude/mise binaries needed.
 * All file I/O runs against a real temp dir (no mocks needed for fs).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentPlugin } from "./api.ts";
import {
  ensureAgentHome,
  installPlugins,
  isNewWorkspace,
  loadState,
  runMiseStartup,
  saveState,
  seedFile,
} from "./setup.ts";

const TMP_BASE = "/tmp/test-shipwright-agent-home";

let testHome: string;

beforeEach(() => {
  testHome = `${TMP_BASE}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  if (existsSync(testHome)) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// seedFile
// ---------------------------------------------------------------------------

describe("seedFile", () => {
  it("creates file on first call", () => {
    mkdirSync(testHome, { recursive: true });
    const filePath = join(testHome, "test.txt");
    seedFile(filePath, "hello");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("hello");
  });

  it("silently skips on second call (wx semantics)", () => {
    mkdirSync(testHome, { recursive: true });
    const filePath = join(testHome, "test.txt");
    seedFile(filePath, "first");
    expect(() => seedFile(filePath, "second")).not.toThrow();
    // Original content preserved
    expect(readFileSync(filePath, "utf8")).toBe("first");
  });

  it("rethrows errors that are not EEXIST", () => {
    // Attempt to write to a path whose parent does not exist
    const filePath = join(testHome, "nonexistent-dir", "test.txt");
    expect(() => seedFile(filePath, "content")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadState / saveState
// ---------------------------------------------------------------------------

describe("loadState", () => {
  it("returns { version: 1 } when file absent", () => {
    mkdirSync(testHome, { recursive: true });
    const state = loadState(testHome);
    expect(state).toEqual({ version: 1 });
  });

  it("returns parsed state when file present", () => {
    mkdirSync(testHome, { recursive: true });
    const data = {
      version: 1 as const,
      bootstrapSeededAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(
      join(testHome, "workspace-state.json"),
      JSON.stringify(data),
      "utf8",
    );
    const state = loadState(testHome);
    expect(state.bootstrapSeededAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("saveState", () => {
  it("writes valid JSON", () => {
    mkdirSync(testHome, { recursive: true });
    const state = {
      version: 1 as const,
      bootstrapSeededAt: "2026-04-14T00:00:00.000Z",
    };
    saveState(testHome, state);
    const raw = readFileSync(join(testHome, "workspace-state.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.bootstrapSeededAt).toBe("2026-04-14T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// isNewWorkspace
// ---------------------------------------------------------------------------

describe("isNewWorkspace", () => {
  it("returns true when all markers absent", () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    expect(isNewWorkspace(testHome)).toBe(true);
  });

  it("returns false when workspace/IDENTITY.md present", () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    writeFileSync(
      join(testHome, "workspace", "IDENTITY.md"),
      "# Identity",
      "utf8",
    );
    expect(isNewWorkspace(testHome)).toBe(false);
  });

  it("returns false when workspace/SOUL.md present", () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    writeFileSync(join(testHome, "workspace", "SOUL.md"), "# Soul", "utf8");
    expect(isNewWorkspace(testHome)).toBe(false);
  });

  it("returns false when workspace/memory/ directory present", () => {
    mkdirSync(join(testHome, "workspace", "memory"), { recursive: true });
    expect(isNewWorkspace(testHome)).toBe(false);
  });

  it("returns false when workspace/.git directory present", () => {
    mkdirSync(join(testHome, "workspace", ".git"), { recursive: true });
    expect(isNewWorkspace(testHome)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureAgentHome
// ---------------------------------------------------------------------------

describe("ensureAgentHome", () => {
  it("creates expected directory tree", () => {
    ensureAgentHome(testHome);

    // Workspace and subdirs
    expect(existsSync(join(testHome, "workspace"))).toBe(true);
    expect(existsSync(join(testHome, "workspace", "repos"))).toBe(true);
    expect(existsSync(join(testHome, "workspace", "worktrees"))).toBe(true);
    expect(existsSync(join(testHome, "workspace", "state"))).toBe(true);
  });

  it("is idempotent — calling twice does not throw", () => {
    ensureAgentHome(testHome);
    expect(() => ensureAgentHome(testHome)).not.toThrow();
  });

  it("works when $home does not exist yet (first deploy)", () => {
    const deepHome = join(testHome, "nested", "deep");
    try {
      ensureAgentHome(deepHome);
      expect(existsSync(join(deepHome, "workspace"))).toBe(true);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("seeds CLAUDE.md, SOUL.md, IDENTITY.md into workspace/ on fresh home", () => {
    ensureAgentHome(testHome);
    expect(existsSync(join(testHome, "workspace", "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(testHome, "workspace", "SOUL.md"))).toBe(true);
    expect(existsSync(join(testHome, "workspace", "IDENTITY.md"))).toBe(true);
  });

  it("CLAUDE.md loads @SOUL.md and @IDENTITY.md", () => {
    ensureAgentHome(testHome);
    const content = readFileSync(
      join(testHome, "workspace", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("@SOUL.md");
    expect(content).toContain("@IDENTITY.md");
  });

  it("seeds state/todos.json as empty array", () => {
    ensureAgentHome(testHome);
    const todosPath = join(testHome, "workspace", "state", "todos.json");
    expect(existsSync(todosPath)).toBe(true);
    const todos = JSON.parse(readFileSync(todosPath, "utf8"));
    expect(Array.isArray(todos)).toBe(true);
    expect(todos).toHaveLength(0);
  });

  it("seeds state/reviews.json as empty array", () => {
    ensureAgentHome(testHome);
    const reviewsPath = join(testHome, "workspace", "state", "reviews.json");
    expect(existsSync(reviewsPath)).toBe(true);
    const reviews = JSON.parse(readFileSync(reviewsPath, "utf8"));
    expect(Array.isArray(reviews)).toBe(true);
    expect(reviews).toHaveLength(0);
  });

  it("creates state/reviews/ directory", () => {
    ensureAgentHome(testHome);
    const reviewsDir = join(testHome, "workspace", "state", "reviews");
    expect(existsSync(reviewsDir)).toBe(true);
    expect(statSync(reviewsDir).isDirectory()).toBe(true);
  });

  it("seeds state/agent-policy.md with conservative defaults", () => {
    ensureAgentHome(testHome);
    const policyPath = join(testHome, "workspace", "state", "agent-policy.md");
    expect(existsSync(policyPath)).toBe(true);
    const content = readFileSync(policyPath, "utf8");
    expect(content).toContain("auto_post_reviews");
    expect(content).toContain("allow_self_review");
    expect(content).toContain("false");
  });

  it("seeds BOOTSTRAP.md into workspace/ and sets bootstrapSeededAt for new workspaces", () => {
    ensureAgentHome(testHome);
    expect(existsSync(join(testHome, "workspace", "BOOTSTRAP.md"))).toBe(true);
    const state = loadState(testHome);
    expect(state.bootstrapSeededAt).toBeDefined();
    expect(typeof state.bootstrapSeededAt).toBe("string");
  });

  it("called twice does not overwrite existing workspace/SOUL.md", () => {
    ensureAgentHome(testHome);
    // Overwrite SOUL.md with custom content
    writeFileSync(
      join(testHome, "workspace", "SOUL.md"),
      "custom soul content",
      "utf8",
    );
    ensureAgentHome(testHome);
    const content = readFileSync(
      join(testHome, "workspace", "SOUL.md"),
      "utf8",
    );
    expect(content).toBe("custom soul content");
  });

  it("does not create workspace/hooks/ (not used)", () => {
    ensureAgentHome(testHome);
    expect(existsSync(join(testHome, "workspace", "hooks"))).toBe(false);
  });

  it("seeds VOICE.md into workspace/", () => {
    ensureAgentHome(testHome);
    const voicePath = join(testHome, "workspace", "VOICE.md");
    expect(existsSync(voicePath)).toBe(true);
    const content = readFileSync(voicePath, "utf8");
    expect(content).toContain("Voice Notes");
    expect(content).toContain("[speak:");
  });

  it("sets setupCompletedAt when bootstrapSeededAt set but workspace/BOOTSTRAP.md is gone", () => {
    ensureAgentHome(testHome);
    // Simulate user completing bootstrap by deleting BOOTSTRAP.md
    rmSync(join(testHome, "workspace", "BOOTSTRAP.md"));
    // Also mark workspace as non-new so bootstrap branch doesn't re-seed
    writeFileSync(
      join(testHome, "workspace", "IDENTITY.md"),
      "# Identity (filled)",
      "utf8",
    );

    ensureAgentHome(testHome);
    const state = loadState(testHome);
    expect(state.setupCompletedAt).toBeDefined();
    expect(typeof state.setupCompletedAt).toBe("string");
  });

  it("does not re-seed BOOTSTRAP.md when bootstrapSeededAt already set", () => {
    ensureAgentHome(testHome);
    // Remove BOOTSTRAP.md and mark as completed via state
    rmSync(join(testHome, "workspace", "BOOTSTRAP.md"));
    const state = loadState(testHome);
    state.bootstrapSeededAt = "2026-01-01T00:00:00.000Z";
    saveState(testHome, state);

    ensureAgentHome(testHome);
    const newState = loadState(testHome);
    expect(newState.setupCompletedAt).toBeDefined();
    // BOOTSTRAP.md stays absent
    expect(existsSync(join(testHome, "workspace", "BOOTSTRAP.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureAgentHome — mise
// ---------------------------------------------------------------------------

describe("ensureAgentHome — mise", () => {
  it("creates $AGENT_HOME/mise/ directory", () => {
    ensureAgentHome(testHome);
    const miseDir = join(testHome, "mise");
    expect(existsSync(miseDir)).toBe(true);
    expect(statSync(miseDir).isDirectory()).toBe(true);
  });

  it("seeds workspace/mise.toml on first boot", () => {
    ensureAgentHome(testHome);
    const miseTomPath = join(testHome, "workspace", "mise.toml");
    expect(existsSync(miseTomPath)).toBe(true);
    const content = readFileSync(miseTomPath, "utf8");
    expect(content).toContain("[tools]");
  });

  it("does not overwrite existing workspace/mise.toml (user edits survive)", () => {
    ensureAgentHome(testHome);
    const miseTomPath = join(testHome, "workspace", "mise.toml");
    writeFileSync(
      miseTomPath,
      "# custom user content\n[tools]\npython = '3.12'\n",
      "utf8",
    );
    ensureAgentHome(testHome);
    const content = readFileSync(miseTomPath, "utf8");
    expect(content).toContain("python = '3.12'");
    expect(content).toContain("custom user content");
  });

  it("seeds workspace/requirements.txt from template on first boot", () => {
    ensureAgentHome(testHome);
    const requirementsPath = join(testHome, "workspace", "requirements.txt");
    expect(existsSync(requirementsPath)).toBe(true);
    const content = readFileSync(requirementsPath, "utf8");
    expect(content).toContain("# Add pip packages here");
  });

  it("does not overwrite existing workspace/requirements.txt (user edits survive)", () => {
    ensureAgentHome(testHome);
    const requirementsPath = join(testHome, "workspace", "requirements.txt");
    writeFileSync(requirementsPath, "faster-whisper\ntorch\n", "utf8");
    ensureAgentHome(testHome);
    const content = readFileSync(requirementsPath, "utf8");
    expect(content).toContain("torch");
  });
});

// ---------------------------------------------------------------------------
// runMiseStartup
// ---------------------------------------------------------------------------

describe("runMiseStartup", () => {
  const originalMiseDataDir = process.env.MISE_DATA_DIR;
  const originalMiseCacheDir = process.env.MISE_CACHE_DIR;
  const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  const originalPath = process.env.PATH;

  afterEach(() => {
    // Restore env vars modified by runMiseStartup
    process.env.MISE_DATA_DIR = originalMiseDataDir;
    process.env.MISE_CACHE_DIR = originalMiseCacheDir;
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    process.env.PATH = originalPath;
  });

  it("sets MISE_DATA_DIR to $AGENT_HOME/mise", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    const mockExec = async (
      _cmd: string,
      _args: string[],
      _opts: { cwd: string },
    ) => ({ stdout: "", exitCode: 0 });
    await runMiseStartup(testHome, mockExec);
    expect(process.env.MISE_DATA_DIR).toBe(join(testHome, "mise"));
  });

  it("pins MISE_CACHE_DIR and XDG_CACHE_HOME to the PVC", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    const mockExec = async () => ({ stdout: "", exitCode: 0 });
    await runMiseStartup(testHome, mockExec);
    expect(process.env.MISE_CACHE_DIR).toBe(join(testHome, "mise", "cache"));
    expect(process.env.XDG_CACHE_HOME).toBe(join(testHome, "cache"));
    expect(existsSync(process.env.MISE_CACHE_DIR ?? "")).toBe(true);
    expect(existsSync(process.env.XDG_CACHE_HOME ?? "")).toBe(true);
  });

  it("skips mise install when mise.toml absent", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };
    await runMiseStartup(testHome, mockExec);
    const installCalls = calls.filter((c) => c.args.includes("install"));
    expect(installCalls).toHaveLength(0);
  });

  it("skips mise install when mise.toml absent (idempotent — execFn called 0 times)", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    let callCount = 0;
    const mockExec = async (
      _cmd: string,
      _args: string[],
      _opts: { cwd: string },
    ) => {
      callCount++;
      return { stdout: "", exitCode: 0 };
    };
    await runMiseStartup(testHome, mockExec);
    expect(callCount).toBe(0);
  });

  it("runs mise trust then mise install when mise.toml present", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    const miseTomlPath = join(testHome, "workspace", "mise.toml");
    writeFileSync(miseTomlPath, "[tools]\n", "utf8");
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };
    await runMiseStartup(testHome, mockExec);
    const trustIdx = calls.findIndex(
      (c) => c.cmd === "mise" && c.args.includes("trust"),
    );
    const installIdx = calls.findIndex(
      (c) => c.cmd === "mise" && c.args.includes("install"),
    );
    expect(trustIdx).toBeGreaterThanOrEqual(0);
    expect(calls[trustIdx].args).toContain(miseTomlPath);
    expect(installIdx).toBeGreaterThan(trustIdx);
  });

  it("prepends MISE_DATA_DIR/shims to process.env.PATH", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    writeFileSync(
      join(testHome, "workspace", "mise.toml"),
      "[tools]\n",
      "utf8",
    );
    const mockExec = async () => ({ stdout: "", exitCode: 0 });
    await runMiseStartup(testHome, mockExec);
    const expectedShims = join(testHome, "mise", "shims");
    expect(process.env.PATH?.startsWith(`${expectedShims}:`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// installPlugins
// ---------------------------------------------------------------------------

describe("installPlugins", () => {
  it("installs shipwright default plugin first (shipwright@shipwright)", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(mockExec, testHome, []);

    // Should have: 1 install + 1 update for the default plugin
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(["plugin", "install", "shipwright@shipwright"]);
    expect(calls[1].args).toEqual(["plugin", "update", "shipwright@shipwright"]);
  });

  it("installs agent-specific plugins after default plugins", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    const agentPlugins: AgentPlugin[] = [
      { marketplace: "my-marketplace", plugin: "custom-plugin" },
      { marketplace: "other-market", plugin: "another-plugin" },
    ];

    await installPlugins(mockExec, testHome, agentPlugins);

    // default install + 2 agent installs + default update + 2 agent updates = 6 calls
    expect(calls).toHaveLength(6);

    // installs: default first, then agent-specific
    expect(calls[0].args).toEqual(["plugin", "install", "shipwright@shipwright"]);
    expect(calls[1].args).toEqual(["plugin", "install", "custom-plugin@my-marketplace"]);
    expect(calls[2].args).toEqual(["plugin", "install", "another-plugin@other-market"]);

    // updates: default first, then agent-specific
    expect(calls[3].args).toEqual(["plugin", "update", "shipwright@shipwright"]);
    expect(calls[4].args).toEqual(["plugin", "update", "custom-plugin@my-marketplace"]);
    expect(calls[5].args).toEqual(["plugin", "update", "another-plugin@other-market"]);
  });

  it("empty agentPlugins installs only default plugins", async () => {
    const calls: Array<{ args: string[] }> = [];
    const mockExec = async (
      _cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(mockExec, testHome, []);

    // 1 install + 1 update for just the default plugin
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain("shipwright@shipwright");
    expect(calls[1].args).toContain("shipwright@shipwright");
  });

  it("is non-fatal when the claude binary isn't available", async () => {
    const throwingExec = async () => {
      throw new Error("spawn claude ENOENT");
    };

    await expect(
      installPlugins(throwingExec, testHome, []),
    ).resolves.toBeUndefined();
  });

  it("continues when a plugin install exits non-zero", async () => {
    const calls: Array<{ args: string[] }> = [];
    const mockExec = async (
      _cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ args });
      const isInstall = args[1] === "install";
      return {
        stdout: isInstall ? "auth required" : "",
        exitCode: isInstall ? 1 : 0,
      };
    };

    await expect(
      installPlugins(mockExec, testHome, []),
    ).resolves.toBeUndefined();

    // All calls still happened despite install failures
    expect(calls).toHaveLength(2);
  });

  it("is a silent no-op when plugins are already installed and up-to-date", async () => {
    const calls: Array<{ args: string[] }> = [];
    const mockExec = async (
      _cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ args });
      return { stdout: "already present", exitCode: 0 };
    };

    await expect(
      installPlugins(mockExec, testHome, []),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});
