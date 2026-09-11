/**
 * admin/src/push-service.ts
 * PushService — orchestrates a "your agent replied" notification.
 *
 * Targeting flows through ChatThreadWatch (NOT a fan-out to every agent
 * member): the users watching a thread are exactly the ones who sent a message
 * in it, so only they are notified when the agent replies. Each of their
 * subscriptions gets a payload built at min(operator ceiling, that
 * subscription's opt-in). Subscriptions the sender reports gone (404/410) are
 * pruned immediately.
 *
 * Constructed with an injected fetchImpl (passed straight to PushSender) — no
 * global.fetch override. A partial VAPID config never reaches here: main.ts
 * only constructs a PushService when isPushEnabled() is true.
 */

import {
  type NotificationThread,
  type PushDetailLevel,
  buildNotificationPayload,
  resolveDetailLevel,
} from "./push-content.ts";
import {
  PushSender,
  type PushSubscriptionLike,
  type VapidConfig,
} from "./push-sender.ts";

// The narrow slice of PrismaClient this service touches. Injected so the unit
// tests use a plain object double instead of a real client.
export interface PushPrismaLike {
  chatThreadWatch: {
    findMany(args: {
      where: { threadId: string };
      select: { userEmail: true };
    }): Promise<Array<{ userEmail: string }>>;
    upsert(args: {
      where: { userEmail_threadId: { userEmail: string; threadId: string } };
      create: { userEmail: string; threadId: string; agentId: string };
      update: { agentId: string };
    }): Promise<{ id: string }>;
  };
  pushSubscription: {
    findMany(args: {
      where: { userEmail: { in: string[] } };
    }): Promise<
      Array<{
        userEmail: string;
        endpoint: string;
        p256dh: string;
        auth: string;
        detailOptIn: string;
      }>
    >;
    upsert(args: {
      where: { endpoint: string };
      create: {
        userEmail: string;
        endpoint: string;
        p256dh: string;
        auth: string;
      };
      update: { userEmail: string; p256dh: string; auth: string };
    }): Promise<{ id: string }>;
    deleteMany(
      args:
        | { where: { endpoint: { in: string[] } } }
        | { where: { endpoint: string; userEmail?: string } },
    ): Promise<{ count: number }>;
  };
}

/** Outcome of PushService.subscribe — distinguishes the three response shapes
 * the route handler maps to HTTP status (503 unavailable / 500 store_failed /
 * 200 ok). */
export type PushSubscribeResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "store_failed" };

/** Outcome of PushService.unsubscribe — delete failures are swallowed/logged
 * inside the service (best-effort), so only "unavailable" (model missing) is
 * distinguished from success. */
export type PushUnsubscribeResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" };

/**
 * A minimal carrier of "who to notify" for a session-based notification.
 * There is no real Session/SessionFollow Prisma model yet (that lands with
 * sibling tasks SES-1.1/SES-6.1) — notifySession only needs the resolved
 * list of emails to notify plus enough identifying info for the payload, not
 * a Prisma-backed lookup. Callers resolve `emails` themselves.
 */
export interface NotificationSession {
  slug: string;
  emails: string[];
}

/**
 * The kind of session-lifecycle event a notification is for. A future task
 * (SESH-7.2) will use this to drive a real buildSessionNotificationPayload —
 * this task only needs the type and a placeholder payload.
 */
export type SessionNotificationKind = "immediate" | "reminder" | "completed";

export class PushService {
  private readonly sender: PushSender;

  constructor(
    private readonly prisma: PushPrismaLike,
    vapid: VapidConfig,
    fetchImpl: typeof fetch,
    private readonly maxDetail: PushDetailLevel | string,
  ) {
    this.sender = new PushSender(vapid, fetchImpl);
  }

  /** The deduped set of emails watching a thread. */
  private async watchersForThread(threadId: string): Promise<string[]> {
    const watchers = await this.prisma.chatThreadWatch.findMany({
      where: { threadId },
      select: { userEmail: true },
    });
    return [...new Set(watchers.map((w) => w.userEmail))];
  }

  /** All push subscriptions belonging to the given emails. */
  private async subscriptionsForEmails(emails: string[]) {
    if (emails.length === 0) return [];
    return this.prisma.pushSubscription.findMany({
      where: { userEmail: { in: emails } },
    });
  }

  /** All subscriptions belonging to the users watching a thread. */
  private async subscriptionsForThread(threadId: string) {
    const emails = await this.watchersForThread(threadId);
    return this.subscriptionsForEmails(emails);
  }

  /**
   * The effective detail level per watching subscription — exposed for the
   * dedicated content-policy audit and for tests.
   */
  async resolveLevelsForThread(threadId: string): Promise<PushDetailLevel[]> {
    const subs = await this.subscriptionsForThread(threadId);
    return subs.map((s) => resolveDetailLevel(this.maxDetail, s.detailOptIn));
  }

