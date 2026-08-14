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
 *       repos/            ← SHIPWRIGHT_REPO_DIR (git clones, main branch;
 *                            repos listed in SHIPWRIGHT_HITL_REPOS are
 *                            auto-cloned via `gh repo clone` during preflight
 *                            if not already present)
 *       worktrees/        ← SHIPWRIGHT_WORKTREE_DIR (feature branches)
 *       state/reviews/
 *       .claude/
 *
 * Env overrides:
 *   SHIPWRIGHT_HITL_HOME          — root dir (default: ~/.shipwright)
 *   SHIPWRIGHT_HITL_HOST          — hostname for service URLs (default: "localhost")
 *   SHIPWRIGHT_HITL_REPOS         — comma-separated org/repo list for the hitl agent (default: none)
 *   SHIPWRIGHT_HITL_AUTHORS       — comma-separated GitHub usernames; when set, restricts review candidates to PRs authored by one of these logins (default: none, unfiltered). hitl.ts's local equivalent of the agent's authorAllowlist config field, kept in sync on the persisted hitl agent record via PATCH.
 *   SHIPWRIGHT_HITL_POLL_INTERVAL — seconds between empty-queue polls (default: 60)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  createTaskStoreClient,
  getCurrentUser,
  ghGraphql,
  ghJson,
  parseCandidateId,
  resolveAllRepos,
} from "../agent/src/check-helpers.ts";
import {
  type CheckPatchDeps,
  buildProductionDeps as buildPatchDeps,
  getPatchCandidates,
} from "../agent/src/check-patch.ts";
import {
  type CheckReviewDeps,
  buildProductionDeps as buildReviewDeps,
  getReviewCandidates,
} from "../agent/src/check-review.ts";
import { FLOOR_TOOLS } from "../agent/src/claude.ts";
import { installPlugins } from "../agent/src/setup.ts";
import {
  type WorkPrCandidate,
  type WorkTaskCandidate,
  selectNextWorkItem,
} from "../agent/src/work-selector.ts";

// ---------------------------------------------------------------------------
// Allowed tools — FLOOR_TOOLS + web access, minus Bash/Agent (both can
// execute arbitrary commands; keep them behind the approval prompt).
// ---------------------------------------------------------------------------

export const HITL_ALLOWED_TOOLS = [
  ...new Set([...FLOOR_TOOLS, "WebSearch", "WebFetch"]),
];

// ---------------------------------------------------------------------------
// Paths — anchored to this script, not cwd
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..");

// ---------------------------------------------------------------------------
// Constants — mirrors dev-tmux.ts defaults; no env vars required
// ---------------------------------------------------------------------------

export const TASK_STORE_PORT = 3002;
export const ADMIN_PORT = 3001;
const DEV_TOKEN = "dev-task-store-admin-token";
const DEV_AGENT_TOKEN = "dev-task-store-hitl-token";
const DEV_ADMIN_API_KEY = "dev-hitl-admin-key";
const HITL_AGENT_NAME = "hitl";

const DUMMY_ENCRYPTION_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";
const DUMMY_SESSION_SECRET = "dev-session-secret-not-for-production-use!";

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

/**
 * Parses the comma-separated SHIPWRIGHT_HITL_AUTHORS env value into a list of
 * GitHub usernames, trimming whitespace and dropping empty entries. Mirrors
 * parseHitlRepos() exactly. authorAllowlist is a real per-agent config field
 * (see admin's AgentRecord); hitl.ts is one particular caller that sources
 * its value from this env var, wires it into getReviewCandidates() via
 * CheckReviewDeps.isAuthorAllowed in runLoop(), and mirrors it onto the
 * persisted hitl agent record via ensureHitlAgent()'s PATCH.
 */
export function parseHitlAuthors(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean)
    : [];
}

// ---------------------------------------------------------------------------
// Config — every env-derived value in one pure, injectable record
// ---------------------------------------------------------------------------

/**
 * The full env-derived configuration for a HITL run. Everything the bootstrap
 * sequence needs to plan its work: paths, ports, URLs, dev credentials, and
 * the repo/author allowlists. Assembled once by buildHitlConfig() so the
 * builders below stay pure functions of (config) rather than reaching into
 * process.env at module scope.
 */
