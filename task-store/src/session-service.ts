/**
 * task-store/src/session-service.ts
 * SessionService — upserts Session rows in lockstep with Task writes.
 *
 * v1 scope (SESH-1.2): upsert only. get/list/update/purge land in later
 * tasks. Task.session (String?) is a free-text field that maps 1:1 to
 * Session.slug whenever it's non-blank — a task write with a blank/absent
 * session performs no Session write at all (see isBlankSession below).
 *
 * upsert() is designed to run inside the SAME transaction as the Task write
 * that triggers it: it accepts an explicit tx-compatible client
 * (PrismaTxClient, mirrors the identically-named alias in task-service.ts /
 * pull-request-service.ts) rather than always reaching for `this.prisma`, so
 * TaskService.create()/bulk() can hand it the same `tx` their task write ran
 * on and get one atomic write across both tables.
 */

import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";
import type { Prisma, PrismaClient } from "./index.ts";

/**
 * The Prisma client surface shared by the top-level client and a
 * $transaction callback's `tx`. Mirrors PrismaTxClient in task-service.ts /
 * pull-request-service.ts — upsert() accepts this so it can run against
 * either, though in practice its only caller (TaskService) always hands it
 * the same `tx` the paired task write ran on.
 */
export type PrismaTxClient = Pick<Prisma.TransactionClient, "session">;

/**
 * True when `session` should be treated as absent for the purposes of the
 * Session upsert hook: null, undefined, or a string that is empty or
 * whitespace-only. Pure logic, no I/O — kept as a standalone export so it
 * has its own fast unit test (session-service.unit.test.ts) distinct from
 * the DB-backed integration coverage of upsert() itself.
 */
export function isBlankSession(session: string | null | undefined): boolean {
  return (
    session === null || session === undefined || session.trim().length === 0
  );
}

export class SessionService {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
  ) {}

  /**
   * Upsert the Session row implied by a task write's `session` value.
   *
   * - Blank (see isBlankSession): a pure no-op — does not touch the DB at
   *   all, so tasks with session: null/""/"   " never create a Session row.
   * - The actual write is Prisma's native `upsert()` — a single atomic
   *   `INSERT ... ON CONFLICT (slug) DO UPDATE` statement, not a separate
   *   findUnique-then-create/update. That matters under concurrency: two
   *   overlapping task writes into the same brand-new slug both running a
   *   plain findUnique-then-create would race on the create(), and a caught
   *   P2002 from *inside* a Prisma interactive transaction doesn't actually
   *   recover it — Postgres marks the whole transaction aborted after any
   *   failed statement, so a subsequent COMMIT silently discards it
   *   (including the already-successful Task insert) without Prisma
   *   surfacing an error. A single-statement ON CONFLICT upsert has no such
   *   window: it always cleanly creates-or-updates, never errors on a
   *   concurrent slug collision.
   * - `create` sets only `slug` — this call site has no title to provide, so
   *   `title` is left null and `createdAt`/`updatedAt` fall back to their
   *   schema defaults.
   * - `update` sets only `archivedAt: null` — `title` and `createdAt` are
   *   never part of the update payload, so a second write into the same
   *   session can't overwrite an already-set title or reset createdAt.
   *   Setting `archivedAt: null` un-archives a currently-archived row; it's
   *   a harmless no-op value-wise when the row is already un-archived
   *   (though Prisma still issues the UPDATE, bumping `updatedAt`).
   *
   * The pre-write `findUnique` read below exists solely to decide whether to
   * log an un-archive transition (mirroring StaleClaimReaper's console.log
   * convention — no TaskEvent-style audit row for v1); it never gates the
   * write's correctness, so a stale read under concurrency can at worst
   * suppress or emit one log line, never corrupt data.
   */
  async upsert(
    client: PrismaTxClient,
    session: string | null | undefined,
  ): Promise<void> {
    if (isBlankSession(session)) return;
    // Non-null/undefined per isBlankSession's guard above.
    const slug = session as string;

    const existing = await client.session.findUnique({ where: { slug } });

    await client.session.upsert({
      where: { slug },
      create: { slug },
      update: { archivedAt: null },
    });

    if (existing?.archivedAt) {
      console.log(
        `[session-service] un-archived session "${slug}" on task write at ${this.clock.now().toISOString()}`,
      );
    }
  }
}
