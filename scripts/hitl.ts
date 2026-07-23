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
 *   SHIPWRIGHT_HITL_HOST          — hostname for service URLs (default: "localhost")
 *   SHIPWRIGHT_HITL_REPOS         — comma-separated org/repo list for the hitl agent (default: none)
 *   SHIPWRIGHT_HITL_AUTHORS       — comma-separated GitHub usernames; when set, restricts review candidates to PRs authored by one of these logins (default: none, unfiltered — dev-tool-only, not wired into the autonomous loop)
 *   SHIPWRIGHT_HITL_POLL_INTERVAL — seconds between empty-queue polls (default: 15)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

import {
  buildProductionDeps as buildReviewDeps,
  getReviewCandidates,
  type CheckReviewDeps,
} from "../agent/src/check-review.ts";
import {
  buildProductionDeps as buildPatchDeps,
  getPatchCandidates,
  type CheckPatchDeps,
} from "../agent/src/check-patch.ts";
import {
  selectNextWorkItem,
  type WorkPrCandidate,
  type WorkTaskCandidate,
} from "../agent/src/work-selector.ts";
import {
  createTaskStoreClient,
  getCurrentUser,
  ghGraphql,
  ghJson,
  parseCandidateId,
  resolveAllRepos,
} from "../agent/src/check-helpers.ts";

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
const HOST = process.env.SHIPWRIGHT_HITL_HOST ?? "localhost";
const TASK_STORE_URL = `http://${HOST}:${TASK_STORE_PORT}`;
const ADMIN_URL = `http://${HOST}:${ADMIN_PORT}`;
const DEV_TOKEN = "dev-task-store-admin-token";
const DEV_AGENT_TOKEN = "dev-task-store-hitl-token";
const DEV_ADMIN_API_KEY = "dev-hitl-admin-key";
const HITL_AGENT_NAME = "hitl";

/**
 * Parses the comma-separated SHIPWRIGHT_HITL_REPOS env value into a list of
 * org/repo strings, trimming whitespace and dropping empty entries. Pure and
 * exported so parsing edge cases (undefined, empty string, stray commas /
 * whitespace) are unit-testable without touching process.env.
 */
export function parseHitlRepos(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean)
    : [];
}

const HITL_REPOS = parseHitlRepos(process.env.SHIPWRIGHT_HITL_REPOS);

/**
 * Parses the comma-separated SHIPWRIGHT_HITL_AUTHORS env value into a list of
 * GitHub usernames, trimming whitespace and dropping empty entries. Mirrors
 * parseHitlRepos() exactly — dev-tool-only author allowlist, wired into
 * getReviewCandidates() via CheckReviewDeps.isAuthorAllowed in runLoop().
 */
export function parseHitlAuthors(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean)
    : [];
}

const HITL_AUTHORS = parseHitlAuthors(process.env.SHIPWRIGHT_HITL_AUTHORS);
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

/**
 * Pure planning step for provisionWorkspace(): given the set of dirs the
 * workspace needs and an injectable existence check, report which dirs are
 * missing and whether CLAUDE.md still needs to be seeded. Kept side-effect
 * free so it's unit-testable without touching the real filesystem.
 */
export function computeProvisionPlan(
  dirs: string[],
  claudeMdPath: string,
  exists: (path: string) => boolean,
): { missingDirs: string[]; needsClaudeMd: boolean } {
  return {
    missingDirs: dirs.filter((dir) => !exists(dir)),
    needsClaudeMd: !exists(claudeMdPath),
  };
}

