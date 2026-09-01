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
    deleteMany(args: {
      where: { endpoint: { in: string[] } };
    }): Promise<{ count: number }>;
  };
}

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

  /** All subscriptions belonging to the users watching a thread. */
  private async subscriptionsForThread(threadId: string) {
    const watchers = await this.prisma.chatThreadWatch.findMany({
      where: { threadId },
      select: { userEmail: true },
    });
    const emails = [...new Set(watchers.map((w) => w.userEmail))];
    if (emails.length === 0) return [];
    return this.prisma.pushSubscription.findMany({
      where: { userEmail: { in: emails } },
    });
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
   * Sends the "agent replied" notification to every subscription watching the
   * thread, then prunes any the sender reported gone. Never throws into the
   * caller's request/response cycle — a push failure must not fail the reply.
   */
  async notifyThreadReply(
    thread: NotificationThread,
  ): Promise<{ delivered: number; pruned: number }> {
    try {
      const subs = await this.subscriptionsForThread(thread.threadId);
      if (subs.length === 0) return { delivered: 0, pruned: 0 };

      // Group subscriptions by their effective detail level so each group gets
      // a single payload build. Different opt-ins → different visible content.
      const byPayload = new Map<string, PushSubscriptionLike[]>();
      for (const s of subs) {
        const level = resolveDetailLevel(this.maxDetail, s.detailOptIn);
        const payload = JSON.stringify(buildNotificationPayload(level, thread));
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
    } catch (err) {
      // Push is a convenience layer over polling, never a replacement — a
      // failure here must never surface to the reply flow.
      console.error("[push] notifyThreadReply failed:", err);
      return { delivered: 0, pruned: 0 };
    }
  }
}
