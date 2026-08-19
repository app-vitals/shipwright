/**
 * task-store/src/pull-request-service.integration.test.ts
 *
 * Integration tests for PullRequestService.claim()'s UPDATE-path lost-update
 * race against a real Postgres DB.
 *
 * Distinct from pull-request.integration.test.ts, which covers the CREATE-path
 * race (two claims against an *empty* table — arbitrated by the
 * @@unique([repo, prNumber]) constraint). This file seeds an existing PR row
 * first, then races two more claim() calls at the SAME commitSha/phase against
 * that row, exercising the UPDATE path where the conflict re-check must live in
 * the SQL WHERE clause (not only a pre-update JS `if`) for Postgres to be the
 * sole arbiter under READ COMMITTED.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { ConflictError, NotFoundError } from "./errors.ts";
import { PullRequestService } from "./pull-request-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip(
  "PullRequestService.claim() UPDATE-path race (integration)",
  () => {
    let prisma: PrismaClient;
    let service: PullRequestService;

    beforeEach(async () => {
      prisma = makePrisma();
      service = new PullRequestService(prisma);
      // claim() now writes PullRequestEvent rows (PSA-1.2); the FK is
      // ON DELETE RESTRICT (see schema.prisma), so events must be cleared
      // before their parent PullRequest rows.
      await prisma.pullRequestEvent.deleteMany();
      await prisma.pullRequest.deleteMany();
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    it("concurrent claims (same commitSha/phase) against an EXISTING released record: exactly one wins, the other gets ConflictError", async () => {
      const repo = "app-vitals/shipwright";
      const prNumber = 5100;
      const commitSha = "sha-update-race";

      // Seed an existing, unclaimed record at this commitSha with reviewState
      // 'pending' (so a review-phase claim is legitimately allowed to win). This
      // guarantees both racers take the UPDATE branch (existing !== null), not
      // the CREATE branch — that's the whole point vs. the sibling file's test.
      await prisma.pullRequest.create({
        data: {
          repo,
          prNumber,
          commitSha,
          reviewState: "pending",
          state: "open",
          claimedBy: null,
        },
      });

      // Race two simultaneous claim() calls for phase=review at the same
      // commitSha. Both read the same stale snapshot (claimedBy: null,
      // reviewState: 'pending' → JS-side guards pass for both). Only one UPDATE
      // may actually take the claim; the other must surface ConflictError once
      // the row it tries to update no longer matches the conflict-free WHERE.
      const results = await Promise.allSettled([
        service.claim(
          repo,
          prNumber,
          commitSha,
          "agent-a",
          undefined,
          "review",
        ),
        service.claim(
          repo,
          prNumber,
          commitSha,
          "agent-b",
          undefined,
          "review",
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // The core assertion the fix guarantees: exactly one winner, exactly one
      // ConflictError. Against the pre-fix code both writers could pass the
      // stale JS check and the second's UPDATE (WHERE id = ? only) would
      // silently clobber the first — yielding two fulfilled results.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = fulfilled[0];
      if (winner.status === "fulfilled") {
        expect(winner.value.status).toBe(200);
        expect(winner.value.record.reviewState).toBe("in_progress");
        expect(winner.value.record.claimedBy).not.toBeNull();
        expect(["agent-a", "agent-b"]).toContain(
          winner.value.record.claimedBy ?? "",
        );
      }

      const loser = rejected[0];
      if (loser.status === "rejected") {
        expect(loser.reason).toBeInstanceOf(ConflictError);
      }

      // Exactly one claim landed in the DB, held by the winner.
      const row = await prisma.pullRequest.findUnique({
        where: { repo_prNumber: { repo, prNumber } },
      });
      expect(row).not.toBeNull();
      if (!row) return;
      expect(row.claimedBy).not.toBeNull();
      if (winner.status === "fulfilled") {
        expect(row.claimedBy).toBe(winner.value.record.claimedBy);
      }
      expect(row.reviewState).toBe("in_progress");
    });

    it("sequential claim after a claim on the same commitSha/phase still returns ConflictError (guard preserved)", async () => {
      const repo = "app-vitals/shipwright";
      const prNumber = 5101;
      const commitSha = "sha-sequential-guard";

      // First claim creates + claims the record for review.
      const first = await service.claim(repo, prNumber, commitSha, "agent-a");
      expect(first.record.claimedBy).toBe("agent-a");

      // A second claim at the same commitSha/phase while still claimed must 409
      // — the moved-into-WHERE conflict check must reproduce the old guard
      // exactly, not just for the concurrent case.
      let caught: unknown;
      try {
        await service.claim(
          repo,
          prNumber,
          commitSha,
          "agent-b",
          undefined,
          "review",
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictError);

      // The original claim is untouched.
      const row = await prisma.pullRequest.findUnique({
        where: { repo_prNumber: { repo, prNumber } },
      });
      expect(row?.claimedBy).toBe("agent-a");
    });

    it("legacy review guard (claimed, same commitSha, reviewState !== pending) still surfaces ConflictError via the WHERE clause", async () => {
      const repo = "app-vitals/shipwright";
      const prNumber = 5102;
      const commitSha = "sha-legacy-guard";
      const now = new Date().toISOString();

      // Seed a record already claimed at this commitSha with a non-pending,
      // non-matching phase (phase is null) so ONLY the legacy review guard —
      // not the modern phase guard — is what must reject the claim.
      await prisma.pullRequest.create({
        data: {
          repo,
          prNumber,
          commitSha,
          reviewState: "in_progress",
          state: "open",
          phase: null,
          claimedBy: "agent-x",
          claimedAt: now,
          heartbeatAt: now,
        },
      });

      let caught: unknown;
      try {
        await service.claim(
          repo,
          prNumber,
          commitSha,
          "agent-y",
          undefined,
          "review",
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictError);

      // Still held by the original claimant.
      const row = await prisma.pullRequest.findUnique({
        where: { repo_prNumber: { repo, prNumber } },
      });
      expect(row?.claimedBy).toBe("agent-x");
    });
  },
);

describeOrSkip("PullRequestService.appendFinding() (integration)", () => {
  let prisma: PrismaClient;
  let service: PullRequestService;

  beforeEach(async () => {
    prisma = makePrisma();
    service = new PullRequestService(prisma);
    await prisma.prFinding.deleteMany();
    // PullRequestEvent's FK is ON DELETE RESTRICT — clear before pullRequest,
    // in case an earlier test (this file or another sharing TEST_DB) left rows.
    await prisma.pullRequestEvent.deleteMany();
    await prisma.pullRequest.deleteMany();
  });

  afterEach(async () => {
    await prisma.$disconnect();
  });

  it("persists a finding via the service and a subsequent get() returns it in findings[]", async () => {
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 6100 },
    });

    const finding = await service.appendFinding(pr.id, {
      ref: "src/foo.ts:42",
      disposition: "resolved",
      source: "review",
      evidence: "Fixed the null check in the follow-up commit.",
      at: "2026-08-17T12:00:00.000Z",
    });

    expect(finding.prRecordId).toBe(pr.id);
    expect(finding.ref).toBe("src/foo.ts:42");
    expect(finding.disposition).toBe("resolved");
    expect(finding.source).toBe("review");

    const fetched = await service.get(pr.id);
    expect(fetched).not.toBeNull();
    if (!fetched) return;
    const withFindings = fetched as typeof fetched & {
      findings: Array<{ id: string; ref: string }>;
    };
    expect(withFindings.findings).toHaveLength(1);
    expect(withFindings.findings[0].id).toBe(finding.id);
    expect(withFindings.findings[0].ref).toBe("src/foo.ts:42");
  });

  it("stamps `at` with the current time via the injected Clock when omitted by the caller", async () => {
    const fixedNow = new Date("2026-08-18T00:00:00.000Z");
    const fixedService = new PullRequestService(prisma, {
      now: () => fixedNow,
    });
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 6101 },
    });

    const finding = await fixedService.appendFinding(pr.id, {
      ref: "src/bar.ts:1",
      disposition: "rejected",
      source: "patch",
      evidence: "Not a real issue.",
    });

    expect(finding.at).toBe(fixedNow.toISOString());
  });

  it("throws NotFoundError when the PR does not exist", async () => {
    let caught: unknown;
    try {
      await service.appendFinding("does-not-exist", {
        ref: "src/foo.ts:1",
        disposition: "resolved",
        source: "review",
        evidence: "evidence",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
  });

  it("allows concurrent appendFinding calls for the same PR (race-safe plain INSERT)", async () => {
    const pr = await prisma.pullRequest.create({
      data: { repo: "app-vitals/shipwright", prNumber: 6102 },
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        service.appendFinding(pr.id, {
          ref: `src/concurrent.ts:${i}`,
          disposition: "resolved",
          source: i % 2 === 0 ? "review" : "patch",
          evidence: `finding ${i}`,
          at: "2026-08-17T05:00:00.000Z",
        }),
      ),
    );

    expect(results).toHaveLength(5);

    const fetched = await service.get(pr.id);
    const withFindings = fetched as typeof fetched & {
      findings: unknown[];
    };
    expect(withFindings?.findings).toHaveLength(5);
  });
});

// ─── recordTransition() audit trail (PSA-1.2) ─────────────────────────────────
//
// Exercises each mutation method against a real Postgres DB and asserts the
// PullRequestEvent rows it lands (field/oldValue/newValue/method/actor), plus
// that a bare heartbeat() writes zero rows. Guarded by describeOrSkip like the
// rest of this file — self-skips without DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST.

describeOrSkip(
  "PullRequestService audit trail — PullRequestEvent rows (integration)",
  () => {
    let prisma: PrismaClient;
    let service: PullRequestService;

    beforeEach(async () => {
      prisma = makePrisma();
      service = new PullRequestService(prisma);
      await prisma.pullRequestEvent.deleteMany();
      await prisma.prFinding.deleteMany();
      await prisma.pullRequest.deleteMany();
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    async function events(prRecordId: string) {
      return prisma.pullRequestEvent.findMany({
        where: { prRecordId },
        orderBy: { field: "asc" },
      });
    }

    it("claim() on an existing released record logs the claim transition", async () => {
      const repo = "app-vitals/shipwright";
      const prNumber = 7000;
      const commitSha = "sha-claim-audit";
      await prisma.pullRequest.create({
        data: { repo, prNumber, commitSha, reviewState: "pending" },
      });

      const { record } = await service.claim(
        repo,
        prNumber,
        commitSha,
        "agent-a",
        undefined,
        "review",
      );

      const rows = await events(record.id);
      const byField = Object.fromEntries(rows.map((r) => [r.field, r]));
      // heartbeatAt must never be logged.
      expect(byField.heartbeatAt).toBeUndefined();
      expect(byField.reviewState).toMatchObject({
        oldValue: "pending",
        newValue: "in_progress",
        method: "claim",
        actor: "agent-a",
      });
      expect(byField.claimedBy).toMatchObject({
        oldValue: null,
        newValue: "agent-a",
      });
    });

    it("claim() creating a brand-new record logs zero events (creation is not audited)", async () => {
      const { record } = await service.claim(
        "app-vitals/shipwright",
        7001,
        "sha-new",
        "agent-a",
      );
      expect(await events(record.id)).toHaveLength(0);
    });

    it("claimNext() logs the claim transition with actor = agentId", async () => {
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 7002,
          reviewState: "pending",
          state: "open",
        },
      });

      const result = await service.claimNext("agent-z", 5);
      expect(result).not.toBeNull();

      const rows = await events(pr.id);
      const byField = Object.fromEntries(rows.map((r) => [r.field, r]));
      expect(byField.claimedBy).toMatchObject({
        newValue: "agent-z",
        method: "claimNext",
        actor: "agent-z",
      });
      expect(byField.heartbeatAt).toBeUndefined();
    });

    it("heartbeat() writes zero event rows", async () => {
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 7003,
          claimedBy: "agent-a",
          heartbeatAt: "2026-08-01T00:00:00.000Z",
        },
      });

      await service.heartbeat(pr.id);

      expect(await events(pr.id)).toHaveLength(0);
    });

    it("complete() logs the review-post transition, actor = prior claimant, no heartbeatAt row", async () => {
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 7004,
          reviewState: "in_progress",
          claimedBy: "agent-a",
          claimedAt: "2026-08-01T00:00:00.000Z",
          heartbeatAt: "2026-08-01T01:00:00.000Z",
          phase: "review",
        },
      });

      await service.complete(pr.id);

      const rows = await events(pr.id);
      const fields = rows.map((r) => r.field);
      expect(fields).not.toContain("heartbeatAt");
      expect(fields).toEqual(
        expect.arrayContaining([
          "reviewState",
          "reviewCycles",
          "reviewedAt",
          "readyForPatchAt",
          "claimedBy",
          "claimedAt",
          "phase",
        ]),
      );
      for (const r of rows) {
        expect(r.method).toBe("complete");
        expect(r.actor).toBe("agent-a");
      }
    });

    it("patch() logs the commitSha + reviewState transition", async () => {
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 7005,
          commitSha: "old-sha",
          reviewState: "posted",
          claimedBy: "agent-b",
        },
      });

      await service.patch(pr.id, "new-sha");

      const byField = Object.fromEntries(
        (await events(pr.id)).map((r) => [r.field, r]),
      );
      expect(byField.commitSha).toMatchObject({
        oldValue: "old-sha",
        newValue: "new-sha",
        method: "patch",
        actor: "agent-b",
      });
      expect(byField.reviewState).toMatchObject({
        oldValue: "posted",
        newValue: "pending",
      });
    });

    it("release() logs the claim-clear transition, actor = prior claimant", async () => {
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 7006,
          reviewState: "in_progress",
          claimedBy: "agent-c",
          claimedAt: "2026-08-01T00:00:00.000Z",
        },
      });

      await service.release(pr.id);

      const byField = Object.fromEntries(
        (await events(pr.id)).map((r) => [r.field, r]),
      );
      expect(byField.claimedBy).toMatchObject({
        oldValue: "agent-c",
        newValue: null,
        method: "release",
        actor: "agent-c",
      });
      expect(byField.reviewState).toMatchObject({
        oldValue: "in_progress",
        newValue: "pending",
      });
    });

    it("recordSkip() crossing the block threshold logs skipCount + blocked in one method", async () => {
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 7007,
          skipCount: 2,
        },
      });

      await service.recordSkip(pr.id);

      const byField = Object.fromEntries(
        (await events(pr.id)).map((r) => [r.field, r]),
      );
      expect(byField.skipCount).toMatchObject({
        oldValue: "2",
        newValue: "3",
        method: "recordSkip",
        // Unclaimed PR → actor attributed to "system".
        actor: "system",
      });
      expect(byField.blocked).toMatchObject({
        oldValue: "false",
        newValue: "true",
      });
    });

    it("resetSkip() logs skipCount reset and block-clear", async () => {
      const pr = await prisma.pullRequest.create({
        data: {
          repo: "app-vitals/shipwright",
          prNumber: 7008,
          skipCount: 3,
          blocked: true,
          blockedReason:
            "Auto-blocked after 3 consecutive skips (dispatched but found nothing to do)",
        },
      });

      await service.resetSkip(pr.id);

      const byField = Object.fromEntries(
        (await events(pr.id)).map((r) => [r.field, r]),
      );
      expect(byField.skipCount).toMatchObject({
        oldValue: "3",
        newValue: "0",
        method: "resetSkip",
      });
      expect(byField.blocked).toMatchObject({
        oldValue: "true",
        newValue: "false",
      });
    });
  },
);
