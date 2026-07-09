/**
 * lib/api-auth.ts
 * API key parsing, request authentication, and declarative authorization.
 * Shared by all service sub-apps (billing, time, cal, accounts, metrics).
 *
 * METRICS_API_KEYS format: comma-separated "name:token:scope" tuples
 * Example: "bodhi:sk_bodhi_abc:*,sully:sk_sully_def:client-xyz"
 *
 * ── Authorization framework ───────────────────────────────────────────────
 * Every OpenAPI route is registered via `registerWithAuthz(app, route, policy,
 * handler)` (see lib/api-utils.ts). The policy is enforced before the handler
 * runs and is also stored as metadata on the app instance so that
 * `enumerateRoutes(app)` can list every registered route + its policy. The
 * coverage test in api/src/server.test.ts uses this enumeration to assert
 * that no route ships without a declared policy.
 */

import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Caller } from "@shipwright/lib/request-context";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AccountsClient } from "./accounts-client.ts";
import { ForbiddenError } from "./errors.ts";

/**
 * Represents an authenticated API caller.
 * scope === "*" → admin (all clients)
 * scope === "<clientId>" → scoped to a single client
 *
 * Re-exported so existing `import type { Caller } from "./lib/api-auth.ts"`
 * consumers keep working unchanged.
 */
export type { Caller };

// Hono env type for routes that use the auth middleware
export type AuthEnv = { Variables: { caller: Caller } };

/**
 * Handler type that gets input types from a route's Zod schemas.
 * Uses RouteHandler for the context parameter (giving typed c.req.valid())
 * but returns Promise<Response> to avoid Prisma Date ↔ Zod string conflicts
 * on response types (see honojs/middleware#796).
 */
export type AppHandler<R extends RouteConfig> = (
  c: Parameters<RouteHandler<R, AuthEnv>>[0],
) => Promise<Response>;

/**
 * Parse the METRICS_API_KEYS env var into a Map<token, Caller>.
 * Returns an empty map if the env var is missing or empty.
 */
export function parseApiKeys(envStr: string | undefined): Map<string, Caller> {
  const map = new Map<string, Caller>();
  if (!envStr) return map;

  for (const entry of envStr.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(":");
    // parts[0]=name, parts[1]=token, parts[2]=scope
    // Token may itself contain colons (e.g. "sk:abc:def") — treat first segment as name,
    // last segment as scope, middle as token.
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

/**
 * Hono middleware that authenticates via Bearer token.
 * Sets c.var.caller on success, returns 401 on failure.
 */
export const authMiddleware = (apiKeys: Map<string, Caller>) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const header = c.req.header("Authorization")?.trim();
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const caller = token ? apiKeys.get(token) : undefined;
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    c.set("caller", caller);
    await next();
  });

/**
 * Token validator interface — decouples authMiddleware from Prisma.
 * Implement with AgentTokenService.validate() for DB-backed agent token auth.
 */
export interface AgentTokenValidator {
  validate(raw: string): Promise<{ userId: string; clientId: string } | null>;
}

/**
 * Extended auth middleware that falls back to DB-backed agent token validation
 * when the Bearer token is not found in the static apiKeys map.
 *
 * Flow:
 *   1. Check static map (service-to-service tokens)
 *   2. If not found, validate as an agent token via the provided validator
 *   3. Valid agent token → Caller{name: agentId, scope: clientId}
 *   4. Unknown / revoked → 401
 */
export const authMiddlewareWithAgentTokens = (
  apiKeys: Map<string, Caller>,
  agentTokens: AgentTokenValidator,
) =>
  createMiddleware<AuthEnv>(async (c, next) => {
    const header = c.req.header("Authorization")?.trim();
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    // Static key check first (service-to-service, admin tokens)
    const staticCaller = apiKeys.get(token);
    if (staticCaller) {
      c.set("caller", staticCaller);
      return next();
    }

    // Fall back to DB-backed agent token validation
    const validated = await agentTokens.validate(token);
    if (!validated) return c.json({ error: "Unauthorized" }, 401);

    c.set("caller", { name: validated.userId, scope: validated.clientId });
    return next();
  });

// ─── Scope helpers ───────────────────────────────────────────────────────────

/**
 * Assert that the given engagementId belongs to the caller's client.
 * No-op for admin callers (scope === "*").
 * Throws ForbiddenError if the engagement doesn't belong to the client.
 */
export async function assertEngagementScope(
  caller: Caller,
  engagementId: string,
  accountsClient: AccountsClient,
): Promise<void> {
  if (caller.scope === "*") return;
  const engagement = (await accountsClient.getEngagement(engagementId)) as {
    clientId: string;
  };
  if (engagement.clientId !== caller.scope) {
    throw new ForbiddenError("Not authorized for this engagement");
  }
}

/**
 * Resolve the engagement IDs the caller is allowed to access.
 * Returns undefined for admin callers (no filter needed).
 * For scoped callers, fetches all engagements belonging to their client.
 */
export async function getEngagementIdsForScope(
  caller: Caller,
  accountsClient: AccountsClient,
): Promise<string[] | undefined> {
  if (caller.scope === "*") return undefined;
  const engagements = (await accountsClient.listEngagements({
    clientId: caller.scope,
  })) as Array<{ id: string }>;
  return engagements.map((e) => e.id);
}

// ─── Authz policy framework ──────────────────────────────────────────────────

