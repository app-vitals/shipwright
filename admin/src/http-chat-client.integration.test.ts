/**
 * admin/src/http-chat-client.integration.test.ts
 * Integration tests for HttpChatClient against recorded chat-service
 * thread/message API fixtures.
 *
 * Drives the client through an INJECTED fetchFn that replays canned Responses
 * from a cassette keyed by scenario — no live API server, no global.fetch
 * override, no mock.module(). Mirrors the pattern in
 * chat-service-provisioning-client.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { HttpChatClient, NoopChatClient } from "./http-chat-client.ts";

// ─── Cassette ───────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

const CASSETTE_PATH = new URL(
  "./fixtures/http-chat-client-cassette.json",
  import.meta.url,
).pathname;

const cassette: Record<string, CassetteEntry> = JSON.parse(
  readFileSync(CASSETTE_PATH, "utf-8"),
);

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

/**
 * Build an injected fetchFn that returns the cassette entry for `key` for
 * every call. Records the last request so tests can assert URL/method/
 * headers/body.
 */
function cassetteFetch(key: string): {
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
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      statusText: `status-${entry.status}`,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    fetchFn,
    lastRequest: () => {
      if (!last) throw new Error("fetchFn was not called");
      return last;
    },
  };
}

function makeClient(key: string): {
  client: HttpChatClient;
  lastRequest: () => RecordedRequest;
} {
  const { fetchFn, lastRequest } = cassetteFetch(key);
  const client = new HttpChatClient(
    "https://chat.example.com",
    "admin-token-xyz",
    {
      fetchFn,
    },
  );
  return { client, lastRequest };
}

// ─── listThreads ────────────────────────────────────────────────────────────

describe("HttpChatClient — listThreads", () => {
  it("GETs /threads with Bearer auth and returns the parsed result", async () => {
    const { client, lastRequest } = makeClient("listThreads_success");
    const result = await client.listThreads();

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://chat.example.com/threads");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(result.threads).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("appends agentId, limit, and offset as query params only when provided", async () => {
    const { client, lastRequest } = makeClient("listThreads_success");
    await client.listThreads("agent-123", { limit: 10, offset: 5 });

    const req = lastRequest();
    const url = new URL(req.url);
    expect(url.pathname).toBe("/threads");
    expect(url.searchParams.get("agentId")).toBe("agent-123");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("offset")).toBe("5");
  });

  it("omits query params entirely when none are provided", async () => {
    const { client, lastRequest } = makeClient("listThreads_success");
    await client.listThreads();

    const req = lastRequest();
    expect(req.url).toBe("https://chat.example.com/threads");
  });

  it("returns an empty result set", async () => {
    const { client } = makeClient("listThreads_empty");
    const result = await client.listThreads();
    expect(result).toEqual({ threads: [], total: 0, limit: 50, offset: 0 });
  });

  it("throws on a non-ok response with the exact error message format", async () => {
    const { client } = makeClient("listThreads_500");
    await expect(client.listThreads()).rejects.toThrow(
      "chat-service GET /threads failed: 500 status-500",
    );
  });
});

// ─── getThread ──────────────────────────────────────────────────────────────

describe("HttpChatClient — getThread", () => {
  it("GETs /threads/:id with Bearer auth", async () => {
    const { client, lastRequest } = makeClient("getThread_success");
    const result = await client.getThread("thread_1");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://chat.example.com/threads/thread_1");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(result.id).toBe("thread_1");
    expect(result.title).toBe("First thread");
  });

  it("throws on a non-ok response with the exact error message format", async () => {
    const { client } = makeClient("getThread_404");
    await expect(client.getThread("thread_1")).rejects.toThrow(
      "chat-service GET /threads/thread_1 failed: 404 status-404",
    );
  });
});

// ─── createThread ───────────────────────────────────────────────────────────

