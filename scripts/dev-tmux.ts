/**
 * scripts/dev-tmux.ts
 * Full dev stack in a tmux session — 4 panes: metrics :3460, agent :3000,
 * chat REPL, and a scratch log shell.
 *
 * Usage:
 *   bun scripts/dev-tmux.ts
 *   (or: task stack)
 *
 * Requires tmux. If tmux is absent, exits with a clear message pointing at
 * `task dev` (the tmux-less alternative).
 *
 * Architecture:
 *   buildTmuxCommands() is a pure builder — no I/O, fully unit-testable.
 *   It returns a TmuxCommand array that launchTmux() executes sequentially.
 *   launchTmux(execFn?) accepts an optional injected exec fn so unit tests
 *   can assert the exact command sequence without spawning a real tmux session
 *   (mirrors the createSupervisor(children, spawnFn?) pattern in scripts/dev.ts).
 *
 * Preflight:
 *   Runs `task db:provision` (prisma migrate deploy) with DATABASE_URL_AGENT
 *   set to the local SQLite path before spawning the agent pane. Safe to
 *   re-run — prisma migrate deploy is idempotent.
 *
 * Pane layout (single window, 4 panes):
 *   [0] metrics  — bun metrics/src/server.ts (METRICS_OFFLINE=true, :3460)
 *   [1] agent    — bun agent/src/run-agent.ts (SHIPWRIGHT_DEV_CHAT=true, :3000)
 *   [2] chat     — bun scripts/chat.ts
 *   [3] logs     — empty scratch shell
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecResult = {
  exitCode: number;
  stderr?: string;
};

export type ExecFn = (cmd: TmuxCommand) => ExecResult | Promise<ExecResult>;

export type TmuxCommand = {
  /** The full tmux argv, e.g. ["tmux", "new-session", "-d", "-s", "shipwright"] */
  args: string[];
  /** Optional per-command env vars merged with process.env before exec */
  env?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_NAME = "shipwright";

/** Pane target references — <session>:<window>.<pane> */
export const PANE_METRICS = `${SESSION_NAME}:0.0`;
export const PANE_AGENT = `${SESSION_NAME}:0.1`;
export const PANE_CHAT = `${SESSION_NAME}:0.2`;
export const PANE_LOGS = `${SESSION_NAME}:0.3`;

// ---------------------------------------------------------------------------
// Dev env vars (obviously-dummy values — local dev only)
// ---------------------------------------------------------------------------

const DEV_ENV = {
  DATABASE_URL_AGENT: "file:./agent/dev.db",
  SHIPWRIGHT_ENCRYPTION_KEY: "dev-only-key-not-real-00000000000000000000000000000000",
  AGENT_HOME: "state/agent-home",
  SHIPWRIGHT_DEV_CHAT: "true",
  POSTHOG_HOST: "http://localhost:3460",
  POSTHOG_PROJECT_API_KEY: "dev",
} as const;

// ---------------------------------------------------------------------------
// Pure builder — no I/O
// ---------------------------------------------------------------------------

/**
 * Build the ordered sequence of tmux commands that set up the 4-pane
 * dev session. Returns a plain array — no side effects.
 *
 * Command sequence:
 *   1. new-session  — create detached session named "shipwright"
 *   2. send-keys    — launch metrics in pane 0
 *   3. split-window — open pane 1 (agent)
 *   4. send-keys    — launch agent in pane 1
 *   5. split-window — open pane 2 (chat)
 *   6. send-keys    — launch chat in pane 2
 *   7. split-window — open pane 3 (logs scratch)
 *   8. select-pane  — focus the chat pane so the user lands there
 *   9. attach-session — attach (final command)
 */
