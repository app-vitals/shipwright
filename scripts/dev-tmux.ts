/**
 * scripts/dev-tmux.ts
 * `task stack` launcher — ties the full local dev stack together in a single
 * tmux session ("shipwright") with one window and 6 panes:
 *
 *   0. metrics    — metrics dashboard, offline SQLite mode             (:3460)
 *   1. admin      — standalone admin service (CRUD API + UI)           (:3001)
 *   2. task-store — task-store service (Postgres-backed task queue)    (:3002)
 *   3. agent      — thin Shipwright agent with the dev /chat endpoint  (:3000)
 *   4. chat       — the TUI chat REPL (scripts/chat.ts)
 *   5. logs       — a scratch shell pane
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

import { existsSync } from "node:fs";
import { connect } from "node:net";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_NAME = "shipwright";
export const WINDOW_INDEX = 0;
export const METRICS_PORT = 3460;
export const ADMIN_PORT = 3001;
export const TASK_STORE_PORT = 3002;
export const AGENT_PORT = 3000;
/** The metrics dashboard UI — a browser page (NOT a tmux pane). */
export const DASHBOARD_URL = `http://localhost:${METRICS_PORT}/dashboard`;
/** The admin dev-login page — auto-opened after stack launch. */
export const ADMIN_DEV_LOGIN_URL = `http://localhost:${ADMIN_PORT}/admin/dev-login`;

// Obviously-fake dev placeholders — safe for a public/MIT repo. These are NOT
// secrets: the agent runs against a local Postgres DB and a local offline
// metrics endpoint, so no real PostHog/encryption material is ever needed.
const DUMMY_POSTHOG_KEY = "phc_dev_dummy";
const DUMMY_ENCRYPTION_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";
// SHIPWRIGHT_INTERNAL_API_KEY removed in UNI-1.2 — runtime routes now use the same
// admin-key / per-agent-token / session-cookie auth as the CRUD routes.
// Agent API key for dev-agent. Must be registered in SHIPWRIGHT_ADMIN_API_KEYS on the
// admin pane so that runtime polling (config sync) succeeds at startup.
const DUMMY_AGENT_API_KEY = "dev-agent-key";
// Obviously-fake dev admin token for the task-store. Seeded (hashed) into the
// task-store DB by a preflight and handed to the admin pane verbatim so the admin
// console can read/manage tasks + PRs. NOT a secret — local DB only, public-safe.
// Bootstrap admin token seeded into the task-store on startup. Not a real
// secret — used only against the local dev Postgres instance.
export const DEV_TASK_STORE_ADMIN_TOKEN = "dev-task-store-admin-token";
// Session-cookie signing key (HS256). Must be non-empty — Web Crypto rejects a
// zero-length HMAC key with "DataError", which surfaces as a 500 on first login.
const DUMMY_SESSION_SECRET = "dev-session-secret-not-for-production-use!";
/** Docker image tag for the agent container. */
const DEV_DOCKER_IMAGE = "shipwright-agent-dev";
/** Named Docker volume that persists agent-home across container restarts. */
const DEV_AGENT_VOLUME = "shipwright-agent-home";
// Default the connection user to the current OS account. Homebrew's Postgres
// creates a superuser role named after the installing user, and Prisma — unlike
// libpq — does NOT auto-default the username, so an unqualified DSN authenticates
// as an empty role and fails with P1010. Qualifying it keeps the DSN portable
// across machines (whatever `whoami` is) without hardcoding a name.
const DEV_DB_USER = process.env.USER ?? "";
const DEV_DATABASE_URL = `postgresql://${
  DEV_DB_USER ? `${DEV_DB_USER}@` : ""
}localhost:5432/shipwright_dev`;
// The task-store service owns a dedicated database (its schema warns against a
// shared one). Same local Postgres server, distinct database name.
const DEV_TASK_STORE_DATABASE_URL = `postgresql://${
  DEV_DB_USER ? `${DEV_DB_USER}@` : ""
}localhost:5432/shipwright_task_store_dev`;
/** Homebrew formula `task stack` provisions Postgres from on macOS. */
const PG_FORMULA = "postgresql@16";
/**
 * Workspaces whose code the panes execute (metrics pane, agent pane → agent +
 * admin). If any lacks `node_modules`, deps were never installed for it — Bun
 * keeps per-workspace `node_modules`, so a workspace added after a prior
 * `bun install` (as `admin` was) silently has none, and the pane crashes on a
 * missing package. The preflight installs deps when any of these is missing.
 */
