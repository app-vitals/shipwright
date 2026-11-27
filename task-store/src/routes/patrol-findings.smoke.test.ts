/**
 * task-store/src/routes/patrol-findings.smoke.test.ts
 *
 * Smoke tests for the /patrol-findings routes via in-process app.request() —
 * PCR-1.2. Wires the REAL PatrolFindingService against a small in-memory
 * Prisma double so the HTTP contract runs through the actual service logic.
 *
 * Covers:
 *   - POST /batch creates, then continues findings (count, lastSeen, appended
 *     history) and is idempotent on an identical replay
 *   - 400 on bad repo / status / fingerprint / duplicates / observedAt
 *   - agent token, out-of-scope repo -> 403 on both write and read
 *   - a different in-scope agent (same account) reads another agent's rows;
 *     other accounts' rows are invisible
 *   - GET filters by cronId/repo/status and emits nextCursor
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "../app.ts";
import type { ScopeResolver } from "../auth.ts";
import type { PrismaClient } from "../index.ts";
import { PatrolFindingService } from "../patrol-finding-service.ts";
import type { SessionServiceLike } from "../session-service.ts";
import type { TaskServiceLike } from "../task-service.ts";
import type { TokenServiceLike } from "../token-service.ts";

const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";
const AGENT2_TOKEN = "agent-token-2";

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
      if (raw === AGENT2_TOKEN) return { id: "tok-3", agentId: "agent-2" };
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
  fingerprint: string;
  status: string;
  lastSeen: Date;
};

function makePrismaDouble() {
  const rows: Row[] = [];
  let counter = 0;

  function matches(r: Row, where: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (k === "AND") continue; // cursor paging is covered by the integration test
      if (v && typeof v === "object" && "in" in v) {
        if (!(v as { in: string[] }).in.includes(r[k] as string)) return false;
      } else if (r[k] !== v) return false;
    }
    return true;
  }

  const sorted = (matched: Row[]) =>
    [...matched].sort(
      (a, b) =>
        b.lastSeen.getTime() - a.lastSeen.getTime() || b.id.localeCompare(a.id),
    );

  const prisma = {
    patrolFinding: {
      create({ data }: { data: Record<string, unknown> }) {
        counter += 1;
        const row = {
          id: `pf-${String(counter).padStart(3, "0")}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          taskId: null,
          detail: null,
          ...data,
        } as unknown as Row;
        rows.push(row);
        return Promise.resolve(row);
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
        take,
      }: {
        where?: Record<string, unknown>;
        take?: number;
      }) {
        return Promise.resolve(
          sorted(rows.filter((r) => matches(r, where))).slice(0, take),
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
    patrolFindingService: new PatrolFindingService(prisma),
    scopeResolver,
  });
  return { app, rows };
}

const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const agent = { Authorization: `Bearer ${AGENT_TOKEN}` };
const agent2 = { Authorization: `Bearer ${AGENT2_TOKEN}` };
const scopeFor =
  (repos: string[], accountId: string): ScopeResolver =>
  async () => ({ repos, accountId });

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    cronId: "consolidation-patrol",
    repo: "org/repo",
    observedAt: "2026-11-27T06:00:00.000Z",
    findings: [
      { fingerprint: "fp-1", status: "tracking", detail: { files: 2 } },
    ],
    ...overrides,
  };
}

type TestApp = ReturnType<typeof makeApp>["app"];

function upsert(
  app: TestApp,
  body: unknown,
  headers: Record<string, string> = admin,
) {
  return app.request("/patrol-findings/batch", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(app: TestApp, query = "", headers = admin) {
  return app.request(`/patrol-findings${query}`, { headers });
}

type Finding = {
  fingerprint: string;
  status: string;
  occurrenceCount: number;
  accountId: string;
  history: { at: string; status: string; occurrenceCount: number }[];
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/patrol-findings routes (smoke)", () => {
  it("no bearer token — 401", async () => {
    const { app } = makeApp();
    expect((await app.request("/patrol-findings")).status).toBe(401);
  });

  describe("POST /batch", () => {
    it("creates, then continues a finding with appended history", async () => {
      const { app, rows } = makeApp();
      const first = await upsert(app, validBody());
      expect(first.status).toBe(200);
      const a = ((await first.json()) as { findings: Finding[] }).findings[0];
      expect(a?.occurrenceCount).toBe(1);
      expect(a?.accountId).toBe("default");

      const second = await upsert(
        app,
        validBody({
          observedAt: "2026-11-28T06:00:00.000Z",
          findings: [{ fingerprint: "fp-1", status: "ready_to_propose" }],
        }),
      );
      const b = ((await second.json()) as { findings: Finding[] }).findings[0];
      expect(b?.occurrenceCount).toBe(2);
      expect(b?.status).toBe("ready_to_propose");
      expect(b?.history.map((h) => h.status)).toEqual([
        "tracking",
        "ready_to_propose",
      ]);
      expect(rows).toHaveLength(1);
    });

    it("a repeated identical upsert leaves count and history unchanged", async () => {
      const { app, rows } = makeApp();
      await upsert(app, validBody());
      const next = validBody({
        observedAt: "2026-11-28T06:00:00.000Z",
        findings: [{ fingerprint: "fp-1", status: "open" }],
      });
      await upsert(app, next);
      const again = (
        (await (await upsert(app, next)).json()) as { findings: Finding[] }
      ).findings[0];
      expect(again?.occurrenceCount).toBe(2);
      expect(again?.history).toHaveLength(2);
      expect(rows).toHaveLength(1);
    });

    const bad: [string, Record<string, unknown>][] = [
      ["malformed repo", { repo: "not-a-repo" }],
      ["empty cronId", { cronId: "" }],
      ["bad observedAt", { observedAt: "yesterday" }],
      ["missing findings", { findings: undefined }],
      ["unknown status", { findings: [{ fingerprint: "a", status: "wat" }] }],
      [
        "empty fingerprint",
        { findings: [{ fingerprint: "", status: "open" }] },
      ],
      [
        "duplicate fingerprints",
        {
          findings: [
            { fingerprint: "a", status: "open" },
            { fingerprint: "a", status: "open" },
          ],
        },
      ],
      [
        "array detail",
        { findings: [{ fingerprint: "a", status: "open", detail: [1] }] },
      ],
    ];
    for (const [name, override] of bad) {
      it(`400 — ${name}`, async () => {
        const { app, rows } = makeApp();
        const res = await upsert(app, validBody(override));
        expect(res.status).toBe(400);
        expect(rows).toHaveLength(0);
      });
    }

    it("agent token, repo outside its scope — 403", async () => {
      const { app, rows } = makeApp(scopeFor(["org/other"], "acct-1"));
      const res = await upsert(app, validBody(), agent);
      expect(res.status).toBe(403);
      expect(rows).toHaveLength(0);
    });

    it("agent token writes to its own account; admin may pick accountId", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-1"));
      const a = (
        (await (await upsert(app, validBody(), agent)).json()) as {
          findings: Finding[];
        }
      ).findings[0];
      expect(a?.accountId).toBe("acct-1");
      const b = (
        (await (
          await upsert(app, validBody({ accountId: "acct-9" }))
        ).json()) as { findings: Finding[] }
      ).findings[0];
      expect(b?.accountId).toBe("acct-9");
    });
  });

  describe("GET /", () => {
    it("filters by cronId, repo and status", async () => {
      const { app } = makeApp();
      await upsert(
        app,
        validBody({
          findings: [
            { fingerprint: "a", status: "tracking" },
            { fingerprint: "b", status: "open" },
          ],
        }),
      );
      await upsert(app, validBody({ cronId: "other" }));
      await upsert(app, validBody({ repo: "org/else" }));
      const ids = async (q: string) =>
        (
          (await (await get(app, q)).json()) as { findings: Finding[] }
        ).findings.map((f) => f.fingerprint);
      expect(
        await ids("?cronId=consolidation-patrol&repo=org/repo"),
      ).toHaveLength(2);
      expect(
        await ids("?cronId=consolidation-patrol&repo=org/repo&status=open"),
      ).toEqual(["b"]);
      expect(await ids("?cronId=other")).toEqual(["fp-1"]);
    });

    it("returns total/limit and a nextCursor when more rows remain", async () => {
      const { app } = makeApp();
      await upsert(
        app,
        validBody({
          findings: [
            { fingerprint: "a", status: "open" },
            { fingerprint: "b", status: "open" },
            { fingerprint: "c", status: "open" },
          ],
        }),
      );
      const body = (await (await get(app, "?limit=2")).json()) as {
        findings: unknown[];
        total: number;
        limit: number;
        nextCursor: string | null;
      };
      expect(body.findings).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.limit).toBe(2);
      expect(typeof body.nextCursor).toBe("string");
    });

    it("400 on a malformed cursor", async () => {
      const { app } = makeApp();
      expect((await get(app, "?cursor=%25%25")).status).toBe(400);
    });

    it("agent token, repo outside its scope — 403 on read", async () => {
      const { app } = makeApp(scopeFor(["org/repo"], "acct-1"));
      expect((await get(app, "?repo=org/other", agent)).status).toBe(403);
    });

    it("another in-scope agent reads findings a different agent wrote; other accounts are hidden", async () => {
      const { app } = makeApp(async (token) => {
        void token;
        return { repos: ["org/repo"], accountId: "acct-1" };
      });
      await upsert(app, validBody(), agent);
      await upsert(app, validBody({ accountId: "acct-2" }));
      const res = await get(app, "?repo=org/repo", agent2);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { findings: Finding[]; total: number };
      expect(body.total).toBe(1);
      expect(body.findings[0]?.accountId).toBe("acct-1");
    });
  });
});