export type HitlConfig = {
  repoRoot: string;
  hitlHome: string;
  workspace: string;
  reposDir: string;
  worktreesDir: string;
  claudeMdTemplate: string;
  agentPolicyTemplate: string;
  repos: string[];
  authors: string[];
  pollIntervalS: number;
  host: string;
  taskStoreUrl: string;
  adminUrl: string;
  adminDatabaseUrl: string;
  taskStoreDatabaseUrl: string;
};

/**
 * Builds the HitlConfig from an env bag, the user's home dir, and the repo
 * root. Pure and exported so the env→config mapping (defaults, overrides, the
 * USER-prefixed Postgres URLs) is unit-testable without touching process.env
 * or the real filesystem.
 */
export function buildHitlConfig(
  env: Record<string, string | undefined>,
  homeDir: string,
  repoRoot: string,
): HitlConfig {
  const hitlHome = env.SHIPWRIGHT_HITL_HOME ?? join(homeDir, ".shipwright");
  const workspace = join(hitlHome, "workspace");
  const host = env.SHIPWRIGHT_HITL_HOST ?? "localhost";
  const dbUser = env.USER ?? "";
  const dbPrefix = dbUser ? `${dbUser}@` : "";

  return {
    repoRoot,
    hitlHome,
    workspace,
    reposDir: join(workspace, "repos"),
    worktreesDir: join(workspace, "worktrees"),
    claudeMdTemplate: join(
      repoRoot,
      "agent",
      "workspace",
      "CLAUDE-HITL.md.template",
    ),
    agentPolicyTemplate: join(
      repoRoot,
      "agent",
      "workspace",
      "state",
      "agent-policy.md.template",
    ),
    repos: parseHitlRepos(env.SHIPWRIGHT_HITL_REPOS),
    authors: parseHitlAuthors(env.SHIPWRIGHT_HITL_AUTHORS),
    pollIntervalS: Number(env.SHIPWRIGHT_HITL_POLL_INTERVAL ?? "60"),
    host,
    taskStoreUrl: `http://${host}:${TASK_STORE_PORT}`,
    adminUrl: `http://${host}:${ADMIN_PORT}`,
    adminDatabaseUrl: `postgresql://${dbPrefix}localhost:5432/shipwright_dev`,
    taskStoreDatabaseUrl: `postgresql://${dbPrefix}localhost:5432/shipwright_task_store_dev`,
  };
}

const CONFIG = buildHitlConfig(process.env, homedir(), REPO_ROOT);

const WORKSPACE = CONFIG.workspace;
const REPOS_DIR = CONFIG.reposDir;
const WORKTREES_DIR = CONFIG.worktreesDir;
const TASK_STORE_URL = CONFIG.taskStoreUrl;
const ADMIN_URL = CONFIG.adminUrl;
const HITL_REPOS = CONFIG.repos;
const HITL_AUTHORS = CONFIG.authors;
const POLL_INTERVAL_S = CONFIG.pollIntervalS;

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

/**
 * Pure planning step for provisionWorkspace(): given the set of dirs the
 * workspace needs and an injectable existence check, report which dirs are
 * missing and whether CLAUDE.md and agent-policy.md still need to be seeded.
 * Kept side-effect free so it's unit-testable without touching the real
 * filesystem.
 */
export function computeProvisionPlan(
  dirs: string[],
  claudeMdPath: string,
  agentPolicyPath: string,
  exists: (path: string) => boolean,
): {
  missingDirs: string[];
  needsClaudeMd: boolean;
  needsAgentPolicy: boolean;
} {
  return {
    missingDirs: dirs.filter((dir) => !exists(dir)),
    needsClaudeMd: !exists(claudeMdPath),
    needsAgentPolicy: !exists(agentPolicyPath),
  };
}

/**
 * Pure planning step for the auto-clone preflight step: given the configured
 * "org/repo" list, the repos dir, and an injectable existence check, report
 * which repos still need cloning (and their destination path). Repos already
 * present under reposDir are left untouched. Kept side-effect free so it's
 * unit-testable without touching the filesystem or network.
 */
