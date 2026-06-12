/**
 * Integration tests for agent/src/setup.ts
 *
 * Tests use injected execFn — no real claude/mise binaries needed.
 * All file I/O runs against a real temp dir (no mocks needed for fs).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentPlugin } from "@shipwright/admin";
import {
  ensureAgentHome,
  ensureDotClaudeSymlink,
  findStalePluginSpecs,
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
// ensureDotClaudeSymlink
// ---------------------------------------------------------------------------

describe("ensureDotClaudeSymlink", () => {
  it("creates the target dir so the symlink is NOT dangling", () => {
    mkdirSync(testHome, { recursive: true });
    const target = join(testHome, "dot-claude"); // does not exist yet
    const link = join(testHome, "home-claude");

    ensureDotClaudeSymlink(target, link, undefined, () => {});

    // Target was created, link is a symlink, and it resolves (not dangling).
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(link)).toBe(true);
    // A write THROUGH the link succeeds — this is the session-env path.
    mkdirSync(join(link, "session-env"), { recursive: true });
    expect(existsSync(join(target, "session-env"))).toBe(true);
  });

  it("replaces a stale DANGLING symlink without throwing (idempotent re-run)", () => {
    mkdirSync(testHome, { recursive: true });
    const target = join(testHome, "dot-claude");
    const link = join(testHome, "home-claude");

    // Simulate the original bug's leftover: a symlink to a missing target.
    symlinkSync(join(testHome, "missing-target"), link);
    expect(existsSync(link)).toBe(false); // dangling

    ensureDotClaudeSymlink(target, link, undefined, () => {});

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(link)).toBe(true); // now resolves
  });

  it("replaces a real directory at the link path", () => {
    mkdirSync(testHome, { recursive: true });
    const target = join(testHome, "dot-claude");
    const link = join(testHome, "home-claude");

    // A real directory (with a file) sits where the symlink should go.
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "stale.txt"), "x", "utf8");

    let warned = false;
    ensureDotClaudeSymlink(target, link, undefined, (m) => {
      if (m.includes("real directory")) warned = true;
    });

    expect(warned).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(link, "stale.txt"))).toBe(false);
  });

  it("is idempotent — calling twice leaves a valid symlink", () => {
    mkdirSync(testHome, { recursive: true });
    const target = join(testHome, "dot-claude");
    const link = join(testHome, "home-claude");

    ensureDotClaudeSymlink(target, link, undefined, () => {});
    expect(() =>
      ensureDotClaudeSymlink(target, link, undefined, () => {}),
    ).not.toThrow();
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(link)).toBe(true);
  });

  it("creates the sibling ~/.claude.json symlink (dangling until Claude writes it)", () => {
    mkdirSync(testHome, { recursive: true });
    const target = join(testHome, "dot-claude");
    const link = join(testHome, "home-claude");

    ensureDotClaudeSymlink(target, link, undefined, () => {});

    const jsonLink = `${link}.json`;
    expect(lstatSync(jsonLink).isSymbolicLink()).toBe(true);
    // Target does not exist yet — Claude writes it on first use. Resolves once created.
    const jsonTarget = join(target, "..", "claude.json");
    writeFileSync(jsonTarget, '{"mcpServers":{}}', "utf8");
    expect(readFileSync(jsonLink, "utf8")).toBe('{"mcpServers":{}}');
  });

  it("replaces a dangling ~/.claude.json symlink on re-run", () => {
    mkdirSync(testHome, { recursive: true });
    const target = join(testHome, "dot-claude");
    const link = join(testHome, "home-claude");
    const jsonLink = `${link}.json`;

    symlinkSync(join(testHome, "missing.json"), jsonLink);
    expect(existsSync(jsonLink)).toBe(false); // dangling

    ensureDotClaudeSymlink(target, link, undefined, () => {});

    expect(lstatSync(jsonLink).isSymbolicLink()).toBe(true);
  });

  it("replaces a real file at ~/.claude.json (image ships a real file — PVC copy wins)", () => {
    mkdirSync(testHome, { recursive: true });
    const target = join(testHome, "dot-claude");
    const link = join(testHome, "home-claude");
    const jsonLink = `${link}.json`;

    writeFileSync(jsonLink, "{}", "utf8");
    expect(lstatSync(jsonLink).isSymbolicLink()).toBe(false);

    ensureDotClaudeSymlink(target, link, undefined, () => {});

    expect(lstatSync(jsonLink).isSymbolicLink()).toBe(true);
  });
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

  it("returns { version: 1 } when file is corrupted (invalid JSON)", () => {
    mkdirSync(testHome, { recursive: true });
    writeFileSync(
      join(testHome, "workspace-state.json"),
      '{"version":1,"bootstrapSeededAt":"2026-',
      "utf8",
    );
    const state = loadState(testHome);
    expect(state).toEqual({ version: 1 });
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
  const originalXdgDataHome = process.env.XDG_DATA_HOME;
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;

  beforeEach(() => {
    // Isolate HOME to the per-test dir so the ~/.bashrc mise-activate append in
    // runMiseStartup never touches the real developer/CI home.
    process.env.HOME = testHome;
  });

  afterEach(() => {
    // Restore env vars modified by runMiseStartup (and the tests below)
    process.env.MISE_DATA_DIR = originalMiseDataDir;
    process.env.MISE_CACHE_DIR = originalMiseCacheDir;
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
  });

  it("sets MISE_DATA_DIR to the PVC path", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    const mockExec = async () => ({ stdout: "", exitCode: 0 });
    await runMiseStartup(testHome, mockExec);
    expect(process.env.MISE_DATA_DIR).toBe(join(testHome, "mise"));
  });

  it("does NOT seed/copy the image mise dir onto the PVC", async () => {
    // node + claude are system binaries (image /usr/bin), not mise tools, so
    // runMiseStartup must NOT copy the image mise dir onto the PVC. The old seed
    // hack did, which on a reused PVC left claude resolving to a shim with no
    // install ("claude is not a valid shim").
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    const imageMiseDir = join(testHome, ".local", "share", "mise");
    mkdirSync(join(imageMiseDir, "shims"), { recursive: true });
    writeFileSync(join(imageMiseDir, "shims", "claude"), "image-shim", "utf8");
    process.env.HOME = testHome;
    // biome-ignore lint/performance/noDelete: intentional env-var removal (not object property)
    delete process.env.XDG_DATA_HOME;
    const mockExec = async () => ({ stdout: "", exitCode: 0 });
    await runMiseStartup(testHome, mockExec);
    // The image's claude shim must NOT have been copied to the PVC.
    expect(existsSync(join(testHome, "mise", "shims", "claude"))).toBe(false);
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

  it("prepends MISE_DATA_DIR/shims (PVC path) to process.env.PATH", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    writeFileSync(
      join(testHome, "workspace", "mise.toml"),
      "[tools]\n",
      "utf8",
    );
    // biome-ignore lint/performance/noDelete: intentional env-var removal (not object property)
    delete process.env.MISE_DATA_DIR;
    const mockExec = async () => ({ stdout: "", exitCode: 0 });
    await runMiseStartup(testHome, mockExec);
    const expectedShims = join(testHome, "mise", "shims");
    expect(process.env.PATH?.startsWith(`${expectedShims}:`)).toBe(true);
  });

  it("appends mise activate bash to ~/.bashrc", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    const mockExec = async () => ({ stdout: "", exitCode: 0 });
    await runMiseStartup(testHome, mockExec);
    const bashrc = join(testHome, ".bashrc");
    expect(existsSync(bashrc)).toBe(true);
    expect(readFileSync(bashrc, "utf8")).toContain("mise activate bash");
  });

  it("does not duplicate the mise activate line on repeated calls (idempotent)", async () => {
    mkdirSync(join(testHome, "workspace"), { recursive: true });
    const mockExec = async () => ({ stdout: "", exitCode: 0 });
    await runMiseStartup(testHome, mockExec);
    await runMiseStartup(testHome, mockExec);
    const content = readFileSync(join(testHome, ".bashrc"), "utf8");
    const count = (content.match(/mise activate bash/g) ?? []).length;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// findStalePluginSpecs
// ---------------------------------------------------------------------------

describe("findStalePluginSpecs", () => {
  it("returns empty array when manifest does not exist", () => {
    const result = findStalePluginSpecs(
      ["shipwright@shipwright"],
      "/nonexistent/installed_plugins.json",
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when all installPaths exist", () => {
    mkdirSync(testHome, { recursive: true });
    const pluginDir = join(testHome, "plugin-dir");
    mkdirSync(pluginDir, { recursive: true });
    const manifestPath = join(testHome, "installed_plugins.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "shipwright@shipwright": [{ installPath: pluginDir }],
        },
      }),
    );

    const result = findStalePluginSpecs(["shipwright@shipwright"], manifestPath);
    expect(result).toEqual([]);
  });

  it("returns specs whose installPath does not exist on disk", () => {
    mkdirSync(testHome, { recursive: true });
    const manifestPath = join(testHome, "installed_plugins.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "vitals-os@vitals-os": [
            { installPath: "/root/.claude/plugins/cache/vitals-os/0.4.5" },
          ],
          "shipwright@shipwright": [
            { installPath: "/root/.claude/plugins/cache/shipwright/1.0.0" },
          ],
        },
      }),
    );

    const result = findStalePluginSpecs(
      ["vitals-os@vitals-os", "shipwright@shipwright"],
      manifestPath,
    );
    expect(result).toContain("vitals-os@vitals-os");
    expect(result).toContain("shipwright@shipwright");
  });

  it("skips specs not present in the manifest", () => {
    mkdirSync(testHome, { recursive: true });
    const manifestPath = join(testHome, "installed_plugins.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: 2, plugins: {} }),
    );

    const result = findStalePluginSpecs(["shipwright@shipwright"], manifestPath);
    expect(result).toEqual([]);
  });

  it("returns empty array when manifest JSON is corrupted", () => {
    mkdirSync(testHome, { recursive: true });
    const manifestPath = join(testHome, "installed_plugins.json");
    writeFileSync(manifestPath, "not valid json");

    const result = findStalePluginSpecs(["shipwright@shipwright"], manifestPath);
    expect(result).toEqual([]);
  });
});

// installPlugins
// ---------------------------------------------------------------------------

describe("installPlugins", () => {
  it("registers local marketplace then installs shipwright@shipwright using the shipwright marketplace", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(mockExec, testHome, [], "/repo/root", join(testHome, "nonexistent.json"));

    // marketplace add + 1 install + 1 update = 3 calls (no stale paths)
    expect(calls).toHaveLength(3);
    expect(calls[0].args).toEqual([
      "plugin",
      "marketplace",
      "add",
      "/repo/root",
    ]);
    expect(calls[1].args).toEqual([
      "plugin",
      "install",
      "shipwright@shipwright",
    ]);
    expect(calls[2].args).toEqual([
      "plugin",
      "update",
      "shipwright@shipwright",
    ]);
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

    await installPlugins(mockExec, testHome, agentPlugins, "/repo/root", join(testHome, "nonexistent.json"));

    // 1 marketplace add + 3 installs + 3 updates = 7 calls
    expect(calls).toHaveLength(7);

    expect(calls[0].args).toEqual([
      "plugin",
      "marketplace",
      "add",
      "/repo/root",
    ]);

    // installs: default first, then agent-specific
    expect(calls[1].args).toEqual([
      "plugin",
      "install",
      "shipwright@shipwright",
    ]);
    expect(calls[2].args).toEqual([
      "plugin",
      "install",
      "custom-plugin@my-marketplace",
    ]);
    expect(calls[3].args).toEqual([
      "plugin",
      "install",
      "another-plugin@other-market",
    ]);

    // updates: default first, then agent-specific
    expect(calls[4].args).toEqual([
      "plugin",
      "update",
      "shipwright@shipwright",
    ]);
    expect(calls[5].args).toEqual([
      "plugin",
      "update",
      "custom-plugin@my-marketplace",
    ]);
    expect(calls[6].args).toEqual([
      "plugin",
      "update",
      "another-plugin@other-market",
    ]);
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

    await installPlugins(mockExec, testHome, [], "/repo/root", join(testHome, "nonexistent.json"));

    // marketplace add + 1 install + 1 update = 3 calls
    expect(calls).toHaveLength(3);
    expect(calls[1].args).toContain("shipwright@shipwright");
    expect(calls[2].args).toContain("shipwright@shipwright");
  });

  it("is non-fatal when the claude binary isn't available", async () => {
    const throwingExec = async () => {
      throw new Error("spawn claude ENOENT");
    };

    await expect(
      installPlugins(throwingExec, testHome, [], "/repo/root", join(testHome, "nonexistent.json")),
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
      installPlugins(mockExec, testHome, [], "/repo/root", join(testHome, "nonexistent.json")),
    ).resolves.toBeUndefined();

    // All calls still happened despite install failures
    expect(calls).toHaveLength(3);
  });

  it("continues when marketplace add exits non-zero", async () => {
    const calls: Array<{ args: string[] }> = [];
    const mockExec = async (
      _cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ args });
      const isMarketplaceAdd = args[1] === "marketplace";
      return {
        stdout: isMarketplaceAdd ? "network error" : "",
        exitCode: isMarketplaceAdd ? 1 : 0,
      };
    };

    await expect(
      installPlugins(mockExec, testHome, [], "/repo/root", join(testHome, "nonexistent.json")),
    ).resolves.toBeUndefined();

    // All 3 calls still happened despite marketplace add failure
    expect(calls).toHaveLength(3);
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
      installPlugins(mockExec, testHome, [], "/repo/root", join(testHome, "nonexistent.json")),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  it("uninstalls then reinstalls plugins with stale installPaths from a different-HOME container", async () => {
    // Simulate a PVC where plugins were installed as root (HOME=/root) but the
    // container now runs as uid 1000 (HOME=/home/bun). The recorded installPath
    // points to /root/.claude/... which doesn't exist in the new container.
    mkdirSync(testHome, { recursive: true });
    const manifestPath = join(testHome, "installed_plugins.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "shipwright@shipwright": [
            { installPath: "/root/.claude/plugins/cache/shipwright/1.0.0" },
          ],
        },
      }),
    );

    const calls: Array<{ args: string[] }> = [];
    const mockExec = async (
      _cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(mockExec, testHome, [], "/repo/root", manifestPath);

    // marketplace add + uninstall (stale) + install + update = 4 calls
    expect(calls).toHaveLength(4);
    expect(calls[1].args).toEqual(["plugin", "uninstall", "shipwright@shipwright"]);
    expect(calls[2].args).toEqual(["plugin", "install", "shipwright@shipwright"]);
    expect(calls[3].args).toEqual(["plugin", "update", "shipwright@shipwright"]);
  });

  it("does not uninstall plugins with valid installPaths", async () => {
    // Plugin installed with correct HOME — installPath exists on disk.
    mkdirSync(testHome, { recursive: true });
    const pluginDir = join(testHome, "plugins", "cache", "shipwright", "1.0.0");
    mkdirSync(pluginDir, { recursive: true });
    const manifestPath = join(testHome, "installed_plugins.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        plugins: {
          "shipwright@shipwright": [{ installPath: pluginDir }],
        },
      }),
    );

    const calls: Array<{ args: string[] }> = [];
    const mockExec = async (
      _cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(mockExec, testHome, [], "/repo/root", manifestPath);

    // marketplace add + install + update = 3 calls (no uninstall)
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.args[1] !== "uninstall")).toBe(true);
  });
});
