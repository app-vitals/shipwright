/**
 * admin/src/task-store-provisioning-client.integration.test.ts
 * Integration tests for HttpTaskStoreProvisioningClient against recorded
 * task-store token API fixtures.
 *
 * Drives the client through an INJECTED fetchFn that replays canned Responses
 * from a cassette keyed by scenario — no live API server, no global.fetch
 * override, no mock.module(). Mirrors the pattern in
 * kubernetes-client.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  HttpTaskStoreProvisioningClient,
  NoopTaskStoreProvisioningClient,
} from "./task-store-provisioning-client.ts";

// ─── Cassette ───────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

const CASSETTE_PATH = new URL(
  "./fixtures/task-store-provisioning-cassette.json",
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
 * Build an injected fetchFn that returns the cassette entry for `key`.
 * Records the last request so tests can assert URL/method/headers/body.
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
 * Build an injected fetchFn that resolves each request from `cassette[key]`
 * based on the request's method + URL (a simple router), and records every
 * request made — needed for tests that drive multiple calls (e.g. list then
 * revoke several matches) against a single client instance.
 *
 * `routes` maps "METHOD path" (path relative to baseUrl, e.g. "GET /tokens"
 * or "DELETE /tokens/tok_abc123") to a cassette key.
 */
function multiCassetteFetch(routes: Record<string, string>): {
  fetchFn: typeof fetch;
  requests: () => RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const path = url.replace("https://task-store.example.com", "");
    const routeKey = `${method} ${path}`;
    const cassetteKey = routes[routeKey];
    if (!cassetteKey) {
      throw new Error(`no route configured for: ${routeKey}`);
    }
    const entry = cassette[cassetteKey];
    if (!entry) throw new Error(`cassette key not found: ${cassetteKey}`);

    requests.push({
      url,
      method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      statusText: `status-${entry.status}`,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return { fetchFn, requests: () => requests };
}

function makeMultiClient(routes: Record<string, string>): {
  client: HttpTaskStoreProvisioningClient;
  requests: () => RecordedRequest[];
} {
  const { fetchFn, requests } = multiCassetteFetch(routes);
  const client = new HttpTaskStoreProvisioningClient(
    "https://task-store.example.com",
    "admin-token-xyz",
    { fetchFn },
  );
  return { client, requests };
}

function makeClient(key: string): {
  client: HttpTaskStoreProvisioningClient;
  lastRequest: () => RecordedRequest;
} {
  const { fetchFn, lastRequest } = cassetteFetch(key);
  const client = new HttpTaskStoreProvisioningClient(
    "https://task-store.example.com",
    "admin-token-xyz",
    { fetchFn },
  );
  return { client, lastRequest };
}

// ─── mintToken ───────────────────────────────────────────────────────────────

describe("HttpTaskStoreProvisioningClient — mintToken", () => {
  it("POSTs to /tokens with Bearer auth and returns id/rawToken", async () => {
    const { client, lastRequest } = makeClient("mintToken_success");
    const result = await client.mintToken("agent-abc label");

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://task-store.example.com/tokens");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(req.body ?? "{}")).toEqual({ label: "agent-abc label" });
    expect(result).toEqual({
      id: "tok_abc123",
      rawToken: "sts_raw_test_token_value",
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
      /task-store POST \/tokens failed: 500/,
    );
  });
});

// ─── revokeToken ─────────────────────────────────────────────────────────────

describe("HttpTaskStoreProvisioningClient — revokeToken", () => {
  it("DELETEs /tokens/:id with Bearer auth", async () => {
    const { client, lastRequest } = makeClient("revokeToken_success");
    await client.revokeToken("tok_abc123");

    const req = lastRequest();
    expect(req.method).toBe("DELETE");
    expect(req.url).toBe("https://task-store.example.com/tokens/tok_abc123");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");
  });

  it("treats 404 as success (already revoked / not found is not an error)", async () => {
    const { client } = makeClient("revokeToken_404");
    await expect(client.revokeToken("tok_missing")).resolves.toBeUndefined();
  });

  it("throws on a non-ok, non-404 response", async () => {
    const { client } = makeClient("revokeToken_500");
    await expect(client.revokeToken("tok_abc123")).rejects.toThrow(
      /task-store DELETE \/tokens\/tok_abc123 failed: 500/,
    );
  });
});

// ─── listTokensForAgent ────────────────────────────────────────────────────────

describe("HttpTaskStoreProvisioningClient — listTokensForAgent", () => {
  it("GETs /tokens with Bearer auth and filters client-side by agentId", async () => {
    const { client, lastRequest } = makeClient("listTokens_mixedAgents");
    const result = await client.listTokensForAgent("agent-1");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://task-store.example.com/tokens");
    expect(req.headers.get("authorization")).toBe("Bearer admin-token-xyz");

    // Only tokens with agentId === "agent-1" — includes the already-revoked
    // one (revocation state is irrelevant to listing/filtering).
    expect(result).toEqual([
      { id: "tok_agent1_a" },
      { id: "tok_agent1_b" },
      { id: "tok_agent1_revoked" },
    ]);
  });

  it("excludes tokens with a different agentId and tokens with no agentId", async () => {
    const { client } = makeClient("listTokens_mixedAgents");
    const result = await client.listTokensForAgent("agent-2");
    expect(result).toEqual([{ id: "tok_agent2_a" }]);
  });

  it("returns an empty array when no tokens match", async () => {
    const { client } = makeClient("listTokens_noMatches");
    const result = await client.listTokensForAgent("agent-1");
    expect(result).toEqual([]);
  });

  it("returns an empty array when the token list itself is empty", async () => {
    const { client } = makeClient("listTokens_empty");
    const result = await client.listTokensForAgent("agent-1");
    expect(result).toEqual([]);
  });

  it("throws on a non-ok response", async () => {
    const { client } = makeClient("listTokens_500");
    await expect(client.listTokensForAgent("agent-1")).rejects.toThrow(
      /task-store GET \/tokens failed: 500/,
    );
  });
});

// ─── listTokensForAgent + revokeToken orchestration (caller-driven) ──────────

describe("listTokensForAgent + revokeToken — agent token cleanup flow", () => {
  it("revokes every token matching the agent (multiple matches)", async () => {
    const { client, requests } = makeMultiClient({
      "GET /tokens": "listTokens_mixedAgents",
      "DELETE /tokens/tok_agent1_a": "revokeToken_success",
      "DELETE /tokens/tok_agent1_b": "revokeToken_success",
      "DELETE /tokens/tok_agent1_revoked": "revokeToken_success",
    });

    const matches = await client.listTokensForAgent("agent-1");
    expect(matches).toEqual([
      { id: "tok_agent1_a" },
      { id: "tok_agent1_b" },
      { id: "tok_agent1_revoked" },
    ]);

    for (const { id } of matches) {
      await client.revokeToken(id);
    }

    const made = requests();
    expect(made).toHaveLength(4);
    expect(made[0].method).toBe("GET");
    expect(made[0].url).toBe("https://task-store.example.com/tokens");
    expect(made.slice(1).map((r) => r.method)).toEqual([
      "DELETE",
      "DELETE",
      "DELETE",
    ]);

    // Every request only ever touches /tokens paths — never /tasks. This is
    // the client-side guarantee that no Task/assignee mutation occurs: this
    // client has no method that can call anything but the tokens endpoint.
    for (const r of made) {
      expect(r.url).toMatch(
        /^https:\/\/task-store\.example\.com\/tokens(\/|$)/,
      );
      expect(r.url).not.toContain("/tasks");
    }
  });

  it("is a no-op when zero tokens match the agent", async () => {
    const { client, requests } = makeMultiClient({
      "GET /tokens": "listTokens_noMatches",
    });

    const matches = await client.listTokensForAgent("agent-does-not-exist");
    expect(matches).toEqual([]);

    for (const { id } of matches) {
      await client.revokeToken(id);
    }

    expect(requests()).toHaveLength(1);
    expect(requests()[0].method).toBe("GET");
  });

  it("re-revoking an already-revoked token does not throw", async () => {
    const { client, requests } = makeMultiClient({
      "GET /tokens": "listTokens_mixedAgents",
      // tok_agent1_revoked is already revoked server-side; task-store's
      // revoke() is idempotent, so this still returns success (200/204),
      // not a 404 or 500.
      "DELETE /tokens/tok_agent1_revoked": "revokeToken_success",
      "DELETE /tokens/tok_agent1_a": "revokeToken_success",
      "DELETE /tokens/tok_agent1_b": "revokeToken_success",
    });

    const matches = await client.listTokensForAgent("agent-1");
    const revokedMatch = matches.find((m) => m.id === "tok_agent1_revoked");
    expect(revokedMatch).toBeDefined();

    await expect(
      client.revokeToken("tok_agent1_revoked"),
    ).resolves.toBeUndefined();

    const made = requests();
    expect(made.some((r) => r.url.endsWith("/tokens/tok_agent1_revoked"))).toBe(
      true,
    );
  });
});

// ─── NoopTaskStoreProvisioningClient ─────────────────────────────────────────

describe("NoopTaskStoreProvisioningClient", () => {
  it("mintToken returns empty id/rawToken", async () => {
    const client = new NoopTaskStoreProvisioningClient();
    const result = await client.mintToken("label");
    expect(result).toEqual({ id: "", rawToken: "" });
  });

  it("mintToken accepts an agentId without erroring", async () => {
    const client = new NoopTaskStoreProvisioningClient();
    const result = await client.mintToken("label", "agent-1");
    expect(result).toEqual({ id: "", rawToken: "" });
  });

  it("revokeToken resolves without error", async () => {
    const client = new NoopTaskStoreProvisioningClient();
    await expect(client.revokeToken("any-id")).resolves.toBeUndefined();
  });

  it("listTokensForAgent returns an empty array with no-op behavior", async () => {
    const client = new NoopTaskStoreProvisioningClient();
    const result = await client.listTokensForAgent("agent-1");
    expect(result).toEqual([]);
  });
});
