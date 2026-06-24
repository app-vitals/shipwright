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
 *
 * Scope resolver (optional):
 *   When a `scopeResolver` is provided, agent tokens trigger a lookup of the
 *   agent's repos from the agents service. The result is stored as `repos`.
 *   Admin tokens always get `repos: []` and skip the lookup.
 *   On any error from the resolver, `repos` falls back to `[]` silently.
 */

import type { MiddlewareHandler } from "hono";
import type { TokenServiceLike } from "./token-service.ts";

export type TaskStoreAuthEnv = {
  Variables: {
    tokenId: string;
    /** null = admin token (unrestricted); set = agent token scoped to this agent. */
    agentId: string | null;
    /** Repos the agent is scoped to. Empty array = unrestricted (admin) or unknown. */
    repos: string[];
  };
};

export function createBearerAuthMiddleware(deps: {
  tokenService: Pick<TokenServiceLike, "validate">;
  /** Optional resolver that returns the repos for a given agent ID. */
  scopeResolver?: (agentId: string) => Promise<string[]>;
}): MiddlewareHandler<TaskStoreAuthEnv> {
  const { tokenService, scopeResolver } = deps;

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
    c.set("agentId", result.agentId);

    // Resolve repos for agent tokens when a scope resolver is configured.
    // Admin tokens (agentId null) always get repos: [] and skip the lookup.
    if (result.agentId !== null && scopeResolver !== undefined) {
      let repos: string[];
      try {
        repos = await scopeResolver(result.agentId);
      } catch {
        repos = [];
      }
      c.set("repos", repos);
    } else {
      c.set("repos", []);
    }

    return next();
  };
}

/**
 * Factory that builds a scope resolver calling the agents service.
 *
 * GET {baseUrl}/agents/{agentId}
 *   Authorization: Bearer {adminApiKey}
 *
 * Returns the `repos` array from the response body.
 * On any error (network, 404, non-200, malformed body) returns [] silently.
 */
export function createScopeResolver(
  baseUrl: string,
  adminApiKey: string,
): (agentId: string) => Promise<string[]> {
  return async (agentId: string): Promise<string[]> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${adminApiKey}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return [];
    }

    if (!res.ok) return [];

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return [];
    }

    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Array.isArray((body as Record<string, unknown>).repos)
    ) {
      const repos = (body as Record<string, unknown>).repos as unknown[];
      return repos.filter((r): r is string => typeof r === "string");
    }

    return [];
  };
}
