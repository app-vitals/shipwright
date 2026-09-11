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
   * - No existing row for the slug: created with just `slug` set — this call
   *   site has no title to provide, so `title` is left null and
   *   createdAt/updatedAt fall back to their schema defaults.
   * - Existing row: `title` and `createdAt` are never part of the update
   *   payload, so a second write into the same session can't overwrite an
   *   already-set title or reset createdAt. If the row is currently archived
   *   (archivedAt !== null), the write un-archives it (archivedAt: null) and
   *   logs the transition, mirroring StaleClaimReaper's console.log
   *   convention — no TaskEvent-style audit row for v1.
   */
  async upsert(
    client: PrismaTxClient,
    session: string | null | undefined,
  ): Promise<void> {
    if (isBlankSession(session)) return;
    // Non-null/undefined per isBlankSession's guard above.
    const slug = session as string;

    const existing = await client.session.findUnique({ where: { slug } });

    if (!existing) {
      await client.session.create({ data: { slug } });
      return;
    }

    if (existing.archivedAt !== null) {
      await client.session.update({
        where: { slug },
        data: { archivedAt: null },
      });
      console.log(
        `[session-service] un-archived session "${slug}" on task write at ${this.clock.now().toISOString()}`,
      );
    }
    // Row exists and isn't archived: nothing to change — title/createdAt are
    // deliberately left untouched by a task write.
  }
}
