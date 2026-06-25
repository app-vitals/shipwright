/**
 * task-store/src/routes/tasks.ts
 * Task CRUD + claim/heartbeat/complete/fail/release routes.
 *
 * Returns a Hono sub-app mounted at /tasks by app.ts. Auth is applied by the
 * parent app, so these handlers assume the caller is already authenticated.
 *
 * Agent tokens (agentId set) are scoped to their own tasks:
 *   - reads return only tasks where assignee === agentId
 *   - writes are blocked on tasks owned by other agents (403)
 *   - creates force assignee = agentId
 * Admin tokens (agentId null) have no restrictions.
 *
 * Routes:
 *   GET    /tasks               list (?status, ?state=open|closed, ?session, ?assignee, ?pr, ?branch, ?limit, ?offset, ?ready=true)
 *                              returns { tasks, total, limit, offset } — or Task[] when ?ready=true
 *   POST   /tasks               create one (409 if id exists)
 *   POST   /tasks/bulk          insert array, skip 409s → { inserted, updated }
 *   GET    /tasks/:id           fetch one (404 when missing)
 *   PATCH  /tasks/:id           update
 *   DELETE /tasks/:id           delete
 *   POST   /tasks/:id/claim     atomic claim (409 when already claimed)
 *   POST   /tasks/:id/heartbeat touch heartbeatAt
 *   POST   /tasks/:id/complete  status=done
 *   POST   /tasks/:id/fail      status=blocked
 *   POST   /tasks/:id/release   unclaim → pending
 */

import { Hono } from "hono";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import type { Prisma } from "../index.ts";
import type { TaskServiceLike } from "../task-service.ts";
import { isOrgRepo } from "../validate.ts";

async function readJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

// repos === null means admin token — bypass scope check; still enforce format.
function validateRepo(repo: unknown, repos: string[] | null): void {
  if (repo === undefined || repo === null) return;
  if (typeof repo !== "string" || !isOrgRepo(repo)) {
    throw new BadRequestError(`repo '${repo}' must be in org/repo format`);
  }
  if (repos !== null && !repos.includes(repo)) {
    throw new BadRequestError(`repo '${repo}' is not in this agent's scope`);
  }
}

/** Fetch a task and enforce agent ownership. Throws 404 or 403 as appropriate.
 *
 * Ownership is granted when any of:
 *   1. agentId is null (admin token — unrestricted)
 *   2. task.assignee === agentId (explicitly assigned)
 *   3. task.claimedBy === agentId (claimed pool task)
 *   4. task.assignee === null AND task.repo is in repos (repo-scoped pool task)
 */
async function requireOwnership(
  taskService: TaskServiceLike,
  id: string,
  agentId: string | null,
  repos: string[] = [],
) {
  const task = await taskService.get(id);
  if (!task) throw new NotFoundError("task not found");
  if (agentId !== null) {
    const ownedByAssignee = task.assignee === agentId;
    const ownedByClaim = task.claimedBy === agentId;
    const inRepoScope =
      task.assignee === null && task.repo !== null && repos.includes(task.repo);
    if (!ownedByAssignee && !ownedByClaim && !inRepoScope) {
      throw new ForbiddenError("task belongs to a different agent");
    }
  }
  return task;
}