describe("HttpChatClient — createThread", () => {
  it("POSTs to /threads with agentId, title, and memberId", async () => {
    const { client, lastRequest } = makeClient("createThread_success");
    const result = await client.createThread("agent-123", {
      title: "New thread",
      memberId: "member-9",
    });

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://chat.example.com/threads");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(JSON.parse(req.body ?? "{}")).toEqual({
      agentId: "agent-123",
      title: "New thread",
      memberId: "member-9",
    });
    expect(result.id).toBe("thread_new");
  });

  it("omits title and memberId from the body when not provided", async () => {
    const { client, lastRequest } = makeClient("createThread_minimal_success");
    await client.createThread("agent-123");

    const req = lastRequest();
    expect(JSON.parse(req.body ?? "{}")).toEqual({ agentId: "agent-123" });
  });

  it("throws on a non-ok response with the exact error message format", async () => {
    const { client } = makeClient("createThread_500");
    await expect(client.createThread("agent-123")).rejects.toThrow(
      "chat-service POST /threads failed: 500 status-500",
    );
  });
});

// ─── updateThread ───────────────────────────────────────────────────────────

describe("HttpChatClient — updateThread", () => {
  it("PATCHes /threads/:id with the update payload", async () => {
    const { client, lastRequest } = makeClient("updateThread_success");
    const result = await client.updateThread("thread_1", {
      title: "Updated title",
    });

    const req = lastRequest();
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe("https://chat.example.com/threads/thread_1");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(JSON.parse(req.body ?? "{}")).toEqual({ title: "Updated title" });
    expect(result.title).toBe("Updated title");
  });

  it("throws on a non-ok response with the exact error message format", async () => {
    const { client } = makeClient("updateThread_500");
    await expect(
      client.updateThread("thread_1", { title: "x" }),
    ).rejects.toThrow(
      "chat-service PATCH /threads/thread_1 failed: 500 status-500",
    );
  });
});

// ─── deleteThread ───────────────────────────────────────────────────────────

describe("HttpChatClient — deleteThread", () => {
  it("DELETEs /threads/:id with Bearer auth", async () => {
    const { client, lastRequest } = makeClient("deleteThread_success");
    await client.deleteThread("thread_1");

    const req = lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("https://chat.example.com/threads/thread_1");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
  });

  it("throws on a non-ok response with the exact error message format", async () => {
    const { client } = makeClient("deleteThread_500");
    await expect(client.deleteThread("thread_1")).rejects.toThrow(
      "chat-service DELETE /threads/thread_1 failed: 500 status-500",
    );
  });
});

// ─── listMessages ───────────────────────────────────────────────────────────

describe("HttpChatClient — listMessages", () => {
  it("GETs /threads/:threadId/messages with Bearer auth", async () => {
    const { client, lastRequest } = makeClient("listMessages_success");
    const result = await client.listMessages("thread_1");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://chat.example.com/threads/thread_1/messages");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]?.tokens).toEqual({
      input_tokens: 12,
      output_tokens: 8,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("appends limit and offset as query params only when provided", async () => {
    const { client, lastRequest } = makeClient("listMessages_success");
    await client.listMessages("thread_1", { limit: 20, offset: 40 });

    const req = lastRequest();
    const url = new URL(req.url);
    expect(url.pathname).toBe("/threads/thread_1/messages");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("offset")).toBe("40");
  });

  it("omits query params entirely when none are provided", async () => {
    const { client, lastRequest } = makeClient("listMessages_success");
    await client.listMessages("thread_1");

    const req = lastRequest();
    expect(req.url).toBe("https://chat.example.com/threads/thread_1/messages");
  });

  it("returns an empty result set", async () => {
    const { client } = makeClient("listMessages_empty");
    const result = await client.listMessages("thread_1");
    expect(result).toEqual({ messages: [], total: 0, limit: 50, offset: 0 });
  });

  it("throws on a non-ok response with the exact error message format", async () => {
    const { client } = makeClient("listMessages_500");
    await expect(client.listMessages("thread_1")).rejects.toThrow(
      "chat-service GET /threads/thread_1/messages failed: 500 status-500",
    );
  });
});

// ─── createMessage ──────────────────────────────────────────────────────────

describe("HttpChatClient — createMessage", () => {
  it("POSTs to /threads/:threadId/messages with role and body", async () => {
    const { client, lastRequest } = makeClient("createMessage_success");
    const result = await client.createMessage(
      "thread_1",
      "user",
      "a message without attachment",
    );

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://chat.example.com/threads/thread_1/messages");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(JSON.parse(req.body ?? "{}")).toEqual({
      role: "user",
      body: "a message without attachment",
    });
    expect(result.id).toBe("msg_new");
  });

  it("base64-encodes an attachment's bytes and includes filename/size", async () => {
    const { client, lastRequest } = makeClient(
      "createMessage_with_attachment_success",
    );
    const bytes = new TextEncoder().encode("hello notes");
    const result = await client.createMessage(
      "thread_1",
      "user",
      "a message with an attachment",
      { filename: "notes.txt", size: bytes.byteLength, bytes },
    );

    const req = lastRequest();
    const payload = JSON.parse(req.body ?? "{}");
    expect(payload.role).toBe("user");
    expect(payload.body).toBe("a message with an attachment");
    expect(payload.attachmentFilename).toBe("notes.txt");
    expect(payload.attachmentSize).toBe(bytes.byteLength);
    expect(payload.attachmentBytes).toBe(Buffer.from(bytes).toString("base64"));
    expect(
      Buffer.from(payload.attachmentBytes, "base64").toString("utf-8"),
    ).toBe("hello notes");
    expect(result.attachmentFilename).toBe("notes.txt");
    expect(result.attachmentSize).toBe(11);
  });

  it("throws on a non-ok response with the exact error message format", async () => {
    const { client } = makeClient("createMessage_500");
    await expect(
      client.createMessage("thread_1", "user", "hi"),
    ).rejects.toThrow(
      "chat-service POST /threads/thread_1/messages failed: 500 status-500",
    );
  });
});

