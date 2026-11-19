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
 *   GET   /sessions        list (?state, ?sort, ?agentId, ?repo, ?org, ?q, ?owner, ?limit, ?cursor, ?accountId)
 *                          returns { sessions, total, limit, nextCursor }
 *   GET   /sessions/:slug  fetch one (404 when missing or out of agent scope)
 *   POST   /sessions/:slug/lock    acquire the planning lock (PLU-2.4; 409 when held)
 *   DELETE /sessions/:slug/lock    release it (403 for a non-holder)
 *   GET    /sessions/preflight/scope  which repos the token may write to (PLU-2.4)
 *   POST   /sessions/:slug/plan    write the plan document, its tasks and the
 *                          planned specs in ONE transaction (PWE-3.1); every
 *                          repo involved must be in an agent token's scope
 *                          (403), a lock held by someone else is 409, a task
 *                          id collision is 409 and rolls everything back.
 *   PATCH /sessions/:slug  rename/archive/owner/homeRepo (SESH-3.1,
 *                          PWE-1.1) — follows task-store scope: admin tokens
 *                          are unrestricted; an agent token may write when
 *                          every repo in the session (task repos + document
 *                          repos) is in its scope. 404 when the session is
 *                          not visible to the agent, 403 when visible but
 *                          not wholly in scope or when it has no repos.
 */

import { readJson } from "@app-vitals/agent-lib/http";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { resolveAccountScope } from "../account-scope.ts";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { DEFAULT_ACCOUNT_ID } from "../default-account.ts";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors.ts";
import type { Prisma } from "../index.ts";
import { rejectUnknownQuery } from "../lib/reject-unknown-query.ts";
import {
  ErrorSchema,
  ScopePreflightQuerySchema,
  ScopePreflightResponseSchema,
  SessionAccountQuerySchema,
  SessionListQuerySchema,
  SessionListResponseSchema,
  SessionLockBodySchema,
  SessionLockConflictSchema,
  SessionLockReleaseSchema,
  SessionLockSchema,
  SessionPatchBodySchema,
  SessionPlanBodySchema,
  SessionPlanResponseSchema,
  SessionSchema,
  SessionSlugParamSchema,
} from "../openapi-schemas.ts";
import type {
  SessionPlanDocumentInput,
  SessionPlanServiceLike,
} from "../session-plan-service.ts";
import type {
  SessionListFilters,
  SessionServiceLike,
  SessionUpdatePatch,
} from "../session-service.ts";
import { accountIdForCreate, validateBulkTasks } from "./tasks.ts";