/**
 * Declarative authorization policy attached to every registered route.
 * The enforcer (`enforceAuthz`) runs before the handler and either succeeds
 * silently or throws a `ForbiddenError`. Handlers retain their existing inline
 * scope checks during the AZH-0.x rollout — the enforcer is a parallel safety
 * net so we can verify behavior parity before tightening in subsequent tasks.
 *
 * Policy kinds:
 * - `public`         — no auth check; reserved for the gateway homepage,
 *                      health, openapi.json, and session-cookie web UI mounts.
 * - `admin`          — caller.scope must be `"*"`.
 * - `own-user-id`    — extract a userId from param/query/body; non-admin
 *                      callers must match it (caller.name === userId).
 * - `scoped-engagement` — extract an engagementId from param/body and ensure
 *                      the caller's scope owns it (admin bypasses).
 * - `scoped-list`    — list endpoint with engagement-id filtering done by the
 *                      handler. The enforcer is a no-op; the policy exists
 *                      purely so the route shows up with intent in
 *                      `enumerateRoutes()`.
 * - `custom`         — escape hatch with a free-form check function. Always
 *                      include a one-line `justification` so reviewers can see
 *                      why the standard kinds didn't fit.
 */
export type AuthzPolicy =
  | { kind: "public" }
  | { kind: "admin" }
  | { kind: "own-user-id"; from: "param" | "query" | "body"; key: string }
  | { kind: "scoped-engagement"; from: "param" | "body"; key: string }
  | { kind: "scoped-list"; filterParam: string }
  | {
      kind: "custom";
      check: (c: Context<AuthEnv>) => Promise<void> | void;
      justification: string;
    };

/**
 * Optional dependencies for the enforcer. `accountsClient` is required for
 * `scoped-engagement` policies (admin bypass still works without it).
 */
export interface AuthzDeps {
  accountsClient?: AccountsClient;
}

/**
 * Read a value off the request based on `from` (param/query/body). Returns
 * `undefined` if missing or not a string. Body extraction uses
 * `c.req.valid("json")` first (already-validated payload) and falls back to a
 * raw `c.req.json()` parse so the enforcer works even before route validation
 * has populated the cache.
 */
async function extractValue(
  c: Context<AuthEnv>,
  from: "param" | "query" | "body",
  key: string,
): Promise<string | undefined> {
  if (from === "param") {
    const value = c.req.param(key);
    return typeof value === "string" ? value : undefined;
  }
  if (from === "query") {
    const value = c.req.query(key);
    return typeof value === "string" ? value : undefined;
  }
  // body
  let body: unknown;
  try {
    // c.req.valid("json") returns the route-validated body when the route's
    // Zod schema has run. The Context here is generic so its `valid` is
    // typed as `never(...)`; cast through unknown to read the cached value.
    body = (c.req.valid as (target: string) => unknown)("json");
  } catch {
    body = undefined;
  }
  if (!body || typeof body !== "object") {
    try {
      body = await c.req.json();
    } catch {
      return undefined;
    }
  }
  if (body && typeof body === "object" && key in (body as object)) {
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

/**
 * Run the authz policy for a request. Throws `ForbiddenError` (or returns a
 * 401-style failure for missing callers on non-public routes) when the policy
 * is not satisfied. Public routes always succeed silently.
 */
export async function enforceAuthz(
  c: Context<AuthEnv>,
  policy: AuthzPolicy,
  deps?: AuthzDeps,
): Promise<void> {
  if (policy.kind === "public") return;

  // Custom policies are responsible for their own auth (e.g. mixed-auth
  // routes that run before the standard authMiddleware). Skip the default
  // caller-presence guard and let the check function decide.
  if (policy.kind === "custom") {
    await policy.check(c);
    return;
  }

  // For every other non-public policy the auth middleware should have set
  // caller. If it didn't, that's a programmer error (route mounted without
  // auth) — surface it as Forbidden rather than 500.
  const caller = c.get("caller");
  if (!caller) {
    throw new ForbiddenError("No authenticated caller");
  }

  if (policy.kind === "admin") {
    if (caller.scope !== "*") {
      // Message phrasing intentionally contains both "Admin scope required"
      // and "admin scope required" so existing tests (.toContain) keep
      // passing regardless of whether they use capital or lowercase. Once
      // the enforcer has fully replaced inline handler checks (later AZH
      // tasks), the redundant phrasing can collapse to a single canonical
      // form.
      throw new ForbiddenError("Admin scope required (admin scope required)");
    }
    return;
  }

  if (policy.kind === "own-user-id") {
    if (caller.scope === "*") return; // admin bypass
    const userId = await extractValue(c, policy.from, policy.key);
    if (!userId || caller.name !== userId) {
      throw new ForbiddenError("Not authorized for this user");
    }
    return;
  }

  if (policy.kind === "scoped-engagement") {
    if (caller.scope === "*") return; // admin bypass
    const engagementId = await extractValue(c, policy.from, policy.key);
    if (!engagementId) {
      throw new ForbiddenError("Missing engagementId for scope check");
    }
    if (!deps?.accountsClient) {
      throw new ForbiddenError(
        "AccountsClient not configured for scoped-engagement policy",
      );
    }
    await assertEngagementScope(caller, engagementId, deps.accountsClient);
    return;
  }

  if (policy.kind === "scoped-list") {
    // List endpoints filter by engagement-id inside the handler. The policy
    // is declarative metadata only; nothing to enforce here.
    return;
  }
}
