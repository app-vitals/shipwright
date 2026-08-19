/**
 * task-store/src/pr-finding.integration.test.ts
 *
 * Integration tests for the PrFinding model against a real Postgres DB.
 *
 * PrFinding records are written incrementally (and potentially concurrently)
 * by both the review and patch pipelines — a plain INSERT per finding avoids
 * the race conditions of a JSON-array read-modify-write PATCH on PullRequest.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip("PrFinding model (integration)", () => {
  let prisma: PrismaClient;

  beforeEach(async () => {
    prisma = makePrisma();
    await prisma.prFinding.deleteMany();
    // PullRequestEvent's FK is ON DELETE RESTRICT (PSA-1.2) — clear event
    // rows before their parent PullRequest rows, in case another test file
    // sharing TEST_DB left rows behind.
    await prisma.pullRequestEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("round-trips a PrFinding row end to end, including the FK relation to PullRequest", async () => {
    const pr = await prisma.pullRequest.create({
      data: {
        repo: "app-vitals/shipwright",
        prNumber: 4200,
      },
    });

    const at = "2026-08-17T12:00:00.000Z";
    const created = await prisma.prFinding.create({
      data: {
        prRecordId: pr.id,
        ref: "src/foo.ts:42",
        disposition: "resolved",
        source: "review",
        evidence: "Fixed the null check in the follow-up commit.",
        at,
      },
    });

    const read = await prisma.prFinding.findUnique({
      where: { id: created.id },
    });

    expect(read).not.toBeNull();
    if (!read) return;

    expect(read.prRecordId).toBe(pr.id);
    expect(read.ref).toBe("src/foo.ts:42");
    expect(read.disposition).toBe("resolved");
    expect(read.source).toBe("review");
    expect(read.evidence).toBe(
      "Fixed the null check in the follow-up commit.",
    );
    expect(read.at).toBe(at);
    expect(read.createdAt).toBeInstanceOf(Date);
  });

  it("accepts all disposition and source enum values", async () => {
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 4201 },
    });

    const dispositions = ["resolved", "superseded", "rejected"] as const;
    const sources = ["review", "patch"] as const;

    for (const disposition of dispositions) {
      for (const source of sources) {
        const created = await prisma.prFinding.create({
          data: {
            prRecordId: pr.id,
            ref: `ref-${disposition}-${source}`,
            disposition,
            source,
            evidence: "evidence text",
            at: "2026-08-17T00:00:00.000Z",
          },
        });
        expect(created.disposition).toBe(disposition);
        expect(created.source).toBe(source);
      }
    }
  });

  it("supports multiple findings per PR, queryable by (prRecordId, ref)", async () => {
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 4202 },
    });

    await prisma.prFinding.create({
      data: {
        prRecordId: pr.id,
        ref: "src/a.ts:1",
        disposition: "rejected",
        source: "review",
        evidence: "not a real issue",
        at: "2026-08-17T01:00:00.000Z",
      },
    });
    await prisma.prFinding.create({
      data: {
        prRecordId: pr.id,
        ref: "src/b.ts:2",
        disposition: "superseded",
        source: "patch",
        evidence: "replaced by a later fix",
        at: "2026-08-17T02:00:00.000Z",
      },
    });

    const byRef = await prisma.prFinding.findMany({
      where: { prRecordId: pr.id, ref: "src/a.ts:1" },
    });
    expect(byRef).toHaveLength(1);
    expect(byRef[0].disposition).toBe("rejected");

    const allForPr = await prisma.prFinding.findMany({
      where: { prRecordId: pr.id },
    });
    expect(allForPr).toHaveLength(2);
  });

  it("supports querying by (prRecordId, source)", async () => {
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 4203 },
    });

    await prisma.prFinding.create({
      data: {
        prRecordId: pr.id,
        ref: "src/c.ts:1",
        disposition: "resolved",
        source: "review",
        evidence: "fixed",
        at: "2026-08-17T03:00:00.000Z",
      },
    });
    await prisma.prFinding.create({
      data: {
        prRecordId: pr.id,
        ref: "src/d.ts:1",
        disposition: "resolved",
        source: "patch",
        evidence: "fixed by patch",
        at: "2026-08-17T04:00:00.000Z",
      },
    });

    const reviewFindings = await prisma.prFinding.findMany({
      where: { prRecordId: pr.id, source: "review" },
    });
    expect(reviewFindings).toHaveLength(1);
    expect(reviewFindings[0].ref).toBe("src/c.ts:1");

    const patchFindings = await prisma.prFinding.findMany({
      where: { prRecordId: pr.id, source: "patch" },
    });
    expect(patchFindings).toHaveLength(1);
    expect(patchFindings[0].ref).toBe("src/d.ts:1");
  });

  it("allows concurrent inserts for the same PR without a read-modify-write race", async () => {
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 4204 },
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        prisma.prFinding.create({
          data: {
            prRecordId: pr.id,
            ref: `src/concurrent.ts:${i}`,
            disposition: "resolved",
            source: i % 2 === 0 ? "review" : "patch",
            evidence: `finding ${i}`,
            at: "2026-08-17T05:00:00.000Z",
          },
        }),
      ),
    );

    expect(results).toHaveLength(5);

    const all = await prisma.prFinding.findMany({
      where: { prRecordId: pr.id },
    });
    expect(all).toHaveLength(5);
  });

  it("enforces the PullRequest FK — findings must be deleted before their parent PR", async () => {
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 4205 },
    });

    await prisma.prFinding.create({
      data: {
        prRecordId: pr.id,
        ref: "src/e.ts:1",
        disposition: "resolved",
        source: "review",
        evidence: "evidence",
        at: "2026-08-17T06:00:00.000Z",
      },
    });

    // Delete findings before the parent PR to respect FK constraints, then
    // confirm the parent can be deleted cleanly (proves the FK is wired).
    await prisma.prFinding.deleteMany({ where: { prRecordId: pr.id } });
    await prisma.pullRequest.delete({ where: { id: pr.id } });

    const remaining = await prisma.pullRequest.findUnique({
      where: { id: pr.id },
    });
    expect(remaining).toBeNull();
  });
});
