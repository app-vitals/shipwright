/**
 * task-store/src/pull-request-account-scope.integration.test.ts
 *
 * SSP-6.6: PullRequest reads/writes are scoped by accountId. Covers, against
 * a real Postgres DB:
 *   - claimNext() never returns another account's PR, even for an identical
 *     repo string
 *   - GET /prs filters by the caller's account; admin sees both
 *   - GET/PATCH /prs/:id for another account's PR → 404; admin sees both
 *   - POST /prs/claim-next via an account-scoped agent token is isolated
 *   - the stale-claim reaper releases stale claims in every account and
 *     leaves fresh claims (in any account) untouched
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { SessionService } from "./session-service.ts";
import { StaleClaimReaper } from "./stale-claim-reaper.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const REPO = "org/repo";
const ACCOUNT_A = "acct-a";
const ACCOUNT_B = "acct-b";

function makePrisma(): PrismaClient {
  return createPrismaClient(TEST_DB as string);
}

async function resetTables(prisma: PrismaClient): Promise<void> {
  await prisma.pullRequestEvent.deleteMany();
  await prisma.prFinding.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.taskEvent.deleteMany();
  await prisma.task.deleteMany();
}

function openPr(accountId: string, prNumber: number, extra = {}) {
  return {
    accountId,
    repo: REPO,
    prNumber,
    state: "open" as const,
    reviewState: "pending" as const,
    ...extra,
  };
}

describeOrSkip("PullRequest account scoping (integration)", () => {
  let prisma: PrismaClient;
  let service: PullRequestService;
  let app: ReturnType<typeof createTaskStoreApp>;
  let adminToken: string;
  let agentToken: string;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.taskToken.deleteMany();
    await resetTables(prisma);
    service = new PullRequestService(prisma);

    const tokenService = new TaskTokenService(prisma);
    adminToken = (await tokenService.create("admin")).rawToken;
    agentToken = (await tokenService.create("agent", "agent-1")).rawToken;
    app = createTaskStoreApp({
      taskService: new TaskService(prisma),
      tokenService,
      pullRequestService: service,
      sessionService: new SessionService(prisma),
      scopeResolver: async () => ({ repos: [REPO], accountId: ACCOUNT_A }),
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function req(path: string, token: string, init: RequestInit = {}) {
    return app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  }

  it("claimNext() scoped to account A never returns account B's PR for the same repo", async () => {
    await prisma.pullRequest.create({ data: openPr(ACCOUNT_B, 1) });
    expect(await service.claimNext("agent-a", 5, [REPO], ACCOUNT_A)).toBeNull();

    const a = await prisma.pullRequest.create({ data: openPr(ACCOUNT_A, 2) });
    const result = await service.claimNext("agent-a", 5, [REPO], ACCOUNT_A);
    expect(result?.pr.id).toBe(a.id);

    const b = await prisma.pullRequest.findFirst({
      where: { accountId: ACCOUNT_B },
    });
    expect(b?.claimedBy).toBeNull();
  });

  it("claimNext() without an account scope (admin) can claim any account's PR", async () => {
    await prisma.pullRequest.create({ data: openPr(ACCOUNT_B, 1) });
    const result = await service.claimNext("admin-agent", 5);
    expect(result?.pr.accountId).toBe(ACCOUNT_B);
  });

  it("POST /prs/claim-next with an account-A agent token skips account B's older PR", async () => {
    await prisma.pullRequest.create({ data: openPr(ACCOUNT_B, 1) });
    const a = await prisma.pullRequest.create({ data: openPr(ACCOUNT_A, 2) });
    const res = await req("/prs/claim-next", agentToken, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pr: { id: string } };
    expect(body.pr.id).toBe(a.id);
  });

  it("GET /prs returns only the caller's account; admin sees both", async () => {
    await prisma.pullRequest.create({ data: openPr(ACCOUNT_A, 1) });
    await prisma.pullRequest.create({ data: openPr(ACCOUNT_B, 2) });

    const agentRes = await req("/prs", agentToken);
    const agentBody = (await agentRes.json()) as {
      prs: { accountId: string }[];
      total: number;
    };
    expect(agentBody.total).toBe(1);
    expect(agentBody.prs[0]?.accountId).toBe(ACCOUNT_A);

    const adminRes = await req("/prs", adminToken);
    expect(((await adminRes.json()) as { total: number }).total).toBe(2);
  });

  it("GET /prs/:id and PATCH /prs/:id 404 for another account's PR; admin sees both", async () => {
    const a = await prisma.pullRequest.create({ data: openPr(ACCOUNT_A, 1) });
    const b = await prisma.pullRequest.create({ data: openPr(ACCOUNT_B, 2) });

    expect((await req(`/prs/${a.id}`, agentToken)).status).toBe(200);
    expect((await req(`/prs/${b.id}`, agentToken)).status).toBe(404);
    const patch = await req(`/prs/${b.id}`, agentToken, {
      method: "PATCH",
      body: JSON.stringify({ staged: true }),
    });
    expect(patch.status).toBe(404);
    expect(
      (await prisma.pullRequest.findUnique({ where: { id: b.id } }))?.staged,
    ).toBe(false);

    expect((await req(`/prs/${a.id}`, adminToken)).status).toBe(200);
    expect((await req(`/prs/${b.id}`, adminToken)).status).toBe(200);
  });

  it("stale-claim reaper releases stale claims across accounts and leaves fresh ones alone", async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 3 * 60 * 60_000).toISOString();
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    const claimed = (accountId: string, n: number, at: string) =>
      openPr(accountId, n, {
        reviewState: "in_progress",
        phase: "review",
        claimedBy: "agent-x",
        claimedAt: at,
        heartbeatAt: at,
      });
    await prisma.pullRequest.createMany({
      data: [
        claimed(ACCOUNT_A, 1, stale),
        claimed(ACCOUNT_B, 2, stale),
        claimed(ACCOUNT_A, 3, fresh),
        claimed(ACCOUNT_B, 4, fresh),
      ],
    });

    await new StaleClaimReaper(prisma).reap();

    const rows = await prisma.pullRequest.findMany({
      orderBy: { prNumber: "asc" },
    });
    expect(rows.map((r) => [r.accountId, r.claimedBy])).toEqual([
      [ACCOUNT_A, null],
      [ACCOUNT_B, null],
      [ACCOUNT_A, "agent-x"],
      [ACCOUNT_B, "agent-x"],
    ]);
    // Reaping never moves a row between accounts.
    expect(rows.map((r) => r.accountId)).toEqual([
      ACCOUNT_A,
      ACCOUNT_B,
      ACCOUNT_A,
      ACCOUNT_B,
    ]);
  });
});