export function createTasksRoutes(
  taskService: TaskServiceLike,
): Hono<TaskStoreAuthEnv> {
  const app = new Hono<TaskStoreAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  app.get("/", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const stateRaw = c.req.query("state");

    // ?ready=true is the legacy spelling; ?state=ready is the new form.
    if (c.req.query("ready") === "true" || stateRaw === "ready") {
      // Pass repos to listReady for repo-scoped agent tokens.
      return c.json(
        await taskService.listReady(agentId ?? undefined, repos ?? undefined),
        200,
      );
    }

    // ?state=blocked delegates to listBlocked().
    if (stateRaw === "blocked") {
      return c.json(await taskService.listBlocked(agentId ?? undefined), 200);
    }

    const prRaw = c.req.query("pr");
    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");
    const state =
      stateRaw === "open" || stateRaw === "closed" || stateRaw === "in_progress"
        ? stateRaw
        : undefined;

    // Agent tokens with a repos scope use agentScope (OR union of assigned + pool tasks).
    // Agent tokens without repos (repos=[]) fall back to simple assignee filter.
    // Admin tokens (repos=null) use caller-supplied ?assignee with no restriction.
    const useAgentScope =
      agentId !== null && repos !== null && repos.length > 0;

    const result = await taskService.list({
      status: c.req.query("status"),
      state,
      session: c.req.query("session"),
      repo: c.req.query("repo"),
      claimedBy: c.req.query("claimedBy"),
      pr: prRaw !== undefined ? Number.parseInt(prRaw, 10) : undefined,
      branch: c.req.query("branch"),
      limit:
        limitRaw !== undefined
          ? Number.parseInt(limitRaw, 10) || undefined
          : undefined,
      offset:
        offsetRaw !== undefined
          ? Number.parseInt(offsetRaw, 10) || undefined
          : undefined,
      // Use agentScope for repo-scoped agent tokens; otherwise use assignee filter.
      ...(useAgentScope
        ? { agentScope: { agentId: agentId as string, repos } }
        : { assignee: agentId ?? c.req.query("assignee") }),
    });
    return c.json(result, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const body = await readJson(c);
    if (typeof body.title !== "string" || !body.title) {
      throw new BadRequestError("title is required");
    }
    if (typeof body.status !== "string" || !body.status) {
      throw new BadRequestError("status is required");
    }
    validateRepo(body.repo, agentId !== null ? repos : null);
    // Agent tokens force assignee to their own ID.
    if (agentId !== null) {
      body.assignee = agentId;
    }
    const created = await taskService.create(body as Prisma.TaskCreateInput);
    return c.json(created, 201);
  });

  // ─── Bulk insert ───────────────────────────────────────────────────────────
  app.post("/bulk", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError("body must be a JSON array of tasks");
    }
    if (!Array.isArray(body)) {
      throw new BadRequestError("body must be a JSON array of tasks");
    }
    // Validate repo field on each task that has one.
    for (const task of body as Record<string, unknown>[]) {
      validateRepo(task.repo, agentId !== null ? repos : null);
    }
    const tasks =
      agentId !== null
        ? (body as Record<string, unknown>[]).map((t) => ({
            ...t,
            assignee: agentId,
          }))
        : body;
    const result = await taskService.bulk(tasks as Prisma.TaskCreateInput[]);
    return c.json(result, 200);
  });

  // ─── Get one ───────────────────────────────────────────────────────────────
  app.get("/:id", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    const task = await requireOwnership(
      taskService,
      c.req.param("id"),
      agentId,
      repos,
    );
    return c.json(task, 200);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  app.patch("/:id", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const task = await requireOwnership(
      taskService,
      c.req.param("id"),
      agentId,
      repos ?? [],
    );
    const body = await readJson(c);
    validateRepo(body.repo, agentId !== null ? repos : null);
    // Prevent agent tokens from reassigning tasks outside their ownership scope.
    // Only force-assign for explicitly assigned tasks; leave pool task assignee null.
    if (agentId !== null && task.assignee !== null) {
      body.assignee = agentId;
    }
    const updated = await taskService.update(
      c.req.param("id"),
      body as Prisma.TaskUpdateInput,
    );
    return c.json(updated, 200);
  });

  // ─── Delete ────────────────────────────────────────────────────────────────
  app.delete("/:id", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    await taskService.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // ─── Claim (atomic) ────────────────────────────────────────────────────────
  app.post("/:id/claim", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    // Agent tokens: pin claimedBy to the token's agentId (ignore request body).
    // Admin tokens: read claimedBy from the request body (existing behaviour).
    let claimedBy: string;
    if (agentId !== null) {
      claimedBy = agentId;
    } else {
      const body = await readJson(c);
      if (typeof body.claimedBy !== "string" || !body.claimedBy) {
        throw new BadRequestError("claimedBy is required");
      }
      claimedBy = body.claimedBy;
    }
    const task = await taskService.claim(c.req.param("id"), claimedBy);
    return c.json(task, 200);
  });

  // ─── Heartbeat ─────────────────────────────────────────────────────────────
  app.post("/:id/heartbeat", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.heartbeat(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Complete ──────────────────────────────────────────────────────────────
  app.post("/:id/complete", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.complete(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Fail ──────────────────────────────────────────────────────────────────
  app.post("/:id/fail", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const body = await readJson(c);
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const task = await taskService.fail(c.req.param("id"), reason);
    return c.json(task, 200);
  });

  // ─── Release ───────────────────────────────────────────────────────────────
  app.post("/:id/release", async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.release(c.req.param("id"));
    return c.json(task, 200);
  });

  return app;
}
