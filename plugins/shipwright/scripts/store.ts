/**
 * plugins/shipwright/scripts/store.ts
 *
 * Canonical Task type, TaskStore interface, and shared resolveReadyTasks logic
 * for Shipwright task stores.
 *
 * ─── dep_satisfied semantics ─────────────────────────────────────────────────
 *
 * A dependency task satisfies the dependency constraint for a candidate task when:
 *
 *   1. dep.status === "merged"    → always satisfied (cross-branch or same-branch)
 *   2. dep.status === "done"      → satisfied (legacy status, treated same as merged)
 *   3. dep.status === "deploying" → satisfied (post-merged, deploy in flight — counts same as deployed)
 *   4. dep.status === "deployed"  → satisfied (post-merged, always counts)
 *   5. dep.status === "cancelled" → satisfied (work is moot; downstream should unblock)
 *   6. dep.branch === candidate.branch AND dep.status ∈ { "pr_open", "approved", "merged" }
 *      → satisfied (bundled tasks on the same PR branch can proceed together)
 *   7. dep.branch !== candidate.branch AND dep.status === "pr_open" AND dep.pr is set
 *      → call isPrMerged(dep.pr) to check if the PR is actually merged on GitHub
 *
 * Any other state (pending, in_progress, blocked, unknown dep) → not satisfied.
 *
 * A task is "ready" when:
 *   - task.status === "pending"
 *   - all dep IDs in task.dependencies resolve to known tasks that satisfy the above
 *   - a missing dep is treated as unsatisfied (conservative)
 */

// ─── Task status ──────────────────────────────────────────────────────────────

/** All status values used in the shipwright pipeline. */
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

// ─── Task ─────────────────────────────────────────────────────────────────────

/**
 * Canonical task record — covers all fields present in todos.json entries
 * and the Python task_store.py schema.
 *
 * All fields except `id`, `title`, and `status` are optional to accommodate
 * tasks at different lifecycle stages and tasks originating from different
 * backends (JSON file vs GitHub Projects v2).
 */
export interface Task {
  id: string;
  title: string;

  /**
   * Current pipeline status.
   *
   * Lifecycle: pending → in_progress → pr_open → approved → merged → deploying → deployed
   * Terminal: merged | done | deployed | cancelled
   * Paused:   blocked
   *
   * dep_satisfied semantics: see module-level JSDoc above.
   */
  status: TaskStatus;

  source?: string;
  session?: string;
  repo?: string;
  description?: string;
  acceptanceCriteria?: string[];

  /** Common values: "Shared", "API", "Database", "Agent", "CLI", "Web". */
  layer?: string;

  /** Used for dep_satisfied same-branch logic — see module-level JSDoc. */
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
  ciFixAttempts?: number;
  mergeCommit?: string;

  /** May duplicate `pr` for legacy compatibility. */
  prNumber?: number;

  /** May duplicate `prCreatedAt` — both fields appear in existing todos.json entries. */
  prOpenedAt?: string;

  prUrl?: string;

  /** GitHub login of the assigned developer. */
  assignee?: string;

  /** GitHub issue URL tracking this task (e.g. https://github.com/org/repo/issues/123). */
  issue?: string;

  /**
   * Tier hint for model selection.
   * Callers must map to a full model ID (e.g. claude-sonnet-4-6); no automatic mapping is applied.
   * Omit to use the agent's default.
   */
  model?: "haiku" | "sonnet" | "opus";

  /**
   * Complexity rating for the task on a 1–5 scale.
   * 1 = trivial, 5 = highest complexity. Used for planning and model selection heuristics.
   */
  complexity?: number;

  /**
   * When true, this task requires human-in-the-loop execution and must not be
   * picked up by the automated dev-task executor. resolveReadyTasks excludes
   * hitl tasks from the ready set.
   */
  hitl?: boolean;

  /** ISO timestamp set when the agent first notified humans about this HITL task. */
  hitlNotifiedAt?: string;
}

// ─── QueryFilters ─────────────────────────────────────────────────────────────

/**
 * Filters for querying the task store.
 *
 * All fields are optional. When `ready` is true, the store applies
 * dep_satisfied logic and returns only tasks that are ready to execute.
 * When `ready` is true, `session` is still applied as a post-filter on the
 * ready set — dep resolution uses the full task list so cross-session deps
 * satisfy correctly, but only tasks matching the session are returned.
 * Other filters (`status`, `id`, `pr`) are ignored when `ready` is true.
 */
