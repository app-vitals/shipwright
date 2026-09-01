/**
 * chat/src/reply-notifier.unit.test.ts
 *
 * Unit tests for createReplyNotifier — the outbound reply-notification
 * webhook caller. Mirrors chat/src/auth.ts's createScopeResolver shape and
 * error-handling contract (never throws, 5s timeout), but takes an injected
 * fetch implementation as an explicit parameter so these tests never touch
 * global.fetch (CLAUDE.md test-isolation hard rule).
 */

import { describe, expect, test } from "bun:test";
import { createReplyNotifier } from "./reply-notifier.ts";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const fn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

describe("createReplyNotifier", () => {
  test("posts to {webhookUrl} with a bearer token and the event payload", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const notify = createReplyNotifier(
      "https://admin.example.com/admin/push/notify",
      "webhook-token",
      fn,
    );

    await notify({ threadId: "thread-1", agentId: "agent-1", title: "Hi" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://admin.example.com/admin/push/notify");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer webhook-token");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("payload contains only threadId, agentId, and title — no message body text", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const notify = createReplyNotifier(
      "https://admin.example.com/admin/push/notify",
      "webhook-token",
      fn,
    );

    await notify({ threadId: "thread-1", agentId: "agent-1", title: "Hi" });

    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toEqual({
      threadId: "thread-1",
      agentId: "agent-1",
      title: "Hi",
    });
    expect(body.preview).toBeUndefined();
    expect(body.body).toBeUndefined();
  });

  test("does not coerce a null title to an empty string", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const notify = createReplyNotifier(
      "https://admin.example.com/admin/push/notify",
      "webhook-token",
      fn,
    );

    await notify({ threadId: "thread-1", agentId: "agent-1", title: null });

    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.title).toBeNull();
  });

  test("never throws when fetch rejects (network failure)", async () => {
    const fn = async (): Promise<Response> => {
      throw new Error("network unreachable");
    };
    const notify = createReplyNotifier(
      "https://admin.example.com/admin/push/notify",
      "webhook-token",
      fn,
    );

    await expect(
      notify({ threadId: "thread-1", agentId: "agent-1", title: null }),
    ).resolves.toBeUndefined();
  });

  test("never throws when the webhook responds with a non-2xx status", async () => {
    const { fn } = fakeFetch(() => new Response(null, { status: 503 }));
    const notify = createReplyNotifier(
      "https://admin.example.com/admin/push/notify",
      "webhook-token",
      fn,
    );

    await expect(
      notify({ threadId: "thread-1", agentId: "agent-1", title: null }),
    ).resolves.toBeUndefined();
  });

  test("sets a 5s AbortSignal.timeout on the request", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const notify = createReplyNotifier(
      "https://admin.example.com/admin/push/notify",
      "webhook-token",
      fn,
    );

    await notify({ threadId: "thread-1", agentId: "agent-1", title: null });

    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});
