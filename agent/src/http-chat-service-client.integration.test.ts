/**
 * agent/src/http-chat-service-client.integration.test.ts
 *
 * Integration tests for HttpChatServiceClient against recorded chat-service
 * REST API fixtures.
 *
 * Drives the client through an INJECTED fetchFn that replays canned Responses
 * from cassette JSON files committed under ./fixtures/chat-service/ — no live
 * API server, no global.fetch override, no mock.module(). Mirrors the pattern
 * in admin/src/chat-service-provisioning-client.integration.test.ts.
 *
 * Companion to http-chat-service-client.unit.test.ts, which covers pure
 * request-shaping logic via an inline injected double — this file instead
 * reads response bodies from committed fixture JSON to exercise the
 * "recorded dependency behavior" boundary per docs/testing.md.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ChatServiceClientError,
  HttpChatServiceClient,
} from "./http-chat-service-client.ts";

// ─── Cassettes ─────────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  /** When set to "base64", `body` is a base64 string decoded to raw bytes. */
  bodyEncoding?: "base64";
  body: unknown;
}

function loadCassette(filename: string): Record<string, CassetteEntry> {
  const path = new URL(
    `./fixtures/chat-service/${filename}`,
    import.meta.url,
  ).pathname;
  return JSON.parse(readFileSync(path, "utf-8"));
}

const threadsCassette = loadCassette("threads.json");
const messagesCassette = loadCassette("messages.json");
const attachmentCassette = loadCassette("attachment.json");

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

/**
 * Build a Response for a cassette entry. JSON entries get a JSON content
 * type; base64-encoded entries (binary attachments) are decoded to raw bytes
 * and returned without a JSON content type, matching what the real
 * chat-service attachment endpoint sends.
 */
function responseForEntry(entry: CassetteEntry): Response {
  if (entry.bodyEncoding === "base64") {
    const bytes = Uint8Array.from(atob(entry.body as string), (c) =>
      c.charCodeAt(0),
    );
    return new Response(bytes, {
      status: entry.status,
      statusText: `status-${entry.status}`,
    });
  }
  return new Response(JSON.stringify(entry.body), {
    status: entry.status,
    statusText: `status-${entry.status}`,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build an injected fetchFn that replays the cassette entry for `key` from
 * `cassette` on every call. Records the last request so tests can assert
 * URL/method/headers.
 */
function cassetteFetch(
  cassette: Record<string, CassetteEntry>,
  key: string,
): {
  fetchFn: typeof fetch;
  lastRequest: () => RecordedRequest;
} {
  let last: RecordedRequest | undefined;
  const entry = cassette[key];
  if (!entry) throw new Error(`cassette key not found: ${key}`);

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    last = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    return responseForEntry(entry);
  }) as typeof fetch;

  return {
    fetchFn,
    lastRequest: () => {
      if (!last) throw new Error("fetchFn was not called");
      return last;
    },
  };
}

const BASE_URL = "https://chat.example.com";
const TOKEN = "chat-service-token-xyz";
const THREAD_ID = "thread-abc";
const MESSAGE_ID = "msg-xyz";

function makeClient(
  cassette: Record<string, CassetteEntry>,
  key: string,
): {
  client: HttpChatServiceClient;
  lastRequest: () => RecordedRequest;
} {
  const { fetchFn, lastRequest } = cassetteFetch(cassette, key);
  const client = new HttpChatServiceClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    fetchFn,
  });
  return { client, lastRequest };
}

// ─── listThreads ───────────────────────────────────────────────────────────────

describe("HttpChatServiceClient.listThreads (recorded fixtures)", () => {
  it("returns the threads array from the recorded fixture on 200", async () => {
    const { client, lastRequest } = makeClient(
      threadsCassette,
      "listThreads_success",
    );

    const result = await client.listThreads({});

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0].id).toBe("thread-abc");
    expect(result.threads[1].memberId).toBeNull();
    expect(result.total).toBe(2);
  });

  it("sends agentId/limit/offset as query params and returns the paginated fixture", async () => {
    const { client, lastRequest } = makeClient(
      threadsCassette,
      "listThreads_with_query_params",
    );

    const result = await client.listThreads({
      agentId: "agent-1",
      limit: 10,
      offset: 5,
    });

    const req = lastRequest();
    const url = new URL(req.url);
    expect(url.pathname).toBe("/threads");
    expect(url.searchParams.get("agentId")).toBe("agent-1");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("5");
    expect(result.total).toBe(6);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(5);
    expect(result.threads).toHaveLength(1);
  });

  it("throws ChatServiceClientError with statusCode 500 on the recorded server error", async () => {
    const { client } = makeClient(threadsCassette, "listThreads_500");

    const err = await client.listThreads({}).catch((e) => e);
    expect(err).toBeInstanceOf(ChatServiceClientError);
    expect(err.statusCode).toBe(500);
  });
});

