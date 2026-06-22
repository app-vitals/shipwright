/**
 * task-store/src/routes/tokens.ts
 * Token management routes.
 *
 * Returns a Hono sub-app mounted at /tokens by app.ts. Auth is applied by the
 * parent app.
 *
 * Routes:
 *   GET    /tokens       list (hash + metadata, never raw values)
 *   POST   /tokens       create — returns the raw token once
 *   DELETE /tokens/:id   revoke
 */

import { Hono } from "hono";
import { NotFoundError } from "../errors.ts";
import type { TokenServiceLike } from "../token-service.ts";

export function createTokensRoutes(tokenService: TokenServiceLike): Hono {
  const app = new Hono();

  // ─── List ──────────────────────────────────────────────────────────────────
  app.get("/", async (c) => {
    const tokens = await tokenService.list();
    return c.json(tokens, 200);
  });

  // ─── Create ────────────────────────────────────────────────────────────────
  app.post("/", async (c) => {
    let label: string | undefined;
    try {
      const body = (await c.req.json()) as { label?: unknown };
      if (typeof body.label === "string") label = body.label;
    } catch {
      // No body / invalid JSON → create an unlabeled token.
    }
    const { token, rawToken } = await tokenService.create(label);
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