  /**
   * The reusable core of every "notify these users" flow: resolves push
   * subscriptions for the given emails, groups them by effective detail
   * level (min(operator ceiling, each subscription's opt-in)), builds one
   * payload per group via `buildPayload`, sends, then prunes any endpoints
   * the sender reports gone. Does NOT swallow errors itself — that's each
   * public entry point's job (notifyThreadReply, notifySession), so the
   * "never throws" contract lives at exactly one place per caller instead of
   * being duplicated or accidentally omitted here.
   */
  async sendToUsers(
    emails: string[],
    buildPayload: (level: PushDetailLevel) => string,
  ): Promise<{ delivered: number; pruned: number }> {
    const subs = await this.subscriptionsForEmails(emails);
    if (subs.length === 0) return { delivered: 0, pruned: 0 };

    // Group subscriptions by their effective detail level so each group gets
    // a single payload build. Different opt-ins → different visible content.
    const byPayload = new Map<string, PushSubscriptionLike[]>();
    for (const s of subs) {
      const level = resolveDetailLevel(this.maxDetail, s.detailOptIn);
      const payload = buildPayload(level);
      if (!byPayload.has(payload)) {
        byPayload.set(payload, []);
      }
      byPayload.get(payload)?.push({
        endpoint: s.endpoint,
        p256dh: s.p256dh,
        auth: s.auth,
      });
    }

    let delivered = 0;
    const prunedEndpoints: string[] = [];
    for (const [payload, group] of byPayload) {
      const res = await this.sender.sendToMany(group, payload);
      delivered += res.delivered;
      prunedEndpoints.push(...res.prunedEndpoints);
    }

    if (prunedEndpoints.length > 0) {
      await this.prisma.pushSubscription.deleteMany({
        where: { endpoint: { in: prunedEndpoints } },
      });
    }
    return { delivered, pruned: prunedEndpoints.length };
  }

  /**
   * Sends the "agent replied" notification to every subscription watching the
   * thread, then prunes any the sender reported gone. Never throws into the
   * caller's request/response cycle — a push failure must not fail the reply.
   */
  async notifyThreadReply(
    thread: NotificationThread,
  ): Promise<{ delivered: number; pruned: number }> {
    try {
      const emails = await this.watchersForThread(thread.threadId);
      if (emails.length === 0) return { delivered: 0, pruned: 0 };
      return await this.sendToUsers(emails, (level) =>
        JSON.stringify(buildNotificationPayload(level, thread)),
      );
    } catch (err) {
      // Push is a convenience layer over polling, never a replacement — a
      // failure here must never surface to the reply flow.
      console.error("[push] notifyThreadReply failed:", err);
      return { delivered: 0, pruned: 0 };
    }
  }

  /**
   * Sends a session-lifecycle notification (SESH-7.1) to every email on
   * `session.emails`, then prunes any endpoints the sender reports gone.
   * Never throws into the caller — same convenience-layer contract as
   * notifyThreadReply. The payload *content* here is a deliberate
   * placeholder (the real content policy is SESH-7.2's
   * buildSessionNotificationPayload), but the detail level it carries is not:
   * `level` is the caller's per-call ceiling, and the effective level of each
   * subscription's payload is min(caller ceiling, operator ceiling, that
   * subscription's opt-in) — the same privacy invariant notifyThreadReply
   * honors. A caller can ask for less detail, never more.
   */
  async notifySession(
    session: NotificationSession,
    level: PushDetailLevel,
    kind: SessionNotificationKind,
  ): Promise<{ delivered: number; pruned: number }> {
    try {
      if (session.emails.length === 0) return { delivered: 0, pruned: 0 };
      // `subLevel` already is min(this.maxDetail, subscription opt-in);
      // resolveDetailLevel caps it once more against the caller's request.
      return await this.sendToUsers(session.emails, (subLevel) =>
        JSON.stringify({
          kind,
          slug: session.slug,
          level: resolveDetailLevel(level, subLevel),
        }),
      );
    } catch (err) {
      console.error("[push] notifySession failed:", err);
      return { delivered: 0, pruned: 0 };
    }
  }

  /**
   * Best-effort upsert of a ChatThreadWatch row (CFB-4.2). Never throws into
   * a request cycle — push is a convenience layer, so a watch-write failure
   * must not fail the message send it rides along with. The `!this.prisma.
   * chatThreadWatch` guard is load-bearing: main.ts constructs this service
   * with `prisma as never`, bypassing type-checking, so the real client may
   * genuinely lack this model if a migration hasn't landed yet.
   */
  async recordWatch(
    userEmail: string,
    agentId: string,
    threadId: string,
  ): Promise<void> {
    if (!this.prisma.chatThreadWatch) return;
    try {
      await this.prisma.chatThreadWatch.upsert({
        where: { userEmail_threadId: { userEmail, threadId } },
        create: { userEmail, threadId, agentId },
        update: { agentId },
      });
    } catch (err) {
      console.error("[push] watchThread upsert failed:", err);
    }
  }

  /**
   * Upserts a browser push subscription for userEmail. The `unavailable`
   * reason covers the same not-yet-migrated case as recordWatch's guard;
   * `store_failed` surfaces an upsert error to the caller (unlike
   * recordWatch/unsubscribe, this one isn't swallowed — the client needs to
   * know its subscription didn't stick).
   */
  async subscribe(
    userEmail: string,
    endpoint: string,
    p256dh: string,
    auth: string,
  ): Promise<PushSubscribeResult> {
    if (!this.prisma.pushSubscription)
      return { ok: false, reason: "unavailable" };
    try {
      await this.prisma.pushSubscription.upsert({
        where: { endpoint },
        create: { userEmail, endpoint, p256dh, auth },
        update: { userEmail, p256dh, auth },
      });
      return { ok: true };
    } catch (err) {
      console.error("[push] subscribe upsert failed:", err);
      return { ok: false, reason: "store_failed" };
    }
  }

  /**
   * Deletes a browser push subscription, scoped to both endpoint and
   * userEmail — this scoping prevents a stale endpoint from pruning another
   * user's subscription. Delete failures are best-effort: logged and
   * swallowed, never surfaced as a distinct outcome.
   */
  async unsubscribe(
    userEmail: string,
    endpoint: string,
  ): Promise<PushUnsubscribeResult> {
    if (!this.prisma.pushSubscription)
      return { ok: false, reason: "unavailable" };
    try {
      await this.prisma.pushSubscription.deleteMany({
        where: { endpoint, userEmail },
      });
    } catch (err) {
      console.error("[push] unsubscribe delete failed:", err);
    }
    return { ok: true };
  }
}
