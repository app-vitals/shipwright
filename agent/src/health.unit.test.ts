/**
 * Unit tests for createHealthApp() in agent/src/health.ts
 *
 * Uses Hono's in-process app.request() — no real socket needed.
 */

import { describe, expect, test } from "bun:test";
import { createHealthApp } from "./health.ts";

describe("GET /health", () => {
  test("returns 200 with { status: 'ok' }", async () => {
    const app = createHealthApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body).toEqual({ status: "ok" });
  });

  test("response is JSON", async () => {
    const app = createHealthApp();
    const res = await app.request("/health");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("unknown routes", () => {
  test("GET /other returns 404", async () => {
    const app = createHealthApp();
    const res = await app.request("/other");
    expect(res.status).toBe(404);
  });

  test("POST /health returns 404 (only GET is registered)", async () => {
    const app = createHealthApp();
    const res = await app.request("/health", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