export function buildTmuxCommands(): TmuxCommand[] {
  return [
    // 1. Create a new detached tmux session
    {
      args: ["tmux", "new-session", "-d", "-s", SESSION_NAME],
    },

    // 2. metrics pane (pane 0, the initial pane)
    {
      args: [
        "tmux",
        "send-keys",
        "-t",
        PANE_METRICS,
        "bun metrics/src/server.ts",
        "Enter",
      ],
      env: {
        METRICS_OFFLINE: "true",
      },
    },

    // 3. Split to create agent pane (pane 1)
    {
      args: [
        "tmux",
        "split-window",
        "-t",
        `${SESSION_NAME}:0`,
        "-v",
      ],
    },

    // 4. agent pane (pane 1)
    {
      args: [
        "tmux",
        "send-keys",
        "-t",
        PANE_AGENT,
        "bun agent/src/run-agent.ts",
        "Enter",
      ],
      env: {
        SHIPWRIGHT_DEV_CHAT: DEV_ENV.SHIPWRIGHT_DEV_CHAT,
        POSTHOG_HOST: DEV_ENV.POSTHOG_HOST,
        POSTHOG_PROJECT_API_KEY: DEV_ENV.POSTHOG_PROJECT_API_KEY,
        DATABASE_URL_AGENT: DEV_ENV.DATABASE_URL_AGENT,
        SHIPWRIGHT_ENCRYPTION_KEY: DEV_ENV.SHIPWRIGHT_ENCRYPTION_KEY,
        AGENT_HOME: DEV_ENV.AGENT_HOME,
      },
    },

    // 5. Split to create chat pane (pane 2)
    {
      args: [
        "tmux",
        "split-window",
        "-t",
        `${SESSION_NAME}:0`,
        "-h",
      ],
    },

    // 6. chat pane (pane 2)
    {
      args: [
        "tmux",
        "send-keys",
        "-t",
        PANE_CHAT,
        "bun scripts/chat.ts",
        "Enter",
      ],
    },

    // 7. Split to create logs pane (pane 3) — scratch shell, no command
    {
      args: [
        "tmux",
        "split-window",
        "-t",
        `${SESSION_NAME}:0`,
        "-v",
      ],
    },

    // 8. Focus chat pane so user lands there
    {
      args: ["tmux", "select-pane", "-t", PANE_CHAT],
    },

    // 9. Attach — must be last
    {
      args: ["tmux", "attach-session", "-t", SESSION_NAME],
    },
  ];
}

// ---------------------------------------------------------------------------
// Default exec implementation using Bun.spawnSync
// ---------------------------------------------------------------------------

function defaultExec(cmd: TmuxCommand): ExecResult {
  const result = Bun.spawnSync(cmd.args, {
    env: {
      ...process.env,
      ...(cmd.env ?? {}),
    },
    stdout: "inherit",
    stderr: "pipe",
  });

  const stderr =
    result.stderr instanceof Uint8Array
      ? new TextDecoder().decode(result.stderr).trim()
      : undefined;

  return { exitCode: result.exitCode ?? 1, stderr };
}

// ---------------------------------------------------------------------------
// Preflight: check tmux is installed
// ---------------------------------------------------------------------------

function checkTmuxInstalled(): void {
  const result = Bun.spawnSync(["which", "tmux"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error(
      "tmux is not installed or not found in PATH.\n" +
        "Install tmux to use `task stack`.\n" +
        "For a tmux-less local dev experience, use: task dev",
    );
  }
}

// ---------------------------------------------------------------------------
// Preflight: run prisma migrate deploy (idempotent)
// ---------------------------------------------------------------------------

function runDbProvision(): void {
  console.log("[stack] running db:provision (prisma migrate deploy)...");
  const result = Bun.spawnSync(
    ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: "admin",
      env: {
        ...process.env,
        DATABASE_URL_AGENT: DEV_ENV.DATABASE_URL_AGENT,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error(
      `[stack] db:provision failed — prisma migrate deploy exited with code ${String(result.exitCode)}`,
    );
  }
  console.log("[stack] db:provision complete.");
}

// ---------------------------------------------------------------------------
// launchTmux — runs the command sequence (injected exec for testing)
// ---------------------------------------------------------------------------

/**
 * Execute the tmux command sequence built by buildTmuxCommands().
 *
 * @param execFn  Optional injected exec function (defaults to Bun.spawnSync).
 *                Injecting a fake fn allows unit tests to assert the exact
 *                command sequence without spawning a real tmux session.
 */
export async function launchTmux(execFn: ExecFn = defaultExec): Promise<void> {
  const cmds = buildTmuxCommands();

  for (const cmd of cmds) {
    let result: ExecResult;
    try {
      result = await execFn(cmd);
    } catch (err) {
      // exec fn threw — likely ENOENT (tmux not installed)
      const msg =
        err instanceof Error ? err.message : String(err);
      throw new Error(
        `tmux command failed: ${cmd.args.join(" ")}\n${msg}\n\nIs tmux installed? For a tmux-less local dev experience, use: task dev`,
      );
    }

    if (result.exitCode !== 0) {
      throw new Error(
        `tmux command exited with code ${result.exitCode}: ${cmd.args.join(" ")}\n${result.stderr ? result.stderr : ""}\n\nFor a tmux-less local dev experience, use: task dev`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    checkTmuxInstalled();
    runDbProvision();
    console.log("[stack] launching tmux session 'shipwright'...");
    await launchTmux();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n[stack] ERROR: ${msg}\n`);
    process.exit(1);
  }
}
