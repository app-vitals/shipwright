/**
 * scripts/register-planning-sessions.integration.test.ts
 *
 * Integration tests for the operator registration script (PLU-6.1) against a
 * real Postgres task store: the real Hono app + DocumentService + TaskService,
 * reached through the script's HTTP client with an injected `fetch` that calls
 * `app.request()`. A fixture planning tree on disk is the content source. No mocks.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST; the suite skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskStoreApp } from "../task-store/src/app.ts";
import { DocumentService } from "../task-store/src/document-service.ts";
import {
  createPrismaClient,
  type PrismaClient,
} from "../task-store/src/prisma-client.ts";
import { SessionService } from "../task-store/src/session-service.ts";
import { TaskService } from "../task-store/src/task-service.ts";
import { TaskTokenService } from "../task-store/src/token-service.ts";
import {
  formatReport,
  HttpPlanningStoreClient,
  runRegistration,
} from "./register-planning-sessions.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const clock = { now: () => new Date("2026-11-17T12:00:00.000Z") };

describeOrSkip("register-planning-sessions (integration)", () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createTaskStoreApp>;
  let token: string;
  let root: string;
  let client: HttpPlanningStoreClient;
  let fakeFetch: typeof fetch;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await prisma.planDocument.deleteMany();
    await prisma.session.deleteMany();
    await prisma.taskToken.deleteMany();
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();

    const tokenService = new TaskTokenService(prisma);
    token = (await tokenService.create("plan-reg")).rawToken;
    app = createTaskStoreApp({
      taskService: new TaskService(prisma),
      tokenService,
      sessionService: new SessionService(prisma),
      documentService: new DocumentService(prisma),
    });
    fakeFetch = ((url: string | URL | Request, init?: RequestInit) =>
      app.request(
        String(url).replace("http://store.test", ""),
        init,
      )) as typeof fetch;
    client = new HttpPlanningStoreClient({
      baseUrl: "http://store.test",
      token,
      fetch: fakeFetch,
    });

    root = mkdtempSync(join(tmpdir(), "plan-reg-script-"));
    const dir = join(root, "planning", "x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "PLAN.md"), "# The plan\n");
    writeFileSync(join(dir, "PRODUCT-SPEC.md"), "# The spec\n");
    writeFileSync(join(dir, "SPEC-0002.md"), "# Second spec\n");
    writeFileSync(join(dir, "AUDIT.md"), "# audit\n");
  });

  afterEach(async () => {
    rmSync(root, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  const run = (dryRun = false) =>
    runRegistration({ client, root, repo: "org/repo", clock, dryRun });

  async function seedTask(id: string, source: string | null) {
    await prisma.task.create({
      data: { id, title: id, status: "pending", repo: "org/repo", source },
    });
  }

  it("second run reports zero creates and zero updates", async () => {
    const first = await run();
    expect(first.errors).toEqual([]);
    expect(first.created).toBe(3);
    const second = await run();
    expect(second.errors).toEqual([]);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.linked).toBe(0);
    expect(await prisma.planDocument.count()).toBe(3);
  });

  it("dry-run writes nothing", async () => {
    await seedTask("T-1", "planning/x/PLAN.md");
    const res = await run(true);
    expect(res.dryRun).toBe(true);
    expect(res.created).toBe(3);
    expect(res.linked).toBe(1);
    expect(await prisma.planDocument.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    const task = await prisma.task.findUniqueOrThrow({ where: { id: "T-1" } });
    expect(task.planDocumentId).toBeNull();
  });

  it("links a task by source changing only planDocumentId; owner stays empty", async () => {
    await seedTask("T-1", "planning/x/PLAN.md");
    await seedTask("T-2", "planning/y/PLAN.md");
    const before = await prisma.task.findUniqueOrThrow({
      where: { id: "T-1" },
    });
    const res = await run();
    expect(res.linked).toBe(1);

    const plan = await prisma.planDocument.findFirstOrThrow({
      where: { kind: "plan" },
    });
    const { planDocumentId, updatedAt, ...after } =
      await prisma.task.findUniqueOrThrow({ where: { id: "T-1" } });
    const { planDocumentId: _p, updatedAt: _u, ...rest } = before;
    expect(planDocumentId).toBe(plan.id);
    expect(after).toEqual(rest);
    expect(updatedAt).toBeInstanceOf(Date);
    const other = await prisma.task.findUniqueOrThrow({ where: { id: "T-2" } });
    expect(other.planDocumentId).toBeNull();

    const docs = await prisma.planDocument.findMany();
    expect(docs.every((d) => d.owner === null)).toBe(true);
    const session = await prisma.session.findFirstOrThrow({
      where: { slug: "x" },
    });
    expect(session.owner).toBeNull();
    expect(session.homeRepo).toBe("org/repo");
  });

  it("reports a non-standard file and registers no row for it", async () => {
    const res = await run();
    expect(res.reported).toEqual([
      { path: "planning/x/AUDIT.md", reason: "non-standard file" },
    ]);
    const paths = (await prisma.planDocument.findMany()).map((d) => d.path);
    expect(paths.some((p) => p.endsWith("AUDIT.md"))).toBe(false);
    expect(formatReport(res)).toContain("planning/x/AUDIT.md");
  });

  it("paginates task lookups past the store's default page size", async () => {
    for (let i = 0; i < 55; i++) await seedTask(`T-${i}`, "planning/x/PLAN.md");
    const res = await run();
    expect(res.linked).toBe(55);
    const unlinked = await prisma.task.count({
      where: { planDocumentId: null },
    });
    expect(unlinked).toBe(0);
  });

  it("surfaces store failures in errors instead of throwing", async () => {
    const bad = new HttpPlanningStoreClient({
      baseUrl: "http://store.test",
      token: "wrong",
      fetch: fakeFetch,
    });
    const res = await runRegistration({
      client: bad,
      root,
      repo: "org/repo",
      clock,
    });
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
