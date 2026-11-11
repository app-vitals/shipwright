/**
 * admin/src/coding/reconcile-open-work.ts
 *
 * Shipwright's OpenWorkPort for the platform's GitHub reconcile (GHE-3.6):
 * when repos are removed from an agent, list the agent's open tasks and PRs on
 * those repos and block them so the loop stops picking them up.
 *
 * "The agent's" work is what the agent is assigned to or has claimed: a task
 * whose assignee or claimedBy is the agent, a PR record whose agentId or
 * claimedBy is the agent. "Open" is every task status that can still progress
 * (pending, in_progress, pr_open, approved) and every open, unblocked PR — so
 * done/merged/deployed/released/cancelled work is never touched, and work that
 * is already blocked keeps its original reason.
 *
 * Blocking writes exactly `status`/`blockedReason` on a task and
 * `blocked`/`blockedReason` on a PR, through the task-store admin token.
 * Dependency-free (only `fetch`, injectable) like task-store-fetchers.ts.
 */

import type {
  OpenWorkItem,
  OpenWorkPort,
} from "@app-vitals/agent-admin/reconcile-open-work";

interface OpenWorkPortConfig {
  url: string;
  adminToken: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const PAGE_SIZE = 100;
const OPEN_TASK_STATUSES = ["pending", "in_progress", "pr_open", "approved"];

interface TaskRow {
  id: string;
  repo: string | null;
  title: string;
}

interface PrRow {
  id: string;
  repo: string;
  prNumber: number;
  title: string | null;
  agentId: string | null;
  claimedBy: string | null;
}

export function createTaskStoreOpenWorkPort(
  config: OpenWorkPortConfig,
): OpenWorkPort {
  const doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  const auth = { Authorization: `Bearer ${config.adminToken}` };

  async function getPage<T>(
    path: string,
    params: URLSearchParams,
    key: "tasks" | "prs",
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = new URLSearchParams(params);
      page.set("limit", String(PAGE_SIZE));
      page.set("offset", String(offset));
      const res = await doFetch(`${config.url}${path}?${page}`, {
        headers: auth,
      });
      if (!res.ok) throw new Error(`task-store GET ${path} → ${res.status}`);
      const body = (await res.json()) as Record<string, T[] | undefined>;
      const batch = body[key] ?? [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) return rows;
    }
  }

  async function patch(path: string, body: unknown): Promise<void> {
    const res = await doFetch(`${config.url}${path}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`task-store PATCH ${path} → ${res.status}`);
  }

  /** Open tasks the agent is assigned to or has claimed, deduped by id. */
  async function openTasks(
    agentId: string,
    repos: readonly string[],
  ): Promise<TaskRow[]> {
    const byId = new Map<string, TaskRow>();
    for (const status of OPEN_TASK_STATUSES) {
      for (const who of ["assignee", "claimedBy"]) {
        const params = new URLSearchParams({ status, [who]: agentId });
        for (const repo of repos) params.append("repo", repo);
        for (const task of await getPage<TaskRow>("/tasks", params, "tasks")) {
          byId.set(task.id, task);
        }
      }
    }
    return [...byId.values()].filter((t) => t.repo && repos.includes(t.repo));
  }

  /** Open, unblocked PR records the agent owns or has claimed. */
  async function openPrs(
    agentId: string,
    repos: readonly string[],
  ): Promise<PrRow[]> {
    const params = new URLSearchParams({ state: "open" });
    for (const repo of repos) params.append("repo", repo);
    const prs = await getPage<PrRow & { blocked: boolean }>(
      "/prs",
      params,
      "prs",
    );
    return prs.filter(
      (pr) =>
        !pr.blocked &&
        repos.includes(pr.repo) &&
        (pr.agentId === agentId || pr.claimedBy === agentId),
    );
  }

  return {
    async listOpenWork(agentId, repos) {
      if (repos.length === 0) return [];
      const [tasks, prs] = await Promise.all([
        openTasks(agentId, repos),
        openPrs(agentId, repos),
      ]);
      const items: OpenWorkItem[] = [
        ...tasks.map((t) => ({
          id: t.id,
          repo: t.repo as string,
          title: t.title,
        })),
        ...prs.map((pr) => ({
          id: pr.id,
          repo: pr.repo,
          title: pr.title ?? `${pr.repo}#${pr.prNumber}`,
        })),
      ];
      return items;
    },

    async blockOpenWork(agentId, repos, reason) {
      if (repos.length === 0) return;
      const [tasks, prs] = await Promise.all([
        openTasks(agentId, repos),
        openPrs(agentId, repos),
      ]);
      for (const task of tasks) {
        await patch(`/tasks/${encodeURIComponent(task.id)}`, {
          status: "blocked",
          blockedReason: reason,
        });
      }
      for (const pr of prs) {
        await patch(`/prs/${encodeURIComponent(pr.id)}`, {
          blocked: true,
          blockedReason: reason,
        });
      }
    },
  };
}
