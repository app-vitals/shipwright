/**
 * task-store/src/routes/readiness-summary.smoke.test.ts
 *
 * Smoke tests for GET /readiness/summary (RDY-4.1) via in-process
 * app.request(), wiring the REAL ReadinessSummaryService against an in-memory
 * Prisma double and a fake system-cron service.
 *
 * Covers: percent + levelDistribution over fixture repos at levels 1/3/3/4,
 * stale (8-day-old) repos listed but excluded, failing-check ownerRunning,
 * 12-point trend, scope (agent repos/account vs admin), auth.
 */

import { describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "../app.ts";
import type { ScopeResolver } from "../auth.ts";
import { FixedClock } from "../clock.ts";
import type { PrismaClient, SystemCronDefinition } from "../index.ts";
import { ReadinessSummaryService } from "../readiness-summary-service.ts";
import type { SessionServiceLike } from "../session-service.ts";
import type { SystemCronServiceLike } from "../system-cron-service.ts";
import type { TaskServiceLike } from "../task-service.ts";
import type { TokenServiceLike } from "../token-service.ts";

const NOW = new Date("2026-11-28T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ADMIN_TOKEN = "admin-token";
const AGENT_TOKEN = "agent-token";

const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const agent = { Authorization: `Bearer ${AGENT_TOKEN}` };

function proxyService<T extends object>(): T {
  return new Proxy({} as T, {
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

type Row = {
  id: string;
  accountId: string;
  repo: string;
  commitSha: string;
  level: number;
  checks: unknown[];
  measuredAt: Date;
};

function makePrismaDouble(rows: Row[]): PrismaClient {
  function matches(r: Row, where: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (k === "measuredAt") {
        const gte = (v as { gte?: Date }).gte;
        if (gte && r.measuredAt < gte) return false;
      } else if (k === "repo" && v && typeof v === "object") {
        if (!(v as { in: string[] }).in.includes(r.repo)) return false;
      } else if ((r as Record<string, unknown>)[k] !== v) return false;
    }
    return true;
  }
  return {
    readinessSnapshot: {
      findMany({
        where = {},
        distinct,
      }: {
        where?: Record<string, unknown>;
        distinct?: string[];
      }) {
        let matched = rows
          .filter((r) => matches(r, where))
          .sort(
            (a, b) =>
              a.repo.localeCompare(b.repo) ||
              b.measuredAt.getTime() - a.measuredAt.getTime(),
          );
        if (distinct?.length) {
          const seen = new Set<string>();
          matched = matched.filter((r) => {
            if (seen.has(r.repo)) return false;
            seen.add(r.repo);
            return true;
          });
        }
        return Promise.resolve(matched);
      },
    },
  } as unknown as PrismaClient;
}

function cron(over: Partial<SystemCronDefinition>): SystemCronDefinition {
  return {
    id: "entropy-patrol",
    accountId: "default",
    name: "x",
    schedule: "0 4 * * 1",
    timezone: "UTC",
    enabled: true,
    enabledAt: null,
    titleTemplate: "t",
    descriptionTemplate: "d",
    repoScope: "all",
    repos: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function snap(
  repo: string,
  level: number,
  ageMs = DAY,
  extra: Partial<Row> = {},
): Row {
  return {
    id: `${repo}-${ageMs}-${extra.commitSha ?? "a"}`,
    accountId: "default",
    repo,
    commitSha: "a",
    level,
    checks: [],
    measuredAt: new Date(NOW.getTime() - ageMs),
    ...extra,
  };
}

function makeApp(
  rows: Row[],
  crons: SystemCronDefinition[] = [],
  scopeResolver?: ScopeResolver,
) {
  const systemCrons = {
    async list({ accountId }: { accountId: string | null }) {
      return crons.filter(
        (c) => accountId === null || c.accountId === accountId,
      );
    },
  } as unknown as SystemCronServiceLike;
  return createTaskStoreApp({
    taskService: proxyService<TaskServiceLike>(),
    tokenService: fakeTokenService(),
    sessionService: proxyService<SessionServiceLike>(),
    readinessSummaryService: new ReadinessSummaryService(
      makePrismaDouble(rows),
      systemCrons,
      FixedClock(NOW),
    ),
    scopeResolver,
  });
}

const FOUR = [
  snap("org/a", 1),
  snap("org/b", 3),
  snap("org/c", 3),
  snap("org/d", 4),
];

describe("GET /readiness/summary (smoke)", () => {
  it("401 without a token", async () => {
    expect((await makeApp([]).request("/readiness/summary")).status).toBe(401);
  });

  it("4 repos at levels 1,3,3,4 -> 75% and matching distribution", async () => {
    const res = await makeApp(FOUR).request("/readiness/summary", {
      headers: admin,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.percentAtOrAboveFloor).toBe(75);
    expect(body.repoCount).toBe(4);
    expect(body.staleCount).toBe(0);
    expect(body.levelDistribution).toEqual({
      "0": 0,
      "1": 1,
      "2": 0,
      "3": 2,
      "4": 1,
      "5": 0,
    });
    const repos = body.repos as {
      repo: string;
      level: number;
      stale: boolean;
    }[];
    expect(repos.map((r) => [r.repo, r.level, r.stale])).toEqual([
      ["org/a", 1, false],
      ["org/b", 3, false],
      ["org/c", 3, false],
      ["org/d", 4, false],
    ]);
  });

  it("a repo whose latest snapshot is 8 days old is stale and excluded", async () => {
    const rows = [...FOUR, snap("org/old", 5, 8 * DAY)];
    const res = await makeApp(rows).request("/readiness/summary", {
      headers: admin,
    });
    const body = (await res.json()) as {
      percentAtOrAboveFloor: number;
      repoCount: number;
      staleCount: number;
      levelDistribution: Record<string, number>;
      repos: { repo: string; stale: boolean; scoredAt: string }[];
    };
    expect(body.percentAtOrAboveFloor).toBe(75);
    expect(body.repoCount).toBe(4);
    expect(body.staleCount).toBe(1);
    expect(body.levelDistribution["5"]).toBe(0);
    const old = body.repos.find((r) => r.repo === "org/old");
    expect(old?.stale).toBe(true);
    expect(old?.scoredAt).toBe(new Date(NOW.getTime() - 8 * DAY).toISOString());
  });

  it("no repos -> null percent, 12 empty trend points", async () => {
    const res = await makeApp([]).request("/readiness/summary", {
      headers: admin,
    });
    const body = (await res.json()) as {
      percentAtOrAboveFloor: number | null;
      repos: unknown[];
      trend: { percentAtOrAboveFloor: number | null }[];
    };
    expect(body.percentAtOrAboveFloor).toBeNull();
    expect(body.repos).toEqual([]);
    expect(body.trend).toHaveLength(12);
  });

  it("failing checks carry owner and server-computed ownerRunning", async () => {
    const checks = [
      { id: "c1", level: 1, result: "fail", owner: "entropy-patrol" },
      { id: "c2", level: 2, result: "fail", owner: "docs-freshness" },
      { id: "c3", level: 2, result: "fail", owner: "environments" },
      { id: "c4", level: 5, result: "fail", owner: "operator" },
      { id: "c5", level: 1, result: "pass", owner: "entropy-patrol" },
    ];
    const rows = [snap("org/a", 0, DAY, { checks })];
    const crons = [
      cron({ id: "entropy-patrol" }),
      cron({ id: "docs-freshness", enabled: false }),
      cron({ id: "environments", repoScope: "selected", repos: ["org/zzz"] }),
    ];
    const res = await makeApp(rows, crons).request("/readiness/summary", {
      headers: admin,
    });
    const body = (await res.json()) as {
      repos: { failingChecks: unknown[] }[];
    };
    expect(body.repos[0]?.failingChecks).toEqual([
      { id: "c1", level: 1, owner: "entropy-patrol", ownerRunning: true },
      { id: "c2", level: 2, owner: "docs-freshness", ownerRunning: false },
      { id: "c3", level: 2, owner: "environments", ownerRunning: false },
      { id: "c4", level: 5, owner: "operator", ownerRunning: true },
    ]);
  });

  it("agent token sees only its scoped repos and account", async () => {
    const rows = [
      ...FOUR,
      snap("org/other-acct", 5, DAY, { accountId: "acct-b" }),
    ];
    const scope: ScopeResolver = async () => ({
      repos: ["org/a", "org/b"],
      accountId: "default",
    });
    const res = await makeApp(rows, [], scope).request("/readiness/summary", {
      headers: agent,
    });
    const body = (await res.json()) as {
      percentAtOrAboveFloor: number;
      repos: { repo: string }[];
    };
    expect(body.repos.map((r) => r.repo)).toEqual(["org/a", "org/b"]);
    expect(body.percentAtOrAboveFloor).toBe(50);
  });

  it("agent token with an empty repo scope sees nothing", async () => {
    const scope: ScopeResolver = async () => ({
      repos: [],
      accountId: "default",
    });
    const res = await makeApp(FOUR, [], scope).request("/readiness/summary", {
      headers: agent,
    });
    const body = (await res.json()) as {
      repoCount: number;
      repos: unknown[];
      trend: unknown[];
    };
    expect(body.repoCount).toBe(0);
    expect(body.repos).toEqual([]);
    expect(body.trend).toHaveLength(12);
  });
});
