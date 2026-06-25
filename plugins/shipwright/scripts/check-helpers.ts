/**
 * plugins/shipwright/scripts/check-helpers.ts
 *
 * Shared helpers for the four pre-check scripts.
 *
 * Covers:
 * - Workspace path resolution (WORKSPACE_PATH env var or cwd heuristic)
 * - Org/repo resolution from repos/ dir and shipwright.config.json
 * - gh CLI execution helper
 * - reviews.json reading
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "pr_open"
  | "approved"
  | "merged"
  | "done"
  | "deploying"
  | "deployed"
  | "blocked"
  | "cancelled";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  source?: string;
  session?: string;
  repo?: string;
  description?: string;
  acceptanceCriteria?: string[];
  layer?: string;
  branch?: string;
  dependencies?: string[];
  pr?: number;
  hours?: number;
  addedAt?: string;
  startedAt?: string;
  prCreatedAt?: string;
  mergedAt?: string;
  blockedAt?: string;
  blockedReason?: string;
  note?: string;
  type?: string;
  priority?: string;
  size?: string;
  file?: string;
  cancelledAt?: string;
  completedAt?: string;
  deployingAt?: string;
  deployedAt?: string;
  ciFixAttempts?: number;
  mergeCommit?: string;
  prNumber?: number;
  prOpenedAt?: string;
  prUrl?: string;
  assignee?: string;
  issue?: string;
  model?: "haiku" | "sonnet" | "opus";
  complexity?: number;
  hitl?: boolean;
  hitlNotifiedAt?: string;
}

// ─── ReviewEntry ──────────────────────────────────────────────────────────────

export interface ReviewEntry {
  pr: number;
  repo: string;
  org?: string;
  verdict?: string;
  posted?: boolean;
  lastReviewedCommit?: string;
  status?: string;
}

// ─── Policy helpers ───────────────────────────────────────────────────────────

export function parseAllowSelfReview(content: string): boolean {
  const match = content.match(
    /(?:`allow_self_review`\s*\|\s*|\*\*allow_self_review\*\*:\s*)(true|false)/,
  );
  return match?.[1] !== "false"; // default true if missing
}

export function readAllowSelfReview(workspacePath: string): boolean {
  try {
    const content = readFileSync(
      join(workspacePath, "state", "agent-policy.md"),
      "utf-8",
    );
    return parseAllowSelfReview(content);
  } catch {
    return true;
  }
}

// ─── Workspace path ───────────────────────────────────────────────────────────

/**
 * Resolve the agent workspace root.
 *
 * Priority:
 * 1. WORKSPACE_PATH env var (explicit override)
 * 2. AGENT_HOME/workspace (standard harness layout)
 *
 * Throws rather than falling back to a default path — a misconfigured agent
 * (missing AGENT_HOME) should fail loudly rather than silently read from the
 * wrong workspace and produce confusing results.
 */
export function resolveWorkspacePath(): string {
  const envPath = (process.env.WORKSPACE_PATH ?? "").trim();
  if (envPath) return envPath;
  const agentHome = (process.env.AGENT_HOME ?? "").trim();
  if (!agentHome)
    throw new Error("AGENT_HOME is not set — cannot resolve workspace path");
  return join(agentHome, "workspace");
}

// ─── reviews.json reading ─────────────────────────────────────────────────────

export function readReviews(workspacePath: string): ReviewEntry[] {
  const reviewsPath = join(workspacePath, "state", "reviews.json");
  if (!existsSync(reviewsPath)) return [];
  return JSON.parse(readFileSync(reviewsPath, "utf-8")) as ReviewEntry[];
}

// ─── Shipwright config ────────────────────────────────────────────────────────

export interface ShipwrightGitHubConfig {
  owner: string;
  repo: string;
}

/**
 * Read state/shipwright.config.json and return the github task store config,
 * or null if the file is absent, unreadable, or not using the github task store.
 */