export function computeMissingClones(
  repos: string[],
  reposDir: string,
  exists: (path: string) => boolean,
): { repo: string; dest: string }[] {
  return repos
    .map((repo) => ({
      repo,
      dest: join(reposDir, repo.slice(repo.lastIndexOf("/") + 1)),
    }))
    .filter(({ dest }) => !exists(dest));
}

// ---------------------------------------------------------------------------
// Bootstrap step builders — pure planners, mirroring dev-tmux.ts's
// buildStackCommands()/runStack() split. Each builder returns the ORDERED
// sequence of steps the bootstrap will perform; runSteps() drives them
// through an injected executor. Tests assert the sequence without spawning
// processes, touching the filesystem, or booting services.
// ---------------------------------------------------------------------------

export type HitlStepKind =
  | "mkdir"
  | "seed-file"
  | "clone"
  | "install-plugins"
  | "exec";

/** One planned step in the HITL bootstrap sequence. */
export type HitlStep = {
  kind: HitlStepKind;
  /** Human-readable label, also used for the failure message on exec steps. */
  label: string;
  /** Target directory (mkdir) or destination file (seed-file). */
  path?: string;
  /** Source template path for seed-file steps. */
  templatePath?: string;
  /** argv for clone/exec steps. */
  argv?: string[];
  /** Working directory for clone/exec steps. */
  cwd?: string;
  /** Env overrides layered onto the base env for exec steps. */
  env?: Record<string, string>;
};

/** Runs a single planned step. Injected so tests can record instead of act. */
export type StepExecFn = (step: HitlStep) => void | Promise<void>;

/**
 * Plans the workspace provisioning steps: the dirs to create and the template
 * files to seed. Pure — takes an injectable existence check and returns the
 * steps rather than performing them.
 */
export function buildProvisionSteps(
  cfg: HitlConfig,
  exists: (path: string) => boolean,
): HitlStep[] {
  const dirs = [
    cfg.workspace,
    cfg.reposDir,
    cfg.worktreesDir,
    join(cfg.workspace, "state", "reviews"),
    join(cfg.workspace, ".claude"),
  ];
  const claudeMd = join(cfg.workspace, "CLAUDE.md");
  const agentPolicy = join(cfg.workspace, "state", "agent-policy.md");

  const plan = computeProvisionPlan(dirs, claudeMd, agentPolicy, exists);
  const steps: HitlStep[] = plan.missingDirs.map((dir) => ({
    kind: "mkdir",
    label: `mkdir ${dir}`,
    path: dir,
  }));

  if (plan.needsClaudeMd) {
    steps.push({
      kind: "seed-file",
      label: "seeded CLAUDE.md",
      path: claudeMd,
      templatePath: cfg.claudeMdTemplate,
    });
  }
  if (plan.needsAgentPolicy) {
    steps.push({
      kind: "seed-file",
      label: "seeded agent-policy.md",
      path: agentPolicy,
      templatePath: cfg.agentPolicyTemplate,
    });
  }

  return steps;
}

/**
 * Plans the auto-clone steps for any configured repo not already present
 * under reposDir. Pure — wraps computeMissingClones() into executable steps.
 */
export function buildCloneSteps(
  cfg: HitlConfig,
  exists: (path: string) => boolean,
): HitlStep[] {
  return computeMissingClones(cfg.repos, cfg.reposDir, exists).map(
    ({ repo, dest }) => ({
      kind: "clone" as const,
      label: `gh repo clone failed for ${repo}`,
      argv: ["gh", "repo", "clone", repo, dest],
      cwd: cfg.repoRoot,
    }),
  );
}

/**
 * Plans the schema/seed steps: prisma generate + migrate for both the
 * task-store and admin services, plus the admin token seed between them.
 * Ordering matters — the token seed runs against an already-migrated
 * task-store DB, and admin migrates last.
 */
