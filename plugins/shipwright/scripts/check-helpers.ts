/**
 * plugins/shipwright/scripts/check-helpers.ts
 *
 * Shared helpers for the four pre-check scripts.
 *
 * Covers:
 * - Workspace path resolution (WORKSPACE_PATH env var or cwd heuristic)
 * - Org/repo resolution from todos.json
 * - gh CLI execution helper
 * - reviews.json reading
 * - todos.json reading
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./store.ts";

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

// ─── todos.json reading ───────────────────────────────────────────────────────

export function readTodos(workspacePath: string): Task[] {
  const todosPath = join(workspacePath, "state", "todos.json");
  if (!existsSync(todosPath)) return [];
  return JSON.parse(readFileSync(todosPath, "utf-8")) as Task[];
}

// ─── reviews.json reading ─────────────────────────────────────────────────────

export function readReviews(workspacePath: string): ReviewEntry[] {
  const reviewsPath = join(workspacePath, "state", "reviews.json");
  if (!existsSync(reviewsPath)) return [];
  return JSON.parse(readFileSync(reviewsPath, "utf-8")) as ReviewEntry[];
}

// ─── Repos resolution ────────────────────────────────────────────────────────

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
