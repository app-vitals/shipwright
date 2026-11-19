/**
 * task-store/src/tasks.cursor.integration.test.ts
 *
 * Keyset-cursor paging of TaskService.list() against a real Postgres DB.
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BadRequestError } from "./errors.ts";
import { encodeCursor } from "./lib/cursor.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

// 11 rows over 3 distinct createdAt values (heavy ties). Ids are deliberately
// not in insertion order so the id tie-break is what orders each tie group.
const T1 = new Date("2026-01-01T00:00:00.000Z");
const T2 = new Date("2026-01-02T00:00:00.000Z");
const T3 = new Date("2026-01-03T00:00:00.000Z");
const ROWS: Array<[string, Date]> = [
  ["k-09", T1],
  ["k-02", T1],
  ["k-05", T1],
  ["k-01", T1],
  ["k-08", T2],
  ["k-03", T2],
  ["k-07", T2],
  ["k-04", T3],
  ["k-10", T3],
  ["k-06", T3],
  ["k-11", T3],
];

describeOrSkip("TaskService.list keyset cursor (integration)", () => {
  let prisma: PrismaClient;
  let service: TaskService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    for (const [id, createdAt] of ROWS) {
      await prisma.task.create({
        data: { id, title: id, status: "pending", createdAt },
      });
    }
    service = new TaskService(prisma);
  });

  afterEach(async () => {
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.$disconnect();
  });

  async function walkCursor(
    limit: number,
    sort: "asc" | "desc",
    extra: Record<string, unknown> = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await service.list({ limit, sort, cursor, ...extra });
      expect(page.total).toBe(ROWS.length);
      ids.push(...page.tasks.map((t) => t.id));
      if (page.nextCursor === null || page.nextCursor === undefined) {
        return ids;
      }
      expect(page.tasks).toHaveLength(limit);
      cursor = page.nextCursor;
    }
    throw new Error("cursor walk did not terminate");
  }

  const expected = (sort: "asc" | "desc") => {
    const asc = [...ROWS]
      .sort(
        (a, b) =>
          a[1].getTime() - b[1].getTime() ||
          (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
      )
      .map(([id]) => id);
    return sort === "asc" ? asc : asc.reverse();
  };

  for (const sort of ["asc", "desc"] as const) {
    for (const limit of [1, 2, 3, 4, 11, 20]) {
      it(`pages through tied createdAt rows without skips or duplicates (sort=${sort}, limit=${limit})`, async () => {
        const ids = await walkCursor(limit, sort);
        expect(ids).toEqual(expected(sort));
        expect(new Set(ids).size).toBe(ROWS.length);
      });
    }
  }

  it("nextCursor is null when the page is exactly the remainder", async () => {
    const page = await service.list({ limit: ROWS.length });
    expect(page.tasks).toHaveLength(ROWS.length);
    expect(page.nextCursor).toBeNull();
  });

  it("a cursor whose row was deleted still resumes at its position", async () => {
    const first = await service.list({ limit: 5 });
    const lastId = first.tasks[4]?.id as string;
    await prisma.task.delete({ where: { id: lastId } });
    const next = await service.list({
      limit: 50,
      cursor: first.nextCursor as string,
    });
    expect(next.tasks.map((t) => t.id)).toEqual(expected("asc").slice(5));
  });

  it("a cursor row that does not match the filter does not matter", async () => {
    // The cursor sits on a k-0x row; filter to a different, unrelated subset.
    const cursor = encodeCursor({ createdAt: T2, id: "k-03" });
    await prisma.task.update({
      where: { id: "k-10" },
      data: { status: "done" },
    });
    const page = await service.list({ cursor, status: "done" });
    expect(page.tasks.map((t) => t.id)).toEqual(["k-10"]);
    expect(page.total).toBe(1);
  });

  it("works for a cursor that never matched any row", async () => {
    const cursor = encodeCursor({ createdAt: T2, id: "zzz" });
    const page = await service.list({ cursor, limit: 100 });
    expect(page.tasks.map((t) => t.id)).toEqual([
      "k-04",
      "k-06",
      "k-10",
      "k-11",
    ]);
  });

  it("does not clobber agentScope's OR (cursor ANDed with it)", async () => {
    await prisma.task.updateMany({
      where: { id: { in: ["k-01", "k-02", "k-03"] } },
      data: { assignee: "agent-a" },
    });
    await prisma.task.updateMany({
      where: { id: { in: ["k-04", "k-05"] } },
      data: { repo: "org/pool" },
    });
    const agentScope = { agentId: "agent-a", repos: ["org/pool"] };
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await service.list({ limit: 2, cursor, agentScope });
      expect(page.total).toBe(5);
      ids.push(...page.tasks.map((t) => t.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect([...ids].sort()).toEqual(["k-01", "k-02", "k-03", "k-04", "k-05"]);
    expect(new Set(ids).size).toBe(5);
  });

  it("composes with repo/org filters that carry their own OR", async () => {
    await prisma.task.updateMany({
      where: { id: { in: ["k-01", "k-02", "k-03", "k-04"] } },
      data: { repo: "org-a/x" },
    });
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await service.list({ limit: 1, cursor, org: ["org-a"] });
      ids.push(...page.tasks.map((t) => t.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(ids).toEqual(["k-01", "k-02", "k-03", "k-04"]);
  });

  it("rejects malformed cursors with BadRequestError", async () => {
    await expect(service.list({ cursor: "garbage!!" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});
