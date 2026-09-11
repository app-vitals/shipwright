/**
 * admin/src/session-alert-sweeper.ts
 *
 * SessionAlertSweeper — the admin service's first background loop (SESH-7.4).
 * Every tick it:
 *
 *   1. Fetches the task-store's `waiting` and `closed` sessions (injected
 *      fetcher — the sessions live in the task-store service, not admin's DB).
 *   2. Materializes auto-follows for users with `autoFollowSessions = true`
 *      who can see a waiting session, don't already have a SessionFollow row,
 *      and whose auto-follow boundary — `autoFollowSince`, else the prefs row's
 *      `createdAt` — predates the session.
 *   3. Sends one `immediate` push the first time a follower is alerted about a
 *      waiting session, and at most one `reminder` per later local day once
 *      that user's `reminderHourLocal` has passed.
 *   4. Sends one `completed` push per follower of a closed session, then deletes
 *      that pair's SessionFollow + SessionAlertState rows so it never fires again.
 *   5. Prunes the SessionAlertState row of any follower who has lost visibility
 *      of the session (membership revoked / repo removed) — and sends them
 *      nothing.
 *
 * Structure mirrors chat/src/stall-reaper.ts: an injected Clock, a per-row
 * try/catch so one bad session or follower can never abort the sweep, a
 * counted return value, and registration via `setInterval` in main.ts (NEVER
 * inside an app factory, which must stay side-effect-free).
 *
 * Re-entrancy note — unlike the stall reaper (whose sweep is idempotent and
 * therefore safe to run concurrently), this sweeper's dedup is a read-then-
 * write straddling network I/O: `sessionAlertState.findMany()` →
 * `pushService.notifySession()` → `stampAlertState()`. Two overlapping ticks
 * would both observe `lastAlertedAt = null` and both push, so `tick()` carries
 * an in-flight guard and returns an all-zero result rather than starting a
 * second concurrent sweep. (That guard is per-process; running more than one
 * admin replica needs a shared lock, which this task does not introduce.)
 *
 * Dedup design note — SessionAlertState carries exactly one nullable
 * `lastAlertedAt` column and deliberately has no "kind" column (see
 * admin/prisma/schema.prisma). So the alert kind is *derived* rather than
 * stored: a null/absent `lastAlertedAt` means "never alerted" → immediate;
 * otherwise a reminder is due only once the local calendar day has advanced
 * past the day of `lastAlertedAt` AND the local hour has reached the user's
 * `reminderHourLocal`. Stamping `lastAlertedAt = now` after every send is what
 * makes "exactly one push per user per session per day" fall out for free, with
 * no migration needed.
 *
 * Known limitation: an explicit unfollow deletes the SessionFollow row
 * outright (SessionFollowService.unfollow), leaving no tombstone, so a user
 * with `autoFollowSessions = true` will be re-auto-followed on the next tick.
 * Distinguishing "never followed" from "explicitly unfollowed" needs a schema
 * column that doesn't exist yet; users who don't want that today turn
 * `autoFollowSessions` off.
 */

