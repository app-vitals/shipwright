/**
 * task-store/src/session-account-key.integration.test.ts
 *
 * SSP-6.7: Sessions are keyed by [accountId, slug]. Covers, against a real
 * Postgres DB:
 *   - TaskService create()/bulk() stamp the Session row with the task's own
 *     accountId (DEFAULT_ACCOUNT_ID when the task carries none)
 *   - SSP-6.9: the slug-only primary key is gone, so the same slug under two
 *     accounts succeeds while the same slug and account conflicts
 *   - with [accountId, slug] as the sole identity:
 *       · two accounts using one slug get two separate Session rows
 *       · rename/archive of one does not affect the other
 *       · list()/get() for account A never count or return account B's
 *         tasks under the same slug
 *       · list() without an accountId returns both rows, labeled by account
 *       · the retention reaper archives only the account whose own tasks
 *         are stale
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_ACCOUNT_ID } from "@shipwright/lib/default-account";
import { FixedClock } from "./clock.ts";
import { type PrismaClient, createPrismaClient } from "./prisma-client.ts";
import { SessionRetentionReaper } from "./session-retention-reaper.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

const ACCOUNT_A = "acct-a";
const ACCOUNT_B = "acct-b";
const SLUG = "shared-slug";

function makePrisma(): PrismaClient {
  return createPrismaClient(TEST_DB as string);
}

async function clearTables(prisma: PrismaClient): Promise<void> {
  // TaskEvent's FK is ON DELETE RESTRICT — clear it before Task rows.
  await prisma.taskEvent.deleteMany();
  await prisma.task.deleteMany();
  await prisma.session.deleteMany();
}

describeOrSkip("Session accountId stamping (integration)", () => {
  let prisma: PrismaClient;
  let taskService: TaskService;

  beforeEach(async () => {
    prisma = makePrisma();
    taskService = new TaskService(prisma);
    await clearTables(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("create() stamps the Session row with the task's accountId", async () => {
    await taskService.create({
      title: "acct-a task",
      status: "pending",
      session: SLUG,
      accountId: ACCOUNT_A,
    });

    const row = await prisma.session.findUnique({
      where: { accountId_slug: { accountId: ACCOUNT_A, slug: SLUG } },
    });
    expect(row).not.toBeNull();
    expect(row?.accountId).toBe(ACCOUNT_A);
  });

  it("create() without an accountId stamps the Session row with DEFAULT_ACCOUNT_ID", async () => {
    await taskService.create({
      title: "default task",
      status: "pending",
      session: SLUG,
    });

    const row = await prisma.session.findUnique({
      where: { accountId_slug: { accountId: DEFAULT_ACCOUNT_ID, slug: SLUG } },
    });
    expect(row?.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("bulk() stamps each Session row with its own task's accountId", async () => {
    await taskService.bulk([
      {
        id: "bulk-a",
        title: "a",
        status: "pending",
        session: "bulk-a-slug",
        accountId: ACCOUNT_A,
      },
      {
        id: "bulk-b",
        title: "b",
        status: "pending",
        session: "bulk-b-slug",
        accountId: ACCOUNT_B,
      },
    ]);

    const rows = await prisma.session.findMany({ orderBy: { slug: "asc" } });
    expect(rows.map((r) => [r.slug, r.accountId])).toEqual([
      ["bulk-a-slug", ACCOUNT_A],
      ["bulk-b-slug", ACCOUNT_B],
    ]);
  });

  it("the same slug under two accountIds yields two Session rows", async () => {
    await taskService.create({
      title: "acct-a task",
      status: "pending",
      session: SLUG,
      accountId: ACCOUNT_A,
    });
    await taskService.create({
      title: "acct-b task",
      status: "pending",
      session: SLUG,
      accountId: ACCOUNT_B,
    });

    const rows = await prisma.session.findMany({
      where: { slug: SLUG },
      orderBy: { accountId: "asc" },
    });
    expect(rows.map((r) => r.accountId)).toEqual([ACCOUNT_A, ACCOUNT_B]);
  });

  it("the same slug and accountId conflicts", async () => {
    await prisma.session.create({
      data: { slug: SLUG, accountId: ACCOUNT_A },
    });

    await expect(
      (async () =>
        prisma.session.create({
          data: { slug: SLUG, accountId: ACCOUNT_A },
        }))(),
    ).rejects.toThrow();
  });
});

describeOrSkip("Session [accountId, slug] isolation (integration)", () => {
  const NOW = new Date("2026-09-01T12:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

  let prisma: PrismaClient;
  let taskService: TaskService;
  let sessionService: SessionService;

  beforeEach(async () => {
    prisma = makePrisma();
    taskService = new TaskService(prisma);
    sessionService = new SessionService(prisma, FixedClock(NOW));
    await clearTables(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  async function seedBothAccounts(): Promise<void> {
    await taskService.create({
      title: "a-1",
      status: "pending",
      session: SLUG,
      accountId: ACCOUNT_A,
      assignee: "agent-a",
      repo: "org/a",
    });
    await taskService.create({
      title: "b-1",
      status: "pending",
      session: SLUG,
      accountId: ACCOUNT_B,
      assignee: "agent-b",
      repo: "org/b",
    });
    await taskService.create({
      title: "b-2",
      status: "done",
      session: SLUG,
      accountId: ACCOUNT_B,
      assignee: "agent-b",
      repo: "org/b",
    });
  }

  it("(AC1) two accounts using the same slug get two separate Session rows", async () => {
    await seedBothAccounts();

    const rows = await prisma.session.findMany({
      where: { slug: SLUG },
      orderBy: { accountId: "asc" },
    });
    expect(rows.map((r) => r.accountId)).toEqual([ACCOUNT_A, ACCOUNT_B]);
  });

  it("(AC1) renaming one account's session does not rename the other's", async () => {
    await seedBothAccounts();

    const updated = await sessionService.update(
      SLUG,
      { title: "A's title" },
      "admin",
      ACCOUNT_A,
    );
    expect(updated.accountId).toBe(ACCOUNT_A);
    expect(updated.title).toBe("A's title");

    const b = await prisma.session.findUniqueOrThrow({
      where: { accountId_slug: { accountId: ACCOUNT_B, slug: SLUG } },
    });
    expect(b.title).toBeNull();
  });

  it("(AC1) archiving one account's session does not archive the other's", async () => {
    await seedBothAccounts();

    await sessionService.update(SLUG, { archived: true }, "admin", ACCOUNT_B);

    const a = await prisma.session.findUniqueOrThrow({
      where: { accountId_slug: { accountId: ACCOUNT_A, slug: SLUG } },
    });
    const b = await prisma.session.findUniqueOrThrow({
      where: { accountId_slug: { accountId: ACCOUNT_B, slug: SLUG } },
    });
    expect(a.archivedAt).toBeNull();
    expect(b.archivedAt).not.toBeNull();
    expect(b.archivedBy).toBe("admin");
  });

  it("a task write un-archives only its own account's session", async () => {
    await seedBothAccounts();
    await sessionService.update(SLUG, { archived: true }, "admin", ACCOUNT_A);
    await sessionService.update(SLUG, { archived: true }, "admin", ACCOUNT_B);

    await taskService.create({
      title: "a-2",
      status: "pending",
      session: SLUG,
      accountId: ACCOUNT_A,
    });

    const a = await prisma.session.findUniqueOrThrow({
      where: { accountId_slug: { accountId: ACCOUNT_A, slug: SLUG } },
    });
    const b = await prisma.session.findUniqueOrThrow({
      where: { accountId_slug: { accountId: ACCOUNT_B, slug: SLUG } },
    });
    expect(a.archivedAt).toBeNull();
    expect(b.archivedAt).not.toBeNull();
  });

  it("update() for an account with no row under that slug rejects with NotFoundError", async () => {
    await taskService.create({
      title: "a-1",
      status: "pending",
      session: SLUG,
      accountId: ACCOUNT_A,
    });

    await expect(
      sessionService.update(SLUG, { title: "x" }, "admin", ACCOUNT_B),
    ).rejects.toThrow("session not found");
  });

  it("(AC2) list() for account A never counts or returns account B's tasks with the same slug", async () => {
    await seedBothAccounts();

    const result = await sessionService.list({
      accountId: ACCOUNT_A,
      state: "all",
    });
    expect(result.total).toBe(1);
    const [item] = result.sessions;
    expect(item?.accountId).toBe(ACCOUNT_A);
    expect(item?.counts).toEqual({ total: 1, open: 1, closed: 0 });
    expect(item?.agentIds).toEqual(["agent-a"]);
    expect(item?.repos).toEqual(["org/a"]);
  });

  it("(AC4) list() without an accountId returns every account's row, each labeled and rolled up from its own tasks", async () => {
    await seedBothAccounts();

    const result = await sessionService.list({ state: "all" });
    expect(result.total).toBe(2);
    const byAccount = new Map(result.sessions.map((s) => [s.accountId, s]));
    expect(byAccount.get(ACCOUNT_A)?.counts).toEqual({
      total: 1,
      open: 1,
      closed: 0,
    });
    expect(byAccount.get(ACCOUNT_B)?.counts).toEqual({
      total: 2,
      open: 1,
      closed: 1,
    });
  });

  it("get() returns only the requested account's row and rollup", async () => {
    await seedBothAccounts();

    const b = await sessionService.get(SLUG, undefined, ACCOUNT_B);
    expect(b?.accountId).toBe(ACCOUNT_B);
    expect(b?.counts).toEqual({ total: 2, open: 1, closed: 1 });

    const missing = await sessionService.get(SLUG, undefined, "acct-none");
    expect(missing).toBeNull();
  });

  it("a scoped token never sees a session whose only qualifying task is in another account", async () => {
    await seedBothAccounts();

    // agent-b's tasks live in account B; in account A's session it has none.
    const scope = { agentId: "agent-b", repos: ["org/b"] };
    const listed = await sessionService.list({
      accountId: ACCOUNT_A,
      state: "all",
      agentScope: scope,
    });
    expect(listed.sessions).toHaveLength(0);

    const got = await sessionService.get(SLUG, scope, ACCOUNT_A);
    expect(got).toBeNull();
  });

  it("(AC3) the retention reaper archives only the session whose own account's tasks are stale", async () => {
    await prisma.session.create({
      data: { slug: SLUG, accountId: ACCOUNT_A },
    });
    await prisma.session.create({
      data: { slug: SLUG, accountId: ACCOUNT_B },
    });
    // Account A: one terminal task, 40 days old → stale.
    await prisma.task.create({
      data: {
        title: "a-old",
        status: "done",
        session: SLUG,
        accountId: ACCOUNT_A,
        updatedAt: daysAgo(40),
      },
    });
    // Account B: one terminal task, 2 days old → fresh.
    await prisma.task.create({
      data: {
        title: "b-recent",
        status: "done",
        session: SLUG,
        accountId: ACCOUNT_B,
        updatedAt: daysAgo(2),
      },
    });

    const reaper = new SessionRetentionReaper(
      prisma,
      sessionService,
      FixedClock(NOW),
      { archiveAfterDays: 30 },
    );
    expect(await reaper.sweep()).toBe(1);

    const a = await prisma.session.findUniqueOrThrow({
      where: { accountId_slug: { accountId: ACCOUNT_A, slug: SLUG } },
    });
    const b = await prisma.session.findUniqueOrThrow({
      where: { accountId_slug: { accountId: ACCOUNT_B, slug: SLUG } },
    });
    expect(a.archivedAt).not.toBeNull();
    expect(a.archivedBy).toBe("system");
    expect(b.archivedAt).toBeNull();
  });

  it("(AC3) the reaper does not count another account's open task against a stale session", async () => {
    await prisma.session.create({
      data: { slug: SLUG, accountId: ACCOUNT_A },
    });
    await prisma.task.create({
      data: {
        title: "a-old",
        status: "done",
        session: SLUG,
        accountId: ACCOUNT_A,
        updatedAt: daysAgo(40),
      },
    });
    // Account B has an open task under the same slug (and no Session row).
    await prisma.task.create({
      data: {
        title: "b-open",
        status: "pending",
        session: SLUG,
        accountId: ACCOUNT_B,
      },
    });

    const reaper = new SessionRetentionReaper(
      prisma,
      sessionService,
      FixedClock(NOW),
      { archiveAfterDays: 30 },
    );
    expect(await reaper.sweep()).toBe(1);
  });
});