function provisionWorkspace(): void {
  const dirs = [
    WORKSPACE,
    REPOS_DIR,
    WORKTREES_DIR,
    join(WORKSPACE, "state", "reviews"),
    join(WORKSPACE, ".claude"),
  ];
  const claudeMd = join(WORKSPACE, "CLAUDE.md");

  const plan = computeProvisionPlan(dirs, claudeMd, existsSync);

  for (const dir of plan.missingDirs) {
    mkdirSync(dir, { recursive: true });
  }

  if (plan.needsClaudeMd) {
    const template = readFileSync(HITL_TEMPLATE, "utf8");
    writeFileSync(claudeMd, template, { flag: "wx" });
    log("seeded CLAUDE.md");
  }

  if (plan.missingDirs.length > 0) {
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

  log("seeding task-store admin token...");
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
        SHIPWRIGHT_TASK_STORE_AGENTS_URL: ADMIN_URL,
        SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY: DEV_ADMIN_API_KEY,
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
        SHIPWRIGHT_ADMIN_API_KEYS: `hitl:${DEV_ADMIN_API_KEY}:*`,
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
// Agent record — ensure the "hitl" agent exists in the admin service so the
// task-store scope resolver can look up its repos.
// ---------------------------------------------------------------------------

/** GET /agents list-summary shape (AgentSummarySchema) — no `repos` field. */
interface AgentSummary {
  id: string;
  name: string;
  selfHosted: boolean;
}

/** POST /agents and GET/PATCH /agents/:id full-record shape — includes `repos`. */
interface AgentRecord {
  id: string;
  name: string;
  repos: string[];
}

/** Injectable fetch type so tests can supply a double instead of real network calls. */
type FetchLike = typeof fetch;

async function patchHitlAgentRepos(
  agentId: string,
  repos: string[],
  fetchImpl: FetchLike,
  headers: Record<string, string>,
): Promise<void> {
  const patchRes = await fetchImpl(`${ADMIN_URL}/agents/${agentId}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ repos }),
  });
  if (patchRes.ok) {
    log(`updated hitl agent repos: ${repos.join(", ")}`);
  } else {
    log(`warning: failed to update hitl agent repos (${patchRes.status})`);
  }
}

export async function ensureHitlAgent(
  fetchImpl: FetchLike = fetch,
  repos: string[] = HITL_REPOS,
): Promise<string | null> {
  const headers = { Authorization: `Bearer ${DEV_ADMIN_API_KEY}` };

  const listRes = await fetchImpl(`${ADMIN_URL}/agents`, { headers });
  if (!listRes.ok) {
    log(`warning: could not list agents (${listRes.status}) — scope resolver may not work`);
    return null;
  }
  const agents: AgentSummary[] = await listRes.json();
  const existingSummary = agents.find((a) => a.name === HITL_AGENT_NAME);

  if (existingSummary) {
    // The list response has no `repos` field — fetch the full record so we
    // can compare against the desired repos.
    const getRes = await fetchImpl(`${ADMIN_URL}/agents/${existingSummary.id}`, {
      headers,
    });
    if (!getRes.ok) {
      log(
        `warning: could not fetch hitl agent detail (${getRes.status}) — scope resolver may not work`,
      );
      return existingSummary.id;
    }
    const existing: AgentRecord = await getRes.json();

    const reposMatch =
      existing.repos.length === repos.length &&
      existing.repos.every((r) => repos.includes(r));
    if (!reposMatch && repos.length > 0) {
      await patchHitlAgentRepos(existing.id, repos, fetchImpl, headers);
    } else {
      log(`hitl agent exists (id: ${existing.id}, repos: ${existing.repos.join(", ") || "none"})`);
    }
    return existing.id;
  }

  const createRes = await fetchImpl(`${ADMIN_URL}/agents`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: HITL_AGENT_NAME,
      selfHosted: true,
    }),
  });

  if (createRes.ok) {
    const created: AgentRecord = await createRes.json();
    // CreateAgentBodySchema doesn't accept `repos` — persist it via a
    // follow-up PATCH (mirrors the existing-agent-mismatch branch above).
    if (repos.length > 0) {
      await patchHitlAgentRepos(created.id, repos, fetchImpl, headers);
    }
    log(`created hitl agent (id: ${created.id}, repos: ${repos.join(", ") || "none"})`);
    return created.id;
  }

  log(`warning: failed to create hitl agent (${createRes.status}) — scope resolver may not work`);
  return null;
}

function seedAgentToken(agentId: string): void {
  log(`seeding task-store agent token (agentId: ${agentId})...`);
  const result = Bun.spawnSync(
    [
      "bun",
      "run",
      join(REPO_ROOT, "scripts", "seed-task-store-token.ts"),
      "--db-url",
      DEV_TASK_STORE_DATABASE_URL,
      "--token",
      DEV_AGENT_TOKEN,
      "--agent-id",
      agentId,
    ],
    { cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) throw new Error("agent token seed failed");
}

// ---------------------------------------------------------------------------
// Task loop
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  title: string;
  status: string;
  hitl?: boolean;
  createdAt?: string;
}

/**
 * Pure response-shape parsing for fetchReadyTasks(): tolerates a missing or
 * malformed `tasks` field so callers get [] rather than throwing.
 */
export function parseTasksResponse(data: unknown): Task[] {
  if (
    data &&
    typeof data === "object" &&
    Array.isArray((data as { tasks?: unknown }).tasks)
  ) {
    return (data as { tasks: Task[] }).tasks;
  }
  return [];
}

/**
 * Picks the command to launch for a given ready task: HITL tasks route to
 * /shipwright:hitl, everything else to the standard autonomous dev-task flow.
 */
export function buildTaskCommand(task: Pick<Task, "id" | "hitl">): string {
  return task.hitl
    ? `/shipwright:hitl ${task.id}`
    : `/shipwright:dev-task ${task.id}`;
}

async function fetchReadyTasks(): Promise<Task[]> {
  try {
    const res = await fetch(`${TASK_STORE_URL}/tasks?ready=true`, {
      headers: { Authorization: `Bearer ${DEV_TOKEN}` },
    });
    if (!res.ok) {
      log(`fetchReadyTasks: task-store returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    return parseTasksResponse(data);
  } catch (err) {
    log(
      `fetchReadyTasks: failed to reach ${TASK_STORE_URL} (${err instanceof Error ? err.message : err}) — check SHIPWRIGHT_HITL_HOST`,
    );
    return [];
  }
}

/**
 * Builds the env passed to the spawned `claude` process: the caller's base
 * env (typically process.env) overlaid with the task-store connection and
 * repo/worktree dirs the dispatched command needs. Pure aside from reading
 * its argument, so it's testable without spawning a real process.
 */
export function buildClaudeSpawnEnv(
  baseEnv: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    SHIPWRIGHT_TASK_STORE_URL: TASK_STORE_URL,
    SHIPWRIGHT_TASK_STORE_TOKEN: DEV_AGENT_TOKEN,
    SHIPWRIGHT_REPO_DIR: REPOS_DIR,
    SHIPWRIGHT_WORKTREE_DIR: WORKTREES_DIR,
  };
}

async function runLoop(): Promise<void> {
  log(`task loop started — polling ${TASK_STORE_URL}`);
  log(`admin UI: ${ADMIN_URL}/admin/dev-login`);
  log(`workspace: ${WORKSPACE}`);
  log(`repos:     ${REPOS_DIR}`);
  log(`worktrees: ${WORKTREES_DIR}`);
  log("press Ctrl-C to stop\n");

  const repoEntries = existsSync(REPOS_DIR) ? readdirSync(REPOS_DIR) : [];
  const hasRepos = repoEntries.length > 0;
  if (!hasRepos) {
    log(
      "⚠ workspace/repos/ is empty — review/patch candidates will be skipped (task-only mode)",
    );
  }

  // resolveWorkspacePath() (called inside buildReviewDeps/buildPatchDeps
  // below) reads WORKSPACE_PATH — set it, plus the task-store env vars the
  // agent-scoped client needs for claims, before building deps/client.
  process.env.WORKSPACE_PATH = WORKSPACE;
  process.env.SHIPWRIGHT_TASK_STORE_URL = TASK_STORE_URL;
  process.env.SHIPWRIGHT_TASK_STORE_TOKEN = DEV_AGENT_TOKEN;

  let reviewDeps: CheckReviewDeps | undefined;
  let patchDeps: CheckPatchDeps | undefined;

  if (hasRepos) {
    const allRepos = resolveAllRepos(WORKSPACE);
    // HITL has no agent config bundle to sync repo scope from — treat every
    // cloned repo as always-in-scope.
    reviewDeps = await buildReviewDeps({
      ghJson,
      getScopedRepos: () => allRepos,
      hasScopeSynced: () => true,
      ...(HITL_AUTHORS.length > 0
        ? { isAuthorAllowed: (login: string) => HITL_AUTHORS.includes(login) }
        : {}),
    });
    patchDeps = await buildPatchDeps({
      ghJson,
      ghGraphql,
      getCurrentUser,
      getScopedRepos: () => allRepos,
      hasScopeSynced: () => true,
    });
  }

  const client = createTaskStoreClient();

  while (true) {
    const tasks = await fetchReadyTasks();
    const taskCandidates: WorkTaskCandidate[] = tasks.map((t) => ({
      id: t.id,
      createdAt: t.createdAt ?? "",
      title: t.title,
    }));

    let prCandidates: WorkPrCandidate[] = [];
    if (hasRepos && reviewDeps && patchDeps) {
      try {
        const [reviewCands, patchCands] = await Promise.all([
          getReviewCandidates(reviewDeps),
          getPatchCandidates(patchDeps),
        ]);
        prCandidates = [...reviewCands, ...patchCands];
      } catch (err) {
        log(
          `PR candidate collection failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    const next = selectNextWorkItem(taskCandidates, prCandidates);

    if (!next) {
      log(`no ready work — retrying in ${POLL_INTERVAL_S}s`);
      await sleep(POLL_INTERVAL_S * 1000);
      continue;
    }

    let command: string;
    let label: string;

    if (next.type === "task") {
      let claimed: boolean;
      try {
        claimed = await client.claim(next.task.id);
      } catch (err) {
        log(
          `task ${next.task.id} claim failed: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      if (!claimed) {
        log(`task ${next.task.id} already claimed (409) — skipping`);
        continue;
      }
      const fullTask = tasks.find((t) => t.id === next.task.id);
      command = buildTaskCommand({ id: next.task.id, hitl: fullTask?.hitl });
      label = `${next.task.id} — ${next.task.title ?? ""}`;
    } else {
      const parsed = parseCandidateId(next.pr.id);
      if (!parsed) {
        log(`malformed PR candidate id: ${next.pr.id} — skipping`);
        continue;
      }
      if (!next.pr.phase) {
        log(`PR candidate ${next.pr.id} missing phase — skipping`);
        continue;
      }

      let claimResult: Awaited<ReturnType<typeof client.claimPr>>;
      try {
        claimResult = await client.claimPr({
          repo: parsed.repo,
          prNumber: parsed.prNumber,
          commitSha: next.pr.commitSha,
          phase: next.pr.phase,
        });
      } catch (err) {
        log(
          `PR ${next.pr.id} claim failed: ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      if (!claimResult) {
        log(`PR ${next.pr.id} already claimed (409) — skipping`);
        continue;
      }

      const preclaimMarker = `[preclaim:${claimResult.id}:${claimResult.commitSha}]`;
      command =
        next.pr.phase === "review"
          ? `/shipwright:review ${next.pr.id} ${preclaimMarker}`
          : `/shipwright:patch ${next.pr.id} ${preclaimMarker}`;
      label = `${next.pr.id} — ${next.pr.title ?? ""}`;
    }

    console.log("");
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log(`next: ${label}`);
    log(`type: ${next.type} → ${command}`);
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    const claude = Bun.spawn(["claude", command], {
      cwd: WORKSPACE,
      env: buildClaudeSpawnEnv(process.env),
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

    const agentId = await ensureHitlAgent();
    if (agentId) {
      seedAgentToken(agentId);
    } else {
      log("warning: no hitl agent — agent token will not be repo-scoped");
    }

    await runLoop();
  } catch (err) {
    console.error(`[hitl] fatal: ${err}`);
    killServices(handles);
    process.exit(1);
  }
}