import { type Clock, SystemClock } from "./clock.ts";
import { type PushDetailLevel, resolveDetailLevel } from "./push-content.ts";
import type { PushService } from "./push-service.ts";
import type {
  SessionFollowRow,
  UserNotificationPrefsRow,
} from "./session-follow-service.ts";
import {
  type VisibilityScope,
  isSessionVisible,
  visibleAgentIdsFor,
} from "./session-scope.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A SessionAlertState row (admin/prisma/schema.prisma). */
export interface SessionAlertStateRow {
  id: string;
  userEmail: string;
  sessionSlug: string;
  lastAlertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The narrow slice of PrismaClient this sweeper touches — same *PrismaLike
 * pattern as push-service.ts / session-follow-service.ts, so tests inject a
 * plain object double instead of a real client.
 */
export interface SessionAlertPrismaLike {
  sessionFollow: {
    findMany(args: {
      where: { sessionSlug: string };
    }): Promise<SessionFollowRow[]>;
    upsert(args: {
      where: {
        userEmail_sessionSlug: { userEmail: string; sessionSlug: string };
      };
      create: { userEmail: string; sessionSlug: string };
      update: Record<string, never>;
    }): Promise<SessionFollowRow>;
    deleteMany(args: {
      where: { userEmail: string; sessionSlug: string };
    }): Promise<{ count: number }>;
  };
  sessionAlertState: {
    findMany(args: {
      where: { sessionSlug: string };
    }): Promise<SessionAlertStateRow[]>;
    upsert(args: {
      where: {
        userEmail_sessionSlug: { userEmail: string; sessionSlug: string };
      };
      create: {
        userEmail: string;
        sessionSlug: string;
        lastAlertedAt: Date;
      };
      update: { lastAlertedAt: Date };
    }): Promise<SessionAlertStateRow>;
    deleteMany(args: {
      where: { userEmail: string; sessionSlug: string };
    }): Promise<{ count: number }>;
  };
  userNotificationPrefs: {
    findMany(): Promise<UserNotificationPrefsRow[]>;
  };
}

/**
 * The fields of a task-store Session (task-store/src/openapi-schemas.ts's
 * SessionSchema) the sweeper actually needs. Declared locally rather than
 * imported so admin keeps no compile-time dependency on the task-store package.
 */
export interface SessionForAlert {
  slug: string;
  title?: string | null;
  agentIds: string[];
  repos: string[];
  /**
   * ISO timestamps the auto-follow opt-in boundary is measured against —
   * `waitingSince` when the task-store has one, `createdAt` otherwise. Both
   * optional so a caller (or fixture) that omits them simply opts out of the
   * boundary check rather than being rejected.
   */
  waitingSince?: string | null;
  createdAt?: string | null;
}

/** Per-tick counters, also the value `tick()` resolves to. */
export interface SessionAlertSweepResult {
  immediate: number;
  reminders: number;
  completions: number;
  pruned: number;
}

/**
 * The one method of AgentMemberService the sweeper calls, narrowed to the one
 * field it reads off each row. Structural (rather than
 * `Pick<AgentMemberService, "listByEmail">`) for the same reason
 * session-scope.ts declares its own MembershipForScope: the real service
 * satisfies it, and test doubles don't have to fabricate a full AgentMember.
 */
export interface MembershipLookup {
  listByEmail(email: string): Promise<Array<{ agentId: string }>>;
}

/** Likewise for AgentService.listByIds — only `repos` is read. */
export interface AgentReposLookup {
  listByIds(ids: string[]): Promise<Array<{ repos?: string[] }>>;
}

export interface SessionAlertSweeperDeps {
  prisma: SessionAlertPrismaLike;
  pushService: Pick<PushService, "notifySession">;
  agentMemberService: MembershipLookup;
  agentService: AgentReposLookup;
  /**
   * Fetches the task-store sessions in the given state. Injected (rather than
   * calling fetch() in here) so tests use a plain async function and never
   * touch global.fetch.
   */
  fetchSessions: (state: "waiting" | "closed") => Promise<SessionForAlert[]>;
  clock?: Clock;
  /** IANA timezone the daily reminder boundary is evaluated in. */
  timezone?: string;
  /**
   * Per-call detail ceiling handed to PushService.notifySession. Typed
   * `| string` because main.ts threads the raw
   * `SHIPWRIGHT_ADMIN_PUSH_MAX_DETAIL` env value straight through (exactly as
   * PushService receives it); the constructor normalizes it.
   */
  detailLevel?: PushDetailLevel | string;
}

/** Matches UserNotificationPrefs.reminderHourLocal's schema default. */
export const DEFAULT_REMINDER_HOUR_LOCAL = 9;

/** Matches admin-ui-pages.ts's default for the same SHIPWRIGHT_ADMIN_TZ concept. */
export const DEFAULT_ALERT_TIMEZONE = "America/Los_Angeles";

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * The `YYYY-MM-DD` local calendar date of `date` in `timezone`. Two timestamps
 * sharing a key fall on the same local day, which is the whole dedup rule for
 * daily reminders. `en-CA` is the locale whose short date format is already
 * ISO-ordered, so no part re-assembly is needed.
 */
export function localDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * The local hour-of-day (0–23) of `date` in `timezone`. The `% 24` normalizes
 * the "24" some ICU builds emit for midnight under `hour12: false`.
 */
export function localHour(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const raw = parts.find((part) => part.type === "hour")?.value ?? "0";
  return (Number.parseInt(raw, 10) || 0) % 24;
}

/**
 * Decide which alert (if any) a waiting-session follower is due, given only
 * the single `lastAlertedAt` timestamp the schema stores:
 *
 *   - never alerted            → "immediate"
 *   - alerted earlier today    → null (already covered this local day)
 *   - alerted on an earlier day, local hour >= reminderHourLocal → "reminder"
 *   - alerted on an earlier day, but too early in the day        → null
 */
export function resolveWaitingAlertKind(
  lastAlertedAt: Date | null,
  now: Date,
  reminderHourLocal: number,
  timezone: string,
): "immediate" | "reminder" | null {
  if (!lastAlertedAt) return "immediate";
  if (localDateKey(lastAlertedAt, timezone) === localDateKey(now, timezone)) {
    return null;
  }
  return localHour(now, timezone) >= reminderHourLocal ? "reminder" : null;
}

/**
 * Whether `session` was already waiting before a user's auto-follow opt-in,
 * i.e. whether auto-follow should skip it as pre-opt-in backlog.
 *
 * Returns `false` (don't skip) whenever the question can't be answered:
 * `since` is null (no prefs row at all — such a user is never in
 * `autoFollowEmails` to begin with), or the task-store gave us no usable
 * timestamp. Erring toward following preserves the pre-existing behavior for
 * those cases rather than silently dropping follows on unparseable input.
 */
export function startedWaitingBefore(
  session: SessionForAlert,
  since: Date | null,
): boolean {
  if (!since) return false;
  const startedAt = session.waitingSince ?? session.createdAt;
  if (!startedAt) return false;
  const ts = new Date(startedAt).getTime();
  if (Number.isNaN(ts)) return false;
  return ts < since.getTime();
}

/**
 * The auto-follow boundary for a user: the moment from which auto-follow
 * applies. `autoFollowSince` when the user explicitly toggled auto-follow on;
 * otherwise the prefs row's own `createdAt`.
 *
 * The `createdAt` fallback matters because `autoFollowSessions` defaults to
 * true and a prefs row is created merely by loading the settings page — so
 * most rows are never explicitly stamped. Treating those as "no boundary"
 * would let the first sweep after the row appears back-follow (and immediately
 * push) the entire pre-existing waiting backlog. The row's creation is the
 * earliest moment auto-follow can meaningfully be "on" for that user, so it is
 * the correct implicit boundary. Rows that predate the sweeper are stamped
 * once by the 20260911000000_backfill_auto_follow_since migration, which pins
 * their boundary at deploy time rather than at row creation.
 */
export function autoFollowBoundary(
  prefs:
    | Pick<UserNotificationPrefsRow, "autoFollowSince" | "createdAt">
    | undefined,
): Date | null {
  if (!prefs) return null;
  return prefs.autoFollowSince ?? prefs.createdAt;
}

// ─── Sweeper ────────────────────────────────────────────────────────────────

export class SessionAlertSweeper {
  private readonly clock: Clock;
  private readonly timezone: string;
  private readonly detailLevel: PushDetailLevel;
  /** True while a sweep is running — see the re-entrancy note in the header. */
  private sweeping = false;

