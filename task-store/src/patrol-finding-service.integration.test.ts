/**
 * task-store/src/patrol-finding-service.integration.test.ts
 *
 * Integration tests (real Postgres) for PatrolFindingService (PCR-1.2):
 * upsert creates new findings, continued ones bump occurrenceCount/lastSeen
 * and append (never rewrite) history, a repeated identical upsert is
 * idempotent, and reads filter/page by cursor and respect account + repo scope.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  PatrolFindingService,
  type UpsertPatrolFindingsInput,
} from "./patrol-finding-service.ts";
import { createPrismaClient, type PrismaClient } from "./prisma-client.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;
const describeOrSkip = TEST_DB ? describe : describe.skip;

const REPO = "app-vitals/shipwright";

function input(
  overrides: Partial<UpsertPatrolFindingsInput> = {},
): UpsertPatrolFindingsInput {
  return {
    accountId: "acct-a",
    cronId: "consolidation-patrol",
    repo: REPO,
    observedAt: "2026-11-27T06:00:00.000Z",
    findings: [{ fingerprint: "fp-1", status: "tracking", detail: { n: 1 } }],
    ...overrides,
  };
}

describeOrSkip("PatrolFindingService (integration)", () => {
  let prisma: PrismaClient;
  let service: PatrolFindingService;

  beforeEach(async () => {
    prisma = createPrismaClient(TEST_DB as string);
    service = new PatrolFindingService(prisma);
    await prisma.patrolFinding.deleteMany();
  });

  afterEach(async () => {
    await prisma.patrolFinding.deleteMany();
    await prisma.$disconnect();
  });

  it("creates a new finding with count 1 and a single history entry", async () => {
    const [f] = await service.upsertBatch(input());
    expect(f?.occurrenceCount).toBe(1);
    expect(f?.firstSeen).toEqual(f?.lastSeen as Date);
    expect(f?.taskId).toBeNull();
    expect(f?.history).toEqual([
      {
        at: "2026-11-27T06:00:00.000Z",
        status: "tracking",
        occurrenceCount: 1,
      },
    ]);
  });

  it("a continued finding bumps count/lastSeen, updates status and appends history", async () => {
    await service.upsertBatch(input());
    const [f] = await service.upsertBatch(
      input({
        observedAt: "2026-11-28T06:00:00.000Z",
        findings: [
          {
            fingerprint: "fp-1",
            status: "ready_to_propose",
            taskId: "T-1",
          },
        ],
      }),
    );
    expect(f?.occurrenceCount).toBe(2);
    expect(f?.status).toBe("ready_to_propose");
    expect(f?.firstSeen.toISOString()).toBe("2026-11-27T06:00:00.000Z");
    expect(f?.lastSeen.toISOString()).toBe("2026-11-28T06:00:00.000Z");
    expect(f?.taskId).toBe("T-1");
    // detail omitted on the second upsert keeps the existing value
    expect(f?.detail).toEqual({ n: 1 });
    expect(f?.history).toEqual([
      {
        at: "2026-11-27T06:00:00.000Z",
        status: "tracking",
        occurrenceCount: 1,
      },
      {
        at: "2026-11-28T06:00:00.000Z",
        status: "ready_to_propose",
        occurrenceCount: 2,
      },
    ]);
    expect(await prisma.patrolFinding.count()).toBe(1);
  });

  it("repeating an identical upsert does not corrupt history or inflate the count", async () => {
    const second = input({
      observedAt: "2026-11-28T06:00:00.000Z",
      findings: [{ fingerprint: "fp-1", status: "open" }],
    });
    await service.upsertBatch(input());
    const first = await service.upsertBatch(second);
    const again = await service.upsertBatch(second);
    expect(again[0]?.occurrenceCount).toBe(2);
    expect(again[0]?.history).toEqual(first[0]?.history);
    // an older observation arriving late is also a no-op
    const late = await service.upsertBatch(input());
    expect(late[0]?.occurrenceCount).toBe(2);
    expect(late[0]?.history).toHaveLength(2);
  });

  it("handles a mixed batch of new and continued findings", async () => {
    await service.upsertBatch(input());
    const out = await service.upsertBatch(
      input({
        observedAt: "2026-11-28T06:00:00.000Z",
        findings: [
          { fingerprint: "fp-1", status: "tracking" },
          { fingerprint: "fp-2", status: "tracking" },
        ],
      }),
    );
    expect(out.map((f) => [f.fingerprint, f.occurrenceCount])).toEqual([
      ["fp-1", 2],
      ["fp-2", 1],
    ]);
  });

  it("keys by account, cron and repo", async () => {
    await service.upsertBatch(input());
    await service.upsertBatch(input({ accountId: "acct-b" }));
    await service.upsertBatch(input({ cronId: "other-patrol" }));
    await service.upsertBatch(input({ repo: "app-vitals/other" }));
    expect(await prisma.patrolFinding.count()).toBe(4);
  });

  it("list filters by cron/repo/status and pages by cursor", async () => {
    const findings = Array.from({ length: 5 }, (_, i) => ({
      fingerprint: `fp-${i}`,
      status: i % 2 === 0 ? "tracking" : "open",
    }));
    for (let i = 0; i < 5; i++) {
      await service.upsertBatch(
        input({
          observedAt: `2026-11-2${i}T00:00:00.000Z`,
          findings: [findings[i] as { fingerprint: string; status: string }],
        }),
      );
    }
    await service.upsertBatch(input({ cronId: "other-patrol" }));

    const filtered = await service.list({
      cronId: "consolidation-patrol",
      repo: REPO,
      status: "tracking",
    });
    expect(filtered.total).toBe(3);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list({
        cronId: "consolidation-patrol",
        limit: 2,
        cursor,
      });
      seen.push(...page.findings.map((f) => f.fingerprint));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["fp-4", "fp-3", "fp-2", "fp-1", "fp-0"]);
  });

  it("scopes reads by account and repo; a different agent in scope reads the rows", async () => {
    await service.upsertBatch(input(), { repos: [REPO], accountId: "acct-a" });
    expect(
      (await service.list({}, { repos: [REPO], accountId: "acct-a" })).total,
    ).toBe(1);
    expect(
      (await service.list({}, { repos: [REPO], accountId: "acct-b" })).total,
    ).toBe(0);
    await expect(
      service.list(
        { repo: REPO },
        { repos: ["other/repo"], accountId: "acct-a" },
      ),
    ).rejects.toThrow();
    await expect(
      service.upsertBatch(input(), {
        repos: ["other/repo"],
        accountId: "acct-a",
      }),
    ).rejects.toThrow();
  });
});
