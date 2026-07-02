/**
 * agent/src/http-chat-service-client.unit.test.ts
 *
 * Unit tests for HttpChatServiceClient.
 * Uses injected fake fetch doubles — no global.fetch override, no mock.module().
 */

import { describe, expect, it } from "bun:test";
import {
  ChatServiceClientError,
  HttpChatServiceClient,
} from "./http-chat-service-client.ts";

// ─── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL = "https://chat.test.shipwright.dev";
const TOKEN = "chat-service-token-123";
const THREAD_ID = "thread-abc";
const MESSAGE_ID = "msg-xyz";

// ─── Fake fetch helpers ────────────────────────────────────────────────────────

type FetchFn = (
  url: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type CapturedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
};

function fakeFetch(statusCode: number, body: unknown): FetchFn {
  return async () => {
    return new Response(JSON.stringify(body), {
      status: statusCode,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function capturingFetch(
  statusCode: number,
  body: unknown,
): { fn: FetchFn; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  return {
    fn: async (urlInput, init) => {
      const url =
        urlInput instanceof Request ? urlInput.url : String(urlInput);
      const method =
        urlInput instanceof Request
          ? urlInput.method
          : (init?.method ?? "GET");
      const headers: Record<string, string> = {};
      const rawHeaders =
        urlInput instanceof Request ? urlInput.headers : new Headers(init?.headers);
      rawHeaders.forEach((value, key) => {
        headers[key] = value;
      });
      let parsedBody: unknown;
      if (init?.body) {
        try {
          parsedBody = JSON.parse(init.body as string);
        } catch {
          parsedBody = init.body;
        }
      }
      calls.push({ url, method, headers, body: parsedBody });
      return new Response(JSON.stringify(body), {
        status: statusCode,
        headers: { "Content-Type": "application/json" },
      });
    },
    calls,
  };
}

// ─── Sample data ───────────────────────────────────────────────────────────────

const SAMPLE_THREADS = {
  threads: [
    {
      id: THREAD_ID,
      agentId: "agent-1",
      memberId: "member-1",
      title: "Test Thread",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  total: 1,
  limit: 50,
  offset: 0,
};

const SAMPLE_MESSAGE = {
  id: MESSAGE_ID,
  threadId: THREAD_ID,
  role: "user",
  body: "Hello!",
  claimedBy: "agent-1",
  claimedAt: new Date().toISOString(),
  repliedAt: null,
  tokens: null,
  costUsd: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const SAMPLE_REPLY_RESULT = {
  userMessage: SAMPLE_MESSAGE,
  assistantMessage: {
    ...SAMPLE_MESSAGE,
    id: "msg-assist-1",
    role: "assistant",
    body: "Hi there!",
    claimedBy: null,
    claimedAt: null,
  },
};

// ─── listThreads ───────────────────────────────────────────────────────────────

describe("HttpChatServiceClient.listThreads", () => {
  it("returns threads list on 200", async () => {
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fakeFetch(200, SAMPLE_THREADS),
    });

    const result = await client.listThreads({});
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].id).toBe(THREAD_ID);
    expect(result.total).toBe(1);
  });

  it("sends Authorization: Bearer header", async () => {
    const { fn, calls } = capturingFetch(200, SAMPLE_THREADS);
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fn,
    });

    await client.listThreads({});

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("calls GET /threads with agentId query param", async () => {
    const { fn, calls } = capturingFetch(200, SAMPLE_THREADS);
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fn,
    });

    await client.listThreads({ agentId: "agent-1", limit: 10, offset: 5 });

    expect(calls[0].method).toBe("GET");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/threads");
    expect(url.searchParams.get("agentId")).toBe("agent-1");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("5");
  });

  it("throws ChatServiceClientError on non-2xx", async () => {
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fakeFetch(500, { error: "Internal server error" }),
    });

    const err = await client.listThreads({}).catch((e) => e);
    expect(err).toBeInstanceOf(ChatServiceClientError);
    expect(err.statusCode).toBe(500);
  });

  it("throws ChatServiceClientError on 401", async () => {
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fakeFetch(401, { error: "Unauthorized" }),
    });

    const err = await client.listThreads({}).catch((e) => e);
    expect(err).toBeInstanceOf(ChatServiceClientError);
    expect(err.statusCode).toBe(401);
  });

  it("omits query params when not provided", async () => {
    const { fn, calls } = capturingFetch(200, SAMPLE_THREADS);
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fn,
    });

    await client.listThreads({});

    const url = new URL(calls[0].url);
    expect(url.searchParams.has("agentId")).toBe(false);
    expect(url.searchParams.has("limit")).toBe(false);
    expect(url.searchParams.has("offset")).toBe(false);
  });
});

