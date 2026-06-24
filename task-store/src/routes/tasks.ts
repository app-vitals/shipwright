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
 *   GET    /tasks               list (?status, ?session, ?assignee, ?pr, ?branch, ?ready=true)
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

/** Fetch a task and enforce agent ownership. Throws 404 or 403 as appropriate. */
async function requireOwnership(
  taskService: TaskServiceLike,
  id: string,
  agentId: string | null,
) {
  const task = await taskService.get(id);
  if (!task) throw new NotFoundError("task not found");
  if (agentId !== null && task.assignee !== agentId) {
    throw new ForbiddenError("task belongs to a different agent");
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

    if (c.req.query("ready") === "true") {
      return c.json(await taskService.listReady(agentId ?? undefined), 200);
    }

    const prRaw = c.req.query("pr");
    const tasks = await taskService.list({
      status: c.req.query("status"),
      session: c.req.query("session"),
      // Agent tokens always scope to their own tasks; ignore any provided ?assignee.
      assignee: agentId ?? c.req.query("assignee"),
      claimedBy: c.req.query("claimedBy"),
      pr: prRaw !== undefined ? Number.parseInt(prRaw, 10) : undefined,
      branch: c.req.query("branch"),
    });
    return c.json(tasks, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    const agentId = c.get("agentId");
    const body = await readJson(c);
    if (typeof body.title !== "string" || !body.title) {
      throw new BadRequestError("title is required");
    }
    if (typeof body.status !== "string" || !body.status) {
      throw new BadRequestError("status is required");
    }
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
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new BadRequestError("body must be a JSON array of tasks");
    }
    if (!Array.isArray(body)) {
      throw new BadRequestError("body must be a JSON array of tasks");
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
    const task = await taskService.get(c.req.param("id"));
    if (!task) throw new NotFoundError("task not found");
    if (agentId !== null && task.assignee !== agentId) {
      throw new ForbiddenError("task belongs to a different agent");
    }
    return c.json(task, 200);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  app.patch("/:id", async (c) => {
    const agentId = c.get("agentId");
    await requireOwnership(taskService, c.req.param("id"), agentId);
    const body = await readJson(c);
    // Prevent agent tokens from reassigning tasks outside their ownership scope.
    if (agentId !== null) {
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
    await requireOwnership(taskService, c.req.param("id"), agentId);
    await taskService.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // ─── Claim (atomic) ────────────────────────────────────────────────────────
  app.post("/:id/claim", async (c) => {
    const agentId = c.get("agentId");
    await requireOwnership(taskService, c.req.param("id"), agentId);
    const body = await readJson(c);
    const claimedBy = body.claimedBy;
    if (typeof claimedBy !== "string" || !claimedBy) {
      throw new BadRequestError("claimedBy is required");
    }
    const task = await taskService.claim(c.req.param("id"), claimedBy);
    return c.json(task, 200);
  });

  // ─── Heartbeat ─────────────────────────────────────────────────────────────
  app.post("/:id/heartbeat", async (c) => {
    const agentId = c.get("agentId");
    await requireOwnership(taskService, c.req.param("id"), agentId);
    const task = await taskService.heartbeat(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Complete ──────────────────────────────────────────────────────────────
  app.post("/:id/complete", async (c) => {
    const agentId = c.get("agentId");
    await requireOwnership(taskService, c.req.param("id"), agentId);
    const task = await taskService.complete(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Fail ──────────────────────────────────────────────────────────────────
  app.post("/:id/fail", async (c) => {
    const agentId = c.get("agentId");
    await requireOwnership(taskService, c.req.param("id"), agentId);
    const body = await readJson(c);
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const task = await taskService.fail(c.req.param("id"), reason);
    return c.json(task, 200);
  });

  // ─── Release ───────────────────────────────────────────────────────────────
  app.post("/:id/release", async (c) => {
    const agentId = c.get("agentId");
    await requireOwnership(taskService, c.req.param("id"), agentId);
    const task = await taskService.release(c.req.param("id"));
    return c.json(task, 200);
  });

  return app;
}
