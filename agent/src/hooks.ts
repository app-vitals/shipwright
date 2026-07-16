/**
 * agent/src/hooks.ts
 *
 * Command hooks — plugin-declared, per-command pre-run hooks executed as
 * fail-closed guards around the shared Claude runner. Hook dirs named
 * `hooks/<plugin>:<command>.pre/` are resolved across all installed plugins
 * (same manifest/pluginCacheDir resolution preCheck uses), then the workspace
 * escape hatch `state/hooks/<plugin>:<command>.pre/`. With no hook dirs
 * installed the decorator is a byte-identical passthrough.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClaudeRunResult } from "./claude.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The claude runner signature the decorator preserves. */
export type ClaudeRunner = (
  message: string,
  sessionKey?: string,
) => Promise<ClaudeRunResult>;

/** Filesystem surface used for hook resolution — injectable for tests. */
export interface HookFs {
  existsSync: (path: string) => boolean;
  statSync: (path: string) => { isDirectory: () => boolean; mode: number };
  readdirSync: (path: string) => string[];
  readFileSync: (path: string, encoding: "utf-8") => string;
}

const nodeFs: HookFs = { existsSync, statSync, readdirSync, readFileSync };

export interface CommandHooksConfig {
  /** Workspace root — hook cwd, and the base for the `state/hooks` escape hatch. */
  workspace?: string;
  /** Plugin cache dir — overridable for testing, like cron-handler's preCheck. */
  pluginCacheDir?: string;
  /** installed_plugins.json path — the production resolution source. */
  pluginManifestPath?: string;
  /** Per-hook timeout. Defaults to SHIPWRIGHT_HOOK_TIMEOUT_MS (120000ms). */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL on timeout. Default 5000ms. */
  killGraceMs?: number;
  /** Process spawner — injectable for tests. Defaults to Bun.spawn. */
  spawner?: typeof Bun.spawn;
  /** Filesystem surface — injectable for tests. Defaults to node:fs. */
  fs?: HookFs;
}

/** The plugin + command a slash-command message invokes. */
export interface ParsedCommand {
  plugin: string;
  command: string;
}

const DEFAULT_HOOK_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 5_000;

// ─── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when a pre hook exits nonzero, times out, or cannot be resolved.
 * Fail-closed: the session is suppressed.
 */
export class HookError extends Error {
  constructor(
    readonly hookName: string,
    readonly exitCode: number | undefined,
    readonly stderr: string,
    readonly timedOut: boolean = false,
  ) {
    super(
      timedOut
        ? `pre hook "${hookName}" timed out${stderr ? `: ${stderr}` : ""}`
        : `pre hook "${hookName}" failed (exit ${exitCode})${stderr ? `: ${stderr}` : ""}`,
    );
    this.name = "HookError";
  }
}

// ─── Command parsing ────────────────────────────────────────────────────────

// A fully-qualified slash command: /<plugin>:<command>, terminated by
// whitespace or end-of-line.
const COMMAND_RE = /^\/([A-Za-z0-9._-]+):([A-Za-z0-9._-]+)(?:\s|$)/;

// Wrapper lines the dispatch paths prepend on their own line(s) before the
// substantive message: cron-handler's `[Cron job: <id>] Current time: …` and
// slack.ts's `[Thread message — …]` line. Skipped so the command is still
// resolvable from the outgoing message alone.
const WRAPPER_LINE_RE = /^\[(?:Cron job:|Thread message)/;

// slack.ts's app_mention handler may prepend a `[Thread context]` …
// `[end thread context]` block of quoted history — never the message being
// sent, so it is skipped wholesale (a slash command inside it must NOT fire).
const THREAD_CONTEXT_START = "[Thread context]";
const THREAD_CONTEXT_END = "[end thread context]";

// slack.ts prefixes every human message with `[<display name>]: ` and an
// app_mention's text retains the bot's `<@U…>` mention token — both may
// precede the slash command on the substantive line.
const SENDER_PREFIX_RE = /^\[[^\]]+\]:\s*/;
const MENTION_TOKEN_RE = /^(?:<@[^>\s]+>\s*)+/;

/**
 * Parse the leading fully-qualified slash command from an outgoing runner
 * message. Returns undefined when the message does not invoke one (⇒ the
 * decorator passes through untouched).
 */
export function parseCommand(message: string): ParsedCommand | undefined {
  let inThreadContext = false;
  for (const rawLine of message.split("\n")) {
    const line = rawLine.trim();
    if (inThreadContext) {
      if (line === THREAD_CONTEXT_END) inThreadContext = false;
      continue;
    }
    if (line === "") continue;
    if (line === THREAD_CONTEXT_START) {
      inThreadContext = true;
      continue;
    }
    if (WRAPPER_LINE_RE.test(line)) continue;
    const stripped = line
      .replace(SENDER_PREFIX_RE, "")
      .replace(MENTION_TOKEN_RE, "");
    const match = COMMAND_RE.exec(stripped);
    return match ? { plugin: match[1], command: match[2] } : undefined;
  }
  return undefined;
}

// ─── Hook resolution ────────────────────────────────────────────────────────

interface PluginRoot {
  name: string;
  root: string;
}

/**
 * Enumerate installed plugins as `{ name, root }`, using the same
 * pluginCacheDir / installed_plugins.json sources cron-handler's preCheck
 * resolution uses.
 */
