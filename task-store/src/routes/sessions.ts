/**
 * task-store/src/routes/sessions.ts
 * Session read routes (SESH-2.2) — mirrors routes/tasks.ts's createRoute +
 * factory pattern.
 *
 * Returns an OpenAPIHono sub-app mounted at /sessions by app.ts. Auth is
 * applied by the parent app, so these handlers assume the caller is already
 * authenticated.
 *
 * Agent tokens are ALWAYS scoped: `agentScope` is built for every token with a
 * non-null `agentId`, regardless of whether its resolved `repos` list is empty.
 * An empty `repos` (resolver failure or a legitimately zero-repo agent — see
 * auth.ts's fail-safe-restrictive fallback) degrades naturally to assignee-only
 * visibility inside SessionService's `hasQualifyingTask()`, rather than to
 * unrestricted visibility. Only admin tokens (agentId null) are unrestricted.
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

    // Every agent token gets an auth scope — an empty `repos` means
    // "scoped-but-unknown" (fail-safe restrictive per auth.ts), not
    // "unrestricted", and degrades to assignee-only matching in the service.
    const useAgentScope = agentId !== null;

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
        ? { agentScope: { agentId: agentId as string, repos: repos ?? [] } }
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
    // Same always-scope-agent-tokens rule as the list route above.
    const useAgentScope = agentId !== null;

    const session = await sessionService.get(
      c.req.param("slug"),
      useAgentScope
        ? { agentId: agentId as string, repos: repos ?? [] }
        : undefined,
    );
    if (!session) throw new NotFoundError("session not found");
    return c.json(session, 200);
  });

  return app;
}
