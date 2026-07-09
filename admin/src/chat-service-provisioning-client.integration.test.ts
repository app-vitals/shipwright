/**
 * admin/src/chat-service-provisioning-client.integration.test.ts
 * Integration tests for HttpChatServiceProvisioningClient against recorded
 * chat-service token/thread API fixtures.
 *
 * Drives the client through an INJECTED fetchFn that replays canned Responses
 * from a cassette keyed by scenario — no live API server, no global.fetch
 * override, no mock.module(). Mirrors the pattern in
 * task-store-provisioning-client.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  HttpChatServiceProvisioningClient,
  NoopChatServiceProvisioningClient,
} from "./chat-service-provisioning-client.ts";

// ─── Cassette ───────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

const CASSETTE_PATH = new URL(
  "./fixtures/chat-service-provisioning-cassette.json",
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

/**
 * Build an injected fetchFn for multi-request flows (e.g. list-then-delete).
 * `routes` is an ordered list of `{ match, key }` pairs; the first entry whose
 * `match(url, method)` returns true is used to resolve the cassette entry for
 * that call. Records every request made, in order.
 */
function multiCassetteFetch(
  routes: { match: (url: string, method: string) => boolean; key: string }[],
): {
  fetchFn: typeof fetch;
  requests: () => RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    const route = routes.find((r) => r.match(url, method));
    if (!route) {
      throw new Error(`multiCassetteFetch: no route matched ${method} ${url}`);
    }
    const entry = cassette[route.key];
    if (!entry) throw new Error(`cassette key not found: ${route.key}`);
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      statusText: `status-${entry.status}`,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return { fetchFn, requests: () => requests };
}

function makeClient(key: string): {
  client: HttpChatServiceProvisioningClient;
  lastRequest: () => RecordedRequest;
} {
  const { fetchFn, lastRequest } = cassetteFetch(key);
  const client = new HttpChatServiceProvisioningClient(
    "https://chat.example.com",
    "admin-token-xyz",
    { fetchFn },
  );
  return { client, lastRequest };
}

// ─── mintToken ───────────────────────────────────────────────────────────────

describe("HttpChatServiceProvisioningClient — mintToken", () => {
  it("POSTs to /tokens with Bearer auth and returns id/rawToken", async () => {
    const { client, lastRequest } = makeClient("mintToken_success");
    const result = await client.mintToken("agent-abc label");

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://chat.example.com/tokens");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(req.body ?? "{}")).toEqual({ label: "agent-abc label" });
    expect(result).toEqual({
      id: "tok_abc123",
      rawToken: "cst_raw_test_token_value",
    });
  });

  it("includes agentId in the body when provided", async () => {
    const { client, lastRequest } = makeClient(
      "mintToken_success_with_agentId",
    );
    const result = await client.mintToken("agent-scoped label", "agent-123");

    const req = lastRequest();
    expect(JSON.parse(req.body ?? "{}")).toEqual({
      label: "agent-scoped label",
      agentId: "agent-123",
    });
    expect(result.id).toBe("tok_def456");
  });

  it("throws on a non-ok response", async () => {
    const { client } = makeClient("mintToken_500");
    await expect(client.mintToken("label")).rejects.toThrow(
      /chat-service POST \/tokens failed: 500/,
    );
  });
});

// ─── revokeToken ─────────────────────────────────────────────────────────────

describe("HttpChatServiceProvisioningClient — revokeToken", () => {
  it("DELETEs /tokens/:id with Bearer auth", async () => {
    const { client, lastRequest } = makeClient("revokeToken_success");
    await client.revokeToken("tok_abc123");

    const req = lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("https://chat.example.com/tokens/tok_abc123");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
  });

  it("treats 404 as success (already revoked / not found is not an error)", async () => {
    const { client } = makeClient("revokeToken_404");
    await expect(client.revokeToken("tok_missing")).resolves.toBeUndefined();
  });

  it("throws on a non-ok, non-404 response", async () => {
    const { client } = makeClient("revokeToken_500");
    await expect(client.revokeToken("tok_abc123")).rejects.toThrow(
      /chat-service DELETE \/tokens\/tok_abc123 failed: 500/,
    );
  });
});

// ─── listTokensForAgent ───────────────────────────────────────────────────────

describe("HttpChatServiceProvisioningClient — listTokensForAgent", () => {
  it("GETs /tokens and filters client-side by agentId", async () => {
    const { client, lastRequest } = makeClient("listTokens_mixed_agents");
    const result = await client.listTokensForAgent("agent-123");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://chat.example.com/tokens");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(result).toEqual([{ id: "tok_1" }, { id: "tok_3" }]);
  });

  it("returns an empty array when no tokens exist", async () => {
    const { client } = makeClient("listTokens_empty");
    const result = await client.listTokensForAgent("agent-123");
    expect(result).toEqual([]);
  });

  it("returns an empty array when no tokens match the agentId", async () => {
    const { client } = makeClient("listTokens_mixed_agents");
    const result = await client.listTokensForAgent("agent-does-not-exist");
    expect(result).toEqual([]);
  });

  it("throws on a non-ok response", async () => {
    const { client } = makeClient("listTokens_500");
    await expect(client.listTokensForAgent("agent-123")).rejects.toThrow(
      /chat-service GET \/tokens failed: 500/,
    );
  });
});

// ─── deleteThreadsForAgent ────────────────────────────────────────────────────

