// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests assert that literal ${x} sequences in templates are NOT evaluated
/**
 * task-store/src/system-cron-service.integration.test.ts
 *
 * Integration tests (real Postgres) for SystemCronService.fire() (SCR-1.1):
 *   - one fire claims a (cronId, scheduledFor) slot and creates one task per
 *     repo with deterministic ids and a rendered description
 *   - N concurrent fires for the same slot produce exactly one claim and one
 *     set of tasks — the losers get claimed:false and create nothing
 *   - a fire that fails mid-transaction leaves nothing behind (no trigger row,
 *     no tasks), so a retry claims the slot cleanly with no duplicate tasks
 *
 * Fault injection uses a per-test wrapper around the real PrismaClient handed
 * to the service's constructor — no mock.module(), no global overrides.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { SystemCronService } from "./system-cron-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

const CRON_ID = "scr-it-audit";
const SCHEDULED_FOR = "2026-11-14T09:00:00Z";
const SLOT = "20261114T090000Z";
const REPOS = ["acme/widgets", "acme/gadgets", "other-org/thing"];

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.systemCronTrigger.deleteMany();
  await prisma.systemCronDefinition.deleteMany();
  await prisma.task.deleteMany({ where: { id: { startsWith: "SC-" } } });
}

/**
 * Wraps `prisma` so the first `failures` interactive transactions throw from
 * inside the callback right after the task bulk-insert — i.e. after both the
 * trigger row and the tasks were written, so a correct implementation must
 * roll both back.
 */
function failingPrisma(prisma: PrismaClient, failures: number): PrismaClient {
  let remaining = failures;
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
      return (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
        // biome-ignore lint/suspicious/noExplicitAny: forwarding the interactive-transaction overload
        (target.$transaction as any)(async (tx: any) => {
          const result = await fn(tx);
          if (remaining > 0) {
            remaining--;
            throw new Error("injected failure after task insert");
          }
          return result;
        }, opts);
    },
  });
}

