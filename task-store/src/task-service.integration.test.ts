/**
 * task-store/src/task-service.integration.test.ts
 *
 * Integration tests for TaskService.claim()'s atomic-UPDATE concurrent-claim
 * race against a real Postgres DB.
 *
 * Mirrors pull-request-service.integration.test.ts's harness and race
 * pattern, scoped to TaskService.claim()'s simpler two-argument signature
 * (id, claimedBy). Unlike PullRequestService.claim() (keyed on
 * repo/prNumber/commitSha/phase with both a CREATE and an UPDATE path),
 * TaskService.claim() only ever updates an existing row via a single
 * conditional UPDATE — `WHERE id = $1 AND status = 'pending' AND
 * "claimedBy" IS NULL` — so the race to exercise here is two concurrent
 * claim() calls against the SAME seeded pending row.
 *
 * Requires DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST to be set; skips otherwise.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { PrismaClient } from "../prisma/client/index.js";
import { ConflictError } from "./errors.ts";
import { TaskService } from "./task-service.ts";

const TEST_DB = process.env.DATABASE_URL_SHIPWRIGHT_TASK_STORE_TEST;

const describeOrSkip = TEST_DB ? describe : describe.skip;

function makePrisma(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: TEST_DB as string } },
  });
}

describeOrSkip(
  "TaskService.claim() concurrent-claim race (integration)",
  () => {
    let prisma: PrismaClient;
    let service: TaskService;

    beforeEach(async () => {
      prisma = makePrisma();
      service = new TaskService(prisma);
      // TaskEvent's FK is ON DELETE RESTRICT (TCS-1.1) — clear event rows
      // before their parent Task rows, since claim()/etc. write them.
      await prisma.taskEvent.deleteMany();
      await prisma.task.deleteMany();
    });

    afterEach(async () => {
      await prisma.$disconnect();
    });

    it("concurrent claims against the SAME seeded pending row: exactly one wins, the other gets ConflictError", async () => {
      // Seed a single pending, unclaimed task row.
      const task = await prisma.task.create({
        data: { title: "concurrent-claim-race", status: "pending" },
      });

      // Race two simultaneous claim() calls for the same task id. Both read
      // the same stale snapshot conceptually, but claim() itself never does a
      // pre-update JS read/check — the conflict guard lives entirely in the
      // UPDATE's WHERE clause (status = 'pending' AND "claimedBy" IS NULL), so
      // Postgres is the sole arbiter under READ COMMITTED: only one UPDATE can
      // affect the row, the other affects zero rows and must throw
      // ConflictError.
      const results = await Promise.allSettled([
        service.claim(task.id, "agent-a"),
        service.claim(task.id, "agent-b"),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // The core assertion the atomic UPDATE guarantees: exactly one winner,
      // exactly one ConflictError. If the conflict check instead lived only in
      // application JS (a read-then-write race), both writers could pass a
      // stale check and clobber each other — yielding two fulfilled results.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const winner = fulfilled[0];
      if (winner.status === "fulfilled") {
        expect(winner.value.status).toBe("in_progress");
        expect(winner.value.claimedBy).not.toBeNull();
        expect(["agent-a", "agent-b"]).toContain(winner.value.claimedBy ?? "");
        expect(winner.value.claimedAt).not.toBeNull();
        expect(winner.value.heartbeatAt).not.toBeNull();
      }

      const loser = rejected[0];
      if (loser.status === "rejected") {
        expect(loser.reason).toBeInstanceOf(ConflictError);
      }

      // Exactly one claim landed in the DB, held by the winner.
      const row = await prisma.task.findUnique({ where: { id: task.id } });
      expect(row).not.toBeNull();
      if (!row) return;
      expect(row.status).toBe("in_progress");
      expect(row.claimedBy).not.toBeNull();
      if (winner.status === "fulfilled") {
        expect(row.claimedBy).toBe(winner.value.claimedBy);
      }
      expect(row.claimedAt).not.toBeNull();
      expect(row.heartbeatAt).not.toBeNull();
    });

    it("sequential claim after a claim on the same task still returns ConflictError (guard preserved)", async () => {
      const task = await prisma.task.create({
        data: { title: "sequential-claim-guard", status: "pending" },
      });

      // First claim wins outright.
      const first = await service.claim(task.id, "agent-a");
      expect(first.claimedBy).toBe("agent-a");
      expect(first.status).toBe("in_progress");

      // A second claim on the same, now-already-claimed row must 409 — the
      // WHERE clause's "claimedBy" IS NULL guard must reject it just as
      // reliably in the sequential case as in the concurrent race above.
      let caught: unknown;
      try {
        await service.claim(task.id, "agent-b");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConflictError);

      // The original claim is untouched.
      const row = await prisma.task.findUnique({ where: { id: task.id } });
      expect(row?.claimedBy).toBe("agent-a");
      expect(row?.status).toBe("in_progress");
    });

    it("claim() writes exactly the expected TaskEvent rows atomically (TCS-1.1)", async () => {
      const task = await prisma.task.create({
        data: { title: "claim-writes-task-events", status: "pending" },
      });

      const claimed = await service.claim(task.id, "agent-a");
      expect(claimed.status).toBe("in_progress");

      const events = await prisma.taskEvent.findMany({
        where: { taskId: task.id },
        orderBy: { field: "asc" },
      });

      // claim() changes status/claimedBy/claimedAt/startedAt/heartbeatAt in
      // the underlying UPDATE, but heartbeatAt is excluded from the audit
      // trail entirely (computeTaskTransitionDiff's TASK_AUDITED_FIELDS
      // allowlist omits it) — so exactly 4 rows are expected, one per
      // audited field that actually changed.
      const byField = Object.fromEntries(events.map((e) => [e.field, e]));
      expect(Object.keys(byField).sort()).toEqual(
        ["claimedAt", "claimedBy", "startedAt", "status"].sort(),
      );

      expect(byField.status.oldValue).toBe("pending");
      expect(byField.status.newValue).toBe("in_progress");
      expect(byField.status.method).toBe("claim");
      expect(byField.status.actor).toBe("agent-a");

      expect(byField.claimedBy.oldValue).toBeNull();
      expect(byField.claimedBy.newValue).toBe("agent-a");

      expect(byField.claimedAt.oldValue).toBeNull();
      expect(byField.claimedAt.newValue).not.toBeNull();

      expect(byField.startedAt.oldValue).toBeNull();
      expect(byField.startedAt.newValue).not.toBeNull();

      // No heartbeatAt row exists at all — confirms the exclusion holds even
      // though claim() does write heartbeatAt on the Task row itself.
      expect(byField.heartbeatAt).toBeUndefined();

      // Every row from this single claim() call shares the same `at` stamp —
      // confirms they were written together as one transition, not drifting
      // timestamps from separate writes.
      const atValues = new Set(events.map((e) => e.at));
      expect(atValues.size).toBe(1);
    });

    it("remove() deletes a task that has TaskEvent rows, without a foreign-key violation (TCS-1.1)", async () => {
      const task = await prisma.task.create({
        data: { title: "remove-with-events", status: "pending" },
      });
      await service.claim(task.id, "agent-a");

      const eventsBefore = await prisma.taskEvent.count({
        where: { taskId: task.id },
      });
      expect(eventsBefore).toBeGreaterThan(0);

      // TaskEvent's FK is ON DELETE RESTRICT — a naive prisma.task.delete()
      // would throw a foreign-key violation here. remove() must clear the
      // task's TaskEvent rows first, in the same transaction.
      await service.remove(task.id);

      const row = await prisma.task.findUnique({ where: { id: task.id } });
      expect(row).toBeNull();

      const eventsAfter = await prisma.taskEvent.count({
        where: { taskId: task.id },
      });
      expect(eventsAfter).toBe(0);
    });

    it("getEvents() returns rows from both a claim() and a subsequent release(), ordered oldest-first (TCS-1.2)", async () => {
      const task = await prisma.task.create({
        data: { title: "claim-then-release-events", status: "pending" },
      });

      await service.claim(task.id, "agent-x");
      await service.release(task.id);

      const result = await service.getEvents(task.id);

      // claim() writes 4 rows (status/claimedBy/claimedAt/startedAt) and
      // release() writes 3 rows (status/claimedBy/claimedAt) — both
      // transitions' rows must be present in the audit trail.
      expect(result.total).toBe(7);
      expect(result.events).toHaveLength(7);

      const claimEvents = result.events.filter((e) => e.method === "claim");
      const releaseEvents = result.events.filter(
        (e) => e.method === "release",
      );
      expect(claimEvents).toHaveLength(4);
      expect(releaseEvents).toHaveLength(3);

      // Ordered oldest-first by `at` — every claim() row must precede every
      // release() row given the sequential await above.
      const claimAts = claimEvents.map((e) => e.at);
      const releaseAts = releaseEvents.map((e) => e.at);
      const maxClaimAt = claimAts.sort().at(-1) as string;
      const minReleaseAt = releaseAts.sort()[0] as string;
      expect(maxClaimAt <= minReleaseAt).toBe(true);

      // The returned array itself is sorted ascending by `at`.
      const ats = result.events.map((e) => e.at);
      const sortedAts = [...ats].sort();
      expect(ats).toEqual(sortedAts);

      // Spot-check the status transition rows from each phase.
      const statusClaim = claimEvents.find((e) => e.field === "status");
      expect(statusClaim?.oldValue).toBe("pending");
      expect(statusClaim?.newValue).toBe("in_progress");

      const statusRelease = releaseEvents.find((e) => e.field === "status");
      expect(statusRelease?.oldValue).toBe("in_progress");
      expect(statusRelease?.newValue).toBe("pending");
    });
  },
);
