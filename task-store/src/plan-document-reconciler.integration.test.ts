/**
 * task-store/src/plan-document-reconciler.integration.test.ts
 *
 * PlanDocumentReconciler against a real Postgres DB, with an injected clock
 * and the real GitHub client replaying recorded fixtures (PLU-2.6).
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { FixedClock } from "./clock.ts";
import { createGitHubPlanClient } from "./github-plan-client.ts";
import type { PlanDocumentState } from "./index.ts";
import { PlanDocumentReconciler } from "./plan-document-reconciler.ts";
import { fixtureFetch } from "./plan-reconciler-fixtures.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const NOW = new Date("2026-11-17T03:00:00.000Z");
const client = () =>
  createGitHubPlanClient({ token: "t", fetch: fixtureFetch() });

describeOrSkip("PlanDocumentReconciler (integration)", () => {
  let prisma: PrismaClient;

  async function makeDoc(
    number: number,
    state: PlanDocumentState,
    prUrl: string | null,
    extra: { commitSha?: string | null } = {},
  ) {
    return prisma.planDocument.create({
      data: {
        session: "reconcile-s1",
        kind: "spec",
        number,
        repo: "acme/home",
        path: `planning/s1/SPEC-000${number}.md`,
        title: `Spec ${number}`,
        owner: "dev@example.com",
        repos: ["acme/other"],
        state,
        prUrl,
        commitSha: extra.commitSha ?? null,
      },
    });
  }

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    await prisma.planDocument.deleteMany({
      where: { session: "reconcile-s1" },
    });
  });

  it("moves a merged-file doc to merged and a closed-unmerged PR doc to abandoned, changing only state/prUrl/commitSha", async () => {
    const merged = await makeDoc(
      1,
      "pr_open",
      "https://github.com/acme/home/pull/12",
    );
    const abandoned = await makeDoc(
      2,
      "pr_open",
      "https://github.com/acme/home/pull/13",
    );
    const stillOpen = await makeDoc(
      3,
      "pr_open",
      "https://github.com/acme/home/pull/14",
    );

    const reconciler = new PlanDocumentReconciler(
      prisma,
      client(),
      FixedClock(NOW),
    );
    const result = await reconciler.sweep();

    expect(result).toEqual({
      examined: 3,
      merged: 1,
      abandoned: 1,
      unchanged: 1,
      failed: 0,
    });
    expect(reconciler.lastSweepAt).toEqual(NOW);

    const after = async (id: string) =>
      prisma.planDocument.findUniqueOrThrow({ where: { id } });

    const m = await after(merged.id);
    expect(m.state).toBe("merged");
    expect(m.commitSha).toBe("9f8e7d6c5b4a39281706f5e4d3c2b1a099887766");
    expect({ ...m, state: 0, commitSha: 0, updatedAt: 0 }).toEqual({
      ...merged,
      state: 0,
      commitSha: 0,
      updatedAt: 0,
    });

    const a = await after(abandoned.id);
    expect(a.state).toBe("abandoned");
    expect({ ...a, state: 0, updatedAt: 0 }).toEqual({
      ...abandoned,
      state: 0,
      updatedAt: 0,
    });

    expect((await after(stillOpen.id)).state).toBe("pr_open");
  });

  it("fills a missing prUrl from the file's merged PR", async () => {
    const d = await makeDoc(1, "draft", null);
    await new PlanDocumentReconciler(prisma, client(), FixedClock(NOW)).sweep();
    const after = await prisma.planDocument.findUniqueOrThrow({
      where: { id: d.id },
    });
    expect(after.state).toBe("merged");
    expect(after.prUrl).toBe("https://github.com/acme/home/pull/12");
  });

  it("never touches merged or abandoned rows", async () => {
    // These point at fixtures that would otherwise flip them.
    const mergedRow = await makeDoc(
      2,
      "merged",
      "https://github.com/acme/home/pull/13",
    );
    const abandonedRow = await makeDoc(
      1,
      "abandoned",
      "https://github.com/acme/home/pull/12",
    );

    const calls: string[] = [];
    const spy = fixtureFetch();
    const spying = (async (...args: Parameters<typeof fetch>) => {
      calls.push(String(args[0]));
      return spy(...args);
    }) as typeof fetch;
    const result = await new PlanDocumentReconciler(
      prisma,
      createGitHubPlanClient({ token: "t", fetch: spying }),
      FixedClock(NOW),
    ).sweep();

    expect(result.examined).toBe(0);
    expect(calls).toEqual([]);
    expect(
      (
        await prisma.planDocument.findUniqueOrThrow({
          where: { id: mergedRow.id },
        })
      ).state,
    ).toBe("merged");
    expect(
      (
        await prisma.planDocument.findUniqueOrThrow({
          where: { id: abandonedRow.id },
        })
      ).state,
    ).toBe("abandoned");
  });

  it("without a GitHub credential is a no-op and logs once", async () => {
    const d = await makeDoc(
      1,
      "pr_open",
      "https://github.com/acme/home/pull/12",
    );
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.join(" "));
    };
    try {
      const reconciler = new PlanDocumentReconciler(
        prisma,
        null,
        FixedClock(NOW),
      );
      const r1 = await reconciler.sweep();
      const r2 = await reconciler.sweep();
      expect(r1.examined).toBe(0);
      expect(r2.examined).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(logs.filter((l) => l.includes("no GitHub credential"))).toHaveLength(
      1,
    );
    expect(
      (await prisma.planDocument.findUniqueOrThrow({ where: { id: d.id } }))
        .state,
    ).toBe("pr_open");
  });

  it("a GitHub failure on one row does not abort the sweep", async () => {
    await makeDoc(1, "pr_open", "https://github.com/acme/home/pull/12");
    await prisma.planDocument.create({
      data: {
        session: "reconcile-s1",
        kind: "spec",
        number: 9,
        repo: "acme/home",
        path: "planning/s1/SPEC-0009.md", // no recorded fixture -> fetch throws
        state: "draft",
      },
    });
    const origErr = console.error;
    console.error = () => {};
    try {
      const r = await new PlanDocumentReconciler(
        prisma,
        client(),
        FixedClock(NOW),
      ).sweep();
      expect(r.failed).toBe(1);
      expect(r.merged).toBe(1);
    } finally {
      console.error = origErr;
    }
  });
});
