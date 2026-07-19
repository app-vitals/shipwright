/**
 * mcp-server/src/auth.ts
 * Inbound bearer-token auth middleware for the MCP server (TSM-2.6).
 *
 * mcp-server has no database and no per-caller token service — unlike
 * task-store's `createBearerAuthMiddleware` (see task-store/src/auth.ts),
 * which validates against a DB-backed TokenService. This is a much simpler
 * static single-secret comparison: the server is configured with exactly one
 * token (SHIPWRIGHT_MCP_SERVER_TOKEN, read by main.ts) and every request must
 * present it.
 *
 * The 401 response SHAPE matches task-store's convention exactly, so clients
 * (and operators) see a consistent contract across Shipwright HTTP services:
 *   - Missing or malformed (non-"Bearer ") Authorization header ->
 *     { error: "Unauthorized" }, 401, WWW-Authenticate: Bearer
 *   - Present but wrong token ->
 *     { error: "Unauthorized" }, 401, WWW-Authenticate: Bearer error="invalid_token"
 *
 * Token comparison is constant-time (`node:crypto`'s `timingSafeEqual`) to
 * avoid leaking the secret's length or content via response-time side
 * channels.
 */

import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Constant-time string comparison. Returns `false` immediately on a length
 * mismatch (length isn't the secret — only the byte content is), and only
 * calls `timingSafeEqual` when both buffers are the same length, since
 * `timingSafeEqual` throws on mismatched lengths.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Build a bearer-auth middleware that requires every request to present
 * `Authorization: Bearer <token>` matching the configured `token` exactly.
 */
export function createBearerAuthMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader === undefined || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": "Bearer",
      });
    }

    const raw = authHeader.slice(7).trim();
    if (!constantTimeEqual(raw, token)) {
      return c.json({ error: "Unauthorized" }, 401, {
        "WWW-Authenticate": 'Bearer error="invalid_token"',
      });
    }

    return next();
  };
}
