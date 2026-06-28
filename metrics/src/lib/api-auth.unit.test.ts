/**
 * lib/api-auth.test.ts
 * Unit tests for parseApiKeys() and the AuthzPolicy framework in api-auth.ts.
 */

import { describe, expect, mock, test } from "bun:test";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  type AuthEnv,
  type AuthzPolicy,
  type Caller,
  enforceAuthz,
  parseApiKeys,
} from "./api-auth.ts";
import { enumerateRoutes, registerWithAuthz } from "./api-utils.ts";
import { ForbiddenError } from "./errors.ts";

// ─── parseApiKeys ─────────────────────────────────────────────────────────────

describe("parseApiKeys", () => {
  test("parses a single wildcard-scope key", () => {
    const m = parseApiKeys("bodhi:sk_bodhi:*");
    expect(m.size).toBe(1);
    expect(m.get("sk_bodhi")).toEqual({ name: "bodhi", scope: "*" });
  });

  test("parses a single client-scoped key", () => {
    const m = parseApiKeys("sully:sk_sully:client-xyz");
    expect(m.size).toBe(1);
    expect(m.get("sk_sully")).toEqual({ name: "sully", scope: "client-xyz" });
  });

  test("parses multiple keys", () => {
    const m = parseApiKeys("bodhi:sk_a:*,sully:sk_b:eng-123");
    expect(m.size).toBe(2);
    expect(m.get("sk_a")).toEqual({ name: "bodhi", scope: "*" });
    expect(m.get("sk_b")).toEqual({ name: "sully", scope: "eng-123" });
  });

  test("returns empty map for undefined", () => {
    expect(parseApiKeys(undefined).size).toBe(0);
  });

  test("returns empty map for empty string", () => {
    expect(parseApiKeys("").size).toBe(0);
  });

  test("skips entries with fewer than 3 colon-separated parts", () => {
    const m = parseApiKeys("bad,bodhi:sk_ok:*");
    expect(m.size).toBe(1);
    expect(m.get("sk_ok")).toEqual({ name: "bodhi", scope: "*" });
  });

  test("handles token that itself contains colons", () => {
    // name:tok:en:scope — token = "tok:en", scope = "scope"
    const m = parseApiKeys("bodhi:tok:en:*");
    expect(m.size).toBe(1);
    expect(m.get("tok:en")).toEqual({ name: "bodhi", scope: "*" });
  });

  test("trims whitespace around each comma-separated entry", () => {
    const m = parseApiKeys(" bodhi:sk_trim:* , sully:sk_trim2:eng ");
    // Entry-level trim only — "bodhi:sk_trim:*" and " sully:sk_trim2:eng" after split on ","
    // The leading space on the second is trimmed via entry.trim()
    expect(m.get("sk_trim")).toEqual({ name: "bodhi", scope: "*" });
    expect(m.get("sk_trim2")).toEqual({ name: "sully", scope: "eng" });
  });

  test("ignores blank comma-separated segments", () => {
    const m = parseApiKeys("bodhi:sk_x:*,,sully:sk_y:eng");
    expect(m.size).toBe(2);
  });
});

// ─── Authz framework ──────────────────────────────────────────────────────────

/**
 * Build a minimal Context-like object for testing the enforcer in isolation.
 * Only the surface enforceAuthz() touches is implemented.
 */
