/**
 * task-store/src/routes/verification-checks.smoke.test.ts
 *
 * Smoke tests for the /verification-checks routes via in-process
 * app.request() — LVB-5.1.
 *
 * Mirrors tasks.pr-open-stamp.smoke.test.ts's pattern rather than the
 * hand-faked-service pattern used by most other *.smoke.test.ts files here:
 * this wires the REAL VerificationCheckService against a small hand-built
 * in-memory Prisma double (task/pullRequest/verificationCheck), so the
 * route's HTTP-contract behavior (auth, status codes, error propagation) is
 * exercised end to end through the actual service's validation — not a
 * second, hand-duplicated copy of its business rules. No real DB, no
 * mock.module(), no global overrides. The service's exhaustive validation
 * rules (e.g. every reasonCategory/status combination) are unit-tested in
 * verification-check-service.unit.test.ts; this file covers the HTTP
 * contract only.
 *
 * Covers:
 *   - No bearer token → 401
 *   - POST /verification-checks → 201 happy path (against a task, and
 *     against a PR)
 *   - POST /verification-checks → 400 when neither/both taskId & prId given
 *   - POST /verification-checks → 404 when the referenced task/pr is missing
 *   - POST /verification-checks → 400 when status:'ran_failed' is submitted
 *     with a non-null reasonCategory (the service's rejection propagates
 *     through the route as a clean 400, not a raw 500)
 *   - GET /verification-checks?taskId= / ?prId= → 200 with the recorded rows
 *   - GET /verification-checks → 400 when neither/both ?taskId=/?prId= given
 *   - GET /verification-checks → 404 when the referenced task/pr is missing
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "../app.ts";
import { FixedClock } from "../clock.ts";
import type { PrismaClient } from "../index.ts";
import type { SessionServiceLike } from "../session-service.ts";
import type { TaskServiceLike } from "../task-service.ts";
import type { TokenServiceLike } from "../token-service.ts";
import { VerificationCheckService } from "../verification-check-service.ts";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const ADMIN_TOKEN = "admin-token";

// ─── Fake builders (routes/services not under test here) ──────────────────────

function fakeSessionService(): SessionServiceLike {
  return {
    async list() {
      return { sessions: [], total: 0, limit: 50, offset: 0 };
    },
    async get() {
      return null;
    },
    async update() {
      throw new Error("not implemented");
    },
  };
}

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
    async bulk() {
      return { inserted: 0, updated: 0, skipped: [] };
    },
    async update(_id, data) {
      return data as never;
    },
    async remove() {},
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
    async unblock() {
      return {} as never;
    },
    async distinct() {
      return { sessions: [], repos: [], orgs: [] };
    },
    async getEvents() {
      return { events: [], total: 0 };
    },
  };
}

function fakeAdminTokenService(): TokenServiceLike {
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
    async validate(raw: string) {
      return raw === ADMIN_TOKEN ? { id: "tok-1", agentId: null } : null;
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

// ─── Hand-built in-memory Prisma double ────────────────────────────────────────
// Mirrors verification-check-service.unit.test.ts's makePrismaDouble, extended
// with a real in-memory verificationCheck store (create/findMany/count) so
// GET after POST round-trips through actual data rather than a stub.

function makePrismaDouble(
  opts: { taskIds?: string[]; prIds?: string[] } = {},
): PrismaClient {
  const taskIds = new Set(opts.taskIds ?? ["task-1"]);
  const prIds = new Set(opts.prIds ?? ["pr-1"]);
  const rows: Record<string, unknown>[] = [];
  let counter = 0;

  const prisma = {
    task: {
      findUnique({ where }: { where: { id: string } }) {
        return Promise.resolve(
          taskIds.has(where.id) ? { id: where.id } : null,
        );
      },
    },
    pullRequest: {
      findUnique({ where }: { where: { id: string } }) {
        return Promise.resolve(prIds.has(where.id) ? { id: where.id } : null);
      },
    },
    verificationCheck: {
      create({ data }: { data: Record<string, unknown> }) {
        counter += 1;
        const row = { id: `vc-${counter}`, createdAt: new Date(), ...data };
        rows.push(row);
        return Promise.resolve(row);
      },
      findMany({ where }: { where: Record<string, unknown> }) {
        const matched = rows.filter((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        );
        return Promise.resolve(matched);
      },
      count({ where }: { where: Record<string, unknown> }) {
        const matched = rows.filter((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        );
        return Promise.resolve(matched.length);
      },
    },
    $transaction<T>(ops: Promise<T>[]): Promise<T[]> {
      return Promise.all(ops);
    },
  };

  return prisma as unknown as PrismaClient;
}

function makeApp(opts: { taskIds?: string[]; prIds?: string[] } = {}) {
  const prisma = makePrismaDouble(opts);
  const verificationCheckService = new VerificationCheckService(
    prisma,
    FixedClock(NOW),
  );
  return createTaskStoreApp({
    taskService: fakeTaskService(),
    tokenService: fakeAdminTokenService(),
    sessionService: fakeSessionService(),
    verificationCheckService,
  });
}

function adminAuth(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}` };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/verification-checks routes (smoke)", () => {
  it("no bearer token — 401", async () => {
    const app = makeApp();
    const res = await app.request("/verification-checks?taskId=task-1");
    expect(res.status).toBe(401);
  });

  // ─── POST /verification-checks ────────────────────────────────────────────

  it("POST against a valid taskId — 201, persists the row", async () => {
    const app = makeApp();
    const res = await app.request("/verification-checks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        status: "ran_passed",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.taskId).toBe("task-1");
    expect(body.prRecordId).toBeNull();
    expect(body.status).toBe("ran_passed");
    expect(body.at).toBe(NOW.toISOString());
  });

  it("POST against a valid prId — 201, persists the row", async () => {
    const app = makeApp();
    const res = await app.request("/verification-checks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        prId: "pr-1",
        repo: "org/repo",
        checkName: "lint",
        status: "skipped",
        reasonCategory: "missing_tool",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.prRecordId).toBe("pr-1");
    expect(body.taskId).toBeNull();
    expect(body.reasonCategory).toBe("missing_tool");
  });

  it("POST with neither taskId nor prId — 400", async () => {
    const app = makeApp();
    const res = await app.request("/verification-checks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        repo: "org/repo",
        checkName: "unit",
        status: "ran_passed",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST with both taskId and prId — 400", async () => {
    const app = makeApp();
    const res = await app.request("/verification-checks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "task-1",
        prId: "pr-1",
        repo: "org/repo",
        checkName: "unit",
        status: "ran_passed",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST against a missing taskId — 404", async () => {
    const app = makeApp();
    const res = await app.request("/verification-checks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "does-not-exist",
        repo: "org/repo",
        checkName: "unit",
        status: "ran_passed",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("POST status:'ran_failed' with a non-null reasonCategory — 400 (service rejection propagates, not a 500)", async () => {
    const app = makeApp();
    const res = await app.request("/verification-checks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        status: "ran_failed",
        reasonCategory: "missing_tool",
      }),
    });
    expect(res.status).toBe(400);
  });

  // ─── GET /verification-checks ─────────────────────────────────────────────

  it("GET ?taskId= after two POSTs against that task — 200 with both rows", async () => {
    const app = makeApp();
    await app.request("/verification-checks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "install",
        status: "ran_passed",
      }),
    });
    await app.request("/verification-checks", {
      method: "POST",
      headers: { ...adminAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        taskId: "task-1",
        repo: "org/repo",
        checkName: "unit",
        status: "timed_out",
        reasonCategory: "check_timeout",
      }),
    });

    const res = await app.request("/verification-checks?taskId=task-1", {
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      checks: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(2);
    expect(body.checks).toHaveLength(2);
    expect(body.checks.map((c) => c.checkName).sort()).toEqual([
      "install",
      "unit",
    ]);
  });

  it("GET ?prId= against a PR with no recorded checks — 200 with an empty list", async () => {
    const app = makeApp();
    const res = await app.request("/verification-checks?prId=pr-1", {
      headers: adminAuth(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: unknown[]; total: number };
    expect(body.checks).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("GET with neither ?taskId= nor ?prId= — 400", async () => {
    const app = makeApp();
    const res = await app.request("/verification-checks", {
      headers: adminAuth(),
    });
    expect(res.status).toBe(400);
  });

  it("GET with both ?taskId= and ?prId= — 400", async () => {
    const app = makeApp();
    const res = await app.request(
      "/verification-checks?taskId=task-1&prId=pr-1",
      { headers: adminAuth() },
    );
    expect(res.status).toBe(400);
  });

  it("GET ?taskId= for a missing task — 404", async () => {
    const app = makeApp();
    const res = await app.request(
      "/verification-checks?taskId=does-not-exist",
      { headers: adminAuth() },
    );
    expect(res.status).toBe(404);
  });
});
