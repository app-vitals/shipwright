/**
 * task-store/src/session-service.integration.test.ts
 *
 * Integration tests for SessionService.upsert() and its wiring into
 * TaskService.create()/bulk() (SESH-1.2), against a real Postgres DB.
 *
 * Covers:
 *   - a task write with a non-blank session creates the Session row
 *   - a second write to the same session does not change createdAt or
 *     overwrite an existing title
 *   - bulk() upserts the Session row the same way as create()
 *   - writing into an archived session clears archivedAt (un-archive)
 *   - session: null / "" / "   " create no Session row at all, and
 *     create()/bulk() still work unchanged for those tasks
 *   - TSW-1.3: bulk() is now atomic — one $transaction for the whole call.
 *     A mid-batch P2002 collision rolls back every row inserted earlier in
 *     the same call (including their session upserts) and rejects with
 *     ConflictError; a full-batch success fires exactly one task.write event
 *     containing every created row; a webhook failure mid-batch also rolls
 *     back the whole batch and rejects with WebhookDeliveryError.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { ConflictError, WebhookDeliveryError } from "./errors.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import type { WebhookDispatcher } from "./webhook-dispatcher.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    // TEST_DB is guaranteed set — the describe block is skipped otherwise.
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip(
  "SessionService upsert via TaskService.create()/bulk() (integration)",
  () => {
    let prisma: PrismaClient;
    let service: TaskService;

    beforeEach(async () => {
      prisma = makePrisma();
      service = new TaskService(prisma);
      // TaskEvent's FK is ON DELETE RESTRICT (TCS-1.1) — clear event rows
      // before their parent Task rows.
      await prisma.taskEvent.deleteMany();
      await prisma.task.deleteMany();
      await prisma.session.deleteMany();
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    // ─── create() ────────────────────────────────────────────────────────────

    it("create() with session: 'x' creates a Session row with slug 'x'", async () => {
      const task = await service.create({
        title: "task with session",
        status: "pending",
        session: "x",
      });
      expect(task.session).toBe("x");

      const row = await prisma.session.findUnique({ where: { slug: "x" } });
      expect(row).not.toBeNull();
      expect(row?.slug).toBe("x");
      expect(row?.title).toBeNull();
      expect(row?.archivedAt).toBeNull();
    });

    it("a second create() into the same session does not change createdAt or overwrite an existing title", async () => {
      // Seed a Session with a title directly — create() has no way to set a
      // title itself, so this simulates a row that was titled some other way.
      const seeded = await prisma.session.create({
        data: { slug: "x", title: "My Session Title" },
      });

      await service.create({
        title: "first task",
        status: "pending",
        session: "x",
      });
      const afterFirst = await prisma.session.findUnique({
        where: { slug: "x" },
      });
      expect(afterFirst?.title).toBe("My Session Title");
      expect(afterFirst?.createdAt.getTime()).toBe(seeded.createdAt.getTime());

      // A second write to the same session must not change createdAt or wipe
      // the title.
      await service.create({
        title: "second task",
        status: "pending",
        session: "x",
      });
      const afterSecond = await prisma.session.findUnique({
        where: { slug: "x" },
      });
      expect(afterSecond?.title).toBe("My Session Title");
      expect(afterSecond?.createdAt.getTime()).toBe(seeded.createdAt.getTime());

      // Exactly one Session row exists for the slug — no duplicate created.
      const count = await prisma.session.count({ where: { slug: "x" } });
      expect(count).toBe(1);
    });

    it("writing a task into an archived session clears archivedAt (un-archive)", async () => {
      const archivedAt = new Date("2026-01-01T00:00:00.000Z");
      await prisma.session.create({
        data: {
          slug: "archived-session",
          archivedAt,
          archivedBy: "someone",
        },
      });

      await service.create({
        title: "revives the session",
        status: "pending",
        session: "archived-session",
      });

      const row = await prisma.session.findUnique({
        where: { slug: "archived-session" },
      });
      expect(row?.archivedAt).toBeNull();
      // archivedBy is untouched by the upsert hook — out of scope for v1.
      expect(row?.archivedBy).toBe("someone");
    });

    // ─── bulk() ───────────────────────────────────────────────────────────────

    it("bulk() with session: 'x' on one or more tasks upserts the Session row", async () => {
      const result = await service.bulk([
        { title: "bulk task 1", status: "pending", session: "bulk-x" },
        { title: "bulk task 2", status: "pending", session: "bulk-x" },
        { title: "bulk task 3", status: "pending", session: "bulk-y" },
      ]);
      expect(result.inserted).toBe(3);
      expect(result.skipped).toEqual([]);

      const rowX = await prisma.session.findUnique({
        where: { slug: "bulk-x" },
      });
      expect(rowX).not.toBeNull();
      const rowY = await prisma.session.findUnique({
        where: { slug: "bulk-y" },
      });
      expect(rowY).not.toBeNull();

      // Only one Session row for "bulk-x" despite two tasks writing into it.
      const countX = await prisma.session.count({
        where: { slug: "bulk-x" },
      });
      expect(countX).toBe(1);
    });

    it("bulk() writing into an archived session clears archivedAt", async () => {
      await prisma.session.create({
        data: { slug: "bulk-archived", archivedAt: new Date() },
      });

      const result = await service.bulk([
        { title: "bulk revive", status: "pending", session: "bulk-archived" },
      ]);
      expect(result.inserted).toBe(1);

      const row = await prisma.session.findUnique({
        where: { slug: "bulk-archived" },
      });
      expect(row?.archivedAt).toBeNull();
    });

    it("bulk()'s P2002 collision rolls back the entire batch, including already-processed session upserts", async () => {
      const existing = await service.create({
        id: "dup-id",
        title: "existing task",
        status: "pending",
      });
      expect(existing.id).toBe("dup-id");

      await expect(
        service.bulk([
          { title: "fine task", status: "pending", session: "bulk-ok" },
          {
            id: "dup-id",
            title: "colliding task",
            status: "pending",
            session: "should-not-exist",
          },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);

      // The colliding task's session upsert must not have run.
      const shouldNotExist = await prisma.session.findUnique({
        where: { slug: "should-not-exist" },
      });
      expect(shouldNotExist).toBeNull();

      // The WHOLE batch rolled back — "fine task"'s session upsert, which ran
      // earlier in the same transaction, must also not have landed.
      const fine = await prisma.session.findUnique({
        where: { slug: "bulk-ok" },
      });
      expect(fine).toBeNull();

      // "fine task" itself must not exist as a row either.
      const fineTask = await prisma.task.findFirst({
        where: { title: "fine task" },
      });
      expect(fineTask).toBeNull();
    });

    it("bulk(): full-batch success fires exactly one task.write event containing every created row", async () => {
      const calls: Array<{ type: string; data: unknown }> = [];
      const dispatcher: WebhookDispatcher = async (type, data) => {
        calls.push({ type, data });
      };
      const dispatchingService = new TaskService(prisma, undefined, dispatcher);

      const result = await dispatchingService.bulk([
        { title: "batch task 1", status: "pending" },
        { title: "batch task 2", status: "pending" },
        { title: "batch task 3", status: "pending" },
      ]);

      expect(result.inserted).toBe(3);
      expect(result.skipped).toEqual([]);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.type).toBe("task.write");
      const dispatched = calls[0]?.data as Array<{ title: string }>;
      expect(dispatched).toHaveLength(3);
      expect(dispatched.map((t) => t.title).sort()).toEqual([
        "batch task 1",
        "batch task 2",
        "batch task 3",
      ]);
    });

    it("bulk(): a mid-batch P2002 collision rolls back every row in the batch (proven via direct Postgres query, not just the rejected promise)", async () => {
      await service.create({
        id: "mid-batch-dup",
        title: "seeded",
        status: "pending",
      });

      await expect(
        service.bulk([
          { title: "before-collision", status: "pending" },
          {
            id: "mid-batch-dup",
            title: "colliding",
            status: "pending",
          },
          { title: "after-collision", status: "pending" },
        ]),
      ).rejects.toBeInstanceOf(ConflictError);

      const before = await prisma.task.findFirst({
        where: { title: "before-collision" },
      });
      expect(before).toBeNull();

      const after = await prisma.task.findFirst({
        where: { title: "after-collision" },
      });
      expect(after).toBeNull();
    });

    it("bulk(): a webhook failure mid-batch rolls back every row in the batch and rejects with WebhookDeliveryError", async () => {
      const throwingDispatcher: WebhookDispatcher = async () => {
        throw new WebhookDeliveryError("simulated webhook delivery failure");
      };
      const failingService = new TaskService(
        prisma,
        undefined,
        throwingDispatcher,
      );

      await expect(
        failingService.bulk([
          { title: "webhook-fail-1", status: "pending" },
          { title: "webhook-fail-2", status: "pending" },
          { title: "webhook-fail-3", status: "pending" },
        ]),
      ).rejects.toBeInstanceOf(WebhookDeliveryError);

      const rows = await prisma.task.findMany({
        where: { title: { startsWith: "webhook-fail-" } },
      });
      expect(rows).toHaveLength(0);
    });

    // ─── concurrency ────────────────────────────────────────────────────────

    it("two concurrent create()s into the same brand-new session both succeed and leave exactly one Session row", async () => {
      // Regression guard: upsert() used to do a plain findUnique-then-create,
      // which isn't atomic — two overlapping transactions writing into the
      // same brand-new slug could both observe "no row yet", then race on
      // session.create(). A caught P2002 from inside a Prisma interactive
      // transaction doesn't actually recover it either: Postgres marks the
      // whole transaction aborted after any failed statement, so the
      // subsequent COMMIT silently discards it (including the
      // already-successful Task insert) without Prisma surfacing an error —
      // the promise resolves "fulfilled" with data that was never actually
      // persisted. upsert() now issues a single atomic
      // `INSERT ... ON CONFLICT (slug) DO UPDATE` via Prisma's native
      // session.upsert(), which has no such race window.
      const results = await Promise.allSettled([
        service.create({
          title: "racer a",
          status: "pending",
          session: "fresh-race-slug",
        }),
        service.create({
          title: "racer b",
          status: "pending",
          session: "fresh-race-slug",
        }),
      ]);

      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toEqual([]);

      const rows = await prisma.session.findMany({
        where: { slug: "fresh-race-slug" },
      });
      expect(rows).toHaveLength(1);

      const tasks = await prisma.task.findMany({
        where: { session: "fresh-race-slug" },
      });
      expect(tasks).toHaveLength(2);
    });

    // ─── no-op for blank session ───────────────────────────────────────────────

    it("create() with session: null creates no Session row", async () => {
      const task = await service.create({
        title: "no session",
        status: "pending",
        session: null,
      });
      expect(task.session).toBeNull();
      const count = await prisma.session.count();
      expect(count).toBe(0);
    });

    it("create() with session: '' creates no Session row", async () => {
      const task = await service.create({
        title: "empty session",
        status: "pending",
        session: "",
      });
      expect(task.session).toBe("");
      const count = await prisma.session.count();
      expect(count).toBe(0);
    });

    it("create() with session: '   ' (whitespace-only) creates no Session row", async () => {
      const task = await service.create({
        title: "whitespace session",
        status: "pending",
        session: "   ",
      });
      expect(task.session).toBe("   ");
      const count = await prisma.session.count();
      expect(count).toBe(0);
    });

    it("bulk() with session: null/''/'   ' creates no Session rows and tasks still insert", async () => {
      const result = await service.bulk([
        { title: "bulk null", status: "pending", session: null },
        { title: "bulk empty", status: "pending", session: "" },
        { title: "bulk whitespace", status: "pending", session: "   " },
      ]);
      expect(result.inserted).toBe(3);
      expect(result.skipped).toEqual([]);
      const count = await prisma.session.count();
      expect(count).toBe(0);
    });
  },
);

// ─── list() / get() (SESH-2.2) ─────────────────────────────────────────────────
//
// The smoke tests in routes/sessions.smoke.test.ts inject a hand-written
// SessionServiceLike double — they verify the route's contract, but never
// execute SessionService.list()/get()'s real Prisma-backed logic (state
// filtering, agentScope visibility, sorting). Per data_layer_own_database,
// that logic belongs here, against a real Postgres DB, not mocked.

describeOrSkip("SessionService.list() / get() (integration)", () => {
  let prisma: PrismaClient;
  let taskService: TaskService;
  let sessionService: SessionService;

  beforeEach(async () => {
    prisma = makePrisma();
    taskService = new TaskService(prisma);
    sessionService = new SessionService(prisma);
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.session.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("list() with no filters excludes closed and archived sessions by default", async () => {
    await taskService.create({
      title: "active task",
      status: "pending",
      session: "active-session",
    });
    await taskService.create({
      title: "closed task",
      status: "done",
      session: "closed-session",
    });
    await taskService.create({
      title: "archived task",
      status: "pending",
      session: "archived-session",
    });
    await prisma.session.update({
      where: { slug: "archived-session" },
      data: { archivedAt: new Date() },
    });

    const result = await sessionService.list();
    const slugs = result.sessions.map((s) => s.slug);
    expect(slugs).toContain("active-session");
    expect(slugs).not.toContain("closed-session");
    expect(slugs).not.toContain("archived-session");
  });

  it("list({state:'archived'}) returns only archived sessions", async () => {
    await taskService.create({
      title: "active task",
      status: "pending",
      session: "active-session",
    });
    await taskService.create({
      title: "archived task",
      status: "pending",
      session: "archived-session",
    });
    await prisma.session.update({
      where: { slug: "archived-session" },
      data: { archivedAt: new Date() },
    });

    const result = await sessionService.list({ state: "archived" });
    const slugs = result.sessions.map((s) => s.slug);
    expect(slugs).toEqual(["archived-session"]);
  });

  it("list({state:'closed'}) returns closed sessions even when archived", async () => {
    await taskService.create({
      title: "closed archived task",
      status: "done",
      session: "closed-archived-session",
    });
    await prisma.session.update({
      where: { slug: "closed-archived-session" },
      data: { archivedAt: new Date() },
    });

    const result = await sessionService.list({ state: "closed" });
    const slugs = result.sessions.map((s) => s.slug);
    expect(slugs).toEqual(["closed-archived-session"]);
  });

  it("list({sort:'waitingSince'}) places the oldest waiting session first, non-waiting after", async () => {
    await taskService.create({
      title: "older blocked task",
      status: "blocked",
      session: "wait-older",
    });
    // Real wall-clock gap so `updatedAt` (and thus waitingSince) differs.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await taskService.create({
      title: "newer blocked task",
      status: "blocked",
      session: "wait-newer",
    });
    await taskService.create({
      title: "active task",
      status: "pending",
      session: "not-waiting-older",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await taskService.create({
      title: "more recently active task",
      status: "pending",
      session: "not-waiting-newer",
    });

    const result = await sessionService.list({
      state: "all",
      sort: "waitingSince",
    });
    const slugs = result.sessions.map((s) => s.slug);
    const waitOlderIdx = slugs.indexOf("wait-older");
    const waitNewerIdx = slugs.indexOf("wait-newer");
    const notWaitingOlderIdx = slugs.indexOf("not-waiting-older");
    const notWaitingNewerIdx = slugs.indexOf("not-waiting-newer");
    expect(waitOlderIdx).toBeGreaterThanOrEqual(0);
    expect(waitOlderIdx).toBeLessThan(waitNewerIdx);
    expect(waitNewerIdx).toBeLessThan(notWaitingNewerIdx);
    expect(waitNewerIdx).toBeLessThan(notWaitingOlderIdx);
    // Non-waiting sessions are sorted by lastActivityAt descending (most
    // recently active first) among themselves.
    expect(notWaitingNewerIdx).toBeLessThan(notWaitingOlderIdx);
  });

  it("list({repo}) only returns sessions whose rollup.repos includes any of the given repo(s)", async () => {
    await taskService.create({
      title: "in target repo",
      status: "pending",
      session: "repo-match",
      repo: "org/target-repo",
    });
    await taskService.create({
      title: "in other repo",
      status: "pending",
      session: "repo-no-match",
      repo: "org/other-repo",
    });

    const result = await sessionService.list({
      state: "all",
      repo: "org/target-repo",
    });
    const slugs = result.sessions.map((s) => s.slug);
    expect(slugs).toContain("repo-match");
    expect(slugs).not.toContain("repo-no-match");
  });

  it("list({agentScope}) only returns sessions with a task assigned to the agent or in its repo scope", async () => {
    await taskService.create({
      title: "assigned to agent",
      status: "pending",
      session: "scoped-by-assignee",
      assignee: "agent-1",
    });
    await taskService.create({
      title: "in scoped repo",
      status: "pending",
      session: "scoped-by-repo",
      repo: "org/scoped-repo",
    });
    await taskService.create({
      title: "unrelated",
      status: "pending",
      session: "scoped-hidden",
      repo: "org/other-repo",
    });

    const result = await sessionService.list({
      state: "all",
      agentScope: { agentId: "agent-1", repos: ["org/scoped-repo"] },
    });
    const slugs = result.sessions.map((s) => s.slug);
    expect(slugs).toContain("scoped-by-assignee");
    expect(slugs).toContain("scoped-by-repo");
    expect(slugs).not.toContain("scoped-hidden");
  });

  it("get() returns null for a slug with no Session row", async () => {
    const result = await sessionService.get("does-not-exist");
    expect(result).toBeNull();
  });

  it("get() returns null when agentScope has no qualifying task in an existing session", async () => {
    await taskService.create({
      title: "unrelated",
      status: "pending",
      session: "not-mine",
      repo: "org/other-repo",
    });

    const result = await sessionService.get("not-mine", {
      agentId: "agent-1",
      repos: ["org/scoped-repo"],
    });
    expect(result).toBeNull();
  });

  it("get() returns the flattened session+rollup shape for a visible session", async () => {
    await taskService.create({
      title: "a task",
      status: "pending",
      session: "flat-session",
    });

    const result = await sessionService.get("flat-session");
    expect(result).not.toBeNull();
    expect(result?.slug).toBe("flat-session");
    expect(result?.state).toBe("active");
    expect(result?.counts).toEqual({ total: 1, open: 1, closed: 0 });
    expect(result?.archived).toBe(false);
    expect(Array.isArray(result?.waitingTasks)).toBe(true);
  });
});

// ─── update() (SESH-3.1) ────────────────────────────────────────────────────
//
// The smoke tests in routes/sessions.smoke.test.ts inject a hand-written
// SessionServiceLike double covering the route's admin-vs-agent-token
// authorization contract — they never execute SessionService.update()'s real
// Prisma-backed write. Per data_layer_own_database, the archive/unarchive/
// rename semantics belong here, against a real Postgres DB.

describeOrSkip("SessionService.update() (integration)", () => {
  let prisma: PrismaClient;
  let taskService: TaskService;
  let sessionService: SessionService;

  beforeEach(async () => {
    prisma = makePrisma();
    taskService = new TaskService(prisma);
    sessionService = new SessionService(prisma);
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.session.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("update(slug, {archived: true}, actor) sets archivedAt + archivedBy", async () => {
    await taskService.create({
      title: "a task",
      status: "pending",
      session: "to-archive",
    });

    const result = await sessionService.update(
      "to-archive",
      { archived: true },
      "dan",
    );

    expect(result.archived).toBe(true);
    expect(result.archivedBy).toBe("dan");
    expect(result.archivedAt).not.toBeNull();

    const row = await prisma.session.findUnique({
      where: { slug: "to-archive" },
    });
    expect(row?.archivedAt).not.toBeNull();
    expect(row?.archivedBy).toBe("dan");
  });

  it("update(slug, {archived: false}, actor) on an archived session clears both", async () => {
    await taskService.create({
      title: "a task",
      status: "pending",
      session: "to-unarchive",
    });
    await prisma.session.update({
      where: { slug: "to-unarchive" },
      data: { archivedAt: new Date(), archivedBy: "someone" },
    });

    const result = await sessionService.update(
      "to-unarchive",
      { archived: false },
      "dan",
    );

    expect(result.archived).toBe(false);
    expect(result.archivedBy).toBeNull();
    expect(result.archivedAt).toBeNull();

    const row = await prisma.session.findUnique({
      where: { slug: "to-unarchive" },
    });
    expect(row?.archivedAt).toBeNull();
    expect(row?.archivedBy).toBeNull();
  });

  it("update(slug, {title: 'New Title'}, actor) updates title", async () => {
    await taskService.create({
      title: "a task",
      status: "pending",
      session: "to-rename",
    });

    const result = await sessionService.update(
      "to-rename",
      { title: "New Title" },
      "dan",
    );

    expect(result.title).toBe("New Title");

    const row = await prisma.session.findUnique({
      where: { slug: "to-rename" },
    });
    expect(row?.title).toBe("New Title");
  });

  it("update(slug, {title: null}, actor) clears an existing title", async () => {
    await taskService.create({
      title: "a task",
      status: "pending",
      session: "to-clear-title",
    });
    await prisma.session.update({
      where: { slug: "to-clear-title" },
      data: { title: "Old Title" },
    });

    const result = await sessionService.update(
      "to-clear-title",
      { title: null },
      "dan",
    );

    expect(result.title).toBeNull();

    const row = await prisma.session.findUnique({
      where: { slug: "to-clear-title" },
    });
    expect(row?.title).toBeNull();
  });

  it("update() omitting archived/title leaves those fields untouched", async () => {
    await taskService.create({
      title: "a task",
      status: "pending",
      session: "untouched-fields",
    });
    await prisma.session.update({
      where: { slug: "untouched-fields" },
      data: { title: "Keep Me" },
    });

    const result = await sessionService.update("untouched-fields", {}, "dan");

    expect(result.title).toBe("Keep Me");
    expect(result.archived).toBe(false);
  });

  it("update() on a nonexistent slug rejects with NotFoundError", async () => {
    await expect(
      sessionService.update("does-not-exist", { title: "x" }, "dan"),
    ).rejects.toThrow();
  });
});
