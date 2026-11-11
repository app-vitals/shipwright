/**
 * task-store/src/reconcile-open-work.integration.test.ts
 * Drives the admin's task-store OpenWorkPort (GHE-3.6) against the real
 * task-store app in-process: list/block touch only the agent's open work on
 * the given repos. Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; skips
 * otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTaskStoreOpenWorkPort } from "@shipwright/admin/coding/reconcile-open-work";
import { createTaskStoreApp } from "./app.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";
const REMOVED = "org/removed";
const KEPT = "org/kept";
const REASON = `repo removed from agent by GitHub reconcile (${REMOVED})`;

describeOrSkip("reconcile open-work port (integration)", () => {
  let prisma: PrismaClient;
  let port: ReturnType<typeof createTaskStoreOpenWorkPort>;

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
    const app = createTaskStoreApp({
      taskService: new TaskService(prisma),
      tokenService,
      sessionService: new SessionService(prisma),
      pullRequestService: new PullRequestService(prisma),
    });
    port = createTaskStoreOpenWorkPort({
      url: "http://task-store.test",
      adminToken,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        return app.request(`${url.pathname}${url.search}`, init);
      },
    });

    const task = (
      id: string,
      status: "pending" | "in_progress" | "pr_open" | "approved" | "done",
      extra: { repo?: string; assignee?: string; claimedBy?: string } = {},
    ) =>
      prisma.task.create({
        data: {
          id,
          title: id,
          status,
          repo: extra.repo ?? REMOVED,
          assignee: extra.assignee ?? AGENT,
          claimedBy: extra.claimedBy ?? null,
        },
      });
    await task("T-pending", "pending");
    await task("T-claimed", "in_progress", {
      assignee: OTHER_AGENT,
      claimedBy: AGENT,
    });
    await task("T-pr-open", "pr_open");
    await task("T-done", "done");
    await task("T-kept-repo", "pending", { repo: KEPT });
    await task("T-other-agent", "pending", { assignee: OTHER_AGENT });
    await prisma.task.create({
      data: {
        id: "T-already-blocked",
        title: "T-already-blocked",
        status: "blocked",
        blockedReason: "original",
        repo: REMOVED,
        assignee: AGENT,
      },
    });

    const pr = (
      repo: string,
      prNumber: number,
      extra: {
        state?: "open" | "merged";
        agentId?: string;
        blocked?: boolean;
      } = {},
    ) =>
      prisma.pullRequest.create({
        data: {
          repo,
          prNumber,
          state: extra.state ?? "open",
          agentId: extra.agentId ?? AGENT,
          blocked: extra.blocked ?? false,
        },
      });
    await pr(REMOVED, 1);
    await pr(REMOVED, 2, { state: "merged" });
    await pr(KEPT, 3);
    await pr(REMOVED, 4, { agentId: OTHER_AGENT });
    await pr(REMOVED, 5, { blocked: true });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("lists only the agent's open tasks and PRs on the given repos", async () => {
    const items = await port.listOpenWork(AGENT, [REMOVED]);
    expect(
      items
        .map((i) => i.id)
        .filter((id) => id.startsWith("T-"))
        .sort(),
    ).toEqual(["T-claimed", "T-pending", "T-pr-open"]);
    const prs = items.filter((i) => !i.id.startsWith("T-"));
    expect(prs).toHaveLength(1);
    expect(prs[0]?.repo).toBe(REMOVED);
    expect(items.every((i) => i.repo === REMOVED)).toBe(true);
  });

  it("lists nothing for an empty repo list", async () => {
    expect(await port.listOpenWork(AGENT, [])).toEqual([]);
  });

  it("blocks open work with the reason and touches nothing else", async () => {
    await port.blockOpenWork(AGENT, [REMOVED], REASON);

    const blockedTasks = await prisma.task.findMany({
      where: { status: "blocked" },
      orderBy: { id: "asc" },
    });
    expect(blockedTasks.map((t) => [t.id, t.blockedReason])).toEqual([
      ["T-already-blocked", "original"],
      ["T-claimed", REASON],
      ["T-pending", REASON],
      ["T-pr-open", REASON],
    ]);
    const untouched = await prisma.task.findMany({
      where: { id: { in: ["T-done", "T-kept-repo", "T-other-agent"] } },
    });
    expect(untouched.map((t) => t.status).sort()).toEqual([
      "done",
      "pending",
      "pending",
    ]);

    const prs = await prisma.pullRequest.findMany({
      orderBy: { prNumber: "asc" },
    });
    expect(prs.map((p) => [p.prNumber, p.blocked, p.blockedReason])).toEqual([
      [1, true, REASON],
      [2, false, null],
      [3, false, null],
      [4, false, null],
      [5, true, null],
    ]);
  });
});
