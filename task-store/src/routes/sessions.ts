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
 * Account scope (SSP-6.7): sessions are keyed by [accountId, slug]. Agent
 * tokens are pinned to their resolved account (a client `?accountId=` is
 * ignored). Admin tokens list every account's sessions (each labeled by
 * `accountId`) unless they pass `?accountId=`; the single-session routes
 * (GET/PATCH /:slug) address one account's row — the admin's `?accountId=`,
 * or DEFAULT_ACCOUNT_ID when omitted.
 *
 * Routes:
 *   GET   /sessions        list (?state, ?sort, ?agentId, ?repo, ?org, ?q, ?limit, ?offset, ?accountId)
 *                          returns { sessions, total, limit, offset }
 *   GET   /sessions/:slug  fetch one (404 when missing or out of agent scope)
 *   PATCH /sessions/:slug  rename/archive (SESH-3.1) — admin-only, 403 for
 *                          agent tokens regardless of ownership; unlike the
 *                          GET routes above, there is no agent-scoped
 *                          visibility carve-out for this write.
 */

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { DEFAULT_ACCOUNT_ID } from "@shipwright/lib/default-account";
import { readJson } from "@shipwright/lib/http";
import type { Context } from "hono";
import { resolveAccountScope } from "../account-scope.ts";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import {
  ErrorSchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionPatchBodySchema,
  SessionSchema,
  SessionSlugParamSchema,
  SessionAccountQuerySchema,
} from "../openapi-schemas.ts";
import type {
  SessionListFilters,
  SessionServiceLike,
  SessionUpdatePatch,
} from "../session-service.ts";

// ─── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["sessions"],
  summary: "List sessions",
  description:
    "Returns `{ sessions, total, limit, offset }` — each session's Task rows rolled up into a single object (`state`, `waitingSince`, `lastActivityAt`, per-status `counts`, distinct `agentIds`/`repos`, `waitingTasks`) flattened with the Session row's own fields. Omitting `?state` defaults to non-archived, non-closed sessions. Every agent token (agentId set) is scoped: it only sees sessions with at least one qualifying task — one where `assignee === agentId` OR the task's repo is in the agent's resolved scope; a token with no resolved repos degrades to assignee-only matching rather than unrestricted visibility. Only admin tokens see every session unrestricted. Agent tokens are pinned to their own account; admin tokens see every account's sessions (each labeled by `accountId`) unless `?accountId=` narrows to one. A session's rollup only counts tasks from its own account.",
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
  description:
    "Returns the same flattened session+rollup shape as the list route. Returns `404` if the session doesn't exist, or if an agent token has no qualifying task in it (same visibility rule as list) — the two cases are indistinguishable to the caller by design. Sessions are keyed by `[accountId, slug]`: agent tokens resolve the slug within their own account; admin tokens address `?accountId=` (default: `default`).",
  request: {
    params: SessionSlugParamSchema,
    query: SessionAccountQuerySchema,
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

const patchRoute = createRoute({
  method: "patch",
  path: "/:slug",
  tags: ["sessions"],
  summary: "Rename/archive a session — admin-only",
  description:
    "Admin-only, no exceptions — agent tokens get `403` regardless of ownership. Body: `{ title?: string | null, archived?: boolean }`, both optional (an empty body is a no-op). `title: null` clears the title; `archived: true` sets `archivedAt`/`archivedBy`, `archived: false` clears both. Returns `404` if the session doesn't exist. Only the `[accountId, slug]` row is touched — `?accountId=` (default: `default`) — so another account's same-slug session is never renamed or archived.",
  request: {
    params: SessionSlugParamSchema,
    query: SessionAccountQuerySchema,
    body: {
      content: { "application/json": { schema: SessionPatchBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated session",
      content: { "application/json": { schema: SessionSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden — admin tokens only",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The single account a GET/PATCH /:slug addresses: the caller's account scope
 * (agent: pinned; admin: ?accountId=), else DEFAULT_ACCOUNT_ID so an admin
 * without ?accountId= keeps the pre-SSP-6.7 default-account behavior.
 */
function slugAccountId(c: Context<TaskStoreAuthEnv>): string {
  return resolveAccountScope(c) ?? DEFAULT_ACCOUNT_ID;
}

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
      org: c.req.queries("org"),
      q: c.req.query("q"),
      accountId: resolveAccountScope(c),
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
      slugAccountId(c),
    );
    if (!session) throw new NotFoundError("session not found");
    return c.json(session, 200);
  });

  // ─── Patch (rename/archive, SESH-3.1) ──────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma-shaped types; JSON serialization handles Date→string correctly at runtime
  app.openapi(patchRoute, async (c): Promise<any> => {
    const agentId = c.get("agentId");
    // Admin-only, no exceptions — unlike the GET routes, agent-scoped tokens
    // never get read-through visibility into a write here.
    if (agentId !== null) {
      throw new ForbiddenError("session updates are admin-only");
    }

    const body = await readJson(c);
    const patch: SessionUpdatePatch = {};
    if ("title" in body) {
      if (body.title !== null && typeof body.title !== "string") {
        throw new BadRequestError("title must be a string or null");
      }
      patch.title = body.title as string | null;
    }
    if ("archived" in body) {
      if (typeof body.archived !== "boolean") {
        throw new BadRequestError("archived must be a boolean");
      }
      patch.archived = body.archived;
    }

    const updated = await sessionService.update(
      c.req.param("slug"),
      patch,
      "admin",
      slugAccountId(c),
    );
    return c.json(updated, 200);
  });

  return app;
}
