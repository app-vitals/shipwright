/**
 * task-store/src/verification-check-service.integration.test.ts
 *
 * Integration tests (real Postgres) for VerificationCheckService repo/account
 * scoping (SSP-6.10): the parent existence checks and the repo+checkName
 * history read must not leak or accept rows across repos or accounts.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import {
  type VerificationCheckScope,
  VerificationCheckService,
} from "./verification-check-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

const REPO_A = "app-vitals/shipwright";
const REPO_B = "other-org/other-repo";

const scopeA: VerificationCheckScope = { repos: [REPO_A], accountId: "acct-a" };

describeOrSkip("VerificationCheckService scoping (integration)", () => {
  let prisma: PrismaClient;
  let service: VerificationCheckService;
  let taskA: string;
  let taskOtherRepo: string;
  let taskOtherAccount: string;
  let prA: string;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    service = new VerificationCheckService(prisma);
    await prisma.verificationCheck.deleteMany();
    await prisma.taskEvent.deleteMany();
    await prisma.pullRequestEvent.deleteMany();
    await prisma.prFinding.deleteMany();
    await prisma.pullRequest.deleteMany();
    await prisma.task.deleteMany();

    taskA = (
      await prisma.task.create({
        data: {
          title: "a",
          status: "pending",
          repo: REPO_A,
          accountId: "acct-a",
        },
      })
    ).id;
    taskOtherRepo = (
      await prisma.task.create({
        data: {
          title: "b",
          status: "pending",
          repo: REPO_B,
          accountId: "acct-a",
        },
      })
    ).id;
    taskOtherAccount = (
      await prisma.task.create({
        data: {
          title: "c",
          status: "pending",
          repo: REPO_A,
          accountId: "acct-b",
        },
      })
    ).id;
    prA = (
      await prisma.pullRequest.create({
        data: { repo: REPO_A, prNumber: 6100, accountId: "acct-a" },
      })
    ).id;
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  const base = {
    repo: REPO_A,
    checkName: "unit",
    status: "ran_passed" as const,
  };

  it("record() stamps the parent's accountId and persists in scope", async () => {
    const task = await service.record({ ...base, taskId: taskA }, scopeA);
    expect(task.accountId).toBe("acct-a");
    const pr = await service.record({ ...base, prId: prA }, scopeA);
    expect(pr.accountId).toBe("acct-a");
  });

  it("record() rejects an out-of-scope repo (403) and out-of-scope parents (404) without writing", async () => {
    await expect(
      service.record({ ...base, repo: REPO_B, taskId: taskA }, scopeA),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.record({ ...base, taskId: taskOtherRepo }, scopeA),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.record({ ...base, taskId: taskOtherAccount }, scopeA),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await prisma.verificationCheck.count()).toBe(0);
  });

  it("listForTask()/listForPr() 404 for out-of-scope parents", async () => {
    await expect(
      service.listForTask(taskOtherRepo, {}, scopeA),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.listForTask(taskOtherAccount, {}, scopeA),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.listForPr(prA, {}, { repos: [], accountId: "acct-a" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.listForPr(prA, {}, { repos: [REPO_A], accountId: "acct-b" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listByRepoAndCheck() only returns the caller's account and in-scope repos", async () => {
    // Unscoped (admin) writes land in each parent's own account.
    await service.record({ ...base, taskId: taskA });
    await service.record({ ...base, taskId: taskOtherAccount });
    await service.record({ ...base, repo: REPO_B, taskId: taskOtherRepo });

    const mine = await service.listByRepoAndCheck(REPO_A, "unit", {}, scopeA);
    expect(mine.total).toBe(1);
    expect(mine.checks[0]?.taskId).toBe(taskA);

    const outOfScopeRepo = await service.listByRepoAndCheck(
      REPO_B,
      "unit",
      {},
      scopeA,
    );
    expect(outOfScopeRepo).toEqual({ checks: [], total: 0 });

    // Admin: unrestricted, optionally narrowed by account.
    const all = await service.listByRepoAndCheck(REPO_A, "unit");
    expect(all.total).toBe(2);
    const narrowed = await service.listByRepoAndCheck(
      REPO_A,
      "unit",
      {},
      { repos: null, accountId: "acct-b" },
    );
    expect(narrowed.checks.map((c) => c.taskId)).toEqual([taskOtherAccount]);
  });
});
