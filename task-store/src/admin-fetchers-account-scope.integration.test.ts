/**
 * task-store/src/admin-fetchers-account-scope.integration.test.ts
 *
 * SSP-6.8 — end-to-end isolation for the admin UI's task-store fetchers
 * (admin/src/task-store-fetchers.ts): the real fetchers, holding the single
 * admin token, driven against the real task-store app and a real Postgres DB
 * for one two-account scenario. The fetchers' injected `fetch` routes each
 * request into `app.request()` in-process (no socket, no global override).
 *
 * Lives here rather than under admin/ because this package owns the
 * task-store app, its Prisma client and the test DB wiring; the fetcher
 * module is dependency-free, so the relative import pulls in nothing else.
 * That import reaches outside this package's `rootDir`, so the file is
 * type-checked by its own tsconfig.cross-package.json (same pattern as
 * admin/tsconfig.type-parity.json) and excluded from tsconfig.json.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DEFAULT_ACCOUNT_ID } from "@shipwright/lib/default-account";
import { createTaskStoreFetchers } from "../../admin/src/task-store-fetchers.ts";
import { createTaskStoreApp } from "./app.ts";
import { type PrismaClient, createPrismaClient } from "./prisma-client.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const ACCT_A = "acct-a";
const ACCT_B = "acct-b";
// Both accounts reuse the same repo and session slug: only accountId differs.
const REPO = "org/shared";
const SLUG = "shared-session";

describeOrSkip(
  "admin task-store fetchers — account isolation (integration)",
  () => {
    let prisma: PrismaClient;
    let fetchers: ReturnType<typeof createTaskStoreFetchers>;

    beforeEach(async () => {
      prisma = createPrismaClient(TEST_DB as string);
      await prisma.verificationCheck.deleteMany();
      await prisma.pullRequestEvent.deleteMany();
      await prisma.prFinding.deleteMany();
      await prisma.pullRequest.deleteMany();
      await prisma.taskToken.deleteMany();
      await prisma.taskEvent.deleteMany();
      await prisma.task.deleteMany();
      await prisma.session.deleteMany();

      const tokenService = new TaskTokenService(prisma);
      const adminToken = (await tokenService.create("admin")).rawToken;
      const sessionService = new SessionService(prisma);
      const app = createTaskStoreApp({
        taskService: new TaskService(prisma),
        tokenService,
        sessionService,
        pullRequestService: new PullRequestService(prisma),
      });
      fetchers = createTaskStoreFetchers({
        url: "http://task-store.test",
        adminToken,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          return app.request(`${url.pathname}${url.search}`, init);
        },
      });

      for (const [id, accountId] of [
        ["A-1", ACCT_A],
        ["B-1", ACCT_B],
        ["D-1", DEFAULT_ACCOUNT_ID],
      ] as const) {
        await prisma.task.create({
          data: {
            id,
            title: id,
            status: "pending",
            repo: REPO,
            session: SLUG,
            accountId,
          },
        });
        await prisma.session.create({ data: { slug: SLUG, accountId } });
      }
      await prisma.pullRequest.create({
        data: { repo: REPO, prNumber: 1, accountId: ACCT_A },
      });
      await prisma.pullRequest.create({
        data: { repo: REPO, prNumber: 1, accountId: ACCT_B },
      });
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    it("lists only the requested account's tasks; no accountId lists every account", async () => {
      const a = await fetchers.fetchTaskStoreTasks<{ tasks: { id: string }[] }>(
        new URLSearchParams(),
        ACCT_A,
      );
      expect(a.tasks.map((t) => t.id)).toEqual(["A-1"]);

      const all = await fetchers.fetchTaskStoreTasks<{
        tasks: { id: string }[];
      }>(new URLSearchParams());
      expect(all.tasks.map((t) => t.id).sort()).toEqual(["A-1", "B-1", "D-1"]);
    });

    it("another account's task id reads and releases as not found", async () => {
      expect(await fetchers.fetchTaskStoreTask("B-1", ACCT_A)).toBeNull();
      expect(
        await fetchers.fetchTaskStoreTask<{ id: string }>("A-1", ACCT_A),
      ).toMatchObject({ id: "A-1" });
      await expect(fetchers.releaseTask("B-1", ACCT_A)).rejects.toThrow("404");
    });

    it("scopes PR lists and by-id reads to the account", async () => {
      const a = await fetchers.fetchTaskStorePrs<{
        prs: { id: string; accountId: string }[];
      }>(new URLSearchParams({ repo: REPO, prNumber: "1" }), ACCT_A);
      expect(a.prs.map((p) => p.accountId)).toEqual([ACCT_A]);

      const b = await fetchers.fetchTaskStorePrs<{ prs: { id: string }[] }>(
        new URLSearchParams(),
        ACCT_B,
      );
      const bId = b.prs[0]?.id as string;
      expect(await fetchers.fetchTaskStorePrById(bId, ACCT_A)).toBeNull();
      expect(
        await fetchers.fetchTaskStorePrById<{ id: string }>(bId, ACCT_B),
      ).toMatchObject({ id: bId });
    });

    it("scopes sessions, and a session patch never crosses accounts", async () => {
      const a = await fetchers.fetchTaskStoreSessions<{
        sessions: { accountId: string }[];
      }>(new URLSearchParams({ state: "all" }), ACCT_A);
      expect(a.sessions.map((s) => s.accountId)).toEqual([ACCT_A]);

      const all = await fetchers.fetchTaskStoreSessions<{
        sessions: { accountId: string }[];
      }>(new URLSearchParams({ state: "all" }));
      expect(all.sessions.map((s) => s.accountId).sort()).toEqual(
        [ACCT_A, ACCT_B, DEFAULT_ACCOUNT_ID].sort(),
      );

      await fetchers.patchTaskStoreSession(
        SLUG,
        { title: "A renamed" },
        ACCT_A,
      );
      const rows = await prisma.session.findMany({
        orderBy: { accountId: "asc" },
      });
      expect(
        Object.fromEntries(rows.map((r) => [r.accountId, r.title ?? null])),
      ).toEqual({
        [ACCT_A]: "A renamed",
        [ACCT_B]: null,
        [DEFAULT_ACCOUNT_ID]: null,
      });
    });

    it("distinct values are scoped to the account", async () => {
      await prisma.task.create({
        data: {
          id: "B-2",
          title: "B-2",
          status: "pending",
          repo: "org/b-only",
          accountId: ACCT_B,
        },
      });
      expect((await fetchers.fetchDistinctTaskValues(ACCT_A)).repos).toEqual([
        REPO,
      ]);
      expect(
        (await fetchers.fetchDistinctTaskValues(ACCT_B)).repos.sort(),
      ).toEqual(["org/b-only", REPO].sort());
    });
  },
);
