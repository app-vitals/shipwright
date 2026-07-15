/**
 * admin/src/main.smoke.test.ts
 *
 * Smoke tests for GET /health and GET /health/ready.
 * Mirrors the route wiring in main.ts's startServer() (see the doc comment
 * there on why startServer itself isn't unit-tested directly) with checkDbReady
 * imported from main.ts, so the DB check logic under test is the real one.
 * Uses app.request() — no real server, no real DB.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { checkDbReady } from "./main.ts";

function buildHealthApp(prisma: {
  $queryRaw: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>;
}) {
  const root = new Hono();
  root.get("/health", (c) => c.json({ status: "ok" }));
  root.get("/health/ready", async (c) => {
    const ready = await checkDbReady(prisma);
    return c.json({ status: ready ? "ok" : "unavailable" }, ready ? 200 : 503);
  });
  return root;
}

describe("GET /health (liveness)", () => {
  it("returns 200 when the DB is unreachable", async () => {
    const app = buildHealthApp({
      $queryRaw: async () => {
        throw new Error("Can't reach database server at 127.0.0.1:5432");
      },
    });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 200 when the DB is reachable", async () => {
    const app = buildHealthApp({ $queryRaw: async () => [{ "?column?": 1 }] });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
  });
});

describe("GET /health/ready (readiness)", () => {
  it("returns 200 when the DB is reachable", async () => {
    const app = buildHealthApp({ $queryRaw: async () => [{ "?column?": 1 }] });
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 503 when the DB is unreachable", async () => {
    const app = buildHealthApp({
      $queryRaw: async () => {
        throw new Error("Can't reach database server at 127.0.0.1:5432");
      },
    });
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable" });
  });
});
