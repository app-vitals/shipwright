/**
 * task-store/src/webhook-dispatcher.unit.test.ts
 *
 * Unit tests for createWebhookDispatcher — the outbound task-store event
 * webhook (TSW-1.1). Takes an injected `fetchImpl` so these tests never
 * touch global.fetch (CLAUDE.md test-isolation hard rule).
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { WebhookDeliveryError } from "./errors.ts";
import { createWebhookDispatcher } from "./webhook-dispatcher.ts";

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

const WEBHOOK_URL = "https://example.com/webhooks/task-store";

describe("createWebhookDispatcher", () => {
  test("posts the envelope {type, data} to the configured url", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const dispatch = createWebhookDispatcher(WEBHOOK_URL, "tok", 5000, fn);

    await dispatch("task.created", { id: "t-1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WEBHOOK_URL);
    expect(calls[0]?.init?.method).toBe("POST");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toEqual({ type: "task.created", data: { id: "t-1" } });
  });

  test("sends Authorization: Bearer {token} when a token is set", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const dispatch = createWebhookDispatcher(
      WEBHOOK_URL,
      "secret-token",
      5000,
      fn,
    );

    await dispatch("task.created", { id: "t-1" });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
  });

  test("sends X-Shipwright-Signature as sha256={hmac} of the raw body keyed by token", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const dispatch = createWebhookDispatcher(
      WEBHOOK_URL,
      "secret-token",
      5000,
      fn,
    );

    await dispatch("task.created", { id: "t-1" });

    const body = calls[0]?.init?.body as string;
    const expectedHmac = createHmac("sha256", "secret-token")
      .update(body)
      .digest("hex");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Shipwright-Signature"]).toBe(`sha256=${expectedHmac}`);
  });

  test("omits Authorization and signature headers when no token is set", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const dispatch = createWebhookDispatcher(WEBHOOK_URL, undefined, 5000, fn);

    await dispatch("task.created", { id: "t-1" });

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-Shipwright-Signature"]).toBeUndefined();
  });

  test("sets an AbortSignal.timeout using the configured timeoutMs", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const dispatch = createWebhookDispatcher(WEBHOOK_URL, "tok", 1234, fn);

    await dispatch("task.created", { id: "t-1" });

    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("throws WebhookDeliveryError on a non-2xx response", async () => {
    const { fn } = fakeFetch(() => new Response(null, { status: 503 }));
    const dispatch = createWebhookDispatcher(WEBHOOK_URL, "tok", 5000, fn);

    await expect(
      dispatch("task.created", { id: "t-1" }),
    ).rejects.toBeInstanceOf(WebhookDeliveryError);
  });

  test("throws WebhookDeliveryError on a network error (fetch rejects)", async () => {
    const fn = async (): Promise<Response> => {
      throw new Error("network unreachable");
    };
    const dispatch = createWebhookDispatcher(WEBHOOK_URL, "tok", 5000, fn);

    await expect(
      dispatch("task.created", { id: "t-1" }),
    ).rejects.toBeInstanceOf(WebhookDeliveryError);
  });

  test("throws WebhookDeliveryError when the request times out (abort)", async () => {
    const fn = async (): Promise<Response> => {
      const err = new DOMException(
        "The operation was aborted.",
        "TimeoutError",
      );
      throw err;
    };
    const dispatch = createWebhookDispatcher(WEBHOOK_URL, "tok", 5000, fn);

    await expect(
      dispatch("task.created", { id: "t-1" }),
    ).rejects.toBeInstanceOf(WebhookDeliveryError);
  });

  test("no-ops (never calls fetchImpl, resolves) when url is unset", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const dispatch = createWebhookDispatcher(undefined, "tok", 5000, fn);

    await expect(
      dispatch("task.created", { id: "t-1" }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test("no-ops when url is an empty string", async () => {
    const { fn, calls } = fakeFetch(() => new Response(null, { status: 200 }));
    const dispatch = createWebhookDispatcher("", "tok", 5000, fn);

    await expect(
      dispatch("task.created", { id: "t-1" }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
