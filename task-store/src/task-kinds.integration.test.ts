/**
 * task-store/src/task-kinds.integration.test.ts
 *
 * INI-1.1 integration coverage against a real Postgres DB: `initiative` and
 * `idea` task kinds through create, ?kind= filtering, PATCH (promotion) and
 * the ready set.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTaskStoreApp } from "./app.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";
import { TaskTokenService } from "./token-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("initiative and idea task kinds (INI-1.1, integration)", () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createTaskStoreApp>;
  let rawToken: string;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await prisma.taskToken.deleteMany();
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();

    const tokenService = new TaskTokenService(prisma);
    rawToken = (await tokenService.create("ini-1-1")).rawToken;
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

  async function create(title: string, kind: string): Promise<string> {
    const res = await app.request("/tasks", {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ title, kind, status: "pending", repo: null }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; kind: string };
    expect(body.kind).toBe(kind);
    return body.id;
  }

  async function list(query: string): Promise<string[]> {
    const res = await app.request(`/tasks?${query}`, { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ title: string }> };
    return body.tasks.map((t) => t.title).sort();
  }

  it("creates and filters initiative and idea tasks by ?kind=", async () => {
    await create("an-initiative", "initiative");
    await create("an-idea", "idea");
    await create("dev-work", "dev");

    expect(await list("kind=initiative")).toEqual(["an-initiative"]);
    expect(await list("kind=idea")).toEqual(["an-idea"]);
    expect(await list("kind=dev")).toEqual(["dev-work"]);
  });

  it("rejects an unknown kind with 400", async () => {
    const res = await app.request("/tasks?kind=bogus", { headers: auth() });
    expect(res.status).toBe(400);
  });

  it("PATCH changes kind (promotion idea -> initiative -> dev)", async () => {
    const id = await create("promote-me", "idea");

    for (const kind of ["initiative", "dev"] as const) {
      const res = await app.request(`/tasks/${id}`, {
        method: "PATCH",
        headers: auth(),
        body: JSON.stringify({ kind }),
      });
      expect(res.status).toBe(200);
      const row = await prisma.task.findUnique({ where: { id } });
      expect(row?.kind).toBe(kind);
    }
  });

  it("never lists initiative or idea tasks as ready", async () => {
    await create("an-initiative", "initiative");
    await create("an-idea", "idea");
    await create("dev-work", "dev");

    expect(await list("ready=true")).toEqual(["dev-work"]);
    expect(await list("kind=initiative&ready=true")).toEqual([]);
    expect(await list("kind=idea&ready=true")).toEqual([]);
  });
});
