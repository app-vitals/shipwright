/**
 * task-store/src/list-cursor.integration.test.ts
 *
 * Multi-page cursor walks (TPG-1.2) for every limit-taking list service except
 * TaskService.list (see tasks.cursor.integration.test.ts), against a real
 * Postgres DB. Each walk must visit every row exactly once, in the endpoint's
 * documented order, and reach `nextCursor === null` exactly once (the last
 * page). Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CoverageSnapshotService } from "./coverage-snapshot-service.ts";
import { BadRequestError } from "./errors.ts";
import { PatrolFindingService } from "./patrol-finding-service.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { ReadinessSnapshotService } from "./readiness-snapshot-service.ts";
import { RepoCronRunService } from "./repo-cron-run-service.ts";
import { SessionService } from "./session-service.ts";
import { SystemCronService } from "./system-cron-service.ts";
import { TaskService } from "./task-service.ts";
import { VerificationCheckService } from "./verification-check-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const REPO = "app-vitals/cursor-walk";
const N = 11;
const LIMIT = 4;

type Page<T> = { items: T[]; nextCursor: string | null | undefined };

/**
 * Follow nextCursor until null. Asserts every non-final page is full, that
 * null appears exactly once (on the last page) and returns all rows in order.
 */
async function walk<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let nulls = 0;
  for (let guard = 0; guard < 50; guard++) {
    const page = await fetchPage(cursor);
    all.push(...page.items);
    if (page.nextCursor === null || page.nextCursor === undefined) {
      nulls++;
      expect(nulls).toBe(1);
      return all;
    }
    expect(page.items).toHaveLength(LIMIT);
    cursor = page.nextCursor;
  }
  throw new Error("cursor walk did not terminate");
}

function expectEachOnce(ids: string[], expected: string[]) {
  expect(ids).toEqual(expected);
  expect(new Set(ids).size).toBe(ids.length);
}

const pad = (i: number) => String(i).padStart(2, "0");