// ─── claimMessage ──────────────────────────────────────────────────────────────

describe("HttpChatServiceClient.claimMessage", () => {
  it("returns claimed message on 200", async () => {
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fakeFetch(200, SAMPLE_MESSAGE),
    });

    const result = await client.claimMessage(THREAD_ID);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(MESSAGE_ID);
    expect(result?.role).toBe("user");
  });

  it("returns null on 404 (no unclaimed messages)", async () => {
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fakeFetch(404, { error: "no unclaimed messages in thread" }),
    });

    const result = await client.claimMessage(THREAD_ID);
    expect(result).toBeNull();
  });

  it("calls POST /threads/:threadId/messages/claim", async () => {
    const { fn, calls } = capturingFetch(200, SAMPLE_MESSAGE);
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fn,
    });

    await client.claimMessage(THREAD_ID);

    expect(calls[0].method).toBe("POST");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(`/threads/${THREAD_ID}/messages/claim`);
  });

  it("sends Authorization: Bearer header", async () => {
    const { fn, calls } = capturingFetch(200, SAMPLE_MESSAGE);
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fn,
    });

    await client.claimMessage(THREAD_ID);

    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws ChatServiceClientError on 500", async () => {
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fakeFetch(500, { error: "Internal server error" }),
    });

    const err = await client.claimMessage(THREAD_ID).catch((e) => e);
    expect(err).toBeInstanceOf(ChatServiceClientError);
    expect(err.statusCode).toBe(500);
  });
});

// ─── replyToMessage ────────────────────────────────────────────────────────────

describe("HttpChatServiceClient.replyToMessage", () => {
  it("returns reply result on 201", async () => {
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fakeFetch(201, SAMPLE_REPLY_RESULT),
    });

    const result = await client.replyToMessage(THREAD_ID, MESSAGE_ID, {
      body: "Hi there!",
    });
    expect(result.assistantMessage.body).toBe("Hi there!");
    expect(result.userMessage.id).toBe(MESSAGE_ID);
  });

  it("calls POST /threads/:threadId/messages/:messageId/reply", async () => {
    const { fn, calls } = capturingFetch(201, SAMPLE_REPLY_RESULT);
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fn,
    });

    await client.replyToMessage(THREAD_ID, MESSAGE_ID, { body: "Hi!" });

    expect(calls[0].method).toBe("POST");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe(
      `/threads/${THREAD_ID}/messages/${MESSAGE_ID}/reply`,
    );
  });

  it("sends body, tokens, and costUsd in request body", async () => {
    const { fn, calls } = capturingFetch(201, SAMPLE_REPLY_RESULT);
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fn,
    });

    const tokens = { input_tokens: 100, output_tokens: 50 };
    await client.replyToMessage(THREAD_ID, MESSAGE_ID, {
      body: "reply text",
      tokens,
      costUsd: 0.001,
    });

    expect(calls[0].body).toEqual({
      body: "reply text",
      tokens,
      costUsd: 0.001,
    });
  });

  it("sends Authorization: Bearer header", async () => {
    const { fn, calls } = capturingFetch(201, SAMPLE_REPLY_RESULT);
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fn,
    });

    await client.replyToMessage(THREAD_ID, MESSAGE_ID, { body: "reply" });

    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws ChatServiceClientError on non-2xx", async () => {
    const client = new HttpChatServiceClient({
      baseUrl: BASE_URL,
      token: TOKEN,
      fetchFn: fakeFetch(400, { error: "bad request" }),
    });

    const err = await client
      .replyToMessage(THREAD_ID, MESSAGE_ID, { body: "reply" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ChatServiceClientError);
    expect(err.statusCode).toBe(400);
  });
});

// ─── ChatServiceClientError ────────────────────────────────────────────────────

describe("ChatServiceClientError", () => {
  it("has correct name and statusCode", () => {
    const err = new ChatServiceClientError(503, "Service unavailable");
    expect(err.name).toBe("ChatServiceClientError");
    expect(err.statusCode).toBe(503);
    expect(err.message).toBe("Service unavailable");
    expect(err).toBeInstanceOf(Error);
  });
});