const STACK_WORKSPACE_DIRS = ["metrics", "agent", "admin", "task-store"];
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
  | "set-option"
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
export type ExecFn = (argv: string[]) => void;

export type BuildOpts = {
  session?: string;
  /**
   * Absolute path to the repo root, mounted read-only into the agent container
   * as /repo. Defaults to process.cwd() at runtime; injected in unit tests for
   * deterministic assertions (no I/O in the pure builder).
   */
  repoPath?: string;
};

// ---------------------------------------------------------------------------
// Pane definitions — the 6-pane stack
// ---------------------------------------------------------------------------

/**
 * The logs pane's command: print a signpost banner — where the UI and services
 * live (the dashboard is a browser page, not a pane) — then drop into an
 * interactive scratch shell. Returns one shell line for `tmux send-keys`.
 */
export function buildLogsBanner(): string {
  // The admin console (:3001) is the front door — it hosts the full nav
  // (Agents · Tasks · PRs · Metrics) and is what auto-opens. The metrics
  // dashboard is a separate service on its own port; each line is labeled with
  // what it serves so nobody guesses /admin/* on the metrics port (a 404).
  const lines = [
    "Shipwright dev stack",
    `  console (agents/tasks/PRs)  ${ADMIN_DEV_LOGIN_URL}   (opening in your browser)`,
    `  metrics dashboard           ${DASHBOARD_URL}`,
    `  task-store API              http://localhost:${TASK_STORE_PORT}`,
    `  agent (use the chat pane)   http://localhost:${AGENT_PORT}`,
    "  chat                        <- the pane to the left",
    "",
    "Scratch shell — run ad-hoc commands here.",
  ];
  const printf = `printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")}`;
  return `${printf}; exec "$SHELL"`;
}

