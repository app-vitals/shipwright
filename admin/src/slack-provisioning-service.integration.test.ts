/**
 * admin/src/slack-provisioning-service.integration.test.ts
 * Integration tests for SlackProvisioningService (UAP-1.1) — the extracted
 * Slack app-manifest-creation/OAuth/app-token orchestration.
 *
 * Uses the same RecordedSlackClient + cassette fixture pattern as
 * slack-provisioning.integration.test.ts (real dependency behavior via a
 * recorded fixture double), but exercises the service directly rather than
 * going through the Hono app.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { sign } from "hono/jwt";
import type { AdminUISlackClient } from "./admin-ui.ts";
import type { AgentDetail } from "./admin-ui-pages.ts";
import { SlackProvisioningService } from "./slack-provisioning-service.ts";
import type { AppManifest } from "./slack-provisioning-client.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_SECRET = "test-admin-session-secret-32-bytes!";
const AGENT_ID = "agent-test-123";
const APP_BASE_URL = "https://example.com";
/** The per-agent connect-slack callback the new UAP-1.1 route registers with Slack. */
const CONNECT_SLACK_CALLBACK = `${APP_BASE_URL}/admin/agents/${AGENT_ID}/connect-slack/callback`;
/** The legacy wizard's OAuth completion route. */
const LEGACY_PROVISION_COMPLETE = `${APP_BASE_URL}/admin/provision/complete`;

// ─── Cassette fixture ─────────────────────────────────────────────────────────

interface ProvisionCassette {
  createAppManifest: {
    appId: string;
    oauthRedirectUrl: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
  };
  authTest: {
    userId: string;
  };
}

class RecordedSlackClient implements AdminUISlackClient {
  private cassette: ProvisionCassette;
  /** Manifests passed to createAppManifest(), in call order — lets tests assert on the registered OAuth redirect_urls. */
  readonly createdManifests: AppManifest[] = [];
  /** redirect_uri values passed to exchangeOAuthCode(), in call order. */
  readonly exchangeRedirectUris: string[] = [];
  /** botToken values passed to authTest(), in call order. */
  readonly authTestBotTokens: string[] = [];

  constructor(cassettePath: string) {
    this.cassette = JSON.parse(readFileSync(cassettePath, "utf-8"));
  }

  async createAppManifest(
    _xoxpToken: string,
    manifest: AppManifest,
  ): Promise<{
    appId: string;
    oauthRedirectUrl: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
  }> {
    this.createdManifests.push(manifest);
    return this.cassette.createAppManifest;
  }

  async updateAppManifest(
    _xoxpToken: string,
    _appId: string,
    _manifest: AppManifest,
  ): Promise<void> {}

  async exchangeOAuthCode(
    _code: string,
    _clientId: string,
    _clientSecret: string,
    redirectUri: string,
  ): Promise<{ botToken: string }> {
    this.exchangeRedirectUris.push(redirectUri);
    return { botToken: "xoxb-test-cassette-bot-token" };
  }

  async authTest(botToken: string): Promise<{ userId: string }> {
    this.authTestBotTokens.push(botToken);
    return this.cassette.authTest;
  }
}

const CASSETTE_PATH = new URL(
  "./fixtures/slack-provision-cassette.json",
  import.meta.url,
).pathname;

// ─── Test doubles ─────────────────────────────────────────────────────────────

interface PatchCall {
  agentId: string;
  env: Record<string, string>;
  secretKeys: string[];
}

interface UpdateFieldsCall {
  id: string;
  input: unknown;
}

