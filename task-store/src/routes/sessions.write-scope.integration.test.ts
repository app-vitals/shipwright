/**
 * task-store/src/routes/sessions.write-scope.integration.test.ts
 *
 * Integration tests (real Postgres) for PWE-1.1: PATCH /sessions/:slug follows
 * task-store scope instead of being admin-only. Requires
 * DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; skips otherwise.
 *
 * Matrix: admin unrestricted; agent with every session repo (task repos +
 * document repos) in scope may write; invisible / other-account session is
 * 404; visible but partly in scope is 403; zero-repo session is 403.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { TaskStoreAuthEnv } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { createPrismaClient, type PrismaClient } from "../prisma-client.ts";
import { SessionService } from "../session-service.ts";
import { createSessionsRoutes } from "./sessions.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

describeOrSkip("PATCH /sessions/:slug write scope (integration)", () => {
  let prisma: PrismaClient;
  let sessions: SessionService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    sessions = new SessionService(prisma);
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.planDocument.deleteMany();
    await prisma.session.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  function appFor(
    agentId: string | null,
    repos: string[] | null,
    accountId: string | null = agentId === null ? null : "default",
  ) {
    const parent = new OpenAPIHono<TaskStoreAuthEnv>();
    parent.use("*", async (c, next) => {
      c.set("agentId", agentId);
      c.set("repos", repos);
      c.set("accountId", accountId);
      c.set("scopeDegraded", false);
      await next();
    });
    parent.onError((err, c) => {
      if (err instanceof ApiError) {
        return c.json({ error: err.message }, err.statusCode as 400);
      }
      return c.json({ error: "internal error" }, 500);
    });
    parent.route("/", createSessionsRoutes(sessions));
    return parent;
  }

  const patch = (
    app: ReturnType<typeof appFor>,
    slug: string,
    body: unknown,
    query = "",
  ) =>
    app.request(`/${slug}${query}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  async function seed(
    slug: string,
    opts: {
      accountId?: string;
      taskRepos?: { repo: string; assignee?: string }[];
      docRepo?: { repo: string; repos?: string[] };
    } = {},
  ) {
    const accountId = opts.accountId ?? "default";
    await prisma.session.create({ data: { slug, accountId } });
    let i = 0;
    for (const t of opts.taskRepos ?? []) {
      await prisma.task.create({
        data: {
          id: `${accountId}-${slug}-${i++}`,
          title: "t",
          status: "pending",
          session: slug,
          repo: t.repo,
          assignee: t.assignee ?? null,
          accountId,
        },
      });
    }
    if (opts.docRepo) {
      await prisma.planDocument.create({
        data: {
          accountId,
          session: slug,
          kind: "spec",
          number: 1,
          repo: opts.docRepo.repo,
          repos: opts.docRepo.repos ?? [],
          path: `planning/${slug}/SPEC-0001.md`,
        },
      });
    }
  }

  const row = (slug: string, accountId = "default") =>
    prisma.session.findUnique({
      where: { accountId_slug: { accountId, slug } },
    });

  it("agent with every task repo in scope can patch; archivedBy records the agent", async () => {
    await seed("s", { taskRepos: [{ repo: "org/a" }, { repo: "org/b" }] });
    const res = await patch(
      appFor("agent-1", ["org/a", "org/b", "org/c"]),
      "s",
      {
        title: "renamed",
        archived: true,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; archivedBy: string };
    expect(body.title).toBe("renamed");
    expect(body.archivedBy).toBe("agent-1");
    expect((await row("s"))?.archivedBy).toBe("agent-1");
  });

  it("document repos (home and target) count toward the session's repos", async () => {
    await seed("s", {
      taskRepos: [{ repo: "org/a" }],
      docRepo: { repo: "org/docs", repos: ["org/a"] },
    });
    const partial = await patch(appFor("agent-1", ["org/a"]), "s", {
      title: "x",
    });
    expect(partial.status).toBe(403);
    expect((await row("s"))?.title).toBeNull();

    const full = await patch(appFor("agent-1", ["org/a", "org/docs"]), "s", {
      title: "x",
    });
    expect(full.status).toBe(200);
  });

  it("visible but only partly in scope is 403 and writes nothing", async () => {
    await seed("s", { taskRepos: [{ repo: "org/a" }, { repo: "org/b" }] });
    const res = await patch(appFor("agent-1", ["org/a"]), "s", {
      archived: true,
    });
    expect(res.status).toBe(403);
    expect((await row("s"))?.archivedAt).toBeNull();
  });

  it("applies to owner and homeRepo too", async () => {
    await seed("s", { taskRepos: [{ repo: "org/a" }] });
    const ok = await patch(appFor("agent-1", ["org/a"]), "s", {
      owner: "a@example.com",
      homeRepo: "org/a",
    });
    expect(ok.status).toBe(200);
    await seed("t", { taskRepos: [{ repo: "org/a" }, { repo: "org/b" }] });
    const denied = await patch(appFor("agent-1", ["org/a"]), "t", {
      owner: "a@example.com",
    });
    expect(denied.status).toBe(403);
  });

  it("a stale `repos` key in the PATCH body is ignored, not rejected; session repos derive from tasks and documents only", async () => {
    await seed("s", {
      taskRepos: [{ repo: "org/a" }],
      docRepo: { repo: "org/docs", repos: ["org/a"] },
    });
    const app = appFor(null, null);
    const res = await patch(app, "s", {
      title: "kept",
      repos: ["org/ghost", "org/secret"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; repos: string[] };
    expect(body.title).toBe("kept");
    expect(body.repos).toEqual(["org/a"]);
    expect(body.repos).not.toContain("org/ghost");

    const got = await sessions.get("s");
    expect(got?.repos).toEqual(["org/a"]);
    expect(got?.documents.map((d) => d.repo)).toEqual(["org/docs"]);

    // Even an out-of-scope `repos` value is no longer a 403 for an agent.
    const agent = await patch(appFor("agent-1", ["org/a", "org/docs"]), "s", {
      repos: ["org/secret"],
    });
    expect(agent.status).toBe(200);
  });

  it("a session the agent cannot see is 404, not 403 (no existence leak)", async () => {
    await seed("s", { taskRepos: [{ repo: "org/other" }] });
    const res = await patch(appFor("agent-1", ["org/a"]), "s", { title: "x" });
    expect(res.status).toBe(404);
    const missing = await patch(appFor("agent-1", ["org/a"]), "nope", {
      title: "x",
    });
    expect(missing.status).toBe(404);
    expect((await row("s"))?.title).toBeNull();
  });

  it("a session in another account is 404 for an agent, and untouched", async () => {
    await seed("s", {
      accountId: "acct-b",
      taskRepos: [{ repo: "org/a" }],
    });
    const res = await patch(appFor("agent-1", ["org/a"]), "s", { title: "x" });
    expect(res.status).toBe(404);
    expect((await row("s", "acct-b"))?.title).toBeNull();
  });

  it("an agent's client-supplied ?accountId= cannot reach another account", async () => {
    await seed("s", { accountId: "acct-b", taskRepos: [{ repo: "org/a" }] });
    const res = await patch(
      appFor("agent-1", ["org/a"]),
      "s",
      { title: "x" },
      "?accountId=acct-b",
    );
    expect(res.status).toBe(404);
    expect((await row("s", "acct-b"))?.title).toBeNull();
  });

  it("same slug in two accounts: only the caller's account row changes", async () => {
    await seed("s", { accountId: "default", taskRepos: [{ repo: "org/a" }] });
    await seed("s", { accountId: "acct-b", taskRepos: [{ repo: "org/a" }] });
    const res = await patch(appFor("agent-1", ["org/a"]), "s", { title: "x" });
    expect(res.status).toBe(200);
    expect((await row("s"))?.title).toBe("x");
    expect((await row("s", "acct-b"))?.title).toBeNull();
  });

  it("a visible zero-repo session is 403 for an agent", async () => {
    // Visible via an assigned task with no repo.
    await prisma.session.create({ data: { slug: "s", accountId: "default" } });
    await prisma.task.create({
      data: {
        id: "t0",
        title: "t",
        status: "pending",
        session: "s",
        repo: null,
        assignee: "agent-1",
      },
    });
    const res = await patch(appFor("agent-1", ["org/a"]), "s", { title: "x" });
    expect(res.status).toBe(403);
    expect((await row("s"))?.title).toBeNull();
  });

  it("an assignee-visible session with an out-of-scope repo is 403", async () => {
    await seed("s", { taskRepos: [{ repo: "org/z", assignee: "agent-1" }] });
    const res = await patch(appFor("agent-1", []), "s", { title: "x" });
    expect(res.status).toBe(403);
  });

  it("admin is unrestricted, including zero-repo sessions; archivedBy is 'admin'", async () => {
    await seed("s", { taskRepos: [{ repo: "org/a" }, { repo: "org/b" }] });
    await seed("empty");
    const res = await patch(appFor(null, null), "s", { archived: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedBy: string }).archivedBy).toBe(
      "admin",
    );
    const empty = await patch(appFor(null, null), "empty", { title: "e" });
    expect(empty.status).toBe(200);
  });

  it("admin ?accountId= addresses that account", async () => {
    await seed("s", { accountId: "acct-b", taskRepos: [{ repo: "org/a" }] });
    const res = await patch(
      appFor(null, null),
      "s",
      { title: "x" },
      "?accountId=acct-b",
    );
    expect(res.status).toBe(200);
    expect((await row("s", "acct-b"))?.title).toBe("x");
    const noQuery = await patch(appFor(null, null), "s", { title: "y" });
    expect(noQuery.status).toBe(404);
  });
});