export const STACK_PANES: Pane[] = [
  {
    label: "metrics",
    cmd: ["bun", "metrics/src/server.ts"],
    // SQLite persistence mode: no METRICS_OFFLINE, no POSTHOG_PROJECT_API_KEY,
    // no METRICS_DATABASE_URL → service defaults to sqlite mode.
    // METRICS_DASHBOARD_DEV_AUTH bypasses dashboard/login auth (there is no login
    // flow in the stack) while KEEPING the real sqlite provider — so the dashboard
    // shows the metrics the agent actually forwards, not fixtures.
    env: {
      METRICS_DB_PATH: "state/metrics.db",
      METRICS_DASHBOARD_DEV_AUTH: "true",
      // The admin console runs on a different origin (:3001) than the metrics
      // dashboard in the local stack, so the dashboard toolbar's Agents/Tasks/PRs
      // links must be absolute or they 404 on this origin. Production leaves this
      // unset → relative links (single-host ingress).
      METRICS_ADMIN_APP_URL: `http://localhost:${ADMIN_PORT}`,
    },
  },
  {
    label: "admin",
    cmd: ["bun", "admin/src/main.ts"],
    env: {
      PORT: String(ADMIN_PORT),
      DATABASE_URL_SHIPWRIGHT_ADMIN: DEV_DATABASE_URL,
      SHIPWRIGHT_ENCRYPTION_KEY: DUMMY_ENCRYPTION_KEY,
      SHIPWRIGHT_SESSION_SECRET: DUMMY_SESSION_SECRET,
      // Register the dev-agent API key so runtime polling (config sync) passes
      // auth. Format: "<agentId>:<apiKey>:<scope>" — scope "dev-agent" scopes it
      // to this agent; use "*" for an admin bypass key.
      SHIPWRIGHT_ADMIN_API_KEYS: `dev-agent:${DUMMY_AGENT_API_KEY}:dev-agent`,
      ADMIN_DEV_AUTH: "true",
      // Point the admin toolbar's "Metrics" link at the running metrics
      // dashboard (:3460). Without this it uses the same-host relative /dashboard,
      // which in dev points to :3001 instead of the metrics service on :3460.
      METRICS_DASHBOARD_URL: `http://localhost:${METRICS_PORT}/dashboard`,
      // Wire the admin console to the task-store service so the Tasks/PRs pages
      // show live data instead of the "Task store unavailable" degraded banner.
      // The admin builds its task-store client only when BOTH of these are set;
      // the token is seeded (hashed) into the task-store DB by a preflight. The
      // inline pane prefix overrides any empty SHIPWRIGHT_TASK_STORE_URL the login
      // shell may export.
      SHIPWRIGHT_TASK_STORE_URL: `http://localhost:${TASK_STORE_PORT}`,
      SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: DEV_TASK_STORE_ADMIN_TOKEN,
    },
  },
  {
    label: "task-store",
    cmd: ["bun", "run", "task-store/src/main.ts"],
    env: {
      PORT: String(TASK_STORE_PORT),
      // Dedicated database for the task-store service — its Prisma schema reads
      // DATABASE_URL_SHIPWRIGHT_TASK_STORE. Shares the local Postgres server with
      // the admin service but a distinct database, per the schema's warning.
      DATABASE_URL_SHIPWRIGHT_TASK_STORE: DEV_TASK_STORE_DATABASE_URL,
      // Seed a bootstrap admin token on startup so the admin pane can reach the
      // task-store API without manual token provisioning.
      TASK_STORE_SEED_ADMIN_TOKEN: DEV_TASK_STORE_ADMIN_TOKEN,
    },
  },
  {
    label: "agent",
    // All env is passed via -e flags inside cmd; pane env stays empty so
    // paneShellLine() emits no inline prefix — docker manages its own env.
    // Secrets (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY) come from the
    // developer's local state/dev-agent.env — see state/dev-agent.env.example.
    cmd: [
      "docker",
      "run",
      "--rm",
      "--name",
      DEV_DOCKER_IMAGE,
      "-p",
      `${AGENT_PORT}:${AGENT_PORT}`,
      "-v",
      `${DEV_AGENT_VOLUME}:/data/agent-home`,
      // Repo is mounted read-only at build time; the exact host path is
      // substituted in buildStackCommands (repoPath opt, default process.cwd()).
      // Placeholder replaced in buildStackCommands — see note there.
      "__REPO_VOLUME_PLACEHOLDER__",
      "--add-host=host.docker.internal:host-gateway",
      "--env-file",
      "state/dev-agent.env",
      "-e",
      "SHIPWRIGHT_DEV_CHAT=true",
      "-e",
      `SHIPWRIGHT_API_URL=http://host.docker.internal:${ADMIN_PORT}`,
      "-e",
      `POSTHOG_HOST=http://host.docker.internal:${METRICS_PORT}`,
      "-e",
      `POSTHOG_PROJECT_API_KEY=${DUMMY_POSTHOG_KEY}`,
      "-e",
      "SHIPWRIGHT_AGENT_ID=dev-agent",
      "-e",
      `SHIPWRIGHT_AGENT_API_KEY=${DUMMY_AGENT_API_KEY}`,
      "-e",
      `PORT=${AGENT_PORT}`,
      DEV_DOCKER_IMAGE,
    ],
    env: {},
  },
  {
    label: "chat",
    cmd: ["bun", "scripts/chat.ts"],
  },
  {
    label: "logs",
    // Signpost banner (URLs) then a scratch shell for ad-hoc commands.
    cmd: [buildLogsBanner()],
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
 *   3. migration preflight BEFORE the admin pane's command is sent
 *   4. seed + docker build preflights BEFORE the agent pane's command is sent
 *   5. send-keys per pane to run its command with inline env
 *
 * Pure: no I/O. runStack() drives the injected exec over this list.
 *
 * The `repoPath` option allows unit tests to inject a deterministic path
 * instead of calling process.cwd() (which would be I/O in a pure builder).
 * The entrypoint passes `process.cwd()` explicitly.
 */
export function buildStackCommands(
  panes: Pane[],
  opts: BuildOpts = {},
): TmuxCommand[] {
  if (panes.length === 0) {
    throw new Error("buildStackCommands: at least one pane is required");
  }
  const session = opts.session ?? SESSION_NAME;
  const repoPath = opts.repoPath ?? process.cwd();
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

  // 1b. Enable mouse mode — drag pane borders to resize, click to focus,
  // scroll wheel to scroll. Scoped to THIS session (`-t`), so it does not
  // touch the user's global tmux config or other sessions.
  cmds.push({
    kind: "set-option",
    argv: ["set-option", "-t", session, "mouse", "on"],
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

  // 2b. Label every pane with its service name via a titled top border.
  // pane-border-status/format are WINDOW options (set once with `-w`); each
  // pane's title comes from its `label`. Scoped to THIS session via `-t`, so
  // the user's global tmux config is untouched. The final chat-focus
  // select-pane below runs after these, so it still wins the active pane.
  cmds.push({
    kind: "set-option",
    argv: ["set-option", "-w", "-t", session, "pane-border-status", "top"],
  });
  cmds.push({
    kind: "set-option",
    argv: [
      "set-option",
      "-w",
      "-t",
      session,
      "pane-border-format",
      " #{pane_title} ",
    ],
  });
  panes.forEach((pane, i) => {
    cmds.push({
      kind: "select-pane",
      argv: ["select-pane", "-t", paneTarget(session, i), "-T", pane.label],
    });
  });

  const adminIndex = panes.findIndex((p) => p.label === "admin");
  const taskStoreIndex = panes.findIndex((p) => p.label === "task-store");
  const agentIndex = panes.findIndex((p) => p.label === "agent");

  // 3+4+5. For each pane, send its command.
  //   - Before the admin pane: prisma generate + migrate deploy preflight.
  //   - Before the agent pane: seed-dev-agent + docker build preflights.
  panes.forEach((pane, i) => {
    if (i === adminIndex) {
      // Preflight: generate the Prisma client then apply migrations so the
      // admin service's Postgres schema is up to date before it starts.
      cmds.push({
        kind: "preflight",
        argv: [
          "sh",
          "-c",
          `cd admin && bunx prisma generate --schema=prisma/schema.prisma && DATABASE_URL_SHIPWRIGHT_ADMIN=${DEV_DATABASE_URL} bunx prisma migrate deploy --schema=prisma/schema.prisma`,
        ],
      });
    }
    if (i === taskStoreIndex) {
      // Preflight: generate the task-store Prisma client then apply migrations
      // against its dedicated database, so the service's schema is up to date
      // before it starts. Mirrors the admin preflight, scoped to task-store.
      cmds.push({
        kind: "preflight",
        argv: [
          "sh",
          "-c",
          `cd task-store && bunx prisma generate --schema=prisma/schema.prisma && DATABASE_URL_SHIPWRIGHT_TASK_STORE=${DEV_TASK_STORE_DATABASE_URL} bunx prisma migrate deploy --schema=prisma/schema.prisma`,
        ],
      });
      // Preflight: seed the admin token the admin console uses to read the
      // task-store. Idempotent upsert (no-op if it already exists). Runs after the
      // migrate-deploy above so the TaskToken table exists.
      cmds.push({
        kind: "preflight",
        argv: [
          "sh",
          "-c",
          `bun run scripts/seed-task-store-token.ts --db-url ${DEV_TASK_STORE_DATABASE_URL} --token ${DEV_TASK_STORE_ADMIN_TOKEN}`,
        ],
      });
    }
    if (i === agentIndex) {
      // Preflight: seed the dev agent record (upsert agent + env + plugin + tools).
      cmds.push({
        kind: "preflight",
        argv: [
          "sh",
          "-c",
          `bun run scripts/seed-dev-agent.ts --db-url ${DEV_DATABASE_URL}`,
        ],
      });
      // Preflight: remove any leftover agent container from a prior session so
      // the `docker run --name` below cannot collide. A stack torn down with
      // `tmux kill-session` (instead of `task stack:down`) leaves the container
      // running; without this, the next `task stack` fails its `docker run` with
      // "name already in use" and silently keeps talking to the stale container.
      // `-f` is a no-op when nothing is there, so this is safe on a clean machine.
      cmds.push({
        kind: "preflight",
        argv: ["sh", "-c", `docker rm -f ${DEV_DOCKER_IMAGE} 2>/dev/null || true`],
      });
      // Preflight: build the Docker image that the agent pane will run.
      cmds.push({
        kind: "preflight",
        argv: [
          "sh",
          "-c",
          `docker build -t ${DEV_DOCKER_IMAGE} -f agent/Dockerfile .`,
        ],
      });
    }

    // Resolve the repo-volume placeholder in the agent pane's docker run cmd.
    const resolvedPane: Pane =
      pane.label === "agent"
        ? {
            ...pane,
            cmd: pane.cmd.map((token) =>
              token === "__REPO_VOLUME_PLACEHOLDER__"
                ? `-v ${repoPath}:/repo:ro`
                : token,
            ),
          }
        : pane;

    cmds.push({
      kind: "send-keys",
      argv: [
        "send-keys",
        "-t",
        paneTarget(session, i),
        paneShellLine(resolvedPane),
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
  "[stack] tmux is not installed — `task stack` needs it for the 5-pane dashboard.",
  "[stack] Install tmux (macOS: `brew install tmux`, Debian/Ubuntu: `apt install tmux`),",
  "[stack] or use the no-tmux fallback: `task dev` (starts the metrics dashboard).",
].join("\n");

/**
 * True if a tmux session of the given name already exists. `new-session` is not
 * idempotent — it errors with "duplicate session" — so the entrypoint checks
 * this first and fails fast rather than aborting mid-build. The `has-session`
 * probe is injectable so the predicate is unit-testable without real tmux.
 */
export function sessionExists(
  name: string,
  hasSession: (name: string) => number = (n) =>
    Bun.spawnSync(["tmux", "has-session", "-t", n], {
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode ?? 1,
): boolean {
  return hasSession(name) === 0;
}

/** Guidance shown when a same-named session is already running. */
export function sessionExistsMessage(name: string): string {
  return [
    `[stack] session '${name}' already running — not rebuilding it.`,
    `[stack]   attach: tmux attach -t ${name}`,
    `[stack]   reset:  tmux kill-session -t ${name}  (or: task stack:down, then re-run task stack)`,
  ].join("\n");
}

/**
 * Teardown commands for `task stack:down`: kill the tmux session, then stop and
 * remove the agent Docker container. The container is started by `docker run`
 * inside a pane, so killing the tmux session orphans it — the daemon keeps it
 * running. This explicitly removes it. Pure (returns argv lists); runTeardown()
 * drives the injected exec. Reuses SESSION_NAME / DEV_DOCKER_IMAGE so the names
 * never drift from the launch side.
 */
export function buildTeardownCommands(
  session: string = SESSION_NAME,
  container: string = DEV_DOCKER_IMAGE,
): string[][] {
  return [
    ["tmux", "kill-session", "-t", session],
    ["docker", "rm", "-f", container],
  ];
}

/**
 * Runs each teardown command via the injected exec. Best-effort: a non-zero
 * exit just means that resource was already gone, so `stack:down` is safe to
 * run when nothing is up. Returns one result per command for logging.
 */
export function runTeardown(
  commands: string[][],
  exec: (argv: string[]) => number,
): Array<{ argv: string[]; ok: boolean }> {
  return commands.map((argv) => ({ argv, ok: exec(argv) === 0 }));
}

/**
 * True if a TCP connection to the database host:port succeeds. The agent pane's
 * migrate-deploy preflight needs a live Postgres; without this probe its failure
 * surfaces as an opaque Prisma `P1001` mid-launch. A cheap connect() up front
 * distinguishes "server not running" cleanly. The probe is injectable so the
 * predicate is unit-testable without a real socket.
 */
export async function dbReachable(
  databaseUrl: string,
  probe: (host: string, port: number) => Promise<boolean> = tcpProbe,
): Promise<boolean> {
  const { hostname, port } = new URL(databaseUrl);
  return probe(hostname || "localhost", Number(port) || 5432);
}

/** Opens a short-lived TCP connection; resolves true on connect, false otherwise. */
function tcpProbe(
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Of the given workspace dirs, return those missing `node_modules` (deps never
 * installed). Pure — the existence check is injected — so it is unit-testable
 * without touching the filesystem.
 */
export function missingWorkspaceDeps(
  dirs: string[],
  hasNodeModules: (dir: string) => boolean,
): string[] {
  return dirs.filter((dir) => !hasNodeModules(dir));
}

/** True if a Homebrew formula is installed. Injectable for unit tests. */
export function brewFormulaInstalled(
  formula: string,
  run: (argv: string[]) => number = (argv) =>
    Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" }).exitCode ?? 1,
): boolean {
  return run(["brew", "list", "--formula", formula]) === 0;
}

/** One provisioning command shown to the user and (on yes) executed. */
export interface SetupStep {
  /** Human-readable command shown before the y/N prompt. */
  display: string;
  /** argv executed to perform the step. */
  argv: string[];
}

export interface PostgresPlan {
  /** True if the server already accepts connections (no bring-up needed). */
  serverReady: boolean;
  /** Ordered server bring-up commands (install/start) — empty when ready. */
  steps: SetupStep[];
  /** Multi-line message printed before the "Run these now? [y/N]" prompt. */
  instructions: string;
}

/**
 * Decide what (if anything) must run to get Postgres ready, and render the exact
 * commands for the user. Pure — reachability + formula presence are passed in —
 * so the branching is unit-tested without touching real brew/sockets. The
 * database itself is created separately (idempotently) once the server is up,
 * so it is shown in the instructions but not returned as a bring-up step.
 */
export function planPostgresSetup(opts: {
  databaseUrl: string;
  reachable: boolean;
  formulaInstalled: boolean;
  formula?: string;
}): PostgresPlan {
  const {
    databaseUrl,
    reachable,
    formulaInstalled,
    formula = PG_FORMULA,
  } = opts;
  const { hostname, port, pathname } = new URL(databaseUrl);
  const host = hostname || "localhost";
  const p = port || "5432";
  const dbName = pathname.replace(/^\//, "") || "shipwright_dev";

  const steps: SetupStep[] = [];
  if (!reachable && !formulaInstalled) {
    steps.push({
      display: `brew install ${formula}`,
      argv: ["sh", "-c", `brew install ${formula}`],
    });
  }
  if (!reachable) {
    steps.push({
      display: `brew services start ${formula}`,
      argv: ["sh", "-c", `brew services start ${formula}`],
    });
  }

  const instructions = [
    reachable
      ? `[stack] Postgres is up at ${host}:${p}, but database '${dbName}' is missing.`
      : `[stack] Postgres is not running at ${host}:${p} — the agent pane needs it.`,
    "[stack] To get it ready (macOS / Homebrew), this will run:",
    ...steps.map((s) => `[stack]   ${s.display}`),
    `[stack]   createdb ${dbName}`,
  ].join("\n");

  return { serverReady: reachable, steps, instructions };
}

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

/**
 * Ensure stack workspace deps are installed. Bun install is fast, safe and
 * idempotent, so a missing workspace is auto-installed without a prompt (unlike
 * installing Postgres, which has system-level side effects). Runs from the repo
 * root — the same cwd the pane commands' relative paths assume.
 */
function ensureDepsInstalled(): void {
  const missing = missingWorkspaceDeps(STACK_WORKSPACE_DIRS, (dir) =>
    existsSync(`${dir}/node_modules`),
  );
  if (missing.length === 0) return;
  console.log(
    `[stack] dependencies missing (${missing.join(", ")}) — running bun install…`,
  );
  const proc = Bun.spawnSync(["bun", "install"], {
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    console.error("[stack] bun install failed — run `task setup`, then retry.");
    process.exit(1);
  }
}

/**
 * Surface the admin dev-login page: once the admin service is listening, open
 * it in the default browser (macOS `open`). Auto-opening removes the
 * "where's the UI?" guesswork. Best-effort: if admin is slow to boot, print
 * the URL instead of failing the launch.
 */
async function openDashboardWhenReady(): Promise<void> {
  const base = `http://localhost:${ADMIN_PORT}`;
  if (!(await waitForReachable(base, 10_000))) {
    console.error(
      `[stack] admin slow to start — open ${ADMIN_DEV_LOGIN_URL} once it's up.`,
    );
    return;
  }
  Bun.spawn(["open", ADMIN_DEV_LOGIN_URL], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

/** Blocking y/N prompt. Empty/EOF/anything-but-yes ⇒ false (safe default). */
function askYesNo(question: string): boolean {
  const answer = (prompt(question) ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** Poll until the DB accepts connections or the timeout elapses. */
async function waitForReachable(
  databaseUrl: string,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await dbReachable(databaseUrl)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return dbReachable(databaseUrl);
}

/** Create the database if missing. Idempotent: a non-zero exit (already exists) is ignored. */
function ensureDatabaseExists(databaseUrl: string): void {
  const { hostname, port, pathname } = new URL(databaseUrl);
  const db = pathname.replace(/^\//, "") || "shipwright_dev";
  Bun.spawnSync(
    ["createdb", "-h", hostname || "localhost", "-p", port || "5432", db],
    { env: process.env, stdout: "ignore", stderr: "ignore" },
  );
}

/**
 * Ensure Postgres is ready: probe, and if it isn't, show the exact commands and
 * offer to run them (y/N). On yes, run them and wait for the server; on no, exit
 * with the commands left on screen so nothing has to be guessed. Always ensures
 * the database exists once the server is reachable.
 */
async function ensurePostgresReady(databaseUrl: string): Promise<void> {
  if (!(await dbReachable(databaseUrl))) {
    const plan = planPostgresSetup({
      databaseUrl,
      reachable: false,
      formulaInstalled: brewFormulaInstalled(PG_FORMULA),
    });
    console.error(plan.instructions);
    if (!askYesNo("[stack] Run these now? [y/N] ")) {
      console.error(
        "[stack] Aborted — run the commands above, then: task stack",
      );
      process.exit(1);
    }
    for (const step of plan.steps) {
      console.log(`[stack] $ ${step.display}`);
      try {
        realExec(step.argv);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    }
    console.log("[stack] waiting for Postgres to accept connections…");
    if (!(await waitForReachable(databaseUrl, 20_000))) {
      console.error(
        "[stack] Postgres still unreachable after start. Check: brew services list",
      );
      process.exit(1);
    }
  }
  // Server is up — make sure the database exists (idempotent, quiet).
  ensureDatabaseExists(databaseUrl);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  // `task stack:down` — tear down the session AND remove the orphaned agent
  // container. Runs before any tmux/postgres checks so it works even when the
  // session is half-gone. Best-effort: argv arrays, no shell (no injection).
  if (Bun.argv.includes("--down")) {
    const exec = (argv: string[]): number =>
      Bun.spawnSync(argv, { stdout: "ignore", stderr: "ignore" }).exitCode ?? 1;
    for (const { argv, ok } of runTeardown(buildTeardownCommands(), exec)) {
      console.log(
        `[stack:down] ${argv.join(" ")} ${ok ? "✓" : "(nothing to do)"}`,
      );
    }
    console.log("[stack:down] dev stack stopped.");
    process.exit(0);
  }

  if (!tmuxIsInstalled()) {
    console.error(NO_TMUX_MESSAGE);
    process.exit(1);
  }

  if (sessionExists(SESSION_NAME)) {
    console.error(sessionExistsMessage(SESSION_NAME));
    process.exit(1);
  }

  if (!existsSync("state/dev-agent.env")) {
    console.error(
      "[stack] state/dev-agent.env not found — copy state/dev-agent.env.example and fill in CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
    );
    process.exit(1);
  }

  ensureDepsInstalled();
  await ensurePostgresReady(DEV_DATABASE_URL);

  console.log(
    `[stack] launching tmux session "${SESSION_NAME}" — metrics :${METRICS_PORT}, admin :${ADMIN_PORT}, task-store :${TASK_STORE_PORT}, agent :${AGENT_PORT}, chat REPL, logs`,
  );
  try {
    runStack(STACK_PANES, realExec, { repoPath: process.cwd() });
  } catch (err) {
    console.error(`[stack] failed to launch: ${(err as Error).message}`);
    process.exit(1);
  }

  // Surface the dashboard UI (a browser page, not a pane) before we hand the
  // terminal over to tmux attach (which blocks).
  await openDashboardWhenReady();

  // Attach the user to the freshly-built session.
  const attach = Bun.spawnSync(["tmux", "attach-session", "-t", SESSION_NAME], {
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  process.exit(attach.exitCode ?? 0);
}
