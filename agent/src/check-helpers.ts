/**
 * agent/src/check-helpers.ts
 *
 * Shared helpers ported from plugins/shipwright/scripts/check-helpers.ts —
 * a native, directly-importable copy for the agent runtime. The plugin
 * scripts remain the source of truth for agents that still run the
 * check-*.ts scripts as separate processes; this module exists so
 * in-process precheck ports (WL-2.2) can import the same logic without a
 * subprocess hop.
 *
 * Behavior is unchanged from the plugin source except createTaskStoreClient,
 * which gains an optional injectable fetch function so callers can supply a
 * fake fetch in tests instead of overriding globalThis.fetch (agent/src test
 * isolation rule: no global.fetch/global.* overrides). When no fetchFn is
 * passed, it falls back to global fetch — identical behavior to the plugin
 * version.
 *
 * Covers:
 * - Workspace path resolution (WORKSPACE_PATH env var or cwd heuristic)
 * - Org/repo resolution from repos/ dir
 * - gh CLI execution helper
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

// ─── Policy helpers ───────────────────────────────────────────────────────────

export function parseAllowSelfReview(content: string): boolean {
  const match = content.match(
    /(?:`allow_self_review`\s*\|\s*|\*\*allow_self_review\*\*:\s*)(true|false)/,
  );
  return match?.[1] !== "false"; // default true if missing
}

// ─── Self-review body matching ────────────────────────────────────────────────

/**
 * Matches a "Verdict: APPROVE" label anywhere in a review body (case-
 * insensitive, optional markdown bold markers around either word). Not
 * anchored to end-of-line — narrative self-reviews trail reasoning after the
 * verdict on the same line. The trailing `\b` requires "approve" to end as a
 * whole word, so "Verdict: CHANGES_REQUESTED" or "Verdict: DISAPPROVE" never
 * matches.
 */
export const VERDICT_APPROVE_LABEL = /verdict\**\s*:\s*\**approve\b/i;

/**
 * True when a review body is a clean APPROVE verdict, matched either by:
 * - a leading `APPROVE` (after stripping leading markdown bold markers), or
 * - a "Verdict: APPROVE" label anywhere in the body (the narrative
 *   self-review convention, which ends a summary with the verdict rather
 *   than leading with it).
 *
 * Shared by check-deploy.ts's hasSelfApproveReview and check-patch.ts's
 * isSelfCleanApprove so the two self-review consumers can't diverge again.
 */
