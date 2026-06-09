/**
 * scripts/dev-tmux.ts
 * `task stack` launcher — ties the full local dev stack together in a single
 * tmux session ("shipwright") with one window and 4 panes:
 *
 *   0. metrics — metrics dashboard, offline SQLite mode            (:3460)
 *   1. agent   — Shipwright agent with the dev /chat endpoint       (:3000)
 *   2. chat    — the TUI chat REPL (scripts/chat.ts)
 *   3. logs    — a scratch shell pane
 *
 * `task dev` is deliberately left untouched — it is the no-tmux fallback that
 * the quickstart depends on. This launcher is additive.
 *
 * Architecture (mirrors scripts/dev.ts injected-spawn pattern):
 *   buildStackCommands(panes, opts) is a PURE builder — it assembles the
 *   ordered list of tmux invocations (new-session, split-window, send-keys per
 *   pane) plus a migration preflight. runStack(panes, exec) drives an INJECTED
 *   exec over that list, so a unit test can inject a fake exec and assert the
 *   exact command sequence + per-pane env without spawning real tmux.
 *
 *   The thin `if (import.meta.main)` entrypoint wires the real exec
 *   (Bun.spawnSync) and the tmux-absent check (clear pointer to `task dev`).
 *
 * Why no real-tmux spawn test: the only behavior beyond the builder is
 * I/O-bound (tmux presence + the OS running the argv). That seam is the
 * injected `exec`, fully covered by dev-tmux.unit.test.ts; a real-tmux E2E
 * would be slow and environment-dependent for no added confidence.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_NAME = "shipwright";
export const WINDOW_INDEX = 0;
export const METRICS_PORT = 3460;
export const AGENT_PORT = 3000;

// Obviously-fake dev placeholders — safe for a public/MIT repo. These are NOT
// secrets: the agent runs against a local SQLite DB and a local offline
// metrics endpoint, so no real PostHog/encryption material is ever needed.
const DUMMY_POSTHOG_KEY = "phc_dev_dummy";
const DUMMY_ENCRYPTION_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";
const DEV_DATABASE_URL_AGENT = "file:./admin/dev.db";
const DEV_AGENT_HOME = "state/agent-home";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Pane = {
  /** Short label for the pane (and tmux pane title). */
  label: string;
  /** The shell command run in the pane, as argv tokens. */
  cmd: string[];
  /** Per-pane environment, exported inline before the command runs. */
  env?: Record<string, string>;
};

/** Kinds of emitted commands, for ordering assertions and clarity. */
export type TmuxCommandKind =
  | "new-session"
  | "split-window"
  | "preflight"
  | "send-keys"
  | "select-pane";

export type TmuxCommand = {
  kind: TmuxCommandKind;
  /** argv passed to `tmux` (for tmux commands) or to the shell (preflight). */
  argv: string[];
};

/** A function that runs a single built command. Injected for testability. */
export type ExecFn = (argv: string[], env?: Record<string, string>) => void;

export type BuildOpts = {
  session?: string;
};

// ---------------------------------------------------------------------------
// Pane definitions — the 4-pane stack
// ---------------------------------------------------------------------------

