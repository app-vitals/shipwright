/**
 * task-store/src/released-merge-phase.integration.test.ts
 *
 * MPD-1.1 integration coverage against a real Postgres DB:
 *   - `released` is a valid TaskStatus end to end (POST/PATCH /tasks,
 *     ?status=released, ?state=closed, dependency satisfaction for ?ready=true)
 *   - PATCH /tasks/:id from `merged` to `released`/`deployed` writes the
 *     expected TaskEvent rows
 *   - PullRequestService.claim(phase=merge) stamps readyForMergeAt
 *   - claimNext()'s FIFO ordering ages PRs across all three ready-for-*
 *     timestamps (review, patch, merge; deploy was dropped in MPD-3.5)
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { FixedClock } from "./clock.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { PullRequestService } from "./pull-request-service.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  // TEST_DB is guaranteed set — the describe block is skipped otherwise.
  return createPrismaClient(TEST_DB as string);
}

const REPO = "app-vitals/shipwright";

describeOrSkip("released task status (MPD-1.1, integration)", () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createTaskStoreApp>;
  let rawToken: string;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.taskToken.deleteMany();
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();

    const tokenService = new TaskTokenService(prisma);
    const created = await tokenService.create("mpd-1-1");
    rawToken = created.rawToken;
    app = createTaskStoreApp({
      taskService: new TaskService(prisma),
      tokenService,
      sessionService: new SessionService(prisma),
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function auth(): Record<string, string> {
    return {
      Authorization: `Bearer ${rawToken}`,
      "content-type": "application/json",
    };
  }

  it("POST /tasks accepts status=released and persists releasedAt", async () => {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        title: "released-on-create",
        status: "released",
        repo: null,
        releasedAt: "2026-07-01T00:00:00.000Z",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      status: string;
      releasedAt: string | null;
    };
    expect(body.status).toBe("released");
    expect(body.releasedAt).toBe("2026-07-01T00:00:00.000Z");

    const row = await prisma.task.findUnique({ where: { id: body.id } });
    expect(row?.status).toBe("released");
    expect(row?.releasedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("GET /tasks?status=released and ?state=closed both include released tasks", async () => {
    await prisma.task.create({
      data: { title: "released-task", status: "released" },
    });
    await prisma.task.create({
      data: { title: "open-task", status: "pending" },
    });

    const byStatus = await app.request("/tasks?status=released", {
      headers: auth(),
    });
    expect(byStatus.status).toBe(200);
    const statusBody = (await byStatus.json()) as {
      tasks: Array<{ title: string }>;
    };
    expect(statusBody.tasks.map((t) => t.title)).toEqual(["released-task"]);

    const closed = await app.request("/tasks?state=closed", {
      headers: auth(),
    });
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as {
      tasks: Array<{ title: string }>;
    };
    const closedTitles = closedBody.tasks.map((t) => t.title);
    expect(closedTitles).toContain("released-task");
    expect(closedTitles).not.toContain("open-task");

    const open = await app.request("/tasks?state=open", { headers: auth() });
    const openBody = (await open.json()) as {
      tasks: Array<{ title: string }>;
    };
    expect(openBody.tasks.map((t) => t.title)).not.toContain("released-task");
  });

  it("a pending task whose only dependency is released is ready", async () => {
    const dep = await prisma.task.create({
      data: { title: "dep", status: "released" },
    });
    const dependent = await prisma.task.create({
      data: { title: "dependent", status: "pending", dependencies: [dep.id] },
    });

    const res = await app.request("/tasks?ready=true", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string }> };
    expect(body.tasks.map((t) => t.id)).toContain(dependent.id);
  });

  it.each([
    ["released", "releasedAt"],
    ["deployed", "deployedAt"],
  ] as const)(
    "PATCH /tasks/:id {status:'%s', %s} from merged succeeds and writes TaskEvent rows",
    async (status, stampField) => {
      const task = await prisma.task.create({
        data: { title: `merged-to-${status}`, status: "merged" },
      });
      const stamp = "2026-07-02T00:00:00.000Z";

      const res = await app.request(`/tasks/${task.id}`, {
        method: "PATCH",
        headers: auth(),
        body: JSON.stringify({ status, [stampField]: stamp }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe(status);
      expect(body[stampField]).toBe(stamp);

      const events = await prisma.taskEvent.findMany({
        where: { taskId: task.id },
      });
      const byField = Object.fromEntries(events.map((e) => [e.field, e]));
      expect(Object.keys(byField).sort()).toEqual(
        ["status", stampField].sort(),
      );
      expect(byField.status.oldValue).toBe("merged");
      expect(byField.status.newValue).toBe(status);
      expect(byField[stampField].oldValue).toBeNull();
      expect(byField[stampField].newValue).toBe(stamp);
    },
  );
});

describeOrSkip("PR merge phase (MPD-1.1, integration)", () => {
  let prisma: PrismaClient;
  const now = new Date("2026-07-10T00:00:00.000Z");

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.pullRequestEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("claim(phase=merge) on an existing record sets phase=merge and stamps readyForMergeAt when null", async () => {
    const service = new PullRequestService(prisma, FixedClock(now));
    await prisma.pullRequest.create({
      data: {
        repo: REPO,
        prNumber: 1101,
        commitSha: "sha-merge",
        reviewState: "approved",
        claimedBy: null,
        readyForMergeAt: null,
      },
    });

    const result = await service.claim(
      REPO,
      1101,
      "sha-merge",
      "agent-m",
      "merge",
    );
    expect(result.status).toBe(200);
    expect(result.record.phase).toBe("merge");
    expect(result.record.claimedBy).toBe("agent-m");
    expect(result.record.reviewState).toBe("approved");
    expect(result.record.readyForMergeAt).toBe(now.toISOString());
  });

  it("claim(phase=merge) does not overwrite an existing readyForMergeAt", async () => {
    const service = new PullRequestService(prisma, FixedClock(now));
    const earlier = "2026-07-01T00:00:00.000Z";
    await prisma.pullRequest.create({
      data: {
        repo: REPO,
        prNumber: 1102,
        commitSha: "sha-merge-2",
        reviewState: "approved",
        readyForMergeAt: earlier,
      },
    });

    const result = await service.claim(
      REPO,
      1102,
      "sha-merge-2",
      "agent-m",
      "merge",
    );
    expect(result.record.readyForMergeAt).toBe(earlier);
  });

  it("claim(phase=merge) on a new record stamps readyForMergeAt", async () => {
    const service = new PullRequestService(prisma, FixedClock(now));
    const result = await service.claim(
      REPO,
      1103,
      "sha-merge-3",
      "agent-m",
      "merge",
    );
    expect(result.status).toBe(201);
    expect(result.record.phase).toBe("merge");
    expect(result.record.readyForMergeAt).toBe(now.toISOString());
  });

  it("claimNext() ages PRs FIFO across readyForReviewAt, readyForPatchAt and readyForMergeAt", async () => {
    const service = new PullRequestService(prisma, FixedClock(now));
    // Deliberately interleave the three timestamp columns so that a COALESCE
    // missing any one of them would produce a different order.
    await prisma.pullRequest.createMany({
      data: [
        {
          repo: REPO,
          prNumber: 1201,
          reviewState: "approved",
          readyForMergeAt: "2026-07-01T04:00:00.000Z",
        },
        {
          repo: REPO,
          prNumber: 1202,
          reviewState: "pending",
          readyForReviewAt: "2026-07-01T02:00:00.000Z",
        },
        {
          repo: REPO,
          prNumber: 1203,
          reviewState: "approved",
          readyForMergeAt: "2026-07-01T01:00:00.000Z",
        },
        {
          repo: REPO,
          prNumber: 1204,
          reviewState: "posted",
          readyForPatchAt: "2026-07-01T03:00:00.000Z",
        },
      ],
    });

    const order: number[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await service.claimNext("agent-fifo", 10);
      expect(result).not.toBeNull();
      order.push(result?.pr.prNumber as number);
    }
    expect(order).toEqual([1203, 1202, 1204, 1201]);
    expect(await service.claimNext("agent-fifo", 10)).toBeNull();
  });
});
