/**
 * task-store/src/routes/system-crons.ts
 * System-cron definition management and the idempotent fire endpoint
 * (SCR-1.1).
 *
 * Returns an OpenAPIHono sub-app mounted at /system-crons by app.ts. Auth is
 * applied by the parent app. Every route here is admin-only — system crons are
 * a platform-level scheduler concern, and /fire creates unassigned tasks in
 * arbitrary repos, so agent tokens get 403 (mirrors PATCH /sessions/:slug).
 *
 * Account scope: admin tokens are unrestricted unless they pass ?accountId=,
 * which narrows list results and makes the single-definition routes 404 a
 * definition in another account. POST /system-crons stamps ?accountId= (or
 * DEFAULT_ACCOUNT_ID) on the new definition; generated tasks inherit the
 * definition's account.
 *
 * Routes:
 *   GET   /system-crons              list (?enabled, ?accountId) → { systemCrons }
 *   POST  /system-crons              create a definition → 201
 *   PATCH /system-crons/:id          update name/schedule/timezone/templates
 *   POST  /system-crons/:id/enable   set enabled=true
 *   POST  /system-crons/:id/disable  set enabled=false
 *   POST  /system-crons/:id/fire     {scheduledFor, repos} → 201 claimed:true
 *                                    (tasks created) | 200 claimed:false
 *                                    (slot already claimed, nothing created)
 */

import { readJson } from "@app-vitals/agent-lib/http";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  resolveAccountScope,
  resolveWriteAccountId,
} from "../account-scope.ts";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { ForbiddenError } from "../errors.ts";
import {
  CreateSystemCronBodySchema,
  ErrorSchema,
  FireSystemCronBodySchema,
  FireSystemCronResponseSchema,
  PatchSystemCronBodySchema,
  SystemCronAccountQuerySchema,
  SystemCronDefinitionSchema,
  SystemCronIdParamSchema,
  SystemCronListQuerySchema,
  SystemCronListResponseSchema,
} from "../openapi-schemas.ts";
import type {
  CreateSystemCronInput,
  SystemCronServiceLike,
  UpdateSystemCronInput,
} from "../system-cron-service.ts";

const TAGS = ["System Crons"];

const forbidden = {
  content: { "application/json": { schema: ErrorSchema } },
  description: "Forbidden — system-cron routes are admin-only",
};
const notFound = {
  content: { "application/json": { schema: ErrorSchema } },
  description:
    "Not found — no such definition, or it is outside the ?accountId= scope",
};
const badRequest = {
  content: { "application/json": { schema: ErrorSchema } },
  description: "Bad request — invalid or missing fields",
};
const definitionResponse = {
  content: { "application/json": { schema: SystemCronDefinitionSchema } },
  description: "The system-cron definition",
};

// ─── Route definitions ────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: TAGS,
  summary: "List system-cron definitions — admin-only",
  description:
    "Returns `{ systemCrons }`, ordered by id. `?enabled=true|false` filters by enabled state; `?accountId=` narrows to one account (omitted: every account).",
  request: { query: SystemCronListQuerySchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: SystemCronListResponseSchema },
      },
      description: "System-cron definitions",
    },
    403: forbidden,
  },
});

const createDefRoute = createRoute({
  method: "post",
  path: "/",
  tags: TAGS,
  summary: "Create a system-cron definition — admin-only",
  description:
    "Creates a definition in `?accountId=` (default: 'default'). `id` must be a lowercase slug; it is embedded in every generated task id. `schedule` must be a 5-field cron expression and `timezone` (default UTC) a valid IANA zone. A duplicate id is `409`.",
  request: {
    query: SystemCronAccountQuerySchema,
    body: {
      content: { "application/json": { schema: CreateSystemCronBodySchema } },
      required: true,
    },
  },
  responses: {
    201: { ...definitionResponse, description: "Created definition" },
    400: badRequest,
    403: forbidden,
    409: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Conflict — a definition with this id already exists",
    },
  },
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{id}",
  tags: TAGS,
  summary: "Update a system-cron definition — admin-only",
  description:
    "Updates any of `name`, `schedule`, `timezone`, `titleTemplate`, `descriptionTemplate`; omitted fields are untouched. Use /enable and /disable to toggle `enabled`.",
  request: {
    params: SystemCronIdParamSchema,
    query: SystemCronAccountQuerySchema,
    body: {
      content: { "application/json": { schema: PatchSystemCronBodySchema } },
      required: true,
    },
  },
  responses: {
    200: definitionResponse,
    400: badRequest,
    403: forbidden,
    404: notFound,
  },
});

const enableRoute = createRoute({
  method: "post",
  path: "/{id}/enable",
  tags: TAGS,
  summary: "Enable a system-cron definition — admin-only",
  description:
    "Sets `enabled: true` so /fire accepts the definition again. Idempotent.",
  request: {
    params: SystemCronIdParamSchema,
    query: SystemCronAccountQuerySchema,
  },
  responses: { 200: definitionResponse, 403: forbidden, 404: notFound },
});