export interface QueryFilters {
  /** When true, returns only tasks that are ready (pending + all deps satisfied). */
  ready?: boolean;

  status?: string;
  session?: string;
  id?: string;
  pr?: number;

  /** Filter tasks by GitHub login of the assigned developer. */
  assignee?: string;

  /** Filter tasks by branch name (exact match). */
  branch?: string;

  /** When true, return only hitl tasks; when false, exclude hitl tasks. */
  hitl?: boolean;
}

// ─── resolveReadyTasks ────────────────────────────────────────────────────────

/**
 * Return tasks that are ready to execute.
 *
 * A task is ready when:
 *   - task.status === "pending"
 *   - all dependency IDs resolve to known tasks that satisfy dep_satisfied rules
 *
 * @param tasks       Full task list (all tasks, not just pending ones)
 * @param isPrMerged  Callback used for cross-branch pr_open deps — given a PR
 *                    number, returns true if that PR is actually merged on GitHub.
 *                    For backends without GitHub access, pass `async () => false`.
 */
export async function resolveReadyTasks(
  tasks: Task[],
  isPrMerged: (prNumber: number) => Promise<boolean>,
): Promise<Task[]> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const results: Task[] = [];

  for (const task of tasks) {
    if (task.status !== "pending") continue;
    if (task.hitl === true) continue;

    let ready = true;
    for (const depId of task.dependencies ?? []) {
      const dep = byId.get(depId);
      if (!dep) {
        ready = false;
        break;
      }

      // Terminal / fully-satisfied statuses
      if (
        dep.status === "merged" ||
        dep.status === "done" ||
        dep.status === "deploying" ||
        dep.status === "deployed" ||
        dep.status === "cancelled"
      ) {
        continue;
      }

      // Same-branch pr_open / approved → bundled, satisfies
      if (
        dep.branch &&
        dep.branch === task.branch &&
        (dep.status === "pr_open" || dep.status === "approved")
      ) {
        continue;
      }

      // Cross-branch pr_open → check GitHub PR merge status
      if (dep.status === "pr_open" && dep.pr !== undefined) {
        const merged = await isPrMerged(dep.pr);
        if (merged) continue;
      }

      // All other states → not satisfied
      ready = false;
      break;
    }

    if (ready) results.push(task);
  }

  return results;
}

// ─── TaskStore ────────────────────────────────────────────────────────────────

/**
 * TaskStore — abstract interface over a task store backend.
 *
 * All methods return Promises for async compatibility regardless of whether
 * the underlying storage is synchronous (local file) or remote (GitHub API).
 *
 * Implementations:
 *  - JSON backend: reads/writes state/todos.json atomically
 *  - GitHub backend: reads/writes GitHub Issues via the gh CLI
 */
export interface TaskStore {
  /**
   * Return tasks matching the given filters.
   *
   * When `filters.ready` is true, returns only tasks that are ready to execute:
   * status === "pending" AND all dependencies are satisfied per dep_satisfied semantics.
   *
   * When `filters.ready` is false or absent, other filter fields are applied as
   * exact-match AND conditions.
   */
  query(filters: QueryFilters): Promise<Task[]>;

  /**
   * Upsert tasks into the store, matched by `id` (idempotent).
   *
   * For each task in the input array:
   * - If a task with the same `id` exists, merge incoming fields over existing fields.
   * - If no task with that `id` exists, insert it.
   *
   * Returns a summary of how many tasks were inserted vs updated.
   */
  append(tasks: Task[]): Promise<{ inserted: number; updated: number }>;

  /**
   * Write specific fields to a task identified by `id`.
   *
   * Merges `fields` over the existing task record. Status is written last
   * to preserve ordering semantics (non-status fields first, then status).
   *
   * Throws if no task with the given `id` exists.
   */
  update(id: string, fields: Partial<Task>): Promise<Task>;

  /** Initialize the backing store if it does not already exist. No-op for the HTTP backend. */
  setup(): Promise<void>;

  /** Resolve the canonical "owner/repo" string for this task store. */
  resolveRepo(): Promise<string>;

  /** Return all unique repos known to this task store. */
  resolveRepos(): Promise<string[]>;

