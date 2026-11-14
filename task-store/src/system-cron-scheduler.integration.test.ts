/**
 * task-store/src/system-cron-scheduler.integration.test.ts
 *
 * SCR-1.3 — two admin replicas' system-cron schedulers
 * (admin/src/coding/system-cron-scheduler.ts) ticking concurrently against
 * ONE real task-store app and a real Postgres DB: every due slot is claimed
 * exactly once and produces exactly one task set (one task per unarchived
 * repo), including a multi-slot catch-up. Each scheduler's HTTP store routes
 * into `app.request()` in-process (no socket, no global override); the
 * lookup-App lister and the clock are injected doubles.
 *
 * Lives here rather than under admin/ for the same reason as
 * admin-fetchers-account-scope.integration.test.ts: this package owns the
 * task-store app, its Prisma client and the test DB wiring. Type-checked by
 * tsconfig.cross-package.json.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createHttpSystemCronStore,
  type LookupRepositoryLister,
  SystemCronScheduler,
  type SystemCronStore,
} from "@shipwright/admin/coding/system-cron-scheduler";
import { createTaskStoreApp } from "./app.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { SessionService } from "./session-service.ts";
import { SystemCronService } from "./system-cron-service.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const CRON_ID = "scr-sched-it";

const lookup: LookupRepositoryLister = {
  listRepositories: async () => ({
    configured: true,
    repos: [
      { fullName: "acme/widgets", archived: false },
      { fullName: "acme/gadgets", archived: false },
      { fullName: "acme/retired", archived: true },
    ],
  }),
};

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.systemCronTrigger.deleteMany({ where: { cronId: CRON_ID } });
  await prisma.task.deleteMany({
    where: { id: { startsWith: `SC-${CRON_ID}-` } },
  });
  await prisma.systemCronDefinition.deleteMany({ where: { id: CRON_ID } });
}

describeOrSkip("system-cron scheduler × task-store (integration)", () => {
  let prisma: PrismaClient;
  let now: Date;
  let schedulers: SystemCronScheduler[];
  let store: SystemCronStore;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await cleanup(prisma);
    await prisma.taskToken.deleteMany({ where: { label: "scr-sched-it" } });

    const tokenService = new TaskTokenService(prisma);
    const adminToken = (await tokenService.create("scr-sched-it")).rawToken;
    const app = createTaskStoreApp({
      taskService: new TaskService(prisma),
      tokenService,
      sessionService: new SessionService(prisma),
      pullRequestService: new PullRequestService(prisma),
      systemCronService: new SystemCronService(prisma),
    });

    // Enabled 2026-11-11 08:00 and never fired: by "now" (2026-11-14
    // 07:00:30) three daily 07:00 slots are due — 12th, 13th, 14th.
    await prisma.systemCronDefinition.create({
      data: {
        id: CRON_ID,
        name: "Scheduler IT",
        schedule: "0 7 * * *",
        timezone: "UTC",
        enabled: true,
        enabledAt: new Date("2026-11-11T08:00:00Z"),
        titleTemplate: "Scheduler IT: {repo}",
        descriptionTemplate: "/shipwright:research-docs --auto --repo {repo}",
      },
    });
    now = new Date("2026-11-14T07:00:30Z");

    store = createHttpSystemCronStore({
      url: "http://task-store.test",
      adminToken,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        return app.request(`${url.pathname}${url.search}`, init);
      },
    });
    const replica = () =>
      new SystemCronScheduler({
        store,
        lookup,
        clock: { now: () => now },
        log: () => {},
        error: () => {},
      });
    schedulers = [replica(), replica()];
  });

  afterEach(async () => {
    await cleanup(prisma);
    await prisma.taskToken.deleteMany({ where: { label: "scr-sched-it" } });
    await prisma.$disconnect();
  });

  it("two schedulers ticking at once create one task set per slot, catching up in order", async () => {
    const results = await Promise.all(schedulers.map((s) => s.tick()));
    for (const r of results) expect(r.errors).toEqual([]);

    const triggers = await prisma.systemCronTrigger.findMany({
      where: { cronId: CRON_ID },
      orderBy: { scheduledFor: "asc" },
    });
    expect(triggers.map((t) => t.scheduledFor.toISOString())).toEqual([
      "2026-11-12T07:00:00.000Z",
      "2026-11-13T07:00:00.000Z",
      "2026-11-14T07:00:00.000Z",
    ]);
    expect(triggers.every((t) => t.taskCount === 2)).toBe(true);

    const tasks = await prisma.task.findMany({
      where: { id: { startsWith: `SC-${CRON_ID}-` } },
      orderBy: { id: "asc" },
    });
    expect(tasks.map((t) => t.id)).toEqual([
      `SC-${CRON_ID}-20261112T070000Z-acme-gadgets`,
      `SC-${CRON_ID}-20261112T070000Z-acme-widgets`,
      `SC-${CRON_ID}-20261113T070000Z-acme-gadgets`,
      `SC-${CRON_ID}-20261113T070000Z-acme-widgets`,
      `SC-${CRON_ID}-20261114T070000Z-acme-gadgets`,
      `SC-${CRON_ID}-20261114T070000Z-acme-widgets`,
    ]);
    expect(tasks[0].description).toBe(
      "/shipwright:research-docs --auto --repo acme/gadgets",
    );

    // Each slot was claimed by exactly one replica.
    const claims = results
      .flatMap((r) => r.fired)
      .filter((f) => f.claimed)
      .map((f) => f.scheduledFor)
      .sort();
    expect(claims).toEqual([
      "2026-11-12T07:00:00.000Z",
      "2026-11-13T07:00:00.000Z",
      "2026-11-14T07:00:00.000Z",
    ]);

    // A later tick in the same minute is idle; the next day fires one slot.
    expect((await schedulers[0].tick()).status).toBe("idle");
    now = new Date("2026-11-15T07:01:00Z");
    await Promise.all(schedulers.map((s) => s.tick()));
    expect(
      await prisma.systemCronTrigger.count({ where: { cronId: CRON_ID } }),
    ).toBe(4);
    expect(
      await prisma.task.count({
        where: { id: { startsWith: `SC-${CRON_ID}-` } },
      }),
    ).toBe(8);
  });

  it("records nothing while the lookup App is unconfigured", async () => {
    const unconfigured = new SystemCronScheduler({
      store,
      lookup: {
        listRepositories: async () => ({ configured: false, repos: [] }),
      },
      clock: { now: () => now },
      log: () => {},
    });
    expect((await unconfigured.tick()).status).toBe("skipped-unconfigured");
    expect(
      await prisma.systemCronTrigger.count({ where: { cronId: CRON_ID } }),
    ).toBe(0);
  });
});
