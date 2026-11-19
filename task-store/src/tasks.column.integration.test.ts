/**
 * task-store/src/tasks.column.integration.test.ts
 *
 * TPG-1.3: GET /tasks?column= membership (TaskService.list({ column })) must
 * equal the admin board's bucketTaskColumn over the same tasks, including
 * dependency-blocked, hitl and PR-blocked tasks. Requires
 * DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { bucketTaskColumn } from "@shipwright/admin/coding/admin-ui-work-item-pages";
import { computeBlockedBy } from "./blocked-by.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const REPO = "org/repo";
const D = (n: number) =>
  new Date(`2026-01-${String(n).padStart(2, "0")}T00:00:00Z`);

type Row = {
  id: string;
  status: string;
  hitl?: boolean | null;
  kind?: string;
  dependencies?: string[];
  branch?: string;
  pr?: number;
};

// Ids are ordered so createdAt (day n) matches list position.
const ROWS: Row[] = [
  { id: "q1", status: "pending" },
  { id: "ip1", status: "in_progress" },
  { id: "ip2", status: "pr_open", pr: 1 }, // PR present, not blocked
  { id: "ip3", status: "approved", hitl: false },
  { id: "h1", status: "pending", hitl: true },
  { id: "b1", status: "blocked" },
  { id: "d1", status: "pending", dependencies: ["q1"] }, // unmet dep
  { id: "d2", status: "pending", dependencies: ["m1"] }, // satisfied dep
  { id: "d3", status: "in_progress", dependencies: ["q1"] }, // unmet dep, in flight
  { id: "p1", status: "pr_open", pr: 2 }, // PR blocked
  { id: "p2", status: "pending", pr: 3 }, // PR blocked
  { id: "m1", status: "merged", hitl: true, pr: 2 }, // closed wins
  { id: "i1", status: "pending", kind: "idea" },
  { id: "n1", status: "pending", kind: "initiative", hitl: true },
  { id: "c1", status: "cancelled" },
];
const COLUMNS = [
  "planning",
  "ideas",
  "queued",
  "in_progress",
  "blocked",
] as const;
const BLOCKED_PRS = [2, 3];

describeOrSkip("GET /tasks?column= vs bucketTaskColumn (integration)", () => {
  let prisma: PrismaClient;
  let service: TaskService;

  async function clean() {
    await prisma.taskEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
    await prisma.task.deleteMany();
  }

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await clean();
    for (const [i, r] of ROWS.entries()) {
      await prisma.task.create({
        data: {
          id: r.id,
          title: r.id,
          status: r.status as never,
          hitl: r.hitl ?? null,
          kind: (r.kind ?? "dev") as never,
          dependencies: r.dependencies ?? [],
          branch: r.branch ?? null,
          repo: REPO,
          pr: r.pr ?? null,
          createdAt: D(i + 1),
        },
      });
    }
    for (const prNumber of [1, 2, 3]) {
      await prisma.pullRequest.create({
        data: { repo: REPO, prNumber, blocked: BLOCKED_PRS.includes(prNumber) },
      });
    }
    // A blocked PR in another repo must not leak onto same-numbered tasks.
    await prisma.pullRequest.create({
      data: { repo: "org/other", prNumber: 1, blocked: true },
    });
    service = new TaskService(prisma);
  }, 30_000);

  afterEach(async () => {
    await clean();
    await prisma.$disconnect();
  }, 30_000);

  /** Ground truth: the board's own bucketing over the full, unfiltered list. */
  async function expectedByColumn(): Promise<Record<string, string[]>> {
    const all = await prisma.task.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const prs = await prisma.pullRequest.findMany();
    const out: Record<string, string[]> = {};
    for (const t of all) {
      const pr = prs.find((p) => p.repo === t.repo && p.prNumber === t.pr);
      const col = bucketTaskColumn(
        { ...t, blockedBy: computeBlockedBy(t, all) },
        pr?.blocked ?? null,
      );
      // The API names the blocked column "blocked".
      const key = col === "blocked_hitl" ? "blocked" : col;
      out[key] = [...(out[key] ?? []), t.id];
    }
    return out;
  }

  it("matches bucketTaskColumn for every column", async () => {
    const expected = await expectedByColumn();
    // Sanity: the fixture really exercises every column and signal.
    expect(expected.blocked).toEqual(["h1", "b1", "d1", "d3", "p1", "p2"]);
    expect(expected.queued).toEqual(["q1", "d2"]);
    expect(expected.in_progress).toEqual(["ip1", "ip2", "ip3"]);

    for (const column of COLUMNS) {
      const page = await service.list({ column, limit: 100 });
      expect(page.tasks.map((t) => t.id)).toEqual(expected[column] ?? []);
      expect(page.total).toBe((expected[column] ?? []).length);
    }
  });

  it("pages with cursor/limit and reports an accurate per-column total", async () => {
    const expected = (await expectedByColumn()).blocked ?? [];
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await service.list({ column: "blocked", limit: 2, cursor });
      expect(page.total).toBe(expected.length);
      expect(page.tasks.length).toBeLessThanOrEqual(2);
      ids.push(...page.tasks.map((t) => t.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(ids).toEqual(expected);
  });

  it("works with offset paging and desc sort", async () => {
    const expected = (await expectedByColumn()).blocked ?? [];
    const page = await service.list({
      column: "blocked",
      limit: 2,
      offset: 2,
      sort: "desc",
    });
    expect(page.total).toBe(expected.length);
    expect(page.tasks.map((t) => t.id)).toEqual(
      [...expected].reverse().slice(2, 4),
    );
  });

  it("composes with other filters", async () => {
    const page = await service.list({ column: "blocked", hitl: true });
    expect(page.tasks.map((t) => t.id)).toEqual(["h1"]);
    expect(page.total).toBe(1);
  });
});
