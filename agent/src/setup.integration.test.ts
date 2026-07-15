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
  discoverBakedMarketplaces,
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

  it("CLAUDE.md loads @BOOTSTRAP.md immediately after @IDENTITY.md for a freshly-seeded workspace", () => {
    ensureAgentHome(testHome);
    const content = readFileSync(
      join(testHome, "workspace", "CLAUDE.md"),
      "utf8",
    );
    expect(content).toContain("@BOOTSTRAP.md");
    // @file includes are loaded literally by Claude Code, unconditionally — the
    // ordering matters (right after @IDENTITY.md) so the First-Run Ritual is
    // the next thing loaded after identity, not a prose note the model has to
    // notice and act on.
    const identityIdx = content.indexOf("@IDENTITY.md");
    const bootstrapIdx = content.indexOf("@BOOTSTRAP.md");
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx).toBeGreaterThan(identityIdx);
    const between = content.slice(
      identityIdx + "@IDENTITY.md".length,
      bootstrapIdx,
    );
    // Nothing but whitespace/newlines between the two includes.
    expect(between.trim()).toBe("");
  });

  it("does not seed state/todos.json or state/reviews.json (superseded by the task-store HTTP API)", () => {
    ensureAgentHome(testHome);
    expect(
      existsSync(join(testHome, "workspace", "state", "todos.json")),
    ).toBe(false);
    expect(
      existsSync(join(testHome, "workspace", "state", "reviews.json")),
    ).toBe(false);
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

  it("strips the @BOOTSTRAP.md include line from CLAUDE.md the moment setupCompletedAt first fires", () => {
    ensureAgentHome(testHome);
    const claudeMdPath = join(testHome, "workspace", "CLAUDE.md");
    const beforeContent = readFileSync(claudeMdPath, "utf8");
    expect(beforeContent).toContain("@BOOTSTRAP.md");

    // Simulate the ritual completing: BOOTSTRAP.md deleted, IDENTITY.md filled in.
    rmSync(join(testHome, "workspace", "BOOTSTRAP.md"));
    writeFileSync(
      join(testHome, "workspace", "IDENTITY.md"),
      "# Identity (filled)",
      "utf8",
    );

    ensureAgentHome(testHome);

    const state = loadState(testHome);
    expect(state.setupCompletedAt).toBeDefined();

    const afterContent = readFileSync(claudeMdPath, "utf8");
    expect(afterContent).not.toContain("@BOOTSTRAP.md");

    // Rest of the file is untouched — compare byte-for-byte minus the
    // stripped line (and its trailing newline).
    const expected = beforeContent
      .split("\n")
      .filter((line) => !line.includes("@BOOTSTRAP.md"))
      .join("\n");
    expect(afterContent).toBe(expected);
  });

  it("does not re-strip or error when ensureAgentHome runs again after setupCompletedAt is already set", () => {
    ensureAgentHome(testHome);
    rmSync(join(testHome, "workspace", "BOOTSTRAP.md"));
    writeFileSync(
      join(testHome, "workspace", "IDENTITY.md"),
      "# Identity (filled)",
      "utf8",
    );
    ensureAgentHome(testHome); // fires the strip
    const claudeMdPath = join(testHome, "workspace", "CLAUDE.md");
    const strippedContent = readFileSync(claudeMdPath, "utf8");
    expect(strippedContent).not.toContain("@BOOTSTRAP.md");

    // Custom edit after ritual completion — must survive further startups.
    const customContent = `${strippedContent}\n<!-- custom note -->\n`;
    writeFileSync(claudeMdPath, customContent, "utf8");

    ensureAgentHome(testHome); // must be a no-op w.r.t. CLAUDE.md content

    expect(readFileSync(claudeMdPath, "utf8")).toBe(customContent);
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

    const result = findStalePluginSpecs(
      ["shipwright@shipwright"],
      manifestPath,
    );
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
          "example-platform@example-platform": [
            {
              installPath: "/root/.claude/plugins/cache/example-platform/0.4.5",
            },
          ],
          "shipwright@shipwright": [
            { installPath: "/root/.claude/plugins/cache/shipwright/1.0.0" },
          ],
        },
      }),
    );

    const result = findStalePluginSpecs(
      ["example-platform@example-platform", "shipwright@shipwright"],
      manifestPath,
    );
    expect(result).toContain("example-platform@example-platform");
    expect(result).toContain("shipwright@shipwright");
  });

  it("skips specs not present in the manifest", () => {
    mkdirSync(testHome, { recursive: true });
    const manifestPath = join(testHome, "installed_plugins.json");
    writeFileSync(manifestPath, JSON.stringify({ version: 2, plugins: {} }));

    const result = findStalePluginSpecs(
      ["shipwright@shipwright"],
      manifestPath,
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when manifest JSON is corrupted", () => {
    mkdirSync(testHome, { recursive: true });
    const manifestPath = join(testHome, "installed_plugins.json");
    writeFileSync(manifestPath, "not valid json");

    const result = findStalePluginSpecs(
      ["shipwright@shipwright"],
      manifestPath,
    );
    expect(result).toEqual([]);
  });
});

