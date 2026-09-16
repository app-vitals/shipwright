/**
 * task-store/src/tasks.pr-open-stamp.smoke.test.ts
 *
 * Smoke tests for POM-1.1's server-side origin stamp on the pr_open
 * transition: PATCH /tasks/:id → TaskService.update() → (same transaction)
 * PullRequestService.stampOrigin(). Unlike the other *.smoke.test.ts files in
 * this directory (which inject a fully-faked TaskServiceLike/
 * PullRequestServiceLike and only exercise route-level HTTP parsing), this
 * file wires the REAL TaskService (and, via its default constructor param,
 * a REAL PullRequestService) so the actual cross-service stamp behavior runs
 * end-to-end through app.request() — the "no new API call from any command"
 * guarantee is a same-transaction property of TaskService.update() itself,
 * not something a route-level fake could observe. No real DB: both services
 * run against a small hand-built in-memory Prisma double (task/taskEvent/
 * pullRequest/pullRequestEvent), following the recording-double pattern
 * already used by task-service.unit.test.ts's makeWriteRecordingDouble and
 * pull-request-service.unit.test.ts's makePrismaDouble — no mock.module(),
 * no global overrides.
 *
 * Covers:
 *   - PATCH /tasks/:id {status:'pr_open', pr:N} on a repo-set task with no
 *     existing PullRequest row → 200, and a new row is created with
 *     origin:'shipwright'
 *   - PATCH /tasks/:id {status:'pr_open'} (pr omitted) on a task whose row
 *     already has pr set (unblock.md's re-affirm-only path) → 200, and the
 *     row is stamped
 *   - PATCH /tasks/:id {status:'pr_open', pr:null} with no pr already on the
 *     row → 400, and no PullRequest row is created
 *   - PATCH /tasks/:id {status:'in_progress'} (no status:'pr_open' in this
 *     PATCH) never calls stampOrigin, even if the row is already pr_open
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { FixedClock } from "./clock.ts";
import type { SessionServiceLike } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

/** No-op SessionService double — session routes aren't under test here. */
function fakeSessionService(): SessionServiceLike {
  return {
    async list() {
      return { sessions: [], total: 0, limit: 50, offset: 0 };
    },
    async get() {
      return null;
    },
    async update() {
      throw new Error("not implemented");
    },
  };
}

const ADMIN_TOKEN = "admin-token";