describe("HttpChatServiceProvisioningClient — deleteThreadsForAgent", () => {
  it("deletes every thread scoped to agentId, following pagination", async () => {
    const { fetchFn, requests } = multiCassetteFetch([
      {
        match: (url, method) =>
          method === "GET" &&
          url === "https://chat.example.com/threads?agentId=agent-123&offset=0",
        key: "listThreads_page_agent123_page1",
      },
      {
        match: (url, method) =>
          method === "GET" &&
          url === "https://chat.example.com/threads?agentId=agent-123&offset=2",
        key: "listThreads_page_agent123_page2",
      },
      {
        match: (url, method) =>
          method === "DELETE" &&
          url === "https://chat.example.com/threads/thread_1",
        key: "deleteThread_success",
      },
      {
        match: (url, method) =>
          method === "DELETE" &&
          url === "https://chat.example.com/threads/thread_2",
        key: "deleteThread_success",
      },
      {
        match: (url, method) =>
          method === "DELETE" &&
          url === "https://chat.example.com/threads/thread_3",
        key: "deleteThread_success",
      },
    ]);
    const client = new HttpChatServiceProvisioningClient(
      "https://chat.example.com",
      "admin-token-xyz",
      { fetchFn },
    );

    const result = await client.deleteThreadsForAgent("agent-123");

    expect(result).toEqual({ deleted: 3 });
    const deleteRequests = requests().filter((r) => r.method === "DELETE");
    expect(deleteRequests.map((r) => r.url).sort()).toEqual([
      "https://chat.example.com/threads/thread_1",
      "https://chat.example.com/threads/thread_2",
      "https://chat.example.com/threads/thread_3",
    ]);
    for (const req of deleteRequests) {
      expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    }
  });

  it("returns {deleted: 0} and makes no DELETE calls when there are no threads", async () => {
    const { fetchFn, requests } = multiCassetteFetch([
      {
        match: (url, method) => method === "GET" && url.includes("/threads"),
        key: "listThreads_empty",
      },
    ]);
    const client = new HttpChatServiceProvisioningClient(
      "https://chat.example.com",
      "admin-token-xyz",
      { fetchFn },
    );

    const result = await client.deleteThreadsForAgent("agent-none");

    expect(result).toEqual({ deleted: 0 });
    expect(requests().some((r) => r.method === "DELETE")).toBe(false);
  });

  it("tolerates a thread already deleted mid-loop (404) without throwing", async () => {
    const { fetchFn } = multiCassetteFetch([
      {
        match: (url, method) => method === "GET" && url.includes("/threads"),
        key: "listThreads_agent456_single_page",
      },
      {
        match: (url, method) =>
          method === "DELETE" &&
          url === "https://chat.example.com/threads/thread_10",
        key: "deleteThread_404",
      },
      {
        match: (url, method) =>
          method === "DELETE" &&
          url === "https://chat.example.com/threads/thread_11",
        key: "deleteThread_success",
      },
    ]);
    const client = new HttpChatServiceProvisioningClient(
      "https://chat.example.com",
      "admin-token-xyz",
      { fetchFn },
    );

    const result = await client.deleteThreadsForAgent("agent-456");

    // A tolerated 404 still counts as an attempted (completed) delete — this
    // matters for retries where a previous run already deleted some threads.
    expect(result).toEqual({ deleted: 2 });
  });

  it("throws on a non-ok, non-404 thread delete response", async () => {
    const { fetchFn } = multiCassetteFetch([
      {
        match: (url, method) => method === "GET" && url.includes("/threads"),
        key: "listThreads_agent456_single_page",
      },
      {
        match: (url, method) => method === "DELETE",
        key: "deleteThread_500",
      },
    ]);
    const client = new HttpChatServiceProvisioningClient(
      "https://chat.example.com",
      "admin-token-xyz",
      { fetchFn },
    );

    await expect(client.deleteThreadsForAgent("agent-456")).rejects.toThrow(
      /chat-service DELETE \/threads\/thread_10 failed: 500/,
    );
  });

  it("throws on a non-ok thread list response", async () => {
    const { fetchFn } = multiCassetteFetch([
      {
        match: (url, method) => method === "GET" && url.includes("/threads"),
        key: "listThreads_500",
      },
    ]);
    const client = new HttpChatServiceProvisioningClient(
      "https://chat.example.com",
      "admin-token-xyz",
      { fetchFn },
    );

    await expect(client.deleteThreadsForAgent("agent-123")).rejects.toThrow(
      /chat-service GET \/threads failed: 500/,
    );
  });
});

// ─── NoopChatServiceProvisioningClient ────────────────────────────────────────

describe("NoopChatServiceProvisioningClient", () => {
  it("mintToken returns empty id/rawToken", async () => {
    const client = new NoopChatServiceProvisioningClient();
    const result = await client.mintToken("label");
    expect(result).toEqual({ id: "", rawToken: "" });
  });

  it("mintToken accepts an agentId without erroring", async () => {
    const client = new NoopChatServiceProvisioningClient();
    const result = await client.mintToken("label", "agent-1");
    expect(result).toEqual({ id: "", rawToken: "" });
  });

  it("revokeToken resolves without error", async () => {
    const client = new NoopChatServiceProvisioningClient();
    await expect(client.revokeToken("any-id")).resolves.toBeUndefined();
  });

  it("listTokensForAgent returns an empty array", async () => {
    const client = new NoopChatServiceProvisioningClient();
    const result = await client.listTokensForAgent("agent-1");
    expect(result).toEqual([]);
  });

  it("deleteThreadsForAgent returns {deleted: 0}", async () => {
    const client = new NoopChatServiceProvisioningClient();
    const result = await client.deleteThreadsForAgent("agent-1");
    expect(result).toEqual({ deleted: 0 });
  });
});