function makeContext(opts: {
  caller?: Caller;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  validJsonThrows?: boolean;
}): Context<AuthEnv> {
  return {
    get(key: string) {
      if (key === "caller") return opts.caller;
      return undefined;
    },
    set() {},
    req: {
      param(name: string) {
        return opts.params?.[name];
      },
      query(name: string) {
        return opts.query?.[name];
      },
      valid(_target: string) {
        if (opts.validJsonThrows) throw new Error("not validated");
        return opts.body ?? {};
      },
      async json() {
        return opts.body ?? {};
      },
      header() {
        return undefined;
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake
  } as any;
}

describe("enforceAuthz", () => {
  test("public policy → succeeds without a caller", async () => {
    const c = makeContext({});
    await expect(enforceAuthz(c, { kind: "public" })).resolves.toBeUndefined();
  });

  test("admin policy → throws Forbidden when caller has client scope", async () => {
    const c = makeContext({ caller: { name: "sully", scope: "client-x" } });
    await expect(enforceAuthz(c, { kind: "admin" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("admin policy → succeeds for caller with scope='*'", async () => {
    const c = makeContext({ caller: { name: "bodhi", scope: "*" } });
    await expect(enforceAuthz(c, { kind: "admin" })).resolves.toBeUndefined();
  });

  test("admin policy → throws Forbidden when no caller is set", async () => {
    const c = makeContext({});
    await expect(enforceAuthz(c, { kind: "admin" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("own-user-id policy → admin bypasses param check", async () => {
    const c = makeContext({
      caller: { name: "bodhi", scope: "*" },
      params: { userId: "other-user" },
    });
    await expect(
      enforceAuthz(c, { kind: "own-user-id", from: "param", key: "userId" }),
    ).resolves.toBeUndefined();
  });

  test("own-user-id policy → matches caller.name to param userId", async () => {
    const c = makeContext({
      caller: { name: "user-1", scope: "client-x" },
      params: { userId: "user-1" },
    });
    await expect(
      enforceAuthz(c, { kind: "own-user-id", from: "param", key: "userId" }),
    ).resolves.toBeUndefined();
  });

  test("own-user-id policy → rejects mismatch from param", async () => {
    const c = makeContext({
      caller: { name: "user-1", scope: "client-x" },
      params: { userId: "user-2" },
    });
    await expect(
      enforceAuthz(c, { kind: "own-user-id", from: "param", key: "userId" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("own-user-id policy → reads from query string", async () => {
    const c = makeContext({
      caller: { name: "user-1", scope: "client-x" },
      query: { userId: "user-1" },
    });
    await expect(
      enforceAuthz(c, { kind: "own-user-id", from: "query", key: "userId" }),
    ).resolves.toBeUndefined();
  });

  test("own-user-id policy → reads from JSON body", async () => {
    const c = makeContext({
      caller: { name: "user-1", scope: "client-x" },
      body: { userId: "user-1" },
    });
    await expect(
      enforceAuthz(c, { kind: "own-user-id", from: "body", key: "userId" }),
    ).resolves.toBeUndefined();
  });

  test("scoped-engagement policy → admin bypasses without accountsClient", async () => {
    const c = makeContext({
      caller: { name: "bodhi", scope: "*" },
      body: { engagementId: "eng-123" },
    });
    await expect(
      enforceAuthz(c, {
        kind: "scoped-engagement",
        from: "body",
        key: "engagementId",
      }),
    ).resolves.toBeUndefined();
  });

  test("scoped-engagement policy → calls assertEngagementScope for scoped caller", async () => {
    const getEngagement = mock(async () => ({
      id: "eng-123",
      clientId: "client-x",
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake engagement
    })) as any;
    const c = makeContext({
      caller: { name: "sully", scope: "client-x" },
      body: { engagementId: "eng-123" },
    });
    await expect(
      enforceAuthz(
        c,
        { kind: "scoped-engagement", from: "body", key: "engagementId" },
        // biome-ignore lint/suspicious/noExplicitAny: AccountsClient fake
        { accountsClient: { getEngagement } as any },
      ),
    ).resolves.toBeUndefined();
    expect(getEngagement).toHaveBeenCalledWith("eng-123");
  });

  test("scoped-engagement policy → rejects when engagement belongs to different client", async () => {
    const getEngagement = mock(async () => ({
      id: "eng-123",
      clientId: "client-other",
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake engagement
    })) as any;
    const c = makeContext({
      caller: { name: "sully", scope: "client-x" },
      body: { engagementId: "eng-123" },
    });
    await expect(
      enforceAuthz(
        c,
        { kind: "scoped-engagement", from: "body", key: "engagementId" },
        // biome-ignore lint/suspicious/noExplicitAny: AccountsClient fake
        { accountsClient: { getEngagement } as any },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("scoped-list policy → no-op (handler does the filtering)", async () => {
    const c = makeContext({ caller: { name: "sully", scope: "client-x" } });
    await expect(
      enforceAuthz(c, { kind: "scoped-list", filterParam: "engagementId" }),
    ).resolves.toBeUndefined();
  });

  test("custom policy → invokes the check function", async () => {
    const check = mock(async () => {});
    const c = makeContext({ caller: { name: "bodhi", scope: "*" } });
    await enforceAuthz(c, {
      kind: "custom",
      check,
      justification: "test",
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  test("custom policy → propagates errors from check function", async () => {
    const c = makeContext({ caller: { name: "bodhi", scope: "*" } });
    await expect(
      enforceAuthz(c, {
        kind: "custom",
        check: () => {
          throw new ForbiddenError("nope");
        },
        justification: "test",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ─── registerWithAuthz + enumerateRoutes ──────────────────────────────────────

describe("registerWithAuthz + enumerateRoutes", () => {
  const pingRoute = createRoute({
    method: "get",
    path: "/ping",
    responses: {
      200: {
        description: "ok",
        content: { "application/json": { schema: z.object({}) } },
      },
    },
  });

  const echoRoute = createRoute({
    method: "post",
    path: "/echo",
    request: {
      body: {
        content: { "application/json": { schema: z.object({}) } },
      },
    },
    responses: {
      200: {
        description: "ok",
        content: { "application/json": { schema: z.object({}) } },
      },
    },
  });

  test("enumerateRoutes lists every route registered with a policy", () => {
    const app = new OpenAPIHono<AuthEnv>();
    const policy: AuthzPolicy = { kind: "public" };
    registerWithAuthz(app, pingRoute, policy, async (c) => c.json({}, 200));
    registerWithAuthz(app, echoRoute, { kind: "admin" }, async (c) =>
      c.json({}, 200),
    );

    const routes = enumerateRoutes(app);
    const ping = routes.find((r) => r.path === "/ping");
    const echo = routes.find((r) => r.path === "/echo");
    expect(ping).toBeDefined();
    expect(ping?.method).toBe("GET");
    expect(ping?.policy).toEqual({ kind: "public" });
    expect(echo).toBeDefined();
    expect(echo?.method).toBe("POST");
    expect(echo?.policy).toEqual({ kind: "admin" });
  });

  test("registerWithAuthz enforces the policy before invoking the handler", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    app.onError((err, c) => {
      if (err instanceof ForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      return c.json({ error: err.message }, 500);
    });
    const handler = mock(async (c: Context<AuthEnv>) => c.json({}, 200));
    registerWithAuthz(
      app,
      pingRoute,
      { kind: "admin" },
      // biome-ignore lint/suspicious/noExplicitAny: handler shape
      handler as any,
    );

    // No caller → enforcer throws ForbiddenError before handler runs.
    const res = await app.request("/ping");
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  test("public route → returns 200 with no Authorization header", async () => {
    const app = new OpenAPIHono<AuthEnv>();
    app.onError((err, c) => {
      if (err instanceof ForbiddenError) {
        return c.json({ error: err.message }, 403);
      }
      return c.json({ error: err.message }, 500);
    });
    registerWithAuthz(
      app,
      pingRoute,
      { kind: "public" },
      // biome-ignore lint/suspicious/noExplicitAny: handler shape
      async (c) => c.json({}, 200) as any,
    );

    // No Authorization header, no caller → public policy allows it.
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
  });
});
