/**
 * admin/src/okta-auth-client.integration.test.ts
 * Integration tests for HttpOktaAuthClient against recorded Okta OIDC
 * API fixtures.
 *
 * Drives the client through an INJECTED fetchFn that replays canned Responses
 * from a cassette keyed by scenario — no live API server, no global.fetch
 * override, no mock.module(). Mirrors the pattern in
 * google-auth-client.integration.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { HttpOktaAuthClient } from "./okta-auth-client.ts";

// ─── Cassette ───────────────────────────────────────────────────────────────

interface CassetteEntry {
  status: number;
  body: unknown;
}

const CASSETTE_PATH = new URL(
  "./fixtures/okta-auth-cassette.json",
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
      body:
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : undefined,
    };
    // A string body is replayed verbatim (e.g. a raw error payload) so the
    // client sees genuinely non-JSON-object bytes when relevant; here all
    // cassette bodies are either objects (JSON-encoded) or raw strings.
    const isRaw = typeof entry.body === "string";
    return new Response(
      isRaw ? (entry.body as string) : JSON.stringify(entry.body),
      {
        status: entry.status,
        headers: { "Content-Type": isRaw ? "text/plain" : "application/json" },
      },
    );
  }) as typeof fetch;

  return {
    fetchFn,
    lastRequest: () => {
      if (!last) throw new Error("fetchFn was not called");
      return last;
    },
  };
}

const TEST_ISSUER = "https://example.okta.com/oauth2/default";

function makeClient(
  key: string,
  issuer: string = TEST_ISSUER,
): {
  client: HttpOktaAuthClient;
  lastRequest: () => RecordedRequest;
} {
  const { fetchFn, lastRequest } = cassetteFetch(key);
  const client = new HttpOktaAuthClient({ issuer, fetchFn });
  return { client, lastRequest };
}

// ─── getAuthorizationUrl ─────────────────────────────────────────────────────

describe("HttpOktaAuthClient — getAuthorizationUrl", () => {
  it("builds the authorize URL with standard OIDC query params (pure, no network call)", () => {
    const client = new HttpOktaAuthClient({ issuer: TEST_ISSUER });
    const url = client.getAuthorizationUrl({
      clientId: "client-id-abc",
      redirectUri: "https://example.com/callback",
      state: "state-xyz",
      scope: "openid profile email",
    });

    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      `${TEST_ISSUER}/v1/authorize`,
    );
    expect(parsed.searchParams.get("client_id")).toBe("client-id-abc");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://example.com/callback",
    );
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("scope")).toBe("openid profile email");
    expect(parsed.searchParams.get("state")).toBe("state-xyz");
  });

  it("defaults scope to 'openid profile email' when not provided", () => {
    const client = new HttpOktaAuthClient({ issuer: TEST_ISSUER });
    const url = client.getAuthorizationUrl({
      clientId: "client-id-abc",
      redirectUri: "https://example.com/callback",
      state: "state-xyz",
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe("openid profile email");
  });

  it("normalizes an issuer with a trailing slash to avoid a double slash", () => {
    const client = new HttpOktaAuthClient({
      issuer: "https://example.okta.com/oauth2/default/",
    });
    const url = client.getAuthorizationUrl({
      clientId: "client-id-abc",
      redirectUri: "https://example.com/callback",
      state: "state-xyz",
    });

    expect(url.startsWith(`${TEST_ISSUER}/v1/authorize?`)).toBe(true);
    expect(url.includes("//v1/authorize")).toBe(false);
  });
});

// ─── exchangeCode ────────────────────────────────────────────────────────────

describe("HttpOktaAuthClient — exchangeCode", () => {
  it("POSTs form-encoded params to the Okta token endpoint and maps the response", async () => {
    const { client, lastRequest } = makeClient("exchangeCode_success");
    const result = await client.exchangeCode({
      code: "auth-code-123",
      clientId: "client-id-abc",
      clientSecret: "client-secret-xyz",
      redirectUri: "https://example.com/callback",
    });

    const req = lastRequest();
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${TEST_ISSUER}/v1/token`);
    expect(req.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const params = new URLSearchParams(req.body);
    expect(params.get("code")).toBe("auth-code-123");
    expect(params.get("client_id")).toBe("client-id-abc");
    expect(params.get("client_secret")).toBe("client-secret-xyz");
    expect(params.get("redirect_uri")).toBe("https://example.com/callback");
    expect(params.get("grant_type")).toBe("authorization_code");

    expect(result).toEqual({
      accessToken: "okta.test-access-token",
      refreshToken: "okta.test-refresh-token",
      idToken: "okta.test-id-token-jwt",
      expiresIn: 3600,
    });
  });

  it("maps a response missing optional fields (no refresh/id token)", async () => {
    const { client } = makeClient("exchangeCode_success_no_optional_fields");
    const result = await client.exchangeCode({
      code: "auth-code-123",
      clientId: "client-id-abc",
      clientSecret: "client-secret-xyz",
      redirectUri: "https://example.com/callback",
    });

    expect(result.accessToken).toBe("okta.test-access-token-minimal");
    expect(result.refreshToken).toBeUndefined();
    expect(result.idToken).toBeUndefined();
    expect(result.expiresIn).toBe(3600);
  });

  it("throws on a non-ok response, including the status and body text", async () => {
    const { client } = makeClient("exchangeCode_400");
    await expect(
      client.exchangeCode({
        code: "bad-code",
        clientId: "client-id-abc",
        clientSecret: "client-secret-xyz",
        redirectUri: "https://example.com/callback",
      }),
    ).rejects.toThrow(/Token exchange failed: 400/);
  });

  it("normalizes an issuer with a trailing slash for the token endpoint", async () => {
    const { client, lastRequest } = makeClient(
      "exchangeCode_success",
      "https://example.okta.com/oauth2/default/",
    );
    await client.exchangeCode({
      code: "auth-code-123",
      clientId: "client-id-abc",
      clientSecret: "client-secret-xyz",
      redirectUri: "https://example.com/callback",
    });

    expect(lastRequest().url).toBe(`${TEST_ISSUER}/v1/token`);
  });
});

// ─── getUserInfo ─────────────────────────────────────────────────────────────

describe("HttpOktaAuthClient — getUserInfo", () => {
  it("GETs the userinfo endpoint with a Bearer token and returns the profile", async () => {
    const { client, lastRequest } = makeClient("getUserInfo_success");
    const result = await client.getUserInfo("test-access-token");

    const req = lastRequest();
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${TEST_ISSUER}/v1/userinfo`);
    expect(req.headers.get("authorization")).toBe("Bearer test-access-token");

    expect(result).toEqual({
      sub: "00u1a2b3c4d5e6f7g8h9",
      email: "user@example.com",
      email_verified: true,
      name: "Test User",
      picture: "https://example.com/photo.jpg",
    });
  });

  it("throws on a non-ok response", async () => {
    const { client } = makeClient("getUserInfo_401");
    await expect(client.getUserInfo("bad-token")).rejects.toThrow(
      /Userinfo fetch failed: 401/,
    );
  });
});

// ─── Default construction ───────────────────────────────────────────────────

describe("HttpOktaAuthClient — default construction", () => {
  it("can be constructed with just an issuer (defaults fetchFn to global fetch, no network call)", () => {
    expect(() => new HttpOktaAuthClient({ issuer: TEST_ISSUER })).not.toThrow();
  });
});
