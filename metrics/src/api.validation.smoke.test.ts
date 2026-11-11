/**
 * metrics/src/api.validation.smoke.test.ts
 *
 * Request-validation smoke tests (ZOD-1.1). The metrics API has no JSON-body
 * route today, so a throwaway JSON-body route is registered on the app returned
 * by createMetricsApp to prove the app-level wiring (defaultHook + onError)
 * under @hono/zod-openapi 1.x: wrong Content-Type -> 415, invalid body -> 400.
 * A real route's query validation (400) is covered too.
 */

import { describe, expect, test } from "bun:test";
import { createRoute, z } from "@hono/zod-openapi";
import { createMetricsApp } from "./api.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";

function buildApp() {
  const app = createMetricsApp(
    new Map(),
    makeAccountsClientMock(async () => []),
    {
      provider: {
        query: async () => ({ columns: [], results: [], types: [] }),
      } as never,
      sessionSecret: "",
      dashboardDevAuth: true,
    },
  );
  const route = createRoute({
    method: "post",
    path: "/__test/json-body",
    request: {
      body: {
        content: {
          "application/json": { schema: z.object({ name: z.string() }) },
        },
      },
    },
    responses: {
      200: {
        description: "ok",
        content: {
          "application/json": { schema: z.object({ ok: z.boolean() }) },
        },
      },
    },
  });
  app.openapi(route, (c) => c.json({ ok: true }, 200));
  return app;
}

describe("metrics request validation", () => {
  test("JSON-body route: non-JSON Content-Type -> 415", async () => {
    const res = await buildApp().request("/__test/json-body", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(415);
  });

  test("JSON-body route: invalid body -> 400 with the issues message", async () => {
    const res = await buildApp().request("/__test/json-body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("name");
  });

  test("JSON-body route: valid body -> 200", async () => {
    const res = await buildApp().request("/__test/json-body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(200);
  });

  test("GET /metrics/merged-prs with an invalid query param -> 400", async () => {
    const res = await buildApp().request("/metrics/merged-prs?groupBy=bogus");
    expect(res.status).toBe(400);
  });
});
