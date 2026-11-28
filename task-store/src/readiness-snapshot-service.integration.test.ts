/**
 * task-store/src/readiness-snapshot-service.integration.test.ts
 *
 * Integration tests (real Postgres) for ReadinessSnapshotService (RDY-1.2):
 * a first record creates, a repeat for the same commit replaces in place,
 * invalid level / malformed repo / malformed checks are rejected, and
 * latest() returns the newest snapshot per repo within scope.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BadRequestError, ForbiddenError } from "./errors.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import {
  type RecordReadinessSnapshotInput,
  ReadinessSnapshotService,
} from "./readiness-snapshot-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const REPO = "app-vitals/shipwright";
const CHECKS = [
  { id: "readme-present", level: 1, result: "pass", owner: "docs-freshness" },
  { id: "linter-configured", level: 1, result: "fail", owner: "entropy" },
];

function input(
  overrides: Partial<RecordReadinessSnapshotInput> = {},
): RecordReadinessSnapshotInput {
  return {
    accountId: "acct-a",
    repo: REPO,
    commitSha: "abc",
    level: 0,
    passing: 1,
    failing: 1,
    checks: CHECKS,
    catalogueVersion: "1",
    measuredAt: "2026-11-28T06:00:00.000Z",
    ...overrides,
  };
}

describeOrSkip("ReadinessSnapshotService (integration)", () => {
  let prisma: PrismaClient;
  let service: ReadinessSnapshotService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    service = new ReadinessSnapshotService(prisma);
    await prisma.readinessSnapshot.deleteMany();
  });

  afterEach(async () => {
    await prisma.readinessSnapshot.deleteMany();
    await prisma.$disconnect();
  });

  it("first record creates; a repeat for the same commit replaces in place", async () => {
    const first = await service.record(input());
    expect(first.created).toBe(true);
    expect(first.snapshot.checks).toEqual(CHECKS);

    const again = await service.record(
      input({ level: 1, passing: 2, failing: 0, catalogueVersion: "2" }),
    );
    expect(again.created).toBe(false);
    expect(again.snapshot.id).toBe(first.snapshot.id);
    expect(again.snapshot).toMatchObject({ level: 1, catalogueVersion: "2" });
    expect(await prisma.readinessSnapshot.count()).toBe(1);
  });

  it("same commit in two accounts is two rows", async () => {
    await service.record(input());
    await service.record(input({ accountId: "acct-b" }));
    expect(await prisma.readinessSnapshot.count()).toBe(2);
  });

  it("rejects invalid level, malformed repo, malformed checks and negative counts", async () => {
    const bad: Partial<RecordReadinessSnapshotInput>[] = [
      { level: 6 },
      { level: -1 },
      { level: 1.5 },
      { repo: "not-a-repo" },
      { checks: "nope" },
      { checks: [{ id: "x", level: 1, result: "maybe", owner: "entropy" }] },
      { checks: [{ id: "x", level: 1, result: "pass" }] },
      { passing: -1 },
      { failing: -1 },
    ];
    for (const override of bad) {
      await expect(service.record(input(override))).rejects.toThrow(
        BadRequestError,
      );
    }
    expect(await prisma.readinessSnapshot.count()).toBe(0);
  });

  it("rejects an out-of-scope repo write with 403", async () => {
    await expect(
      service.record(input(), { repos: ["org/other"], accountId: "acct-a" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("latest returns the newest per repo, honours ?repo= and scope", async () => {
    await service.record(input({ commitSha: "old" }));
    await service.record(
      input({ commitSha: "new", measuredAt: "2026-11-29T06:00:00.000Z" }),
    );
    await service.record(input({ repo: "org/b", commitSha: "b1" }));
    await service.record(input({ accountId: "acct-b", commitSha: "other" }));

    const scope = { repos: [REPO, "org/b"], accountId: "acct-a" };
    const all = await service.latest(scope);
    expect(all.map((s) => [s.repo, s.commitSha])).toEqual([
      [REPO, "new"],
      ["org/b", "b1"],
    ]);
    const one = await service.latest(scope, REPO);
    expect(one.map((s) => s.commitSha)).toEqual(["new"]);
    await expect(service.latest(scope, "org/secret")).rejects.toThrow(
      ForbiddenError,
    );
  });
});
