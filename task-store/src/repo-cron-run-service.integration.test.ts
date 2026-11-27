/**
 * task-store/src/repo-cron-run-service.integration.test.ts
 *
 * Integration tests (real Postgres) for RepoCronRunService (PCR-1.1): the
 * log is append-only (two records for one cron+repo are two rows), /latest
 * returns the newer ok/no_op run with machineState, and failed runs and other
 * accounts are skipped.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import {
  type RecordRepoCronRunInput,
  RepoCronRunService,
} from "./repo-cron-run-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const REPO = "app-vitals/shipwright";

function input(
  overrides: Partial<RecordRepoCronRunInput> = {},
): RecordRepoCronRunInput {
  return {
    accountId: "acct-a",
    cronId: "error-patrol",
    repo: REPO,
    startedAt: "2026-11-27T06:00:00.000Z",
    finishedAt: "2026-11-27T06:01:00.000Z",
    commitSha: "abc",
    outcome: "ok",
    metrics: { scanned: 3, auto: 1, review: 0, plan: 0 },
    machineState: { page: 2 },
    ...overrides,
  };
}

describeOrSkip("RepoCronRunService (integration)", () => {
  let prisma: PrismaClient;
  let service: RepoCronRunService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    service = new RepoCronRunService(prisma);
    await prisma.repoCronRun.deleteMany();
  });

  afterEach(async () => {
    await prisma.repoCronRun.deleteMany();
    await prisma.$disconnect();
  });

  it("two records for the same (cronId, repo) create two rows; latest returns the newer ok one", async () => {
    await service.record(input({ commitSha: "older" }));
    await service.record(
      input({ commitSha: "newer", finishedAt: "2026-11-27T07:00:00.000Z" }),
    );
    expect(await prisma.repoCronRun.count()).toBe(2);

    const latest = await service.latest("error-patrol", REPO);
    expect(latest?.commitSha).toBe("newer");
    expect(latest?.machineState).toEqual({ page: 2 });
  });

  it("latest skips failed runs and returns null when none is ok/no_op", async () => {
    await service.record(input({ outcome: "failed" }));
    expect(await service.latest("error-patrol", REPO)).toBeNull();
    await service.record(
      input({ outcome: "no_op", finishedAt: "2026-11-26T00:00:00.000Z" }),
    );
    await service.record(
      input({ outcome: "failed", finishedAt: "2026-11-28T00:00:00.000Z" }),
    );
    expect((await service.latest("error-patrol", REPO))?.outcome).toBe("no_op");
  });

  it("scopes by account and repo", async () => {
    await service.record(input({ accountId: "acct-b" }));
    expect(
      await service.latest("error-patrol", REPO, {
        repos: [REPO],
        accountId: "acct-a",
      }),
    ).toBeNull();
    expect(
      await service.latest("error-patrol", REPO, {
        repos: ["other/repo"],
        accountId: "acct-b",
      }),
    ).toBeNull();
  });

  it("list omits machineState unless includeDetail", async () => {
    await service.record(input());
    const plain = await service.list();
    expect("machineState" in (plain.runs[0] as object)).toBe(false);
    const detail = await service.list({ includeDetail: true });
    expect(detail.runs[0]?.machineState).toEqual({ page: 2 });
  });
});