function fakeAdminTokenService(): TokenServiceLike {
  return {
    async create(label?: string, agentId?: string) {
      return {
        token: {
          id: "tok-admin",
          token: "hash",
          label: label ?? null,
          agentId: agentId ?? null,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw",
      };
    },
    async validate(raw: string) {
      return raw === ADMIN_TOKEN ? { id: "tok-admin", agentId: null } : null;
    },
    async revoke() {
      return null;
    },
    async list() {
      return [];
    },
    async update() {
      return null;
    },
  };
}

function adminAuth(): Record<string, string> {
  return {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    "content-type": "application/json",
  };
}

/**
 * Minimal in-memory Prisma double supporting exactly what TaskService.update()
 * + the default-constructed PullRequestService.stampOrigin() need:
 * task/taskEvent (TaskService) and pullRequest/pullRequestEvent
 * (PullRequestService), plus a callback-form $transaction that just invokes
 * the callback with the double itself as `tx` (mirrors attachEventStub in
 * pull-request-service.unit.test.ts).
 */
function makeInMemoryPrisma() {
  const tasks = new Map<string, Record<string, unknown>>();
  // Keyed by `${repo}#${prNumber}`, mirroring the real @@unique([repo, prNumber]).
  const pullRequests = new Map<string, Record<string, unknown>>();
  let nextPrId = 0;

  const prisma = {
    task: {
      async findUnique({ where }: { where: { id: string } }) {
        return tasks.get(where.id) ?? null;
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) {
        const existing = tasks.get(where.id);
        if (!existing) {
          const err = new Error("Record to update not found.") as Error & {
            code: string;
          };
          err.code = "P2025";
          throw err;
        }
        const updated = { ...existing, ...data, updatedAt: new Date() };
        tasks.set(where.id, updated);
        return updated;
      },
    },
    taskEvent: {
      async create() {
        return {};
      },
    },
    pullRequest: {
      async findUnique({
        where,
      }: {
        where: { repo_prNumber: { repo: string; prNumber: number } };
      }) {
        const { repo, prNumber } = where.repo_prNumber;
        return pullRequests.get(`${repo}#${prNumber}`) ?? null;
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) {
        for (const [key, pr] of pullRequests) {
          if (pr.id === where.id) {
            const updated = { ...pr, ...data };
            pullRequests.set(key, updated);
            return updated;
          }
        }
        throw new Error(`pullRequest ${where.id} not found`);
      },
      async create({ data }: { data: Record<string, unknown> }) {
        nextPrId += 1;
        const record = {
          id: `pr-${nextPrId}`,
          staged: false,
          state: "open",
          reviewState: "pending",
          phase: null,
          claimedBy: null,
          claimedAt: null,
          heartbeatAt: null,
          origin: null,
          authorLogin: null,
          headRef: null,
          title: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        pullRequests.set(`${data.repo}#${data.prNumber}`, record);
        return record;
      },
    },
    pullRequestEvent: {
      async create() {
        return {};
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  return { prisma, tasks, pullRequests };
}

function seedTask(
  tasks: Map<string, Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): void {
  const task = {
    id: "task-1",
    title: "A task",
    status: "in_progress",
    repo: "org/repo",
    pr: null,
    claimedBy: null,
    dependencies: [],
    acceptanceCriteria: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  tasks.set(task.id as string, task);
}

describe("PATCH /tasks/:id — pr_open origin stamp (POM-1.1)", () => {
  it("stamps a new PullRequest row with origin:'shipwright' when status:'pr_open' + a new pr are both supplied", async () => {
    const { prisma, tasks, pullRequests } = makeInMemoryPrisma();
    seedTask(tasks, { repo: "org/repo", pr: null });
    const taskService = new TaskService(
      prisma as never,
      FixedClock(new Date("2026-09-16T00:00:00.000Z")),
    );
    const app = createTaskStoreApp({
      taskService,
      tokenService: fakeAdminTokenService(),
      sessionService: fakeSessionService(),
    });

    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: adminAuth(),
      body: JSON.stringify({ status: "pr_open", pr: 42 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; pr: number };
    expect(body.status).toBe("pr_open");
    expect(body.pr).toBe(42);

    const pr = pullRequests.get("org/repo#42");
    expect(pr).toBeDefined();
    expect(pr?.origin).toBe("shipwright");
  });

  it("stamps the row when status:'pr_open' is re-affirmed with pr already on the task (unblock.md's re-affirm-only path)", async () => {
    const { prisma, tasks, pullRequests } = makeInMemoryPrisma();
    seedTask(tasks, { repo: "org/repo", pr: 99, status: "pr_open" });
    const taskService = new TaskService(
      prisma as never,
      FixedClock(new Date("2026-09-16T00:00:00.000Z")),
    );
    const app = createTaskStoreApp({
      taskService,
      tokenService: fakeAdminTokenService(),
      sessionService: fakeSessionService(),
    });

    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: adminAuth(),
      body: JSON.stringify({ status: "pr_open" }),
    });

    expect(res.status).toBe(200);
    const pr = pullRequests.get("org/repo#99");
    expect(pr).toBeDefined();
    expect(pr?.origin).toBe("shipwright");
  });

  it("returns 400 and creates no PullRequest row when status:'pr_open' is set with pr:null and no pr already on the row", async () => {
    const { prisma, tasks, pullRequests } = makeInMemoryPrisma();
    seedTask(tasks, { repo: "org/repo", pr: null, status: "in_progress" });
    const taskService = new TaskService(
      prisma as never,
      FixedClock(new Date("2026-09-16T00:00:00.000Z")),
    );
    const app = createTaskStoreApp({
      taskService,
      tokenService: fakeAdminTokenService(),
      sessionService: fakeSessionService(),
    });

    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: adminAuth(),
      body: JSON.stringify({ status: "pr_open", pr: null }),
    });

    expect(res.status).toBe(400);
    expect(pullRequests.size).toBe(0);
    // The task itself is left untouched — the whole transaction rolled back.
    expect(tasks.get("task-1")?.status).toBe("in_progress");
  });

  it("succeeds (200) and stamps when the row already has a non-null pr, even though this PATCH omits pr", async () => {
    const { prisma, tasks, pullRequests } = makeInMemoryPrisma();
    seedTask(tasks, { repo: "org/repo", pr: 7, status: "in_progress" });
    const taskService = new TaskService(
      prisma as never,
      FixedClock(new Date("2026-09-16T00:00:00.000Z")),
    );
    const app = createTaskStoreApp({
      taskService,
      tokenService: fakeAdminTokenService(),
      sessionService: fakeSessionService(),
    });

    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: adminAuth(),
      body: JSON.stringify({ status: "pr_open" }),
    });

    expect(res.status).toBe(200);
    expect(pullRequests.get("org/repo#7")?.origin).toBe("shipwright");
  });

  it("does not call stampOrigin (no PullRequest row created) for a PATCH that doesn't set status:'pr_open', even on an already-pr_open task", async () => {
    const { prisma, tasks, pullRequests } = makeInMemoryPrisma();
    seedTask(tasks, { repo: "org/repo", pr: 5, status: "pr_open" });
    const taskService = new TaskService(
      prisma as never,
      FixedClock(new Date("2026-09-16T00:00:00.000Z")),
    );
    const app = createTaskStoreApp({
      taskService,
      tokenService: fakeAdminTokenService(),
      sessionService: fakeSessionService(),
    });

    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: adminAuth(),
      body: JSON.stringify({ note: "just a note update" }),
    });

    expect(res.status).toBe(200);
    expect(pullRequests.size).toBe(0);
  });

  it("does not overwrite an already-non-null origin on a second pr_open PATCH (first-write-wins)", async () => {
    const { prisma, tasks, pullRequests } = makeInMemoryPrisma();
    seedTask(tasks, { repo: "org/repo", pr: 11, status: "in_progress" });
    pullRequests.set("org/repo#11", {
      id: "pr-existing",
      repo: "org/repo",
      prNumber: 11,
      origin: "human",
    });
    const taskService = new TaskService(
      prisma as never,
      FixedClock(new Date("2026-09-16T00:00:00.000Z")),
    );
    const app = createTaskStoreApp({
      taskService,
      tokenService: fakeAdminTokenService(),
      sessionService: fakeSessionService(),
    });

    const res = await app.request("/tasks/task-1", {
      method: "PATCH",
      headers: adminAuth(),
      body: JSON.stringify({ status: "pr_open" }),
    });

    expect(res.status).toBe(200);
    expect(pullRequests.get("org/repo#11")?.origin).toBe("human");
  });
});
