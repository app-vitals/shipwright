/**
 * scripts/hitl.ts
 * Human-in-the-loop dev runner — provisions a workspace (mirroring agent
 * setup.ts), boots task-store + admin, then loops: fetch the next ready
 * task → launch Claude Code with the right command.
 *
 * Usage:
 *   task hitl
 *   bun /path/to/shipwright/scripts/hitl.ts
 *
 * Workspace layout (mirrors ensureAgentHome):
 *   ~/.shipwright/
 *     workspace/          ← Claude Code's cwd
 *       repos/            ← SHIPWRIGHT_REPO_DIR (git clones, main branch)
 *       worktrees/        ← SHIPWRIGHT_WORKTREE_DIR (feature branches)
 *       state/reviews/
 *       .claude/
 *
 * Env overrides:
 *   SHIPWRIGHT_HITL_HOME          — root dir (default: ~/.shipwright)
 *   SHIPWRIGHT_HITL_HOST          — hostname for service URLs (default: "shipwright.test")
 *   SHIPWRIGHT_HITL_POLL_INTERVAL — seconds between empty-queue polls (default: 15)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Paths — anchored to this script, not cwd
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..");
const HITL_HOME =
  process.env.SHIPWRIGHT_HITL_HOME ?? join(homedir(), ".shipwright");
const WORKSPACE = join(HITL_HOME, "workspace");
const REPOS_DIR = join(WORKSPACE, "repos");
const WORKTREES_DIR = join(WORKSPACE, "worktrees");

// ---------------------------------------------------------------------------
// Constants — mirrors dev-tmux.ts defaults; no env vars required
// ---------------------------------------------------------------------------

const TASK_STORE_PORT = 3002;
const ADMIN_PORT = 3001;
const HOST = process.env.SHIPWRIGHT_HITL_HOST ?? "shipwright.test";
const TASK_STORE_URL = `http://${HOST}:${TASK_STORE_PORT}`;
const ADMIN_URL = `http://${HOST}:${ADMIN_PORT}`;
const DEV_TOKEN = "dev-task-store-admin-token";
const DEV_AGENT_TOKEN = "dev-task-store-hitl-token";
const POLL_INTERVAL_S = Number(
  process.env.SHIPWRIGHT_HITL_POLL_INTERVAL ?? "15",
);

const DEV_DB_USER = process.env.USER ?? "";
const DEV_DB_PREFIX = DEV_DB_USER ? `${DEV_DB_USER}@` : "";
const DEV_DATABASE_URL = `postgresql://${DEV_DB_PREFIX}localhost:5432/shipwright_dev`;
const DEV_TASK_STORE_DATABASE_URL = `postgresql://${DEV_DB_PREFIX}localhost:5432/shipwright_task_store_dev`;

const DUMMY_ENCRYPTION_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";
const DUMMY_SESSION_SECRET = "dev-session-secret-not-for-production-use!";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string) {
  console.log(`[hitl] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) {
        log(`${label} healthy`);
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`${label} did not become healthy within 30s`);
}

// ---------------------------------------------------------------------------
// Workspace provisioning — mirrors agent/src/setup.ts ensureAgentHome()
// ---------------------------------------------------------------------------

const HITL_TEMPLATE = join(
  REPO_ROOT,
  "agent",
  "workspace",
  "CLAUDE-HITL.md.template",
);

function provisionWorkspace(): void {
  const dirs = [
    WORKSPACE,
    REPOS_DIR,
    WORKTREES_DIR,
    join(WORKSPACE, "state", "reviews"),
    join(WORKSPACE, ".claude"),
  ];

  let created = false;
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created = true;
    }
  }

  const claudeMd = join(WORKSPACE, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    const template = readFileSync(HITL_TEMPLATE, "utf8");
    writeFileSync(claudeMd, template, { flag: "wx" });
    log("seeded CLAUDE.md");
  }

  if (created) {
    log(`workspace provisioned: ${WORKSPACE}`);
  }
}

// ---------------------------------------------------------------------------
// Preflight: workspace + migrations + token seed
// ---------------------------------------------------------------------------

async function runPreflight(): Promise<void> {
  provisionWorkspace();

  log("running task-store prisma generate + migrate...");
  const tsGen = Bun.spawnSync(
    ["bunx", "prisma", "generate", "--schema=prisma/schema.prisma"],
    { cwd: join(REPO_ROOT, "task-store"), stdout: "inherit", stderr: "inherit" },
  );
  if (tsGen.exitCode !== 0) throw new Error("task-store prisma generate failed");

  const tsMigrate = Bun.spawnSync(
    ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: join(REPO_ROOT, "task-store"),
      env: {
        ...process.env,
        DATABASE_URL_SHIPWRIGHT_TASK_STORE: DEV_TASK_STORE_DATABASE_URL,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (tsMigrate.exitCode !== 0) throw new Error("task-store migrate failed");

  log("seeding task-store admin and agent tokens...");
  const adminSeed = Bun.spawnSync(
    [
      "bun",
      "run",
      join(REPO_ROOT, "scripts", "seed-task-store-token.ts"),
      "--db-url",
      DEV_TASK_STORE_DATABASE_URL,
      "--token",
      DEV_TOKEN,
    ],
    { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (adminSeed.exitCode !== 0) throw new Error("admin token seed failed");

  const agentSeed = Bun.spawnSync(
    [
      "bun",
      "run",
      join(REPO_ROOT, "scripts", "seed-task-store-token.ts"),
      "--db-url",
      DEV_TASK_STORE_DATABASE_URL,
      "--token",
      DEV_AGENT_TOKEN,
      "--agent-id",
      "hitl",
    ],
    { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (agentSeed.exitCode !== 0) throw new Error("agent token seed failed");

  log("running admin prisma generate + migrate...");
  const adminGen = Bun.spawnSync(
    ["bunx", "prisma", "generate", "--schema=prisma/schema.prisma"],
    { cwd: join(REPO_ROOT, "admin"), stdout: "inherit", stderr: "inherit" },
  );
  if (adminGen.exitCode !== 0) throw new Error("admin prisma generate failed");

  const adminMigrate = Bun.spawnSync(
    ["bunx", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    {
      cwd: join(REPO_ROOT, "admin"),
      env: {
        ...process.env,
        DATABASE_URL_SHIPWRIGHT_ADMIN: DEV_DATABASE_URL,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (adminMigrate.exitCode !== 0) throw new Error("admin migrate failed");
}

// ---------------------------------------------------------------------------
// Service spawning
// ---------------------------------------------------------------------------

type ServiceHandle = {
  label: string;
  proc: ReturnType<typeof Bun.spawn>;
};

function startServices(): ServiceHandle[] {
  const taskStore = Bun.spawn(
    ["bun", "run", join(REPO_ROOT, "task-store", "src", "main.ts")],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(TASK_STORE_PORT),
        DATABASE_URL_SHIPWRIGHT_TASK_STORE: DEV_TASK_STORE_DATABASE_URL,
        TASK_STORE_SEED_ADMIN_TOKEN: DEV_TOKEN,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  const admin = Bun.spawn(
    ["bun", join(REPO_ROOT, "admin", "src", "main.ts")],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(ADMIN_PORT),
        DATABASE_URL_SHIPWRIGHT_ADMIN: DEV_DATABASE_URL,
        SHIPWRIGHT_ENCRYPTION_KEY: DUMMY_ENCRYPTION_KEY,
        SHIPWRIGHT_SESSION_SECRET: DUMMY_SESSION_SECRET,
        ADMIN_DEV_AUTH: "true",
        SHIPWRIGHT_TASK_STORE_URL: TASK_STORE_URL,
        SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: DEV_TOKEN,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  return [
    { label: "task-store", proc: taskStore },
    { label: "admin", proc: admin },
  ];
}

function killServices(handles: ServiceHandle[]): void {
  for (const h of handles) {
    try {
      h.proc.kill("SIGINT");
    } catch {
      // already dead
    }
  }
}

// ---------------------------------------------------------------------------
// Task loop
// ---------------------------------------------------------------------------

interface Task {
  id: string;
  title: string;
  status: string;
  hitl?: boolean;
}

async function fetchReadyTasks(): Promise<Task[]> {
  try {
    const res = await fetch(`${TASK_STORE_URL}/tasks?ready=true`, {
      headers: { Authorization: `Bearer ${DEV_TOKEN}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { tasks: Task[] };
    return data.tasks ?? [];
  } catch {
    return [];
  }
}

async function runLoop(): Promise<void> {
  log(`task loop started — polling ${TASK_STORE_URL}`);
  log(`admin UI: ${ADMIN_URL}/admin/dev-login`);
  log(`workspace: ${WORKSPACE}`);
  log(`repos:     ${REPOS_DIR}`);
  log(`worktrees: ${WORKTREES_DIR}`);
  log("press Ctrl-C to stop\n");

  while (true) {
    const tasks = await fetchReadyTasks();

    if (tasks.length === 0) {
      log(`no ready tasks — retrying in ${POLL_INTERVAL_S}s`);
      await sleep(POLL_INTERVAL_S * 1000);
      continue;
    }

    // biome-ignore lint/correctness/noUnreachable: dispatch scaffolded but gated until task-selection is wired
    continue;

    const task = tasks[0];
    const command = task.hitl
      ? `/shipwright:hitl ${task.id}`
      : `/shipwright:dev-task ${task.id}`;

    console.log("");
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log(`next: ${task.id} — ${task.title}`);
    log(`hitl: ${task.hitl ?? false} → ${command}`);
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    const claude = Bun.spawn(["claude", command], {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        SHIPWRIGHT_TASK_STORE_URL: TASK_STORE_URL,
        SHIPWRIGHT_TASK_STORE_TOKEN: DEV_AGENT_TOKEN,
        SHIPWRIGHT_REPO_DIR: REPOS_DIR,
        SHIPWRIGHT_WORKTREE_DIR: WORKTREES_DIR,
      },
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });

    await claude.exited;

    log(`claude exited (code ${claude.exitCode}) — continuing loop`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const handles: ServiceHandle[] = [];

  const shutdown = () => {
    log("shutting down services...");
    killServices(handles);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await runPreflight();

    log("starting task-store and admin...");
    handles.push(...startServices());

    await Promise.all([
      waitForHealth(`http://localhost:${TASK_STORE_PORT}`, "task-store"),
      waitForHealth(`http://localhost:${ADMIN_PORT}`, "admin"),
    ]);

    await runLoop();
  } catch (err) {
    console.error(`[hitl] fatal: ${err}`);
    killServices(handles);
    process.exit(1);
  }
}