export function readShipwrightConfig(
  workspacePath: string,
): ShipwrightGitHubConfig | null {
  const configPath = join(workspacePath, "state", "shipwright.config.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    const cfg = raw as Record<string, unknown>;
    if (cfg.taskStore !== "github") return null;
    const gh = cfg.github;
    if (
      typeof gh === "object" &&
      gh !== null &&
      typeof (gh as Record<string, unknown>).owner === "string" &&
      typeof (gh as Record<string, unknown>).repo === "string"
    ) {
      return {
        owner: (gh as Record<string, unknown>).owner as string,
        repo: (gh as Record<string, unknown>).repo as string,
      };
    }
  } catch {
    // unreadable or invalid JSON
  }
  return null;
}

// ─── Repos resolution ────────────────────────────────────────────────────────

/**
 * Resolve the full ordered list of "owner/repo" strings for this workspace.
 *
 * Priority:
 * 1. shipwright.config.json github repo — placed first, deduped from scanned list
 * 2. Scanned repos from workspace/repos/ or SHIPWRIGHT_REPOS_DIR
 * 3. Default "app-vitals/shipwright" if nothing else is found
 */
export function resolveAllRepos(workspacePath: string): string[] {
  const shipwrightConfig = readShipwrightConfig(workspacePath);
  const scannedRepos = resolveRepos(workspacePath);

  if (shipwrightConfig) {
    const primary = `${shipwrightConfig.owner}/${shipwrightConfig.repo}`;
    return [primary, ...scannedRepos.filter((r) => r !== primary)];
  }
  if (scannedRepos.length > 0) {
    return scannedRepos;
  }
  return ["app-vitals/shipwright"];
}

/**
 * Parse a git remote URL into "org/repo" format.
 * Handles both HTTPS (https://github.com/org/repo.git) and
 * SSH (git@github.com:org/repo.git) forms.
 * Returns null if the URL cannot be parsed.
 */