// ─── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["sessions"],
  summary: "List sessions",
  description:
    "Returns `{ sessions, total, limit, nextCursor }` — each session's Task rows rolled up into a single object (`state`, `waitingSince`, `lastActivityAt`, per-status `counts`, distinct `agentIds`/`repos`, `waitingTasks`) flattened with the Session row's own fields. Each session also carries `owner`, `homeRepo` and its `documents`; `repos` is the distinct task repos, and `?owner=` filters on the exact owner email. Omitting `?state` defaults to non-archived, non-closed sessions. Every agent token (agentId set) is scoped: it only sees sessions with at least one qualifying task — one where `assignee === agentId` OR the task's repo is in the agent's resolved scope — or a document whose home repo or a target repo is in that scope; a token with no resolved repos degrades to assignee-only matching rather than unrestricted visibility. Only admin tokens see every session unrestricted. Agent tokens are pinned to their own account; admin tokens see every account's sessions (each labeled by `accountId`) unless `?accountId=` narrows to one. A session's rollup only counts tasks from its own account. `nextCursor` is an opaque cursor — pass it back as `?cursor=` to fetch the next page; it is `null` on the last page. A malformed cursor is a 400.",
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
    "Returns the same flattened session+rollup shape as the list route, including `owner`, `homeRepo`, `repos` and the session's `documents`. A session with no qualifying task is also visible to an agent token when one of its documents has its home repo or a target repo in the token's scope. Returns `404` if the session doesn't exist, or if an agent token has no qualifying task in it (same visibility rule as list) — the two cases are indistinguishable to the caller by design. Sessions are keyed by `[accountId, slug]`: agent tokens resolve the slug within their own account; admin tokens address `?accountId=` (default: `default`).",
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
  summary: "Update a session (title, archive, owner, homeRepo)",
  description:
    "Follows task-store scope. Admin tokens are unrestricted. An agent token may write only when EVERY repo in the session — the union of its task repos and document repos (home and target) — is in the token's repo scope. A session the agent cannot see (same visibility rule as `GET /sessions/:slug`, or another account's session) is `404`, indistinguishable from a missing one; a visible session only partly in scope is `403`; a session with no repos at all is admin-only (`403` for agents). `archivedBy` records the caller (the agent id, or `admin`). Body: `{ title?: string | null, archived?: boolean, owner?: string | null, homeRepo?: string | null }`, all optional (an empty body is a no-op). `owner`/`homeRepo` accept `null` to clear. A `repos` key is not part of the body and is ignored (a session's repos derive from its tasks and documents). `title: null` clears the title; `archived: true` sets `archivedAt`/`archivedBy`, `archived: false` clears both. Returns `404` if the session doesn't exist (or is not visible to the agent). Only the `[accountId, slug]` row is touched — `?accountId=` (default: `default`) — so another account's same-slug session is never renamed or archived.",
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
      description:
        "Forbidden — session not wholly within the agent token's repo scope, or has no repos (admin-only)",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const acquireLockRoute = createRoute({
  method: "post",
  path: "/:slug/lock",
  tags: ["sessions"],
  summary: "Acquire the session planning lock",
  description:
    "Takes a short-lived, self-expiring planning lock so a planning pass can read the plan and write tasks without another pass interleaving. Body (optional): `{ holder? }` — defaults to the token's agent id (`admin` for admin tokens). Returns `200 { holder, acquiredAt, expiresAt }`. If the lock is held and unexpired the response is `409` and the body names the `holder`, `acquiredAt` and `expiresAt`; an expired lock can be re-acquired, and the current holder re-acquiring just extends it. Agent tokens need the session in scope (404 otherwise); `404` when the session does not exist.",
  request: {
    params: SessionSlugParamSchema,
    query: SessionAccountQuerySchema,
    body: {
      content: { "application/json": { schema: SessionLockBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Lock acquired",
      content: { "application/json": { schema: SessionLockSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description: "Lock held and unexpired",
      content: { "application/json": { schema: SessionLockConflictSchema } },
    },
  },
});

const releaseLockRoute = createRoute({
  method: "delete",
  path: "/:slug/lock",
  tags: ["sessions"],
  summary: "Release the session planning lock",
  description:
    "Releases the planning lock after tasks are written and the plan is pushed. Body (optional): `{ holder? }` — defaults to the token's agent id (`admin` for admin tokens). Only the holder may release a live lock (`403` otherwise); releasing a free or expired lock is a no-op `200`. `404` when the session does not exist or is out of an agent token's scope.",
  request: {
    params: SessionSlugParamSchema,
    query: SessionAccountQuerySchema,
    body: {
      content: { "application/json": { schema: SessionLockBodySchema } },
      required: false,
    },
  },
  responses: {
    200: {
      description: "Lock released",
      content: { "application/json": { schema: SessionLockReleaseSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Lock held by someone else",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const scopePreflightRoute = createRoute({
  method: "get",
  path: "/preflight/scope",
  tags: ["sessions"],
  summary: "Scope preflight for a list of repos",
  description:
    "Read-only credential check, not a permission model: given `?repo=` (repeatable), reports which repos the calling token may write to (`covered`) and which it may not (`uncovered`). Admin tokens cover every repo; an agent token covers the repos in its resolved scope. Request order is preserved and duplicates collapse.",
  request: { query: ScopePreflightQuerySchema },
  responses: {
    200: {
      description: "Covered and uncovered repos",
      content: { "application/json": { schema: ScopePreflightResponseSchema } },
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

const planRoute = createRoute({
  method: "post",
  path: "/:slug/plan",
  tags: ["sessions"],
  summary:
    "Write a session's plan document, tasks and planned specs atomically",
  description:
    "One transaction for what a planning pass used to do in three calls (POST /documents, POST /tasks/bulk, PATCH /documents/:id). Ensures the session row (setting `owner` and `homeRepo` as POST /documents does), registers the plan document (number 1, idempotent), creates the tasks (same shape and validation as POST /tasks/bulk) stamped with the session, `planDocumentId`, `originKind: document` and `originRef` (the plan document id), and sets `plannedAt` on the listed specs. Agent tokens: every repo involved — the plan's `repo` and `repos`, every task `repo`, and every repo the session already spans — must be in the token's scope, else `403`. A planning lock held (unexpired) by anyone other than `holder` is a `409` with the lock body. A task id collision is a `409` (agent tokens get the generic `task id unavailable` body) and, like a webhook delivery failure (`502`) or an unregistered spec (`400`), rolls back everything — including the session row and the plan document. Re-sending the same plan is idempotent for the document and a `409` for task ids that already exist. Admin tokens may pass `?accountId=` (default: `default`). POST /tasks/bulk is unchanged.",
  request: {
    params: SessionSlugParamSchema,
    query: SessionAccountQuerySchema,
    body: {
      content: { "application/json": { schema: SessionPlanBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "Plan written: the plan document id and the inserted task count",
      content: { "application/json": { schema: SessionPlanResponseSchema } },
    },
    400: {
      description:
        "Bad request — malformed body, an invalid task (as POST /tasks/bulk), a task whose `session` differs from the slug, or an unregistered spec number",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description:
        "Forbidden — a repo in the request or the session is outside the agent token's scope, or the token's account scope could not be resolved",
      content: { "application/json": { schema: ErrorSchema } },
    },
    409: {
      description:
        "Conflict — the planning lock is held by someone else (lock body), or a task id is unavailable; nothing was written",
      content: { "application/json": { schema: SessionLockConflictSchema } },
    },
    502: {
      description: "Webhook delivery failed; nothing was written",
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

/** Lock holder: explicit body `holder`, else the token's agent id, else "admin". */
async function lockHolder(c: Context<TaskStoreAuthEnv>): Promise<string> {
  const raw = await c.req.text();
  let holder: unknown;
  if (raw.trim() !== "") {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new BadRequestError("body must be valid JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new BadRequestError("body must be a JSON object");
    }
    holder = (body as Record<string, unknown>).holder;
  }
  if (holder !== undefined) {
    if (typeof holder !== "string" || holder.length === 0) {
      throw new BadRequestError("holder must be a non-empty string");
    }
    return holder;
  }
  return c.get("agentId") ?? "admin";
}

/** Agent tokens must be able to see the session (same rule as GET /:slug). */
async function assertSessionVisible(
  sessionService: SessionServiceLike,
  c: Context<TaskStoreAuthEnv>,
): Promise<void> {
  const agentId = c.get("agentId");
  if (agentId === null) return;
  const visible = await sessionService.get(
    c.req.param("slug") as string,
    { agentId, repos: c.get("repos") ?? [] },
    slugAccountId(c),
  );
  if (!visible) throw new NotFoundError("session not found");
}

/**
 * PWE-1.1: gate a session write on the caller's scope. Admin tokens pass.
 * For an agent token: not visible (GET rule, own account only) => 404 so
 * existence never leaks; visible => every repo in the session (task repos,
 * document home + target repos) must be in the token's scope,
 * and a session with no repos is admin-only => 403. Returns the agent's repo
 * scope (null for admin).
 */
async function assertSessionWritable(
  sessionService: SessionServiceLike,
  c: Context<TaskStoreAuthEnv>,
): Promise<string[] | null> {
  const agentId = c.get("agentId");
  if (agentId === null) return null;
  const slug = c.req.param("slug") as string;
  const accountId = slugAccountId(c);
  const scope = c.get("repos") ?? [];

  const visible = await sessionService.get(
    slug,
    { agentId, repos: scope },
    accountId,
  );
  if (!visible) throw new NotFoundError("session not found");

  // Unscoped read: the visible view above filters documents to the agent's
  // scope, which would hide exactly the out-of-scope repos we must check.
  const full = await sessionService.get(slug, undefined, accountId);
  if (!full) throw new NotFoundError("session not found");
  const repos = new Set(full.repos);
  for (const d of full.documents) {
    repos.add(d.repo);
    for (const r of d.repos) repos.add(r);
  }
  if (repos.size === 0) {
    throw new ForbiddenError(
      "session has no repos; only admin tokens may update it",
    );
  }
  const outside = [...repos].filter((r) => !scope.includes(r));
  if (outside.length > 0) {
    throw new ForbiddenError(
      `session spans repos outside this token's scope: ${outside.join(", ")}`,
    );
  }
  return scope;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Disabled plan writer used when the feature is not wired up in a test context. */
const unwiredPlanService: SessionPlanServiceLike = {
  async plan() {
    throw new Error("session plan writes are not configured");
  },
};

export function createSessionsRoutes(
  sessionService: SessionServiceLike,
  planService: SessionPlanServiceLike = unwiredPlanService,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // ─── List ──────────────────────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma-shaped types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
    // PLU-1.1: a filter we don't recognise must 400, never silently widen.
    rejectUnknownQuery(c, SessionListQuerySchema);
    const agentId = c.get("agentId");
    const repos = c.get("repos");

    // Every agent token gets an auth scope — an empty `repos` means
    // "scoped-but-unknown" (fail-safe restrictive per auth.ts), not
    // "unrestricted", and degrades to assignee-only matching in the service.
    const useAgentScope = agentId !== null;

    const limitRaw = c.req.query("limit");
    const cursor = c.req.query("cursor");

    const filters: SessionListFilters = {
      state: c.req.query("state") as SessionListFilters["state"],
      sort: c.req.query("sort") as SessionListFilters["sort"],
      agentId: c.req.query("agentId"),
      repo: c.req.queries("repo"),
      org: c.req.queries("org"),
      q: c.req.query("q"),
      owner: c.req.query("owner"),
      accountId: resolveAccountScope(c),
      cursor,
      limit:
        limitRaw !== undefined
          ? Number.parseInt(limitRaw, 10) || undefined
          : undefined,
      ...(useAgentScope
        ? { agentScope: { agentId: agentId as string, repos: repos ?? [] } }
        : {}),
    };

    const result = await sessionService.list(filters);
    return c.json({ ...result, nextCursor: result.nextCursor ?? null }, 200);
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

  // ─── Patch (SESH-3.1; scoped writes, PWE-1.1) ───────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma-shaped types; JSON serialization handles Date→string correctly at runtime
  app.openapi(patchRoute, async (c): Promise<any> => {
    // Scope is checked before the body so an out-of-scope caller learns
    // nothing from validation errors.
    await assertSessionWritable(sessionService, c);

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
    for (const field of ["owner", "homeRepo"] as const) {
      if (field in body) {
        if (body[field] !== null && typeof body[field] !== "string") {
          throw new BadRequestError(`${field} must be a string or null`);
        }
        patch[field] = body[field] as string | null;
      }
    }
    const updated = await sessionService.update(
      c.req.param("slug"),
      patch,
      c.get("agentId") ?? "admin",
      slugAccountId(c),
    );
    return c.json(updated, 200);
  });

  // ─── Scope preflight (PLU-2.4) ─────────────────────────────────────────────
  // The two-segment path can never
  // match `/:slug`.
  app.openapi(scopePreflightRoute, async (c) => {
    rejectUnknownQuery(c, ScopePreflightQuerySchema);
    const asked = [...new Set(c.req.queries("repo") ?? [])];
    if (asked.length === 0 || asked.some((r) => r.length === 0)) {
      throw new BadRequestError("repo is required (one or more non-empty)");
    }
    const scope = c.get("repos");
    // Admin tokens (repos null) are unrestricted. An agent token with an empty
    // or degraded scope covers nothing.
    const isCovered = (r: string) =>
      c.get("agentId") === null || (scope ?? []).includes(r);
    return c.json(
      {
        covered: asked.filter(isCovered),
        uncovered: asked.filter((r) => !isCovered(r)),
      },
      200,
    );
  });

  // ─── Planning lock (PLU-2.4) ───────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: Date→string handled by JSON serialization
  app.openapi(acquireLockRoute, async (c): Promise<any> => {
    await assertSessionVisible(sessionService, c);
    const holder = await lockHolder(c);
    const lock = await sessionService.acquirePlanningLock(
      c.req.param("slug"),
      holder,
      slugAccountId(c),
    );
    return c.json(
      {
        holder: lock.holder,
        acquiredAt: lock.acquiredAt.toISOString(),
        expiresAt: lock.expiresAt.toISOString(),
      },
      200,
    );
  });

  // biome-ignore lint/suspicious/noExplicitAny: matches sibling handlers
  app.openapi(releaseLockRoute, async (c): Promise<any> => {
    await assertSessionVisible(sessionService, c);
    const holder = await lockHolder(c);
    await sessionService.releasePlanningLock(
      c.req.param("slug"),
      holder,
      slugAccountId(c),
    );
    return c.json({ released: true }, 200);
  });

  // ─── Plan write (PWE-3.1) ──────────────────────────────────────────────────
  // biome-ignore lint/suspicious/noExplicitAny: matches sibling handlers
  app.openapi(planRoute, async (c): Promise<any> => {
    const slug = c.req.param("slug") as string;
    const agentId = c.get("agentId");
    const body = await readJson(c);
    const plan = body.plan as SessionPlanDocumentInput;
    const tasks = body.tasks as Record<string, unknown>[];
    const specs = (body.specs ?? []) as number[];
    for (const task of tasks) {
      if (
        task.session !== undefined &&
        task.session !== null &&
        task.session !== slug
      ) {
        throw new BadRequestError(
          `task '${String(task.id)}' has session '${String(task.session)}', not '${slug}'`,
        );
      }
    }
    // Format and field checks exactly as POST /tasks/bulk. Scope is passed as
    // unrestricted here because the service enforces it as a 403 across
    // every repo in the request (bulk answers an out-of-scope task repo 400).
    const accountId = accountIdForCreate(c);
    validateBulkTasks(tasks, null, accountId);
    const holder =
      typeof body.holder === "string" ? body.holder : (agentId ?? "admin");

    try {
      const result = await planService.plan(
        {
          session: slug,
          accountId,
          holder,
          plan,
          tasks: tasks as Prisma.TaskCreateInput[],
          specs,
        },
        { repos: agentId === null ? null : (c.get("repos") ?? []) },
      );
      return c.json(result, 200);
    } catch (err) {
      // Same no-leak rule as POST /tasks/bulk for a task id collision (task
      // ids are global). The lock 409 carries its details and passes through.
      if (
        err instanceof ConflictError &&
        err.details === undefined &&
        c.get("accountId") !== null
      ) {
        throw new ConflictError("task id unavailable");
      }
      throw err;
    }
  });

  return app;
}
