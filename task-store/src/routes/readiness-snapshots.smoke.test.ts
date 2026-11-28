/**
 * task-store/src/routes/readiness-snapshots.smoke.test.ts
 *
 * Smoke tests for the /readiness-snapshots routes via in-process
 * app.request() — RDY-1.2. Wires the REAL ReadinessSnapshotService against a
 * small hand-built in-memory Prisma double (mirrors
 * verification-checks.smoke.test.ts) so the HTTP contract is exercised end to
 * end through the actual service's validation and upsert logic.
 *
 * Covers:
 *   - POST -> 201; repeat POST (same repo+commit) -> 200, row replaced in place,
 *     still exactly one row
 *   - POST -> 400 on invalid level / malformed repo / malformed checks entry /
 *     negative counts / empty commitSha; agent token out-of-scope repo -> 403
 *   - GET ?repo= newest first, honouring since/limit
 *   - GET /latest -> one row per repo (newest), or just ?repo=; out-of-scope
 *     ?repo= -> 403 for agent tokens
 *   - Agent tokens only see their own account; admin may pass accountId
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "../app.ts";
import type { ScopeResolver } from "../auth.ts";
import { FixedClock } from "../clock.ts";
import { ReadinessSnapshotService } from "../readiness-snapshot-service.ts";
import type { PrismaClient } from "../index.ts";
import type { SessionServiceLike } from "../session-service.ts";
import type { TaskServiceLike } from "../task-service.ts";
import type { TokenServiceLike } from "../token-service.ts";

const NOW = new Date("2026-11-28T12:00:00.000Z");
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
  repo: string;
  commitSha: string;
  measuredAt: Date;
};

function makePrismaDouble() {
  const rows: Row[] = [];
  let counter = 0;

  function matches(r: Row, where: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (k === "measuredAt") {
        const gte = (v as { gte?: Date }).gte;
        if (gte && r.measuredAt < gte) return false;
      } else if (k === "repo" && v && typeof v === "object") {
        if (!(v as { in: string[] }).in.includes(r.repo)) return false;
      } else if (r[k] !== v) return false;
    }
    return true;
  }

  const prisma = {
    readinessSnapshot: {
      findUnique({
        where,
      }: {
        where: {
          accountId_repo_commitSha: {
            accountId: string;
            repo: string;
            commitSha: string;
          };
        };
      }) {
        const k = where.accountId_repo_commitSha;
        return Promise.resolve(
          rows.find(
            (r) =>
              r.accountId === k.accountId &&
              r.repo === k.repo &&
              r.commitSha === k.commitSha,
          ) ?? null,
        );
      },
      create({ data }: { data: Record<string, unknown> }) {
        counter += 1;
        const row = {
          id: `rs-${counter}`,
          createdAt: new Date(),
          ...data,
        } as unknown as Row;
        rows.push(row);
        return Promise.resolve(row);
      },
      upsert({
        where,
        create,
        update,
      }: {
        where: {
          accountId_repo_commitSha: {
            accountId: string;
            repo: string;
            commitSha: string;
          };
        };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) {
        const k = where.accountId_repo_commitSha;
        const row = rows.find(
          (r) =>
            r.accountId === k.accountId &&
            r.repo === k.repo &&
            r.commitSha === k.commitSha,
        );
        if (row) {
          Object.assign(row, update);
          return Promise.resolve(row);
        }
        counter += 1;
        const made = {
          id: `rs-${counter}`,
          createdAt: new Date(),
          ...create,
        } as unknown as Row;
        rows.push(made);
        return Promise.resolve(made);
      },
      update({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) {
        const row = rows.find((r) => r.id === where.id) as Row;
        Object.assign(row, data);
        return Promise.resolve(row);
      },
      findMany({
        where = {},
        orderBy,
        take,
        skip,
        distinct,
      }: {
        where?: Record<string, unknown>;
        orderBy?:
          | { measuredAt?: "asc" | "desc" }
          | { repo?: "asc"; measuredAt?: "asc" | "desc" }[];
        take?: number;
        skip?: number;
        distinct?: string[];
      }) {
        let matched = rows.filter((r) => matches(r, where));
        const orders = Array.isArray(orderBy)
          ? orderBy
          : orderBy
            ? [orderBy]
            : [];
        if (orders.length) {
          matched = [...matched].sort((a, b) => {
            for (const o of orders) {
              if ("repo" in o && o.repo) {
                const c = a.repo.localeCompare(b.repo);
                if (c !== 0) return c;
              }
              if (o.measuredAt) {
                const dir = o.measuredAt === "desc" ? -1 : 1;
                const d = a.measuredAt.getTime() - b.measuredAt.getTime();
                if (d !== 0) return dir * d;
              }
            }
            return 0;
          });
        }
        if (distinct?.length) {
          const seen = new Set<string>();
          matched = matched.filter((r) => {
            const key = distinct.map((d) => String(r[d])).join("|");
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        const start = skip ?? 0;
        return Promise.resolve(
          take !== undefined
            ? matched.slice(start, start + take)
            : matched.slice(start),
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
    readinessSnapshotService: new ReadinessSnapshotService(
      prisma,
      FixedClock(NOW),
    ),
    scopeResolver,
  });
  return { app, rows };
}

const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const agent = { Authorization: `Bearer ${AGENT_TOKEN}` };
const scopeFor =
  (repos: string[], accountId: string): ScopeResolver =>
  async () => ({ repos, accountId });

const CHECKS = [
  { id: "readme-present", level: 1, result: "pass", owner: "docs-freshness" },
  { id: "linter-configured", level: 1, result: "fail", owner: "entropy" },
  { id: "preview-environment", level: 3, result: "n/a", owner: "environments" },
];

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    repo: "org/repo",
    commitSha: "abc123",
    level: 2,
    passing: 2,
    failing: 1,
    checks: CHECKS,
    catalogueVersion: "1",
    measuredAt: "2026-11-10T00:00:00.000Z",
    ...overrides,
  };
}

function post(
  app: ReturnType<typeof makeApp>["app"],
  body: unknown,
  headers: Record<string, string> = admin,
) {
  return app.request("/readiness-snapshots", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/readiness-snapshots routes (smoke)", () => {
  it("no bearer token — 401", async () => {
    const { app } = makeApp();
    expect((await app.request("/readiness-snapshots")).status).toBe(401);
  });

  describe("POST", () => {
    it("201 with the stored fields; repeat POST - 200, replaced, one row", async () => {
      const { app, rows } = makeApp();
      const res = await post(app, validBody());
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        accountId: "default",
        repo: "org/repo",
        level: 2,
        passing: 2,
        failing: 1,
        catalogueVersion: "1",
      });
      expect(body.checks).toEqual(CHECKS);

      const again = await post(
        app,
        validBody({ level: 3, passing: 3, failing: 0, catalogueVersion: "2" }),
      );
      expect(again.status).toBe(200);
      const updated = (await again.json()) as Record<string, unknown>;
      expect(updated).toMatchObject({ level: 3, catalogueVersion: "2" });
      expect(updated.id).toBe(body.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.level).toBe(3);
    });

    it("defaults measuredAt to now when omitted", async () => {
      const { app } = makeApp();
      const res = await post(app, validBody({ measuredAt: undefined }));
      expect(res.status).toBe(201);
      expect(((await res.json()) as { measuredAt: string }).measuredAt).toBe(
        NOW.toISOString(),
      );
    });

    const badCheck = (o: Record<string, unknown>) => [{ ...CHECKS[0], ...o }];
    const bad: [string, Record<string, unknown>][] = [
      ["level 6", { level: 6 }],
      ["level -1", { level: -1 }],
      ["level non-integer", { level: 2.5 }],
      ["level string", { level: "3" }],
      ["negative passing", { passing: -1 }],
      ["negative failing", { failing: -1 }],
      ["empty commitSha", { commitSha: "" }],
      ["malformed repo", { repo: "not-a-repo" }],
      ["malformed repo (extra segment)", { repo: "a/b/c" }],
      ["missing catalogueVersion", { catalogueVersion: undefined }],
      ["checks not an array", { checks: { id: "x" } }],
      ["checks missing", { checks: undefined }],
      ["check missing id", { checks: badCheck({ id: undefined }) }],
      ["check bad result", { checks: badCheck({ result: "maybe" }) }],
      ["check level 0", { checks: badCheck({ level: 0 }) }],
      ["check level non-integer", { checks: badCheck({ level: 1.5 }) }],
      ["check missing owner", { checks: badCheck({ owner: undefined }) }],
    ];
    for (const [name, override] of bad) {
      it(`400 — ${name}`, async () => {
        const { app, rows } = makeApp();
        const res = await post(app, validBody(override));
        expect(res.status).toBe(400);
        expect(rows).toHaveLength(0);
      });
    }

    it("agent token, out-of-scope repo — 403", async () => {
      const { app, rows } = makeApp(scopeFor(["org/other"], "acct-a"));
      const res = await post(app, validBody(), agent);
      expect(res.status).toBe(403);
      expect(rows).toHaveLength(0);
    });

    it("agent token, in-scope repo — stamped with its account, body accountId ignored", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-a"));
      const res = await post(app, validBody({ accountId: "acct-b" }), agent);
      expect(res.status).toBe(201);
      expect(((await res.json()) as { accountId: string }).accountId).toBe(
        "acct-a",
      );
    });

    it("admin may pass accountId; same commit in two accounts = two rows", async () => {
      const { app, rows } = makeApp();
      expect((await post(app, validBody({ accountId: "acct-a" }))).status).toBe(
        201,
      );
      expect((await post(app, validBody({ accountId: "acct-b" }))).status).toBe(
        201,
      );
      expect(rows.map((r) => r.accountId).sort()).toEqual(["acct-a", "acct-b"]);
    });
  });

  describe("GET /readiness-snapshots", () => {
    async function seed(app: ReturnType<typeof makeApp>["app"]) {
      for (const [repo, sha, at] of [
        ["org/a", "s1", "2026-11-01T00:00:00.000Z"],
        ["org/a", "s2", "2026-11-05T00:00:00.000Z"],
        ["org/a", "s3", "2026-11-09T00:00:00.000Z"],
        ["org/b", "s4", "2026-11-07T00:00:00.000Z"],
      ] as const) {
        await post(app, validBody({ repo, commitSha: sha, measuredAt: at }));
      }
    }

    it("?repo= returns only that repo, newest first, with total/limit", async () => {
      const { app } = makeApp();
      await seed(app);
      const res = await app.request("/readiness-snapshots?repo=org/a", {
        headers: admin,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        snapshots: { commitSha: string }[];
        total: number;
        limit: number;
      };
      expect(body.snapshots.map((s) => s.commitSha)).toEqual([
        "s3",
        "s2",
        "s1",
      ]);
      expect(body).toMatchObject({ total: 3, limit: 50 });
    });

    it("honours since and limit", async () => {
      const { app } = makeApp();
      await seed(app);
      const since = await app.request(
        "/readiness-snapshots?repo=org/a&since=2026-11-04T00:00:00.000Z",
        { headers: admin },
      );
      const sb = (await since.json()) as {
        snapshots: { commitSha: string }[];
        total: number;
      };
      expect(sb.snapshots.map((s) => s.commitSha)).toEqual(["s3", "s2"]);
      expect(sb.total).toBe(2);

      const page = await app.request(
        "/readiness-snapshots?repo=org/a&limit=1",
        {
          headers: admin,
        },
      );
      const pb = (await page.json()) as {
        snapshots: { commitSha: string }[];
        limit: number;
        nextCursor: string | null;
      };
      expect(pb.snapshots.map((s) => s.commitSha)).toEqual(["s3"]);
      expect(pb).toMatchObject({ limit: 1 });
      expect(pb.nextCursor).not.toBeNull();
      expect(pb).not.toHaveProperty("offset");
    });

    it("400 on malformed since", async () => {
      const { app } = makeApp();
      const res = await app.request("/readiness-snapshots?since=garbage", {
        headers: admin,
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /readiness-snapshots/latest", () => {
    async function seed(app: ReturnType<typeof makeApp>["app"]) {
      for (const [repo, sha, at] of [
        ["org/a", "old", "2026-11-01T00:00:00.000Z"],
        ["org/a", "new", "2026-11-09T00:00:00.000Z"],
        ["org/b", "only", "2026-11-03T00:00:00.000Z"],
      ] as const) {
        await post(app, validBody({ repo, commitSha: sha, measuredAt: at }));
      }
    }

    it("exactly one row per repo, newest by measuredAt", async () => {
      const { app } = makeApp();
      await seed(app);
      const res = await app.request("/readiness-snapshots/latest", {
        headers: admin,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        snapshots: { repo: string; commitSha: string }[];
      };
      expect(body.snapshots).toHaveLength(2);
      const byRepo = Object.fromEntries(
        body.snapshots.map((s) => [s.repo, s.commitSha]),
      );
      expect(byRepo).toEqual({ "org/a": "new", "org/b": "only" });
    });

    it("?repo= returns just that repo's newest; unknown repo is empty", async () => {
      const { app } = makeApp();
      await seed(app);
      const one = (await (
        await app.request("/readiness-snapshots/latest?repo=org/a", {
          headers: admin,
        })
      ).json()) as { snapshots: { commitSha: string }[] };
      expect(one.snapshots.map((s) => s.commitSha)).toEqual(["new"]);
      const none = await app.request(
        "/readiness-snapshots/latest?repo=org/none",
        { headers: admin },
      );
      expect(none.status).toBe(200);
      expect(
        ((await none.json()) as { snapshots: unknown[] }).snapshots,
      ).toEqual([]);
    });

    it("agent token ?repo= out of scope - 403", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-a"));
      await post(app, validBody({ repo: "org/secret", accountId: "acct-a" }));
      const res = await app.request(
        "/readiness-snapshots/latest?repo=org/secret",
        {
          headers: agent,
        },
      );
      expect(res.status).toBe(403);
    });
  });

  describe("account scoping", () => {
    it("agent token never sees another account's rows (list + latest)", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-a"));
      await post(app, validBody({ commitSha: "mine" }), agent);
      // Another account's row, written by an admin.
      await post(app, validBody({ commitSha: "theirs", accountId: "acct-b" }));

      const list = (await (
        await app.request("/readiness-snapshots?repo=org/repo", {
          headers: agent,
        })
      ).json()) as { snapshots: { commitSha: string }[]; total: number };
      expect(list.snapshots.map((s) => s.commitSha)).toEqual(["mine"]);
      expect(list.total).toBe(1);

      const latest = (await (
        await app.request("/readiness-snapshots/latest", { headers: agent })
      ).json()) as { snapshots: { accountId: string }[] };
      expect(latest.snapshots.map((s) => s.accountId)).toEqual(["acct-a"]);
    });

    it("agent ?accountId= is ignored; admin ?accountId= narrows", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-a"));
      await post(app, validBody({ commitSha: "mine" }), agent);
      await post(app, validBody({ commitSha: "theirs", accountId: "acct-b" }));

      const asAgent = (await (
        await app.request("/readiness-snapshots?accountId=acct-b", {
          headers: agent,
        })
      ).json()) as { snapshots: { commitSha: string }[] };
      expect(asAgent.snapshots.map((s) => s.commitSha)).toEqual(["mine"]);

      const asAdmin = (await (
        await app.request("/readiness-snapshots?accountId=acct-b", {
          headers: admin,
        })
      ).json()) as { snapshots: { commitSha: string }[] };
      expect(asAdmin.snapshots.map((s) => s.commitSha)).toEqual(["theirs"]);
    });

    it("agent token never reads repos outside its scope (list + latest)", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-a"));
      await post(app, validBody({ commitSha: "mine" }), agent);
      // Same account, repo outside the agent's scope — written by an admin.
      await post(
        app,
        validBody({
          repo: "org/secret",
          commitSha: "hidden",
          accountId: "acct-a",
        }),
      );

      const list = (await (
        await app.request("/readiness-snapshots", { headers: agent })
      ).json()) as { snapshots: { commitSha: string }[]; total: number };
      expect(list.snapshots.map((s) => s.commitSha)).toEqual(["mine"]);
      expect(list.total).toBe(1);

      const forbidden = (await (
        await app.request("/readiness-snapshots?repo=org/secret", {
          headers: agent,
        })
      ).json()) as { snapshots: unknown[]; total: number };
      expect(forbidden.snapshots).toEqual([]);
      expect(forbidden.total).toBe(0);

      const latest = (await (
        await app.request("/readiness-snapshots/latest", { headers: agent })
      ).json()) as { snapshots: { repo: string }[] };
      expect(latest.snapshots.map((s) => s.repo)).toEqual(["org/repo"]);
    });

    it("agent token with an empty repo scope reads nothing", async () => {
      const { app } = makeApp(scopeFor([], "acct-a"));
      await post(app, validBody({ accountId: "acct-a" }));
      const list = (await (
        await app.request("/readiness-snapshots", { headers: agent })
      ).json()) as { snapshots: unknown[]; total: number };
      expect(list.snapshots).toEqual([]);
      expect(list.total).toBe(0);
      const latest = (await (
        await app.request("/readiness-snapshots/latest", { headers: agent })
      ).json()) as { snapshots: unknown[] };
      expect(latest.snapshots).toEqual([]);
    });
  });
});
