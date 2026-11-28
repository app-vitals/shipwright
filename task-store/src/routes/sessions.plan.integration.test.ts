/**
 * task-store/src/routes/sessions.plan.integration.test.ts
 *
 * Integration tests (real Postgres) for PWE-3.1: POST /sessions/{slug}/plan
 * writes the session, the plan document, the stamped tasks and the planned
 * specs in ONE transaction. Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
 * skips otherwise.
 *
 * Covers: the success path; atomicity under a forced failure at every stage
 * (plan registration, task insert, webhook, unknown spec, id collision);
 * all-repos scope (403); the planning lock (409); idempotent re-runs.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { TaskStoreAuthEnv } from "../auth.ts";
import type { Clock } from "../clock.ts";
import { DocumentService } from "../document-service.ts";
import { ApiError, ConflictError, WebhookDeliveryError } from "../errors.ts";
import { createPrismaClient, type PrismaClient } from "../prisma-client.ts";
import {
  type SessionPlanInput,
  SessionPlanService,
} from "../session-plan-service.ts";
import { PLANNING_LOCK_TTL_MS, SessionService } from "../session-service.ts";
import { TaskService } from "../task-service.ts";
import type { WebhookDispatcher } from "../webhook-dispatcher.ts";
import { createSessionsRoutes } from "./sessions.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const NOW = new Date("2026-11-19T12:00:00.000Z");
const clock: Clock = { now: () => NOW };

describeOrSkip("POST /sessions/{slug}/plan (integration)", () => {
  let prisma: PrismaClient;
  let dispatched: unknown[][];
  let webhook: WebhookDispatcher;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    dispatched = [];
    webhook = async (_type, data) => {
      dispatched.push(data as unknown[]);
    };
    await prisma.taskEvent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.planDocument.deleteMany();
    await prisma.session.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  type Overrides = {
    documentService?: DocumentService;
    taskService?: TaskService;
  };

  function appFor(
    agentId: string | null,
    repos: string[] | null,
    overrides: Overrides = {},
  ) {
    const tasks =
      overrides.taskService ??
      new TaskService(prisma, clock, (type, data) => webhook(type, data));
    const docs = overrides.documentService ?? new DocumentService(prisma);
    const planner = new SessionPlanService(prisma, tasks, docs, clock);
    const parent = new OpenAPIHono<TaskStoreAuthEnv>();
    parent.use("*", async (c, next) => {
      c.set("agentId", agentId);
      c.set("repos", repos);
      c.set("accountId", agentId === null ? null : "default");
      c.set("scopeDegraded", false);
      await next();
    });
    // Mirrors app.ts: ApiError status + ConflictError details in the body.
    parent.onError((err, c) => {
      if (err instanceof ApiError) {
        const details = err instanceof ConflictError ? err.details : undefined;
        return c.json(
          { ...details, error: err.message },
          err.statusCode as 400,
        );
      }
      return c.json({ error: String(err) }, 500);
    });
    parent.route(
      "/",
      createSessionsRoutes(new SessionService(prisma, clock), planner),
    );
    return parent;
  }

  const admin = (o?: Overrides) => appFor(null, null, o);
  const agent = (repos: string[], o?: Overrides) => appFor("agent-1", repos, o);

  const post = (app: ReturnType<typeof appFor>, slug: string, body: unknown) =>
    app.request(`/${slug}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  const task = (id: string, repo: string | null = "org/a", extra = {}) => ({
    id,
    title: `task ${id}`,
    status: "pending",
    repo,
    ...extra,
  });

  const planBody = (extra: Record<string, unknown> = {}) => ({
    plan: {
      repo: "org/home",
      path: "planning/s/PLAN.md",
      owner: "owner@example.com",
      repos: ["org/a", "org/b"],
    },
    tasks: [task("S-1.1"), task("S-1.2", "org/b")],
    specs: [1],
    ...extra,
  });

  async function seedSpec(slug: string, number: number, repo = "org/home") {
    return prisma.planDocument.create({
      data: {
        accountId: "default",
        session: slug,
        kind: "spec",
        number,
        repo,
        path: `planning/${slug}/SPEC-000${number}.md`,
      },
    });
  }

  /** Asserts that the request wrote nothing for `slug`. */
  async function expectNothingWritten(slug: string, taskIds: string[]) {
    expect(
      await prisma.session.findUnique({
        where: { accountId_slug: { accountId: "default", slug } },
      }),
    ).toBeNull();
    expect(
      await prisma.planDocument.count({
        where: { session: slug, kind: "plan" },
      }),
    ).toBe(0);
    expect(await prisma.task.count({ where: { id: { in: taskIds } } })).toBe(0);
  }

  // ─── Success path ───────────────────────────────────────────────────────

  it("creates the session, plan document, stamped tasks and planned specs", async () => {
    await seedSpec("s", 1);
    await seedSpec("s", 2);
    const res = await post(admin(), "s", planBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      planDocumentId: string;
      inserted: number;
    };
    expect(body.inserted).toBe(2);

    const session = await prisma.session.findUnique({
      where: { accountId_slug: { accountId: "default", slug: "s" } },
    });
    expect(session?.owner).toBe("owner@example.com");
    expect(session?.homeRepo).toBe("org/home");

    const plan = await prisma.planDocument.findUnique({
      where: { id: body.planDocumentId },
    });
    expect(plan?.kind).toBe("plan");
    expect(plan?.number).toBe(1);
    expect(plan?.repo).toBe("org/home");
    expect(plan?.repos).toEqual(["org/a", "org/b"]);

    const tasks = await prisma.task.findMany({ orderBy: { id: "asc" } });
    expect(tasks.map((t) => t.id)).toEqual(["S-1.1", "S-1.2"]);
    for (const t of tasks) {
      expect(t.session).toBe("s");
      expect(t.accountId).toBe("default");
      expect(t.planDocumentId).toBe(body.planDocumentId);
      expect(t.originKind).toBe("document");
      expect(t.originRef).toBe(body.planDocumentId);
    }

    const specs = await prisma.planDocument.findMany({
      where: { session: "s", kind: "spec" },
      orderBy: { number: "asc" },
    });
    expect(specs[0].plannedAt?.toISOString()).toBe(NOW.toISOString());
    expect(specs[1].plannedAt).toBeNull(); // not listed

    // One webhook for the whole batch.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toHaveLength(2);
  });

  it("an agent with every repo in scope may write the plan", async () => {
    const res = await post(
      agent(["org/home", "org/a", "org/b"]),
      "s",
      planBody({ specs: [] }),
    );
    expect(res.status).toBe(200);
    expect(await prisma.task.count()).toBe(2);
  });

  it("an already-planned spec keeps its plannedAt", async () => {
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    const spec = await seedSpec("s", 1);
    await prisma.planDocument.update({
      where: { id: spec.id },
      data: { plannedAt: earlier },
    });
    expect((await post(admin(), "s", planBody())).status).toBe(200);
    const after = await prisma.planDocument.findUnique({
      where: { id: spec.id },
    });
    expect(after?.plannedAt?.toISOString()).toBe(earlier.toISOString());
  });

  // ─── Atomicity: a forced failure at any stage writes nothing ────────────

  it("a task id collision is 409 and rolls back the session, plan, tasks and specs", async () => {
    await prisma.task.create({
      data: { id: "S-1.2", title: "taken", status: "pending", repo: "org/z" },
    });
    // Spec lives in another session's slug so this session stays unwritten.
    const res = await post(admin(), "fresh", planBody({ specs: [] }));
    expect(res.status).toBe(409);
    await expectNothingWritten("fresh", ["S-1.1"]);
    expect(dispatched).toHaveLength(0);
  });

  it("a collision leaves an existing spec's plannedAt unset", async () => {
    const spec = await seedSpec("s", 1);
    await prisma.task.create({
      data: { id: "S-1.2", title: "taken", status: "pending", repo: "org/z" },
    });
    expect((await post(admin(), "s", planBody())).status).toBe(409);
    const after = await prisma.planDocument.findUnique({
      where: { id: spec.id },
    });
    expect(after?.plannedAt).toBeNull();
    expect(
      await prisma.planDocument.count({
        where: { session: "s", kind: "plan" },
      }),
    ).toBe(0);
    expect(await prisma.task.count({ where: { id: "S-1.1" } })).toBe(0);
  });

  it("an agent's collision gets the generic body", async () => {
    await prisma.task.create({
      data: { id: "S-1.1", title: "taken", status: "pending", repo: "org/z" },
    });
    const res = await post(
      agent(["org/home", "org/a", "org/b"]),
      "s",
      planBody({ specs: [] }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "task id unavailable",
    );
  });

  it("a webhook delivery failure is 502 and writes nothing", async () => {
    webhook = async () => {
      throw new WebhookDeliveryError("receiver down");
    };
    const res = await post(admin(), "fresh", planBody({ specs: [] }));
    expect(res.status).toBe(502);
    await expectNothingWritten("fresh", ["S-1.1", "S-1.2"]);
  });

  it("an unregistered spec is 400 and writes nothing", async () => {
    const res = await post(admin(), "fresh", planBody({ specs: [7] }));
    expect(res.status).toBe(400);
    await expectNothingWritten("fresh", ["S-1.1", "S-1.2"]);
  });

  it("a failure right after the plan registers rolls back the session and plan", async () => {
    const real = new DocumentService(prisma);
    const failing = Object.create(real) as DocumentService;
    failing.register = async (...args) => {
      await real.register(...args);
      throw new Error("forced failure after register");
    };
    const res = await post(
      admin({ documentService: failing }),
      "fresh",
      planBody({ specs: [] }),
    );
    expect(res.status).toBe(500);
    await expectNothingWritten("fresh", ["S-1.1", "S-1.2"]);
  });

  it("a failure right after the tasks insert rolls back everything", async () => {
    const real = new TaskService(prisma, clock);
    const failing = Object.create(real) as TaskService;
    failing.bulk = async (...args) => {
      await real.bulk(...args);
      throw new Error("forced failure after bulk");
    };
    const spec = await seedSpec("s", 1);
    const res = await post(admin({ taskService: failing }), "s", planBody());
    expect(res.status).toBe(500);
    expect(await prisma.task.count()).toBe(0);
    expect(
      await prisma.planDocument.count({
        where: { session: "s", kind: "plan" },
      }),
    ).toBe(0);
    expect(
      (await prisma.planDocument.findUnique({ where: { id: spec.id } }))
        ?.plannedAt,
    ).toBeNull();
  });

  // ─── Scope ──────────────────────────────────────────────────────────────

  it.each([
    ["the plan's home repo", ["org/a", "org/b"]],
    ["a plan target repo", ["org/home", "org/a"]],
    ["a task repo", ["org/home", "org/a", "org/x"]],
  ])("403 when %s is outside the agent's scope", async (_label, scope) => {
    const body = planBody({
      specs: [],
      plan: {
        repo: "org/home",
        path: "planning/s/PLAN.md",
        repos: scope.includes("org/x") ? ["org/a"] : ["org/a", "org/b"],
      },
      tasks: scope.includes("org/x")
        ? [task("S-1.1"), task("S-1.2", "org/b")]
        : [task("S-1.1")],
    });
    const res = await post(agent(scope), "fresh", body);
    expect(res.status).toBe(403);
    await expectNothingWritten("fresh", ["S-1.1", "S-1.2"]);
  });

  it("403 when the existing session spans a repo outside the agent's scope", async () => {
    await prisma.session.create({ data: { slug: "s", accountId: "default" } });
    await prisma.task.create({
      data: {
        id: "OTHER-1",
        title: "t",
        status: "pending",
        repo: "org/secret",
        session: "s",
      },
    });
    const res = await post(
      agent(["org/home", "org/a", "org/b"]),
      "s",
      planBody({ specs: [] }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toContain("org/secret");
    expect(await prisma.task.count()).toBe(1);
    expect(await prisma.planDocument.count()).toBe(0);
  });

  // ─── Planning lock ──────────────────────────────────────────────────────

  async function lockSession(holder: string, expiresAt: Date) {
    await prisma.session.create({
      data: {
        slug: "s",
        accountId: "default",
        planningLockHolder: holder,
        planningLockExpiresAt: expiresAt,
      },
    });
  }
  const live = new Date(NOW.getTime() + PLANNING_LOCK_TTL_MS / 2);

  it("a live lock held by someone else is 409 naming the holder; nothing written", async () => {
    await lockSession("agent-2", live);
    const res = await post(
      agent(["org/home", "org/a", "org/b"]),
      "s",
      planBody({ specs: [] }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { holder: string; expiresAt: string };
    expect(body.holder).toBe("agent-2");
    expect(body.expiresAt).toBe(live.toISOString());
    expect(await prisma.task.count()).toBe(0);
    expect(await prisma.planDocument.count()).toBe(0);
  });

  it("the lock holder itself may write, and the lock is left in place", async () => {
    await lockSession("agent-1", live);
    const res = await post(
      agent(["org/home", "org/a", "org/b"]),
      "s",
      planBody({ specs: [] }),
    );
    expect(res.status).toBe(200);
    const row = await prisma.session.findUnique({
      where: { accountId_slug: { accountId: "default", slug: "s" } },
    });
    expect(row?.planningLockHolder).toBe("agent-1");
  });

  it("an explicit body holder is honoured", async () => {
    await lockSession("plan-pass-7", live);
    const res = await post(
      admin(),
      "s",
      planBody({ specs: [], holder: "plan-pass-7" }),
    );
    expect(res.status).toBe(200);
    expect((await post(admin(), "s", planBody({ specs: [] }))).status).toBe(
      409,
    );
  });

  it("an expired lock does not block the write", async () => {
    await lockSession("agent-2", new Date(NOW.getTime() - 1000));
    const res = await post(admin(), "s", planBody({ specs: [] }));
    expect(res.status).toBe(200);
  });

  // ─── Idempotency ────────────────────────────────────────────────────────

  it("re-running the same plan reuses the document and 409s on existing task ids", async () => {
    await seedSpec("s", 1);
    const first = (await (await post(admin(), "s", planBody())).json()) as {
      planDocumentId: string;
    };
    const again = await post(admin(), "s", planBody());
    expect(again.status).toBe(409);
    expect(
      await prisma.planDocument.count({
        where: { session: "s", kind: "plan" },
      }),
    ).toBe(1);

    // Same plan, new tasks: same document id, tasks appended.
    const more = await post(
      admin(),
      "s",
      planBody({ tasks: [task("S-2.1")], specs: [1] }),
    );
    expect(more.status).toBe(200);
    const body = (await more.json()) as {
      planDocumentId: string;
      inserted: number;
    };
    expect(body.planDocumentId).toBe(first.planDocumentId);
    expect(body.inserted).toBe(1);
    expect(await prisma.task.count({ where: { session: "s" } })).toBe(3);
  });

  // ─── Validation ─────────────────────────────────────────────────────────

  it("400 when a task names a different session; nothing written", async () => {
    const res = await post(
      admin(),
      "fresh",
      planBody({
        specs: [],
        tasks: [task("S-1.1", "org/a", { session: "x" })],
      }),
    );
    expect(res.status).toBe(400);
    await expectNothingWritten("fresh", ["S-1.1"]);
  });

  it("400 for a task that POST /tasks/bulk would reject (bad status)", async () => {
    const res = await post(
      admin(),
      "fresh",
      planBody({
        specs: [],
        tasks: [task("S-1.1", "org/a", { status: "nope" })],
      }),
    );
    expect(res.status).toBe(400);
    await expectNothingWritten("fresh", ["S-1.1"]);
  });

  it("the service alone also refuses an out-of-scope request before writing", async () => {
    const planner = new SessionPlanService(
      prisma,
      new TaskService(prisma, clock),
      new DocumentService(prisma),
      clock,
    );
    const input: SessionPlanInput = {
      session: "fresh",
      accountId: "default",
      holder: "agent-1",
      plan: { repo: "org/home", path: "p" },
      tasks: [],
      specs: [],
    };
    await expect(planner.plan(input, { repos: ["org/a"] })).rejects.toThrow(
      "outside this token's scope",
    );
    await expectNothingWritten("fresh", []);
  });

  // ─── Slug rules and case-insensitive lookup (STI-1.2) ────────────────────

  const getSession = (app: ReturnType<typeof appFor>, slug: string) =>
    app.request(`/${encodeURIComponent(slug)}`);

  describe("new-session slug validation", () => {
    it.each([
      ["uppercase", "Fresh"],
      ["leading digit", "1fresh"],
      ["over 64 chars", "a".repeat(65)],
      ["slash", "a%2Fb"],
    ])(
      "400 with a rename-me message for %s and nothing is written",
      async (_n, slug) => {
        const res = await post(
          admin(),
          slug,
          planBody({ specs: [], tasks: [] }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toContain("please choose a different name");
        expect(await prisma.session.count()).toBe(0);
      },
    );

    it("accepts a 64-char valid slug", async () => {
      const res = await post(
        admin(),
        "a".repeat(64),
        planBody({ specs: [], tasks: [] }),
      );
      expect(res.status).toBe(200);
    });

    it("a legacy slug with uppercase still resolves and accepts plan writes", async () => {
      await prisma.session.create({
        data: { accountId: "default", slug: "Legacy_Slug" },
      });
      const res = await post(
        admin(),
        "Legacy_Slug",
        planBody({ specs: [], tasks: [task("LEG-1.1")] }),
      );
      expect(res.status).toBe(200);
      expect(await prisma.session.count()).toBe(1);
      expect((await getSession(admin(), "Legacy_Slug")).status).toBe(200);
    });
  });

  describe("case-insensitive lookup", () => {
    it("409 naming the existing slug for a case-variant of an existing session", async () => {
      await prisma.session.create({
        data: { accountId: "default", slug: "existing" },
      });
      const res = await post(
        admin(),
        "Existing",
        planBody({ specs: [], tasks: [] }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("'existing'");
      expect(await prisma.session.count()).toBe(1);
    });

    it("409 names a legacy uppercase slug when a lowercase variant is requested", async () => {
      await prisma.session.create({
        data: { accountId: "default", slug: "Legacy" },
      });
      const res = await post(
        admin(),
        "legacy",
        planBody({ specs: [], tasks: [] }),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain(
        "'Legacy'",
      );
    });

    it("the same slug in another account is not a conflict", async () => {
      await prisma.session.create({
        data: { accountId: "other", slug: "shared" },
      });
      const res = await post(
        admin(),
        "shared",
        planBody({ specs: [], tasks: [] }),
      );
      expect(res.status).toBe(200);
    });

    it("GET /sessions/:slug matches case-insensitively and returns the canonical slug", async () => {
      await prisma.session.create({
        data: { accountId: "default", slug: "mixed-case" },
      });
      const res = await getSession(admin(), "MIXED-Case");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { slug: string }).slug).toBe("mixed-case");
    });

    it("GET /sessions/:slug rolls up tasks and documents of the canonical slug", async () => {
      await prisma.session.create({
        data: { accountId: "default", slug: "rollup" },
      });
      await prisma.task.create({
        data: { id: "R-1.1", title: "t", status: "pending", session: "rollup" },
      });
      await seedSpec("rollup", 1);
      const res = await getSession(admin(), "ROLLUP");
      const body = (await res.json()) as {
        documents: unknown[];
        counts?: unknown;
      };
      expect(body.documents).toHaveLength(1);
    });

    it("session= filter on tasks and documents is case-insensitive", async () => {
      await prisma.session.create({
        data: { accountId: "default", slug: "filtered" },
      });
      await prisma.task.create({
        data: {
          id: "F-1.1",
          title: "t",
          status: "pending",
          session: "filtered",
        },
      });
      await seedSpec("filtered", 1);
      const tasks = await new TaskService(prisma, clock).list({
        session: "FILTERED",
      });
      expect(tasks.tasks.map((t) => t.id)).toEqual(["F-1.1"]);
      const docs = await new DocumentService(prisma).list(
        { session: "Filtered" },
        { repos: null, accountId: null },
      );
      expect(docs.documents).toHaveLength(1);
    });
  });
});
