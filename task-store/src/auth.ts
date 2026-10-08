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
 *   Admin tokens always get `repos: null` (unrestricted) and skip the lookup.
 *   On any error from the resolver, `repos` falls back to `[]` silently (fail-safe restrictive).
 *   That same error also sets `scopeDegraded: true` on the context — a purely
 *   additive signal that lets downstream consumers (e.g. GET /tasks) tell
 *   "resolver failed" apart from "agent legitimately has zero repos" (both
 *   otherwise look identical as `repos: []`). scopeDegraded is false whenever
 *   the resolver isn't invoked or resolves successfully (including to []),
 *   and always false for admin tokens.
 *
 * Account scope:
 *   The resolver also returns the agent's `accountId` (null = unassigned
 *   agent, mapped to DEFAULT_ACCOUNT_ID). It is stored as `accountId` on the
 *   context: admin tokens get null (unrestricted); agent tokens get the
 *   resolved account. FAIL CLOSED: when the resolver rejects (or returns a
 *   malformed shape, which the resolver itself turns into a rejection), the
 *   agent gets `repos: []`, `scopeDegraded: true`, and the NO_ACCESS_ACCOUNT_ID
 *   sentinel — never the default account. See account-scope.ts for the
 *   helper later tasks use to read it.
 *
 * Caller:
 *   A shared `Caller` (see lib/request-context.ts) is also stored as `caller`,
 *   for use in logging (e.g. app.ts's onError handler). Admin tokens resolve
 *   to {name: 'admin', scope: '*'}; agent tokens resolve to {name: agentId,
 *   scope: agentId}.
 */

import type { MiddlewareHandler } from "hono";
import { DEFAULT_ACCOUNT_ID } from "@shipwright/lib/default-account";
import type { Caller } from "@shipwright/lib/request-context";
import type { TokenServiceLike } from "./token-service.ts";

/** What a scope resolver returns for an agent. */
export interface ScopeResolution {
  repos: string[];
  /** The agent's account; null for unassigned agents (treated as the default account). */
  accountId: string | null;
}

export type ScopeResolver = (agentId: string) => Promise<ScopeResolution>;

/**
 * Sentinel accountId for an agent whose scope could not be resolved. No row
 * carries this accountId, so any accountId filter matches nothing.
 */
export const NO_ACCESS_ACCOUNT_ID = "";

export type TaskStoreAuthEnv = {
  Variables: {
    tokenId: string;
    /** null = admin token (unrestricted); set = agent token scoped to this agent. */
    agentId: string | null;
    /**
     * Repos the agent is scoped to.
     * null  = admin token (unrestricted — no scoping applied).
     * []    = agent token with no repos resolved (scoped-but-unknown; fail-safe restrictive).
     * [...] = agent token with known repo scope.
     */
    repos: string[] | null;
    /**
     * True only when the scope-resolver call itself failed (network error,
     * timeout, non-2xx status, malformed JSON body) and `repos` was forced
     * to [] as a result. False for a legitimate resolver-returned [] and
     * always false for admin tokens. Purely an observability signal — does
     * not change any authz decision.
     */
    scopeDegraded: boolean;
    /**
     * Account the caller is scoped to.
     * null  = admin token (unrestricted).
     * string = agent token's account (DEFAULT_ACCOUNT_ID for unassigned agents).
     * NO_ACCESS_ACCOUNT_ID = scope resolution failed (scopeDegraded) — matches no rows.
     */
    accountId: string | null;
    /** Shared caller identity, derived from agentId — see lib/request-context.ts. */
    caller: Caller;
  };
};

export function createBearerAuthMiddleware(deps: {
  tokenService: Pick<TokenServiceLike, "validate">;
  /** Optional resolver that returns the repos and account for a given agent ID. */
  scopeResolver?: ScopeResolver;
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
    c.set(
      "caller",
      result.agentId === null
        ? { name: "admin", scope: "*" }
        : { name: result.agentId, scope: result.agentId },
    );

    // Resolve repos for agent tokens when a scope resolver is configured.
    // Admin tokens (agentId null) get repos: null (unrestricted — skip the lookup)
    // and scopeDegraded is always false.
    // Agent tokens with no resolver get repos: [] (scoped-but-unknown — fail-safe restrictive)
    // and scopeDegraded is false (nothing was attempted, let alone failed).
    // Agent tokens with a resolver get repos from the lookup; a rejection
    // (genuine resolver failure) falls back to repos: [] AND sets
    // scopeDegraded: true. A resolved (even legitimately empty) result keeps
    // scopeDegraded: false.
    if (result.agentId === null) {
      c.set("repos", null);
      c.set("scopeDegraded", false);
      c.set("accountId", null);
    } else if (scopeResolver !== undefined) {
      let repos: string[];
      let accountId: string;
      let scopeDegraded = false;
      try {
        const resolution = await scopeResolver(result.agentId);
        if (!isScopeResolution(resolution)) {
          throw new Error("scope resolver returned a malformed resolution");
        }
        repos = resolution.repos;
        accountId = resolution.accountId ?? DEFAULT_ACCOUNT_ID;
      } catch {
        repos = [];
        accountId = NO_ACCESS_ACCOUNT_ID;
        scopeDegraded = true;
      }
      c.set("repos", repos);
      c.set("scopeDegraded", scopeDegraded);
      c.set("accountId", accountId);
    } else {
      c.set("repos", []);
      c.set("scopeDegraded", false);
      c.set("accountId", DEFAULT_ACCOUNT_ID);
    }

    return next();
  };
}

function isScopeResolution(v: unknown): v is ScopeResolution {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    Array.isArray(r.repos) &&
    (r.accountId === null || typeof r.accountId === "string")
  );
}

/**
 * Factory that builds a scope resolver calling the agents service.
 *
 * GET {baseUrl}/agents/{agentId}
 *   Authorization: Bearer {adminApiKey}
 *
 * Returns `{repos, accountId}` from the response body (`accountId` null =
 * unassigned agent).
 *
 * Infra failures (fetch throwing/timeout, non-2xx status, malformed JSON
 * body) are genuine failures of the resolver call itself — these propagate
 * (reject) so callers can distinguish "the lookup failed" from "the lookup
 * succeeded and legitimately found nothing" (see createBearerAuthMiddleware's
 * `scopeDegraded` signal).
 *
 * A successful response with a malformed *shape* (missing `repos` key,
 * `repos` not an array, missing/non-string `accountId`, body is an
 * array/null) also rejects: guessing an account would risk granting
 * default-account access, so the middleware fails closed on it.
 */
export function createScopeResolver(
  baseUrl: string,
  adminApiKey: string,
): ScopeResolver {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  return async (agentId: string): Promise<ScopeResolution> => {
    let res: Response;
    try {
      res = await fetch(`${normalizedBaseUrl}/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${adminApiKey}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new Error("scope resolver request failed", { cause: err });
    }

    if (!res.ok) {
      throw new Error(`scope resolver received non-ok status: ${res.status}`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new Error("scope resolver received malformed JSON body", {
        cause: err,
      });
    }

    if (isScopeResolution(body)) {
      return {
        repos: body.repos.filter((r): r is string => typeof r === "string"),
        accountId: body.accountId,
      };
    }

    throw new Error("scope resolver received malformed response shape");
  };
}