  /** Close stale open issues/milestones. Returns counts. */
  cleanup(): Promise<{
    closed: number;
    milestonesClosed: number;
    plansClosed: number;
  }>;
}

// ─── TaskStoreConfig ─────────────────────────────────────────────────────────

/** Configuration object passed to task-store adapters. */
export interface TaskStoreConfig {
  taskStoreUrl: string;
}

// ─── TaskStoreHttpClient ──────────────────────────────────────────────────────

/** Minimal fetch signature used for dependency injection in tests. */
export type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * TaskStore implementation backed by the remote task-store HTTP service.
 *
 * Auth:     Bearer token via SHIPWRIGHT_TASK_STORE_TOKEN env var.
 * Base URL: config.taskStoreUrl
 *
 * API contract:
 *   GET  /tasks               → Task[]
 *   GET  /tasks?ready=true    → ready Task[]
 *   POST /tasks               → insert (409 if id exists — skip silently)
 *   PATCH /tasks/{id}         → partial update → updated Task
 *   POST /tasks/{id}/claim    → atomic claim → updated Task
 *   GET  /tasks/repo          → { repo: string }
 */
export class TaskStoreHttpClient implements TaskStore {
  private readonly authHeader: string;
  private readonly baseUrl: string;

  constructor(
    taskStoreUrl: string,
    private readonly fetchFn: FetchFn,
    token?: string,
  ) {
    const resolvedToken =
      token ?? process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "";
    if (!resolvedToken) {
      throw new Error(
        "SHIPWRIGHT_TASK_STORE_TOKEN environment variable is required",
      );
    }
    this.authHeader = `Bearer ${resolvedToken}`;
    this.baseUrl = taskStoreUrl.replace(/\/$/, "");
  }

  private async apiFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers as Record<string, string> | undefined),
    };
    return this.fetchFn(url, { ...options, headers });
  }

  private async apiFetchJson<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const res = await this.apiFetch(path, options);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `task-store API error (${res.status}) ${options.method ?? "GET"} ${path}: ${text}`,
      );
    }
    return res.json() as Promise<T>;
  }

  async query(filters: QueryFilters): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filters.ready === true) {
      params.set("ready", "true");
    } else {
      if (filters.status !== undefined) params.set("status", filters.status);
      if (filters.session !== undefined) params.set("session", filters.session);
      if (filters.id !== undefined) params.set("id", filters.id);
      if (filters.pr !== undefined) params.set("pr", String(filters.pr));
      if (filters.branch !== undefined) params.set("branch", filters.branch);
      if (filters.hitl !== undefined) params.set("hitl", String(filters.hitl));
    }
    if (filters.assignee !== undefined)
      params.set("assignee", filters.assignee);
    const qs = params.toString();
    return this.apiFetchJson<Task[]>(qs ? `/tasks?${qs}` : "/tasks");
  }

  async append(tasks: Task[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    for (const task of tasks) {
      const res = await this.apiFetch("/tasks", {
        method: "POST",
        body: JSON.stringify(task),
      });
      if (res.status === 409) continue; // already exists — insert-only semantics
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `task-store API error (${res.status}) POST /tasks for task ${task.id}: ${text}`,
        );
      }
      inserted++;
    }
    return { inserted, updated: 0 };
  }

  async update(id: string, fields: Partial<Task>): Promise<Task> {
    return this.apiFetchJson<Task>(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
  }

  async claim(id: string): Promise<Task> {
    return this.apiFetchJson<Task>(`/tasks/${id}/claim`, { method: "POST" });
  }

  async setup(): Promise<void> {}

  async resolveRepo(): Promise<string> {
    try {
      const res = await this.apiFetch("/tasks/repo");
      if (res.ok) {
        const data = (await res.json()) as { repo?: string };
        if (data.repo) return data.repo;
      }
    } catch {
      // fall through
    }
    const tasks = await this.apiFetchJson<Task[]>("/tasks");
    const first = tasks.find((t) => t.repo);
    if (!first?.repo) {
      throw new Error(
        "task-store: cannot resolveRepo — no tasks with a repo field found",
      );
    }
    return first.repo;
  }

  async resolveRepos(): Promise<string[]> {
    return [await this.resolveRepo()];
  }

  async cleanup(): Promise<{
    closed: number;
    milestonesClosed: number;
    plansClosed: number;
  }> {
    return { closed: 0, milestonesClosed: 0, plansClosed: 0 };
  }
}