describeOrSkip("SystemCronService.fire (integration)", () => {
  let prisma: PrismaClient;
  let service: SystemCronService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    service = new SystemCronService(prisma);
    await cleanup(prisma);
    await prisma.systemCronDefinition.create({
      data: {
        id: CRON_ID,
        accountId: "acct-scr",
        name: "Dependency audit",
        schedule: "0 9 * * *",
        timezone: "UTC",
        enabled: true,
        titleTemplate: "Dependency audit: {repo}",
        descriptionTemplate:
          "Audit {repo} dependencies. Leave ${x} {{x}} {other} alone.",
      },
    });
  });

  afterEach(async () => {
    await cleanup(prisma);
    await prisma.$disconnect();
  });

  it("claims the slot and creates one task per repo with deterministic ids", async () => {
    const result = await service.fire(CRON_ID, {
      scheduledFor: SCHEDULED_FOR,
      repos: REPOS,
    });

    expect(result.claimed).toBe(true);
    expect(result.slot).toBe(SLOT);
    expect(result.scheduledFor).toBe("2026-11-14T09:00:00.000Z");
    expect([...result.taskIds].sort()).toEqual(
      [
        `SC-${CRON_ID}-${SLOT}-acme-widgets`,
        `SC-${CRON_ID}-${SLOT}-acme-gadgets`,
        `SC-${CRON_ID}-${SLOT}-other-org-thing`,
      ].sort(),
    );

    const task = await prisma.task.findUniqueOrThrow({
      where: { id: `SC-${CRON_ID}-${SLOT}-acme-widgets` },
    });
    expect(task.title).toBe("Dependency audit: acme/widgets");
    expect(task.description).toBe(
      "Audit acme/widgets dependencies. Leave ${x} {{x}} {other} alone.",
    );
    expect(task.repo).toBe("acme/widgets");
    expect(task.kind).toBe("dev");
    expect(task.hitl).toBe(false);
    expect(task.assignee).toBeNull();
    expect(task.status).toBe("pending");
    expect(task.accountId).toBe("acct-scr");

    const triggers = await prisma.systemCronTrigger.findMany({
      where: { cronId: CRON_ID },
    });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].scheduledFor.toISOString()).toBe(
      "2026-11-14T09:00:00.000Z",
    );
  });

  it("a second fire for the same slot returns claimed:false and creates nothing", async () => {
    await service.fire(CRON_ID, { scheduledFor: SCHEDULED_FOR, repos: REPOS });
    const again = await service.fire(CRON_ID, {
      scheduledFor: SCHEDULED_FOR,
      repos: [...REPOS, "acme/new-repo"],
    });

    expect(again.claimed).toBe(false);
    expect(again.taskIds).toEqual([]);
    expect(
      await prisma.task.count({ where: { id: { startsWith: "SC-" } } }),
    ).toBe(REPOS.length);
  });

  it("N concurrent fires for one slot produce one claim and one set of tasks", async () => {
    const N = 8;
    // Each caller gets its own client (own pool) so the inserts genuinely race
    // across separate connections rather than queueing on one.
    const clients = Array.from({ length: N }, () =>
      createPrismaClient(TEST_DB as string),
    );
    try {
      const results = await Promise.all(
        clients.map((client) =>
          new SystemCronService(client).fire(CRON_ID, {
            scheduledFor: SCHEDULED_FOR,
            repos: REPOS,
          }),
        ),
      );

      const winners = results.filter((r) => r.claimed);
      const losers = results.filter((r) => !r.claimed);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(N - 1);
      expect(winners[0].taskIds).toHaveLength(REPOS.length);
      for (const loser of losers) expect(loser.taskIds).toEqual([]);

      expect(
        await prisma.systemCronTrigger.count({ where: { cronId: CRON_ID } }),
      ).toBe(1);
      expect(
        await prisma.task.count({ where: { id: { startsWith: "SC-" } } }),
      ).toBe(REPOS.length);
    } finally {
      await Promise.all(clients.map((c) => c.$disconnect()));
    }
  });

  it("a fire that fails mid-transaction leaves nothing behind, and a retry is safe", async () => {
    const flaky = new SystemCronService(failingPrisma(prisma, 1));

    await expect(
      flaky.fire(CRON_ID, { scheduledFor: SCHEDULED_FOR, repos: REPOS }),
    ).rejects.toThrow("injected failure after task insert");

    // Rolled back as a unit: no trigger row, no tasks.
    expect(await prisma.systemCronTrigger.count()).toBe(0);
    expect(
      await prisma.task.count({ where: { id: { startsWith: "SC-" } } }),
    ).toBe(0);

    // Retry (same wrapper, failure budget now spent) claims cleanly.
    const retry = await flaky.fire(CRON_ID, {
      scheduledFor: SCHEDULED_FOR,
      repos: REPOS,
    });
    expect(retry.claimed).toBe(true);
    expect(retry.taskIds).toHaveLength(REPOS.length);

    // A further retry after success is a no-op — still exactly one set.
    const again = await flaky.fire(CRON_ID, {
      scheduledFor: SCHEDULED_FOR,
      repos: REPOS,
    });
    expect(again.claimed).toBe(false);
    expect(await prisma.systemCronTrigger.count()).toBe(1);
    expect(
      await prisma.task.count({ where: { id: { startsWith: "SC-" } } }),
    ).toBe(REPOS.length);
  });

  it("distinct slots for the same cron each get their own tasks", async () => {
    const a = await service.fire(CRON_ID, {
      scheduledFor: "2026-11-14T09:00:00Z",
      repos: ["acme/widgets"],
    });
    const b = await service.fire(CRON_ID, {
      scheduledFor: "2026-11-15T09:00:00Z",
      repos: ["acme/widgets"],
    });
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(true);
    expect(a.taskIds).toEqual([`SC-${CRON_ID}-20261114T090000Z-acme-widgets`]);
    expect(b.taskIds).toEqual([`SC-${CRON_ID}-20261115T090000Z-acme-widgets`]);
  });

  it("sub-second variants of one instant map to the same slot", async () => {
    const a = await service.fire(CRON_ID, {
      scheduledFor: "2026-11-14T09:00:00.000Z",
      repos: REPOS,
    });
    const b = await service.fire(CRON_ID, {
      scheduledFor: "2026-11-14T09:00:00.500Z",
      repos: REPOS,
    });
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(false);
  });

  it("rejects a disabled definition with 409 and creates nothing", async () => {
    await prisma.systemCronDefinition.update({
      where: { id: CRON_ID },
      data: { enabled: false },
    });
    await expect(
      service.fire(CRON_ID, { scheduledFor: SCHEDULED_FOR, repos: REPOS }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.systemCronTrigger.count()).toBe(0);
  });

  it("404s an unknown cron and a cron outside the caller's account", async () => {
    await expect(
      service.fire("nope", { scheduledFor: SCHEDULED_FOR, repos: REPOS }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.fire(
        CRON_ID,
        { scheduledFor: SCHEDULED_FOR, repos: REPOS },
        "acct-other",
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describeOrSkip("SystemCronService definitions (integration)", () => {
  let prisma: PrismaClient;
  let service: SystemCronService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    service = new SystemCronService(prisma);
    await cleanup(prisma);
  });

  afterEach(async () => {
    await cleanup(prisma);
    await prisma.$disconnect();
  });

  it("creates, lists, patches and enables/disables definitions", async () => {
    const created = await service.create(
      {
        id: CRON_ID,
        name: "Audit",
        schedule: "0 9 * * *",
        titleTemplate: "Audit {repo}",
        descriptionTemplate: "Audit {repo}",
      },
      "acct-scr",
    );
    expect(created.enabled).toBe(true);
    expect(created.timezone).toBe("UTC");
    expect(created.accountId).toBe("acct-scr");

    await expect(
      service.create(
        {
          id: CRON_ID,
          name: "dup",
          schedule: "0 9 * * *",
          titleTemplate: "t",
          descriptionTemplate: "d",
        },
        "acct-scr",
      ),
    ).rejects.toMatchObject({ statusCode: 409 });

    const patched = await service.update(
      CRON_ID,
      { schedule: "0 10 * * 1", timezone: "America/New_York" },
      "acct-scr",
    );
    expect(patched.schedule).toBe("0 10 * * 1");
    expect(patched.timezone).toBe("America/New_York");
    expect(patched.name).toBe("Audit");

    const disabled = await service.setEnabled(CRON_ID, false, null);
    expect(disabled.enabled).toBe(false);

    expect(await service.list({ accountId: "acct-scr" })).toHaveLength(1);
    expect(await service.list({ accountId: "acct-other" })).toHaveLength(0);
    expect(await service.list({ accountId: null, enabled: true })).toHaveLength(
      0,
    );

    await expect(
      service.update(CRON_ID, { name: "x" }, "acct-other"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
