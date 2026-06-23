/**
 * plugins/shipwright/scripts/adapters/task-store.ts
 *
 * TaskStore implementation backed by a remote task-store HTTP service.
 *
 * Auth: Bearer token via SHIPWRIGHT_TASK_STORE_TOKEN env var.
 * Base URL: from config.taskStoreUrl or SHIPWRIGHT_TASK_STORE_URL env var.
 * fetchFn is injected via the constructor — no global.fetch usage.
 *
 * API contract:
 *   GET  /tasks               → returns Task[]
 *   GET  /tasks?ready=true    → returns ready Task[]
 *   GET  /tasks?status=X      → filter by status
 *   GET  /tasks?assignee=X    → filter by assignee
 *   POST /tasks               → insert task (409 if id exists — skip silently)
 *   PATCH /tasks/{id}         → partial update → returns updated Task
 *   POST /tasks/{id}/claim    → atomic claim → returns updated Task
 *   GET  /tasks/repo          → returns { repo: string }
 */

import type {
  QueryFilters,
  Task,
  TaskStore,
  TaskStoreConfig,
} from "../store.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal fetch signature used for dependency injection. */
type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

// ─── TaskStoreHttpAdapter ──────────────────────────────────────────────────────

export class TaskStoreHttpAdapter implements TaskStore {
  private readonly authHeader: string;

  constructor(
    private readonly config: TaskStoreConfig,
    private readonly fetchFn: FetchFn,
    token?: string,
  ) {
    const resolvedToken =
      token ?? process.env.SHIPWRIGHT_TASK_STORE_TOKEN ?? "";
    if (!resolvedToken) {
      throw new Error(
        "SHIPWRIGHT_TASK_STORE_TOKEN environment variable is required for task-store backend",
      );
    }
    this.authHeader = `Bearer ${resolvedToken}`;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private get baseUrl(): string {
    const url =
      (this.config as { taskStoreUrl?: string }).taskStoreUrl ??
      process.env.SHIPWRIGHT_TASK_STORE_URL ??
      "";
    if (!url) {
      throw new Error(
        "taskStoreUrl is required in TaskStoreConfig (or set SHIPWRIGHT_TASK_STORE_URL env var)",
      );
    }
    return url.replace(/\/$/, "");
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

  // ── TaskStore interface ───────────────────────────────────────────────────

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

    // assignee applies to both ready and non-ready queries
    if (filters.assignee !== undefined)
      params.set("assignee", filters.assignee);

    const qs = params.toString();
    const path = qs ? `/tasks?${qs}` : "/tasks";

    return this.apiFetchJson<Task[]>(path);
  }

  async append(tasks: Task[]): Promise<{ inserted: number; updated: number }> {
    let inserted = 0;
    const updated = 0;

    for (const task of tasks) {
      const res = await this.apiFetch("/tasks", {
        method: "POST",
        body: JSON.stringify(task),
      });

      if (res.status === 409) {
        // Already exists — skip silently (insert-only semantics)
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `task-store API error (${res.status}) POST /tasks for task ${task.id}: ${text}`,
        );
      }

      inserted++;
    }

    return { inserted, updated };
  }

  async update(id: string, fields: Partial<Task>): Promise<Task> {
    return this.apiFetchJson<Task>(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
  }

  /**
   * Atomically claim a task — transitions it to in_progress and assigns it
   * to the calling agent. Returns the updated task.
   */
  async claim(id: string): Promise<Task> {
    return this.apiFetchJson<Task>(`/tasks/${id}/claim`, {
      method: "POST",
    });
  }

  async setup(): Promise<void> {
    // The task-store service manages its own initialization.
    // This is a no-op for the HTTP adapter.
  }

  async resolveRepo(): Promise<string> {
    // First try the dedicated /tasks/repo endpoint
    try {
      const res = await this.apiFetch("/tasks/repo");
      if (res.ok) {
        const data = (await res.json()) as { repo?: string };
        if (data.repo) return data.repo;
      }
    } catch {
      // Fall through to task-based resolution
    }

    // Fall back to reading the first task's repo field
    const tasks = await this.apiFetchJson<Task[]>("/tasks");
    const firstWithRepo = tasks.find((t) => t.repo);
    if (!firstWithRepo?.repo) {
      throw new Error(
        "task-store: cannot resolveRepo — no tasks with a repo field found",
      );
    }
    return firstWithRepo.repo;
  }

  async resolveRepos(): Promise<string[]> {
    const repo = await this.resolveRepo();
    return [repo];
  }

  async cleanup(): Promise<{
    closed: number;
    milestonesClosed: number;
    plansClosed: number;
  }> {
    // The task-store service manages its own lifecycle.
    // This adapter does not drive issue/milestone cleanup.
    return { closed: 0, milestonesClosed: 0, plansClosed: 0 };
  }
}
