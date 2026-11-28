/**
 * task-store/src/readiness-summary-service.integration.test.ts
 *
 * Integration tests (real Postgres) for ReadinessSummaryService (RDY-4.1):
 * the 12-week trend aggregation (each week's latest snapshot per repo) and
 * ownerRunning computed from the system-cron table.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FixedClock } from "./clock.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { ReadinessSnapshotService } from "./readiness-snapshot-service.ts";
import { ReadinessSummaryService } from "./readiness-summary-service.ts";
import { SystemCronService } from "./system-cron-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const NOW = new Date("2026-11-28T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ALL = { repos: null, accountId: null };

describeOrSkip("ReadinessSummaryService (integration)", () => {
  let prisma: PrismaClient;
  let snapshots: ReadinessSnapshotService;
  let crons: SystemCronService;
  let service: ReadinessSummaryService;

  const record = (
    repo: string,
    level: number,
    ageMs: number,
    over: { commitSha?: string; checks?: unknown; accountId?: string } = {},
  ) =>
    snapshots.record({
      accountId: over.accountId ?? "default",
      repo,
      commitSha: over.commitSha ?? `${repo}-${ageMs}`,
      level,
      passing: 1,
      failing: 0,
      checks: over.checks ?? [],
      catalogueVersion: "1",
      measuredAt: ago(ageMs),
    });

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    snapshots = new ReadinessSnapshotService(prisma);
    crons = new SystemCronService(prisma);
    service = new ReadinessSummaryService(prisma, crons, FixedClock(NOW));
    await prisma.readinessSnapshot.deleteMany();
    await prisma.systemCronTrigger.deleteMany();
    await prisma.systemCronDefinition.deleteMany();
  });

  afterEach(async () => {
    await prisma.readinessSnapshot.deleteMany();
    await prisma.systemCronTrigger.deleteMany();
    await prisma.systemCronDefinition.deleteMany();
    await prisma.$disconnect();
  });

  it("trend has 12 weekly points built from each week's latest snapshot per repo", async () => {
    // Final week (0-7d ago): a goes 1 -> 4 (latest 4), b stays 2 => 1 of 2.
    await record("org/a", 1, 6 * DAY);
    await record("org/a", 4, 1 * DAY);
    await record("org/b", 2, 3 * DAY);
    // Week 2 back (7-14d ago): a=3, b=3 => 100%.
    await record("org/a", 3, 10 * DAY);
    await record("org/b", 3, 9 * DAY);
    // Oldest week (77-84d ago): only c at level 5.
    await record("org/c", 5, 80 * DAY);
    // Outside the 12-week window: ignored.
    await record("org/d", 5, 90 * DAY);

    const { trend } = await service.summary(ALL);
    expect(trend).toHaveLength(12);
    // chronological, contiguous, ending at now
    expect(trend[11]?.weekEnd).toBe(NOW.toISOString());
    for (let i = 1; i < 12; i++) {
      expect(trend[i]?.weekStart).toBe(trend[i - 1]?.weekEnd as string);
    }
    expect(trend[11]).toMatchObject({
      percentAtOrAboveFloor: 50,
      repoCount: 2,
    });
    expect(trend[10]).toMatchObject({
      percentAtOrAboveFloor: 100,
      repoCount: 2,
    });
    expect(trend[0]).toMatchObject({
      percentAtOrAboveFloor: 100,
      repoCount: 1,
    });
    expect(trend[5]).toMatchObject({
      percentAtOrAboveFloor: null,
      repoCount: 0,
    });
  });

  it("ownerRunning is false for a disabled cron or one not scoped to the repo", async () => {
    await crons.create({
      id: "entropy-patrol",
      name: "e",
      schedule: "0 4 * * 1",
      titleTemplate: "t {repo}",
      descriptionTemplate: "d {repo}",
      enabled: true,
    });
    await crons.create({
      id: "docs-freshness",
      name: "d",
      schedule: "0 7 * * *",
      titleTemplate: "t {repo}",
      descriptionTemplate: "d {repo}",
      enabled: false,
    });
    await crons.create({
      id: "environments",
      name: "v",
      schedule: "0 3 * * 1",
      titleTemplate: "t {repo}",
      descriptionTemplate: "d {repo}",
      enabled: true,
      repoScope: "selected",
      repos: ["org/other"],
    });
    await crons.create({
      id: "security-patrol",
      name: "s",
      schedule: "0 2 * * 1",
      titleTemplate: "t {repo}",
      descriptionTemplate: "d {repo}",
      enabled: true,
      repoScope: "selected",
      repos: ["org/a"],
    });
    const fail = (id: string, owner: string) => ({
      id,
      level: 1,
      result: "fail",
      owner,
    });
    await record("org/a", 0, DAY, {
      checks: [
        fail("c1", "entropy-patrol"),
        fail("c2", "docs-freshness"),
        fail("c3", "environments"),
        fail("c4", "security-patrol"),
        fail("c5", "no-such-cron"),
        fail("c6", "operator"),
      ],
    });

    const { repos } = await service.summary(ALL);
    const byId = Object.fromEntries(
      (repos[0]?.failingChecks ?? []).map((c) => [c.id, c.ownerRunning]),
    );
    expect(byId).toEqual({
      c1: true,
      c2: false,
      c3: false,
      c4: true,
      c5: false,
      c6: true,
    });
  });

  it("a cron in another account does not count as running", async () => {
    await crons.create(
      {
        id: "entropy-patrol",
        name: "e",
        schedule: "0 4 * * 1",
        titleTemplate: "t {repo}",
        descriptionTemplate: "d {repo}",
        enabled: true,
      },
      "acct-b",
    );
    await record("org/a", 0, DAY, {
      checks: [{ id: "c1", level: 1, result: "fail", owner: "entropy-patrol" }],
    });
    const { repos } = await service.summary(ALL);
    expect(repos[0]?.failingChecks[0]?.ownerRunning).toBe(false);
  });
});