function listPluginRoots(config: CommandHooksConfig, fs: HookFs): PluginRoot[] {
  const roots: PluginRoot[] = [];

  if (config.pluginCacheDir) {
    if (!fs.existsSync(config.pluginCacheDir)) return roots;
    for (const name of fs.readdirSync(config.pluginCacheDir)) {
      const root = join(config.pluginCacheDir, name);
      if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
        roots.push({ name, root });
      }
    }
    return roots;
  }

  const manifestPath =
    config.pluginManifestPath ??
    join(homedir(), ".claude", "plugins", "installed_plugins.json");

  // An absent manifest means no plugins are installed — the no-hooks
  // passthrough case, not an error.
  if (!fs.existsSync(manifestPath)) return roots;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      version: number;
      plugins: Record<string, Array<{ installPath?: string }>>;
    };
    for (const [key, entries] of Object.entries(manifest.plugins)) {
      const installPath = entries?.[0]?.installPath;
      if (installPath) {
        // Manifest keys are `<name>@<source>` — the plugin name is the prefix.
        roots.push({ name: key.split("@")[0], root: installPath });
      }
    }
  } catch (err) {
    // Fail closed: a manifest that exists but cannot be read/parsed makes
    // hook resolution unknowable — the session must not run ungated.
    throw new HookError(manifestPath, undefined, String(err));
  }
  return roots;
}

/** Sorted list of executable files in a hook directory (empty if absent). */
function listHookScripts(dir: string, fs: HookFs): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const scripts: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const path = join(dir, name);
    let stat: { isDirectory: () => boolean; mode: number };
    try {
      stat = fs.statSync(path);
    } catch (err) {
      // Fail closed: an unstat-able entry (e.g. a dangling symlink) is a
      // broken hook install, not a skippable file.
      throw new HookError(path, undefined, String(err));
    }
    // Only regular executable files run — skip subdirs and non-exec files.
    if (!stat.isDirectory() && (stat.mode & 0o111) !== 0) {
      scripts.push(path);
    }
  }
  return scripts;
}

/**
 * Resolve the ordered list of pre-hook script paths for an invoked command:
 * plugin hooks first (alphabetical by plugin, then filename), workspace
 * escape-hatch hooks last.
 */
export function resolveHookScripts(
  parsed: ParsedCommand,
  config: CommandHooksConfig,
): string[] {
  const fs = config.fs ?? nodeFs;
  const dirName = `${parsed.plugin}:${parsed.command}.pre`;
  const scripts: string[] = [];

  const roots = listPluginRoots(config, fs).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const { root } of roots) {
    scripts.push(...listHookScripts(join(root, "hooks", dirName), fs));
  }

  if (config.workspace) {
    scripts.push(
      ...listHookScripts(join(config.workspace, "state", "hooks", dirName), fs),
    );
  }

  return scripts;
}

// ─── Execution ────────────────────────────────────────────────────────────

function resolveTimeoutMs(config: CommandHooksConfig): number {
  if (config.timeoutMs !== undefined) return config.timeoutMs;
  const raw = process.env.SHIPWRIGHT_HOOK_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_HOOK_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_HOOK_TIMEOUT_MS;
}

/** Run a single pre hook, throwing HookError on nonzero exit or timeout. */
async function runHook(
  scriptPath: string,
  message: string,
  parsed: ParsedCommand,
  config: CommandHooksConfig,
): Promise<void> {
  const spawner = config.spawner ?? Bun.spawn;
  const timeoutMs = resolveTimeoutMs(config);
  const killGraceMs = config.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const proc = spawner([scriptPath], {
    ...(config.workspace ? { cwd: config.workspace } : {}),
    // Spread at spawn time so live config-sync env rotations are visible,
    // mirroring preCheck's env: process.env passthrough.
    env: {
      ...process.env,
      SHIPWRIGHT_HOOK_EVENT: "pre",
      SHIPWRIGHT_HOOK_COMMAND: `${parsed.plugin}:${parsed.command}`,
    },
    stdin: new TextEncoder().encode(message),
    stdout: "inherit",
    stderr: "pipe",
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    // Escalate: a hook that ignores SIGTERM must not hang the agent.
    killTimer = setTimeout(() => proc.kill("SIGKILL"), killGraceMs);
  }, timeoutMs);

  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
  });

  if (timedOut) {
    throw new HookError(scriptPath, exitCode, stderr.trim(), true);
  }
  if (exitCode !== 0) {
    throw new HookError(scriptPath, exitCode, stderr.trim(), false);
  }
}

// ─── Decorator ────────────────────────────────────────────────────────────

/**
 * Wrap a claude runner so every message whose leading slash command has
 * attached pre hooks runs those hooks first. No leading command, or no hooks
 * attached ⇒ byte-identical passthrough. A hook failure throws HookError
 * before the runner is ever called, so the session does not run.
 */
export function withCommandHooks(
  runner: ClaudeRunner,
  config: CommandHooksConfig = {},
): ClaudeRunner {
  return async function runWithHooks(
    message: string,
    sessionKey?: string,
  ): Promise<ClaudeRunResult> {
    const parsed = parseCommand(message);
    if (!parsed) return runner(message, sessionKey);

    const scripts = resolveHookScripts(parsed, config);
    if (scripts.length === 0) return runner(message, sessionKey);

    const command = `${parsed.plugin}:${parsed.command}`;
    for (const scriptPath of scripts) {
      console.log(
        `[agent:hooks] running pre hook for ${command}: ${scriptPath}`,
      );
      await runHook(scriptPath, message, parsed, config);
    }

    return runner(message, sessionKey);
  };
}
