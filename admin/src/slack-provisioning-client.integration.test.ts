/**
 * admin/src/slack-provisioning-client.integration.test.ts
 * Integration tests for HttpSlackProvisioningClient against recorded Slack
 * API fixtures.
 *
 * Drives the client through an INJECTED fetchFn that replays canned Responses
 * from a cassette keyed by scenario — no live API server, no global.fetch
 * override, no mock.module(). Mirrors the pattern in
 * kubernetes-client.integration.test.ts.
 *
 * Distinct from slack-provisioning.integration.test.ts, which tests the
 * admin-ui route flow via a hand-written RecordedSlackClient double and does
 * not exercise HttpSlackProvisioningClient's actual HTTP/fetch logic.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { HttpSlackProvisioningClient } from "./slack-provisioning-client.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";

// ─── Cassette ───────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

const CASSETTE_PATH = new URL(
  "./fixtures/slack-provisioning-http-cassette.json",
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
  client: HttpSlackProvisioningClient;
  lastRequest: () => RecordedRequest;
} {
  const { fetchFn, lastRequest } = cassetteFetch(key);
  const client = new HttpSlackProvisioningClient({ fetchFn });
  return { client, lastRequest };
}

const MANIFEST: AppManifest = {
  display_information: { name: "test-agent" },
};

// ─── exchangeOAuthCode ───────────────────────────────────────────────────────

describe("HttpSlackProvisioningClient — exchangeOAuthCode", () => {
  it("POSTs Basic-auth form-encoded params to oauth.v2.access and returns the bot token", async () => {
    const { client, lastRequest } = makeClient("exchangeOAuthCode_success");
    const result = await client.exchangeOAuthCode(
      "auth-code",
      "client-id",
      "client-secret",
      "https://example.com/callback",
    );

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://slack.com/api/oauth.v2.access");
    const expectedAuth = `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`;
    expect(req.headers.get("authorization")).toBe(expectedAuth);
    expect(req.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(req.body);
    expect(params.get("code")).toBe("auth-code");
    expect(params.get("redirect_uri")).toBe("https://example.com/callback");

    expect(result).toEqual({ botToken: "xoxb-test-bot-token" });
  });

  it("throws on an HTTP error response", async () => {
    const { client } = makeClient("exchangeOAuthCode_http_error");
    await expect(
      client.exchangeOAuthCode("code", "id", "secret", "https://x.com"),
    ).rejects.toThrow(/Slack oauth\.v2\.access HTTP error: 500/);
  });

  it("throws when Slack returns ok: false", async () => {
    const { client } = makeClient("exchangeOAuthCode_slack_error");
    await expect(
      client.exchangeOAuthCode("code", "id", "secret", "https://x.com"),
    ).rejects.toThrow(/Slack oauth\.v2\.access failed: invalid_code/);
  });

  it("throws when access_token is missing from an ok response", async () => {
    const { client } = makeClient("exchangeOAuthCode_missing_access_token");
    await expect(
      client.exchangeOAuthCode("code", "id", "secret", "https://x.com"),
    ).rejects.toThrow(/response missing access_token/);
  });
});

// ─── updateAppManifest ───────────────────────────────────────────────────────

describe("HttpSlackProvisioningClient — updateAppManifest", () => {
  it("POSTs Bearer-auth JSON to apps.manifest.update", async () => {
    const { client, lastRequest } = makeClient("updateAppManifest_success");
    await client.updateAppManifest("xoxp-token", "A0123456789", MANIFEST);

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://slack.com/api/apps.manifest.update");
    expect(req.headers.get("authorization")).toBe("Bearer xoxp-token");
    expect(req.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    const body = JSON.parse(req.body ?? "{}");
    expect(body.app_id).toBe("A0123456789");
    expect(JSON.parse(body.manifest)).toEqual(MANIFEST);
  });

  it("throws on an HTTP error response", async () => {
    const { client } = makeClient("updateAppManifest_http_error");
    await expect(
      client.updateAppManifest("xoxp-token", "A0123456789", MANIFEST),
    ).rejects.toThrow(/Slack apps\.manifest\.update HTTP error: 500/);
  });

  it("throws when Slack returns ok: false", async () => {
    const { client } = makeClient("updateAppManifest_slack_error");
    await expect(
      client.updateAppManifest("xoxp-token", "A0123456789", MANIFEST),
    ).rejects.toThrow(/Slack apps\.manifest\.update failed: invalid_manifest/);
  });
});

// ─── createAppManifest ───────────────────────────────────────────────────────

describe("HttpSlackProvisioningClient — createAppManifest", () => {
  it("POSTs Bearer-auth JSON to apps.manifest.create and returns credentials", async () => {
    const { client, lastRequest } = makeClient("createAppManifest_success");
    const result = await client.createAppManifest("xoxp-token", MANIFEST);

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://slack.com/api/apps.manifest.create");
    expect(req.headers.get("authorization")).toBe("Bearer xoxp-token");
    const body = JSON.parse(req.body ?? "{}");
    expect(JSON.parse(body.manifest)).toEqual(MANIFEST);

    expect(result).toEqual({
      appId: "A0123456789",
      oauthRedirectUrl: "https://slack.com/oauth/authorize?client_id=123",
      clientId: "123456789.987654321",
      clientSecret: "test-client-secret",
      signingSecret: "test-signing-secret",
    });
  });

  it("throws on an HTTP error response", async () => {
    const { client } = makeClient("createAppManifest_http_error");
    await expect(
      client.createAppManifest("xoxp-token", MANIFEST),
    ).rejects.toThrow(/Slack apps\.manifest\.create HTTP error: 500/);
  });

  it("throws when Slack returns ok: false", async () => {
    const { client } = makeClient("createAppManifest_slack_error");
    await expect(
      client.createAppManifest("xoxp-token", MANIFEST),
    ).rejects.toThrow(/Slack apps\.manifest\.create failed: invalid_manifest/);
  });

  it("throws when app_id or oauth_authorize_url is missing", async () => {
    const { client } = makeClient("createAppManifest_missing_app_id");
    await expect(
      client.createAppManifest("xoxp-token", MANIFEST),
    ).rejects.toThrow(/response missing app_id or oauth_authorize_url/);
  });

  it("throws when credentials are missing", async () => {
    const { client } = makeClient("createAppManifest_missing_credentials");
    await expect(
      client.createAppManifest("xoxp-token", MANIFEST),
    ).rejects.toThrow(/response missing credentials/);
  });
});

// ─── Default construction (no opts) ─────────────────────────────────────────

describe("HttpSlackProvisioningClient — default construction", () => {
  it("can be constructed with no arguments (defaults apiBase and fetchFn)", () => {
    expect(() => new HttpSlackProvisioningClient()).not.toThrow();
  });

  it("can be constructed with empty opts", () => {
    expect(() => new HttpSlackProvisioningClient({})).not.toThrow();
  });
});
