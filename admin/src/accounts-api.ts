/**
 * admin/src/accounts-api.ts
 * Admin-only /accounts API (SSP-5.1): list/get/create/patch self-serve
 * accounts. Flag-gated (404 when SHIPWRIGHT_SELF_SERVE_ENABLED is off, checked
 * before auth) and admin-only (admin cookie or scope "*" key); every other
 * caller class gets 403.
 *
 * POST /accounts goes through AccountService.create(), which seeds the owner
 * AccountMember row — so that owner's first login joins this account instead
 * of creating a new one.
 *
 * PATCH /accounts/:id routes through AccountLifecycle.update() (SSP-8.2):
 * status=suspended locks down the account's agents' crons, status=active
 * restores the lockdown-disabled ones (422 if trialExpiresAt is still past).
 */

import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { AccountLifecycle } from "./account-lifecycle.ts";
import type { AccountService, UpdateAccountInput } from "./accounts.ts";
import type { AgentTokenService } from "./agent-tokens.ts";
import {
  type AdminApiKey,
  type AdminAuthEnv,
  createAdminAuthMiddleware,
} from "./api-auth.ts";
import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "./errors.ts";
import {
  AccountIdParamSchema,
  AccountResponseSchema,
  AccountsListResponseSchema,
  CreateAccountBodySchema,
  ErrorSchema,
  PatchAccountBodySchema,
} from "./openapi-schemas.ts";
import type { SelfServeConfig } from "./self-serve-config.ts";

export interface AccountsApiDeps {
  accountService: Pick<
    AccountService,
    "listWithCounts" | "getWithCounts" | "create"
  >;
  /**
   * PATCH goes through the lifecycle so a status change runs its cron
   * lockdown/restore side effect (SSP-8.2).
   */
  accountLifecycle: Pick<AccountLifecycle, "update">;
  selfServe?: SelfServeConfig;
  sessionSecret: string;
  adminApiKeys?: Map<string, AdminApiKey>;
  agentTokenService: Pick<AgentTokenService, "validate">;
}

const jsonError = { content: { "application/json": { schema: ErrorSchema } } };

const errorResponses = {
  401: { description: "Unauthorized", ...jsonError },
  403: { description: "Forbidden (non-admin caller)", ...jsonError },
  404: { description: "Not found (or self-serve disabled)", ...jsonError },
};

const listAccountsRoute = createRoute({
  method: "get",
  path: "/accounts",
  tags: ["accounts"],
  summary: "List accounts",
  description:
    "Admin-only, flag-gated. Returns every account with agentCount and memberCount.",
  responses: {
    200: {
      description: "Accounts",
      content: { "application/json": { schema: AccountsListResponseSchema } },
    },
    ...errorResponses,
  },
});

const getAccountRoute = createRoute({
  method: "get",
  path: "/accounts/{id}",
  tags: ["accounts"],
  summary: "Get an account",
  description: "Admin-only, flag-gated.",
  request: { params: AccountIdParamSchema },
  responses: {
    200: {
      description: "Account",
      content: { "application/json": { schema: AccountResponseSchema } },
    },
    ...errorResponses,
  },
});

