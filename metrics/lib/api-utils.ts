/**
 * lib/api-utils.ts
 * Shared utilities for Hono OpenAPI route registration + the authz framework
 * wrapper that attaches a declarative policy to every route.
 */

import type { OpenAPIHono, RouteConfig } from "@hono/zod-openapi";
import {
  type AppHandler,
  type AuthEnv,
  type AuthzDeps,
  type AuthzPolicy,
  enforceAuthz,
} from "./api-auth.ts";

/**
 * Symbol used to attach the per-app policy registry to each OpenAPIHono
 * instance. We hang it off the app object directly (not a WeakMap) so that
 * sub-app metadata survives `app.route("/", subApp)` mounts — the parent app
 * can't reach into the child's WeakMap, but it can pull the symbol-keyed
 * property off the merged `openAPIRegistry.definitions` once we walk them.
 */
const POLICY_REGISTRY = Symbol.for("shipwright.authz.policy-registry");

interface PolicyEntry {
  method: string;
  path: string;
  policy: AuthzPolicy;
}

interface PolicyAwareApp {
  [POLICY_REGISTRY]?: Map<string, PolicyEntry>;
}

function getRegistry(
  // biome-ignore lint/suspicious/noExplicitAny: structural access only
  app: OpenAPIHono<any>,
): Map<string, PolicyEntry> {
  const holder = app as unknown as PolicyAwareApp;
  if (!holder[POLICY_REGISTRY]) {
    holder[POLICY_REGISTRY] = new Map();
  }
  return holder[POLICY_REGISTRY] as Map<string, PolicyEntry>;
}

function makeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

// `register()` was retired in favour of `registerWithAuthz()` — every
// OpenAPI route must now declare an AuthzPolicy. The bare bridge from
// AppHandler<R> → RouteHandler<R> lives inside registerWithAuthz below.

/**
 * Register an OpenAPI route with a declarative authorization policy.
 *
 * The wrapper:
 *   1. Stores `{method, path, policy}` in a per-app registry so
 *      `enumerateRoutes(app)` can list every route + its declared policy.
 *   2. Runs `enforceAuthz(c, policy, deps)` before the handler — a parallel
 *      safety net while we migrate without changing existing inline scope
 *      checks (subsequent AZH tasks will tighten and remove duplication).
 *
 * @param app      The OpenAPIHono sub-app to register the route on.
 * @param route    The route definition created via `createRoute()`.
 * @param policy   The authz policy describing how to enforce access.
 * @param handler  The typed route handler (AppHandler<R>).
 * @param deps     Optional deps passed to the enforcer (e.g. accountsClient
 *                 for `scoped-engagement` policies).
 */
export function registerWithAuthz<R extends RouteConfig>(
  app: OpenAPIHono<AuthEnv>,
  route: R,
  policy: AuthzPolicy,
  handler: AppHandler<R>,
  deps?: AuthzDeps,
): void {
  const registry = getRegistry(app);
  registry.set(makeKey(route.method, route.path), {
    method: route.method.toUpperCase(),
    path: route.path,
    policy,
  });

  const wrapped: AppHandler<R> = async (c) => {
    await enforceAuthz(c, policy, deps);
    return handler(c);
  };
  // biome-ignore lint/suspicious/noExplicitAny: bridge AppHandler → RouteHandler return type gap
  app.openapi(route, wrapped as any);
}

/**
 * Walk the app's OpenAPI registry (and the registries of any sub-apps mounted
 * via `app.route()`) and return every registered route with its policy.
 *
 * The OpenAPIRegistry holds parent references via the constructor, so calling
 * `app.openAPIRegistry.definitions` returns the merged route list across all
 * sub-apps. We pair each route with the policy registered via
 * `registerWithAuthz` (looked up by `${method} ${path}`).
 *
 * Routes that appear in the OpenAPI spec but have no policy entry are
 * returned with `policy: undefined` — the coverage test in api/src/server.test.ts
 * fails when this happens (or when a public route is missing from the
 * allowlist).
 */
export function enumerateRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: walks any OpenAPIHono variant
  app: OpenAPIHono<any>,
): Array<{ method: string; path: string; policy?: AuthzPolicy }> {
  // Collect every policy entry from this app + every nested sub-app we can
  // reach via the OpenAPIRegistry's recorded definitions. We can't iterate
  // sub-apps directly, so we walk the OpenAPI route list (which the registry
  // aggregates across mounts) and look each one up in our policy map.
  const policies = collectPolicies(app);

  // biome-ignore lint/suspicious/noExplicitAny: untyped registry definitions
  const definitions: any[] = app.openAPIRegistry.definitions ?? [];
  const routes: Array<{
    method: string;
    path: string;
    policy?: AuthzPolicy;
  }> = [];
  for (const def of definitions) {
    if (def.type !== "route") continue;
    const route = def.route as { method: string; path: string };
    const method = route.method.toUpperCase();
    const key = makeKey(method, route.path);
    const entry = policies.get(key);
    routes.push({
      method,
      path: route.path,
      ...(entry ? { policy: entry.policy } : {}),
    });
  }
  return routes;
}

/**
 * Recursively walk the policy registries attached to an app and (effectively)
 * any sub-apps it mounts. We don't have a handle on the sub-app objects here,
 * so we rely on the OpenAPIRegistry's parent linkage: when sub-apps are
 * mounted via `app.route("/", subApp)` Hono copies their route definitions
 * into the parent registry, but the policy registries live on the sub-app
 * objects. Sub-apps must therefore call `registerWithAuthz` themselves; the
 * gateway then merges the registries by path lookup.
 *
 * For now the simplest correct implementation is to expose a side-channel:
 * sub-apps stash their per-app registries on the same symbol, and the gateway
 * merges by walking the OpenAPI definitions and looking up by key. This works
 * because the gateway-level enumerateRoutes call only sees method+path that
 * was already routed through registerWithAuthz somewhere up the chain.
 *
 * To make merging work we attach a `mergePolicyRegistry` helper that the
 * gateway invokes when mounting a sub-app — but to keep the migration
 * lightweight we instead expose `registerSubAppPolicies(parent, child)` which
 * the gateway calls right after each `app.route()` call.
 */
function collectPolicies(
  // biome-ignore lint/suspicious/noExplicitAny: structural access only
  app: OpenAPIHono<any>,
): Map<string, PolicyEntry> {
  return getRegistry(app);
}

/**
 * Merge a sub-app's policy registry into the parent app. Call this right
 * after `parent.route("/", child)` so the parent's `enumerateRoutes()` sees
 * every policy registered on the child.
 */
export function registerSubAppPolicies(
  // biome-ignore lint/suspicious/noExplicitAny: structural access only
  parent: OpenAPIHono<any>,
  // biome-ignore lint/suspicious/noExplicitAny: structural access only
  child: OpenAPIHono<any>,
): void {
  const parentReg = getRegistry(parent);
  const childReg = getRegistry(child);
  for (const [key, entry] of childReg.entries()) {
    parentReg.set(key, entry);
  }
}
