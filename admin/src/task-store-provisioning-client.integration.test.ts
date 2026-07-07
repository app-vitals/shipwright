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
});
