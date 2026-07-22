/**
 * task-store/src/routes/tasks.ts
 * Task CRUD + claim/heartbeat/complete/fail/release routes.
 *
 * Returns an OpenAPIHono sub-app mounted at /tasks by app.ts. Auth is applied
 * by the parent app, so these handlers assume the caller is already
 * authenticated.
 *
 * Agent tokens (agentId set) are scoped to their own tasks:
 *   - reads return only tasks where assignee === agentId
 *   - writes are blocked on tasks owned by other agents (403)
 *   - creates leave assignee as supplied by the caller, defaulting to
 *     null/unassigned (pool task) when omitted — not forced to agentId
 * Admin tokens (agentId null) have no restrictions.
 *
 * Routes:
 *   GET    /tasks               list (?status, ?state=open|closed, ?session, ?assignee, ?pr, ?branch, ?hitl=true|false, ?limit, ?offset, ?ready=true)
 *                              returns { tasks, total }
 *   POST   /tasks               create one (409 if id exists)
 *   POST   /tasks/bulk          insert array, skip 409s → { inserted, updated, skipped }
 *                              (skipped lists the IDs that collided with an existing task)
 *   GET    /tasks/:id           fetch one (404 when missing)
 *   PATCH  /tasks/:id           update
 *   DELETE /tasks/:id           delete
 *   POST   /tasks/:id/claim     atomic claim (409 when already claimed)
 *   POST   /tasks/:id/heartbeat touch heartbeatAt
 *   POST   /tasks/:id/complete  status=done
 *   POST   /tasks/:id/fail      status=blocked
 *   POST   /tasks/:id/release   unclaim → pending
 *   POST   /tasks/:id/skip      increment skipCount, auto-block at threshold
 *   POST   /tasks/:id/skip/reset  reset skipCount back to 0
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import type { Prisma } from "../index.ts";
import {
  BulkInsertBodySchema,
  BulkInsertResponseSchema,
  ClaimBodySchema,
  CreateTaskBodySchema,
  DistinctResponseSchema,
  ErrorSchema,
  FailBodySchema,
  TaskIdParamSchema,
  TaskListQuerySchema,
  TaskListResponseSchema,
  TaskSchema,
  UpdateTaskBodySchema,
} from "../openapi-schemas.ts";
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

// Fields that gate task claim ownership. Agent tokens must go through the
// dedicated /claim and /release routes to change these — never generic PATCH.
// requireOwnership() grants PATCH access via repo scope alone (not just
// assignee/claimant match), so without this guard a repo-scoped agent token
// could overwrite an actively claimed task's status back to "pending",
// making it immediately re-claimable by a different agent while the
// original session still holds it (TaskService.claim()'s atomic UPDATE
// gates solely on status = 'pending', never on claimedBy IS NULL).
const LIFECYCLE_GUARD_KEYS = ["claimedBy", "claimedAt", "heartbeatAt"] as const;

// admin tokens (agentId === null) are unrestricted, mirroring the existing
// admin-bypass convention already used by requireOwnership.
function assertNoLifecycleFieldWrite(
  body: Record<string, unknown>,
  agentId: string | null,
): void {
  if (agentId === null) return;
  for (const key of LIFECYCLE_GUARD_KEYS) {
    if (key in body) {
      throw new BadRequestError(
        `agent tokens cannot set '${key}' via PATCH — use /claim or /release`,
      );
    }
  }
  if (body.status === "pending") {
    throw new BadRequestError(
      "agent tokens cannot set status: 'pending' via PATCH — use /release to unclaim (or /claim to reclaim)",
    );
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

// ─── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["tasks"],
  summary: "List tasks",
  request: {
    query: TaskListQuerySchema,
  },
  responses: {
    200: {
      description: "List of tasks with total count",
      content: { "application/json": { schema: TaskListResponseSchema } },
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
  tags: ["tasks"],
  summary: "Create a task",
  request: {
    body: {
      content: { "application/json": { schema: CreateTaskBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Created task",
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
  },
});

const bulkRoute = createRoute({
  method: "post",
  path: "/bulk",
  tags: ["tasks"],
  summary: "Bulk insert tasks",
  request: {
    body: {
      content: { "application/json": { schema: BulkInsertBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Bulk insert result",
      content: { "application/json": { schema: BulkInsertResponseSchema } },
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
  tags: ["tasks"],
  summary: "Get distinct session and repo values",
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

const getOneRoute = createRoute({
  method: "get",
  path: "/:id",
  tags: ["tasks"],
  summary: "Get a task by ID",
  request: {
    params: TaskIdParamSchema,
  },
  responses: {
    200: {
      description: "Task",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/:id",
  tags: ["tasks"],
  summary: "Update a task",
  request: {
    params: TaskIdParamSchema,
    body: {
      content: { "application/json": { schema: UpdateTaskBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated task",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/:id",
  tags: ["tasks"],
  summary: "Delete a task",
  request: {
    params: TaskIdParamSchema,
  },
  responses: {
    204: {
      description: "Deleted",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const claimRoute = createRoute({
  method: "post",
  path: "/:id/claim",
  tags: ["tasks"],
  summary: "Atomically claim a task",
  request: {
    params: TaskIdParamSchema,
    body: {
      content: { "application/json": { schema: ClaimBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Claimed task",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Conflict — already claimed",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const heartbeatRoute = createRoute({
  method: "post",
  path: "/:id/heartbeat",
  tags: ["tasks"],
  summary: "Touch heartbeatAt on a claimed task",
  request: {
    params: TaskIdParamSchema,
  },
  responses: {
    200: {
      description: "Updated task",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const completeRoute = createRoute({
  method: "post",
  path: "/:id/complete",
  tags: ["tasks"],
  summary: "Mark a task as done",
  request: {
    params: TaskIdParamSchema,
  },
  responses: {
    200: {
      description: "Updated task",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const failRoute = createRoute({
  method: "post",
  path: "/:id/fail",
  tags: ["tasks"],
  summary: "Mark a task as blocked",
  request: {
    params: TaskIdParamSchema,
    body: {
      content: { "application/json": { schema: FailBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Updated task",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const releaseRoute = createRoute({
  method: "post",
  path: "/:id/release",
  tags: ["tasks"],
  summary: "Release a task back to pending",
  request: {
    params: TaskIdParamSchema,
  },
  responses: {
    200: {
      description: "Updated task",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const skipRoute = createRoute({
  method: "post",
  path: "/:id/skip",
  tags: ["tasks"],
  summary: "Record a skip — increments skipCount, auto-blocks at threshold",
  request: {
    params: TaskIdParamSchema,
  },
  responses: {
    200: {
      description: "Updated task",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const skipResetRoute = createRoute({
  method: "post",
  path: "/:id/skip/reset",
  tags: ["tasks"],
  summary: "Reset skip tracking — skipCount back to 0",
  request: {
    params: TaskIdParamSchema,
  },
  responses: {
    200: {
      description: "Updated task",
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
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createTasksRoutes(
  taskService: TaskServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const stateRaw = c.req.query("state");

    // Note: ?updatedSince is intentionally NOT threaded into listReady()/
    // listBlocked() below. Both are convenience endpoints computed over the
    // *entire* task graph (dependency resolution needs every task, not a
    // recency-windowed subset) and the acceptance criteria for this filter
    // only cover the plain GET /tasks list path, not these two branches.
    // ?ready=true is the legacy spelling; ?state=ready is the new form.
    if (c.req.query("ready") === "true" || stateRaw === "ready") {
      // Pass repos to listReady for repo-scoped agent tokens.
      const tasks = await taskService.listReady(
        agentId ?? undefined,
        repos ?? undefined,
      );
      return c.json({ tasks, total: tasks.length }, 200);
    }

    // ?state=blocked delegates to listBlocked().
    if (stateRaw === "blocked") {
      const tasks = await taskService.listBlocked(
        agentId ?? undefined,
        repos !== null ? repos : undefined,
      );
      return c.json({ tasks, total: tasks.length }, 200);
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
      source: c.req.query("source"),
      session: c.req.query("session"),
      repo: c.req.query("repo"),
      claimedBy: c.req.query("claimedBy"),
      pr: prRaw !== undefined ? Number.parseInt(prRaw, 10) : undefined,
      branch: c.req.query("branch"),
      hitl:
        c.req.query("hitl") === "true"
          ? true
          : c.req.query("hitl") === "false"
            ? false
            : undefined,
      limit:
        limitRaw !== undefined
          ? Number.parseInt(limitRaw, 10) || undefined
          : undefined,
      offset:
        offsetRaw !== undefined
          ? Number.parseInt(offsetRaw, 10) || undefined
          : undefined,
      sort: c.req.query("sort") === "desc" ? "desc" : undefined,
      updatedSince: c.req.query("updatedSince"),
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
    return c.json(result, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(createTaskRoute, async (c): Promise<any> => {
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
    const created = await taskService.create(body as Prisma.TaskCreateInput);
    return c.json(created, 201);
  });

  // ─── Bulk insert ───────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(bulkRoute, async (c): Promise<any> => {
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
    const result = await taskService.bulk(body as Prisma.TaskCreateInput[]);
    return c.json(result, 200);
  });

  // ─── Distinct values ───────────────────────────────────────────────────────
  // Must be registered before /:id routes to avoid param capture.
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(distinctRoute, async (c): Promise<any> => {
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
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(getOneRoute, async (c): Promise<any> => {
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
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(updateRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const task = await requireOwnership(
      taskService,
      c.req.param("id"),
      agentId,
      repos ?? [],
    );
    const body = await readJson(c);
    assertNoLifecycleFieldWrite(body, agentId);
    validateRepo(body.repo, agentId !== null ? repos : null);
    // Prevent agent tokens from reassigning tasks outside their ownership scope.
    // Only force-assign when the acting agent is the explicit assignee or claimedBy.
    // Skip force-assign when access is purely via repo scope — the task may belong
    // to a different agent and we should not silently steal it.
    const ownedByAssignee = task.assignee === agentId;
    const ownedByClaim = task.claimedBy === agentId;
    if (
      agentId !== null &&
      task.assignee !== null &&
      (ownedByAssignee || ownedByClaim)
    ) {
      body.assignee = agentId;
    }
    const updated = await taskService.update(
      c.req.param("id"),
      body as Prisma.TaskUpdateInput,
    );
    return c.json(updated, 200);
  });

  // ─── Delete ────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(deleteRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    await taskService.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  // ─── Claim (atomic) ────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(claimRoute, async (c): Promise<any> => {
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
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(heartbeatRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.heartbeat(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Complete ──────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(completeRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.complete(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Fail ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(failRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const body = await readJson(c);
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const task = await taskService.fail(c.req.param("id"), reason);
    return c.json(task, 200);
  });

  // ─── Release ───────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(releaseRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.release(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Skip ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(skipRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.recordSkip(c.req.param("id"));
    return c.json(task, 200);
  });

  // ─── Skip reset ────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(skipResetRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos") ?? [];
    await requireOwnership(taskService, c.req.param("id"), agentId, repos);
    const task = await taskService.resetSkip(c.req.param("id"));
    return c.json(task, 200);
  });

  return app;
}
