/**
 * task-store/src/auth.ts
 * Bearer-token auth middleware for the task-store service.
 *
 * Rejects with 401 when:
 *   - the Authorization header is absent
 *   - the Authorization header is present but not a "Bearer <token>" form
 *   - the token does not validate (unknown or revoked)
 *
 * On success the validated token id is stored on the context as `tokenId`.
 */

import type { MiddlewareHandler } from "hono";
import type { TokenServiceLike } from "./token-service.ts";

export type TaskStoreAuthEnv = { Variables: { tokenId: string } };

export function createBearerAuthMiddleware(deps: {
  tokenService: Pick<TokenServiceLike, "validate">;
}): MiddlewareHandler<TaskStoreAuthEnv> {
  const { tokenService } = deps;

  return async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader === undefined) {
      return c.json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }

    if (!authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }

    const raw = authHeader.slice(7).trim();
    const result = await tokenService.validate(raw);
    if (!result) {
      return c.json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": 'Bearer error="invalid_token"',
      });
    }

    c.set("tokenId", result.id);
    return next();
  };
}
