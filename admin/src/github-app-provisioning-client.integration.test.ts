/**
 * admin/src/github-app-provisioning-client.integration.test.ts
 * Integration tests for HttpGithubAppProvisioningClient against recorded
 * GitHub API fixtures.
 *
 * Drives the client through an INJECTED fetchFn that replays canned Responses
 * from a cassette keyed by scenario — no live API server, no global.fetch
 * override, no mock.module(). Mirrors the pattern in
 * slack-provisioning-client.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { HttpGithubAppProvisioningClient } from "./github-app-provisioning-client.ts";

// ─── Cassette ───────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

const CASSETTE_PATH = new URL(
  "./fixtures/github-app-manifest-cassette.json",
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
  client: HttpGithubAppProvisioningClient;
  lastRequest: () => RecordedRequest;
} {
  const { fetchFn, lastRequest } = cassetteFetch(key);
  const client = new HttpGithubAppProvisioningClient({ fetchFn });
  return { client, lastRequest };
}

// ─── exchangeManifestCode ────────────────────────────────────────────────────

describe("HttpGithubAppProvisioningClient — exchangeManifestCode", () => {
  it("POSTs unauthenticated to app-manifests/{code}/conversions and returns narrowed fields", async () => {
    const { client, lastRequest } = makeClient("exchangeManifestCode_success");
    const result = await client.exchangeManifestCode("test-code");

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      "https://api.github.com/app-manifests/test-code/conversions",
    );
    expect(req.headers.get("authorization")).toBeNull();

    expect(result).toEqual({
      appId: "123456",
      slug: "test-agent-app",
      pem: "-----BEGIN RSA PRIVATE KEY-----\ntestpemcontents\n-----END RSA PRIVATE KEY-----\n",
      clientId: "Iv1.testclientid1234",
      clientSecret: "test-client-secret-value",
    });
  });

  it("never stores or returns webhook_secret", async () => {
    const { client } = makeClient("exchangeManifestCode_success");
    const result = await client.exchangeManifestCode("test-code");

    expect(result).not.toHaveProperty("webhookSecret");
    expect(result).not.toHaveProperty("webhook_secret");
    expect(Object.keys(result)).not.toContain("webhookSecret");
    expect(JSON.stringify(result)).not.toContain("test-webhook-secret");
  });

  it("throws a descriptive error on a 404 (bad/expired code)", async () => {
    const { client } = makeClient("exchangeManifestCode_not_found");
    await expect(client.exchangeManifestCode("bad-code")).rejects.toThrow(
      /GitHub app-manifests conversion HTTP error: 404/,
    );
  });

  it("throws a descriptive error on a 422 (validation failed)", async () => {
    const { client } = makeClient("exchangeManifestCode_unprocessable");
    await expect(client.exchangeManifestCode("bad-code")).rejects.toThrow(
      /GitHub app-manifests conversion HTTP error: 422/,
    );
  });

  it("throws a descriptive error when required fields are missing from an ok response", async () => {
    const { client } = makeClient("exchangeManifestCode_missing_fields");
    await expect(client.exchangeManifestCode("test-code")).rejects.toThrow(
      /response missing/,
    );
  });
});

// ─── Default construction (no opts) ─────────────────────────────────────────

describe("HttpGithubAppProvisioningClient — default construction", () => {
  it("can be constructed with no arguments (defaults apiBase and fetchFn)", () => {
    expect(() => new HttpGithubAppProvisioningClient()).not.toThrow();
  });

  it("can be constructed with empty opts", () => {
    expect(() => new HttpGithubAppProvisioningClient({})).not.toThrow();
  });
});