function makeService(opts?: {
  slackClient?: AdminUISlackClient;
  patchCalls?: PatchCall[];
  reconcileCalls?: string[];
  updateFieldsCalls?: UpdateFieldsCall[];
  getConfigBundle?: () => Promise<{
    env: Record<string, string>;
    agentId: string;
    allowedTools: string[];
  } | null>;
  getDetail?: () => Promise<AgentDetail | null>;
}): SlackProvisioningService {
  const patchCalls = opts?.patchCalls ?? [];
  const reconcileCalls = opts?.reconcileCalls ?? [];
  const updateFieldsCalls = opts?.updateFieldsCalls ?? [];
  return new SlackProvisioningService({
    slackClient: opts?.slackClient ?? new RecordedSlackClient(CASSETTE_PATH),
    agentService: {
      getDetail:
        opts?.getDetail ??
        (async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          authorAllowlist: [],
          restrictSlackToMembers: false,
          typeName: "coding",
          missingRequiredEnv: [],
        })),
      updateFields: async (id: string, input: unknown) => {
        updateFieldsCalls.push({ id, input });
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          authorAllowlist: [],
          restrictSlackToMembers: false,
          typeName: "coding",
          missingRequiredEnv: [],
        };
      },
    },
    agentEnvService: {
      getConfigBundle: opts?.getConfigBundle ?? (async () => null),
      patch: async (
        agentId: string,
        env: Record<string, string>,
        secretKeys?: Set<string>,
      ) => {
        patchCalls.push({
          agentId,
          env,
          secretKeys: secretKeys ? [...secretKeys] : [],
        });
      },
    },
    agentCronJobService: {
      reconcileSystemCrons: async (agentId: string) => {
        reconcileCalls.push(agentId);
        return { created: 3, updated: 0, deleted: 0 };
      },
    },
    sessionSecret: SESSION_SECRET,
    appBaseUrl: APP_BASE_URL,
    secretEnvVars: new Set(["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"]),
  });
}