export function isCleanApproveBody(body: string): boolean {
  return (
    body.trimStart().replace(/^\*+/, "").startsWith("APPROVE") ||
    VERDICT_APPROVE_LABEL.test(body)
  );
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

// ─── Repos resolution ────────────────────────────────────────────────────────

export function resolveAllRepos(workspacePath: string): string[] {
  return resolveRepos(workspacePath);
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

type FetchFn = (
  url: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Reads SHIPWRIGHT_TASK_STORE_URL and SHIPWRIGHT_TASK_STORE_TOKEN from the
 * environment, validates they are present, and returns a minimal fetch client
 * for the task-store HTTP API.
 *
 * Exits with code 1 if either variable is missing so callers (precheck scripts)
 * get a clean error rather than a confusing undefined/TypeError at call-time.
 *
 * Accepts an optional `fetchFn` for dependency injection in tests; defaults to
 * global fetch when not provided (identical behavior to the plugin version).
 */
export function createTaskStoreClient(opts?: { fetchFn?: FetchFn }): {
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
  const doFetch: FetchFn = opts?.fetchFn ?? fetch;

  return {
    async query(params: URLSearchParams): Promise<Task[]> {
      const res = await doFetch(`${baseUrl}/tasks?${params}`, { headers });
      if (!res.ok)
        throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
      const data = (await res.json()) as unknown;
      // Temporary: accept legacy bare Task[] from older task-store instances
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
      const res = await doFetch(`${baseUrl}/tasks/${id}`, {
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

// ─── PR candidate helpers ─────────────────────────────────────────────────────
//
// Shared by the WL-2.2 candidate providers (check-review.ts, check-patch.ts,
// check-deploy.ts) so the id/org-repo/task-store-record logic can't diverge
// across the three phase-specific ports.

/** Stable, human-readable candidate id: "org/repo#prNumber". */
export function candidateId(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/** Split "org/repo" into [org, repo], defaulting org to "app-vitals" for a bare repo name. */
export function splitOrgRepo(repo: string): [string, string] {
  return repo.includes("/")
    ? (repo.split("/", 2) as [string, string])
    : ["app-vitals", repo];
}

/**
 * Build a `(repo, prNumber) => record | null` query function against the
 * task-store `/prs` endpoint. Returns null on missing config, a non-ok
 * response, or any fetch error — a missing task-store PR record must not
 * throw, since an unclaimed PR simply has no record yet.
 *
 * Accepts an optional `fetchFn` for dependency injection in tests, matching
 * createTaskStoreClient's pattern.
 *
 * Accepts an optional `ready: true` to request only unclaimed PR records via
 * LPF-2.1's `?ready=true` filter (mirrors `/tasks?ready=true`). When set,
 * a `null` result becomes ambiguous between "no record exists yet" and
 * "a record exists but is currently claimed" — callers that need to
 * distinguish those two cases (e.g. check-review.ts) must NOT pass `ready`
 * and should check `record.claimedBy` themselves instead.
 */
export function createPrRecordQuery<T>(opts?: {
  fetchFn?: FetchFn;
  ready?: boolean;
}): (repo: string, prNumber: number) => Promise<T | null> {
  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const doFetch: FetchFn = opts?.fetchFn ?? fetch;

  return async (repo: string, prNumber: number): Promise<T | null> => {
    if (!taskStoreUrl || !taskStoreToken) return null;
    try {
      const baseUrl = taskStoreUrl.replace(/\/$/, "");
      const params = new URLSearchParams({ repo, prNumber: String(prNumber) });
      if (opts?.ready) params.set("ready", "true");
      const res = await doFetch(`${baseUrl}/prs?${params}`, {
        headers: {
          Authorization: `Bearer ${taskStoreToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as unknown;
      let records: T[] = [];
      if (Array.isArray(data)) {
        records = data as T[];
      } else if (
        data !== null &&
        typeof data === "object" &&
        Array.isArray((data as Record<string, unknown>).prs)
      ) {
        records = (data as Record<string, unknown>).prs as T[];
      }
      return records[0] ?? null;
    } catch {
      return null;
    }
  };
}

/**
 * Status + addedAt for the task linked to a PR, as returned by
 * createTaskStatusQuery. `addedAt` is included alongside `status` so callers
 * can source a cross-phase age comparison from the SAME clock dev-task's
 * backlog candidates already use (task.addedAt), instead of a phase-recent
 * timestamp. It may be undefined if the matched task record doesn't carry
 * one.
 */
export interface LinkedTaskInfo {
  status: TaskStatus;
  addedAt?: string;
}

/**
 * Build a `(repo, prNumber) => LinkedTaskInfo | null` query function against
 * the task-store `/tasks` endpoint's `?repo=&pr=` filters. Returns null ONLY
 * on a confirmed empty result (no linked task) — a PR simply has no task yet.
 * Throws on missing config, a non-ok response, or a malformed/unreachable
 * response, so a caller who needs a go/no-go decision (unlike
 * createPrRecordQuery's non-gating age field) can distinguish "no task" from
 * "couldn't tell" and fail closed on the latter.
 *
 * Accepts an optional `fetchFn` for dependency injection in tests, matching
 * createPrRecordQuery's pattern.
 */
export function createTaskStatusQuery(opts?: {
  fetchFn?: FetchFn;
}): (repo: string, prNumber: number) => Promise<LinkedTaskInfo | null> {
  const taskStoreUrl = (process.env.SHIPWRIGHT_TASK_STORE_URL ?? "").trim();
  const taskStoreToken = (process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "").trim();
  const doFetch: FetchFn = opts?.fetchFn ?? fetch;

  return async (
    repo: string,
    prNumber: number,
  ): Promise<LinkedTaskInfo | null> => {
    if (!taskStoreUrl || !taskStoreToken) {
      throw new Error(
        "SHIPWRIGHT_TASK_STORE_URL/SHIPWRIGHT_TASK_STORE_TOKEN not configured",
      );
    }
    const baseUrl = taskStoreUrl.replace(/\/$/, "");
    const params = new URLSearchParams({ repo, pr: String(prNumber) });
    const res = await doFetch(`${baseUrl}/tasks?${params}`, {
      headers: {
        Authorization: `Bearer ${taskStoreToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`task-store GET /tasks?${params} → ${res.status}`);
    }
    const data = (await res.json()) as unknown;
    let tasks: Task[];
    if (Array.isArray(data)) {
      tasks = data as Task[];
    } else if (
      data !== null &&
      typeof data === "object" &&
      Array.isArray((data as Record<string, unknown>).tasks)
    ) {
      tasks = (data as Record<string, unknown>).tasks as Task[];
    } else {
      throw new Error(`Unexpected task-store response format: ${JSON.stringify(data)}`);
    }
    const task = tasks[0];
    if (!task) return null;
    return { status: task.status, addedAt: task.addedAt };
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
