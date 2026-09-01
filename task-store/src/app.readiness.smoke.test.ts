/**
 * task-store/src/app.readiness.smoke.test.ts
 *
 * Smoke tests for GET /health/ready — the DB-aware readiness probe route.
 * Unauthenticated, mirrors admin's /health/ready split (liveness stays
 * DB-independent on /health; readiness gates on `checkDbReady`).
 *
 * Covers:
 *   - 200 {status:"ok"} when checkDbReady is omitted (default always-ready,
 *     keeps existing callers/tests that don't inject it unaffected)
 *   - 503 {status:"not_ready"} when the injected checkDbReady resolves false
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import type { TaskServiceLike } from "./task-service.ts";
import type { TokenServiceLike } from "./token-service.ts";

function fakeTaskService(): TaskServiceLike {
  return {
    async list() {
      return { tasks: [], total: 0, limit: 50, offset: 0 };
    },
    async listReady() {
      return [];
    },
    async listBlocked() {
      return [];
    },
    async get() {
      return null;
    },
    async create(data) {
      return data as never;
    },
    async update(_id, data) {
      return data as never;
    },
    async remove() {
      return;
    },
    async claim() {
      return {} as never;
    },
    async heartbeat() {
      return {} as never;
    },
    async complete() {
      return {} as never;
    },
    async fail() {
      return {} as never;
    },
    async release() {
      return {} as never;
    },
    async recordSkip() {
      return {} as never;
    },
    async resetSkip() {
      return {} as never;
    },
    async bulk() {
      return { inserted: 0, updated: 0, skipped: [] };
    },
    async distinct() {
      return { sessions: [], repos: [], orgs: [] };
    },
    async getEvents() {
      return { events: [], total: 0 };
    },
  };
}

function fakeTokenService(): TokenServiceLike {
  return {
    async create(label?: string) {
      return {
        token: {
          id: "tok-1",
          token: "hash",
          label: label ?? null,
          agentId: null,
          createdAt: new Date(),
          revokedAt: null,
        },
        rawToken: "raw",
      };
    },
    async validate() {
      return null;
    },
    async revoke() {
      return null;
    },
    async list() {
      return [];
    },
    async update() {
      return null;
    },
  };
}

describe("GET /health/ready (smoke)", () => {
  it("returns 200 {status:'ok'} without auth when checkDbReady is omitted", async () => {
    const app = createTaskStoreApp({
      taskService: fakeTaskService(),
      tokenService: fakeTokenService(),
    });
    const res = await app.request("/health/ready");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("returns 503 {status:'not_ready'} without auth when checkDbReady resolves false", async () => {
    const app = createTaskStoreApp({
      taskService: fakeTaskService(),
      tokenService: fakeTokenService(),
      checkDbReady: async () => false,
    });
    const res = await app.request("/health/ready");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("not_ready");
  });
});