describeOrSkip("cursor walks on list services (integration)", () => {
  let prisma: PrismaClient;

  async function cleanup() {
    await prisma.verificationCheck.deleteMany();
    await prisma.taskEvent.deleteMany();
    await prisma.pullRequestEvent.deleteMany();
    await prisma.prFinding.deleteMany();
    await prisma.pullRequest.deleteMany();
    await prisma.coverageSnapshot.deleteMany();
    await prisma.readinessSnapshot.deleteMany();
    await prisma.repoCronRun.deleteMany();
    await prisma.patrolFinding.deleteMany();
    await prisma.systemCronTrigger.deleteMany();
    await prisma.systemCronDefinition.deleteMany();
    await prisma.task.deleteMany();
    await prisma.session.deleteMany();
  }

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("GET /tasks/:id/events — string `at` key with heavy ties, ordered (at, id)", async () => {
    await prisma.task.create({
      data: { id: "ev-task", title: "t", status: "pending" },
    });
    // 3 distinct `at` values; ids not in insertion order.
    const ids = Array.from({ length: N }, (_, i) => `te-${pad(i)}`);
    for (const [i, id] of [...ids].reverse().entries()) {
      await prisma.taskEvent.create({
        data: {
          id,
          taskId: "ev-task",
          field: "status",
          method: "update",
          at: `2026-01-0${(i % 3) + 1}T00:00:00.000Z`,
        },
      });
    }
    const service = new TaskService(prisma);
    const rows = await walk(async (cursor) => {
      const r = await service.getEvents("ev-task", { limit: LIMIT, cursor });
      expect(r.total).toBe(N);
      return { items: r.events, nextCursor: r.nextCursor };
    });
    const expected = (
      await prisma.taskEvent.findMany({
        where: { taskId: "ev-task" },
        orderBy: [{ at: "asc" }, { id: "asc" }],
      })
    ).map((e) => e.id);
    expectEachOnce(
      rows.map((e) => e.id),
      expected,
    );
  });

  it("GET /prs/:id/events — walks to null exactly once", async () => {
    const pr = await prisma.pullRequest.create({
      data: { repo: REPO, prNumber: 1 },
    });
    for (let i = 0; i < N; i++) {
      await prisma.pullRequestEvent.create({
        data: {
          id: `pe-${pad(i)}`,
          prRecordId: pr.id,
          field: "state",
          method: "update",
          at: `2026-01-0${(i % 3) + 1}T00:00:00.000Z`,
        },
      });
    }
    const service = new PullRequestService(prisma);
    const rows = await walk(async (cursor) => {
      const r = await service.getEvents(pr.id, { limit: LIMIT, cursor });
      return { items: r.events, nextCursor: r.nextCursor };
    });
    const expected = (
      await prisma.pullRequestEvent.findMany({
        where: { prRecordId: pr.id },
        orderBy: [{ at: "asc" }, { id: "asc" }],
      })
    ).map((e) => e.id);
    expectEachOnce(
      rows.map((e) => e.id),
      expected,
    );
  });

  it("GET /prs — keyset (createdAt, id), asc and desc, with filters", async () => {
    const T = [
      new Date("2026-01-01T00:00:00.000Z"),
      new Date("2026-01-02T00:00:00.000Z"),
      new Date("2026-01-03T00:00:00.000Z"),
    ];
    for (let i = 0; i < N; i++) {
      await prisma.pullRequest.create({
        data: { repo: REPO, prNumber: i + 1, createdAt: T[i % 3] },
      });
    }
    const service = new PullRequestService(prisma);
    for (const sort of ["asc", "desc"] as const) {
      const rows = await walk(async (cursor) => {
        const r = await service.list({
          limit: LIMIT,
          sort,
          cursor,
          repo: REPO,
        });
        expect(r.total).toBe(N);
        return { items: r.prs, nextCursor: r.nextCursor };
      });
      const expected = (
        await prisma.pullRequest.findMany({
          orderBy: [{ createdAt: sort }, { id: sort }],
        })
      ).map((p) => p.id);
      expectEachOnce(
        rows.map((p) => p.id),
        expected,
      );
    }
  });

  it("GET /prs?blocked=true — offset-wrapped cursor walks the in-memory blocked set", async () => {
    for (let i = 0; i < N; i++) {
      await prisma.pullRequest.create({
        data: { repo: REPO, prNumber: i + 1, blocked: true },
      });
    }
    const service = new PullRequestService(prisma);
    const rows = await walk(async (cursor) => {
      const r = await service.list({ limit: LIMIT, blocked: true, cursor });
      expect(r.total).toBe(N);
      return { items: r.prs, nextCursor: r.nextCursor };
    });
    expect(new Set(rows.map((p) => p.id)).size).toBe(N);
  });

  it("GET /verification-checks — asc (task) and desc (repo+check) walks", async () => {
    const task = await prisma.task.create({
      data: { title: "t", status: "pending", repo: REPO },
    });
    for (let i = 0; i < N; i++) {
      await prisma.verificationCheck.create({
        data: {
          id: `vc-${pad(i)}`,
          taskId: task.id,
          repo: REPO,
          checkName: "lint",
          status: "ran_passed",
          at: `2026-01-0${(i % 3) + 1}T00:00:00.000Z`,
        },
      });
    }
    const service = new VerificationCheckService(prisma);
    const asc = await walk(async (cursor) => {
      const r = await service.listForTask(task.id, { limit: LIMIT, cursor });
      return { items: r.checks, nextCursor: r.nextCursor };
    });
    expectEachOnce(
      asc.map((c) => c.id),
      (
        await prisma.verificationCheck.findMany({
          orderBy: [{ at: "asc" }, { id: "asc" }],
        })
      ).map((c) => c.id),
    );
    const desc = await walk(async (cursor) => {
      const r = await service.listByRepoAndCheck(REPO, "lint", {
        limit: LIMIT,
        cursor,
      });
      return { items: r.checks, nextCursor: r.nextCursor };
    });
    expectEachOnce(
      desc.map((c) => c.id),
      (
        await prisma.verificationCheck.findMany({
          orderBy: [{ at: "desc" }, { id: "desc" }],
        })
      ).map((c) => c.id),
    );
  });

  it("GET /cron-runs — newest first by (finishedAt, id)", async () => {
    for (let i = 0; i < N; i++) {
      await prisma.repoCronRun.create({
        data: {
          id: `cr-${pad(i)}`,
          cronId: "walk",
          repo: REPO,
          startedAt: new Date("2026-01-01T00:00:00.000Z"),
          finishedAt: new Date(`2026-01-0${(i % 3) + 1}T00:00:00.000Z`),
          commitSha: `sha-${pad(i)}`,
          outcome: "ok",
          metrics: {},
        },
      });
    }
    const service = new RepoCronRunService(prisma);
    const rows = await walk(async (cursor) => {
      const r = await service.list({ limit: LIMIT, cursor, repo: REPO });
      expect(r.total).toBe(N);
      return { items: r.runs, nextCursor: r.nextCursor };
    });
    expectEachOnce(
      rows.map((s) => s.id),
      (
        await prisma.repoCronRun.findMany({
          orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
        })
      ).map((s) => s.id),
    );
  });

  it("GET /patrol-findings — newest first by (lastSeen, id)", async () => {
    for (let i = 0; i < N; i++) {
      await prisma.patrolFinding.create({
        data: {
          id: `pf-${pad(i)}`,
          cronId: "walk",
          repo: REPO,
          fingerprint: `fp-${pad(i)}`,
          status: "tracking",
          firstSeen: new Date("2026-01-01T00:00:00.000Z"),
          lastSeen: new Date(`2026-01-0${(i % 3) + 1}T00:00:00.000Z`),
          history: [],
        },
      });
    }
    const service = new PatrolFindingService(prisma);
    const rows = await walk(async (cursor) => {
      const r = await service.list({ limit: LIMIT, cursor, repo: REPO });
      expect(r.total).toBe(N);
      return { items: r.findings, nextCursor: r.nextCursor };
    });
    expectEachOnce(
      rows.map((s) => s.id),
      (
        await prisma.patrolFinding.findMany({
          orderBy: [{ lastSeen: "desc" }, { id: "desc" }],
        })
      ).map((s) => s.id),
    );
  });

  it("GET /coverage-snapshots — newest first by (measuredAt, id)", async () => {
    for (let i = 0; i < N; i++) {
      await prisma.coverageSnapshot.create({
        data: {
          id: `cs-${pad(i)}`,
          repo: REPO,
          branch: "main",
          commitSha: `sha-${pad(i)}`,
          linesCovered: 1,
          linesTotal: 2,
          linesPct: 50,
          tool: "bun",
          measuredAt: new Date(`2026-01-0${(i % 3) + 1}T00:00:00.000Z`),
        },
      });
    }
    const service = new CoverageSnapshotService(prisma);
    const rows = await walk(async (cursor) => {
      const r = await service.list({ limit: LIMIT, cursor, repo: REPO });
      expect(r.total).toBe(N);
      return { items: r.snapshots, nextCursor: r.nextCursor };
    });
    expectEachOnce(
      rows.map((s) => s.id),
      (
        await prisma.coverageSnapshot.findMany({
          orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
        })
      ).map((s) => s.id),
    );
  });

  it("GET /readiness-snapshots — newest first by (measuredAt, id)", async () => {
    for (let i = 0; i < N; i++) {
      await prisma.readinessSnapshot.create({
        data: {
          id: `rs-${pad(i)}`,
          repo: REPO,
          commitSha: `sha-${pad(i)}`,
          level: 2,
          passing: 1,
          failing: 0,
          checks: [],
          catalogueVersion: "1",
          measuredAt: new Date(`2026-01-0${(i % 3) + 1}T00:00:00.000Z`),
        },
      });
    }
    const service = new ReadinessSnapshotService(prisma);
    const rows = await walk(async (cursor) => {
      const r = await service.list({ limit: LIMIT, cursor, repo: REPO });
      expect(r.total).toBe(N);
      return { items: r.snapshots, nextCursor: r.nextCursor };
    });
    expectEachOnce(
      rows.map((s) => s.id),
      (
        await prisma.readinessSnapshot.findMany({
          orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
        })
      ).map((s) => s.id),
    );
  });

  it("GET /system-crons/:id/triggers — newest scheduledFor first", async () => {
    await prisma.systemCronDefinition.create({
      data: {
        id: "cur-cron",
        name: "c",
        schedule: "0 9 * * *",
        titleTemplate: "t",
        descriptionTemplate: "d",
      },
    });
    for (let i = 0; i < N; i++) {
      await prisma.systemCronTrigger.create({
        data: {
          cronId: "cur-cron",
          scheduledFor: new Date(Date.UTC(2026, 0, 1 + i)),
          slot: `slot-${i}`,
          taskCount: i,
        },
      });
    }
    const service = new SystemCronService(prisma);
    const rows = await walk(async (cursor) => {
      const r = await service.recentTriggers("cur-cron", LIMIT, null, cursor);
      return { items: r.triggers, nextCursor: r.nextCursor };
    });
    expect(rows.map((t) => t.taskCount)).toEqual(
      Array.from({ length: N }, (_, i) => N - 1 - i),
    );
  });

  it("GET /sessions — offset-wrapped cursor walks the rollup order", async () => {
    for (let i = 0; i < N; i++) {
      const slug = `cursor-sess-${pad(i)}`;
      await prisma.session.create({ data: { slug } });
      await prisma.task.create({
        data: { title: slug, status: "pending", session: slug },
      });
    }
    const service = new SessionService(prisma);
    const rows = await walk(async (cursor) => {
      const r = await service.list({ limit: LIMIT, cursor });
      expect(r.total).toBe(N);
      return { items: r.sessions, nextCursor: r.nextCursor };
    });
    expect(new Set(rows.map((s) => s.slug)).size).toBe(N);
  });

  it("malformed cursors are a 400 on every service", async () => {
    await prisma.task.create({
      data: { id: "m-task", title: "t", status: "pending" },
    });
    const pr = await prisma.pullRequest.create({
      data: { repo: REPO, prNumber: 99 },
    });
    await prisma.systemCronDefinition.create({
      data: {
        id: "m-cron",
        name: "c",
        schedule: "0 9 * * *",
        titleTemplate: "t",
        descriptionTemplate: "d",
      },
    });
    await expect(
      new TaskService(prisma).getEvents("m-task", { cursor: "!!" }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      new PullRequestService(prisma).getEvents(pr.id, { cursor: "!!" }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      new PullRequestService(prisma).list({ cursor: "!!" }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      new SessionService(prisma).list({ cursor: "!!" }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      new CoverageSnapshotService(prisma).list({ cursor: "!!" }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      new ReadinessSnapshotService(prisma).list({ cursor: "!!" }),
    ).rejects.toThrow(BadRequestError);
    await expect(
      new SystemCronService(prisma).recentTriggers("m-cron", 5, null, "!!"),
    ).rejects.toThrow(BadRequestError);
    await expect(
      new VerificationCheckService(prisma).listByRepoAndCheck(REPO, "lint", {
        cursor: "!!",
      }),
    ).rejects.toThrow(BadRequestError);
  });
});
