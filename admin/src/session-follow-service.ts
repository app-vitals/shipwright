/**
 * admin/src/session-follow-service.ts
 * SessionFollowService — CRUD over SessionFollow + UserNotificationPrefs
 * (SessionAlertState is written by the future reminder job, not this
 * service; the model exists now so that job has a place to land state
 * without a follow-up migration). unfollow() is the one exception: it also
 * deletes the caller's SessionAlertState row for the slug, as a cleanup of
 * stale alert-cooldown state on unfollow, not a write of new alert state.
 *
 * Follows the push-service.ts Prisma-owner pattern: a narrow *PrismaLike
 * interface scoped to only the models/methods this service touches, so
 * tests can inject a plain object double instead of a real client.
 */

import { type Clock, SystemClock } from "./clock.ts";
import { BadRequestError } from "./errors.ts";

// The narrow slice of PrismaClient this service touches. Injected so unit
// tests (and any future callers) can use a plain object double instead of a
// real client.
export interface SessionFollowPrismaLike {
  sessionFollow: {
    upsert(args: {
      where: {
        userEmail_sessionSlug: { userEmail: string; sessionSlug: string };
      };
      create: { userEmail: string; sessionSlug: string };
      update: { muted: boolean };
    }): Promise<SessionFollowRow>;
    deleteMany(args: {
      where: { userEmail: string; sessionSlug: string };
    }): Promise<{ count: number }>;
    findMany(args: {
      where: { userEmail: string };
    }): Promise<SessionFollowRow[]>;
  };
  sessionAlertState: {
    deleteMany(args: {
      where: { userEmail: string; sessionSlug: string };
    }): Promise<{ count: number }>;
  };
  userNotificationPrefs: {
    upsert(args: {
      where: { userEmail: string };
      create: { userEmail: string };
      update: Record<string, never>;
    }): Promise<UserNotificationPrefsRow>;
    update(args: {
      where: { userEmail: string };
      data: Partial<{
        autoFollowSessions: boolean;
        reminderHourLocal: number;
        autoFollowSince: Date;
      }>;
    }): Promise<UserNotificationPrefsRow>;
  };
}

export interface SessionFollowRow {
  id: string;
  userEmail: string;
  sessionSlug: string;
  muted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserNotificationPrefsRow {
  userEmail: string;
  autoFollowSessions: boolean;
  reminderHourLocal: number;
  autoFollowSince: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields updatePrefs() accepts. Omitted fields are left untouched. */
export interface UpdatePrefsInput {
  autoFollowSessions?: boolean;
  reminderHourLocal?: number;
}

export class SessionFollowService {
  private readonly clock: Clock;

  constructor(
    private readonly prisma: SessionFollowPrismaLike,
    clock?: Clock,
  ) {
    this.clock = clock ?? SystemClock();
  }

  /**
   * Follows a session for a user. Idempotent: re-following an already-
   * followed session un-mutes it rather than erroring, since the unique
   * constraint on [userEmail, sessionSlug] means there is exactly one row
   * per pair — upsert is the natural fit.
   */
  async follow(
    userEmail: string,
    sessionSlug: string,
  ): Promise<SessionFollowRow> {
    return this.prisma.sessionFollow.upsert({
      where: { userEmail_sessionSlug: { userEmail, sessionSlug } },
      create: { userEmail, sessionSlug },
      update: { muted: false },
    });
  }

  /**
   * Unfollows a session for a user. Idempotent: unfollowing a session the
   * user never followed (or already unfollowed) is a no-op, not an error —
   * deleteMany matches zero rows silently rather than throwing like delete()
   * would on a missing unique key. Also clears the user's SessionAlertState
   * row for this slug (if any) — a stale cooldown timestamp for a session
   * the user no longer follows shouldn't linger and affect a future re-follow;
   * deleteMany against the same [userEmail, sessionSlug] unique key is
   * idempotent here too.
   */
  async unfollow(userEmail: string, sessionSlug: string): Promise<void> {
    await Promise.all([
      this.prisma.sessionFollow.deleteMany({
        where: { userEmail, sessionSlug },
      }),
      this.prisma.sessionAlertState.deleteMany({
        where: { userEmail, sessionSlug },
      }),
    ]);
  }

  /** All sessions a user currently follows (muted or not). */
  async listByUser(userEmail: string): Promise<SessionFollowRow[]> {
    return this.prisma.sessionFollow.findMany({ where: { userEmail } });
  }

  /**
   * Returns the user's notification prefs, creating a default-valued row on
   * first call. Uses upsert with an empty `update` so a concurrent first
   * call from two requests can't race into a duplicate-key error — the
   * loser just gets back the winner's row.
   */
  async getOrCreatePrefs(userEmail: string): Promise<UserNotificationPrefsRow> {
    return this.prisma.userNotificationPrefs.upsert({
      where: { userEmail },
      create: { userEmail },
      update: {},
    });
  }

  /**
   * Updates (upserting if absent) a user's notification prefs. Validates
   * reminderHourLocal is an integer in [0, 23] — a local hour-of-day, so
   * anything outside that range is a client input error (400), not a server
   * failure.
   */
  async updatePrefs(
    userEmail: string,
    input: UpdatePrefsInput,
  ): Promise<UserNotificationPrefsRow> {
    if (input.reminderHourLocal !== undefined) {
      const hour = input.reminderHourLocal;
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new BadRequestError(
          `reminderHourLocal must be an integer in [0, 23], got ${hour}`,
        );
      }
    }

    // Ensure a row exists first so `update` below always has one to modify —
    // upsert's `update` clause can't express "only touch provided fields"
    // conditionally, so we do the empty-upsert-then-update dance instead.
    const current = await this.getOrCreatePrefs(userEmail);

    // Stamp the opt-in moment the first time a user explicitly turns
    // auto-follow on. session-alert-sweeper.ts reads `autoFollowSince` as the
    // backfill boundary — without this write it would stay null forever and
    // the boundary could never apply. Only set on a genuine off→on (or
    // never-stamped) transition, so re-saving the form with the box already
    // ticked doesn't silently move the boundary forward.
    const stampAutoFollowSince =
      input.autoFollowSessions === true &&
      (!current.autoFollowSessions || current.autoFollowSince === null);

    return this.prisma.userNotificationPrefs.update({
      where: { userEmail },
      data: {
        ...(input.autoFollowSessions !== undefined
          ? { autoFollowSessions: input.autoFollowSessions }
          : {}),
        ...(stampAutoFollowSince ? { autoFollowSince: this.clock.now() } : {}),
        ...(input.reminderHourLocal !== undefined
          ? { reminderHourLocal: input.reminderHourLocal }
          : {}),
      },
    });
  }
}
