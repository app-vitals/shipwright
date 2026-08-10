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
import { ConflictError } from "./errors.ts";
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
