/**
 * task-store/src/routes/tasks.ts
 * Task CRUD + claim/heartbeat/complete/fail/release routes.
 *
 * Returns a Hono sub-app mounted at /tasks by app.ts. Auth is applied by the
 * parent app, so these handlers assume the caller is already authenticated.
 *
 * Routes:
 *   GET    /tasks               list (?status, ?session, ?assignee, ?ready=true)
 *   POST   /tasks               create
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
import { BadRequestError, NotFoundError } from "../errors.ts";
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

export function createTasksRoutes(taskService: TaskServiceLike): Hono {
  const app = new Hono();

  // ─── List ──────────────────────────────────────────────────────────────────
  app.get("/", async (c) => {
    if (c.req.query("ready") === "true") {
      return c.json(await taskService.listReady(), 200);
    }
    const tasks = await taskService.list({
      status: c.req.query("status"),
      session: c.req.query("session"),
      assignee: c.req.query("assignee"),
      claimedBy: c.req.query("claimedBy"),
    });
    return c.json(tasks, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    const body = await readJson(c);
    if (typeof body.title !== "string" || !body.title) {
      throw new BadRequestError("title is required");
    }
    if (typeof body.status !== "string" || !body.status) {
      throw new BadRequestError("status is required");
    }
    const created = await taskService.create(body as Prisma.TaskCreateInput);
    return c.json(created, 201);
  });

  // ─── Get one ───────────────────────────────────────────────────────────────
  app.get("/:id", async (c) => {
    const task = await taskService.get(c.req.param("id"));
    if (!task) throw new NotFoundError("task not found");
    return c.json(task, 200);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  app.patch("/:id", async (c) => {
    const body = await readJson(c);
    const updated = await taskService.update(
      c.req.param("id"),
      body as Prisma.TaskUpdateInput,
    );
    return c.json(updated, 200);
  });

  // ─── Delete ────────────────────────────────────────────────────────────────
  app.delete("/:id", async (c) => {
    await taskService.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // ─── Claim (atomic) ────────────────────────────────────────────────────────
  app.post("/:id/claim", async (c) => {
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
    const task = await taskService.heartbeat(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Complete ──────────────────────────────────────────────────────────────
  app.post("/:id/complete", async (c) => {
    const task = await taskService.complete(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Fail ──────────────────────────────────────────────────────────────────
  app.post("/:id/fail", async (c) => {
    const body = await readJson(c);
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const task = await taskService.fail(c.req.param("id"), reason);
    return c.json(task, 200);
  });

  // ─── Release ───────────────────────────────────────────────────────────────
  app.post("/:id/release", async (c) => {
    const task = await taskService.release(c.req.param("id"));
    return c.json(task, 200);
  });

  return app;
}
