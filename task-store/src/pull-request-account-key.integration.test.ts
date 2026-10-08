/**
 * task-store/src/pull-request-account-key.integration.test.ts
 *
 * SSP-6.3: PullRequest callers use the [accountId, repo, prNumber] key and
 * stamp accountId on creation. Covers, against a real Postgres DB:
 *   - claim()/stampOrigin()/census() stamp the caller's accountId on create
 *     (DEFAULT_ACCOUNT_ID when omitted — the pre-multi-tenancy regression)
 *   - a concurrent CREATE-path claim race within one account still resolves
 *     via P2002 → ConflictError
 *   - a claim from another account never mutates this account's row
 *   - the non-key repo+prNumber lookups (claim's linked-task origin probe,
 *     getCensusCursor, lookupBlockedPrNumbers, list({blocked}) task join) only
 *     match rows in the same account
 *   - the HTTP routes stamp the account resolved from the caller's token
 *     (agent: resolved account; admin: ?accountId= or 'default')
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_ACCOUNT_ID } from "@shipwright/lib/default-account";
import { createTaskStoreApp } from "./app.ts";
import { ConflictError } from "./errors.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

const REPO = "org/repo";
const ACCOUNT_A = "acct-a";
const ACCOUNT_B = "acct-b";

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createPrismaClient(TEST_DB as string);
}

async function resetTables(prisma: PrismaClient): Promise<void> {
  // FKs are ON DELETE RESTRICT — clear children before parents.
  await prisma.pullRequestEvent.deleteMany();
  await prisma.prFinding.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.taskEvent.deleteMany();
  await prisma.task.deleteMany();
}

describeOrSkip(
  "PullRequestService accountId key + stamping (integration)",
  () => {
    let prisma: PrismaClient;
    let service: PullRequestService;

    beforeEach(async () => {
      prisma = makePrisma();
      service = new PullRequestService(prisma);
      await resetTables(prisma);
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    it("claim() stamps the supplied accountId on record creation", async () => {
      const { status, record } = await service.claim(
        REPO,
        12,
        "sha-1",
        "agent-a",
        "review",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ACCOUNT_A,
      );
      expect(status).toBe(201);
      expect(record.accountId).toBe(ACCOUNT_A);

      const row = await prisma.pullRequest.findUnique({
        where: {
          accountId_repo_prNumber: {
            accountId: ACCOUNT_A,
            repo: REPO,
            prNumber: 12,
          },
        },
      });
      expect(row?.claimedBy).toBe("agent-a");
    });

    it("claim() without an accountId stamps DEFAULT_ACCOUNT_ID and re-claims the same row (regression)", async () => {
      const first = await service.claim(REPO, 13, "sha-1", "agent-a");
      expect(first.status).toBe(201);
      expect(first.record.accountId).toBe(DEFAULT_ACCOUNT_ID);

      await service.release(first.record.id);
      const second = await service.claim(REPO, 13, "sha-2", "agent-b");
      expect(second.status).toBe(200);
      expect(second.record.id).toBe(first.record.id);
      expect(await prisma.pullRequest.count()).toBe(1);
    });

    it("concurrent CREATE-path claims in the same account: exactly one wins, the other gets ConflictError", async () => {
      const claimAs = (agent: string) =>
        service.claim(
          REPO,
          14,
          "sha-race",
          agent,
          "review",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          ACCOUNT_A,
        );

      const results = await Promise.allSettled([
        claimAs("agent-a"),
        claimAs("agent-b"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const loser = rejected[0];
      if (loser.status === "rejected") {
        expect(loser.reason).toBeInstanceOf(ConflictError);
      }

      const rows = await prisma.pullRequest.findMany({
        where: { repo: REPO, prNumber: 14 },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].accountId).toBe(ACCOUNT_A);
    });

    it("a claim from another account never mutates this account's row", async () => {
      const owned = await service.claim(
        REPO,
        15,
        "sha-a",
        "agent-a",
        "review",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ACCOUNT_A,
      );

      // Before SSP-6.4 drops the old [repo, prNumber] unique this surfaces as a
      // ConflictError (the old constraint rejects the second INSERT); after it,
      // account B gets its own row. Either way account A's row is untouched.
      await service
        .claim(
          REPO,
          15,
          "sha-b",
          "agent-b",
          "review",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          ACCOUNT_B,
        )
        .catch((err: unknown) => {
          expect(err).toBeInstanceOf(ConflictError);
        });

      const rowA = await prisma.pullRequest.findUnique({
        where: { id: owned.record.id },
      });
      expect(rowA?.accountId).toBe(ACCOUNT_A);
      expect(rowA?.claimedBy).toBe("agent-a");
      expect(rowA?.commitSha).toBe("sha-a");
    });

    it("claim()'s linked-task origin probe only matches a task in the same account", async () => {
      await prisma.task.create({
        data: {
          id: "SSP-T-1",
          accountId: ACCOUNT_B,
          title: "other tenant's task",
          status: "pr_open",
          repo: REPO,
          pr: 16,
        },
      });

      const { record } = await service.claim(
        REPO,
        16,
        "sha-1",
        "agent-a",
        "review",
        undefined,
        "octocat",
        "feature/x",
        "A human PR",
        false,
        false,
        false,
        ACCOUNT_A,
      );
      // The account-B task must not make account A's PR look agent-authored.
      expect(record.origin).toBe("human");
    });

    it("stampOrigin() stamps the supplied accountId on create and matches only that account", async () => {
      const created = await service.stampOrigin(
        REPO,
        17,
        { origin: "shipwright" },
        undefined,
        ACCOUNT_A,
      );
      expect(created.accountId).toBe(ACCOUNT_A);

      // A second stamp for the same account updates the same row.
      const again = await service.stampOrigin(
        REPO,
        17,
        { title: "t" },
        undefined,
        ACCOUNT_A,
      );
      expect(again.id).toBe(created.id);
      expect(again.title).toBe("t");
    });

    it("stampOrigin() without an accountId stamps DEFAULT_ACCOUNT_ID (regression)", async () => {
      const created = await service.stampOrigin(REPO, 18, { origin: "human" });
      expect(created.accountId).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("census() stamps the supplied accountId on every created row", async () => {
      const rows = await service.census(
        [
          { repo: REPO, prNumber: 19, origin: "human" },
          { repo: REPO, prNumber: 20, origin: "ci" },
        ],
        ACCOUNT_A,
      );
      expect(rows.map((r) => r.accountId)).toEqual([ACCOUNT_A, ACCOUNT_A]);
    });

    it("getCensusCursor() only considers rows in the requested account", async () => {
      await prisma.pullRequest.create({
        data: {
          accountId: ACCOUNT_B,
          repo: REPO,
          prNumber: 21,
          origin: "human",
          mergedAt: "2026-09-30T00:00:00.000Z",
        },
      });
      await prisma.pullRequest.create({
        data: {
          accountId: ACCOUNT_A,
          repo: "org/other",
          prNumber: 22,
          origin: "human",
          mergedAt: "2026-09-01T00:00:00.000Z",
        },
      });
      await prisma.pullRequest.create({
        data: {
          accountId: ACCOUNT_A,
          repo: REPO,
          prNumber: 23,
          origin: "human",
          mergedAt: "2026-09-10T00:00:00.000Z",
        },
      });

      expect(await service.getCensusCursor(REPO, ACCOUNT_A)).toBe(
        "2026-09-10T00:00:00.000Z",
      );
      expect(await service.getCensusCursor(REPO)).toBeNull();
    });

    it("lookupBlockedPrNumbers() ignores a blocked PR in another account", async () => {
      await prisma.pullRequest.create({
        data: { accountId: ACCOUNT_B, repo: REPO, prNumber: 24, blocked: true },
      });
      await prisma.pullRequest.create({
        data: { accountId: ACCOUNT_A, repo: REPO, prNumber: 25, blocked: true },
      });

      const result = await service.lookupBlockedPrNumbers([
        { accountId: ACCOUNT_A, repo: REPO, prNumber: 24 },
        { accountId: ACCOUNT_A, repo: REPO, prNumber: 25 },
      ]);
      expect([...result]).toEqual([25]);
    });

    it("list({ blocked: true }) only joins tasks from the PR's own account", async () => {
      await prisma.pullRequest.create({
        data: { accountId: ACCOUNT_A, repo: REPO, prNumber: 26 },
      });
      await prisma.task.create({
        data: {
          id: "SSP-T-2",
          accountId: ACCOUNT_B,
          title: "other tenant's blocked task",
          status: "blocked",
          repo: REPO,
          pr: 26,
        },
      });

      const result = await service.list({ blocked: true });
      expect(result.prs).toHaveLength(0);
    });
  },
);

describeOrSkip("PR routes stamp the caller's account (integration)", () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createTaskStoreApp>;
  let adminToken: string;
  let agentToken: string;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.taskToken.deleteMany();
    await resetTables(prisma);

    const tokenService = new TaskTokenService(prisma);
    adminToken = (await tokenService.create("admin")).rawToken;
    agentToken = (await tokenService.create("agent", "agent-1")).rawToken;

    app = createTaskStoreApp({
      taskService: new TaskService(prisma),
      tokenService,
      pullRequestService: new PullRequestService(prisma),
      sessionService: new SessionService(prisma),
      scopeResolver: async () => ({ repos: [REPO], accountId: ACCOUNT_A }),
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function post(path: string, token: string, body: unknown) {
    return app.request(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("POST /prs/claim with an agent token stamps the agent's resolved account", async () => {
    const res = await post("/prs/claim", agentToken, {
      repo: REPO,
      prNumber: 30,
      commitSha: "sha-1",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accountId: string };
    expect(body.accountId).toBe(ACCOUNT_A);
  });

  it("POST /prs/claim with an agent token ignores a client-supplied ?accountId=", async () => {
    const res = await post(`/prs/claim?accountId=${ACCOUNT_B}`, agentToken, {
      repo: REPO,
      prNumber: 31,
      commitSha: "sha-1",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accountId: string };
    expect(body.accountId).toBe(ACCOUNT_A);
  });

  it("POST /prs/claim with an admin token and ?accountId= stamps that account", async () => {
    const res = await post(`/prs/claim?accountId=${ACCOUNT_B}`, adminToken, {
      repo: REPO,
      prNumber: 32,
      commitSha: "sha-1",
      claimedBy: "admin-agent",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accountId: string };
    expect(body.accountId).toBe(ACCOUNT_B);
  });

  it("POST /prs/claim with an admin token and no ?accountId= stamps 'default'", async () => {
    const res = await post("/prs/claim", adminToken, {
      repo: REPO,
      prNumber: 33,
      commitSha: "sha-1",
      claimedBy: "admin-agent",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accountId: string };
    expect(body.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });

  it("POST /prs/census with an agent token stamps the agent's resolved account", async () => {
    const res = await post("/prs/census", agentToken, [
      { repo: REPO, prNumber: 34, origin: "human" },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prs: { accountId: string }[] };
    expect(body.prs.map((p) => p.accountId)).toEqual([ACCOUNT_A]);
  });

  it("GET /prs/census/cursor reads the caller's account only", async () => {
    await prisma.pullRequest.create({
      data: {
        accountId: DEFAULT_ACCOUNT_ID,
        repo: REPO,
        prNumber: 35,
        origin: "human",
        mergedAt: "2026-09-30T00:00:00.000Z",
      },
    });

    const res = await app.request(
      `/prs/census/cursor?repo=${encodeURIComponent(REPO)}`,
      { headers: { Authorization: `Bearer ${agentToken}` } },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cursor: string | null }).cursor).toBeNull();
  });
});

describeOrSkip("PullRequest unique key after dropping [repo, prNumber] (SSP-6.4)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await resetTables(prisma);
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("allows the same repo/prNumber under two different accountIds", async () => {
    await prisma.pullRequest.create({
      data: { accountId: ACCOUNT_A, repo: REPO, prNumber: 77 },
    });
    await prisma.pullRequest.create({
      data: { accountId: ACCOUNT_B, repo: REPO, prNumber: 77 },
    });

    expect(
      await prisma.pullRequest.count({ where: { repo: REPO, prNumber: 77 } }),
    ).toBe(2);
  });

  it("rejects the same repo/prNumber under the same accountId with P2002", async () => {
    await prisma.pullRequest.create({
      data: { accountId: ACCOUNT_A, repo: REPO, prNumber: 78 },
    });

    const attempt = (async () =>
      prisma.pullRequest.create({
        data: { accountId: ACCOUNT_A, repo: REPO, prNumber: 78 },
      }))();
    await expect(attempt).rejects.toMatchObject({ code: "P2002" });
  });
});