async function makeProvisionStateToken(
  overrides: Partial<{
    agentId: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
    appId: string;
    redirectUri: string;
    /** When true, omit redirectUri entirely (simulates a cookie signed before the field existed). */
    omitRedirectUri: boolean;
    expired: boolean;
    secret: string;
  }> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      agentId: overrides.agentId ?? AGENT_ID,
      clientId: overrides.clientId ?? "test-client-id",
      clientSecret: overrides.clientSecret ?? "test-client-secret",
      signingSecret: overrides.signingSecret ?? "test-signing-secret",
      appId: overrides.appId ?? "A0123456789",
      ...(overrides.omitRedirectUri
        ? {}
        : { redirectUri: overrides.redirectUri ?? CONNECT_SLACK_CALLBACK }),
      iat: now,
      exp: overrides.expired ? now - 10 : now + 300,
    },
    overrides.secret ?? SESSION_SECRET,
    "HS256",
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SlackProvisioningService.startConnect", () => {
  it("valid xoxe.xoxp- token → calls apps.manifest.create (cassette) and returns a signed provision-state token + oauth URL", async () => {
    const service = makeService();
    const result = await service.startConnect(
      AGENT_ID,
      "xoxe.xoxp-1-fake-token-for-testing",
      CONNECT_SLACK_CALLBACK,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.oauthRedirectUrl).toContain(
      "https://slack.com/oauth/authorize",
    );
    expect(typeof result.provisionStateToken).toBe("string");
    expect(result.provisionStateToken.length).toBeGreaterThan(0);
  });

  it("registers the caller-supplied redirectUri in the app manifest's OAuth redirect_urls (per-agent connect-slack flow), and threads it into the signed state so the OAuth exchange reuses the same URL", async () => {
    const slackClient = new RecordedSlackClient(CASSETTE_PATH);
    const service = makeService({ slackClient });

    const result = await service.startConnect(
      AGENT_ID,
      "xoxe.xoxp-1-fake-token-for-testing",
      CONNECT_SLACK_CALLBACK,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    // The manifest registered with Slack must carry the per-agent callback,
    // NOT the legacy /admin/provision/complete route.
    expect(slackClient.createdManifests.length).toBe(1);
    expect(
      slackClient.createdManifests[0].oauth_config?.redirect_urls,
    ).toEqual([CONNECT_SLACK_CALLBACK]);

    // And the OAuth exchange must use the identical URL, recovered from the
    // signed state cookie — Slack rejects a mismatch. Prove it by completing
    // with the token this call produced.
    const completeResult = await service.completeConnect(
      result.provisionStateToken,
      "valid-oauth-code",
      // Fallback would be the wrong (legacy) URL — the state's own value must win.
      LEGACY_PROVISION_COMPLETE,
    );
    expect(completeResult.outcome).toBe("needs_app_token");
    expect(slackClient.exchangeRedirectUris).toEqual([CONNECT_SLACK_CALLBACK]);
  });

  it("a combined-flow ghConnectError (UAP-2.1) is folded into the signed state and handed back by completeConnect so the post-callback landing can surface it", async () => {
    const service = makeService();
    const result = await service.startConnect(
      AGENT_ID,
      "xoxe.xoxp-1-fake-token-for-testing",
      CONNECT_SLACK_CALLBACK,
      "GitHub Personal Access Token is required.",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    // The GitHub PAT failure rode through the signed state cookie and comes
    // back out on the success outcome — never silently swallowed.
    const completeResult = await service.completeConnect(
      result.provisionStateToken,
      "valid-oauth-code",
      CONNECT_SLACK_CALLBACK,
    );
    expect(completeResult.outcome).toBe("needs_app_token");
    if (completeResult.outcome !== "needs_app_token")
      throw new Error("wrong outcome");
    expect(completeResult.ghConnectError).toBe(
      "GitHub Personal Access Token is required.",
    );
  });

  it("no ghConnectError → completeConnect returns undefined (default flow unaffected)", async () => {
    const service = makeService();
    const result = await service.startConnect(
      AGENT_ID,
      "xoxe.xoxp-1-fake-token-for-testing",
      CONNECT_SLACK_CALLBACK,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");

    const completeResult = await service.completeConnect(
      result.provisionStateToken,
      "valid-oauth-code",
      CONNECT_SLACK_CALLBACK,
    );
    expect(completeResult.outcome).toBe("needs_app_token");
    if (completeResult.outcome !== "needs_app_token")
      throw new Error("wrong outcome");
    expect(completeResult.ghConnectError).toBeUndefined();
  });

  it("missing xoxpToken → ok: false with validation error, no Slack call", async () => {
    const service = makeService();
    const result = await service.startConnect(
      AGENT_ID,
      undefined,
      CONNECT_SLACK_CALLBACK,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error).toContain("xoxe.xoxp-");
  });

  it("xoxpToken missing xoxe.xoxp- prefix → ok: false with validation error", async () => {
    const service = makeService();
    const result = await service.startConnect(
      AGENT_ID,
      "xoxb-not-a-user-token",
      CONNECT_SLACK_CALLBACK,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error).toContain("xoxe.xoxp-");
  });

  it("agent id that doesn't exist → ok: false with 'Agent not found.'", async () => {
    const service = makeService({ getDetail: async () => null });
    const result = await service.startConnect(
      "nonexistent-agent",
      "xoxe.xoxp-1-fake-token-for-testing",
      CONNECT_SLACK_CALLBACK,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error).toBe("Agent not found.");
  });
});

describe("SlackProvisioningService.completeConnect", () => {
  it("valid state token + code → exchanges OAuth code (cassette) and stores SLACK_BOT_TOKEN, returns needs_app_token", async () => {
    const patchCalls: PatchCall[] = [];
    const updateFieldsCalls: UpdateFieldsCall[] = [];
    const service = makeService({ patchCalls, updateFieldsCalls });
    const token = await makeProvisionStateToken();

    const result = await service.completeConnect(
      token,
      "valid-oauth-code",
      CONNECT_SLACK_CALLBACK,
    );

    expect(result.outcome).toBe("needs_app_token");
    if (result.outcome !== "needs_app_token") throw new Error("wrong outcome");
    expect(result.agentId).toBe(AGENT_ID);

    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0].env.SLACK_BOT_TOKEN).toBe(
      "xoxb-test-cassette-bot-token",
    );
    expect(patchCalls[0].secretKeys).toContain("SLACK_BOT_TOKEN");
  });

  it("valid state token + code → resolves the bot's own user id via auth.test (cassette) and persists it via agentService.updateFields", async () => {
    const slackClient = new RecordedSlackClient(CASSETTE_PATH);
    const updateFieldsCalls: UpdateFieldsCall[] = [];
    const service = makeService({ slackClient, updateFieldsCalls });
    const token = await makeProvisionStateToken();

    const result = await service.completeConnect(
      token,
      "valid-oauth-code",
      CONNECT_SLACK_CALLBACK,
    );

    expect(result.outcome).toBe("needs_app_token");

    // auth.test is called with the freshly-exchanged bot token.
    expect(slackClient.authTestBotTokens).toEqual([
      "xoxb-test-cassette-bot-token",
    ]);

    // The resolved user id (from the cassette) is persisted to agent.slackId.
    expect(updateFieldsCalls.length).toBe(1);
    expect(updateFieldsCalls[0].id).toBe(AGENT_ID);
    expect(updateFieldsCalls[0].input).toEqual({ slackId: "U0AALR8M69X" });
  });

  it("reinstall (SLACK_APP_TOKEN already set) → returns reinstalled outcome, still resolves and persists slackId via auth.test", async () => {
    const patchCalls: PatchCall[] = [];
    const updateFieldsCalls: UpdateFieldsCall[] = [];
    const service = makeService({
      patchCalls,
      updateFieldsCalls,
      getConfigBundle: async () => ({
        env: {
          SLACK_BOT_TOKEN: "xoxb-old",
          SLACK_APP_TOKEN: "xapp-existing",
        },
        agentId: AGENT_ID,
        allowedTools: [],
      }),
    });
    const token = await makeProvisionStateToken();

    const result = await service.completeConnect(
      token,
      "valid-oauth-code",
      CONNECT_SLACK_CALLBACK,
    );

    expect(result.outcome).toBe("reinstalled");
    if (result.outcome !== "reinstalled") throw new Error("wrong outcome");
    expect(result.agentId).toBe(AGENT_ID);

    expect(updateFieldsCalls.length).toBe(1);
    expect(updateFieldsCalls[0].id).toBe(AGENT_ID);
    expect(updateFieldsCalls[0].input).toEqual({ slackId: "U0AALR8M69X" });
  });

  it("missing state cookie → invalid_state outcome, no Slack call, no env write", async () => {
    const patchCalls: PatchCall[] = [];
    const service = makeService({ patchCalls });

    const result = await service.completeConnect(
      undefined,
      "some-code",
      CONNECT_SLACK_CALLBACK,
    );

    expect(result.outcome).toBe("invalid_state");
    expect(patchCalls.length).toBe(0);
  });

  it("expired state token → invalid_state outcome", async () => {
    const patchCalls: PatchCall[] = [];
    const service = makeService({ patchCalls });
    const token = await makeProvisionStateToken({ expired: true });

    const result = await service.completeConnect(
      token,
      "some-code",
      CONNECT_SLACK_CALLBACK,
    );

    expect(result.outcome).toBe("invalid_state");
    expect(patchCalls.length).toBe(0);
  });

  it("valid state token but missing code (OAuth denied) → missing_code outcome, no env write", async () => {
    const patchCalls: PatchCall[] = [];
    const service = makeService({ patchCalls });
    const token = await makeProvisionStateToken();

    const result = await service.completeConnect(
      token,
      undefined,
      CONNECT_SLACK_CALLBACK,
    );

    expect(result.outcome).toBe("missing_code");
    expect(patchCalls.length).toBe(0);
  });

  it("legacy wizard flow: state carries /admin/provision/complete → OAuth exchange uses that URL, not the per-agent callback", async () => {
    const slackClient = new RecordedSlackClient(CASSETTE_PATH);
    const service = makeService({ slackClient });
    const token = await makeProvisionStateToken({
      redirectUri: LEGACY_PROVISION_COMPLETE,
    });

    const result = await service.completeConnect(
      token,
      "valid-oauth-code",
      LEGACY_PROVISION_COMPLETE,
    );

    expect(result.outcome).toBe("needs_app_token");
    expect(slackClient.exchangeRedirectUris).toEqual([
      LEGACY_PROVISION_COMPLETE,
    ]);
  });

  it("state cookie predating the redirectUri field → OAuth exchange falls back to the caller-supplied URL", async () => {
    const slackClient = new RecordedSlackClient(CASSETTE_PATH);
    const service = makeService({ slackClient });
    const token = await makeProvisionStateToken({ omitRedirectUri: true });

    const result = await service.completeConnect(
      token,
      "valid-oauth-code",
      LEGACY_PROVISION_COMPLETE,
    );

    expect(result.outcome).toBe("needs_app_token");
    expect(slackClient.exchangeRedirectUris).toEqual([
      LEGACY_PROVISION_COMPLETE,
    ]);
  });

  it("OAuth exchange failure → exchange_failed outcome", async () => {
    const patchCalls: PatchCall[] = [];
    const failingSlackClient: AdminUISlackClient = {
      createAppManifest: async () => {
        throw new Error("unused in this test");
      },
      updateAppManifest: async () => {},
      exchangeOAuthCode: async () => {
        throw new Error("invalid_code");
      },
      authTest: async () => {
        throw new Error("unused in this test");
      },
    };
    const service = makeService({
      slackClient: failingSlackClient,
      patchCalls,
    });
    const token = await makeProvisionStateToken();

    const result = await service.completeConnect(
      token,
      "bad-code",
      CONNECT_SLACK_CALLBACK,
    );

    expect(result.outcome).toBe("exchange_failed");
    if (result.outcome !== "exchange_failed") throw new Error("wrong outcome");
    expect(result.error).toContain("invalid_code");
    expect(patchCalls.length).toBe(0);
  });

  it("auth.test failure after a successful exchange → exchange_failed outcome, SLACK_BOT_TOKEN not persisted", async () => {
    const patchCalls: PatchCall[] = [];
    const updateFieldsCalls: UpdateFieldsCall[] = [];
    const failingAuthTestClient: AdminUISlackClient = {
      createAppManifest: async () => {
        throw new Error("unused in this test");
      },
      updateAppManifest: async () => {},
      exchangeOAuthCode: async () => ({
        botToken: "xoxb-test-cassette-bot-token",
      }),
      authTest: async () => {
        throw new Error("token_revoked");
      },
    };
    const service = makeService({
      slackClient: failingAuthTestClient,
      patchCalls,
      updateFieldsCalls,
    });
    const token = await makeProvisionStateToken();

    const result = await service.completeConnect(
      token,
      "valid-oauth-code",
      CONNECT_SLACK_CALLBACK,
    );

    expect(result.outcome).toBe("exchange_failed");
    if (result.outcome !== "exchange_failed") throw new Error("wrong outcome");
    expect(result.error).toContain("token_revoked");
    expect(patchCalls.length).toBe(0);
    expect(updateFieldsCalls.length).toBe(0);
  });
});

