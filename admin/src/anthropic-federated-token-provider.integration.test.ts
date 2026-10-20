/**
 * admin/src/anthropic-federated-token-provider.integration.test.ts
 * FederatedTokenProvider against the FakeAnthropicTokenExchange test double
 * (POST /v1/oauth/token is not in the Anthropic OpenAPI spec, so there is no
 * spec-validated recorded fixture for it — see anthropic-identity-client.fixtures.ts).
 * The projected token is a real temp file; time is an injected Clock.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnthropicTokenExchangeError,
  FederatedTokenProvider,
} from "./anthropic-federated-token-provider.ts";
import {
  asFetch,
  FakeAnthropicTokenExchange,
} from "./anthropic-identity-client.fixtures.ts";
import type { Clock } from "./clock.ts";

class MutableClock implements Clock {
  constructor(private ms: number) {}
  now(): Date {
    return new Date(this.ms);
  }
  advanceSeconds(s: number): void {
    this.ms += s * 1000;
  }
}

let dir: string;
let tokenFile: string;
let clock: MutableClock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anthropic-token-"));
  tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "projected-jwt-v1\n");
  clock = new MutableClock(Date.parse("2026-10-01T12:00:00Z"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeProvider(
  exchange: FakeAnthropicTokenExchange,
  extra: Partial<ConstructorParameters<typeof FederatedTokenProvider>[0]> = {},
) {
  return new FederatedTokenProvider({
    fetchFn: exchange.asFetch(),
    tokenFilePath: tokenFile,
    federationRuleId: "fdrl_01Admin",
    organizationId: "org-1234",
    clock,
    ...extra,
  });
}

describe("FederatedTokenProvider", () => {
  it("POSTs a jwt-bearer grant with the projected token and returns the access token", async () => {
    const exchange = new FakeAnthropicTokenExchange();
    const provider = makeProvider(exchange, {
      serviceAccountId: "svac_01Admin",
      workspaceId: "wrkspc_01Work",
    });

    expect(await provider.getAccessToken()).toBe("fake-access-token-1");

    const req = exchange.requests[0];
    expect(req.method).toBe("POST");
    expect(req.url.toString()).toBe("https://api.anthropic.com/v1/oauth/token");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("anthropic-beta")).toContain(
      "oidc-federation-2026-04-01",
    );
    expect(req.body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: "projected-jwt-v1",
      federation_rule_id: "fdrl_01Admin",
      organization_id: "org-1234",
      service_account_id: "svac_01Admin",
      workspace_id: "wrkspc_01Work",
    });
  });

  it("omits optional ids when not configured", async () => {
    const exchange = new FakeAnthropicTokenExchange();
    await makeProvider(exchange).getAccessToken();
    expect(Object.keys(exchange.requests[0].body as object).sort()).toEqual([
      "assertion",
      "federation_rule_id",
      "grant_type",
      "organization_id",
    ]);
  });

  it("caches the access token until shortly before expires_in", async () => {
    const exchange = new FakeAnthropicTokenExchange({ expiresIn: 3600 });
    const provider = makeProvider(exchange);

    await provider.getAccessToken();
    clock.advanceSeconds(3600 - 61);
    expect(await provider.getAccessToken()).toBe("fake-access-token-1");
    expect(exchange.calls).toBe(1);

    clock.advanceSeconds(2);
    expect(await provider.getAccessToken()).toBe("fake-access-token-2");
    expect(exchange.calls).toBe(2);
  });

  it("re-reads the projected token file on every exchange (kubelet rotation)", async () => {
    const exchange = new FakeAnthropicTokenExchange({ expiresIn: 120 });
    const provider = makeProvider(exchange);

    await provider.getAccessToken();
    writeFileSync(tokenFile, "projected-jwt-v2\n");
    clock.advanceSeconds(200);
    await provider.getAccessToken();

    expect(exchange.assertions).toEqual([
      "projected-jwt-v1",
      "projected-jwt-v2",
    ]);
  });

  it("invalidate() forces a fresh exchange", async () => {
    const exchange = new FakeAnthropicTokenExchange();
    const provider = makeProvider(exchange);
    await provider.getAccessToken();
    provider.invalidate();
    expect(await provider.getAccessToken()).toBe("fake-access-token-2");
  });

  it("coalesces concurrent callers into one exchange", async () => {
    const exchange = new FakeAnthropicTokenExchange();
    const provider = makeProvider(exchange);
    const tokens = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(exchange.calls).toBe(1);
  });

  it("fails clearly, without file contents, when the token file is missing", async () => {
    rmSync(tokenFile);
    const provider = makeProvider(new FakeAnthropicTokenExchange());
    const err = await provider.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AnthropicTokenExchangeError);
    expect(err.message).toMatch(/projected token file/i);
    expect(err.message).toContain(tokenFile);
  });

  it("fails when the token file is empty", async () => {
    writeFileSync(tokenFile, "  \n");
    const provider = makeProvider(new FakeAnthropicTokenExchange());
    await expect(provider.getAccessToken()).rejects.toThrow(/empty/i);
  });

  it("surfaces status, error code and request-id on exchange failure but never echoed secrets", async () => {
    const exchange = new FakeAnthropicTokenExchange({
      failWith: {
        status: 401,
        body: {
          error: "invalid_grant",
          error_description: "no matching rule",
          assertion: "projected-jwt-v1",
          access_token: "echoed-access-token",
        },
      },
    });
    const err = await makeProvider(exchange)
      .getAccessToken()
      .catch((e) => e);
    expect(err).toBeInstanceOf(AnthropicTokenExchangeError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_grant");
    expect(err.message).toContain("401");
    expect(err.message).toContain("req_fake");
    expect(err.message).not.toContain("projected-jwt-v1");
    expect(err.message).not.toContain("echoed-access-token");
  });

  it("rejects a success body that fails schema validation without echoing it", async () => {
    const exchange = new FakeAnthropicTokenExchange({
      successBody: () => ({ access_token: "", leaked: "do-not-print" }),
    });
    const err = await makeProvider(exchange)
      .getAccessToken()
      .catch((e) => e);
    expect(err).toBeInstanceOf(AnthropicTokenExchangeError);
    expect(err.message).not.toContain("do-not-print");
  });

  it("rejects a non-bearer token_type", async () => {
    const exchange = new FakeAnthropicTokenExchange({
      successBody: () => ({
        access_token: "fake-access-token",
        token_type: "mac",
        expires_in: 60,
      }),
    });
    await expect(makeProvider(exchange).getAccessToken()).rejects.toThrow(
      /token_type/,
    );
  });

  it("rejects a non-JSON response", async () => {
    const fetchFn = asFetch(
      async () => new Response("<html>oops</html>", { status: 200 }),
    );
    const provider = new FederatedTokenProvider({
      fetchFn,
      tokenFilePath: tokenFile,
      federationRuleId: "fdrl_01Admin",
      organizationId: "org-1234",
      clock,
    });
    await expect(provider.getAccessToken()).rejects.toThrow(/not valid JSON/);
  });

  it("wraps network failures without leaking the assertion", async () => {
    const fetchFn = asFetch(async () => {
      throw new Error("connect ECONNREFUSED projected-jwt-v1");
    });
    const provider = new FederatedTokenProvider({
      fetchFn,
      tokenFilePath: tokenFile,
      federationRuleId: "fdrl_01Admin",
      organizationId: "org-1234",
      clock,
    });
    const err = await provider.getAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AnthropicTokenExchangeError);
    expect(err.message).not.toContain("projected-jwt-v1");
  });

  it("refuses to send the assertion to a non-https, non-loopback base URL", async () => {
    const exchange = new FakeAnthropicTokenExchange();
    const provider = makeProvider(exchange, { baseUrl: "http://example.com" });
    await expect(provider.getAccessToken()).rejects.toThrow(/https/);
    expect(exchange.calls).toBe(0);
  });
});
