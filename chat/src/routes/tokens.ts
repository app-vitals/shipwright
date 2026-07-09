/**
 * chat/src/routes/tokens.ts
 * Token management routes — admin tokens only.
 *
 * Returns an OpenAPIHono sub-app mounted at /tokens by app.ts. Auth is applied
 * by the parent app. All routes here require an admin token (agentId === null).
 *
 * Routes:
 *   GET    /tokens       list (hash + metadata, never raw values)
 *   POST   /tokens       create — returns the raw token once
 *   PATCH  /tokens/:id   update label and/or agentId
 *   DELETE /tokens/:id   revoke
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { ChatAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import { ChatTokenSchema, ErrorSchema } from "../openapi-schemas.ts";
import type { ChatTokenServiceLike } from "../token-service.ts";

// ─── Extra schemas for token routes ───────────────────────────────────────────

const ChatTokenWithRawSchema = ChatTokenSchema.extend({
  rawToken: z.string().openapi({ example: "raw-token-value-shown-once" }),
}).openapi("ChatTokenWithRaw");

const TokenBodySchema = z
  .object({
    label: z.string().optional().openapi({ example: "ci-runner" }),
    agentId: z.string().optional().openapi({ example: "agent-id-123" }),
  })
  .openapi("TokenBody");

const TokenIdParamSchema = z.object({
  id: z.string().openapi({ example: "clxtoken123456" }),
});

// ─── Route definitions ────────────────────────────────────────────────────────

const listTokensRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["tokens"],
  summary: "List all tokens",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Array of token metadata",
      content: { "application/json": { schema: z.array(ChatTokenSchema) } },
    },
    403: {
      description: "Forbidden — admin token required",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const createTokenRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["tokens"],
  summary: "Create a new token — raw value returned exactly once",
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      required: false,
      content: { "application/json": { schema: TokenBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Created token including the one-time raw value",
      content: { "application/json": { schema: ChatTokenWithRawSchema } },
    },
    403: {
      description: "Forbidden — admin token required",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const updateTokenRoute = createRoute({
  method: "patch",
  path: "/:id",
  tags: ["tokens"],
  summary: "Update token label and/or agentId",
  security: [{ bearerAuth: [] }],
  request: {
    params: TokenIdParamSchema,
    body: {
      required: false,
      content: { "application/json": { schema: TokenBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Updated token metadata",
      content: { "application/json": { schema: ChatTokenSchema } },
    },
    400: {
      description: "Bad request — token is revoked",
      content: { "application/json": { schema: ErrorSchema } },
    },
    403: {
      description: "Forbidden — admin token required",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Token not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

const revokeTokenRoute = createRoute({
  method: "delete",
  path: "/:id",
  tags: ["tokens"],
  summary: "Revoke a token",
  security: [{ bearerAuth: [] }],
  request: {
    params: TokenIdParamSchema,
  },
  responses: {
    200: {
      description: "Revoked token metadata",
      content: { "application/json": { schema: ChatTokenSchema } },
    },
    403: {
      description: "Forbidden — admin token required",
      content: { "application/json": { schema: ErrorSchema } },
    },
    404: {
      description: "Token not found",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createTokensRoutes(
  tokenService: ChatTokenServiceLike,
): OpenAPIHono<ChatAuthEnv> {
  const app = new OpenAPIHono<ChatAuthEnv>();

  // All token management requires an admin token.
  app.use("*", async (c, next) => {
    if (c.get("agentId") !== null) {
      throw new ForbiddenError("token management requires an admin token");
    }
    return next();
  });

  // ─── List ──────────────────────────────────────────────────────────────────
  app.openapi(listTokensRoute, async (c) => {
    const tokens = await tokenService.list();
    return c.json(tokens, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.openapi(createTokenRoute, async (c) => {
    let label: string | undefined;
    let agentId: string | undefined;
    try {
      const body = (await c.req.json()) as {
        label?: unknown;
        agentId?: unknown;
      };
      if (typeof body.label === "string") label = body.label;
      if (typeof body.agentId === "string") agentId = body.agentId;
    } catch (_err) {
      // No body / invalid JSON → create an unlabeled admin token.
    }
    const { token, rawToken } = await tokenService.create(label, agentId);
    // The raw token is returned exactly once, here.
    return c.json({ ...token, rawToken }, 201);
  });

  // ─── Update ────────────────────────────────────────────────────────────────
  app.openapi(updateTokenRoute, async (c) => {
    let label: string | undefined;
    let agentId: string | undefined;
    try {
      const body = (await c.req.json()) as {
        label?: unknown;
        agentId?: unknown;
      };
      if (typeof body.label === "string") label = body.label;
      if (typeof body.agentId === "string") agentId = body.agentId;
    } catch (_err) {
      // Invalid JSON — proceed with undefined fields
    }

    const tokenId = c.req.param("id");
    try {
      const updated = await tokenService.update(tokenId, { label, agentId });
      if (!updated) throw new NotFoundError("token not found");
      return c.json(updated, 200);
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "REVOKED"
      ) {
        throw new BadRequestError("token is revoked");
      }
      throw err;
    }
  });

  // ─── Revoke ────────────────────────────────────────────────────────────────
  app.openapi(revokeTokenRoute, async (c) => {
    const revoked = await tokenService.revoke(c.req.param("id"));
    if (!revoked) throw new NotFoundError("token not found");
    return c.json(revoked, 200);
  });

  return app;
}