export function buildMigrationSteps(cfg: HitlConfig): HitlStep[] {
  const prismaArgs = (cmd: "generate" | "deploy"): string[] =>
    cmd === "generate"
      ? ["bunx", "prisma", "generate", "--schema=prisma/schema.prisma"]
      : [
          "bunx",
          "prisma",
          "migrate",
          "deploy",
          "--schema=prisma/schema.prisma",
        ];

  return [
    {
      kind: "exec",
      label: "task-store prisma generate failed",
      argv: prismaArgs("generate"),
      cwd: join(cfg.repoRoot, "task-store"),
    },
    {
      kind: "exec",
      label: "task-store migrate failed",
      argv: prismaArgs("deploy"),
      cwd: join(cfg.repoRoot, "task-store"),
      env: { DATABASE_URL_SHIPWRIGHT_TASK_STORE: cfg.taskStoreDatabaseUrl },
    },
    buildTokenSeedStep(cfg, DEV_TOKEN),
    {
      kind: "exec",
      label: "admin prisma generate failed",
      argv: prismaArgs("generate"),
      cwd: join(cfg.repoRoot, "admin"),
    },
    {
      kind: "exec",
      label: "admin migrate failed",
      argv: prismaArgs("deploy"),
      cwd: join(cfg.repoRoot, "admin"),
      env: { DATABASE_URL_SHIPWRIGHT_ADMIN: cfg.adminDatabaseUrl },
    },
  ];
}

/**
 * Plans a task-store token seed. Used twice: once during preflight for the
 * admin token (no agent id), and again after ensureHitlAgent() resolves an
 * agent id so the agent token is repo-scoped.
 */
export function buildTokenSeedStep(
  cfg: HitlConfig,
  token: string,
  agentId?: string,
): HitlStep {
  return {
    kind: "exec",
    label: agentId ? "agent token seed failed" : "admin token seed failed",
    argv: [
      "bun",
      "run",
      join(cfg.repoRoot, "scripts", "seed-task-store-token.ts"),
      "--db-url",
      cfg.taskStoreDatabaseUrl,
      "--token",
      token,
      ...(agentId ? ["--agent-id", agentId] : []),
    ],
    cwd: cfg.repoRoot,
  };
}

/**
 * Plans the complete preflight sequence in execution order:
 * provision → clone → install plugins → migrate/seed. This is the
 * clone→seed half of the bootstrap, as one assertable list.
 */
export function buildPreflightSteps(
  cfg: HitlConfig,
  exists: (path: string) => boolean,
): HitlStep[] {
  return [
    ...buildProvisionSteps(cfg, exists),
    ...buildCloneSteps(cfg, exists),
    { kind: "install-plugins", label: "installing shipwright plugin..." },
    ...buildMigrationSteps(cfg),
  ];
}

/** Drives a planned step sequence through an injected executor, in order. */
export async function runSteps(
  steps: HitlStep[],
  exec: StepExecFn,
): Promise<HitlStep[]> {
  for (const step of steps) {
    await exec(step);
  }
  return steps;
}

/**
 * The real executor: performs a planned step's I/O. Used only by the
 * entrypoint — tests inject a recording executor instead.
 */
