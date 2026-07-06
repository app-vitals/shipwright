/**
 * metrics/src/api.on-error.smoke.test.ts
 * SEN-1.4 — regression coverage for the shared makeOnError wiring.
 *
 * createMetricsApp and createPublicMetricsApp both used to register their own
 * inline `app.onError` (console.error + bare 500) and have been switched to
 * the shared `makeOnError` factory from ./lib/errors.ts. This file drives each
 * app via app.request() (no real server) and asserts the mapped-error
 * behavior is unchanged: ApiError subclasses map to their statusCode, the
 * "Malformed JSON" special case maps to 400, and unknown errors map to 500 —
 * for BOTH app factories, so the shared wiring is proven at the app level and
 * not just at the makeOnError unit level.
 *
 * A throwing test-only route is mounted on the app instance returned by each
 * factory so the error actually propagates through Hono's onError hook,
 * mirroring how a real handler throw would be caught.
 *
 * No mock.module(), no global overrides — everything is injected or mounted
 * directly on the returned app instance.
 */

import { describe, expect, test } from "bun:test";
import {
  type MetricsDeps,
  createMetricsApp,
  createPublicMetricsApp,
} from "./api.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import {
  BadGatewayError,
  BadRequestError,
  NotFoundError,
} from "./lib/errors.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import type { MetricsProvider } from "./metrics-provider.ts";
import type { HogQLResult } from "./types.ts";

const emptyResult: HogQLResult = {
  columns: [],
  results: [],
  types: [],
  hasMore: false,
  limit: 100,
  offset: 0,
};

function makeEmptyProvider(): MetricsProvider {
  return { query: async () => emptyResult };
}

const noopAccountsClient = makeAccountsClientMock(async () => []);

/** Mounts a throwing route on an already-built app so its onError hook fires. */
function withThrowingRoute(
  app: { get: (path: string, handler: (c: unknown) => never) => unknown },
  path: string,
  err: Error,
) {
  app.get(path, () => {
    throw err;
  });
  return app;
}

describe("createMetricsApp — shared makeOnError wiring", () => {
  function buildApp(): ReturnType<typeof createMetricsApp> {
    const deps: MetricsDeps = { provider: makeEmptyProvider() };
    return createMetricsApp(parseApiKeys(""), noopAccountsClient, deps);
  }

  test("maps a 5xx ApiError subclass to its statusCode", async () => {
    const app = buildApp();
    withThrowingRoute(
      app,
      "/__test/bad-gateway",
      new BadGatewayError("Upstream failed"),
    );
    const res = await app.request("/__test/bad-gateway");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Upstream failed" });
  });

  test("maps a non-5xx ApiError subclass to its statusCode", async () => {
    const app = buildApp();
    withThrowingRoute(
      app,
      "/__test/not-found",
      new NotFoundError("Widget not found"),
    );
    const res = await app.request("/__test/not-found");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Widget not found" });
  });

  test("maps a 400 ApiError subclass to its statusCode", async () => {
    const app = buildApp();
    withThrowingRoute(app, "/__test/bad-request", new BadRequestError("nope"));
    const res = await app.request("/__test/bad-request");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "nope" });
  });

  test('maps a "Malformed JSON" message to 400 with the generic body', async () => {
    const app = buildApp();
    withThrowingRoute(
      app,
      "/__test/malformed-json",
      new Error("Malformed JSON in request body"),
    );
    const res = await app.request("/__test/malformed-json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  test("maps an unknown Error to 500", async () => {
    const app = buildApp();
    withThrowingRoute(app, "/__test/boom", new Error("Something unexpected"));
    const res = await app.request("/__test/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something unexpected" });
  });
});

describe("createPublicMetricsApp — shared makeOnError wiring", () => {
  function buildApp(): ReturnType<typeof createPublicMetricsApp> {
    return createPublicMetricsApp(makeEmptyProvider());
  }

  test("maps a 5xx ApiError subclass to its statusCode", async () => {
    const app = buildApp();
    withThrowingRoute(
      app,
      "/__test/bad-gateway",
      new BadGatewayError("Upstream failed"),
    );
    const res = await app.request("/__test/bad-gateway");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Upstream failed" });
  });

  test("maps a non-5xx ApiError subclass to its statusCode", async () => {
    const app = buildApp();
    withThrowingRoute(
      app,
      "/__test/not-found",
      new NotFoundError("Widget not found"),
    );
    const res = await app.request("/__test/not-found");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Widget not found" });
  });

  test('maps a "Malformed JSON" message to 400 with the generic body', async () => {
    const app = buildApp();
    withThrowingRoute(
      app,
      "/__test/malformed-json",
      new Error("Malformed JSON in request body"),
    );
    const res = await app.request("/__test/malformed-json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  test("maps an unknown Error to 500", async () => {
    const app = buildApp();
    withThrowingRoute(app, "/__test/boom", new Error("Something unexpected"));
    const res = await app.request("/__test/boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Something unexpected" });
  });
});
