/**
 * admin/src/api-auth.ts
 * Combined admin auth middleware — accepts either a session cookie OR a bearer token.
 *
 * Bearer check runs first (when Authorization header is present).
 * If Authorization header is absent, falls through to session cookie check.
 * If Authorization header is present but invalid, rejects immediately (401) —
 * does NOT fall through to the cookie path.
 */

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import type { AgentTokenService } from "./agent-tokens.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "admin_session";

// Matches /admin/api/agents/{agentId}/... routes — used for per-agent scope enforcement.
const AGENT_ROUTE_RE = /^\/admin\/api\/agents\/([^/]+)/;

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Returns a Hono middleware that accepts either:
 * (a) a valid session cookie (JWT in admin_session cookie), OR
 * (b) a valid bearer token (validated via agentTokenService.validate())
 *
 * Decision tree:
 *   1. Authorization header present?
 *      - Yes, starts with "Bearer " → validate token → pass or 401
 *      - Yes, malformed → 401 (no cookie fallback)
 *      - No → try session cookie
 *   2. Cookie present?
 *      - Yes → verify JWT → pass or 401
 *      - No → 401
 */
export function createAdminAuthMiddleware(deps: {
  sessionSecret: string;
  agentTokenService: Pick<AgentTokenService, "validate">;
}): MiddlewareHandler {
  const { sessionSecret, agentTokenService } = deps;

  return async (c, next) => {
    const authHeader = c.req.header("Authorization");

    if (authHeader !== undefined) {
      // Authorization header is present — bearer token path.
      // Do NOT fall through to cookie check on failure.
      if (!authHeader.startsWith("Bearer ")) {
        return c.json({ error: "Unauthorized" }, 401, {
          "WWW-Authenticate": "Bearer",
        });
      }
      const raw = authHeader.slice(7);
      const result = await agentTokenService.validate(raw);
      if (!result) {
        return c.json({ error: "Unauthorized" }, 401, {
          "WWW-Authenticate": 'Bearer error="invalid_token"',
        });
      }
      // Enforce per-agent scope: token must belong to the agent being accessed.
      // c.req.param() is not available in global middleware (params resolve only at
      // handler dispatch), so we extract the agent ID directly from the URL path.
      const match = AGENT_ROUTE_RE.exec(c.req.path);
      if (match && result.agentId !== match[1]) {
        return c.json({ error: "Forbidden" }, 403);
      }
      return next();
    }

    // No Authorization header — try session cookie.
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (!sessionToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    try {
      const payload = (await verify(
        sessionToken,
        sessionSecret,
        "HS256",
      )) as Record<string, unknown>;
      if (
        typeof payload.userId !== "string" ||
        !payload.userId ||
        typeof payload.email !== "string" ||
        !payload.email
      ) {
        return c.json({ error: "Unauthorized" }, 401);
      }
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  };
}