// installPlugins
// ---------------------------------------------------------------------------

// Explicit empty extra-marketplace list — every call in this describe block
// must pass this (or an intentional array) instead of omitting the arg.
// Omitting it falls through to discoverBakedMarketplaces(BAKED_MARKETPLACES_ROOT),
// which reads the REAL /opt/shipwright/marketplaces directory on disk and makes
// these tests depend on ambient sandbox/image state.
const NO_EXTRA_MARKETPLACES: string[] = [];

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

    await installPlugins(
      mockExec,
      testHome,
      [],
      "/repo/root",
      join(testHome, "nonexistent.json"),
      NO_EXTRA_MARKETPLACES,
    );

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

    await installPlugins(
      mockExec,
      testHome,
      agentPlugins,
      "/repo/root",
      join(testHome, "nonexistent.json"),
      NO_EXTRA_MARKETPLACES,
    );

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

    await installPlugins(
      mockExec,
      testHome,
      [],
      "/repo/root",
      join(testHome, "nonexistent.json"),
      NO_EXTRA_MARKETPLACES,
    );

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
      installPlugins(
        throwingExec,
        testHome,
        [],
        "/repo/root",
        join(testHome, "nonexistent.json"),
        NO_EXTRA_MARKETPLACES,
      ),
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
      installPlugins(
        mockExec,
        testHome,
        [],
        "/repo/root",
        join(testHome, "nonexistent.json"),
        NO_EXTRA_MARKETPLACES,
      ),
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
      installPlugins(
        mockExec,
        testHome,
        [],
        "/repo/root",
        join(testHome, "nonexistent.json"),
        NO_EXTRA_MARKETPLACES,
      ),
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
      installPlugins(
        mockExec,
        testHome,
        [],
        "/repo/root",
        join(testHome, "nonexistent.json"),
        NO_EXTRA_MARKETPLACES,
      ),
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

    await installPlugins(
      mockExec,
      testHome,
      [],
      "/repo/root",
      manifestPath,
      NO_EXTRA_MARKETPLACES,
    );

    // marketplace add + uninstall (stale) + install + update = 4 calls
    expect(calls).toHaveLength(4);
    expect(calls[1].args).toEqual([
      "plugin",
      "uninstall",
      "shipwright@shipwright",
    ]);
    expect(calls[2].args).toEqual([
      "plugin",
      "install",
      "shipwright@shipwright",
    ]);
    expect(calls[3].args).toEqual([
      "plugin",
      "update",
      "shipwright@shipwright",
    ]);
  });

  it("skips install and update for a stale spec whose uninstall exits non-zero", async () => {
    // When uninstall fails the stale manifest entry survives. Re-installing
    // would silently succeed (idempotent) without fixing the stale path, so
    // the spec must be skipped — visible failure on next restart is better than
    // silent "success" with a still-broken path.
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
      const isUninstall = args[1] === "uninstall";
      return {
        stdout: isUninstall ? "permission denied" : "",
        exitCode: isUninstall ? 1 : 0,
      };
    };

    await installPlugins(
      mockExec,
      testHome,
      [],
      "/repo/root",
      manifestPath,
      NO_EXTRA_MARKETPLACES,
    );

    // marketplace add + uninstall (failed) = 2 calls; install and update are skipped
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual([
      "plugin",
      "marketplace",
      "add",
      "/repo/root",
    ]);
    expect(calls[1].args).toEqual([
      "plugin",
      "uninstall",
      "shipwright@shipwright",
    ]);
    // No install or update calls for the failed spec
    expect(calls.every((c) => c.args[1] !== "install")).toBe(true);
    expect(calls.every((c) => c.args[1] !== "update")).toBe(true);
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

    await installPlugins(
      mockExec,
      testHome,
      [],
      "/repo/root",
      manifestPath,
      NO_EXTRA_MARKETPLACES,
    );

    // marketplace add + install + update = 3 calls (no uninstall)
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.args[1] !== "uninstall")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// discoverBakedMarketplaces
// ---------------------------------------------------------------------------

