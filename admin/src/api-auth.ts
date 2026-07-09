/**
 * admin/src/api-auth.ts
 * Combined admin auth middleware — accepts either a session cookie OR a bearer token.
 *
 * Bearer check runs first (when Authorization header is present).
 * If Authorization header is absent, falls through to session cookie check.
 * If Authorization header is present but invalid, rejects immediately (401) —
 * does NOT fall through to the cookie path.
 */

import type { Caller } from "@shipwright/lib/request-context";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verify } from "hono/jwt";
import type { AgentTokenService } from "./agent-tokens.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AdminAuthEnv = {
  Variables: { isAdmin: boolean; caller: Caller };
};

/**
 * Declarative authorization policy for the admin service.
 * - `public`  — no auth check; used for unauthenticated read-only routes.
 * - `session` — requires a valid session cookie or bearer token (default).
 */
export type AdminAuthzPolicy = { kind: "public" } | { kind: "session" };

/**
 * No-op middleware for routes declared with policy kind "public".
 * Allows unauthenticated requests to pass through without a 401.
 */
export const publicNoAuthMiddleware: MiddlewareHandler<AdminAuthEnv> = async (
  _c,
  next,
) => {
  await next();
};

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_COOKIE = "admin_session";

// Matches /agents/{agentId}/... routes — used for per-agent scope enforcement.
const AGENT_ROUTE_RE = /^\/agents\/([^/]+)/;

// ─── Admin API key parsing ────────────────────────────────────────────────────

/**
 * Represents a parsed admin API key entry.
 * scope === "*" → admin (bypasses all per-agent scope checks)
 * scope === "<agentId>" → scoped to a single agent
 */
export interface AdminApiKey {
  name: string;
  scope: string;
}

/**
 * Parse the SHIPWRIGHT_ADMIN_API_KEYS env var into a Map<token, AdminApiKey>.
 * Format: comma-separated "name:token:scope" tuples.
 * Example: "bodhi:sk_bodhi_abc:*,svc:sk_svc_xyz:agent-id-123"
 *
 * Tokens may contain embedded colons — first segment is name, last is scope,
 * everything in between is the token.
 *
 * Returns an empty map if the env var is missing or empty.
 */
export function parseAdminApiKeys(
  envStr: string | undefined,
): Map<string, AdminApiKey> {
  const map = new Map<string, AdminApiKey>();
  if (!envStr) return map;

  for (const entry of envStr.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":");
    // parts[0]=name, parts[1..n-1]=token (may contain colons), parts[n]=scope
    if (parts.length < 3) continue;
    const name = parts[0];
    const scope = parts[parts.length - 1];
    const token = parts.slice(1, parts.length - 1).join(":");
    if (name && token && scope) {
      map.set(token, { name, scope });
    }
  }

  return map;
}

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Returns a Hono middleware that accepts either:
 * (a) a valid session cookie (JWT in admin_session cookie), OR
 * (b) a valid bearer token — checked in this order:
 *     1. Matches a SHIPWRIGHT_ADMIN_API_KEYS env key with scope=* → isAdmin, bypass
 *     2. Matches a SHIPWRIGHT_ADMIN_API_KEYS env key with scope=<agentId> → enforce agentId
 *     3. Validates via agentTokenService.validate() (DB token path)
 *
 * Decision tree:
 *   1. Authorization header present?
 *      - Yes, starts with "Bearer " → check env keys, then DB token → pass or 401
 *      - Yes, malformed → 401 (no cookie fallback)
 *      - No → try session cookie
 *   2. Cookie present?
 *      - Yes → verify JWT → pass or 401
 *      - No → 401
 */
export function createAdminAuthMiddleware(deps: {
  sessionSecret: string;
  agentTokenService: Pick<AgentTokenService, "validate">;
  adminApiKeys?: Map<string, AdminApiKey>;
}): MiddlewareHandler<AdminAuthEnv> {
  const { sessionSecret, agentTokenService, adminApiKeys } = deps;

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

      // (1) Check admin API keys first (env-based, no DB round-trip).
      if (adminApiKeys?.size) {
        const envKey = adminApiKeys.get(raw);
        if (envKey) {
          if (envKey.scope === "*") {
            // Admin key — bypass all scope checks.
            c.set("isAdmin", true);
            c.set("caller", { name: envKey.name, scope: "*" });
            return next();
          }
          // Scoped key — enforce route agentId matches key scope.
          const match = AGENT_ROUTE_RE.exec(c.req.path);
          if (match && envKey.scope !== match[1]) {
            return c.json({ error: "Forbidden" }, 403);
          }
          // Non-agent routes: scoped keys are permitted (no agentId to enforce against).
          // All current /agents/* routes match AGENT_ROUTE_RE — revisit if that changes.
          c.set("isAdmin", false);
          c.set("caller", { name: envKey.name, scope: envKey.scope });
          return next();
        }
      }

      // (2) Fall through to DB token path (AgentTokenService).
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
      // DB token path — per-agent bearer, not an admin.
      c.set("isAdmin", false);
      c.set("caller", { name: result.agentId, scope: result.agentId });
      return next();
    }

    // No Authorization header — try session cookie.
    const sessionToken = getCookie(c, SESSION_COOKIE);
    if (!sessionToken) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    let email: string;
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
      email = payload.email;
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    // Session cookie — admin.
    c.set("isAdmin", true);
    c.set("caller", { name: email, scope: "session" });
    return next();
  };
}