function parseRemoteUrl(url: string): string | null {
  // SSH: git@github.com:org/repo.git
  const sshMatch = url.match(/^git@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://github.com/org/repo.git or https://github.com/org/repo
  const httpsMatch = url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return null;
}

/**
 * Scan a directory for git clones and return ["org/repo", ...] strings
 * by reading each clone's .git/config for the remote origin URL.
 */
function scanReposDir(dir: string): string[] {
  const repos: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return repos;
  }

  for (const entry of entries) {
    const gitConfigPath = join(dir, entry, ".git", "config");
    if (!existsSync(gitConfigPath)) continue;
    try {
      const content = readFileSync(gitConfigPath, "utf-8");
      // Look for the [remote "origin"] url line
      const urlMatch = content.match(
        /\[remote\s+"origin"\][^\[]*url\s*=\s*(.+)/,
      );
      if (!urlMatch) continue;
      const remoteUrl = urlMatch[1].trim();
      const orgRepo = parseRemoteUrl(remoteUrl);
      if (orgRepo) repos.push(orgRepo);
    } catch {
      // Skip unreadable configs
    }
  }

  return repos;
}

/**
 * Resolve the list of "owner/repo" strings for this workspace.
 *
 * Priority:
 * 1. workspace/repos/ — scans for git clones, reads remote origin URLs
 * 2. SHIPWRIGHT_REPOS_DIR env var — same scan on an external directory
 * 3. Returns [] if nothing found
 */
export function resolveRepos(workspacePath: string): string[] {
  // 1. Try workspace/repos/ directory
  const reposDir = join(workspacePath, "repos");
  if (existsSync(reposDir)) {
    const repos = scanReposDir(reposDir);
    if (repos.length > 0) return repos;
  }

  // 2. Fall back to SHIPWRIGHT_REPOS_DIR env var
  const envReposDir = (process.env.SHIPWRIGHT_REPOS_DIR ?? "").trim();
  if (envReposDir && existsSync(envReposDir)) {
    const repos = scanReposDir(envReposDir);
    if (repos.length > 0) return repos;
  }

  return [];
}

// ─── Merge-only detection ────────────────────────────────────────────────────

export interface CommitInfo {
  sha: string;
  parents: Array<{ sha: string }>;
}

/**
 * Returns true if all commits after `lastReviewedCommit` are merge commits
 * (parents.length >= 2). Returns false on error, missing anchor, or if there
 * are no commits after the anchor.
 *
 * Shared by check-review (skip re-review after merge-from-main) and check-patch
 * (still trigger patch when only merge commits landed since a stale review).
 */
export async function isMergeOnlyUpdate(
  prNumber: number,
  lastReviewedCommit: string,
  deps: {
    listPrCommits: (prNumber: number, repo?: string) => Promise<CommitInfo[]>;
  },
  repo?: string,
): Promise<boolean> {
  try {
    const commits = await deps.listPrCommits(prNumber, repo);
    const anchorIndex = commits.findIndex((c) => c.sha === lastReviewedCommit);
    if (anchorIndex === -1) return false;
    const subsequent = commits.slice(anchorIndex + 1);
    if (subsequent.length === 0) return false;
    return subsequent.every((c) => c.parents.length >= 2);
  } catch {
    return false;
  }
}

// ─── Task store HTTP client ───────────────────────────────────────────────────

/**
 * Reads SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_TOKEN from the
 * environment, validates they are present, and returns a minimal fetch client
 * for the task-store HTTP API.
 *
 * Exits with code 1 if either variable is missing so callers (precheck scripts)
 * get a clean error rather than a confusing undefined/TypeError at call-time.
 */
export function createTaskStoreClient(): {
  query(params: URLSearchParams): Promise<Task[]>;
  update(id: string, fields: Record<string, unknown>): Promise<Task>;
} {
  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  if (!taskStoreUrl) {
    process.stderr.write("error: SHIPWRIGHT_TASK_STORE_URL is required\n");
    process.exit(1);
  }
  if (!taskStoreToken) {
    process.stderr.write("error: SHIPWRIGHT_TASK_STORE_TOKEN is required\n");
    process.exit(1);
  }
  const baseUrl = taskStoreUrl.replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${taskStoreToken}`,
    "Content-Type": "application/json",
  };

  return {
    async query(params: URLSearchParams): Promise<Task[]> {
      const res = await fetch(`${baseUrl}/tasks?${params}`, { headers });
      if (!res.ok)
        throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
      const data = (await res.json()) as unknown;
      // ?ready=true returns Task[]; all other queries return { tasks, total, limit, offset }
      if (Array.isArray(data)) return data as Task[];
      if (
        data !== null &&
        typeof data === "object" &&
        Array.isArray((data as Record<string, unknown>).tasks)
      )
        return (data as Record<string, unknown>).tasks as Task[];
      throw new Error(
        `Unexpected task-store response format: ${JSON.stringify(data)}`,
      );
    },
    async update(id: string, fields: Record<string, unknown>): Promise<Task> {
      const res = await fetch(`${baseUrl}/tasks/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(fields),
      });
      if (!res.ok)
        throw new Error(`task-store PATCH /tasks/${id} → ${res.status}`);
      return res.json() as Promise<Task>;
    },
  };
}

// ─── gh CLI helper ────────────────────────────────────────────────────────────

/**
 * Run a gh CLI command and return the parsed JSON output.
 * Throws on non-zero exit.
 */
export function ghJson<T>(args: string[]): T {
  const result = spawnSync("gh", args, {
    encoding: "utf-8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

/**
 * Run a gh CLI command without parsing output.
 * Throws on non-zero exit.
 */
export function ghRun(args: string[]): void {
  const result = spawnSync("gh", args, {
    encoding: "utf-8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}`,
    );
  }
}

/**
 * Run a gh API graphql command and return the raw response.
 */
export function ghGraphql<T>(query: string): T {
  const result = spawnSync("gh", ["api", "graphql", "-f", `query=${query}`], {
    encoding: "utf-8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `gh api graphql failed (exit ${result.status}): ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

/**
 * Get the current authenticated GH user login.
 *
 * Uses GraphQL viewer (not REST /user) because installation tokens issued to
 * GitHub Apps are rejected by /user with 403; the viewer query resolves to the
 * app's bot identity under both PAT and installation-token auth.
 *
 * Normalises the bot identity format: GraphQL returns "name[bot]" but
 * pr.author.login (and gh pr list --author) use "app/name", so we convert
 * here once so every call-site sees a consistent format.
 */
export function getCurrentUser(): string {
  const result = ghGraphql<{ data: { viewer: { login: string } } }>(
    "query { viewer { login } }",
  );
  const login = result.data.viewer.login;
  return login.endsWith("[bot]") ? `app/${login.slice(0, -5)}` : login;
}