// ─── claimMessage ──────────────────────────────────────────────────────────────

describe("HttpChatServiceClient.claimMessage (recorded fixtures)", () => {
  it("returns the claimed message from the recorded fixture on 200", async () => {
    const { client, lastRequest } = makeClient(
      messagesCassette,
      "claimMessage_success",
    );

    const result = await client.claimMessage(THREAD_ID);

    const req = lastRequest();
    expect(req.method).toBe("POST");
    const url = new URL(req.url);
    expect(url.pathname).toBe(`/threads/${THREAD_ID}/messages/claim`);
    expect(req.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(result).not.toBeNull();
    expect(result?.id).toBe(MESSAGE_ID);
    expect(result?.claimedBy).toBe("agent-1");
  });

  it("returns null on the recorded 404 (no unclaimed messages)", async () => {
    const { client } = makeClient(messagesCassette, "claimMessage_404");

    const result = await client.claimMessage(THREAD_ID);
    expect(result).toBeNull();
  });

  it("throws ChatServiceClientError with statusCode 500 on the recorded server error", async () => {
    const { client } = makeClient(messagesCassette, "claimMessage_500");

    const err = await client.claimMessage(THREAD_ID).catch((e) => e);
    expect(err).toBeInstanceOf(ChatServiceClientError);
    expect(err.statusCode).toBe(500);
  });
});

// ─── replyToMessage ────────────────────────────────────────────────────────────

describe("HttpChatServiceClient.replyToMessage (recorded fixtures)", () => {
  it("returns the reply result from the recorded fixture on 201", async () => {
    const { client, lastRequest } = makeClient(
      messagesCassette,
      "replyToMessage_success",
    );

    const result = await client.replyToMessage(THREAD_ID, MESSAGE_ID, {
      body: "Sure, here's how...",
      tokens: { input_tokens: 120, output_tokens: 42 },
      costUsd: 0.0021,
    });

    const req = lastRequest();
    expect(req.method).toBe("POST");
    const url = new URL(req.url);
    expect(url.pathname).toBe(
      `/threads/${THREAD_ID}/messages/${MESSAGE_ID}/reply`,
    );
    expect(req.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(req.body ?? "{}")).toEqual({
      body: "Sure, here's how...",
      tokens: { input_tokens: 120, output_tokens: 42 },
      costUsd: 0.0021,
    });
    expect(result.userMessage.id).toBe(MESSAGE_ID);
    expect(result.assistantMessage.role).toBe("assistant");
    expect(result.assistantMessage.body).toBe("Sure, here's how...");
    expect(result.assistantMessage.costUsd).toBe(0.0021);
  });

  it("throws ChatServiceClientError with statusCode 400 on the recorded bad-request error", async () => {
    const { client } = makeClient(messagesCassette, "replyToMessage_400");

    const err = await client
      .replyToMessage(THREAD_ID, MESSAGE_ID, { body: "" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ChatServiceClientError);
    expect(err.statusCode).toBe(400);
  });
});

// ─── getAttachment ─────────────────────────────────────────────────────────────

describe("HttpChatServiceClient.getAttachment (recorded fixtures)", () => {
  it("returns the recorded binary bytes as a Uint8Array on 200", async () => {
    const entry = attachmentCassette.getAttachment_success;
    const expectedBytes = Uint8Array.from(atob(entry.body as string), (c) =>
      c.charCodeAt(0),
    );

    const { client, lastRequest } = makeClient(
      attachmentCassette,
      "getAttachment_success",
    );

    const result = await client.getAttachment(THREAD_ID, MESSAGE_ID);

    const req = lastRequest();
    expect(req.method).toBe("GET");
    const url = new URL(req.url);
    expect(url.pathname).toBe(
      `/threads/${THREAD_ID}/messages/${MESSAGE_ID}/attachment`,
    );
    expect(req.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(result).not.toBeNull();
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toEqual(expectedBytes);
  });

  it("returns null on the recorded 404 (no attachment)", async () => {
    const { client } = makeClient(attachmentCassette, "getAttachment_404");

    const result = await client.getAttachment(THREAD_ID, MESSAGE_ID);
    expect(result).toBeNull();
  });

  it("throws ChatServiceClientError with statusCode 500 on the recorded server error", async () => {
    const { client } = makeClient(attachmentCassette, "getAttachment_500");

    const err = await client
      .getAttachment(THREAD_ID, MESSAGE_ID)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ChatServiceClientError);
    expect(err.statusCode).toBe(500);
  });
});
