/**
 * task-store/src/routes/tasks.ts
 * Task CRUD + claim/heartbeat/complete/fail/release routes.
 *
 * Returns an OpenAPIHono sub-app mounted at /tasks by app.ts. Auth is applied by the
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
 *                              returns { tasks, total }
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

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import type { Prisma, Task } from "../index.ts";
import { ErrorSchema, type Task as TaskJson, TaskSchema } from "../openapi-schemas.ts";
import type { TaskServiceLike, TaskWithBlockedBy } from "../task-service.ts";
import { isOrgRepo } from "../validate.ts";

/**
 * Cast a Prisma Task (with Date fields and JsonValue metadata) to the OpenAPI
 * schema's Task type (with string dates). At runtime JSON serialization converts
 * Date → ISO string, so the wire format is correct. This cast bridges the
 * compile-time type gap without changing any behaviour.
 */
function asTaskJson(task: Task | TaskWithBlockedBy): TaskJson {
  return task as unknown as TaskJson;
}

function asTaskListJson(tasks: (Task | TaskWithBlockedBy)[]): TaskJson[] {
  return tasks as unknown as TaskJson[];
}

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
 *   4. task.repo is in repos (repo-scoped token with matching repo)
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
    const inRepoScope = task.repo !== null && repos.includes(task.repo);
    if (!ownedByAssignee && !ownedByClaim && !inRepoScope) {
      throw new ForbiddenError("task belongs to a different agent");
    }
  }
  return task;
}

// ─── Common response schemas ──────────────────────────────────────────────────

