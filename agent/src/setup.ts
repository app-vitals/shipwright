/**
 * agent/src/setup.ts
 * Workspace bootstrapping — directory scaffolding, file seeding, plugin installation.
 *
 * Safe to call on every agent startup:
 * - Identity/config files are seeded once using wx semantics (user edits preserved)
 * - Plugin installs are idempotent (exit 0 when already present / already at latest)
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentPlugin } from "@shipwright/admin";

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

// Templates live at agent/workspace/ alongside this source file.
const WORKSPACE_TEMPLATE_DIR = join(import.meta.dir, "..", "workspace");

// Repo root — two levels up from agent/src/. In Docker this is /app; on the Pi
// it resolves to the checkout root. Mirrors the vitals-os approach so the local
// marketplace is always used regardless of whether the GitHub repo is accessible.
const SHIPWRIGHT_REPO_ROOT = join(import.meta.dir, "..", "..");

// Local marketplace name — matches the `name` field in .claude-plugin/marketplace.json.
const SHIPWRIGHT_MARKETPLACE = "shipwright";

// Default plugin installed on all Shipwright agents.
const DEFAULT_PLUGINS: readonly string[] = ["shipwright"];

/**
 * Reads a template file from agent/workspace/<name>.
 * Throws clearly if the file is missing so deployment failures are loud.
 */
