/**
 * admin/src/coding/task-store-fetchers.ts
 *
 * The admin UI's task-store HTTP fetchers (extracted from main.ts, SSP-6.8).
 * Every call uses the single task-store admin token. An optional trailing
 * `accountId` is forwarded as `?accountId=`, which the task-store honors for
 * admin tokens only (task-store/src/account-scope.ts): omitted means every
 * account, set means exactly that account — so an account user's views are
 * filtered server-side rather than in admin.
 *
 * Deliberately dependency-free (only `fetch`, injectable) so it stays
 * unit-testable with a recording double and can be driven against the real
 * task-store app in-process by task-store's integration suite.
 *
 * Response bodies are typed by the caller (`<T>`), exactly as the previous
 * inline `res.json()` returns were; admin-ui.ts's AdminUIDeps pins the shapes.
 */

interface TaskStoreFetchersConfig {
  url: string;
  adminToken: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Copy of `params` with `accountId` set when given (never mutates input). */
function withAccountId(
  params: URLSearchParams,
  accountId?: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  if (accountId) next.set("accountId", accountId);
  return next;
}

function query(params: URLSearchParams): string {
  return params.size > 0 ? `?${params}` : "";
}

/** Lifecycle timestamps of a task (GET /tasks/:id), for adherence checks. */
export interface TaskLifecycle {
  repo: string | null;
  startedAt: string | null;
  pr: number | null;
  prCreatedAt: string | null;
  mergedAt: string | null;
  deployedAt: string | null;
}

/** The CI/outcome fields of a PR record (GET /prs?repo=&prNumber=). */
export interface PrOutcome {
  state: string;
  mergedAt: string | null;
  prCreatedAt: string | null;
  commitCount: number | null;
  commitsCiFix: number | null;
  patchCycles: number;
  reviewCycles: number;
}

export function createTaskStoreFetchers(config: TaskStoreFetchersConfig) {
  const doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  const auth = { Authorization: `Bearer ${config.adminToken}` };

  const path = (p: string, params: URLSearchParams, accountId?: string) =>
    `${config.url}${p}${query(withAccountId(params, accountId))}`;

  async function getJson<T>(
    p: string,
    params: URLSearchParams,
    accountId: string | undefined,
    label: string,
  ): Promise<T> {
    const res = await doFetch(path(p, params, accountId), { headers: auth });
    if (!res.ok) throw new Error(`task-store GET ${label} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  /** GET by id: a 404 (missing, or another account's row) maps to null. */
  async function getJsonOrNull<T>(
    p: string,
    accountId: string | undefined,
  ): Promise<T | null> {
    const res = await doFetch(path(p, new URLSearchParams(), accountId), {
      headers: auth,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`task-store GET ${p} → ${res.status}`);
    return res.json() as Promise<T>;
  }

  return {
    fetchTaskStoreTasks: <T>(params: URLSearchParams, accountId?: string) =>
      getJson<T>("/tasks", params, accountId, "/tasks"),

    fetchTaskStoreTask: <T>(id: string, accountId?: string) =>
      getJsonOrNull<T>(`/tasks/${encodeURIComponent(id)}`, accountId),

    releaseTask: async (id: string, accountId?: string): Promise<void> => {
      const res = await doFetch(
        path(
          `/tasks/${encodeURIComponent(id)}/release`,
          new URLSearchParams(),
          accountId,
        ),
        { method: "POST", headers: auth },
      );
      if (!res.ok)
        throw new Error(`task-store POST /tasks/${id}/release → ${res.status}`);
    },

    fetchDistinctTaskValues: (accountId?: string) =>
      getJson<{ sessions: string[]; repos: string[]; orgs: string[] }>(
        "/tasks/distinct",
        new URLSearchParams(),
        accountId,
        "/tasks/distinct",
      ),

    fetchTaskStorePrs: <T>(params: URLSearchParams, accountId?: string) =>
      getJson<T>("/prs", params, accountId, "/prs"),

    fetchTaskStorePrById: <T>(id: string, accountId?: string) =>
      getJsonOrNull<T>(`/prs/${encodeURIComponent(id)}`, accountId),

    fetchVerificationChecks: <T>(params: URLSearchParams, accountId?: string) =>
      getJson<T>(
        "/verification-checks",
        params,
        accountId,
        "/verification-checks",
      ),

    /** Lifecycle fields of a task by id; null when it doesn't exist. */
    getTask: (itemId: string, accountId?: string) =>
      getJsonOrNull<TaskLifecycle>(
        `/tasks/${encodeURIComponent(itemId)}`,
        accountId,
      ),

    /**
     * A PR record by repo + PR number via the existing /prs list lookup;
     * null when no such PR exists (an empty list, mirroring getJsonOrNull).
     */
    getPrByNumber: async (
      repo: string,
      pr: number,
      accountId?: string,
    ): Promise<PrOutcome | null> => {
      const { prs } = await getJson<{ prs: PrOutcome[] }>(
        "/prs",
        new URLSearchParams({ repo, prNumber: String(pr) }),
        accountId,
        "/prs",
      );
      return prs[0] ?? null;
    },

    /** Verification-check rows recorded against a task, oldest first. */
    getVerificationChecks: async <T = unknown>(
      itemId: string,
      accountId?: string,
    ): Promise<T[]> => {
      const { checks } = await getJson<{ checks: T[] }>(
        "/verification-checks",
        new URLSearchParams({ taskId: itemId }),
        accountId,
        "/verification-checks",
      );
      return checks;
    },

    fetchTaskStoreSessions: <T>(params: URLSearchParams, accountId?: string) =>
      getJson<T>("/sessions", params, accountId, "/sessions"),

    fetchTaskStoreSession: <T>(slug: string, accountId?: string) =>
      getJsonOrNull<T>(`/sessions/${encodeURIComponent(slug)}`, accountId),

    /**
     * PATCH /sessions/:slug. Resolves null on 404 — the slug doesn't exist in
     * the addressed account (for an account user: someone else's session).
     */
    patchTaskStoreSession: async (
      slug: string,
      patch: { title?: string | null; archived?: boolean },
      accountId?: string,
    ): Promise<unknown> => {
      const res = await doFetch(
        path(
          `/sessions/${encodeURIComponent(slug)}`,
          new URLSearchParams(),
          accountId,
        ),
        {
          method: "PATCH",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (res.status === 404) return null;
      if (!res.ok)
        throw new Error(`task-store PATCH /sessions/${slug} → ${res.status}`);
      return res.json();
    },
  };
}
