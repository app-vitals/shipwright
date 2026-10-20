/**
 * admin/src/anthropic-identity-client.fixtures.ts
 * Test support for the Anthropic identity client (never imported by production
 * code):
 *
 *   - the recorded fixture loader and a replaying `fetch` double that asserts
 *     every outgoing request matches the next recorded interaction, and
 *   - `FakeAnthropicTokenExchange`, a test double for POST /v1/oauth/token.
 *
 * KNOWN GAP: POST /v1/oauth/token is not part of the Anthropic OpenAPI spec
 * (anthropics/anthropic-sdk-typescript scripts/mock-spec.json.gz), so the token
 * exchange cannot be validated as a recorded fixture against it. The fake below mirrors the
 * wire format the Anthropic SDK itself sends (RFC 7523 jwt-bearer grant) and is
 * the only coverage for that call. It is documented in
 * docs/test-readiness/test-system.md.
 */

import { readFileSync } from "node:fs";

// ─── Recorded fixtures ───────────────────────────────────────────────────────

export interface RecordedRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface RecordedResponse {
  status: number;
  body: unknown;
}

export interface RecordedInteraction {
  request: RecordedRequest;
  response: RecordedResponse;
}

export interface AnthropicRecordedFixtures {
  scenarios: Record<string, RecordedInteraction[]>;
}

export const RECORDED_FIXTURES_PATH = new URL(
  "./fixtures/anthropic-identity-recorded-fixtures.json",
  import.meta.url,
).pathname;

export function loadRecordedFixtures(): AnthropicRecordedFixtures {
  return JSON.parse(
    readFileSync(RECORDED_FIXTURES_PATH, "utf-8"),
  ) as AnthropicRecordedFixtures;
}

export interface SeenRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

/** Type a hand-written async function as a `fetch` (adds no behaviour). */
export function asFetch(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return fn as unknown as typeof fetch;
}

export const TOKEN_EXCHANGE_PATH = "/v1/oauth/token";

export interface RecordedFixtureFetch {
  fetchFn: typeof fetch;
  /** Every request seen by the double, including token exchanges. */
  seen: SeenRequest[];
  /** API (non token-exchange) requests only. */
  apiRequests: () => SeenRequest[];
}

async function readBody(input: RequestInfo | URL, init?: RequestInit) {
  const raw =
    typeof init?.body === "string"
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : undefined;
  if (!raw) return undefined;
  return JSON.parse(raw) as unknown;
}

/**
 * Build an injected `fetch` that replays the interactions of one recorded fixture
 * scenario in order, throwing if a request deviates from the recording (method,
 * path, query or JSON body). Requests to the token endpoint are routed to
 * `tokenExchange` instead of the recorded fixtures.
 */
export function recordedFixtureFetch(
  scenario: string,
  opts: { tokenExchange?: FakeAnthropicTokenExchange } = {},
): RecordedFixtureFetch {
  const interactions = loadRecordedFixtures().scenarios[scenario];
  if (!interactions)
    throw new Error(`recorded fixture scenario not found: ${scenario}`);
  const seen: SeenRequest[] = [];
  let cursor = 0;

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const body = await readBody(input, init);
    const request: SeenRequest = { method, url, headers, body };
    seen.push(request);

    if (url.pathname === TOKEN_EXCHANGE_PATH) {
      if (!opts.tokenExchange) {
        throw new Error("unexpected token exchange: no tokenExchange double");
      }
      return opts.tokenExchange.handle(request);
    }

    const next = interactions[cursor++];
    if (!next) {
      throw new Error(
        `recorded fixture ${scenario}: unexpected extra request ${method} ${url.pathname}`,
      );
    }
    const expected = next.request;
    if (method !== expected.method || url.pathname !== expected.path) {
      throw new Error(
        `recorded fixture ${scenario}: expected ${expected.method} ${expected.path}, got ${method} ${url.pathname}`,
      );
    }
    const query = Object.fromEntries(url.searchParams.entries());
    if (!Bun.deepEquals(query, expected.query ?? {})) {
      throw new Error(
        `recorded fixture ${scenario}: query mismatch, expected ${JSON.stringify(expected.query ?? {})}, got ${JSON.stringify(query)}`,
      );
    }
    if (!Bun.deepEquals(body, expected.body)) {
      throw new Error(
        `recorded fixture ${scenario}: body mismatch for ${method} ${url.pathname}`,
      );
    }
    return new Response(JSON.stringify(next.response.body), {
      status: next.response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    fetchFn,
    seen,
    apiRequests: () =>
      seen.filter((r) => r.url.pathname !== TOKEN_EXCHANGE_PATH),
  };
}

// ─── Fake token exchange ────────────────────────────────────────────────────

export interface FakeTokenExchangeOptions {
  /** Access token handed out; `{n}` is replaced by the 1-based call number. */
  accessTokenTemplate?: string;
  expiresIn?: number;
  /** When set, every exchange answers with this status and body instead. */
  failWith?: { status: number; body: unknown };
  /** Override the success body (e.g. to test malformed responses). */
  successBody?: (callNumber: number) => unknown;
}

/**
 * Test double for POST /v1/oauth/token. Records the assertion it was given so
 * tests can prove the projected token was re-read, and answers with
 * synthetic, obviously-fake tokens.
 */
export class FakeAnthropicTokenExchange {
  readonly assertions: string[] = [];
  readonly requests: SeenRequest[] = [];

  constructor(private readonly opts: FakeTokenExchangeOptions = {}) {}

  get calls(): number {
    return this.requests.length;
  }

  /** The access token the n-th (1-based) exchange returns. */
  accessTokenFor(callNumber: number): string {
    return (this.opts.accessTokenTemplate ?? "fake-access-token-{n}").replace(
      "{n}",
      String(callNumber),
    );
  }

  handle(request: SeenRequest): Response {
    this.requests.push(request);
    const body = request.body as { assertion?: string } | undefined;
    this.assertions.push(body?.assertion ?? "");
    if (this.opts.failWith) {
      return new Response(JSON.stringify(this.opts.failWith.body), {
        status: this.opts.failWith.status,
        headers: {
          "Content-Type": "application/json",
          "Request-Id": "req_fake",
        },
      });
    }
    const n = this.requests.length;
    const payload = this.opts.successBody?.(n) ?? {
      access_token: this.accessTokenFor(n),
      token_type: "Bearer",
      expires_in: this.opts.expiresIn ?? 3600,
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** A standalone fetch for tests that exercise the token provider alone. */
  asFetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      return this.handle({
        method: (init?.method ?? "GET").toUpperCase(),
        url,
        headers: new Headers(init?.headers),
        body: await readBody(input, init),
      });
    }) as typeof fetch;
  }
}