function readTemplate(name: string): string {
  const path = join(WORKSPACE_TEMPLATE_DIR, name);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`Missing workspace template: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// Workspace state
// ---------------------------------------------------------------------------

interface WorkspaceState {
  version: 1;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
}

/**
 * Loads workspace state from $AGENT_HOME/workspace-state.json.
 * Returns { version: 1 } when the file is absent or corrupted.
 */
export function loadState(home: string): WorkspaceState {
  const statePath = join(home, "workspace-state.json");
  if (!existsSync(statePath)) {
    return { version: 1 };
  }
  const raw = readFileSync(statePath, "utf8");
  try {
    return JSON.parse(raw) as WorkspaceState;
  } catch {
    // Corrupted or truncated file (e.g., partial write from a prior crash) —
    // fall back to defaults so startup is never blocked.
    return { version: 1 };
  }
}

/**
 * Saves workspace state to $AGENT_HOME/workspace-state.json.
 */
export function saveState(home: string, state: WorkspaceState): void {
  const statePath = join(home, "workspace-state.json");
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// File seeding
// ---------------------------------------------------------------------------

/**
 * Writes content to path using exclusive-create flag (wx).
 * Silently skips if the file already exists.
 * Rethrows any other error.
 */
export function seedFile(path: string, content: string): void {
  try {
    writeFileSync(path, content, { flag: "wx", encoding: "utf8" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// New workspace detection
// ---------------------------------------------------------------------------

/**
 * Returns true only when ALL of these markers are absent from the workspace dir:
 * - IDENTITY.md
 * - SOUL.md
 * - memory/ directory
 * - .git directory
 */
export function isNewWorkspace(home: string): boolean {
  const workspaceDir = join(home, "workspace");

  if (existsSync(join(workspaceDir, "IDENTITY.md"))) return false;
  if (existsSync(join(workspaceDir, "SOUL.md"))) return false;

  const memoryPath = join(workspaceDir, "memory");
  if (existsSync(memoryPath)) {
    try {
      if (statSync(memoryPath).isDirectory()) return false;
    } catch {
      // stat error — treat as absent
    }
  }

  const gitPath = join(workspaceDir, ".git");
  if (existsSync(gitPath)) {
    try {
      if (statSync(gitPath).isDirectory()) return false;
    } catch {
      // stat error — treat as absent
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Plugin install
// ---------------------------------------------------------------------------

type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; exitCode: number }>;

async function defaultExec(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<{ stdout: string; exitCode: number }> {
  // env: process.env is required — Bun.spawn otherwise snapshots env at Bun
  // startup and misses runtime mutations (MISE_CACHE_DIR, etc.).
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return { stdout, exitCode: proc.exitCode ?? 1 };
}

/**
 * Installs the shipwright default plugins plus any agent-specific plugins
 * from the config bundle. All commands are idempotent (exit 0 when already
 * present / already at latest), so reboots are a silent no-op.
 *
 * Non-fatal — a missing `claude` binary or network blip logs and returns
 * without throwing, so startup is never blocked.
 *
 * Install order: defaults first, then agent-specific plugins.
 * Update order: same.
 */
export async function installPlugins(
  execFn: ExecFn = defaultExec,
  cwd: string = process.cwd(),
  agentPlugins: AgentPlugin[] = [],
  shipwrightRepoRoot: string = SHIPWRIGHT_REPO_ROOT,
): Promise<void> {
  try {
    // Register the local marketplace so `claude plugin install` can resolve
    // plugins by name. Idempotent — safe to call on every startup.
    const add = await execFn(
      "claude",
      ["plugin", "marketplace", "add", shipwrightRepoRoot],
      { cwd },
    );
    if (add.exitCode !== 0) {
      console.warn(
        `[agent] claude plugin marketplace add exited ${add.exitCode}: ${add.stdout}`,
      );
    }

    const defaultPluginSpecs = DEFAULT_PLUGINS.map(
      (name) => `${name}@${SHIPWRIGHT_MARKETPLACE}`,
    );
    const agentPluginSpecs = agentPlugins.map(
      (p) => `${p.plugin}@${p.marketplace}`,
    );
    const allSpecs = [...defaultPluginSpecs, ...agentPluginSpecs];

    // Install all plugins (defaults then agent-specific)
    for (const spec of allSpecs) {
      const install = await execFn("claude", ["plugin", "install", spec], {
        cwd,
      });
      if (install.exitCode !== 0) {
        console.warn(
          `[agent] claude plugin install ${spec} exited ${install.exitCode}: ${install.stdout}`,
        );
      }
    }

    // Update all plugins (defaults then agent-specific)
    for (const spec of allSpecs) {
      const update = await execFn("claude", ["plugin", "update", spec], {
        cwd,
      });
      if (update.exitCode !== 0) {
        console.warn(
          `[agent] claude plugin update ${spec} exited ${update.exitCode}: ${update.stdout}`,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[agent] plugin install failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Initializes $AGENT_HOME with the required directory structure, identity
 * files, and workspace scaffolding.
 *
 * Safe to call on every startup:
 * - Identity/skill files are seeded once with wx semantics (user edits preserved)
 * - state/todos.json, state/reviews.json, state/agent-policy.md are seeded once if absent
 *
 * Throws if required directories cannot be created.
 */
/** Filesystem ops used by ensureDotClaudeSymlink — injectable for tests. */
export interface DotClaudeFs {
  mkdirSync: typeof mkdirSync;
  lstatSync: typeof lstatSync;
  unlinkSync: typeof unlinkSync;
  rmSync: typeof rmSync;
  symlinkSync: typeof symlinkSync;
}

const DEFAULT_DOT_CLAUDE_FS: DotClaudeFs = {
  mkdirSync,
  lstatSync,
  unlinkSync,
  rmSync,
  symlinkSync,
};

/**
 * Symlink `linkPath` (~/.claude) → `target` ($AGENT_HOME/dot-claude), ensuring
 * the TARGET directory exists first. ALSO symlinks the sibling `~/.claude.json`
 * → `$AGENT_HOME/claude.json` (see below).
 *
 * The target MUST be created before symlinking: on a fresh PVC the target does
 * not exist, so without this the symlink dangles and every write under
 * ~/.claude — Claude Code's `session-env`, plugin installs — fails (the Bash
 * tool can't initialize, plugin installs exit 1).
 *
 * Existence is probed with `lstatSync`, not `existsSync`: `existsSync` follows
 * the link and returns false for a DANGLING symlink, which would then make
 * `symlinkSync` throw EEXIST on a re-run. `lstatSync` sees the link itself, so
 * a stale/dangling symlink is detected and replaced. A real directory at
 * `linkPath` is removed (logged) before relinking.
 *
 * `~/.claude.json` holds Claude Code's MCP server registrations (`claude mcp
 * add`) and lives OUTSIDE `~/.claude/`, so it needs its own symlink to survive
 * pod restarts. Without it, registered MCP servers (e.g. Linear) silently
 * disappear — Claude reads the ephemeral image copy instead of the PVC's. The
 * target is `$AGENT_HOME/claude.json` (sibling of the dot-claude dir), matching
 * the path the vitals-os runtime used, so a migrated PVC's existing MCP config
 * is picked up. Unlike the dir, the target is NOT pre-created: it is a FILE that
 * Claude writes on first use, so a dangling symlink is correct until then.
 */
export function ensureDotClaudeSymlink(
  target: string,
  linkPath: string,
  fs: DotClaudeFs = DEFAULT_DOT_CLAUDE_FS,
  log: (msg: string) => void = console.log,
): void {
  // Create the symlink target first so the link never dangles.
  fs.mkdirSync(target, { recursive: true });

  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch {
    existing = null; // linkPath does not exist yet — nothing to remove
  }

  if (existing) {
    if (existing.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else {
      log(
        "[entrypoint] ~/.claude is a real directory — removing before symlinking",
      );
      fs.rmSync(linkPath, { recursive: true });
    }
  }

  fs.symlinkSync(target, linkPath);
  log(`[entrypoint] symlinked ${linkPath} → ${target}`);

  // ── ~/.claude.json (MCP server registrations) — file symlink, no mkdir ──────
  const jsonTarget = join(target, "..", "claude.json");
  const jsonLink = `${linkPath}.json`;
  let existingJson: ReturnType<typeof lstatSync> | null = null;
  try {
    existingJson = fs.lstatSync(jsonLink);
  } catch {
    existingJson = null;
  }
  if (existingJson) {
    if (existingJson.isSymbolicLink()) {
      fs.unlinkSync(jsonLink);
    } else {
      // The image ships a real ~/.claude.json — remove it before symlinking so
      // the PVC copy (with MCP registrations) is the one Claude reads.
      fs.rmSync(jsonLink, { recursive: false });
    }
  }
  fs.symlinkSync(jsonTarget, jsonLink);
  log(`[entrypoint] symlinked ${jsonLink} → ${jsonTarget}`);
}

export function ensureAgentHome(home: string): void {
  const workspaceDir = join(home, "workspace");
  const stateDir = join(workspaceDir, "state");
  const reposDir = join(workspaceDir, "repos");
  const worktreesDir = join(workspaceDir, "worktrees");

  const claudeDir = join(workspaceDir, ".claude");
  const skillsDir = join(claudeDir, "skills");
  const commandsDir = join(claudeDir, "commands");

  const miseDir = join(home, "mise");

  // Create required directories (throws on permission error)
  for (const dir of [
    workspaceDir,
    claudeDir,
    skillsDir,
    commandsDir,
    stateDir,
    reposDir,
    worktreesDir,
    miseDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // Check new workspace status BEFORE seeding identity files (markers include SOUL.md)
  const newWorkspace = isNewWorkspace(home);

  // Seed identity files into workspace/ (Claude's cwd — where CLAUDE.md is auto-loaded)
  seedFile(join(workspaceDir, "CLAUDE.md"), readTemplate("CLAUDE.md.template"));

  // Seed VOICE.md once (wx semantics — user edits preserved)
  seedFile(join(workspaceDir, "VOICE.md"), readTemplate("VOICE.md.template"));

  seedFile(join(workspaceDir, "SOUL.md"), readTemplate("SOUL.md.template"));
  seedFile(
    join(workspaceDir, "IDENTITY.md"),
    readTemplate("IDENTITY.md.template"),
  );

  // Seed workspace/mise.toml — user-editable tool declarations; seeded once (wx)
  seedFile(join(workspaceDir, "mise.toml"), readTemplate("mise.toml.template"));

  // Seed workspace/requirements.txt — Python package dependencies; seeded once (wx)
  seedFile(
    join(workspaceDir, "requirements.txt"),
    readTemplate("requirements.txt.template"),
  );

  // Seed state/todos.json — shipwright work queue
  seedFile(
    join(stateDir, "todos.json"),
    readTemplate("state/todos.json.template"),
  );

  // Seed state/reviews.json — review tracking
  seedFile(join(stateDir, "reviews.json"), "[]\n");

  // Create state/reviews/ directory for review artifacts (PR_REVIEW files)
  mkdirSync(join(stateDir, "reviews"), { recursive: true });

  // Seed state/agent-policy.md — conservative defaults for agent autonomy
  seedFile(
    join(stateDir, "agent-policy.md"),
    readTemplate("state/agent-policy.md.template"),
  );

  // Bootstrap seeding for new workspaces
  const state = loadState(home);

  if (newWorkspace && !state.bootstrapSeededAt) {
    seedFile(
      join(workspaceDir, "BOOTSTRAP.md"),
      readTemplate("BOOTSTRAP.md.template"),
    );
    state.bootstrapSeededAt = new Date().toISOString();
    saveState(home, state);
  } else if (
    state.bootstrapSeededAt &&
    !existsSync(join(workspaceDir, "BOOTSTRAP.md"))
  ) {
    state.setupCompletedAt = new Date().toISOString();
    saveState(home, state);
  }
}

// ---------------------------------------------------------------------------
// Mise startup
// ---------------------------------------------------------------------------

/**
 * Configures mise for the agent workspace:
 * - Sets MISE_DATA_DIR so installs land on the PVC
 * - Sets MISE_CACHE_DIR + XDG_CACHE_HOME so download tarballs and tool caches
 *   land on the PVC instead of ephemeral storage
 * - Runs `mise install` when workspace/mise.toml is present (idempotent)
 * - Prepends mise shim paths to process.env.PATH so subprocesses find tools
 *
 * Non-fatal: mise failures are logged but do not abort startup.
 */
export async function runMiseStartup(
  home: string,
  execFn: ExecFn = defaultExec,
): Promise<void> {
  const workspaceDir = join(home, "workspace");

  // Pin mise + XDG cache/data dirs to the PVC before any mise calls so installs
  // and download tarballs land on persistent storage, not ephemeral. node and
  // claude are system-wide binaries (installed in the image, on /usr/bin), NOT
  // mise tools — so repointing MISE_DATA_DIR at the PVC does NOT affect them.
  // MISE_DATA_DIR holds only workspace-declared runtime tools.
  //
  // (Do NOT seed/copy the image mise dir onto the PVC here — that hack existed
  // when node+claude were mise-managed; on a reused PVC the copy was skipped and
  // claude resolved to a shim with no install: "claude is not a valid shim".)
  process.env.MISE_DATA_DIR = join(home, "mise");
  process.env.MISE_CACHE_DIR = join(home, "mise", "cache");
  process.env.XDG_CACHE_HOME = join(home, "cache");
  mkdirSync(process.env.MISE_CACHE_DIR, { recursive: true });
  mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });

  // Activate mise in any bash session the agent spawns (e.g. Claude Code's Bash
  // tool). The shims-on-PATH prepend below only reaches direct subprocesses;
  // login/interactive shells re-source profile files that reset PATH, so
  // workspace-declared tools (e.g. fern's Rust toolchain) would be missing
  // without this. Ported from the vitals-os runtime; dropped in the extraction.
  // Unconditional (before the mise.toml check) so it's ready for any workspace
  // tools; idempotent so repeated boots don't stack duplicate lines.
  const bashrc = join(process.env.HOME ?? home, ".bashrc");
  if (
    !existsSync(bashrc) ||
    !readFileSync(bashrc, "utf8").includes("mise activate bash")
  ) {
    appendFileSync(bashrc, '\neval "$(mise activate bash)"\n');
    console.log(`[agent] mise activation appended to ${bashrc}`);
  }

  // Skip mise install if no mise.toml declared
  const miseTomlPath = join(workspaceDir, "mise.toml");
  if (!existsSync(miseTomlPath)) {
    return;
  }

  // Trust the workspace config so mise doesn't prompt interactively
  await execFn("mise", ["trust", miseTomlPath], { cwd: workspaceDir });

  // Run mise install (idempotent — no-op when tools already cached)
  const install = await execFn("mise", ["install"], { cwd: workspaceDir });
  if (install.exitCode !== 0) {
    console.warn("[agent] mise install failed — tools may be unavailable");
    return;
  }

  // Prepend MISE_DATA_DIR/shims to PATH so workspace-declared tools are found
  // in non-interactive bash sessions.
  const shimsDir = join(process.env.MISE_DATA_DIR, "shims");
  process.env.PATH = [shimsDir, process.env.PATH ?? ""].join(":");
}