describe("SlackProvisioningService.saveAppToken", () => {
  it("valid xapp- token → stores SLACK_APP_TOKEN and reconciles system crons", async () => {
    const patchCalls: PatchCall[] = [];
    const reconcileCalls: string[] = [];
    const service = makeService({ patchCalls, reconcileCalls });

    const result = await service.saveAppToken(
      AGENT_ID,
      "xapp-1-TEST-fake-socket-token",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.agentId).toBe(AGENT_ID);

    expect(patchCalls.length).toBe(1);
    expect(patchCalls[0].env.SLACK_APP_TOKEN).toBe(
      "xapp-1-TEST-fake-socket-token",
    );
    expect(patchCalls[0].secretKeys).toContain("SLACK_APP_TOKEN");
    expect(reconcileCalls).toContain(AGENT_ID);
  });

  it("missing agentId → ok: false, no env write, no cron reconcile", async () => {
    const patchCalls: PatchCall[] = [];
    const reconcileCalls: string[] = [];
    const service = makeService({ patchCalls, reconcileCalls });

    const result = await service.saveAppToken(
      undefined,
      "xapp-1-TEST-fake-socket-token",
    );

    expect(result.ok).toBe(false);
    expect(patchCalls.length).toBe(0);
    expect(reconcileCalls.length).toBe(0);
  });

  it("xappToken missing xapp- prefix → ok: false, no env write", async () => {
    const patchCalls: PatchCall[] = [];
    const reconcileCalls: string[] = [];
    const service = makeService({ patchCalls, reconcileCalls });

    const result = await service.saveAppToken(AGENT_ID, "not-a-valid-token");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.error).toContain("xapp-");
    expect(patchCalls.length).toBe(0);
  });
});
