/**
 * admin/src/anthropic-identity-client.integration.test.ts
 * HttpAnthropicIdentityClient against recorded fixture doubles
 * (fixtures/anthropic-identity-recorded-fixtures.json) replayed through an INJECTED
 * fetch — no live API, no global.fetch override, no mock.module().
 *
 * The recorded fixtures are validated against the pinned Anthropic OpenAPI spec by
 * anthropic-identity-fixture-spec.integration.test.ts. The projected-token
 * exchange (POST /v1/oauth/token, not in the spec) is the
 * FakeAnthropicTokenExchange test double.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FederatedTokenProvider } from "./anthropic-federated-token-provider.ts";
import {
  asFetch,
  FakeAnthropicTokenExchange,
  recordedFixtureFetch,
  TOKEN_EXCHANGE_PATH,
} from "./anthropic-identity-client.fixtures.ts";
import {
  AnthropicApiError,
  AnthropicAuthError,
  AnthropicConflictError,
  AnthropicResponseValidationError,
  HttpAnthropicIdentityClient,
} from "./anthropic-identity-client.ts";
import { FixedClock } from "./clock.ts";

let dir: string;
let tokenFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anthropic-client-"));
  tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "projected-jwt-secret\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function withFetch(fetchFn: typeof fetch) {
  const tokenProvider = new FederatedTokenProvider({
    fetchFn,
    tokenFilePath: tokenFile,
    federationRuleId: "fdrl_01Admin",
    organizationId: "org-1234",
    clock: FixedClock(new Date("2026-10-01T12:00:00Z")),
  });
  return new HttpAnthropicIdentityClient({ fetchFn, tokenProvider });
}

function setup(scenario: string) {
  const exchange = new FakeAnthropicTokenExchange();
  const replay = recordedFixtureFetch(scenario, { tokenExchange: exchange });
  return { client: withFetch(replay.fetchFn), replay, exchange };
}

/** Route token-exchange calls to the fake, everything else to `apiFetch`. */
function inline(apiFetch: typeof fetch): typeof fetch {
  const exchange = new FakeAnthropicTokenExchange();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (url.pathname === TOKEN_EXCHANGE_PATH) {
      return exchange.asFetch()(input, init);
    }
    return apiFetch(input, init);
  }) as typeof fetch;
}

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return asFetch(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

const SECRETS = [
  "projected-jwt-secret",
  "fake-access-token-1",
  "fake-access-token-2",
  "Bearer ",
];

function expectNoSecrets(err: Error) {
  const text = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
  for (const s of SECRETS) expect(text).not.toContain(s);
}

const SA_INPUT = { name: "agent-alpha", description: "Shipwright agent alpha" };

describe("createServiceAccount", () => {
  it("POSTs the service account with a federated bearer token and parses the response", async () => {
    const { client, replay } = setup("createServiceAccount_success");
    const sa = await client.createServiceAccount(SA_INPUT);
    expect(sa).toEqual({
      id: "svac_01Alpha",
      name: "agent-alpha",
      archivedAt: null,
    });
    const req = replay.apiRequests()[0];
    expect(req.url.origin).toBe("https://api.anthropic.com");
    expect(req.headers.get("authorization")).toBe("Bearer fake-access-token-1");
    expect(req.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
  });

  it("surfaces a 409 duplicate name as a typed conflict error (no retry)", async () => {
    const { client, replay } = setup("createServiceAccount_duplicate_409");
    const err = await client.createServiceAccount(SA_INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(AnthropicConflictError);
    expect(err).toBeInstanceOf(AnthropicApiError);
    expect(err.status).toBe(409);
    expect(err.operation).toBe("createServiceAccount");
    expect(replay.apiRequests()).toHaveLength(1);
    expectNoSecrets(err);
  });

  it("re-exchanges the token once after a 401 and retries", async () => {
    const { client, exchange, replay } = setup(
      "createServiceAccount_unauthorized_then_success",
    );
    const sa = await client.createServiceAccount(SA_INPUT);
    expect(sa.id).toBe("svac_01Alpha");
    expect(exchange.calls).toBe(2);
    const [first, second] = replay.apiRequests();
    expect(first.headers.get("authorization")).toBe(
      "Bearer fake-access-token-1",
    );
    expect(second.headers.get("authorization")).toBe(
      "Bearer fake-access-token-2",
    );
  });

  it("throws a typed auth error after a second 401, without leaking tokens", async () => {
    const { client, exchange, replay } = setup(
      "createServiceAccount_unauthorized_401",
    );
    const err = await client.createServiceAccount(SA_INPUT).catch((e) => e);
    expect(err).toBeInstanceOf(AnthropicAuthError);
    expect(err.status).toBe(401);
    expect(exchange.calls).toBe(2);
    expect(replay.apiRequests()).toHaveLength(2);
    expectNoSecrets(err);
  });

  it("rejects a response that fails schema validation without echoing it", async () => {
    const client = withFetch(
      inline(jsonFetch({ id: 42, secret: "do-not-print" })),
    );
    const err = await client
      .createServiceAccount({ name: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AnthropicResponseValidationError);
    expect(err.message).not.toContain("do-not-print");
    expectNoSecrets(err);
  });

  it("rejects a non-JSON 200 body", async () => {
    const client = withFetch(inline(jsonFetch("<html>gateway</html>")));
    await expect(
      client.createServiceAccount({ name: "x" }),
    ).rejects.toBeInstanceOf(AnthropicResponseValidationError);
  });
});

describe("addServiceAccountToWorkspace", () => {
  it("POSTs the workspace membership and parses the member", async () => {
    const { client } = setup("addServiceAccountToWorkspace_success");
    const member = await client.addServiceAccountToWorkspace({
      serviceAccountId: "svac_01Alpha",
      workspaceId: "wrkspc_01Work",
    });
    expect(member).toEqual({
      serviceAccountId: "svac_01Alpha",
      workspaceId: "wrkspc_01Work",
      workspaceRole: "workspace_developer",
    });
  });

  it("maps a 404 to an API error carrying the error type and request id", async () => {
    const { client } = setup("addServiceAccountToWorkspace_not_found_404");
    const err = await client
      .addServiceAccountToWorkspace({
        serviceAccountId: "svac_01Missing",
        workspaceId: "wrkspc_01Work",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AnthropicApiError);
    expect(err).not.toBeInstanceOf(AnthropicConflictError);
    expect(err.status).toBe(404);
    expect(err.errorType).toBe("not_found_error");
    expect(err.requestId).toBe("req_01Fake");
  });
});

describe("federation rules", () => {
  const input = {
    name: "agent-alpha",
    description: "Shipwright agent alpha",
    issuerId: "fdis_01Issuer",
    serviceAccountId: "svac_01Alpha",
    workspaceId: "wrkspc_01Work",
    match: { subjectPrefix: "system:serviceaccount:agents:agent-alpha" },
  };

  it("createFederationRule POSTs the rule and parses it", async () => {
    const { client } = setup("createFederationRule_success");
    const rule = await client.createFederationRule(input);
    expect(rule).toEqual({
      id: "fdrl_01Alpha",
      name: "agent-alpha",
      archivedAt: null,
    });
  });

  it("createFederationRule surfaces a 409 as a conflict error", async () => {
    const { client } = setup("createFederationRule_duplicate_409");
    await expect(client.createFederationRule(input)).rejects.toBeInstanceOf(
      AnthropicConflictError,
    );
  });

  it("archiveFederationRule POSTs to the archive endpoint", async () => {
    const { client } = setup("archiveFederationRule_success");
    const rule = await client.archiveFederationRule("fdrl_01Alpha");
    expect(rule.archivedAt).toBe("2026-10-02T09:30:00Z");
  });
});

describe("archiveServiceAccount", () => {
  it("POSTs to the archive endpoint", async () => {
    const { client } = setup("archiveServiceAccount_success");
    const sa = await client.archiveServiceAccount("svac_01Alpha");
    expect(sa.archivedAt).toBe("2026-10-02T09:31:00Z");
  });

  it("raises an auth error on a persistent 401", async () => {
    const { client } = setup("archiveServiceAccount_unauthorized_401");
    await expect(
      client.archiveServiceAccount("svac_01Alpha"),
    ).rejects.toBeInstanceOf(AnthropicAuthError);
  });
});

describe("findServiceAccountByName", () => {
  it("follows next_page across pages until the name is found", async () => {
    const { client, replay } = setup(
      "findServiceAccountByName_found_on_second_page",
    );
    const sa = await client.findServiceAccountByName("agent-alpha");
    expect(sa?.id).toBe("svac_01Alpha");
    const reqs = replay.apiRequests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0].url.searchParams.get("page")).toBeNull();
    expect(reqs[1].url.searchParams.get("page")).toBe("cursor-page-2");
  });

  it("pages through every result before concluding the name is absent", async () => {
    const { client, replay } = setup(
      "findServiceAccountByName_not_found_exhausted",
    );
    expect(await client.findServiceAccountByName("agent-alpha")).toBeNull();
    expect(replay.apiRequests()).toHaveLength(3);
  });

  it("returns null for an empty list", async () => {
    const { client } = setup("findServiceAccountByName_empty");
    expect(await client.findServiceAccountByName("agent-alpha")).toBeNull();
  });

  it("raises an auth error on a persistent 401", async () => {
    const { client } = setup("findServiceAccountByName_unauthorized_401");
    await expect(client.findServiceAccountByName("a")).rejects.toBeInstanceOf(
      AnthropicAuthError,
    );
  });

  it("skips archived entries and ignores near-miss names", async () => {
    const sa = (id: string, name: string, archived: string | null) => ({
      type: "service_account",
      id,
      name,
      description: null,
      organization_role: "developer",
      archived_at: archived,
      archived_by_actor_id: null,
      created_at: "2026-10-01T12:00:00Z",
      created_by_actor_id: null,
      updated_at: "2026-10-01T12:00:00Z",
      updated_by_actor_id: null,
    });
    const client = withFetch(
      inline(
        jsonFetch({
          data: [
            sa("svac_old", "agent-alpha", "2026-09-01T00:00:00Z"),
            sa("svac_near", "agent-alpha-2", null),
            sa("svac_live", "agent-alpha", null),
          ],
          next_page: null,
        }),
      ),
    );
    expect((await client.findServiceAccountByName("agent-alpha"))?.id).toBe(
      "svac_live",
    );
  });

  it("aborts if the API returns the same cursor twice", async () => {
    const client = withFetch(
      inline(jsonFetch({ data: [], next_page: "same" })),
    );
    await expect(client.findServiceAccountByName("x")).rejects.toThrow(
      /pagination/i,
    );
  });
});

describe("findFederationRuleByName", () => {
  it("pages to the third page to find the rule", async () => {
    const { client, replay } = setup(
      "findFederationRuleByName_found_on_third_page",
    );
    const rule = await client.findFederationRuleByName("agent-alpha");
    expect(rule?.id).toBe("fdrl_01Alpha");
    expect(replay.apiRequests()).toHaveLength(3);
  });

  it("returns null when no page contains the name", async () => {
    const { client } = setup("findFederationRuleByName_not_found");
    expect(await client.findFederationRuleByName("agent-alpha")).toBeNull();
  });
});