// ─── getThreadStats ─────────────────────────────────────────────────────────

describe("HttpChatClient — getThreadStats", () => {
  it("GETs /threads/:threadId/stats with Bearer auth", async () => {
    const { client, lastRequest } = makeClient("getThreadStats_success");
    const result = await client.getThreadStats("thread_1");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://chat.example.com/threads/thread_1/stats");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(result).toEqual({
      messageCount: 2,
      totalInputTokens: 12,
      totalOutputTokens: 8,
      totalCostUsd: 0.0012,
    });
  });

  it("throws on a non-ok response with the exact error message format", async () => {
    const { client } = makeClient("getThreadStats_500");
    await expect(client.getThreadStats("thread_1")).rejects.toThrow(
      "chat-service GET /threads/thread_1/stats failed: 500 status-500",
    );
  });
});

// ─── NoopChatClient ─────────────────────────────────────────────────────────

describe("NoopChatClient", () => {
  it("listThreads returns an empty result set", async () => {
    const client = new NoopChatClient();
    const result = await client.listThreads();
    expect(result).toEqual({ threads: [], total: 0, limit: 50, offset: 0 });
  });

  it("getThread returns an empty-shaped thread", async () => {
    const client = new NoopChatClient();
    const result = await client.getThread("thread_1");
    expect(result.id).toBe("");
    expect(result.title).toBeNull();
    expect(result.memberId).toBeNull();
  });

  it("createThread echoes the given agentId", async () => {
    const client = new NoopChatClient();
    const result = await client.createThread("agent-123");
    expect(result.agentId).toBe("agent-123");
    expect(result.id).toBe("");
  });

  it("updateThread echoes the given id and title", async () => {
    const client = new NoopChatClient();
    const result = await client.updateThread("thread_1", { title: "t" });
    expect(result.id).toBe("thread_1");
    expect(result.title).toBe("t");
  });

  it("deleteThread resolves without error", async () => {
    const client = new NoopChatClient();
    await expect(client.deleteThread("thread_1")).resolves.toBeUndefined();
  });

  it("listMessages returns an empty result set", async () => {
    const client = new NoopChatClient();
    const result = await client.listMessages("thread_1");
    expect(result).toEqual({ messages: [], total: 0, limit: 50, offset: 0 });
  });

  it("createMessage echoes threadId/role/body and attachment metadata", async () => {
    const client = new NoopChatClient();
    const result = await client.createMessage("thread_1", "user", "hi", {
      filename: "a.txt",
      size: 3,
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(result.threadId).toBe("thread_1");
    expect(result.role).toBe("user");
    expect(result.body).toBe("hi");
    expect(result.attachmentFilename).toBe("a.txt");
    expect(result.attachmentSize).toBe(3);
  });

  it("getThreadStats returns zeroed stats", async () => {
    const client = new NoopChatClient();
    const result = await client.getThreadStats("thread_1");
    expect(result).toEqual({
      messageCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
    });
  });
});
