/**
 * chat/src/routes/threads.ts
 * Thread CRUD routes.
 *
 * Routes:
 *   GET    /threads         list (scoped to agentId for agent tokens)
 *   POST   /threads         create
 *   GET    /threads/:id     get
 *   PATCH  /threads/:id     update title / memberId
 *   DELETE /threads/:id     delete
 *
 * Agent token: all operations are scoped to threads owned by that agentId.
 * Admin token: full access; can filter by ?agentId or ?memberId.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ChatAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import {
  ErrorSchema,
  ThreadSchema,
  ThreadStatsSchema,
} from "../openapi-schemas.ts";
import type { ThreadServiceLike } from "../thread-service.ts";
import { parseIntParam } from "./utils.ts";

// ─── Extra schemas for thread routes ──────────────────────────────────────────

const ThreadListQuerySchema = z.object({
  limit: z.string().optional().openapi({ example: "50" }),
  offset: z.string().optional().openapi({ example: "0" }),
  agentId: z.string().optional().openapi({ example: "agent-id-123" }),
  memberId: z.string().optional().openapi({ example: "member-id-123" }),
});

const ThreadListResponseSchema = z
  .object({
    threads: z.array(ThreadSchema),
    total: z.number().int().openapi({ example: 10 }),
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
  })
  .openapi("ThreadListResponse");

const CreateThreadBodySchema = z
  .object({
    agentId: z.string().openapi({ example: "agent-id-123" }),
    memberId: z.string().optional().openapi({ example: "member-id-123" }),
    title: z.string().optional().openapi({ example: "Deployment question" }),
  })
  .openapi("CreateThreadBody");

const UpdateThreadBodySchema = z
  .object({
    title: z.string().nullable().optional().openapi({ example: "New title" }),
    memberId: z
      .string()
      .nullable()
      .optional()
      .openapi({ example: "member-id-123" }),
  })
  .openapi("UpdateThreadBody");

const ThreadIdParamSchema = z.object({
  id: z.string().openapi({ example: "clxthread123456" }),
});

// ─── Route definitions ────────────────────────────────────────────────────────

const listThreadsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["threads"],
  summary: "List threads (scoped to agentId for agent tokens)",
  security: [{ bearerAuth: [] }],
  request: {
    query: ThreadListQuerySchema,
  },
  responses: {
    200: {
      description: "List of threads with total count",
      content: { "application/json": { schema: ThreadListResponseSchema } },
    },
  },
});

const createThreadRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["threads"],
  summary: "Create a thread",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: CreateThreadBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Created thread",
      content: { "application/json": { schema: ThreadSchema } },
    },
    400: {
      description: "Bad request — agentId is required",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden — agent token may only create threads for itself",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getThreadStatsRoute = createRoute({
  method: "get",
  path: "/:id/stats",
  tags: ["threads"],
  summary: "Get aggregated stats for a thread",
  security: [{ bearerAuth: [] }],
  request: {
    params: ThreadIdParamSchema,
  },
  responses: {
    200: {
      description: "Aggregated thread stats",
      content: { "application/json": { schema: ThreadStatsSchema } },
    },
    403: {
      description: "Forbidden — agent token may not access this thread",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Thread not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getThreadRoute = createRoute({
  method: "get",
  path: "/:id",
  tags: ["threads"],
  summary: "Get a thread by id",
  security: [{ bearerAuth: [] }],
  request: {
    params: ThreadIdParamSchema,
  },
  responses: {
    200: {
      description: "Thread",
      content: { "application/json": { schema: ThreadSchema } },
    },
    403: {
      description: "Forbidden — agent token may not access this thread",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Thread not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateThreadRoute = createRoute({
  method: "patch",
  path: "/:id",
  tags: ["threads"],
  summary: "Update thread title and/or memberId",
  security: [{ bearerAuth: [] }],
  request: {
    params: ThreadIdParamSchema,
    body: {
      required: false,
      content: { "application/json": { schema: UpdateThreadBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated thread",
      content: { "application/json": { schema: ThreadSchema } },
    },
    403: {
      description: "Forbidden — agent token may not access this thread",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Thread not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const deleteThreadRoute = createRoute({
  method: "delete",
  path: "/:id",
  tags: ["threads"],
  summary: "Delete a thread",
  security: [{ bearerAuth: [] }],
  request: {
    params: ThreadIdParamSchema,
  },
  responses: {
    200: {
      description: "Deleted thread",
      content: { "application/json": { schema: ThreadSchema } },
    },
    403: {
      description: "Forbidden — agent token may not access this thread",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Thread not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createThreadsRoutes(
  threadService: ThreadServiceLike,
): OpenAPIHono<ChatAuthEnv> {
  const app = new OpenAPIHono<ChatAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  app.openapi(listThreadsRoute, async (c) => {
    const callerAgentId = c.get("agentId");
    const limit = parseIntParam(c.req.query("limit"), 50);
    const offset = parseIntParam(c.req.query("offset"), 0);

    // Agent tokens are restricted to their own threads.
    const agentId =
      callerAgentId !== null
        ? callerAgentId
        : (c.req.query("agentId") ?? undefined);
    const memberId = c.req.query("memberId") ?? undefined;

    const { threads, total } = await threadService.list({
      agentId,
      memberId,
      limit,
      offset,
    });
    return c.json({ threads, total, limit, offset }, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.openapi(createThreadRoute, async (c) => {
    const callerAgentId = c.get("agentId");

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body → fall through to validation below
    }

    const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
    if (!agentId) throw new BadRequestError("agentId is required");

    // Agent tokens can only create threads for themselves.
    if (callerAgentId !== null && callerAgentId !== agentId) {
      throw new ForbiddenError(
        "agent token may only create threads for its own agentId",
      );
    }

    const memberId =
      typeof body.memberId === "string" ? body.memberId : undefined;
    const title = typeof body.title === "string" ? body.title : undefined;

    const thread = await threadService.create({ agentId, memberId, title });
    return c.json(thread, 201);
  });

  // ─── Stats ─────────────────────────────────────────────────────────────────
  app.openapi(getThreadStatsRoute, async (c) => {
    const thread = await threadService.findById(c.req.param("id"));
    if (!thread) throw new NotFoundError("thread not found");
    enforceAgentScope(c.get("agentId"), thread.agentId);
    const stats = await threadService.getStats(thread);
    return c.json(stats, 200);
  });

  // ─── Get ───────────────────────────────────────────────────────────────────
  app.openapi(getThreadRoute, async (c) => {
    const thread = await threadService.findById(c.req.param("id"));
    if (!thread) throw new NotFoundError("thread not found");
    enforceAgentScope(c.get("agentId"), thread.agentId);
    return c.json(thread, 200);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  app.openapi(updateThreadRoute, async (c) => {
    const thread = await threadService.findById(c.req.param("id"));
    if (!thread) throw new NotFoundError("thread not found");
    enforceAgentScope(c.get("agentId"), thread.agentId);

    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      // empty body → no-op update
    }

    const title = "title" in body ? (body.title as string | null) : undefined;
    const memberId =
      "memberId" in body ? (body.memberId as string | null) : undefined;

    const updated = await threadService.update(c.req.param("id"), {
      title,
      memberId,
    });
    if (!updated) throw new NotFoundError("thread not found");
    return c.json(updated, 200);
  });

  // ─── Delete ────────────────────────────────────────────────────────────────
  app.openapi(deleteThreadRoute, async (c) => {
    const thread = await threadService.findById(c.req.param("id"));
    if (!thread) throw new NotFoundError("thread not found");
    enforceAgentScope(c.get("agentId"), thread.agentId);

    const deleted = await threadService.delete(c.req.param("id"));
    if (!deleted) throw new NotFoundError("thread not found");
    return c.json(deleted, 200);
  });

  return app;
}

function enforceAgentScope(
  callerAgentId: string | null,
  threadAgentId: string,
): void {
  if (callerAgentId !== null && callerAgentId !== threadAgentId) {
    throw new ForbiddenError("agent token may not access this thread");
  }
}