export const STACK_PANES: Pane[] = [
  {
    label: "metrics",
    cmd: ["bun", "metrics/src/server.ts"],
    env: { METRICS_OFFLINE: "true" },
  },
  {
    label: "agent",
    cmd: ["bun", "agent/src/run-agent.ts"],
    env: {
      SHIPWRIGHT_DEV_CHAT: "true",
      POSTHOG_HOST: `http://localhost:${METRICS_PORT}`,
      POSTHOG_PROJECT_API_KEY: DUMMY_POSTHOG_KEY,
      DATABASE_URL_AGENT: DEV_DATABASE_URL_AGENT,
      SHIPWRIGHT_ENCRYPTION_KEY: DUMMY_ENCRYPTION_KEY,
      AGENT_HOME: DEV_AGENT_HOME,
    },
  },
  {
    label: "chat",
    cmd: ["bun", "scripts/chat.ts"],
  },
  {
    label: "logs",
    // Scratch shell — interactive prompt for ad-hoc commands / tailing logs.
    cmd: ["$SHELL"],
  },
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Render a pane's env + command into a single shell line suitable for
 * `tmux send-keys`. Env is exported inline so it applies only to this pane.
 * Defensive: skips undefined/empty env keys.
 */
export function paneShellLine(pane: Pane): string {
  const envPrefix = Object.entries(pane.env ?? {})
    .filter(([k, v]) => k && v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const cmd = pane.cmd.join(" ");
  return envPrefix ? `${envPrefix} ${cmd}` : cmd;
}

/** tmux pane target like `shipwright:0.2`. */
function paneTarget(session: string, paneIndex: number): string {
  return `${session}:${WINDOW_INDEX}.${paneIndex}`;
}

// ---------------------------------------------------------------------------
// Pure builder — assembles the ordered tmux command sequence
// ---------------------------------------------------------------------------

/**
 * Build the ordered list of commands that stand up the stack:
 *   1. new-session (detached) hosting pane 0
 *   2. one split-window per remaining pane (single window, tiled)
 *   3. a migration preflight BEFORE the agent pane's command is sent
 *   4. send-keys per pane to run its command with inline env
 *
 * Pure: no I/O. runStack() drives the injected exec over this list.
 */
export function buildStackCommands(
  panes: Pane[],
  opts: BuildOpts = {},
): TmuxCommand[] {
  if (panes.length === 0) {
    throw new Error("buildStackCommands: at least one pane is required");
  }
  const session = opts.session ?? SESSION_NAME;
  const cmds: TmuxCommand[] = [];

  // 1. Create the session (detached) with pane 0.
  cmds.push({
    kind: "new-session",
    argv: [
      "new-session",
      "-d",
      "-s",
      session,
      "-n",
      "stack",
      "-x",
      "220",
      "-y",
      "50",
    ],
  });

  // 2. Split off one pane per remaining pane, then tile evenly.
  for (let i = 1; i < panes.length; i++) {
    cmds.push({
      kind: "split-window",
      argv: ["split-window", "-t", paneTarget(session, 0)],
    });
  }
  cmds.push({
    kind: "select-pane",
    argv: ["select-layout", "-t", `${session}:${WINDOW_INDEX}`, "tiled"],
  });

  const agentIndex = panes.findIndex((p) => p.label === "agent");

  // 3+4. For each pane, send its command. Before the agent pane, run the
  // migration preflight so the agent's SQLite DB exists.
  panes.forEach((pane, i) => {
    if (i === agentIndex) {
      cmds.push({
        kind: "preflight",
        argv: [
          "sh",
          "-c",
          `cd admin && DATABASE_URL_AGENT=${DEV_DATABASE_URL_AGENT} bunx prisma migrate deploy --schema=prisma/schema.prisma`,
        ],
      });
    }
    cmds.push({
      kind: "send-keys",
      argv: [
        "send-keys",
        "-t",
        paneTarget(session, i),
        paneShellLine(pane),
        "Enter",
      ],
    });
  });

  // Focus the chat pane so the user lands on the REPL.
  const chatIndex = panes.findIndex((p) => p.label === "chat");
  if (chatIndex >= 0) {
    cmds.push({
      kind: "select-pane",
      argv: ["select-pane", "-t", paneTarget(session, chatIndex)],
    });
  }

  return cmds;
}

// ---------------------------------------------------------------------------
// Driver — runs the built commands through an injected exec
// ---------------------------------------------------------------------------

/**
 * Drive the built command sequence through the injected exec. The preflight is
 * run as a shell command; everything else is a `tmux` invocation. Returns the
 * built list so callers/tests can introspect what ran.
 */
export function runStack(
  panes: Pane[],
  exec: ExecFn,
  opts: BuildOpts = {},
): TmuxCommand[] {
  const cmds = buildStackCommands(panes, opts);
  for (const cmd of cmds) {
    exec(cmd.argv);
  }
  return cmds;
}

// ---------------------------------------------------------------------------
// Real exec (I/O) — used only by the entrypoint
// ---------------------------------------------------------------------------

/** True if the `tmux` binary is on PATH. */
export function tmuxIsInstalled(
  which: (bin: string) => string | null = (bin) => Bun.which(bin),
): boolean {
  return which("tmux") !== null;
}

const NO_TMUX_MESSAGE = [
  "[stack] tmux is not installed — `task stack` needs it for the 4-pane dashboard.",
  "[stack] Install tmux (macOS: `brew install tmux`, Debian/Ubuntu: `apt install tmux`),",
  "[stack] or use the no-tmux fallback: `task dev` (starts the metrics dashboard).",
].join("\n");

function realExec(argv: string[]): void {
  const [bin, ...rest] = argv;
  // The preflight is a plain shell command; tmux subcommands go to `tmux`.
  const isShell = bin === "sh";
  const proc = Bun.spawnSync(isShell ? argv : ["tmux", ...argv], {
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `[stack] command failed (exit ${proc.exitCode}): ${(isShell ? argv : ["tmux", ...rest]).join(" ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  if (!tmuxIsInstalled()) {
    console.error(NO_TMUX_MESSAGE);
    process.exit(1);
  }

  console.log(
    `[stack] launching tmux session "${SESSION_NAME}" — metrics :${METRICS_PORT}, agent :${AGENT_PORT}, chat REPL, logs`,
  );
  try {
    runStack(STACK_PANES, realExec);
  } catch (err) {
    console.error(`[stack] failed to launch: ${(err as Error).message}`);
    process.exit(1);
  }

  // Attach the user to the freshly-built session.
  const attach = Bun.spawnSync(["tmux", "attach-session", "-t", SESSION_NAME], {
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(attach.exitCode ?? 0);
}