  constructor(private readonly deps: SessionAlertSweeperDeps) {
    this.clock = deps.clock ?? SystemClock();
    this.timezone = deps.timezone ?? DEFAULT_ALERT_TIMEZONE;
    // `detailLevel` may be an unvalidated env string. resolveDetailLevel with
    // the most permissive opt-in returns the ceiling itself when it's a valid
    // level and DEFAULT_MAX_DETAIL ("title") when it's unset or garbage — the
    // same fallback PushService applies internally.
    this.detailLevel = resolveDetailLevel(deps.detailLevel, "preview");
  }

  /**
   * One sweep. Never throws: input-gathering failures short-circuit to an
   * all-zero result (sending nothing), and every per-session / per-follower
   * step is individually try/caught so one bad row can't abort the rest.
   *
   * Not re-entrant by design: if a previous sweep is still in flight (a slow
   * task-store fetch under a short `SHIPWRIGHT_ADMIN_SESSION_ALERT_INTERVAL_MS`
   * is the realistic trigger), this call returns all-zero immediately rather
   * than racing it. Skipping is safe — the next tick picks up whatever the
   * in-flight sweep leaves behind.
   */
  async tick(): Promise<SessionAlertSweepResult> {
    if (this.sweeping) {
      console.warn(
        "[session-alert-sweeper] previous tick still in flight — skipping",
      );
      return { immediate: 0, reminders: 0, completions: 0, pruned: 0 };
    }
    this.sweeping = true;
    try {
      return await this.sweep();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweep(): Promise<SessionAlertSweepResult> {
    const result: SessionAlertSweepResult = {
      immediate: 0,
      reminders: 0,
      completions: 0,
      pruned: 0,
    };

    let waiting: SessionForAlert[];
    let closed: SessionForAlert[];
    let prefs: UserNotificationPrefsRow[];
    try {
      // Gathered together because none of them is optional: without the
      // session lists there is nothing to sweep, and without prefs we cannot
      // honor auto-follow or per-user reminder hours. Any failure here means
      // the tick does nothing at all rather than acting on partial inputs.
      [waiting, closed, prefs] = await Promise.all([
        this.deps.fetchSessions("waiting"),
        this.deps.fetchSessions("closed"),
        this.deps.prisma.userNotificationPrefs.findMany(),
      ]);
    } catch (err) {
      console.error("[session-alert-sweeper] input fetch failed:", err);
      return result;
    }

    const prefsByEmail = new Map(prefs.map((row) => [row.userEmail, row]));
    const autoFollowEmails = prefs
      .filter((row) => row.autoFollowSessions)
      .map((row) => row.userEmail);
    // One membership/repo resolution per email per tick, not per session.
    const scopeCache = new Map<string, VisibilityScope>();
    const now = this.clock.now();

    for (const session of waiting) {
      try {
        await this.sweepWaitingSession(session, {
          now,
          result,
          prefsByEmail,
          autoFollowEmails,
          scopeCache,
        });
      } catch (err) {
        console.error(
          `[session-alert-sweeper] waiting session ${session.slug} failed:`,
          err,
        );
      }
    }

    for (const session of closed) {
      try {
        await this.sweepClosedSession(session, { result, scopeCache });
      } catch (err) {
        console.error(
          `[session-alert-sweeper] closed session ${session.slug} failed:`,
          err,
        );
      }
    }

    const sent = result.immediate + result.reminders + result.completions;
    if (sent > 0 || result.pruned > 0) {
      console.log(
        `[session-alert-sweeper] immediate=${result.immediate} reminders=${result.reminders} completions=${result.completions} pruned=${result.pruned}`,
      );
    }

    return result;
  }

  // ─── Waiting sessions ─────────────────────────────────────────────────────

  private async sweepWaitingSession(
    session: SessionForAlert,
    ctx: {
      now: Date;
      result: SessionAlertSweepResult;
      prefsByEmail: Map<string, UserNotificationPrefsRow>;
      autoFollowEmails: string[];
      scopeCache: Map<string, VisibilityScope>;
    },
  ): Promise<void> {
    const [followRows, alertRows] = await Promise.all([
      this.deps.prisma.sessionFollow.findMany({
        where: { sessionSlug: session.slug },
      }),
      this.deps.prisma.sessionAlertState.findMany({
        where: { sessionSlug: session.slug },
      }),
    ]);

    const alertByEmail = new Map(alertRows.map((row) => [row.userEmail, row]));
    const followers = followRows.map((row) => ({
      userEmail: row.userEmail,
      muted: row.muted,
    }));
    const followedEmails = new Set(followers.map((f) => f.userEmail));

    // Materialize auto-follows for users who can see this session.
    for (const userEmail of ctx.autoFollowEmails) {
      if (followedEmails.has(userEmail)) continue;
      // Opt-in boundary: a user is never retro-followed onto sessions that
      // were already waiting before auto-follow started applying to them —
      // `autoFollowSince` if they explicitly toggled it on, else their prefs
      // row's `createdAt` (see autoFollowBoundary). Every auto-follow user has
      // a boundary, so no cohort gets the whole backlog pushed at once.
      if (
        startedWaitingBefore(
          session,
          autoFollowBoundary(ctx.prefsByEmail.get(userEmail)),
        )
      ) {
        continue;
      }
      try {
        if (!(await this.canSee(userEmail, session, ctx.scopeCache))) continue;
        await this.deps.prisma.sessionFollow.upsert({
          where: {
            userEmail_sessionSlug: { userEmail, sessionSlug: session.slug },
          },
          create: { userEmail, sessionSlug: session.slug },
          update: {},
        });
        followers.push({ userEmail, muted: false });
        followedEmails.add(userEmail);
      } catch (err) {
        console.error(
          `[session-alert-sweeper] auto-follow ${userEmail} → ${session.slug} failed:`,
          err,
        );
      }
    }

    for (const follower of followers) {
      try {
        if (
          !(await this.isVisibleOrPrune(
            follower.userEmail,
            session,
            ctx.result,
            ctx.scopeCache,
          ))
        ) {
          continue;
        }
        // Muted means "I still follow this, just don't ping me" — no push and
        // no lastAlertedAt stamp, so un-muting later still yields an immediate.
        if (follower.muted) continue;

        const reminderHour =
          ctx.prefsByEmail.get(follower.userEmail)?.reminderHourLocal ??
          DEFAULT_REMINDER_HOUR_LOCAL;
        const kind = resolveWaitingAlertKind(
          alertByEmail.get(follower.userEmail)?.lastAlertedAt ?? null,
          ctx.now,
          reminderHour,
          this.timezone,
        );
        if (!kind) continue;

        await this.deps.pushService.notifySession(
          { slug: session.slug, emails: [follower.userEmail] },
          this.detailLevel,
          kind,
        );
        await this.stampAlertState(follower.userEmail, session.slug, ctx.now);
        if (kind === "immediate") ctx.result.immediate++;
        else ctx.result.reminders++;
      } catch (err) {
        console.error(
          `[session-alert-sweeper] alert ${follower.userEmail} → ${session.slug} failed:`,
          err,
        );
      }
    }
  }

  // ─── Closed sessions ──────────────────────────────────────────────────────

  private async sweepClosedSession(
    session: SessionForAlert,
    ctx: {
      result: SessionAlertSweepResult;
      scopeCache: Map<string, VisibilityScope>;
    },
  ): Promise<void> {
    // No auto-follow materialization here: a user who never followed a session
    // has no reason to learn it finished.
    const followRows = await this.deps.prisma.sessionFollow.findMany({
      where: { sessionSlug: session.slug },
    });

    for (const follower of followRows) {
      try {
        if (
          !(await this.isVisibleOrPrune(
            follower.userEmail,
            session,
            ctx.result,
            ctx.scopeCache,
          ))
        ) {
          continue;
        }
        if (!follower.muted) {
          await this.deps.pushService.notifySession(
            { slug: session.slug, emails: [follower.userEmail] },
            this.detailLevel,
            "completed",
          );
          ctx.result.completions++;
        }
        // Terminal cleanup: the session is closed, so the follow and its alert
        // state are dead weight — and removing them is what guarantees no
        // further pushes on subsequent ticks.
        await Promise.all([
          this.deps.prisma.sessionFollow.deleteMany({
            where: {
              userEmail: follower.userEmail,
              sessionSlug: session.slug,
            },
          }),
          this.deps.prisma.sessionAlertState.deleteMany({
            where: {
              userEmail: follower.userEmail,
              sessionSlug: session.slug,
            },
          }),
        ]);
      } catch (err) {
        console.error(
          `[session-alert-sweeper] completion ${follower.userEmail} → ${session.slug} failed:`,
          err,
        );
      }
    }
  }

  // ─── Shared steps ─────────────────────────────────────────────────────────

  private async stampAlertState(
    userEmail: string,
    sessionSlug: string,
    now: Date,
  ): Promise<void> {
    await this.deps.prisma.sessionAlertState.upsert({
      where: { userEmail_sessionSlug: { userEmail, sessionSlug } },
      create: { userEmail, sessionSlug, lastAlertedAt: now },
      update: { lastAlertedAt: now },
    });
  }

  /** Deletes a stale alert-state row, returning how many rows went away. */
  private async pruneAlertState(
    userEmail: string,
    sessionSlug: string,
  ): Promise<number> {
    const { count } = await this.deps.prisma.sessionAlertState.deleteMany({
      where: { userEmail, sessionSlug },
    });
    return count;
  }

  /**
   * The shared guard both sweep loops open with: if `userEmail` can no longer
   * see `session`, prune their stale alert-state row (counting it in
   * `result.pruned`) and report `false` so the caller sends nothing; otherwise
   * report `true` so the caller proceeds.
   */
  private async isVisibleOrPrune(
    userEmail: string,
    session: SessionForAlert,
    result: SessionAlertSweepResult,
    cache: Map<string, VisibilityScope>,
  ): Promise<boolean> {
    if (await this.canSee(userEmail, session, cache)) return true;
    result.pruned += await this.pruneAlertState(userEmail, session.slug);
    return false;
  }

  /**
   * Whether `userEmail` can still see `session`. Every follower is evaluated
   * as a non-admin member — the same rule admin-ui-session-follow.ts's
   * memberCanSeeSession() applies, deliberately without an adminAllowedEmails
   * fast path: an operator listed there who also holds memberships is covered,
   * and one who holds none simply doesn't get session pushes.
   */
  private async canSee(
    userEmail: string,
    session: SessionForAlert,
    cache: Map<string, VisibilityScope>,
  ): Promise<boolean> {
    const scope = await this.scopeFor(userEmail, cache);
    return isSessionVisible(session, scope);
  }

  private async scopeFor(
    userEmail: string,
    cache: Map<string, VisibilityScope>,
  ): Promise<VisibilityScope> {
    const key = userEmail.toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;

    const memberships = await this.deps.agentMemberService.listByEmail(key);
    const agentIds = visibleAgentIdsFor(false, memberships);
    const agents =
      memberships.length === 0
        ? []
        : await this.deps.agentService.listByIds(
            memberships.map((membership) => membership.agentId),
          );
    const scope: VisibilityScope = {
      agentIds,
      repos: agents.flatMap((agent) => agent.repos ?? []),
    };
    cache.set(key, scope);
    return scope;
  }
}