describe("discoverBakedMarketplaces", () => {
  it("returns dirs that have .claude-plugin/marketplace.json", () => {
    mkdirSync(testHome, { recursive: true });
    const conventionRoot = join(testHome, "marketplaces");

    // Create a valid marketplace dir
    const validDir = join(conventionRoot, "my-marketplace");
    mkdirSync(join(validDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(validDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "my-marketplace" }),
      "utf8",
    );

    const result = discoverBakedMarketplaces(conventionRoot);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(validDir);
  });

  it("skips dirs without .claude-plugin/marketplace.json", () => {
    mkdirSync(testHome, { recursive: true });
    const conventionRoot = join(testHome, "marketplaces");

    // Valid dir
    const validDir = join(conventionRoot, "valid-marketplace");
    mkdirSync(join(validDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(validDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "valid-marketplace" }),
      "utf8",
    );

    // Dir missing .claude-plugin/marketplace.json
    const invalidDir = join(conventionRoot, "invalid-marketplace");
    mkdirSync(join(invalidDir, ".claude-plugin"), { recursive: true });
    // No marketplace.json — only a different file
    writeFileSync(
      join(invalidDir, ".claude-plugin", "plugin.json"),
      "{}",
      "utf8",
    );

    // Dir with no .claude-plugin at all
    const bareDir = join(conventionRoot, "bare-dir");
    mkdirSync(bareDir, { recursive: true });

    const result = discoverBakedMarketplaces(conventionRoot);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(validDir);
  });

  it("returns empty array when conventionRoot is absent", () => {
    const result = discoverBakedMarketplaces(
      join(testHome, "nonexistent-convention-root"),
    );
    expect(result).toEqual([]);
  });

  it("returns empty array when conventionRoot is empty", () => {
    mkdirSync(testHome, { recursive: true });
    const conventionRoot = join(testHome, "empty-marketplaces");
    mkdirSync(conventionRoot, { recursive: true });

    const result = discoverBakedMarketplaces(conventionRoot);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// installPlugins — extra marketplace discovery
// ---------------------------------------------------------------------------

describe("installPlugins — extra marketplace discovery", () => {
  it("registers each discovered marketplace dir before plugin installs", async () => {
    mkdirSync(testHome, { recursive: true });
    const conventionRoot = join(testHome, "marketplaces");

    // Create a baked marketplace dir
    const extraMarketDir = join(conventionRoot, "example-platform");
    mkdirSync(join(extraMarketDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(extraMarketDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "example-platform" }),
      "utf8",
    );

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(
      mockExec,
      testHome,
      [],
      "/repo/root",
      join(testHome, "nonexistent.json"),
      undefined, // use default discovery — pass conventionRoot via extraMarketplacesRoot
      conventionRoot,
    );

    // Extra marketplace add must come BEFORE the /repo/root marketplace add and BEFORE plugin install
    const addCalls = calls.filter((c) => c.args[1] === "marketplace");
    expect(addCalls.length).toBeGreaterThanOrEqual(2);
    expect(addCalls[0].args[3]).toBe(extraMarketDir);
    expect(addCalls[1].args[3]).toBe("/repo/root");

    // All install calls must come after all marketplace add calls
    const installIdx = calls.findIndex((c) => c.args[1] === "install");
    const lastAddIdx = calls.reduce(
      (max, c, i) => (c.args[1] === "marketplace" ? i : max),
      -1,
    );
    expect(installIdx).toBeGreaterThan(lastAddIdx);
  });

  it("skips dirs that do not have .claude-plugin/marketplace.json", async () => {
    mkdirSync(testHome, { recursive: true });
    const conventionRoot = join(testHome, "marketplaces");

    // Valid dir
    const validDir = join(conventionRoot, "valid");
    mkdirSync(join(validDir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(validDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ name: "valid" }),
      "utf8",
    );

    // Invalid dir (no marketplace.json)
    const invalidDir = join(conventionRoot, "invalid");
    mkdirSync(join(invalidDir, ".claude-plugin"), { recursive: true });

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(
      mockExec,
      testHome,
      [],
      "/repo/root",
      join(testHome, "nonexistent.json"),
      undefined,
      conventionRoot,
    );

    const addCalls = calls.filter((c) => c.args[1] === "marketplace");
    // Only valid + /repo/root = 2 adds (invalid dir excluded)
    expect(addCalls).toHaveLength(2);
    const addDirs = addCalls.map((c) => c.args[3]);
    expect(addDirs).toContain(validDir);
    expect(addDirs).not.toContain(invalidDir);
    expect(addDirs).toContain("/repo/root");
  });

  it("is backward compatible when no extra marketplace dirs exist", async () => {
    mkdirSync(testHome, { recursive: true });
    const conventionRoot = join(testHome, "empty-marketplaces");
    mkdirSync(conventionRoot, { recursive: true });

    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mockExec = async (
      cmd: string,
      args: string[],
      _opts: { cwd: string },
    ) => {
      calls.push({ cmd, args });
      return { stdout: "", exitCode: 0 };
    };

    await installPlugins(
      mockExec,
      testHome,
      [],
      "/repo/root",
      join(testHome, "nonexistent.json"),
      undefined,
      conventionRoot,
    );

    // Only the /repo/root marketplace add — same as before this feature
    const addCalls = calls.filter((c) => c.args[1] === "marketplace");
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].args[3]).toBe("/repo/root");
    // marketplace add + install + update = 3 calls total
    expect(calls).toHaveLength(3);
  });
});
