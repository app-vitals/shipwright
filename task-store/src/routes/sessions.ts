/**
 * task-store/src/routes/sessions.ts
 * Session read routes (SESH-2.2) — mirrors routes/tasks.ts's createRoute +
 * factory pattern.
 *
 * Returns an OpenAPIHono sub-app mounted at /sessions by app.ts. Auth is
 * applied by the parent app, so these handlers assume the caller is already
 * authenticated.
 *
 * Agent tokens are scoped the same way TaskService.list()'s `agentScope` and
 * distinct() are: `agentScope` is built only when the token has a non-empty
 * repo scope (`agentId !== null && repos !== null && repos.length > 0`,
 * mirroring routes/tasks.ts's `useAgentScope`). Admin tokens (agentId null)
 * are unrestricted.
 *
 * Routes:
 *   GET /sessions        list (?state, ?sort, ?agentId, ?repo, ?q, ?limit, ?offset)
 *                         returns { sessions, total, limit, offset }
 *   GET /sessions/:slug   fetch one (404 when missing or out of agent scope)
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { NotFoundError } from "../errors.ts";
import {
  ErrorSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionSchema,
  SessionSlugParamSchema,
} from "../openapi-schemas.ts";
import type {
  SessionListFilters,
  SessionServiceLike,
} from "../session-service.ts";

// ─── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["sessions"],
  summary: "List sessions",
  request: {
    query: SessionListQuerySchema,
  },
  responses: {
    200: {
      description: "List of sessions with total count",
      content: { "application/json": { schema: SessionListResponseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const getOneRoute = createRoute({
  method: "get",
  path: "/:slug",
  tags: ["sessions"],
  summary: "Get a session by slug",
  request: {
    params: SessionSlugParamSchema,
  },
  responses: {
    200: {
      description: "Session",
      content: { "application/json": { schema: SessionSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSessionsRoutes(
  sessionService: SessionServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma-shaped types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");

    // Same useAgentScope condition as routes/tasks.ts's listRoute: only build
    // an auth scope for agent tokens with a known, non-empty repo scope.
    const useAgentScope =
      agentId !== null && repos !== null && repos.length > 0;

    const limitRaw = c.req.query("limit");
    const offsetRaw = c.req.query("offset");

    const filters: SessionListFilters = {
      state: c.req.query("state") as SessionListFilters["state"],
      sort: c.req.query("sort") as SessionListFilters["sort"],
      agentId: c.req.query("agentId"),
      repo: c.req.queries("repo"),
      q: c.req.query("q"),
      limit:
        limitRaw !== undefined
          ? Number.parseInt(limitRaw, 10) || undefined
          : undefined,
      offset:
        offsetRaw !== undefined
          ? Number.parseInt(offsetRaw, 10) || undefined
          : undefined,
      ...(useAgentScope
        ? { agentScope: { agentId: agentId as string, repos } }
        : {}),
    };

    const result = await sessionService.list(filters);
    return c.json(result, 200);
  });

  // ─── Get one ───────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma-shaped types; JSON serialization handles Date→string correctly at runtime
  app.openapi(getOneRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    const repos = c.get("repos");
    const useAgentScope =
      agentId !== null && repos !== null && repos.length > 0;

    const session = await sessionService.get(
      c.req.param("slug"),
      useAgentScope ? { agentId: agentId as string, repos } : undefined,
    );
    if (!session) throw new NotFoundError("session not found");
    return c.json(session, 200);
  });

  return app;
}
