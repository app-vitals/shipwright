/**
 * task-store/src/document-service.integration.test.ts
 *
 * Integration tests for DocumentService (PLU-2.2) against a real Postgres DB:
 * register idempotency, the planned filter, session ensure, the owner-first
 * rule, and repo-scope enforcement.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DocumentService } from "./document-service.ts";
import { ForbiddenError, NotFoundError } from "./errors.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const ACCOUNT = "default";
const ADMIN = { repos: null, accountId: null };

function spec(n: number, extra: Record<string, unknown> = {}) {
  return {
    session: "x",
    kind: "spec" as const,
    number: n,
    repo: "org/home",
    path: `planning/x/SPEC-000${n}.md`,
    ...extra,
  };
}

describeOrSkip("DocumentService (integration)", () => {
  let prisma: PrismaClient;
  let service: DocumentService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    service = new DocumentService(prisma);
    await prisma.planDocument.deleteMany();
    await prisma.session.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("registering the same session/kind/number twice yields one row with the later prUrl", async () => {
    const first = await service.register(
      spec(1, { prUrl: "https://github.com/org/home/pull/1", title: "A" }),
      ACCOUNT,
      ADMIN,
    );
    const second = await service.register(
      spec(1, {
        prUrl: "https://github.com/org/home/pull/2",
        title: "B",
        owner: "a@x.com",
        repos: ["org/a"],
        state: "pr_open",
      }),
      ACCOUNT,
      ADMIN,
    );
    expect(second.id).toBe(first.id);
    expect(await prisma.planDocument.count()).toBe(1);
    expect(second.prUrl).toBe("https://github.com/org/home/pull/2");
    expect(second.title).toBe("B");
    expect(second.owner).toBe("a@x.com");
    expect(second.repos).toEqual(["org/a"]);
    expect(second.state).toBe("pr_open");
  });

  it("re-registering without optional fields does not wipe them", async () => {
    await service.register(spec(1, { prUrl: "u", title: "T" }), ACCOUNT, ADMIN);
    const again = await service.register(spec(1), ACCOUNT, ADMIN);
    expect(again.prUrl).toBe("u");
    expect(again.title).toBe("T");
  });

  it("plans are always number 1", async () => {
    const plan = await service.register(
      {
        session: "x",
        kind: "plan",
        repo: "org/home",
        path: "planning/x/PLAN.md",
      },
      ACCOUNT,
      ADMIN,
    );
    expect(plan.number).toBe(1);
  });

  it("creates the session row when absent, setting owner and homeRepo", async () => {
    expect(await prisma.session.count()).toBe(0);
    await service.register(spec(1, { owner: "first@x.com" }), ACCOUNT, ADMIN);
    const session = await prisma.session.findUnique({
      where: { accountId_slug: { accountId: ACCOUNT, slug: "x" } },
    });
    expect(session?.owner).toBe("first@x.com");
    expect(session?.homeRepo).toBe("org/home");
  });

  it("a later document with a different owner does not change the session owner or homeRepo", async () => {
    await service.register(spec(1, { owner: "first@x.com" }), ACCOUNT, ADMIN);
    await service.register(
      spec(2, { owner: "second@x.com", repo: "org/other" }),
      ACCOUNT,
      ADMIN,
    );
    const session = await prisma.session.findFirst({ where: { slug: "x" } });
    expect(session?.owner).toBe("first@x.com");
    expect(session?.homeRepo).toBe("org/home");
  });

  it("owner is taken from the first document that has one", async () => {
    await service.register(spec(1), ACCOUNT, ADMIN);
    await service.register(spec(2, { owner: "late@x.com" }), ACCOUNT, ADMIN);
    const session = await prisma.session.findFirst({ where: { slug: "x" } });
    expect(session?.owner).toBe("late@x.com");
  });

  it("rejects a home repo outside the caller's repo scope and writes nothing", async () => {
    await expect(
      service.register(spec(1), ACCOUNT, {
        repos: ["org/else"],
        accountId: ACCOUNT,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.planDocument.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
  });

  it("planned=false returns only specs with no plannedAt and excludes abandoned", async () => {
    await service.register(spec(1), ACCOUNT, ADMIN);
    const planned = await service.register(spec(2), ACCOUNT, ADMIN);
    await service.register(spec(3, { state: "abandoned" }), ACCOUNT, ADMIN);
    await service.register(
      { session: "x", kind: "plan", repo: "org/home", path: "p" },
      ACCOUNT,
      ADMIN,
    );
    await service.patch(
      planned.id,
      { plannedAt: "2026-11-17T12:00:00.000Z" },
      ADMIN,
    );

    const unplanned = await service.list(
      { session: "x", kind: "spec", planned: false },
      ADMIN,
    );
    expect(unplanned.documents.map((d) => d.number)).toEqual([1]);
    const done = await service.list({ planned: true }, ADMIN);
    expect(done.documents.map((d) => d.number)).toEqual([2]);
  });

  it("filters by owner, session and account", async () => {
    await service.register(spec(1, { owner: "a@x.com" }), ACCOUNT, ADMIN);
    await service.register(
      spec(2, { owner: "b@x.com", session: "y" }),
      "other",
      ADMIN,
    );
    expect(
      (await service.list({ owner: "b@x.com" }, ADMIN)).documents,
    ).toHaveLength(1);
    expect(
      (await service.list({}, { repos: null, accountId: "other" })).documents,
    ).toHaveLength(1);
    expect((await service.list({ session: "x" }, ADMIN)).total).toBe(1);
  });

  it("patch sets plannedAt, prUrl, owner and state; out-of-scope is not found", async () => {
    const doc = await service.register(spec(1), ACCOUNT, ADMIN);
    const patched = await service.patch(
      doc.id,
      {
        plannedAt: "2026-11-17T12:00:00.000Z",
        prUrl: "u",
        owner: "o@x.com",
        state: "merged",
      },
      ADMIN,
    );
    expect(patched.plannedAt?.toISOString()).toBe("2026-11-17T12:00:00.000Z");
    expect(patched.prUrl).toBe("u");
    expect(patched.owner).toBe("o@x.com");
    expect(patched.state).toBe("merged");
    await expect(
      service.patch(
        doc.id,
        { state: "draft" },
        {
          repos: ["org/else"],
          accountId: null,
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.patch("nope", {}, ADMIN)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
