/**
 * chat/src/routes/tokens.ts
 * Token management routes — admin tokens only.
 *
 * Returns a Hono sub-app mounted at /tokens by app.ts. Auth is applied by the
 * parent app. All routes here require an admin token (agentId === null).
 *
 * Routes:
 *   GET    /tokens       list (hash + metadata, never raw values)
 *   POST   /tokens       create — returns the raw token once
 *   PATCH  /tokens/:id   update label and/or agentId
 *   DELETE /tokens/:id   revoke
 */

import { Hono } from "hono";
import type { ChatAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import type { ChatTokenServiceLike } from "../token-service.ts";

export function createTokensRoutes(
  tokenService: ChatTokenServiceLike,
): Hono<ChatAuthEnv> {
  const app = new Hono<ChatAuthEnv>();

  // All token management requires an admin token.
  app.use("*", async (c, next) => {
    if (c.get("agentId") !== null) {
      throw new ForbiddenError("token management requires an admin token");
    }
    return next();
  });

  // ─── List ──────────────────────────────────────────────────────────────────
  app.get("/", async (c) => {
    const tokens = await tokenService.list();
    return c.json(tokens, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
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
  app.patch("/:id", async (c) => {
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
  app.delete("/:id", async (c) => {
    const revoked = await tokenService.revoke(c.req.param("id"));
    if (!revoked) throw new NotFoundError("token not found");
    return c.json(revoked, 200);
  });

  return app;
}