const TaskListResponseSchema = z.object({
  tasks: z.array(TaskSchema),
  total: z.number().int(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
});

const BulkResponseSchema = z.object({
  inserted: z.number().int(),
  updated: z.number().int(),
});

const DistinctResponseSchema = z.object({
  sessions: z.array(z.string()),
  repos: z.array(z.string()),
});

// ─── Common path params ───────────────────────────────────────────────────────

const IdParamsSchema = z.object({
  id: z.string().openapi({ example: "clx1234567890" }),
});

// ─── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  summary: "List tasks",
  description:
    "Returns a paginated list of tasks. Agent tokens are scoped to their own tasks.",
  request: {
    query: z.object({
      status: z.string().optional().openapi({ example: "pending" }),
      state: z
        .enum(["open", "closed", "in_progress", "ready", "blocked"])
        .optional()
        .openapi({ example: "open" }),
      session: z.string().optional().openapi({ example: "session-123" }),
      assignee: z.string().optional().openapi({ example: "user@example.com" }),
      repo: z.string().optional().openapi({ example: "org/repo" }),
      claimedBy: z.string().optional().openapi({ example: "agent-id-123" }),
      pr: z
        .string()
        .optional()
        .openapi({ example: "42", description: "PR number (integer)" }),
      branch: z.string().optional().openapi({ example: "feat/feature-x" }),
      limit: z
        .string()
        .optional()
        .openapi({ example: "50", description: "Max results" }),
      offset: z
        .string()
        .optional()
        .openapi({ example: "0", description: "Pagination offset" }),
      ready: z
        .enum(["true", "false"])
        .optional()
        .openapi({ example: "true", description: "Legacy: filter ready tasks" }),
    }),
  },
  responses: {
    200: {
      description: "Task list",
      content: { "application/json": { schema: TaskListResponseSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const createTaskRoute = createRoute({
  method: "post",
  path: "/",
  summary: "Create a task",
  description: "Creates a new task. Agent tokens force assignee to their own ID.",
  responses: {
    201: {
      description: "Task created",
      content: { "application/json": { schema: TaskSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Task ID already exists",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const bulkRoute = createRoute({
  method: "post",
  path: "/bulk",
  summary: "Bulk insert tasks",
  description: "Inserts multiple tasks, skipping 409s. Returns insert/update counts.",
  responses: {
    200: {
      description: "Bulk insert result",
      content: { "application/json": { schema: BulkResponseSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const distinctRoute = createRoute({
  method: "get",
  path: "/distinct",
  summary: "Distinct task field values",
  description: "Returns distinct session and repo values for tasks visible to the caller.",
  responses: {
    200: {
      description: "Distinct values",
      content: { "application/json": { schema: DistinctResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getTaskRoute = createRoute({
  method: "get",
  path: "/{id}",
  summary: "Get a task by ID",
  request: { params: IdParamsSchema },
  responses: {
    200: {
      description: "Task found",
      content: { "application/json": { schema: TaskSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden — task belongs to a different agent",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateTaskRoute = createRoute({
  method: "patch",
  path: "/{id}",
  summary: "Update a task",
  request: { params: IdParamsSchema },
  responses: {
    200: {
      description: "Task updated",
      content: { "application/json": { schema: TaskSchema } },
    },
    400: {
      description: "Bad request",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/{id}",
  summary: "Delete a task",
  request: { params: IdParamsSchema },
  responses: {
    204: {
      description: "Task deleted",
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const claimRoute = createRoute({
  method: "post",
  path: "/{id}/claim",
  summary: "Claim a task",
  description:
    "Atomically claims a task. Agent tokens pin claimedBy to their own agentId.",
  request: { params: IdParamsSchema },
  responses: {
    200: {
      description: "Task claimed",
      content: { "application/json": { schema: TaskSchema } },
    },
    400: {
      description: "Bad request (claimedBy required for admin tokens)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Task already claimed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const heartbeatRoute = createRoute({
  method: "post",
  path: "/{id}/heartbeat",
  summary: "Heartbeat a task",
  description: "Updates heartbeatAt to the current time.",
  request: { params: IdParamsSchema },
  responses: {
    200: {
      description: "Heartbeat recorded",
      content: { "application/json": { schema: TaskSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const completeRoute = createRoute({
  method: "post",
  path: "/{id}/complete",
  summary: "Complete a task",
  description: "Sets task status to done.",
  request: { params: IdParamsSchema },
  responses: {
    200: {
      description: "Task completed",
      content: { "application/json": { schema: TaskSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const failRoute = createRoute({
  method: "post",
  path: "/{id}/fail",
  summary: "Fail a task",
  description: "Sets task status to blocked.",
  request: { params: IdParamsSchema },
  responses: {
    200: {
      description: "Task failed",
      content: { "application/json": { schema: TaskSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const releaseRoute = createRoute({
  method: "post",
  path: "/{id}/release",
  summary: "Release a task",
  description: "Unclaims a task and sets status back to pending.",
  request: { params: IdParamsSchema },
  responses: {
    200: {
      description: "Task released",
      content: { "application/json": { schema: TaskSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Task not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

export function createTasksRoutes(
  taskService: TaskServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  app.openapi(listRoute, async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const stateRaw = c.req.query("state");

    // ?ready=true is the legacy spelling; ?state=ready is the new form.
    if (c.req.query("ready") === "true" || stateRaw === "ready") {
      // Pass repos to listReady for repo-scoped agent tokens.
      const tasks = await taskService.listReady(
        agentId ?? undefined,
        repos ?? undefined,
      );
      return c.json({ tasks: asTaskListJson(tasks), total: tasks.length }, 200);
    }

    // ?state=blocked delegates to listBlocked().
    if (stateRaw === "blocked") {
      const tasks = await taskService.listBlocked(
        agentId ?? undefined,
        repos !== null ? repos : undefined,
      );
      return c.json({ tasks: asTaskListJson(tasks), total: tasks.length }, 200);
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
      // Under agentScope, an explicit caller-supplied ?assignee= further narrows
      // the already-visible OR set (assigned-to-me OR in-my-repo-pool) — safe,
      // since it can only ever return a subset of what agentScope already
      // permits seeing. This differs from the non-scoped case below, where the
      // agent has no broader visible set to narrow from, so the token's own
      // agentId always wins over any caller-supplied ?assignee=.
      ...(useAgentScope
        ? {
            agentScope: { agentId: agentId as string, repos },
            ...(c.req.query("assignee")
              ? { assignee: c.req.query("assignee") }
              : {}),
          }
        : { assignee: agentId ?? c.req.query("assignee") }),
    });
    return c.json({ tasks: asTaskListJson(result.tasks), total: result.total, limit: result.limit, offset: result.offset }, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.openapi(createTaskRoute, async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const body = await readJson(c);
    if (typeof body.title !== "string" || !body.title) {
      throw new BadRequestError("title is required");
    }
    if (typeof body.status !== "string" || !body.status) {
      throw new BadRequestError("status is required");
    }
    if (!("repo" in body)) {
      throw new BadRequestError(
        "repo key is required (null is valid for unscoped tasks)",
      );
    }
    validateRepo(body.repo, agentId !== null ? repos : null);
    // Agent tokens force assignee to their own ID.
    if (agentId !== null) {
      body.assignee = agentId;
    }
    const created = await taskService.create(body as Prisma.TaskCreateInput);
    return c.json(asTaskJson(created), 201);
  });

  // ─── Bulk insert ───────────────────────────────────────────────────────────
  app.openapi(bulkRoute, async (c) => {
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
    // Validate repo presence and format on each task.
    for (const task of body as Record<string, unknown>[]) {
      if (!("repo" in task)) {
        throw new BadRequestError(
          "repo key is required (null is valid for unscoped tasks)",
        );
      }
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

  // ─── Distinct values ───────────────────────────────────────────────────────
  // Must be registered before /:id routes to avoid param capture.
  app.openapi(distinctRoute, async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    return c.json(
      await taskService.distinct(
        agentId ?? undefined,
        repos !== null ? repos : undefined,
      ),
      200,
    );
  });

  // ─── Get one ───────────────────────────────────────────────────────────────
  app.openapi(getTaskRoute, async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    const task = await requireOwnership(
      taskService,
      c.req.param("id"),
      agentId,
      repos,
    );
    return c.json(asTaskJson(task), 200);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  app.openapi(updateTaskRoute, async (c) => {
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
    // Only force-assign when the acting agent is the explicit assignee or claimedBy.
    // Skip force-assign when access is purely via repo scope — the task may belong
    // to a different agent and we should not silently steal it.
    const ownedByAssignee = task.assignee === agentId;
    const ownedByClaim = task.claimedBy === agentId;
    if (agentId !== null && task.assignee !== null && (ownedByAssignee || ownedByClaim)) {
      body.assignee = agentId;
    }
    const updated = await taskService.update(
      c.req.param("id"),
      body as Prisma.TaskUpdateInput,
    );
    return c.json(asTaskJson(updated), 200);
  });

  // ─── Delete ────────────────────────────────────────────────────────────────
  app.openapi(deleteTaskRoute, async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    await taskService.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // ─── Claim (atomic) ────────────────────────────────────────────────────────
  app.openapi(claimRoute, async (c) => {
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
    return c.json(asTaskJson(task), 200);
  });

  // ─── Heartbeat ─────────────────────────────────────────────────────────────
  app.openapi(heartbeatRoute, async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.heartbeat(c.req.param("id"));
    return c.json(asTaskJson(task), 200);
  });

  // ─── Complete ──────────────────────────────────────────────────────────────
  app.openapi(completeRoute, async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.complete(c.req.param("id"));
    return c.json(asTaskJson(task), 200);
  });

  // ─── Fail ──────────────────────────────────────────────────────────────────
  app.openapi(failRoute, async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const body = await readJson(c);
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const task = await taskService.fail(c.req.param("id"), reason);
    return c.json(asTaskJson(task), 200);
  });

  // ─── Release ───────────────────────────────────────────────────────────────
  app.openapi(releaseRoute, async (c) => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.release(c.req.param("id"));
    return c.json(asTaskJson(task), 200);
  });

  return app;
}