const createAccountRoute = createRoute({
  method: "post",
  path: "/accounts",
  tags: ["accounts"],
  summary: "Create an account",
  description:
    "Admin-only, flag-gated. Creates the account and seeds ownerEmail as its owner member, so that owner's first login joins this account. 409 if ownerEmail already belongs to an account.",
  request: {
    body: {
      content: { "application/json": { schema: CreateAccountBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Account created",
      content: { "application/json": { schema: AccountResponseSchema } },
    },
    400: { description: "Bad request", ...jsonError },
    409: { description: "Owner email already in an account", ...jsonError },
    ...errorResponses,
  },
});

const patchAccountRoute = createRoute({
  method: "patch",
  path: "/accounts/{id}",
  tags: ["accounts"],
  summary: "Update an account",
  description:
    "Admin-only, flag-gated. Updates name, maxAgents, plan, status and/or trialExpiresAt. status=suspended (or trial_expired) disables every enabled cron of the account's agents with a lockdown marker; status=active re-enables exactly those, and requires trialExpiresAt to be cleared or in the future (422 otherwise). Nothing is deleted.",
  request: {
    params: AccountIdParamSchema,
    body: {
      content: { "application/json": { schema: PatchAccountBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Account updated",
      content: { "application/json": { schema: AccountResponseSchema } },
    },
    400: { description: "Bad request", ...jsonError },
    422: {
      description: "Reactivation with trialExpiresAt still in the past",
      ...jsonError,
    },
    ...errorResponses,
  },
});

function serialize(a: {
  id: string;
  name: string;
  status: string;
  maxAgents: number;
  plan: string | null;
  trialExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  agentCount: number;
  memberCount: number;
}) {
  return {
    id: a.id,
    name: a.name,
    status: a.status as "active" | "suspended" | "trial_expired",
    maxAgents: a.maxAgents,
    plan: a.plan,
    trialExpiresAt: a.trialExpiresAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    agentCount: a.agentCount,
    memberCount: a.memberCount,
  };
}

export function createAccountsApp(
  deps: AccountsApiDeps,
): OpenAPIHono<AdminAuthEnv> {
  const { accountService, selfServe } = deps;

  const app = new OpenAPIHono<AdminAuthEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const message = result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(", ");
        return c.json({ error: message }, 400);
      }
    },
  });

  app.onError((err, c) => {
    if (err instanceof ApiError && err.statusCode < 500) {
      return c.json(
        { error: err.message },
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 422,
      );
    }
    if (err instanceof HTTPException && err.status < 500) {
      return c.json({ error: err.message }, err.status as 400 | 415);
    }
    console.error("[accounts-api] unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  const authMiddleware = createAdminAuthMiddleware({
    sessionSecret: deps.sessionSecret,
    agentTokenService: deps.agentTokenService,
    adminApiKeys: deps.adminApiKeys,
  });

  // Flag gate runs before auth so a disabled deployment reveals nothing.
  const flagGate: Parameters<typeof app.use>[1] = async (c, next) => {
    if (selfServe?.enabled !== true) return c.json({ error: "Not found" }, 404);
    return next();
  };
  // "/accounts/*" also matches the bare "/accounts" path in Hono.
  app.use("/accounts/*", flagGate);
  app.use("/accounts/*", authMiddleware);

  const requireAdmin = (c: { get: (k: "isAdmin") => unknown }) => {
    if (c.get("isAdmin") !== true) {
      throw new ForbiddenError("Admin access required");
    }
  };

  app.openapi(listAccountsRoute, async (c) => {
    requireAdmin(c);
    const accounts = await accountService.listWithCounts();
    return c.json({ accounts: accounts.map(serialize) }, 200);
  });

  app.openapi(getAccountRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    const account = await accountService.getWithCounts(id);
    if (!account) throw new NotFoundError(`account ${id} not found`);
    return c.json(serialize(account), 200);
  });

  app.openapi(createAccountRoute, async (c) => {
    requireAdmin(c);
    const body = c.req.valid("json");
    let createdId: string;
    try {
      const created = await accountService.create(body.name, body.ownerEmail, {
        maxAgents: body.maxAgents,
        ...(body.plan !== undefined ? { plan: body.plan } : {}),
        ...(body.trialExpiresAt !== undefined
          ? {
              trialExpiresAt: body.trialExpiresAt
                ? new Date(body.trialExpiresAt)
                : null,
            }
          : {}),
      });
      createdId = created.id;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        throw new ConflictError("ownerEmail already belongs to an account");
      }
      throw err;
    }
    const account = await accountService.getWithCounts(createdId);
    if (!account) throw new NotFoundError(`account ${createdId} not found`);
    return c.json(serialize(account), 201);
  });

  app.openapi(patchAccountRoute, async (c) => {
    requireAdmin(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    if (!(await accountService.getWithCounts(id))) {
      throw new NotFoundError(`account ${id} not found`);
    }
    const { trialExpiresAt, ...rest } = body;
    const data: UpdateAccountInput = {
      ...rest,
      ...(trialExpiresAt !== undefined
        ? { trialExpiresAt: trialExpiresAt ? new Date(trialExpiresAt) : null }
        : {}),
    };
    await deps.accountLifecycle.update(id, data);
    const account = await accountService.getWithCounts(id);
    if (!account) throw new NotFoundError(`account ${id} not found`);
    return c.json(serialize(account), 200);
  });

  return app;
}
