/**
 * admin/src/push-service.unit.test.ts
 * Unit tests for PushService orchestration: watcher → subscription lookup,
 * per-subscription detail resolution, fan-out, and immediate pruning of the
 * subscriptions the sender reports gone. All doubles are injected (no globals,
 * no real Prisma, no real network).
 */

import { describe, expect, it } from "bun:test";
import type { PushSubscriptionLike } from "./push-sender.ts";
import { PushService } from "./push-service.ts";

const vapid = {
  publicKey:
    "BAl-hYOXgpZwx-qqRoAapu5iSeHrlcJdy89wjv1NyctfsYSyGKCVO97vvlOVR4h61MROU8CZLAxzQEj8vIFsTaI",
  privateKey: "Sl9AT1gAl_yFgHlTToZkarQRWNYHVTAviDf5osjxXN0",
  subject: "mailto:ops@example.com",
};

const P256DH =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";

interface Row {
  id: string;
  userEmail: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  detailOptIn: string;
}

function fakePrisma(watchers: string[], subs: Row[]) {
  const deleted: string[] = [];
  const prisma = {
    chatThreadWatch: {
      findMany: async () => watchers.map((email) => ({ userEmail: email })),
    },
    pushSubscription: {
      findMany: async ({ where }: { where: { userEmail: { in: string[] } } }) =>
        subs.filter((s) => where.userEmail.in.includes(s.userEmail)),
      deleteMany: async ({
        where,
      }: { where: { endpoint: { in: string[] } } }) => {
        deleted.push(...where.endpoint.in);
        return { count: where.endpoint.in.length };
      },
    },
  };
  return { prisma, deleted };
}

describe("PushService.notifyThreadReply", () => {
  it("fans out to every watcher's subscription and prunes the gone ones", async () => {
    const { prisma, deleted } = fakePrisma(
      ["a@x.com", "b@x.com"],
      [
        {
          id: "1",
          userEmail: "a@x.com",
          endpoint: "https://push/ok",
          p256dh: P256DH,
          auth: AUTH,
          detailOptIn: "title",
        },
        {
          id: "2",
          userEmail: "b@x.com",
          endpoint: "https://push/gone",
          p256dh: P256DH,
          auth: AUTH,
          detailOptIn: "generic",
        },
      ],
    );
    const sent: Array<{ sub: PushSubscriptionLike; payload: string }> = [];
    const fetchImpl = (async (url: string) => {
      sent.push({
        sub: { endpoint: url } as PushSubscriptionLike,
        payload: "",
      });
      return new Response(null, {
        status: url.endsWith("/gone") ? 410 : 201,
      });
    }) as unknown as typeof fetch;

    const service = new PushService(prisma as never, vapid, fetchImpl, "title");
    const result = await service.notifyThreadReply({
      threadId: "thr_1",
      agentId: "agt_1",
      title: "Fix the thing",
      preview: "the reply text",
    });

    expect(sent.length).toBe(2);
    expect(result.delivered).toBe(1);
    expect(deleted).toEqual(["https://push/gone"]);
  });

  it("is a no-op (no send) when the thread has no watchers", async () => {
    const { prisma, deleted } = fakePrisma([], []);
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const service = new PushService(prisma as never, vapid, fetchImpl, "title");
    const result = await service.notifyThreadReply({
      threadId: "thr_x",
      agentId: "agt_x",
      title: "t",
      preview: "p",
    });
    expect(called).toBe(0);
    expect(result.delivered).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("caps each subscription's detail at the operator ceiling", async () => {
    // Ceiling = generic; a subscription opted into preview still gets generic.
    const { prisma } = fakePrisma(
      ["a@x.com"],
      [
        {
          id: "1",
          userEmail: "a@x.com",
          endpoint: "https://push/ok",
          p256dh: P256DH,
          auth: AUTH,
          detailOptIn: "preview",
        },
      ],
    );
    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      // Decrypt isn't feasible here; assert instead via the effective level the
      // service exposes for auditing.
      bodies.push(String(init.method));
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const service = new PushService(
      prisma as never,
      vapid,
      fetchImpl,
      "generic",
    );
    const levels = await service.resolveLevelsForThread("thr_1");
    expect(levels).toEqual(["generic"]);
  });
});