async function execStep(step: HitlStep): Promise<void> {
  switch (step.kind) {
    case "mkdir":
      mkdirSync(step.path as string, { recursive: true });
      return;
    case "seed-file": {
      const template = readFileSync(step.templatePath as string, "utf8");
      writeFileSync(step.path as string, template, { flag: "wx" });
      log(step.label);
      return;
    }
    case "install-plugins":
      log(step.label);
      await installPlugins();
      return;
    case "clone":
    case "exec": {
      const result = Bun.spawnSync(step.argv as string[], {
        cwd: step.cwd,
        ...(step.env ? { env: { ...process.env, ...step.env } } : {}),
        stdout: "inherit",
        stderr: "inherit",
      });
      if (result.exitCode !== 0) throw new Error(step.label);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Preflight: workspace + migrations + token seed
// ---------------------------------------------------------------------------

async function runPreflight(): Promise<void> {
  await runSteps(buildPreflightSteps(CONFIG, existsSync), execStep);
  log(`workspace provisioned: ${WORKSPACE}`);
}

// ---------------------------------------------------------------------------
// Service spawning
// ---------------------------------------------------------------------------

type ServiceHandle = {
  label: string;
  proc: ReturnType<typeof Bun.spawn>;
};

/** A service the bootstrap boots: what to run, where, and with what env. */
export type ServiceSpec = {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
};

/**
 * Plans the boot step: the exact argv, cwd, and fully-resolved env for the
 * task-store and admin services, layered onto a caller-supplied base env.
 * Pure — mirrors buildClaudeSpawnEnv()'s overlay contract, so the boot
 * sequence is assertable without spawning long-running processes.
 */
export function buildServiceSpecs(
  cfg: HitlConfig,
  baseEnv: Record<string, string | undefined>,
): ServiceSpec[] {
  const base = Object.fromEntries(
    Object.entries(baseEnv).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

  return [
    {
      label: "task-store",
      argv: ["bun", "run", join(cfg.repoRoot, "task-store", "src", "main.ts")],
      cwd: cfg.repoRoot,
      env: {
        ...base,
        PORT: String(TASK_STORE_PORT),
        DATABASE_URL_SHIPWRIGHT_TASK_STORE: cfg.taskStoreDatabaseUrl,
        TASK_STORE_SEED_ADMIN_TOKEN: DEV_TOKEN,
        SHIPWRIGHT_TASK_STORE_AGENTS_URL: cfg.adminUrl,
        SHIPWRIGHT_TASK_STORE_AGENTS_API_KEY: DEV_ADMIN_API_KEY,
      },
    },
    {
      label: "admin",
      argv: ["bun", join(cfg.repoRoot, "admin", "src", "main.ts")],
      cwd: cfg.repoRoot,
      env: {
        ...base,
        PORT: String(ADMIN_PORT),
        DATABASE_URL_SHIPWRIGHT_ADMIN: cfg.adminDatabaseUrl,
        SHIPWRIGHT_ENCRYPTION_KEY: DUMMY_ENCRYPTION_KEY,
        SHIPWRIGHT_SESSION_SECRET: DUMMY_SESSION_SECRET,
        ADMIN_DEV_AUTH: "true",
        SHIPWRIGHT_ADMIN_API_KEYS: `hitl:${DEV_ADMIN_API_KEY}:*`,
        SHIPWRIGHT_TASK_STORE_URL: cfg.taskStoreUrl,
        SHIPWRIGHT_TASK_STORE_ADMIN_TOKEN: DEV_TOKEN,
      },
    },
  ];
}

function startServices(): ServiceHandle[] {
  return buildServiceSpecs(CONFIG, process.env).map((spec) => ({
    label: spec.label,
    proc: Bun.spawn(spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      stdout: "inherit",
      stderr: "inherit",
    }),
  }));
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

/** POST /agents and GET/PATCH /agents/:id full-record shape — includes `repos` and `authorAllowlist`. */
interface AgentRecord {
  id: string;
  name: string;
  repos: string[];
  authorAllowlist: string[];
}

/** Injectable fetch type so tests can supply a double instead of real network calls. */
type FetchLike = typeof fetch;

/** Order-independent array-equality check — same semantics for repos and authorAllowlist. */
function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * PATCHes whichever of `repos`/`authorAllowlist` are provided onto the hitl
 * agent record in a single request (PATCH /agents/:id accepts a partial
 * body — omitted fields are left unchanged).
 */
async function patchHitlAgent(
  agentId: string,
  fields: { repos?: string[]; authorAllowlist?: string[] },
  fetchImpl: FetchLike,
  headers: Record<string, string>,
): Promise<void> {
  const patchRes = await fetchImpl(`${ADMIN_URL}/agents/${agentId}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (patchRes.ok) {
    if (fields.repos !== undefined) {
      log(`updated hitl agent repos: ${fields.repos.join(", ")}`);
    }
    if (fields.authorAllowlist !== undefined) {
      log(
        `updated hitl agent authorAllowlist: ${fields.authorAllowlist.join(", ")}`,
      );
    }
  } else {
    log(`warning: failed to update hitl agent (${patchRes.status})`);
  }
}

export async function ensureHitlAgent(
  fetchImpl: FetchLike = fetch,
  repos: string[] = HITL_REPOS,
  authors: string[] = HITL_AUTHORS,
): Promise<string | null> {
  const headers = { Authorization: `Bearer ${DEV_ADMIN_API_KEY}` };

  const listRes = await fetchImpl(`${ADMIN_URL}/agents`, { headers });
  if (!listRes.ok) {
    log(
      `warning: could not list agents (${listRes.status}) — scope resolver may not work`,
    );
    return null;
  }
  const agents: AgentSummary[] = await listRes.json();
  const existingSummary = agents.find((a) => a.name === HITL_AGENT_NAME);

  if (existingSummary) {
    // The list response has no `repos`/`authorAllowlist` fields — fetch the
    // full record so we can compare against the desired values.
    const getRes = await fetchImpl(
      `${ADMIN_URL}/agents/${existingSummary.id}`,
      {
        headers,
      },
    );
    if (!getRes.ok) {
      log(
        `warning: could not fetch hitl agent detail (${getRes.status}) — scope resolver may not work`,
      );
      return existingSummary.id;
    }
    const existing: AgentRecord = await getRes.json();

    const reposMatch = sameMembers(existing.repos, repos);
    const authorsMatch = sameMembers(existing.authorAllowlist ?? [], authors);

    const patchFields: { repos?: string[]; authorAllowlist?: string[] } = {};
    if (!reposMatch && repos.length > 0) patchFields.repos = repos;
    if (!authorsMatch && authors.length > 0)
      patchFields.authorAllowlist = authors;

    if (Object.keys(patchFields).length > 0) {
      await patchHitlAgent(existing.id, patchFields, fetchImpl, headers);
    } else {
      log(
        `hitl agent exists (id: ${existing.id}, repos: ${existing.repos.join(", ") || "none"}, authorAllowlist: ${(existing.authorAllowlist ?? []).join(", ") || "none"})`,
      );
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
    // CreateAgentBodySchema doesn't accept `repos`/`authorAllowlist` —
    // persist them via a follow-up PATCH (mirrors the existing-agent-mismatch
    // branch above).
    const patchFields: { repos?: string[]; authorAllowlist?: string[] } = {};
    if (repos.length > 0) patchFields.repos = repos;
    if (authors.length > 0) patchFields.authorAllowlist = authors;
    if (Object.keys(patchFields).length > 0) {
      await patchHitlAgent(created.id, patchFields, fetchImpl, headers);
    }
    log(
      `created hitl agent (id: ${created.id}, repos: ${repos.join(", ") || "none"}, authorAllowlist: ${authors.join(", ") || "none"})`,
    );
    return created.id;
  }

  log(
    `warning: failed to create hitl agent (${createRes.status}) — scope resolver may not work`,
  );
  return null;
}

async function seedAgentToken(agentId: string): Promise<void> {
  log(`seeding task-store agent token (agentId: ${agentId})...`);
  await execStep(buildTokenSeedStep(CONFIG, DEV_AGENT_TOKEN, agentId));
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

/**
 * Picks the command to launch for a claimed PR candidate, stamping the
 * orchestrator pre-claim marker the review/patch commands consume so they
 * skip their own redundant self-claim (CBD-1.4/1.5). Pure — the claim itself
 * happens in runLoop(); this only formats the resulting dispatch.
 */
export function buildPrCommand(
  prId: string,
  phase: string,
  claim: { id: string; commitSha: string },
): string {
  const marker = `[preclaim:${claim.id}:${claim.commitSha}]`;
  const command = phase === "review" ? "review" : "patch";
  return `/shipwright:${command} ${prId} ${marker}`;
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

      command = buildPrCommand(next.pr.id, next.pr.phase, claimResult);
      label = `${next.pr.id} — ${next.pr.title ?? ""}`;
    }

    console.log("");
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log(`next: ${label}`);
    log(`type: ${next.type} → ${command}`);
    log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("");

    const claude = Bun.spawn(
      [
        "claude",
        command,
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        ...HITL_ALLOWED_TOOLS,
      ],
      {
        cwd: WORKSPACE,
        env: buildClaudeSpawnEnv(process.env),
        stdout: "inherit",
        stderr: "inherit",
        stdin: "inherit",
      },
    );

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
      await seedAgentToken(agentId);
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
