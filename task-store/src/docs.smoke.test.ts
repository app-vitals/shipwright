/**
 * task-store/src/docs.smoke.test.ts
 *
 * Smoke tests for the ephemeral /docs endpoints via in-process `app.request()`.
 * No real socket, no real DB — the doc store is injected with a mutable clock so
 * TTL expiry is deterministic (no real wall-clock).
 *
 * Covers:
 *   - POST /docs with a valid bearer → 201 + { id, url, expiresIn }
 *   - GET  /docs/:id → 200 + the stored HTML with text/html content-type
 *   - GET  /docs/:id after TTL expiry → 404
 *   - GET  /docs/:id for an unknown id → 404
 *   - POST /docs without a valid bearer → 401
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { Clock } from "./clock.ts";
import { EphemeralDocStore } from "./doc-store.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

const VALID_TOKEN = "valid-token";
const HTML = "<!doctype html><html><body><h1>report</h1></body></html>";

function fakeTokenService(): Pick<TokenServiceLike, "validate"> {
  return {
    async validate(raw: string) {
      return raw === VALID_TOKEN ? { id: "tok-1", agentId: null } : null;
    },
  };
}

/** Mutable clock so the test can advance time across the TTL boundary. */
function mutableClock(): { clock: Clock; advance(ms: number): void } {
  let nowMs = 0;
  return {
    clock: { now: () => new Date(nowMs) },
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

/** Build the full task-store app with an injected doc store. */
function makeApp(docStore: EphemeralDocStore) {
  return createTaskStoreApp({
    // Only `validate` is exercised by these routes; cast the partial fake.
    tokenService: fakeTokenService() as unknown as TokenServiceLike,
    taskService: {} as unknown as TaskServiceLike,
    docStore,
  });
}

function auth(token = VALID_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("task-store /docs (smoke)", () => {
  it("POST /docs with a valid bearer returns 201 + { id, url, expiresIn }", async () => {
    const { clock } = mutableClock();
    const app = makeApp(new EphemeralDocStore({ clock, ttlSeconds: 1800 }));

    const res = await app.request("/docs", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "text/html" },
      body: HTML,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      url: string;
      expiresIn: number;
    };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.url).toContain(`/docs/${body.id}`);
    expect(body.expiresIn).toBe(1800);
  });

  it("GET /docs/:id returns the stored HTML with a text/html content-type (no auth)", async () => {
    const { clock } = mutableClock();
    const app = makeApp(new EphemeralDocStore({ clock, ttlSeconds: 1800 }));

    const post = await app.request("/docs", {
      method: "POST",
      headers: { ...auth() },
      body: HTML,
    });
    const { id } = (await post.json()) as { id: string };

    // No Authorization header — capability URL is public.
    const get = await app.request(`/docs/${id}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("text/html");
    expect(await get.text()).toBe(HTML);
  });

  it("GET /docs/:id returns 404 once the document has expired", async () => {
    const { clock, advance } = mutableClock();
    const app = makeApp(new EphemeralDocStore({ clock, ttlSeconds: 10 }));

    const post = await app.request("/docs", {
      method: "POST",
      headers: { ...auth() },
      body: HTML,
    });
    const { id } = (await post.json()) as { id: string };

    advance(10_001); // past the TTL
    const get = await app.request(`/docs/${id}`);
    expect(get.status).toBe(404);
  });

  it("GET /docs/:id returns 404 for an unknown id", async () => {
    const { clock } = mutableClock();
    const app = makeApp(new EphemeralDocStore({ clock }));

    const res = await app.request("/docs/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("POST /docs without a valid bearer returns 401", async () => {
    const { clock } = mutableClock();
    const app = makeApp(new EphemeralDocStore({ clock }));

    const res = await app.request("/docs", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "text/html",
      },
      body: HTML,
    });
    expect(res.status).toBe(401);
  });

  it("POST /docs with no Authorization header returns 401", async () => {
    const { clock } = mutableClock();
    const app = makeApp(new EphemeralDocStore({ clock }));

    const res = await app.request("/docs", {
      method: "POST",
      headers: { "Content-Type": "text/html" },
      body: HTML,
    });
    expect(res.status).toBe(401);
  });
});
