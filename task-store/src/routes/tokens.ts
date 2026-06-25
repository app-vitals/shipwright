/**
 * task-store/src/routes/tokens.ts
 * Token management routes — admin tokens only.
 *
 * Returns a Hono sub-app mounted at /tokens by app.ts. Auth is applied by the
 * parent app. All routes here require an admin token (agentId === null).
 *
 * Routes:
 *   GET    /tokens       list (hash + metadata, never raw values)
 *   POST   /tokens       create — returns the raw token once
 *   DELETE /tokens/:id   revoke
 */

import { Hono } from "hono";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.ts";
import type { TokenServiceLike } from "../token-service.ts";
import { isOrgRepo } from "../validate.ts";

export function createTokensRoutes(
  tokenService: TokenServiceLike,
): Hono<TaskStoreAuthEnv> {
  const app = new Hono<TaskStoreAuthEnv>();

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
        repos?: unknown;
      };
      if (typeof body.label === "string") label = body.label;
      if (typeof body.agentId === "string") agentId = body.agentId;
      if (Array.isArray(body.repos)) {
        for (const entry of body.repos) {
          if (typeof entry !== "string" || !isOrgRepo(entry)) {
            throw new BadRequestError(
              `invalid repos entry: "${entry}" — expected "org/repo" format`,
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof BadRequestError) throw err;
      // No body / invalid JSON → create an unlabeled admin token.
    }
    const { token, rawToken } = await tokenService.create(label, agentId);
    // The raw token is returned exactly once, here.
    return c.json({ ...token, rawToken }, 201);
  });

  // ─── Revoke ────────────────────────────────────────────────────────────────
  app.delete("/:id", async (c) => {
    const revoked = await tokenService.revoke(c.req.param("id"));
    if (!revoked) throw new NotFoundError("token not found");
    return c.json(revoked, 200);
  });

  return app;
}
