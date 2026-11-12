/**
 * task-store/src/patch-by-pr.integration.test.ts
 *
 * MPD-1.2 integration coverage for PATCH /tasks/by-pr against a real Postgres
 * DB: the status + deployedAt/releasedAt writes, TaskEvent rows, idempotent
 * repeats, skipped statuses, bundle atomicity (rollback on webhook failure)
 * and account scoping.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { FixedClock } from "./clock.ts";
import type { TaskStatus } from "./index.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const REPO = "app-vitals/shipwright";
const NOW = new Date("2026-07-10T00:00:00.000Z");

describeOrSkip("PATCH /tasks/by-pr (MPD-1.2, integration)", () => {
  let prisma: PrismaClient;
  let rawToken: string;
  let dispatched: number;
  let failWebhook: boolean;
  let app: ReturnType<typeof createTaskStoreApp>;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await prisma.taskToken.deleteMany();
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    dispatched = 0;
    failWebhook = false;

    const tokenService = new TaskTokenService(prisma);
    rawToken = (await tokenService.create("mpd-1-2")).rawToken;
    app = createTaskStoreApp({
      taskService: new TaskService(prisma, FixedClock(NOW), async () => {
        dispatched++;
        if (failWebhook) throw new Error("webhook down");
      }),
      tokenService,
      sessionService: new SessionService(prisma),
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function patch(body: unknown, query = "") {
    return app.request(`/tasks/by-pr${query}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${rawToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  function mk(id: string, status: TaskStatus, pr: number | null, repo = REPO) {
    return prisma.task.create({
      data: { id, title: id, status: status as TaskStatus, pr, repo },
    });
  }

  it.each([
    ["deployed", "deployedAt"],
    ["released", "releasedAt"],
  ] as const)(
    "moves a bundle of merged tasks on one PR to %s, stamps %s and writes TaskEvent rows",
    async (status, stampField) => {
      await mk("a", "merged", 7);
      await mk("b", "merged", 7);
      await mk("other", "merged", 8);
      const at = "2026-07-02T00:00:00.000Z";

      const res = await patch({ repo: REPO, prNumbers: [7], status, at });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        updated: string[];
        unchanged: string[];
        skipped: unknown[];
      };
      expect(body.updated.sort()).toEqual(["a", "b"]);
      expect(body.unchanged).toEqual([]);
      expect(body.skipped).toEqual([]);

      for (const id of ["a", "b"]) {
        const row = await prisma.task.findUnique({ where: { id } });
        expect(row?.status).toBe(status);
        expect(row?.[stampField]).toBe(at);
        const events = await prisma.taskEvent.findMany({
          where: { taskId: id },
        });
        const byField = Object.fromEntries(events.map((e) => [e.field, e]));
        expect(Object.keys(byField).sort()).toEqual(
          ["status", stampField].sort(),
        );
        expect(byField.status.oldValue).toBe("merged");
        expect(byField.status.newValue).toBe(status);
        expect(byField[stampField].newValue).toBe(at);
      }
      // A PR that was not listed is untouched.
      expect(
        (await prisma.task.findUnique({ where: { id: "other" } }))?.status,
      ).toBe("merged");
      // One webhook dispatch for the whole batch.
      expect(dispatched).toBe(1);
    },
  );

  it("defaults the stamp to now when `at` is omitted", async () => {
    await mk("a", "merged", 7);
    await patch({ repo: REPO, prNumbers: [7], status: "deployed" });
    const row = await prisma.task.findUnique({ where: { id: "a" } });
    expect(row?.deployedAt).toBe(NOW.toISOString());
  });

  it("is idempotent: a repeat reports unchanged and writes no new events", async () => {
    await mk("a", "merged", 7);
    const req = { repo: REPO, prNumbers: [7], status: "deployed" };
    await patch(req);
    const eventsAfterFirst = await prisma.taskEvent.count();
    const res = await patch({ ...req, at: "2030-01-01T00:00:00.000Z" });
    expect(await res.json()).toEqual({
      updated: [],
      unchanged: ["a"],
      skipped: [],
    });
    expect(await prisma.taskEvent.count()).toBe(eventsAfterFirst);
    expect(
      (await prisma.task.findUnique({ where: { id: "a" } }))?.deployedAt,
    ).toBe(NOW.toISOString());
  });

  it("never modifies tasks in other statuses and reports them skipped", async () => {
    await mk("m", "merged", 7);
    await mk("open", "pr_open", 7);
    await mk("blk", "blocked", 7);
    await mk("dn", "done", 7);
    const res = await patch({ repo: REPO, prNumbers: [7], status: "deployed" });
    const body = (await res.json()) as {
      updated: string[];
      skipped: Array<{ id: string; status: string }>;
    };
    expect(body.updated).toEqual(["m"]);
    expect(body.skipped.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "blk", status: "blocked" },
      { id: "dn", status: "done" },
      { id: "open", status: "pr_open" },
    ]);
    for (const [id, status] of [
      ["open", "pr_open"],
      ["blk", "blocked"],
      ["dn", "done"],
    ] as const) {
      const row = await prisma.task.findUnique({ where: { id } });
      expect(row?.status).toBe(status);
      expect(row?.deployedAt).toBeNull();
      expect(await prisma.taskEvent.count({ where: { taskId: id } })).toBe(0);
    }
  });

  it("only matches tasks of the given repo", async () => {
    await mk("same", "merged", 7);
    await mk("elsewhere", "merged", 7, "app-vitals/other");
    const res = await patch({ repo: REPO, prNumbers: [7], status: "deployed" });
    expect(((await res.json()) as { updated: string[] }).updated).toEqual([
      "same",
    ]);
    expect(
      (await prisma.task.findUnique({ where: { id: "elsewhere" } }))?.status,
    ).toBe("merged");
  });

  it("rolls back the whole bundle (statuses and events) when the webhook fails", async () => {
    await mk("a", "merged", 7);
    await mk("b", "merged", 8);
    failWebhook = true;
    const res = await patch({
      repo: REPO,
      prNumbers: [7, 8],
      status: "deployed",
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    for (const id of ["a", "b"]) {
      const row = await prisma.task.findUnique({ where: { id } });
      expect(row?.status).toBe("merged");
      expect(row?.deployedAt).toBeNull();
      expect(await prisma.taskEvent.count({ where: { taskId: id } })).toBe(0);
    }
  });

  it("respects the account scope for admin tokens (?accountId=)", async () => {
    await mk("a", "merged", 7);
    const res = await patch(
      { repo: REPO, prNumbers: [7], status: "deployed" },
      "?accountId=some-other-account",
    );
    expect(await res.json()).toEqual({
      updated: [],
      unchanged: [],
      skipped: [],
    });
    expect((await prisma.task.findUnique({ where: { id: "a" } }))?.status).toBe(
      "merged",
    );
  });
});
