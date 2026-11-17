/**
 * task-store/src/session-planning.integration.test.ts
 *
 * Integration tests (real Postgres) for PLU-2.3: session owner / homeRepo /
 * declaredRepos, the `repos` union, the `owner` list filter, the session's
 * documents, and document-based scoped-token visibility.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DocumentService } from "./document-service.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";
import { SessionService } from "./session-service.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const ADMIN = { repos: null, accountId: null };
const OWNER = "a@example.com";

describeOrSkip("session planning fields and visibility (integration)", () => {
  let prisma: PrismaClient;
  let sessions: SessionService;
  let docs: DocumentService;
  let tasks: TaskService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    sessions = new SessionService(prisma);
    docs = new DocumentService(prisma);
    tasks = new TaskService(prisma);
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.planDocument.deleteMany();
    await prisma.session.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  async function registerSpec(
    session: string,
    repo: string,
    repos: string[] = [],
    owner?: string,
  ) {
    return docs.register(
      {
        session,
        kind: "spec",
        number: 1,
        repo,
        path: `planning/${session}/SPEC-0001.md`,
        repos,
        owner,
      },
      "default",
      ADMIN,
    );
  }

  it("a scoped token with a document's target repo in scope sees the task-less session (get and list)", async () => {
    await registerSpec("s1", "org/home", ["org/target"]);
    const scope = { agentId: "agent-x", repos: ["org/target"] };

    const got = await sessions.get("s1", scope);
    expect(got?.slug).toBe("s1");
    expect(got?.documents.map((d) => d.number)).toEqual([1]);

    const listed = await sessions.list({ agentScope: scope, state: "all" });
    expect(listed.sessions.map((s) => s.slug)).toEqual(["s1"]);
  });

  it("a scoped token with the document's home repo in scope sees the session", async () => {
    await registerSpec("s1", "org/home", ["org/target"]);
    const scope = { agentId: "agent-x", repos: ["org/home"] };
    expect((await sessions.get("s1", scope))?.slug).toBe("s1");
  });

  it("a scoped token with none of the document's repos in scope cannot see the session", async () => {
    await registerSpec("s1", "org/home", ["org/target"]);
    const scope = { agentId: "agent-x", repos: ["org/other"] };

    expect(await sessions.get("s1", scope)).toBeNull();
    const listed = await sessions.list({ agentScope: scope, state: "all" });
    expect(listed.sessions).toEqual([]);
  });

  it("a task-visible session only shows the token the documents it can see", async () => {
    await registerSpec("s1", "org/home", ["org/target"]);
    await docs.register(
      {
        session: "s1",
        kind: "plan",
        repo: "org/secret",
        path: "planning/s1/PLAN.md",
      },
      "default",
      ADMIN,
    );
    await tasks.create({
      title: "t",
      status: "pending",
      session: "s1",
      repo: "org/task-repo",
    });
    const scope = {
      agentId: "agent-x",
      repos: ["org/task-repo", "org/target"],
    };
    const got = await sessions.get("s1", scope);
    expect(got?.documents.map((d) => d.kind)).toEqual(["spec"]);
  });

  it("documents list: a scoped token sees a document through a target repo", async () => {
    await registerSpec("s1", "org/home", ["org/target"]);
    const viaTarget = await docs.list(
      {},
      { repos: ["org/target"], accountId: "default" },
    );
    expect(viaTarget.total).toBe(1);
    const none = await docs.list(
      {},
      { repos: ["org/other"], accountId: "default" },
    );
    expect(none.total).toBe(0);
  });

  it("repos is the union of task repos and declared repos, and repo/org filters apply to it", async () => {
    await tasks.create({
      title: "t",
      status: "pending",
      session: "s1",
      repo: "org/task-repo",
    });
    await sessions.update(
      "s1",
      { repos: ["org/declared", "org/task-repo", "other/x"] },
      "admin",
    );

    const got = await sessions.get("s1");
    expect([...(got?.repos ?? [])].sort()).toEqual([
      "org/declared",
      "org/task-repo",
      "other/x",
    ]);

    const byRepo = await sessions.list({ repo: "org/declared", state: "all" });
    expect(byRepo.sessions.map((s) => s.slug)).toEqual(["s1"]);
    const byOrg = await sessions.list({ org: "other", state: "all" });
    expect(byOrg.sessions.map((s) => s.slug)).toEqual(["s1"]);
    const miss = await sessions.list({ repo: "org/nope", state: "all" });
    expect(miss.sessions).toEqual([]);
  });

  it("owner filter returns only that owner's sessions", async () => {
    await registerSpec("mine", "org/home", [], OWNER);
    await registerSpec("theirs", "org/home", [], "b@example.com");
    await tasks.create({ title: "t", status: "pending", session: "nobody" });

    const res = await sessions.list({ owner: OWNER, state: "all" });
    expect(res.sessions.map((s) => s.slug)).toEqual(["mine"]);
    expect(res.sessions[0].owner).toBe(OWNER);
    expect(res.sessions[0].homeRepo).toBe("org/home");
  });

  it("update persists owner, homeRepo and repos (declaredRepos) and can clear owner/homeRepo", async () => {
    await tasks.create({ title: "t", status: "pending", session: "s1" });
    const updated = await sessions.update(
      "s1",
      { owner: OWNER, homeRepo: "org/home", repos: ["org/a", "org/a"] },
      "admin",
    );
    expect(updated.owner).toBe(OWNER);
    expect(updated.homeRepo).toBe("org/home");
    expect(updated.repos).toEqual(["org/a"]);
    const row = await prisma.session.findFirst({ where: { slug: "s1" } });
    expect(row?.declaredRepos).toEqual(["org/a"]);

    const cleared = await sessions.update(
      "s1",
      { owner: null, homeRepo: null },
      "admin",
    );
    expect(cleared.owner).toBeNull();
    expect(cleared.homeRepo).toBeNull();
    expect(cleared.repos).toEqual(["org/a"]);
  });

  it("sessions with no declared repos or documents keep their previous shape (empty documents)", async () => {
    await tasks.create({
      title: "t",
      status: "pending",
      session: "s1",
      repo: "org/r",
    });
    const got = await sessions.get("s1");
    expect(got?.repos).toEqual(["org/r"]);
    expect(got?.documents).toEqual([]);
    expect(got?.owner).toBeNull();
    expect(got?.homeRepo).toBeNull();
  });
});
