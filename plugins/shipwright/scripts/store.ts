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
 *   5. dep.branch === candidate.branch AND dep.status ∈ { "pr_open", "approved", "merged" }
 *      → satisfied (bundled tasks on the same PR branch can proceed together)
 *   6. dep.branch !== candidate.branch AND dep.status === "pr_open" AND dep.pr is set
 *      → call isPrMerged(dep.pr) to check if the PR is actually merged on GitHub
 *
 * Any other state (pending, in_progress, blocked, cancelled, unknown dep) → not satisfied.
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
}

// ─── TaskStoreConfig ──────────────────────────────────────────────────────────

/**
 * Configuration for a TaskStore instance.
 *
 * `taskStore: "json"` uses a local state/todos.json file.
 * `taskStore: "github"` uses GitHub Issues as the backing store.
 */
export interface TaskStoreConfig {
  taskStore: "json" | "github";

  /** Required when taskStore === "github". */
  github?: {
    owner: string;
    repo: string;
  };
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
        dep.status === "deployed"
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

  /**
   * Initialize the backing store if it does not already exist.
   *
   * For the JSON backend: creates state/todos.json with an empty array.
   * For the GitHub backend: performs board setup (field creation, etc.).
   * No-op if the store is already initialized.
   */
  setup(): Promise<void>;

  /**
   * Resolve the canonical "owner/repo" string for this task store.
   *
   * For the GitHub backend: returns `config.github.owner + "/" + config.github.repo`.
   * For the JSON backend: reads the first task's `repo` field, or throws if none found.
   */
  resolveRepo(): Promise<string>;

  /**
   * Return all unique repos known to this task store as an array.
   *
   * For the JSON backend: collects all unique `repo` field values from tasks in todos.json.
   * For the GitHub backend: returns the single configured `owner/repo` as a one-element array.
   *
   * Returns an empty array if no repos are found (no error).
   */
  resolveRepos(): Promise<string[]>;

  /**
   * Close any open GitHub issues that carry a terminal status label (merged, done, deployed,
   * cancelled), close open plan issues whose sessions are fully terminal, and close any open
   * milestones that have no remaining open issues.
   *
   * For the JSON backend: closes issues referenced by `task.issue` URLs.
   * For the GitHub backend: scans all issues with a `status:*` label plus open `[plan]` issues.
   *
   * Returns counts for logging.
   */
  cleanup(): Promise<{
    closed: number;
    milestonesClosed: number;
    plansClosed: number;
  }>;
}
