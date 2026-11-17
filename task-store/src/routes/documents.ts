/**
 * task-store/src/routes/documents.ts
 * Planning document routes (PLU-2.2). Mounted at /documents by app.ts; auth is
 * applied by the parent app.
 *
 * Routes:
 *   POST  /documents      register a document — idempotent on
 *                         (accountId, session, kind, number); re-registering
 *                         updates prUrl/title/owner/repos/state. Ensures the
 *                         session row, sets its owner from the first document
 *                         only, and sets homeRepo when empty. 403 when the home
 *                         repo is outside an agent token's repo scope.
 *   GET   /documents      list (?session, ?kind, ?owner, ?planned, ?accountId);
 *                         unknown parameters are 400 (PLU-1.1 helper).
 *   PATCH /documents/:id  set plannedAt / prUrl / owner / state.
 */

import { readJson } from "@app-vitals/agent-lib/http";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  resolveAccountScope,
  resolveWriteAccountId,
} from "../account-scope.ts";
import type { TaskStoreAuthEnv } from "../auth.ts";
import type {
  DocumentListFilters,
  DocumentScope,
  DocumentServiceLike,
  PatchDocumentInput,
  RegisterDocumentInput,
} from "../document-service.ts";
import { BadRequestError } from "../errors.ts";
import { rejectUnknownQuery } from "../lib/reject-unknown-query.ts";
import {
  ErrorSchema,
  PatchPlanDocumentBodySchema,
  PlanDocumentIdParamSchema,
  PlanDocumentListQuerySchema,
  PlanDocumentListResponseSchema,
  PlanDocumentSchema,
  RegisterPlanDocumentBodySchema,
} from "../openapi-schemas.ts";

const registerRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["documents"],
  summary: "Register a planning document",
  description:
    "Idempotent on `(accountId, session, kind, number)`: registering the same key again updates `prUrl`, `title`, `owner`, `repos` and `state` on the one row. Ensures the session row exists, sets the session's `owner` from the first document that carries one (never overwritten by later documents) and sets its `homeRepo` when empty. Plans are always number 1. Agent tokens: `repo` — and the repo of any existing document at that key — must be in the token's repo scope, else `403`. Admin tokens may pass `?accountId=` (default: `default`).",
  request: {
    body: {
      content: {
        "application/json": { schema: RegisterPlanDocumentBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Registered (or re-registered) document",
      content: { "application/json": { schema: PlanDocumentSchema } },
    },
    400: {
      description: "Bad request — missing/invalid fields",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description:
        "Forbidden — `repo`, or the existing document's repo, is outside the token's repo scope",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["documents"],
  summary: "List planning documents",
  description:
    "Returns `{ documents, total }`. `?planned=false` returns specs with no `plannedAt` and excludes `abandoned` ones; `?planned=true` returns documents with `plannedAt` set. Any query parameter not documented here is rejected with `400`. Agent tokens only see documents in their account whose home repo is in the token's repo scope.",
  request: { query: PlanDocumentListQuerySchema },
  responses: {
    200: {
      description: "Matching documents",
      content: {
        "application/json": { schema: PlanDocumentListResponseSchema },
      },
    },
    400: {
      description: "Bad request — unknown query parameter",
      content: { "application/json": { schema: ErrorSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/:id",
  tags: ["documents"],
  summary: "Update a planning document",
  description:
    "Sets any of `plannedAt` (specs only; null clears), `prUrl`, `owner`, `state`. Omitted fields are untouched. `404` when the document does not exist or is outside the caller's scope.",
  request: {
    params: PlanDocumentIdParamSchema,
    body: {
      content: {
        "application/json": { schema: PatchPlanDocumentBodySchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Updated document",
      content: { "application/json": { schema: PlanDocumentSchema } },
    },
    400: {
      description: "Bad request — invalid field",
      content: { "application/json": { schema: ErrorSchema } },
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

function callerScope(c: Context<TaskStoreAuthEnv>): DocumentScope {
  return { repos: c.get("repos"), accountId: resolveAccountScope(c) };
}

function optString(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in body) || body[key] === undefined) return undefined;
  const v = body[key];
  if (v !== null && typeof v !== "string") {
    throw new BadRequestError(`${key} must be a string or null`);
  }
  return v as string | null;
}

export function createDocumentsRoutes(
  service: DocumentServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string
  app.openapi(registerRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const input: RegisterDocumentInput = {
      session: typeof body.session === "string" ? body.session : "",
      kind: body.kind as RegisterDocumentInput["kind"],
      number: typeof body.number === "number" ? body.number : undefined,
      repo: typeof body.repo === "string" ? body.repo : "",
      path: typeof body.path === "string" ? body.path : "",
      title: optString(body, "title"),
      owner: optString(body, "owner"),
      prUrl: optString(body, "prUrl"),
      commitSha: optString(body, "commitSha"),
      originTaskId: optString(body, "originTaskId"),
      state: body.state as RegisterDocumentInput["state"],
    };
    if (body.kind !== "spec" && body.kind !== "plan") {
      throw new BadRequestError("kind must be 'spec' or 'plan'");
    }
    if (body.number !== undefined && !Number.isInteger(body.number)) {
      throw new BadRequestError("number must be an integer");
    }
    if (body.repos !== undefined) {
      if (
        !Array.isArray(body.repos) ||
        body.repos.some((r) => typeof r !== "string")
      ) {
        throw new BadRequestError("repos must be an array of strings");
      }
      input.repos = body.repos as string[];
    }
    const doc = await service.register(
      input,
      resolveWriteAccountId(c),
      callerScope(c),
    );
    return c.json(doc, 200);
  });

  // biome-ignore lint/suspicious/noExplicitAny: see above
  app.openapi(listRoute, async (c): Promise<any> => {
    rejectUnknownQuery(c, PlanDocumentListQuerySchema);
    const planned = c.req.query("planned");
    const kind = c.req.query("kind");
    if (planned !== undefined && planned !== "true" && planned !== "false") {
      throw new BadRequestError("planned must be 'true' or 'false'");
    }
    if (kind !== undefined && kind !== "spec" && kind !== "plan") {
      throw new BadRequestError("kind must be 'spec' or 'plan'");
    }
    const filters: DocumentListFilters = {
      session: c.req.query("session"),
      kind: kind as DocumentListFilters["kind"],
      owner: c.req.query("owner"),
      planned: planned === undefined ? undefined : planned === "true",
    };
    return c.json(await service.list(filters, callerScope(c)), 200);
  });

  // biome-ignore lint/suspicious/noExplicitAny: see above
  app.openapi(patchRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const patch: PatchDocumentInput = {};
    if ("plannedAt" in body) {
      const v = body.plannedAt;
      if (
        v !== null &&
        (typeof v !== "string" || Number.isNaN(Date.parse(v)))
      ) {
        throw new BadRequestError("plannedAt must be an ISO timestamp or null");
      }
      patch.plannedAt = v as string | null;
    }
    const prUrl = optString(body, "prUrl");
    if (prUrl !== undefined) patch.prUrl = prUrl;
    const owner = optString(body, "owner");
    if (owner !== undefined) patch.owner = owner;
    if ("state" in body) {
      patch.state = body.state as PatchDocumentInput["state"];
    }
    const doc = await service.patch(c.req.param("id"), patch, callerScope(c));
    return c.json(doc, 200);
  });

  return app;
}