const disableRoute = createRoute({
  method: "post",
  path: "/{id}/disable",
  tags: TAGS,
  summary: "Disable a system-cron definition — admin-only",
  description:
    "Sets `enabled: false`; a disabled definition's /fire is `409`. Idempotent.",
  request: {
    params: SystemCronIdParamSchema,
    query: SystemCronAccountQuerySchema,
  },
  responses: { 200: definitionResponse, 403: forbidden, 404: notFound },
});

const fireRoute = createRoute({
  method: "post",
  path: "/{id}/fire",
  tags: TAGS,
  summary: "Fire one slot of a system cron, exactly once — admin-only",
  description:
    "Claims the `(id, scheduledFor)` slot and, in the same transaction, creates one task per distinct repo: kind `dev`, status `pending`, `hitl: false`, no assignee, `source: 'system-cron'`, id `SC-{id}-{slot}-{owner}-{repo}` where slot is the compact UTC form of scheduledFor (`YYYYMMDDTHHMMSSZ`), and title/description rendered from the definition's templates by plain `{repo}` substitution (nothing else is evaluated). `scheduledFor` must carry an explicit timezone and is truncated to whole seconds. `201 { claimed: true, taskIds }` when this call claimed the slot; `200 { claimed: false, taskIds: [] }` when it was already claimed or a concurrent call won the race — nothing is created. A failed fire rolls back the claim with the tasks, so retrying is always safe. Disabled definition: `409`.",
  request: {
    params: SystemCronIdParamSchema,
    query: SystemCronAccountQuerySchema,
    body: {
      content: { "application/json": { schema: FireSystemCronBodySchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: FireSystemCronResponseSchema },
      },
      description: "Slot already claimed — nothing created (claimed: false)",
    },
    201: {
      content: {
        "application/json": { schema: FireSystemCronResponseSchema },
      },
      description: "Slot claimed — tasks created (claimed: true)",
    },
    400: badRequest,
    403: forbidden,
    404: notFound,
    409: {
      content: { "application/json": { schema: ErrorSchema } },
      description: "Conflict — the definition is disabled",
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

function requireAdmin(c: Context<TaskStoreAuthEnv>): void {
  if (c.get("agentId") !== null) {
    throw new ForbiddenError("system-cron routes are admin-only");
  }
}

/**
 * Copies the listed keys that are present in `body`. Types are not checked
 * here — the service validates every field (non-string → 400).
 */
function pickKeys<K extends string>(
  body: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) {
    if (body[k] !== undefined) out[k] = body[k] as string;
  }
  return out;
}

const PATCHABLE = [
  "name",
  "schedule",
  "timezone",
  "titleTemplate",
  "descriptionTemplate",
] as const;

export function createSystemCronsRoutes(
  service: SystemCronServiceLike,
): OpenAPIHono<TaskStoreAuthEnv> {
  const app = new OpenAPIHono<TaskStoreAuthEnv>();

  // Admin gate runs before body validation so agent tokens always get 403.
  app.use("*", async (c, next) => {
    requireAdmin(c);
    await next();
  });

  // biome-ignore lint/suspicious/noExplicitAny: service returns Prisma types; JSON serialization handles Date→string correctly at runtime
  app.openapi(listRoute, async (c): Promise<any> => {
    const enabledRaw = c.req.query("enabled");
    const systemCrons = await service.list({
      accountId: resolveAccountScope(c),
      enabled:
        enabledRaw === "true"
          ? true
          : enabledRaw === "false"
            ? false
            : undefined,
    });
    return c.json({ systemCrons }, 200);
  });

  // biome-ignore lint/suspicious/noExplicitAny: see above
  app.openapi(createDefRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const def = await service.create(
      {
        ...(pickKeys(body, ["id", ...PATCHABLE]) as CreateSystemCronInput),
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      },
      resolveWriteAccountId(c),
    );
    return c.json(def, 201);
  });

  // biome-ignore lint/suspicious/noExplicitAny: see above
  app.openapi(patchRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const def = await service.update(
      c.req.param("id"),
      pickKeys(body, PATCHABLE) as UpdateSystemCronInput,
      resolveAccountScope(c),
    );
    return c.json(def, 200);
  });

  // biome-ignore lint/suspicious/noExplicitAny: see above
  app.openapi(enableRoute, async (c): Promise<any> => {
    const def = await service.setEnabled(
      c.req.param("id"),
      true,
      resolveAccountScope(c),
    );
    return c.json(def, 200);
  });

  // biome-ignore lint/suspicious/noExplicitAny: see above
  app.openapi(disableRoute, async (c): Promise<any> => {
    const def = await service.setEnabled(
      c.req.param("id"),
      false,
      resolveAccountScope(c),
    );
    return c.json(def, 200);
  });

  // biome-ignore lint/suspicious/noExplicitAny: see above
  app.openapi(fireRoute, async (c): Promise<any> => {
    const body = await readJson(c);
    const result = await service.fire(
      c.req.param("id"),
      { scheduledFor: body.scheduledFor, repos: body.repos },
      resolveAccountScope(c),
    );
    return c.json(result, result.claimed ? 201 : 200);
  });

  return app;
}
