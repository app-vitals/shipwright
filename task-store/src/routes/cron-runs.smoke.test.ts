/**
 * task-store/src/routes/cron-runs.smoke.test.ts
 *
 * Smoke tests for the /cron-runs routes via in-process app.request() — PCR-1.1.
 * Wires the REAL RepoCronRunService against a small in-memory Prisma double so
 * the HTTP contract runs through the actual service validation.
 *
 * Covers:
 *   - POST → 201, append-only (two POSTs, two rows)
 *   - POST → 400 on bad metrics / routing counts / repo / outcome / timestamps;
 *     agent token out-of-scope repo → 403
 *   - GET newest-first, machineState omitted unless includeDetail=true, filters
 *   - GET /latest skips failed runs, 404 when no ok/no_op run, returns
 *     machineState to an in-scope token that did not write the run
 *   - Agent tokens only see their own account
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "../app.ts";
import type { ScopeResolver } from "../auth.ts";
import { RepoCronRunService } from "../repo-cron-run-service.ts";
import type { PrismaClient } from "../index.ts";
import type { SessionServiceLike } from "../session-service.ts";
import type { TaskServiceLike } from "../task-service.ts";
import type { TokenServiceLike } from "../token-service.ts";

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";

// ─── Fakes for services not under test ────────────────────────────────────────

function fakeSessionService(): SessionServiceLike {
  return {
    async list() {
      return { sessions: [], total: 0, limit: 50 };
    },
    async get() {
      return null;
    },
    async update() {
      throw new Error("not implemented");
    },
    async acquirePlanningLock() {
      throw new Error("not implemented");
    },
    async releasePlanningLock() {
      throw new Error("not implemented");
    },
  };
}

function fakeTaskService(): TaskServiceLike {
  return new Proxy({} as TaskServiceLike, {
    get() {
      return async () => {
        throw new Error("not implemented");
      };
    },
  });
}

function fakeTokenService(): TokenServiceLike {
  return {
    async create() {
      throw new Error("not implemented");
    },
    async validate(raw: string) {
      if (raw === AGENT_TOKEN) return { id: "tok-2", agentId: "agent-1" };
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

// ─── In-memory Prisma double ──────────────────────────────────────────────────

type Row = Record<string, unknown> & {
  id: string;
  accountId: string;
  cronId: string;
  repo: string;
  outcome: string;
  finishedAt: Date;
};

function makePrismaDouble() {
  const rows: Row[] = [];
  let counter = 0;

  function matches(r: Row, where: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (k === "repo" && v && typeof v === "object") {
        if (!(v as { in: string[] }).in.includes(r.repo)) return false;
      } else if (k === "outcome" && v && typeof v === "object") {
        if (!(v as { in: string[] }).in.includes(r.outcome)) return false;
      } else if (r[k] !== v) return false;
    }
    return true;
  }

  const sorted = (matched: Row[]) =>
    [...matched].sort(
      (a, b) =>
        b.finishedAt.getTime() - a.finishedAt.getTime() ||
        b.id.localeCompare(a.id),
    );

  const prisma = {
    repoCronRun: {
      create({ data }: { data: Record<string, unknown> }) {
        counter += 1;
        const row = {
          id: `rcr-${String(counter).padStart(3, "0")}`,
          createdAt: new Date(),
          taskId: null,
          scheduledFor: null,
          machineState: null,
          ...data,
        } as unknown as Row;
        rows.push(row);
        return Promise.resolve(row);
      },
      findMany({
        where = {},
        take,
        omit,
      }: {
        where?: Record<string, unknown>;
        take?: number;
        omit?: Record<string, boolean>;
      }) {
        const matched = sorted(rows.filter((r) => matches(r, where))).slice(
          0,
          take,
        );
        return Promise.resolve(
          matched.map((r) => {
            const copy = { ...r };
            for (const k of Object.keys(omit ?? {})) delete copy[k];
            return copy;
          }),
        );
      },
      findFirst({ where = {} }: { where?: Record<string, unknown> }) {
        return Promise.resolve(
          sorted(rows.filter((r) => matches(r, where)))[0] ?? null,
        );
      },
      count({ where = {} }: { where?: Record<string, unknown> }) {
        return Promise.resolve(rows.filter((r) => matches(r, where)).length);
      },
    },
    $transaction<T>(ops: Promise<T>[]): Promise<T[]> {
      return Promise.all(ops);
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
}

function makeApp(scopeResolver?: ScopeResolver) {
  const { prisma, rows } = makePrismaDouble();
  const app = createTaskStoreApp({
    taskService: fakeTaskService(),
    tokenService: fakeTokenService(),
    sessionService: fakeSessionService(),
    repoCronRunService: new RepoCronRunService(prisma),
    scopeResolver,
  });
  return { app, rows };
}

const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const agent = { Authorization: `Bearer ${AGENT_TOKEN}` };
const scopeFor =
  (repos: string[], accountId: string): ScopeResolver =>
  async () => ({ repos, accountId });

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    cronId: "error-patrol",
    repo: "org/repo",
    taskId: "SC-1",
    scheduledFor: "2026-11-27T06:00:00.000Z",
    startedAt: "2026-11-27T06:00:05.000Z",
    finishedAt: "2026-11-27T06:04:00.000Z",
    commitSha: "abc123",
    outcome: "ok",
    metrics: { scanned: 12, auto: 2, review: 1, plan: 0 },
    machineState: { sentryProject: "web" },
    ...overrides,
  };
}

type TestApp = ReturnType<typeof makeApp>["app"];

function post(
  app: TestApp,
  body: unknown,
  headers: Record<string, string> = admin,
) {
  return app.request("/cron-runs", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(app: TestApp, path: string, headers = admin) {
  return app.request(`/cron-runs${path}`, { headers });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/cron-runs routes (smoke)", () => {
  it("no bearer token — 401", async () => {
    const { app } = makeApp();
    expect((await app.request("/cron-runs")).status).toBe(401);
  });

  describe("POST", () => {
    it("201; two POSTs for the same (cronId, repo) append two rows", async () => {
      const { app, rows } = makeApp();
      const first = await post(app, validBody());
      expect(first.status).toBe(201);
      const body = (await first.json()) as Record<string, unknown>;
      expect(body.accountId).toBe("default");
      expect(body.metrics).toEqual({
        scanned: 12,
        auto: 2,
        review: 1,
        plan: 0,
      });
      expect((await post(app, validBody())).status).toBe(201);
      expect(rows).toHaveLength(2);
    });

    const bad: [string, Record<string, unknown>][] = [
      ["non-numeric metric", { metrics: { scanned: "12" } }],
      ["non-finite metric", { metrics: { scanned: null } }],
      ["array metrics", { metrics: [1, 2] }],
      ["missing metrics", { metrics: undefined }],
      ["negative auto", { metrics: { auto: -1 } }],
      ["fractional review", { metrics: { review: 1.5 } }],
      ["fractional plan", { metrics: { plan: 0.5 } }],
      ["malformed repo", { repo: "not-a-repo" }],
      ["unknown outcome", { outcome: "great" }],
      ["bad startedAt", { startedAt: "yesterday" }],
      ["bad finishedAt", { finishedAt: "" }],
      ["bad scheduledFor", { scheduledFor: "soon" }],
      ["empty cronId", { cronId: "" }],
      ["empty commitSha", { commitSha: "" }],
    ];
    for (const [name, override] of bad) {
      it(`400 — ${name}`, async () => {
        const { app, rows } = makeApp();
        const res = await post(app, validBody(override));
        expect(res.status).toBe(400);
        expect(rows).toHaveLength(0);
      });
    }

    it("agent token, repo outside its scope — 403", async () => {
      const { app, rows } = makeApp(scopeFor(["org/other"], "acct-1"));
      const res = await post(app, validBody(), agent);
      expect(res.status).toBe(403);
      expect(rows).toHaveLength(0);
    });

    it("agent token writes to its own account; admin may pick accountId", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-1"));
      const a = (await (await post(app, validBody(), agent)).json()) as {
        accountId: string;
      };
      expect(a.accountId).toBe("acct-1");
      const b = (await (
        await post(app, validBody({ accountId: "acct-9" }))
      ).json()) as { accountId: string };
      expect(b.accountId).toBe("acct-9");
    });
  });

  describe("GET /", () => {
    it("newest finishedAt first; omits machineState unless includeDetail=true", async () => {
      const { app } = makeApp();
      await post(app, validBody({ finishedAt: "2026-11-26T00:00:00.000Z" }));
      await post(app, validBody({ finishedAt: "2026-11-27T00:00:00.000Z" }));
      const res = await get(app, "");
      const body = (await res.json()) as {
        runs: Record<string, unknown>[];
        total: number;
        nextCursor: string | null;
      };
      expect(body.total).toBe(2);
      expect(body.nextCursor).toBeNull();
      expect(body.runs.map((r) => r.finishedAt)).toEqual([
        "2026-11-27T00:00:00.000Z",
        "2026-11-26T00:00:00.000Z",
      ]);
      expect(body.runs.every((r) => !("machineState" in r))).toBe(true);

      const detail = (await (await get(app, "?includeDetail=true")).json()) as {
        runs: Record<string, unknown>[];
      };
      expect(detail.runs[0]?.machineState).toEqual({ sentryProject: "web" });
    });

    it("filters by cronId and repo", async () => {
      const { app } = makeApp();
      await post(app, validBody());
      await post(app, validBody({ cronId: "other" }));
      await post(app, validBody({ repo: "org/two" }));
      const byCron = (await (await get(app, "?cronId=other")).json()) as {
        total: number;
      };
      expect(byCron.total).toBe(1);
      const byRepo = (await (await get(app, "?repo=org/two")).json()) as {
        total: number;
      };
      expect(byRepo.total).toBe(1);
    });

    it("agent tokens only see their own account and in-scope repos", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-1"));
      await post(app, validBody({ accountId: "acct-1" }));
      await post(app, validBody({ accountId: "acct-2" }));
      const res = (await (await get(app, "", agent)).json()) as {
        runs: { accountId: string }[];
      };
      expect(res.runs.map((r) => r.accountId)).toEqual(["acct-1"]);
      const out = (await (await get(app, "?repo=org/zzz", agent)).json()) as {
        total: number;
      };
      expect(out.total).toBe(0);
    });
  });

  describe("GET /latest", () => {
    const q = "/latest?cronId=error-patrol&repo=org/repo";

    it("404 when there is no run", async () => {
      const { app } = makeApp();
      expect((await get(app, q)).status).toBe(404);
    });

    it("skips failed runs; 404 when only failed runs exist", async () => {
      const { app } = makeApp();
      await post(app, validBody({ outcome: "failed" }));
      expect((await get(app, q)).status).toBe(404);
      await post(
        app,
        validBody({
          outcome: "ok",
          finishedAt: "2026-11-20T00:00:00.000Z",
          commitSha: "older-ok",
        }),
      );
      await post(
        app,
        validBody({
          outcome: "failed",
          finishedAt: "2026-11-27T00:00:00.000Z",
          commitSha: "newer-failed",
        }),
      );
      const res = await get(app, q);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { commitSha: string }).commitSha).toBe(
        "older-ok",
      );
    });

    it("no_op counts; returns the newer of two ok runs with machineState", async () => {
      const { app } = makeApp();
      await post(
        app,
        validBody({ finishedAt: "2026-11-20T00:00:00.000Z", commitSha: "old" }),
      );
      await post(
        app,
        validBody({
          outcome: "no_op",
          finishedAt: "2026-11-21T00:00:00.000Z",
          commitSha: "new",
        }),
      );
      const body = (await (await get(app, q)).json()) as {
        commitSha: string;
        machineState: unknown;
      };
      expect(body.commitSha).toBe("new");
      expect(body.machineState).toEqual({ sentryProject: "web" });
    });

    it("returns machineState to an in-scope agent token that did not write the run", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-1"));
      await post(app, validBody({ accountId: "acct-1" })); // written by admin
      const res = await get(app, q, agent);
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { machineState: unknown }).machineState,
      ).toEqual({ sentryProject: "web" });
    });

    it("404 for another account's run or an out-of-scope repo", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-1"));
      await post(app, validBody({ accountId: "acct-2" }));
      expect((await get(app, q, agent)).status).toBe(404);
      await post(app, validBody({ accountId: "acct-1", repo: "org/hidden" }));
      expect(
        (await get(app, "/latest?cronId=error-patrol&repo=org/hidden", agent))
          .status,
      ).toBe(404);
    });
  });
});
