/**
 * agent/src/admin-ui.smoke.test.ts
 * Smoke tests for the Admin UI shell (admin-ui.ts).
 *
 * Uses app.request() — no real server, no real DB.
 * Services are injected as in-memory test doubles.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { sign } from "hono/jwt";
import { createAdminUIApp } from "./admin-ui.ts";
import {
  AGENT_ID,
  CRON_ID,
  MOCK_CRON,
  MOCK_TOOL,
  makeGoogleClient,
  makeMockDeps,
  makeOktaClient,
  makeSessionCookie,
  OKTA_ISSUER,
  SESSION_SECRET,
  TOKEN_ID,
  TOOL_ID,
} from "./admin-ui.fixtures.ts";
import { AnthropicCredentialsBlockedError } from "./anthropic-credential-guard.ts";
import type { PushService } from "./push-service.ts";

// ─── Auth redirect tests ──────────────────────────────────────────────────────

describe("admin UI — unauthenticated redirects", () => {
  it("unauthenticated GET /admin/agents redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("unauthenticated GET /admin/agents/:id redirects to /admin/login", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });
});

// ─── Login page ───────────────────────────────────────────────────────────────

describe("admin UI — login page", () => {
  it("GET /admin/login returns 200 with Sign in with Google button (no password form)", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Scope the password-form check to <body> — the shared mobile stylesheet
    // in <head> legitimately contains an `input[type="password"]` CSS
    // selector (for other pages' real password fields), which would
    // otherwise collide with a naive whole-page substring match.
    const body = html.slice(html.indexOf("<body"));
    expect(html).toContain("Sign in with Google");
    expect(body).not.toContain('type="password"');
    expect(body).not.toContain('name="password"');
  });

  it("GET /admin/login shows only Okta when Google creds are empty", async () => {
    const app = createAdminUIApp(
      makeMockDeps({ googleClientId: "", googleClientSecret: "" }),
    );
    const html = await (await app.request("/admin/login")).text();
    expect(html).toContain("Sign in with Okta");
    expect(html).not.toContain("Sign in with Google");
  });

  it("GET /admin/login shows the misconfiguration notice when no provider is set", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        googleClientId: "",
        googleClientSecret: "",
        oktaClientId: "",
        oktaIssuer: "",
      }),
    );
    const html = await (await app.request("/admin/login")).text();
    expect(html).toContain("No sign-in provider is configured");
    expect(html).not.toContain("Sign in with Google");
    expect(html).not.toContain("Sign in with Okta");
  });
});

// ─── OAuth routes ─────────────────────────────────────────────────────────────

describe("admin UI — GET /admin/auth/google", () => {
  it("redirects to Google OAuth URL and sets oauth_state cookie", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/auth/google");
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("accounts.google.com");
    expect(location).toContain("openid");
    expect(location).toContain("profile");
    expect(location).toContain("email");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("oauth_state=");
    expect(cookie).toContain("HttpOnly");
  });

  it("redirects to /admin/login?error=server_error when googleClientId is empty", async () => {
    const app = createAdminUIApp(makeMockDeps({ googleClientId: "" }));
    const res = await app.request("/admin/auth/google");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });
});

describe("admin UI — GET /admin/auth/callback", () => {
  // Helper: set a nonce cookie (encoded as JSON alongside optional returnTo) and matching state query param.
  // Hono's setCookie URL-encodes cookie values; getCookie URL-decodes them on read.
  // The test helper must percent-encode the JSON so getCookie returns the original JSON string.
  function callbackRequest(
    nonce: string,
    queryOverrides?: Record<string, string>,
    returnTo?: string,
  ): Request {
    const params = new URLSearchParams({
      state: nonce,
      code: "auth-code-123",
      ...queryOverrides,
    });
    const oauthState = encodeURIComponent(JSON.stringify({ nonce, returnTo }));
    return new Request(
      `https://example.com/admin/auth/callback?${params.toString()}`,
      {
        headers: { Cookie: `oauth_state=${oauthState}` },
      },
    );
  }

  it("happy path — valid state, code exchanged, email in allowlist → sets session cookie and redirects to /admin/agents", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("happy path with returnTo — redirects to the stored returnTo path after auth", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      callbackRequest(nonce, {}, "/admin/agents/agent-test-123"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents/agent-test-123");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=");
  });

  it("state mismatch → redirects to /admin/login?error=invalid_state", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const oauthState = encodeURIComponent(
      JSON.stringify({ nonce: "stored-nonce" }),
    );
    const res = await app.request(
      new Request(
        "https://example.com/admin/auth/callback?state=wrong-state&code=auth-code",
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=invalid_state");
  });

  it("missing oauth_state cookie → redirects to /admin/login?error=invalid_state", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      new Request(
        "https://example.com/admin/auth/callback?state=some-state&code=code",
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=invalid_state");
  });

  it("missing GOOGLE_CLIENT_ID → redirects to /admin/login?error=server_error", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(makeMockDeps({ googleClientId: "" }));
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });

  it("access_denied param → redirects to /admin/login?error=access_denied", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const res = await app.request(
      new Request(
        `https://example.com/admin/auth/callback?error=access_denied&state=${nonce}`,
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=access_denied");
  });

  it("token exchange failure → redirects to /admin/login?error=auth_failed", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: makeGoogleClient({
          exchangeCode: () =>
            Promise.reject(new Error("token exchange failed")),
        }),
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=auth_failed");
  });

  it("userinfo fetch failure → redirects to /admin/login?error=auth_failed", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: makeGoogleClient({
          getUserInfo: () => Promise.reject(new Error("userinfo failed")),
        }),
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=auth_failed");
  });

  it("email not in allowlist → returns 403", async () => {
    const nonce = "test-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: makeGoogleClient({
          getUserInfo: () =>
            Promise.resolve({
              sub: "google-sub-999",
              email: "notallowed@example.com",
              email_verified: true,
              name: "Not Allowed",
            }),
        }),
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(403);
  });
});

describe("admin UI — Google callback self-serve signup (SSP-3.1)", () => {
  const nonce = "test-nonce-abc";
  const callbackRequest = (n: string) =>
    new Request(
      `https://example.com/admin/auth/callback?state=${n}&code=auth-code-123`,
      {
        headers: {
          Cookie: `oauth_state=${encodeURIComponent(JSON.stringify({ nonce: n }))}`,
        },
      },
    );
  const identity = (over: Record<string, unknown> = {}) =>
    makeGoogleClient({
      getUserInfo: () =>
        Promise.resolve({
          sub: "google-sub-new",
          email: "New.User@Example.com",
          email_verified: true,
          name: "New User",
          ...over,
        }),
    });
  const enabled = { enabled: true, defaultMaxAgents: 2, contactEmail: "x@y.z" };

  it("flag on: unknown verified email is provisioned, gets a session cookie, lands on /admin/agents", async () => {
    const calls: string[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: identity(),
        selfServe: enabled,
        accountOnboarding: {
          provisionForEmail: async (email) => {
            calls.push(email);
            return { kind: "created", accountId: "acc-1" };
          },
        },
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");
    expect(res.headers.get("Set-Cookie")).toContain("admin_session=");
    expect(calls).toEqual(["new.user@example.com"]);
  });

  it("created account notifies once; a throwing notifier does not fail login", async () => {
    const notified: unknown[] = [];
    const run = async (
      kind: "created" | "joined" | "existing",
      throws = false,
    ) => {
      const app = createAdminUIApp(
        makeMockDeps({
          googleClient: identity(),
          selfServe: enabled,
          accountOnboarding: {
            provisionForEmail: async () => ({ kind, accountId: "acc-1" }),
          },
          accountCreatedNotifier: async (info) => {
            notified.push(info);
            if (throws) throw new Error("push down");
          },
        }),
      );
      return app.request(callbackRequest(nonce));
    };
    const res = await run("created", true);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");
    expect(res.headers.get("Set-Cookie")).toContain("admin_session=");
    expect(notified).toEqual([
      { accountId: "acc-1", emailDomain: "example.com" },
    ]);

    notified.length = 0;
    await run("joined");
    await run("existing");
    expect(notified).toEqual([]);
  });

  it("flag off: unknown email still gets 403 and nothing is provisioned", async () => {
    let called = false;
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: identity(),
        selfServe: { ...enabled, enabled: false },
        accountOnboarding: {
          provisionForEmail: async () => {
            called = true;
            return { kind: "created", accountId: "acc-1" };
          },
        },
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });

  it("flag on: unverified email creates nothing", async () => {
    let called = false;
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: identity({ email_verified: false }),
        selfServe: enabled,
        accountOnboarding: {
          provisionForEmail: async () => {
            called = true;
            return { kind: "created", accountId: "acc-1" };
          },
        },
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=auth_failed");
    expect(called).toBe(false);
  });

  it("flag on: platform admin logs in without touching onboarding", async () => {
    let called = false;
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: identity({ email: "admin@example.com" }),
        selfServe: enabled,
        accountOnboarding: {
          provisionForEmail: async () => {
            called = true;
            return { kind: "created", accountId: "acc-1" };
          },
        },
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(called).toBe(false);
  });

  it("flag on: Okta callback never auto-provisions (403 for unknown email)", async () => {
    let called = false;
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const app = createAdminUIApp(
      makeMockDeps({
        selfServe: enabled,
        accountOnboarding: {
          provisionForEmail: async () => {
            called = true;
            return { kind: "created", accountId: "acc-1" };
          },
        },
        oktaClient: makeOktaClient({
          getUserInfo: () =>
            Promise.resolve({
              sub: "okta-sub-new",
              email: "stranger@example.com",
              email_verified: true,
              name: "Stranger",
            }),
        }),
      }),
    );
    const res = await app.request(
      new Request(
        `https://example.com/admin/auth/okta/callback?state=${nonce}&code=c`,
        { headers: { Cookie: `oauth_state=${oauthState}` } },
      ),
    );
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });

  it("flag on: provisioning failure redirects to server_error without a session", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: identity(),
        selfServe: enabled,
        accountOnboarding: {
          provisionForEmail: async () => {
            throw new Error("db down");
          },
        },
      }),
    );
    const res = await app.request(callbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain("admin_session=");
  });
});

describe("admin UI — GET /admin/auth/okta", () => {
  it("redirects to the Okta authorization URL and sets oauth_state cookie", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/auth/okta");
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain(OKTA_ISSUER);
    expect(location).toContain("v1/authorize");
    expect(location).toContain("openid");
    expect(location).toContain("profile");
    expect(location).toContain("email");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("oauth_state=");
    expect(cookie).toContain("HttpOnly");
  });

  it("redirects to /admin/login?error=server_error when oktaClientId is empty", async () => {
    const app = createAdminUIApp(makeMockDeps({ oktaClientId: "" }));
    const res = await app.request("/admin/auth/okta");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });

  it("redirects to /admin/login?error=server_error when oktaIssuer is empty", async () => {
    const app = createAdminUIApp(makeMockDeps({ oktaIssuer: "" }));
    const res = await app.request("/admin/auth/okta");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });
});

describe("admin UI — GET /admin/auth/okta/callback", () => {
  // Mirrors callbackRequest() from the Google callback describe block above.
  function oktaCallbackRequest(
    nonce: string,
    queryOverrides?: Record<string, string>,
    returnTo?: string,
  ): Request {
    const params = new URLSearchParams({
      state: nonce,
      code: "auth-code-123",
      ...queryOverrides,
    });
    const oauthState = encodeURIComponent(JSON.stringify({ nonce, returnTo }));
    return new Request(
      `https://example.com/admin/auth/okta/callback?${params.toString()}`,
      {
        headers: { Cookie: `oauth_state=${oauthState}` },
      },
    );
  }

  it("happy path — valid state, code exchanged, email in allowlist → sets session cookie and redirects to /admin/agents", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=");
    expect(cookie).toContain("HttpOnly");
  });

  it("happy path with returnTo — redirects to the stored returnTo path after auth", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      oktaCallbackRequest(nonce, {}, "/admin/agents/agent-test-123"),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents/agent-test-123");
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=");
  });

  it("resolves isAdmin via the same allowlist check as Google — allowlisted email → isAdmin true session", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("admin_session=");
  });

  it("state mismatch → redirects to /admin/login?error=invalid_state", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const oauthState = encodeURIComponent(
      JSON.stringify({ nonce: "stored-nonce" }),
    );
    const res = await app.request(
      new Request(
        "https://example.com/admin/auth/okta/callback?state=wrong-state&code=auth-code",
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=invalid_state");
  });

  it("missing oauth_state cookie → redirects to /admin/login?error=invalid_state", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      new Request(
        "https://example.com/admin/auth/okta/callback?state=some-state&code=code",
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=invalid_state");
  });

  it("missing OKTA_CLIENT_ID → redirects to /admin/login?error=server_error", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps({ oktaClientId: "" }));
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });

  it("missing OKTA_ISSUER → redirects to /admin/login?error=server_error", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps({ oktaIssuer: "" }));
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=server_error");
  });

  it("access_denied param → redirects to /admin/login?error=access_denied", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(makeMockDeps());
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const res = await app.request(
      new Request(
        `https://example.com/admin/auth/okta/callback?error=access_denied&state=${nonce}`,
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=access_denied");
  });

  it("token exchange failure → redirects to /admin/login?error=auth_failed", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        oktaClient: makeOktaClient({
          exchangeCode: () =>
            Promise.reject(new Error("token exchange failed")),
        }),
      }),
    );
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=auth_failed");
  });

  it("userinfo fetch failure → redirects to /admin/login?error=auth_failed", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        oktaClient: makeOktaClient({
          getUserInfo: () => Promise.reject(new Error("userinfo failed")),
        }),
      }),
    );
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=auth_failed");
  });

  it("email not in allowlist → returns 403", async () => {
    const nonce = "test-okta-nonce-abc";
    const app = createAdminUIApp(
      makeMockDeps({
        oktaClient: makeOktaClient({
          getUserInfo: () =>
            Promise.resolve({
              sub: "okta-sub-999",
              email: "notallowed@example.com",
              email_verified: true,
              name: "Not Allowed",
            }),
        }),
      }),
    );
    const res = await app.request(oktaCallbackRequest(nonce));
    expect(res.status).toBe(403);
  });
});

// ─── Authenticated pages ──────────────────────────────────────────────────────

describe("admin UI — authenticated pages", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("authenticated GET /admin/agents returns 200 with agents list", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test Agent");
  });

  it("authenticated GET /admin/agents includes a Queue & Activity link with the correct href for a rendered agent row", async () => {
    const app = createAdminUIApp(makeMockDeps({ queueActivityLinks: true }));
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      `<a href="/admin/agents/${AGENT_ID}/queue-activity" class="btn btn-secondary"`,
    );
    expect(html).toContain("Queue &amp; Activity</a>");
  });

  it("authenticated GET /admin/agents shows the session user's email in the navbar", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("admin@example.com");
  });

  it("authenticated GET /admin/agents/:id returns 200 with agent detail sections", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Env Vars");
    expect(html).toContain("Cron Jobs");
    expect(html).toContain("Tools");
    expect(html).toContain("Tokens");
    expect(html).toContain("Plugins");
    expect(html).toContain("admin@example.com");
  });

  describe("connect-later actions (UAP-2.3)", () => {
    it("no env vars set: shows Connect Slack, Set up GitHub App, and Add GitHub PAT actions, each wired to the correct connect-* route and agent id", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({ env: {}, secretKeys: [] }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain("Connect Slack");
      expect(html).toContain("Set up GitHub App");
      expect(html).toContain('name="ghAppPublic"');
      expect(html).toContain("Installable on multiple orgs");
      expect(html).toContain("Add GitHub PAT");

      expect(html).toContain(
        `<form method="POST" action="/admin/agents/${AGENT_ID}/connect-slack"`,
      );
      expect(html).toContain(
        `<form method="POST" action="/admin/agents/${AGENT_ID}/connect-github"`,
      );
      // Two distinct connect-github forms (App auto-provision + PAT) both scoped to this agent id.
      expect(
        html.split(`/admin/agents/${AGENT_ID}/connect-github`).length - 1,
      ).toBeGreaterThanOrEqual(2);
    });

    it("SLACK_APP_TOKEN present: hides Connect Slack but still shows the GitHub actions", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: { SLACK_APP_TOKEN: "xapp-1-abc" },
              secretKeys: ["SLACK_APP_TOKEN"],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).not.toContain("Connect Slack");
      expect(html).toContain("Set up GitHub App");
      expect(html).toContain("Add GitHub PAT");
    });

    it("GH_APP_ID present: hides Set up GitHub App but still shows Connect Slack and Add GitHub PAT", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: { GH_APP_ID: "12345" },
              secretKeys: [],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain("Connect Slack");
      expect(html).not.toContain("Set up GitHub App");
      expect(html).toContain("Add GitHub PAT");
    });

    it("GH_TOKEN present: hides Add GitHub PAT but still shows Connect Slack and Set up GitHub App", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: { GH_TOKEN: "ghp_abc" },
              secretKeys: ["GH_TOKEN"],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain("Connect Slack");
      expect(html).toContain("Set up GitHub App");
      expect(html).not.toContain("Add GitHub PAT");
    });

    it("GH_APP_ID and GH_TOKEN both present (independent signals): hides both GitHub actions but still shows Connect Slack", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: { GH_APP_ID: "12345", GH_TOKEN: "ghp_abc" },
              secretKeys: ["GH_TOKEN"],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain("Connect Slack");
      expect(html).not.toContain("Set up GitHub App");
      expect(html).not.toContain("Add GitHub PAT");
    });

    it("all three env vars set: none of the connect-later actions render", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({
              env: {
                SLACK_APP_TOKEN: "xapp-1-abc",
                GH_APP_ID: "12345",
                GH_TOKEN: "ghp_abc",
              },
              secretKeys: ["SLACK_APP_TOKEN", "GH_TOKEN"],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).not.toContain("Connect Slack");
      expect(html).not.toContain("Set up GitHub App");
      expect(html).not.toContain("Add GitHub PAT");
    });

    it("Add GitHub PAT form posts ghAuthMode=pat to the connect-github route", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({ env: {}, secretKeys: [] }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      const html = await res.text();

      // Isolate the Add GitHub PAT popover block and assert its hidden field + input.
      const patBlockStart = html.indexOf("Add GitHub PAT");
      expect(patBlockStart).toBeGreaterThan(-1);
      const patBlock = html.slice(patBlockStart, patBlockStart + 1500);
      expect(patBlock).toContain(
        `action="/admin/agents/${AGENT_ID}/connect-github"`,
      );
      expect(patBlock).toContain('name="ghAuthMode" value="pat"');
      expect(patBlock).toContain('name="ghPat"');
    });

    it("Set up GitHub App form posts ghAuthMode=app + ghAppMode=auto with a githubOrg field to the connect-github route", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({ env: {}, secretKeys: [] }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      const html = await res.text();

      const appBlockStart = html.indexOf("Set up GitHub App");
      expect(appBlockStart).toBeGreaterThan(-1);
      const appBlock = html.slice(appBlockStart, appBlockStart + 1500);
      expect(appBlock).toContain(
        `action="/admin/agents/${AGENT_ID}/connect-github"`,
      );
      expect(appBlock).toContain('name="ghAuthMode" value="app"');
      expect(appBlock).toContain('name="ghAppMode" value="auto"');
      expect(appBlock).toContain('name="githubOrg"');
    });

    it("Connect Slack form posts xoxpToken to the connect-slack route", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({ env: {}, secretKeys: [] }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      const html = await res.text();

      const slackBlockStart = html.indexOf("Connect Slack");
      expect(slackBlockStart).toBeGreaterThan(-1);
      const slackBlock = html.slice(slackBlockStart, slackBlockStart + 1500);
      expect(slackBlock).toContain(
        `action="/admin/agents/${AGENT_ID}/connect-slack"`,
      );
      expect(slackBlock).toContain('name="xoxpToken"');
    });

    it("non-admin member viewer does not see the connect-later actions (Slack access card is admin-only)", async () => {
      const MEMBER_EMAIL = "member@example.com";
      const memberCookie = await makeSessionCookie(
        SESSION_SECRET,
        "google-sub-member",
        MEMBER_EMAIL,
        false,
      );
      const app = createAdminUIApp(
        makeMockDeps({
          agentEnvService: {
            getByAgentId: async () => ({ env: {}, secretKeys: [] }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
          agentMemberService: {
            listByEmail: async (email: string) =>
              email === MEMBER_EMAIL
                ? [
                    {
                      id: "m1",
                      agentId: AGENT_ID,
                      email,
                      createdAt: new Date(),
                    },
                  ]
                : [],
            exists: async (_agentId: string, email: string) =>
              email === MEMBER_EMAIL,
            add: async () => ({
              id: "m1",
              agentId: AGENT_ID,
              email: MEMBER_EMAIL,
              createdAt: new Date(),
            }),
            remove: async () => {},
            listByAgentId: async () => [],
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${memberCookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("Connect Slack");
      expect(html).not.toContain("Set up GitHub App");
      expect(html).not.toContain("Add GitHub PAT");
    });
  });

  it("authenticated GET /admin/agents/new returns 200 with a required type select listing the agent types", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents/new", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Regression coverage for a bug where a consumer wiring up AdminUIDeps
    // without the required `provisioner` field (it has no default, unlike
    // agentTypeRegistry) caused this route to throw on `provisioner.canProvision`
    // — a 500 that left the type picker (and its "required" select[name=type])
    // missing entirely rather than merely disabled.
    expect(html).toContain(
      '<select id="type" name="type" class="form-input" required>',
    );
    expect(html).toContain('<option value="coding">Coding Agent</option>');
  });

  it("nests shipwright-loop phase crons under the loop row instead of listing them flat", async () => {
    const LOOP_ID = "cron-loop-1";
    const PHASES = [
      "shipwright-dev-task",
      "shipwright-review",
      "shipwright-patch",
      "shipwright-deploy",
    ];
    const phaseCrons = PHASES.map((name, i) => ({
      ...MOCK_CRON,
      id: `cron-phase-${i}`,
      name,
      system: true,
      parentCronId: LOOP_ID,
      lastRun: null,
      runCountToday: 0,
    }));
    const loopCron = {
      ...MOCK_CRON,
      id: LOOP_ID,
      name: "shipwright-loop",
      system: true,
      parentCronId: null,
      lockdownDisabledAt: null,
      lastRun: null,
      runCountToday: 0,
    };

    const app = createAdminUIApp(
      makeMockDeps({
        agentCronJobService: {
          list: async () => [loopCron, ...phaseCrons],
          listWithRunSummary: async () => [loopCron, ...phaseCrons],
          get: async () => MOCK_CRON,
          create: async () => MOCK_CRON,
          setEnabled: async () => MOCK_CRON,
          update: async () => MOCK_CRON,
          delete: async () => {},
          reconcileSystemCrons: async () => ({
            created: 0,
            updated: 0,
            deleted: 0,
          }),
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    // Nested section is clearly labeled as belonging to shipwright-loop.
    const labelIndex = html.indexOf("Phases of shipwright-loop");
    expect(labelIndex).toBeGreaterThan(-1);

    // Each phase's toggle form is present and wired to the existing toggle route.
    for (const phase of phaseCrons) {
      const toggleAction = `action="/admin/agents/${AGENT_ID}/crons/${phase.id}/toggle"`;
      expect(html).toContain(toggleAction);
      // The toggle form must appear after the "Phases of shipwright-loop" label,
      // i.e. nested beneath the loop row rather than as a flat top-level row.
      const toggleIndex = html.indexOf(toggleAction);
      expect(toggleIndex).toBeGreaterThan(labelIndex);
    }

    // The loop's own toggle form is still rendered as the top-level row.
    expect(html).toContain(
      `action="/admin/agents/${AGENT_ID}/crons/${LOOP_ID}/toggle"`,
    );
  });

  it("GET /admin/provision redirects to /admin/agents/new", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/provision", {
      headers: { Cookie: `admin_session=${cookie}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/agents/new");
  });

  it("POST /admin/provision/start returns 404 (endpoint removed)", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/provision/start", {
      method: "POST",
      body: new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid" }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(404);
  });

  it("authenticated GET /admin/agents/:id?error=missing_fields renders an error banner", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}?error=missing_fields`,
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alert-error");
    expect(html).toContain("Required fields are missing");
  });

  it("authenticated GET /admin/agents/:id includes an add-cron form with enabled checkbox", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/admin/agents/');
    expect(html).toContain('name="schedule"');
    expect(html).toContain('name="enabled"');
    expect(html).toContain("Enabled");
  });

  it("authenticated GET /admin/agents/:id?newToken= renders new token notice", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}?newToken=raw-token-abc123`,
      {
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("raw-token-abc123");
  });

  it("POST /admin/agents/:id/envs with secret=true shows lock icon in rendered page", async () => {
    let _capturedArgs: unknown[] = [];
    const deps = makeMockDeps({
      agentEnvService: {
        getByAgentId: async () => ({
          env: { MY_SECRET: "***" },
          secretKeys: ["MY_SECRET"],
        }),
        upsert: async (...args: unknown[]) => {
          _capturedArgs = args;
        },
        patch: async (...args: unknown[]) => {
          _capturedArgs = args;
        },
        deleteKey: async () => {},
        getConfigBundle: async () => null,
      },
    });
    const app = createAdminUIApp(deps);
    // POST the env var form with secret checked
    const form = new FormData();
    form.append("key", "MY_SECRET");
    form.append("value", "topsecret");
    form.append("secret", "true");
    const postRes = await app.request(`/admin/agents/${AGENT_ID}/envs`, {
      method: "POST",
      body: form,
      headers: { Cookie: `admin_session=${cookie}` },
    });
    // Should redirect to agent detail
    expect(postRes.status).toBe(302);

    // Fetch the agent detail page — the mock getByAgentId returns the secret key
    const getRes = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(getRes.status).toBe(200);
    const html = await getRes.text();
    // Lock icon should appear for secret keys
    expect(html).toContain("🔒");
  });

  describe("self-hosted agent (selfHosted=true) detail page", () => {
    const SELFHOSTED_AGENT_ID = "agent-selfhosted-123";

    it("managed agent (selfHosted=false) shows Slack info in header", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: AGENT_ID,
              name: "Managed Agent",
              slackId: "U0AALR8M69X",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Slack ID:");
      expect(html).toContain("U0AALR8M69X");
    });

    it("managed agent (selfHosted=false) shows Env Vars card", async () => {
      const app = createAdminUIApp(makeMockDeps());
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Env Vars");
    });

    it("managed agent (selfHosted=false) shows System crons", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentCronJobService: {
            list: async () => [
              { ...MOCK_CRON, system: true, name: "system-cron" },
            ],
            listWithRunSummary: async () => [
              {
                ...MOCK_CRON,
                system: true,
                name: "system-cron",
                lastRun: null,
                runCountToday: 0,
              },
            ],
            get: async () => MOCK_CRON,
            create: async () => MOCK_CRON,
            setEnabled: async () => MOCK_CRON,
            update: async () => MOCK_CRON,
            delete: async () => {},
            reconcileSystemCrons: async () => ({
              created: 0,
              updated: 0,
              deleted: 0,
            }),
          },
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // System subsection should be present
      expect(html).toContain("System");
    });

    it("managed agent (selfHosted=false) shows Tools card", async () => {
      const app = createAdminUIApp(makeMockDeps());
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Bash(git:*)");
    });

    it("self-hosted agent (selfHosted=true) does NOT show Slack info in header", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: SELFHOSTED_AGENT_ID,
              name: "Self-Hosted Agent",
              slackId: null,
              selfHosted: true,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
          },
        }),
      );
      const res = await app.request(`/admin/agents/${SELFHOSTED_AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("Slack ID:");
    });

    it("self-hosted agent (selfHosted=true) does NOT show Env Vars card", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: SELFHOSTED_AGENT_ID,
              name: "Self-Hosted Agent",
              slackId: null,
              selfHosted: true,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
          },
          agentEnvService: {
            getByAgentId: async () => ({
              env: { TEST_VAR: "should-not-show" },
              secretKeys: [],
            }),
            upsert: async () => {},
            patch: async () => {},
            deleteKey: async () => {},
            getConfigBundle: async () => null,
          },
        }),
      );
      const res = await app.request(`/admin/agents/${SELFHOSTED_AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // The card title "Env Vars" should not appear
      expect(html).not.toContain('<div class="card-title">Env Vars</div>');
    });

    it("self-hosted agent (selfHosted=true) shows System crons with self-hosted notice", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: SELFHOSTED_AGENT_ID,
              name: "Self-Hosted Agent",
              slackId: null,
              selfHosted: true,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
          },
          agentCronJobService: {
            list: async () => [
              { ...MOCK_CRON, system: true, name: "system-cron" },
            ],
            listWithRunSummary: async () => [
              {
                ...MOCK_CRON,
                system: true,
                name: "system-cron",
                lastRun: null,
                runCountToday: 0,
              },
            ],
            get: async () => MOCK_CRON,
            create: async () => MOCK_CRON,
            setEnabled: async () => MOCK_CRON,
            update: async () => MOCK_CRON,
            delete: async () => {},
            reconcileSystemCrons: async () => ({
              created: 0,
              updated: 0,
              deleted: 0,
            }),
          },
        }),
      );
      const res = await app.request(`/admin/agents/${SELFHOSTED_AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // System crons section should be present for self-hosted agents
      expect(html).toContain(">System<");
      // Self-hosted notice should appear in the Crons card
      expect(html).toContain(
        "Crons fire only while the local agent service is running",
      );
    });

    it("self-hosted agent (selfHosted=true) shows Tools card", async () => {
      const app = createAdminUIApp(
        makeMockDeps({
          agentService: {
            ...makeMockDeps().agentService,
            getDetail: async () => ({
              id: SELFHOSTED_AGENT_ID,
              name: "Self-Hosted Agent",
              slackId: null,
              selfHosted: true,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            }),
          },
          agentToolService: {
            list: async () => [
              {
                ...MOCK_TOOL,
                pattern: "Bash(git:*)",
                agentId: SELFHOSTED_AGENT_ID,
              },
            ],
            add: async () => MOCK_TOOL,
            toggle: async () => MOCK_TOOL,
            remove: async () => {},
          },
        }),
      );
      const res = await app.request(`/admin/agents/${SELFHOSTED_AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      // Tools card should appear for self-hosted agents
      expect(html).toContain('<div class="card-title">Tools</div>');
      // Tools should be rendered
      expect(html).toContain("Bash(git:*)");
    });
  });
});

// ─── Cron job mutation routes ─────────────────────────────────────────────────

describe("admin UI — cron job mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/crons with valid data redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({
      schedule: "0 * * * *",
      prompt: "Test prompt",
      channel: "C123",
      enabled: "true",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/crons with missing schedule redirects with error", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ prompt: "Test prompt" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=");
  });

  it("POST /admin/agents/:id/crons passes enabled=false to the service when checkbox is unchecked", async () => {
    let capturedEnabled: boolean | undefined;
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      create: async (_agentId, input) => {
        capturedEnabled = input.enabled;
        return MOCK_CRON;
      },
    };
    const app = createAdminUIApp(deps);
    // When the checkbox is unchecked, browsers omit the field entirely
    const body = new URLSearchParams({
      schedule: "0 * * * *",
      prompt: "Test prompt",
      channel: "C123",
      // enabled field intentionally absent — simulates unchecked checkbox
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    // When enabled is absent (unchecked), the handler should pass enabled=false
    expect(capturedEnabled).toBe(false);
  });

  it("POST /admin/agents/:id/crons passes enabled=true when checkbox is checked", async () => {
    let capturedEnabled: boolean | undefined;
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      create: async (_agentId, input) => {
        capturedEnabled = input.enabled;
        return MOCK_CRON;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      schedule: "0 * * * *",
      prompt: "Test prompt",
      channel: "C123",
      enabled: "on",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/crons`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(capturedEnabled).toBe(true);
  });

  it("POST /admin/agents/:id/crons/:cronId/update redirects to agent detail and forwards user/silent", async () => {
    let capturedInput:
      | { user?: string | null; silent?: boolean; preCheck?: string | null }
      | undefined;
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      // existing cron is DM-routed (user set, channel null) — the route must
      // forward user/silent or the service's validateDeliveryTarget would throw.
      get: async () => ({
        ...MOCK_CRON,
        user: "U999",
        channel: null,
        silent: false,
        system: false,
      }),
      update: async (_a, _c, input) => {
        capturedInput = input;
        return MOCK_CRON;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      schedule: "*/30 * * * *",
      prompt: "edited prompt",
      preCheck: "shipwright:check-dev-task.ts",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/update`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    expect(capturedInput?.user).toBe("U999");
    expect(capturedInput?.silent).toBe(false);
    expect(capturedInput?.preCheck).toBe("shipwright:check-dev-task.ts");
  });

  it("POST /admin/agents/:id/crons/:cronId/update redirects with error when schedule missing", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ prompt: "no schedule" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/update`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=");
  });

  it("POST /admin/agents/:id/crons/:cronId/update redirects with error for system crons (update NOT called)", async () => {
    let updateCalled = false;
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      get: async () => ({ ...MOCK_CRON, system: true }),
      update: async () => {
        updateCalled = true;
        return MOCK_CRON;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ schedule: "0 * * * *", prompt: "x" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/update`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=");
    expect(updateCalled).toBe(false);
  });

  it("POST /admin/agents/:id/crons/:cronId/update redirects with error when the service throws", async () => {
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      get: async () => ({ ...MOCK_CRON, system: false }),
      update: async () => {
        throw new Error("invalid cron expression");
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      schedule: "not a cron",
      prompt: "x",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/update`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=");
  });

  it("POST /admin/agents/:id/crons/:cronId/delete redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/delete`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/crons/:cronId/delete redirects with error for system crons", async () => {
    const deps = makeMockDeps();
    deps.agentCronJobService = {
      ...deps.agentCronJobService,
      get: async () => ({ ...MOCK_CRON, system: true }),
    };
    const app = createAdminUIApp(deps);
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/delete`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("error=");
    expect(decodeURIComponent(location)).toContain(
      "system crons cannot be deleted",
    );
  });

  it("POST /admin/agents/:id/crons/:cronId/toggle redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ enabled: "false" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/crons/${CRON_ID}/toggle`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

// ─── Tool mutation routes ─────────────────────────────────────────────────────

describe("admin UI — tool mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/tools with valid pattern redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ pattern: "Read" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/tools`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/tools with missing pattern redirects with error", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ pattern: "" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/tools`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?error=missing_fields`,
    );
  });

  it("POST /admin/agents/:id/tools/:toolId/delete redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/tools/${TOOL_ID}/delete`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/tools/:toolId/toggle redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ enabled: "false" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/tools/${TOOL_ID}/toggle`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

// ─── Agent Policy panel (APM-1.3) ─────────────────────────────────────────────

describe("admin UI — owner and Anthropic identity section (PAI-2.5)", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  function identityDeps(overrides: {
    ownerEmail?: string | null;
    anthropicIdentityName?: string | null;
    anthropicServiceAccountId?: string | null;
    anthropicFederationRuleId?: string | null;
  }) {
    const base = makeMockDeps();
    return makeMockDeps({
      agentService: {
        ...base.agentService,
        getDetail: async () => ({
          id: AGENT_ID,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
          ownerEmail: null,
          anthropicIdentityName: null,
          anthropicServiceAccountId: null,
          anthropicFederationRuleId: null,
          ...overrides,
        }),
      },
    });
  }

  it("GET /admin/agents/:id renders the owner and Anthropic identity values", async () => {
    const app = createAdminUIApp(
      identityDeps({
        ownerEmail: "jane.doe@example.com",
        anthropicIdentityName: "shipwright-test-agent",
        anthropicServiceAccountId: "svac_01ABC",
        anthropicFederationRuleId: "fdrl_01XYZ",
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<div class="card-title">Owner &amp; Anthropic identity</div>',
    );
    expect(html).toContain("Owner email");
    expect(html).toContain("jane.doe@example.com");
    expect(html).toContain("Anthropic identity name");
    expect(html).toContain("shipwright-test-agent");
    expect(html).toContain("Service account ID");
    expect(html).toContain("svac_01ABC");
    expect(html).toContain("Federation rule ID");
    expect(html).toContain("fdrl_01XYZ");
  });

  it("GET /admin/agents/:id HTML-escapes identity values", async () => {
    const app = createAdminUIApp(
      identityDeps({
        ownerEmail: "<b>owner</b>@example.com",
        anthropicIdentityName: "<img src=x onerror=alert(1)>",
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<b>owner</b>@example.com");
    expect(html).toContain("&lt;b&gt;owner&lt;/b&gt;@example.com");
  });

  it("GET /admin/agents/:id renders an em dash placeholder for each unset identity field", async () => {
    const app = createAdminUIApp(identityDeps({}));
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const start = html.indexOf(
      '<div class="card-title">Owner &amp; Anthropic identity</div>',
    );
    expect(start).toBeGreaterThan(-1);
    const sectionHtml = html.slice(start, html.indexOf("</table>", start));
    expect(sectionHtml.match(/—/g)?.length).toBe(4);
  });
});

describe("admin UI — agent policy fields", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("GET /admin/agents/:id renders the Agent Policy card with default field values", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="card-title">Agent Policy</div>');

    // Booleans default true/false/true — checkboxes reflect DB column defaults.
    const autoPostReviewsInput = html.match(
      /<input[^>]*id="autoPostReviews"[^>]*type="checkbox"[^>]*>/,
    )?.[0] as string;
    expect(autoPostReviewsInput).toContain("checked");

    const allowSelfReviewInput = html.match(
      /<input[^>]*id="allowSelfReview"[^>]*type="checkbox"[^>]*>/,
    )?.[0] as string;
    expect(allowSelfReviewInput).not.toContain("checked");

    const cleanupMergedWorktreesInput = html.match(
      /<input[^>]*id="cleanupMergedWorktrees"[^>]*type="checkbox"[^>]*>/,
    )?.[0] as string;
    expect(cleanupMergedWorktreesInput).toContain("checked");

    // Numbers default 75/5/14.
    expect(html).toContain(
      '<input id="minConfidence" name="minConfidence" type="number" value="75"',
    );
    expect(html).toContain(
      '<input id="maxFindings" name="maxFindings" type="number" value="5"',
    );
    expect(html).toContain(
      '<input id="cleanupAfterDays" name="cleanupAfterDays" type="number" value="14"',
    );
  });

  it("GET /admin/agents/:id renders non-default Agent Policy values from the DB", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          ...makeMockDeps().agentService,
          getDetail: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
            reviewAuthorAllowlist: [],
            patchAuthorAllowlist: [],
            restrictSlackToMembers: false,
            missingRequiredEnv: [],
            autoPostReviews: false,
            allowSelfReview: true,
            minConfidence: 90,
            maxFindings: 3,
            cleanupMergedWorktrees: false,
            cleanupAfterDays: 30,
          }),
        },
      }),
    );
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    const autoPostReviewsInput = html.match(
      /<input[^>]*id="autoPostReviews"[^>]*type="checkbox"[^>]*>/,
    )?.[0] as string;
    expect(autoPostReviewsInput).not.toContain("checked");

    const allowSelfReviewInput = html.match(
      /<input[^>]*id="allowSelfReview"[^>]*type="checkbox"[^>]*>/,
    )?.[0] as string;
    expect(allowSelfReviewInput).toContain("checked");

    const cleanupMergedWorktreesInput = html.match(
      /<input[^>]*id="cleanupMergedWorktrees"[^>]*type="checkbox"[^>]*>/,
    )?.[0] as string;
    expect(cleanupMergedWorktreesInput).not.toContain("checked");

    expect(html).toContain(
      '<input id="minConfidence" name="minConfidence" type="number" value="90"',
    );
    expect(html).toContain(
      '<input id="maxFindings" name="maxFindings" type="number" value="3"',
    );
    expect(html).toContain(
      '<input id="cleanupAfterDays" name="cleanupAfterDays" type="number" value="30"',
    );
  });

  it("GET /admin/agents/:id renders a hidden 'false' fallback after each Agent Policy checkbox (so an unchecked box still submits a value)", async () => {
    // Regression guard: unchecked HTML checkboxes are omitted from FormData
    // entirely, so without this fallback, unchecking a box in a real browser
    // would leave the field unchanged rather than clearing it — see the POST
    // test below that exercises the actual two-entries-same-key submission
    // order a browser produces.
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const html = await res.text();
    for (const name of [
      "autoPostReviews",
      "allowSelfReview",
      "cleanupMergedWorktrees",
    ]) {
      expect(html).toContain(
        `<input type="hidden" name="${name}" value="false" />`,
      );
    }
  });

  it("POST /admin/agents/:id/settings with a real browser's checked-checkbox submission order (checkbox 'true' before hidden 'false') resolves to true", async () => {
    let received: Record<string, unknown> | undefined;
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          ...makeMockDeps().agentService,
          updateFields: async (_id: string, input: Record<string, unknown>) => {
            received = input;
            return {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U123456",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            };
          },
        },
      }),
    );
    // Mirrors exactly what a browser submits for a CHECKED box rendered as
    // `<input type="checkbox" ...checked /><input type="hidden" value="false" />`:
    // both entries under the same key, checkbox first.
    const body = new URLSearchParams([
      ["autoPostReviews", "true"],
      ["autoPostReviews", "false"],
    ]);
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(received).toEqual({ autoPostReviews: true });
  });

  it("POST /admin/agents/:id/settings with a real browser's unchecked-checkbox submission (only the hidden 'false' entry present) resolves to false", async () => {
    let received: Record<string, unknown> | undefined;
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          ...makeMockDeps().agentService,
          updateFields: async (_id: string, input: Record<string, unknown>) => {
            received = input;
            return {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U123456",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            };
          },
        },
      }),
    );
    // Mirrors what a browser submits for an UNCHECKED box: only the hidden
    // fallback entry, since the checkbox itself is omitted from FormData.
    const body = new URLSearchParams([["autoPostReviews", "false"]]);
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(received).toEqual({ autoPostReviews: false });
  });

  it("POST /admin/agents/:id/settings with new values for all 6 policy fields updates them", async () => {
    let received: Record<string, unknown> | undefined;
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          ...makeMockDeps().agentService,
          updateFields: async (_id: string, input: Record<string, unknown>) => {
            received = input;
            return {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U123456",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            };
          },
        },
      }),
    );
    const body = new URLSearchParams({
      autoPostReviews: "false",
      allowSelfReview: "true",
      cleanupMergedWorktrees: "false",
      minConfidence: "90",
      maxFindings: "3",
      cleanupAfterDays: "30",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(received).toEqual({
      autoPostReviews: false,
      allowSelfReview: true,
      cleanupMergedWorktrees: false,
      minConfidence: 90,
      maxFindings: 3,
      cleanupAfterDays: 30,
    });
  });

  it("POST /admin/agents/:id/settings from the Agent Policy form (no restrictSlackToMembers field) does not clobber restrictSlackToMembers", async () => {
    let received: Record<string, unknown> | undefined;
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          ...makeMockDeps().agentService,
          updateFields: async (_id: string, input: Record<string, unknown>) => {
            received = input;
            return {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U123456",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: true,
              missingRequiredEnv: [],
            };
          },
        },
      }),
    );
    // Mirrors the Agent Policy card's <form> — it has no
    // restrictSlackToMembers input at all (that field lives in the separate
    // Slack access card/form).
    const body = new URLSearchParams({
      autoPostReviews: "true",
      minConfidence: "80",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(received).not.toHaveProperty("restrictSlackToMembers");
    expect(received).toEqual({ autoPostReviews: true, minConfidence: 80 });
  });

  it("POST /admin/agents/:id/settings with a non-numeric minConfidence leaves it unchanged rather than passing NaN", async () => {
    let received: Record<string, unknown> | undefined;
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          ...makeMockDeps().agentService,
          updateFields: async (_id: string, input: Record<string, unknown>) => {
            received = input;
            return {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U123456",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            };
          },
        },
      }),
    );
    const body = new URLSearchParams({
      minConfidence: "not-a-number",
      maxFindings: "5",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    // Never crashes (no 500) and never forwards NaN to the mutator.
    expect(res.status).toBe(302);
    expect(received).not.toHaveProperty("minConfidence");
    expect(received?.minConfidence).not.toBeNaN();
    expect(received).toEqual({ maxFindings: 5 });
  });

  it("POST /admin/agents/:id/settings with a cleared minConfidence leaves it unchanged rather than zeroing it", async () => {
    let received: Record<string, unknown> | undefined;
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          ...makeMockDeps().agentService,
          updateFields: async (_id: string, input: Record<string, unknown>) => {
            received = input;
            return {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U123456",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            };
          },
        },
      }),
    );
    // An emptied <input type="number"> submits "" — Number("") is 0, so
    // without a blank guard this would silently persist minConfidence: 0.
    const body = new URLSearchParams({
      minConfidence: "",
      maxFindings: "5",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(received).not.toHaveProperty("minConfidence");
    expect(received).toEqual({ maxFindings: 5 });
  });

  it("POST /admin/agents/:id/settings with a negative cleanupAfterDays leaves it unchanged", async () => {
    let received: Record<string, unknown> | undefined;
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          ...makeMockDeps().agentService,
          updateFields: async (_id: string, input: Record<string, unknown>) => {
            received = input;
            return {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U123456",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
              repos: [],
              reviewAuthorAllowlist: [],
              patchAuthorAllowlist: [],
              restrictSlackToMembers: false,
              missingRequiredEnv: [],
            };
          },
        },
      }),
    );
    const body = new URLSearchParams({ cleanupAfterDays: "-5" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(received).toEqual({});
  });
});

// ─── Token mutation routes ────────────────────────────────────────────────────

describe("admin UI — token mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/tokens creates token and renders 200 with token inline", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ label: "my-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/tokens`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    // Token is rendered in a 200 HTML response — not redirected with ?newToken= in the URL,
    // which would expose the raw token in server access logs and browser history.
    expect(res.status).toBe(200);
    const responseHtml = await res.text();
    expect(responseHtml).toContain("sw_raw123456");
  });

  it("POST /admin/agents/:id/tokens/:tokenId/revoke redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/tokens/${TOKEN_ID}/revoke`,
      {
        method: "POST",
        headers: { Cookie: `admin_session=${cookie}` },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

// ─── Member access control ────────────────────────────────────────────────────

describe("admin UI — member access control", () => {
  const MEMBER_EMAIL = "member@example.com";

  it("non-admin member can view their agent detail", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      MEMBER_EMAIL,
      false,
    );
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
        },
        agentEnv: { findMany: async () => [] },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async ({
            where,
          }: {
            where: { agentId_email: { agentId: string; email: string } };
          }) =>
            where.agentId_email.email === MEMBER_EMAIL
              ? { id: "m1", agentId: AGENT_ID, email: MEMBER_EMAIL }
              : null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: MEMBER_EMAIL,
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === MEMBER_EMAIL
            ? [{ id: "m1", agentId: AGENT_ID, email, createdAt: new Date() }]
            : [],
        exists: async (_agentId: string, email: string) =>
          email === MEMBER_EMAIL,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(200);
  });

  it("non-admin non-member gets 403 on agent detail", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${outsiderCookie}` },
    });
    expect(res.status).toBe(403);
  });

  it("account member can open their account's agent but gets 403 on another account's (SSP-2.1)", async () => {
    const cookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-acct",
      "acct-user@example.com",
      false,
    );
    const app = createAdminUIApp(
      makeMockDeps({
        callerScopeResolver: async () => ({
          kind: "scoped",
          accountId: "acct-a",
          agentIds: [AGENT_ID],
        }),
      }),
    );
    const own = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(own.status).toBe(200);
    const other = await app.request("/admin/agents/agent-in-account-b", {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(other.status).toBe(403);
  });

  it("non-admin sees only their agents in the agents list", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      MEMBER_EMAIL,
      false,
    );
    const OTHER_AGENT_ID = "agent-other-456";
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async ({
            where,
          }: {
            where?: { id?: { in?: string[] } };
          } = {}) => {
            const allAgents = [
              {
                id: AGENT_ID,
                name: "My Agent",
                slackId: "U1",
                createdAt: new Date("2024-01-01"),
              },
              {
                id: OTHER_AGENT_ID,
                name: "Other Agent",
                slackId: "U2",
                createdAt: new Date("2024-01-01"),
              },
            ];
            if (where?.id?.in) {
              return allAgents.filter((a) => where.id?.in?.includes(a.id));
            }
            return allAgents;
          },
          findUnique: async () => null,
          create: async () => ({
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentEnv: { findMany: async () => [] },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [
            {
              id: "m1",
              agentId: AGENT_ID,
              email: MEMBER_EMAIL,
              createdAt: new Date(),
            },
          ],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: MEMBER_EMAIL,
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === MEMBER_EMAIL
            ? [
                {
                  id: "m1",
                  agentId: AGENT_ID,
                  email: MEMBER_EMAIL,
                  createdAt: new Date(),
                },
              ]
            : [],
        exists: async () => false,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
      agentService: {
        listAll: async () => [
          {
            id: AGENT_ID,
            name: "My Agent",
            slackId: "U1",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
          {
            id: OTHER_AGENT_ID,
            name: "Other Agent",
            slackId: "U2",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
        ],
        listByIds: async (ids: string[]) =>
          [
            {
              id: AGENT_ID,
              name: "My Agent",
              slackId: "U1",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
            {
              id: OTHER_AGENT_ID,
              name: "Other Agent",
              slackId: "U2",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ].filter((a) => ids.includes(a.id)),
        searchByName: async () => [],
        listOptions: async () => [
          { id: AGENT_ID, name: "My Agent" },
          { id: OTHER_AGENT_ID, name: "Other Agent" },
        ],
        create: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        getDetail: async () => null,
        updateFields: async () => {
          throw new Error("not implemented");
        },
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/agents", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("My Agent");
    expect(html).not.toContain("Other Agent");
  });

  it("OAuth callback grants member access to non-admin with a matching membership", async () => {
    const nonce = "test-nonce-member";
    const params = new URLSearchParams({
      state: nonce,
      code: "auth-code-member",
    });
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const deps = makeMockDeps({
      googleClient: makeGoogleClient({
        getUserInfo: () =>
          Promise.resolve({
            sub: "google-sub-member",
            email: MEMBER_EMAIL,
            email_verified: true,
            name: "Member User",
          }),
      }),
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentEnv: { findMany: async () => [] },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [
            {
              id: "m1",
              agentId: AGENT_ID,
              email: MEMBER_EMAIL,
              createdAt: new Date(),
            },
          ],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: MEMBER_EMAIL,
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === MEMBER_EMAIL
            ? [
                {
                  id: "m1",
                  agentId: AGENT_ID,
                  email: MEMBER_EMAIL,
                  createdAt: new Date(),
                },
              ]
            : [],
        exists: async () => false,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(
      new Request(
        `https://example.com/admin/auth/callback?${params.toString()}`,
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Set-Cookie")).toContain("admin_session=");
  });

  it("OAuth callback returns 403 for non-admin with no membership", async () => {
    const nonce = "test-nonce-outsider";
    const params = new URLSearchParams({
      state: nonce,
      code: "auth-code-outsider",
    });
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const app = createAdminUIApp(
      makeMockDeps({
        googleClient: makeGoogleClient({
          getUserInfo: () =>
            Promise.resolve({
              sub: "google-sub-outsider",
              email: "outsider@example.com",
              email_verified: true,
              name: "Outsider",
            }),
        }),
      }),
    );
    const res = await app.request(
      new Request(
        `https://example.com/admin/auth/callback?${params.toString()}`,
        {
          headers: { Cookie: `oauth_state=${oauthState}` },
        },
      ),
    );
    expect(res.status).toBe(403);
  });
});

// ─── Agent delete route ───────────────────────────────────────────────────────

describe("admin UI — agent delete route", () => {
  let adminCookie: string;
  let nonAdminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
    nonAdminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
  });

  it("admin POST /admin/agents/:id/delete → 302 redirect to /admin/agents?success=deleted, deleteAgentFully's composed dependencies invoked, row actually deleted", async () => {
    let deprovisioned: string | null = null;
    let deleted: string | null = null;
    const taskStoreRevoked: string[] = [];
    const chatRevoked: string[] = [];
    const chatThreadsDeletedFor: string[] = [];
    const deps = makeMockDeps({
      provisioner: {
        canProvision: false,
        provision: async () => ({
          resourceName: "r",
          secretName: "s",
          deploymentName: "d",
        }),
        deprovision: async (agentId: string) => {
          deprovisioned = agentId;
        },
        reconcile: async () => ({
          recreated: [],
          migrated: [],
          noOwner: [],
          dryRun: false,
          updated: [],
          orphans: [],
          failed: [],
        }),
      },
      serviceIntegrations: [
        {
          name: "task-store",
          listTokensForAgent: async () => [{ id: "ts-1" }],
          revokeToken: async (id: string) => {
            taskStoreRevoked.push(id);
          },
        },
      ],
      chatService: {
        listTokensForAgent: async () => [{ id: "chat-1" }],
        revokeToken: async (id: string) => {
          chatRevoked.push(id);
        },
        deleteThreadsForAgent: async (agentId: string) => {
          chatThreadsDeletedFor.push(agentId);
          return { deleted: 0 };
        },
      },
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          delete: async ({ where }: { where: { id: string } }) => {
            deleted = where.id;
            return {
              id: where.id,
              name: "Test Agent",
              slackId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              repos: [],
            };
          },
        },
        // No secret/manual-step-worthy env rows — the success redirect must
        // be the bare "?success=deleted" with no &manualSteps= appended.
        agentEnv: { findMany: async () => [] },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: "member@example.com",
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/agents/${AGENT_ID}/delete`, {
      method: "POST",
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(302);
    // Exactly this Location — no &manualSteps= since there are no secret env rows.
    expect(res.headers.get("Location")).toBe("/admin/agents?success=deleted");
    // biome-ignore lint/style/noNonNullAssertion: set by the spy closure above
    expect(deprovisioned!).toBe(AGENT_ID);
    expect(taskStoreRevoked).toEqual(["ts-1"]);
    expect(chatRevoked).toEqual(["chat-1"]);
    expect(chatThreadsDeletedFor).toEqual([AGENT_ID]);
    // biome-ignore lint/style/noNonNullAssertion: set by the spy closure above
    expect(deleted!).toBe(AGENT_ID);
  });

  it("admin POST /admin/agents/:id/delete → when deprovision (k8s) throws, redirects to the agent's OWN page with an error and preserves the row (retry path)", async () => {
    let deleted: string | null = null;
    const deps = makeMockDeps({
      provisioner: {
        canProvision: false,
        provision: async () => ({
          resourceName: "r",
          secretName: "s",
          deploymentName: "d",
        }),
        deprovision: async () => {
          throw new Error("k8s API timeout");
        },
        reconcile: async () => ({
          recreated: [],
          migrated: [],
          noOwner: [],
          dryRun: false,
          updated: [],
          orphans: [],
          failed: [],
        }),
      },
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          delete: async ({ where }: { where: { id: string } }) => {
            deleted = where.id;
            return {
              id: where.id,
              name: "Test Agent",
              slackId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              repos: [],
            };
          },
        },
        agentEnv: { findMany: async () => [] },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: "member@example.com",
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/agents/${AGENT_ID}/delete`, {
      method: "POST",
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    // Redirects back to the agent's OWN page — NOT the agents list — so the
    // row doesn't appear deleted from the operator's perspective.
    expect(location.startsWith(`/admin/agents/${AGENT_ID}?error=`)).toBe(true);
    const errorMsg = decodeURIComponent(location.split("error=")[1] ?? "");
    expect(errorMsg).toContain("k8s");
    expect(deleted).toBeNull();
  });

  it("admin POST /admin/agents/:id/delete → surfaces manualStepsRequired on the success redirect when the agent has secret env rows", async () => {
    const deps = makeMockDeps({
      provisioner: {
        canProvision: false,
        provision: async () => ({
          resourceName: "r",
          secretName: "s",
          deploymentName: "d",
        }),
        deprovision: async () => {},
        reconcile: async () => ({
          recreated: [],
          migrated: [],
          noOwner: [],
          dryRun: false,
          updated: [],
          orphans: [],
          failed: [],
        }),
      },
      prisma: {
        agent: {
          findMany: async () => [
            {
              id: AGENT_ID,
              name: "Test Agent",
              slackId: "U123456",
              createdAt: new Date("2024-01-01"),
            },
          ],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            selfHosted: false,
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U123456",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
            repos: [],
          }),
          delete: async ({ where }: { where: { id: string } }) => ({
            id: where.id,
            name: "Test Agent",
            slackId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentEnv: {
          findMany: async () => [
            { key: "GH_TOKEN", value: "ghp_x", secret: true },
            { key: "PORT", value: "3000", secret: false },
          ],
        },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: "member@example.com",
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/agents/${AGENT_ID}/delete`, {
      method: "POST",
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(
      location.startsWith("/admin/agents?success=deleted&manualSteps="),
    ).toBe(true);
    const manualStepsRaw = new URLSearchParams(location.split("?")[1]).get(
      "manualSteps",
    );
    expect(manualStepsRaw).not.toBeNull();
    // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
    const manualSteps = JSON.parse(manualStepsRaw!) as Array<{ key: string }>;
    expect(manualSteps.map((s) => s.key)).toEqual(["GH_TOKEN"]);

    // A subsequent GET /admin/agents with that manualSteps query param renders
    // the dismissible panel (renderAgentsPage's opts wiring).
    const getRes = await app.request(
      `/admin/agents?${location.split("?")[1]}`,
      {
        headers: { Cookie: `admin_session=${adminCookie}` },
      },
    );
    expect(getRes.status).toBe(200);
    const html = await getRes.text();
    expect(html).toContain("Manual cleanup required");
    expect(html).toContain("GitHub personal access token");
  });

  it("non-admin POST /admin/agents/:id/delete → 403", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}/delete`, {
      method: "POST",
      headers: { Cookie: `admin_session=${nonAdminCookie}` },
    });
    expect(res.status).toBe(403);
  });
});

// ─── Member management routes ─────────────────────────────────────────────────

describe("admin UI — member management routes", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("admin can add a member via POST /admin/agents/:id/members", async () => {
    let created: { agentId: string; email: string } | null = null;
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            selfHosted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentEnv: { findMany: async () => [] },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async ({
            data,
          }: {
            data: { agentId: string; email: string };
          }) => {
            created = data;
            return { id: "m-new", ...data };
          },
          deleteMany: async () => ({ count: 0 }),
        },
      },
      agentMemberService: {
        listByEmail: async () => [],
        exists: async () => false,
        add: async (agentId: string, email: string) => {
          created = { agentId, email };
          return { id: "m-new", agentId, email, createdAt: new Date() };
        },
        remove: async () => {},
        listByAgentId: async () => [],
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ email: "newmember@example.com" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/members`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(created).not.toBeNull();
    expect((created as { agentId: string; email: string } | null)?.email).toBe(
      "newmember@example.com",
    );
  });

  it("admin can remove a member via POST /admin/agents/:id/members/delete", async () => {
    let deletedId: string | null = null;
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async () => [],
          findUnique: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            selfHosted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          create: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "Test Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentEnv: { findMany: async () => [] },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: "member@example.com",
          }),
          deleteMany: async ({
            where,
          }: {
            where: { id: string; agentId: string };
          }) => {
            deletedId = where.id;
            return { count: 1 };
          },
        },
      },
      agentMemberService: {
        listByEmail: async () => [],
        exists: async () => false,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: "member@example.com",
          createdAt: new Date(),
        }),
        remove: async (_agentId: string, memberId: string) => {
          deletedId = memberId;
        },
        listByAgentId: async () => [],
      },
    });
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ memberId: "m1" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/members/delete`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(deletedId as string | null).toBe("m1");
  });

  it("non-admin gets 403 on POST /admin/agents/:id/members", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ email: "new@example.com" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/members`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${memberCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });
});

describe("admin UI — manifest sync route", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("happy path: valid token + SLACK_APP_ID set → redirects to ?success=manifest_synced", async () => {
    let updateCalled = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => ({
            env: { SLACK_APP_ID: "A123456" },
            agentId: AGENT_ID,
            allowedTools: [],
          }),
        },
        slackClient: {
          updateAppManifest: async () => {
            updateCalled = true;
          },
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("success=manifest_synced");
    expect(updateCalled).toBe(true);
  });

  it("invalid token (wrong prefix) → redirects with error", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ xoxpToken: "xoxb-wrong-token-type" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=");
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "Slack app configuration token must start with xoxe.xoxp-",
    );
  });

  it("xoxe.xoxp rotating token → passes token validation", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({
      xoxpToken: "xoxe.xoxp-valid-rotating-token",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    // Token passes validation; redirect (if any) is for a different reason (e.g. missing SLACK_APP_ID)
    expect(decodeURIComponent(res.headers.get("location") ?? "")).not.toContain(
      "Slack app configuration token must start with",
    );
  });

  it("missing SLACK_APP_ID env var → redirects with error", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "SLACK_APP_ID is not set",
    );
  });

  it("Slack client throws → redirects with the error message", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => ({
            env: { SLACK_APP_ID: "A123456" },
            agentId: AGENT_ID,
            allowedTools: [],
          }),
        },
        slackClient: {
          updateAppManifest: async () => {
            throw new Error("slack_api_error");
          },
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(decodeURIComponent(res.headers.get("location") ?? "")).toContain(
      "slack_api_error",
    );
  });

  it("access denied: non-admin non-member → 403", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${outsiderCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("sync-manifest with SLACK_CLIENT_ID/SECRET/SIGNING_SECRET in env → 302 to slack.com/oauth/v2/authorize with provision state cookie set", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => ({
            env: {
              SLACK_APP_ID: "A123456",
              SLACK_CLIENT_ID: "my-client-id",
              SLACK_CLIENT_SECRET: "my-client-secret",
              SLACK_SIGNING_SECRET: "my-signing-secret",
            },
            agentId: AGENT_ID,
            allowedTools: [],
          }),
        },
        slackClient: {
          updateAppManifest: async () => {},
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("slack.com/oauth/v2/authorize");
    expect(location).toContain("client_id=my-client-id");
    // redirect_uri must point at the per-agent connect-slack callback, not
    // the removed /admin/provision/complete alias (UAP-3.3)
    expect(decodeURIComponent(location)).toContain(
      `redirect_uri=https://example.com/admin/agents/${AGENT_ID}/connect-slack/callback`,
    );
    // Provision state cookie should be set
    const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
    expect(setCookieHeader).toContain("slack_provision_state=");
    // Verify JWT payload — a bug encoding the wrong agentId or clientId
    // would pass the presence check above but be caught here
    const tokenMatch = setCookieHeader.match(/slack_provision_state=([^;]+)/);
    expect(tokenMatch).not.toBeNull();
    const jwtPayload = JSON.parse(
      Buffer.from(tokenMatch?.[1].split(".")[1] ?? "", "base64url").toString(),
    );
    expect(jwtPayload.agentId).toBe(AGENT_ID);
    expect(jwtPayload.clientId).toBe("my-client-id");
  });

  it("sync-manifest with no SLACK_CLIENT_ID in env (legacy agent) → 302 to ?success=manifest_synced", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => ({
            env: {
              SLACK_APP_ID: "A123456",
              // No SLACK_CLIENT_ID — legacy agent
            },
            agentId: AGENT_ID,
            allowedTools: [],
          }),
        },
        slackClient: {
          updateAppManifest: async () => {},
        },
      }),
    );
    const body = new URLSearchParams({ xoxpToken: "xoxe.xoxp-valid-token" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/sync-manifest`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("success=manifest_synced");
    expect(res.headers.get("Set-Cookie") ?? "").not.toContain(
      "slack_provision_state=",
    );
  });
});

// ─── connect-slack routes (UAP-1.1) ────────────────────────────────────────────
//
// New per-agent routes that delegate to the same extracted
// SlackProvisioningService the legacy /admin/provision/* wizard now calls —
// they must reach the same successful outcomes as that wizard's Slack path,
// for an already-existing agent id passed explicitly in the URL.

describe("admin UI — POST /admin/agents/:id/connect-slack", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid xoxe.xoxp- token → 302 redirect to slack.com/oauth authorize URL with provision-state cookie set", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const body = new URLSearchParams({
      xoxpToken: "xoxe.xoxp-1-fake-token-for-testing",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-slack`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://slack.com/oauth/authorize");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("slack_provision_state=");
  });

  it("missing xoxpToken → redirects back to the agent page with an error", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-slack`, {
      method: "POST",
      body: new URLSearchParams({}).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`/admin/agents/${AGENT_ID}`);
    expect(location).toContain("error=");
  });

  it("agent id that doesn't exist → redirects back with an error, no Slack call", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          listAll: async () => [],
          listByIds: async () => [],
          searchByName: async () => [],
          listOptions: async () => [],
          create: async () => {
            throw new Error("not implemented");
          },
          delete: async () => {},
          getDetail: async () => null,
          updateFields: async () => {
            throw new Error("not implemented");
          },
        },
      }),
    );

    const body = new URLSearchParams({
      xoxpToken: "xoxe.xoxp-1-fake-token-for-testing",
    });
    const res = await app.request(
      "/admin/agents/nonexistent-agent/connect-slack",
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${adminCookie}`,
        },
        redirect: "manual",
      },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/admin/agents/nonexistent-agent");
    expect(location).toContain("error=");
  });
});

describe("admin UI — GET /admin/agents/:id/connect-slack/callback", () => {
  let adminCookie: string;
  const PROVISION_STATE_COOKIE = "slack_provision_state";

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  async function makeProvisionStateCookie(
    opts: { agentId?: string; expired?: boolean } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        agentId: opts.agentId ?? AGENT_ID,
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        signingSecret: "test-signing-secret",
        appId: "A0123456789",
        iat: now,
        exp: opts.expired ? now - 10 : now + 300,
      },
      SESSION_SECRET,
      "HS256",
    );
  }

  it("valid state cookie + code param → stores SLACK_BOT_TOKEN and renders the xapp-token page (same outcome as /admin/provision/complete)", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const provisionState = await makeProvisionStateCookie();
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-slack/callback?code=valid-oauth-code`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${PROVISION_STATE_COOKIE}=${provisionState}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("xapp");
    expect(patchCalls.some((c) => "SLACK_BOT_TOKEN" in c.env)).toBe(true);
    // The rendered xapp-token form must submit to the per-agent connect-slack
    // route, not the removed /admin/provision/xapp-token alias (UAP-3.3).
    expect(html).toContain(
      `action="/admin/agents/${AGENT_ID}/connect-slack/app-token"`,
    );
    expect(html).not.toContain('action="/admin/provision/xapp-token"');
  });

  it("valid state cookie + code param → persists the resolved slackId through the full HTTP route, and the agent detail page then renders the Sync Manifest button (UAP-1.3 acceptance criterion 2)", async () => {
    // Step 1: exercise the real connect-slack/callback HTTP route (not just
    // the service layer) with an agent that has no slackId yet, and prove
    // agentService.updateFields is invoked with the Slack-resolved user id.
    const updateFieldsCalls: Array<{
      agentId: string;
      fields: { slackId?: string | null };
    }> = [];
    const initialAgent = {
      id: AGENT_ID,
      name: "Test Agent",
      slackId: null,
      selfHosted: false,
      typeName: "coding",
      createdAt: new Date("2024-01-01"),
      updatedAt: new Date("2024-01-01"),
      repos: [],
      reviewAuthorAllowlist: [],
      patchAuthorAllowlist: [],
      restrictSlackToMembers: false,
      missingRequiredEnv: [],
    };

    const callbackApp = createAdminUIApp(
      makeMockDeps({
        agentService: {
          listAll: async () => [],
          listByIds: async () => [],
          searchByName: async () => [],
          listOptions: async () => [],
          create: async () => {
            throw new Error("not implemented");
          },
          delete: async () => {},
          getDetail: async () => initialAgent,
          updateFields: async (
            agentId: string,
            fields: { slackId?: string | null },
          ) => {
            updateFieldsCalls.push({ agentId, fields });
            return { ...initialAgent, ...fields };
          },
        },
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    // Sanity check: before the flow, the agent page does NOT show the
    // Sync Manifest button (slackId is null).
    const beforeRes = await callbackApp.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(beforeRes.status).toBe(200);
    const beforeHtml = await beforeRes.text();
    expect(beforeHtml).not.toContain("Sync Manifest");

    const provisionState = await makeProvisionStateCookie();
    const callbackRes = await callbackApp.request(
      `/admin/agents/${AGENT_ID}/connect-slack/callback?code=valid-oauth-code`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${PROVISION_STATE_COOKIE}=${provisionState}`,
        },
      },
    );
    expect(callbackRes.status).toBe(200);

    // The key assertion: updateFields was called through the real HTTP
    // route with a non-null, non-empty slackId for the correct agent.
    expect(updateFieldsCalls).toHaveLength(1);
    expect(updateFieldsCalls[0]?.agentId).toBe(AGENT_ID);
    expect(updateFieldsCalls[0]?.fields.slackId).toBeTruthy();

    // Step 2: prove admin-ui-pages.ts's Sync Manifest gate renders once
    // slackId is populated, by hitting the agent detail route again with
    // a mock reflecting the post-flow (slackId-populated) state — mirroring
    // what completeConnect() just persisted above.
    const resolvedSlackId = updateFieldsCalls[0]?.fields.slackId as string;
    const detailApp = createAdminUIApp(
      makeMockDeps({
        agentService: {
          listAll: async () => [],
          listByIds: async () => [],
          searchByName: async () => [],
          listOptions: async () => [],
          create: async () => {
            throw new Error("not implemented");
          },
          delete: async () => {},
          getDetail: async () => ({
            ...initialAgent,
            slackId: resolvedSlackId,
          }),
          updateFields: async () => {
            throw new Error("not implemented");
          },
        },
      }),
    );

    const afterRes = await detailApp.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(afterRes.status).toBe(200);
    const afterHtml = await afterRes.text();
    expect(afterHtml).toContain("Sync Manifest");
  });

  it("missing state cookie → renders an error page", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-slack/callback?code=some-code`,
      {
        headers: { Cookie: `admin_session=${adminCookie}` },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });
});

describe("admin UI — POST /admin/agents/:id/connect-slack/app-token", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid xapp- token → 200, SLACK_APP_TOKEN stored, crons reconciled (same outcome as /admin/provision/xapp-token)", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const reconcileCalls: string[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
        agentCronJobService: {
          list: async () => [MOCK_CRON],
          listWithRunSummary: async () => [
            { ...MOCK_CRON, lastRun: null, runCountToday: 0 },
          ],
          get: async () => MOCK_CRON,
          create: async () => MOCK_CRON,
          setEnabled: async () => MOCK_CRON,
          update: async () => MOCK_CRON,
          delete: async () => {},
          reconcileSystemCrons: async (agentId: string) => {
            reconcileCalls.push(agentId);
            return { created: 3, updated: 0, deleted: 0 };
          },
        },
      }),
    );

    const body = new URLSearchParams({
      xappToken: "xapp-1-TEST-fake-socket-token",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-slack/app-token`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${adminCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    expect(
      patchCalls.some(
        (c) => c.env.SLACK_APP_TOKEN === "xapp-1-TEST-fake-socket-token",
      ),
    ).toBe(true);
    expect(reconcileCalls).toContain(AGENT_ID);
  });

  it("invalid xappToken (missing xapp- prefix) → shows error, no env write", async () => {
    let patched = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      xappToken: "not-a-valid-xapp-token",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-slack/app-token`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${adminCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });
});

// ─── connect-github routes (UAP-1.2) ───────────────────────────────────────────
//
// New per-agent routes that delegate to the same extracted
// GithubProvisioningService the legacy /admin/provision/* wizard's GitHub
// branches (and github-app/complete + github-app/installed) now call — they
// must reach the same successful outcomes as those legacy routes, for an
// already-existing agent id passed explicitly in the URL, across all three
// modes (pat / app-auto / app-manual).

const GITHUB_PROVISION_STATE_COOKIE = "github_provision_state";

describe("admin UI — POST /admin/agents/:id/connect-github (mode=pat)", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid PAT → 200 completion page, GH_TOKEN stored, no GitHub call", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "pat",
      ghPat: "ghp_faketokenfortesting1234567890",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect(
      patchCalls.some(
        (c) => c.env.GH_TOKEN === "ghp_faketokenfortesting1234567890",
      ),
    ).toBe(true);
  });

  it("missing ghPat → error, no env write", async () => {
    let patched = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({ ghAuthMode: "pat" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });

  it("agent id that doesn't exist → error, no GitHub/env call", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentService: {
          listAll: async () => [],
          listByIds: async () => [],
          searchByName: async () => [],
          listOptions: async () => [],
          create: async () => {
            throw new Error("not implemented");
          },
          delete: async () => {},
          getDetail: async () => null,
          updateFields: async () => {
            throw new Error("not implemented");
          },
        },
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "pat",
      ghPat: "ghp_faketokenfortesting1234567890",
    });
    const res = await app.request(
      "/admin/agents/nonexistent-agent/connect-github",
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${adminCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });
});

describe("admin UI — POST /admin/agents/:id/connect-github (mode=app, app-manual)", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid App ID/Installation ID/PEM key → 200 completion page, all three env vars stored", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "manual",
      ghAppId: "12345",
      ghAppInstallationId: "67890",
      ghAppPrivateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect(patchCalls.some((c) => c.env.GH_APP_ID === "12345")).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_INSTALLATION_ID === "67890"),
    ).toBe(true);
    expect(
      patchCalls.some((c) =>
        c.env.GH_APP_PRIVATE_KEY?.includes("BEGIN RSA PRIVATE KEY"),
      ),
    ).toBe(true);
  });

  it("UAP-5.4: valid App ID/Installation ID/PEM uploaded as a file → 200 completion page, GH_APP_PRIVATE_KEY stored with the file's text content", async () => {
    const patchCalls: Array<{ env: Record<string, string> }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (_agentId: string, env: Record<string, string>) => {
            patchCalls.push({ env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const pemContents =
      "-----BEGIN RSA PRIVATE KEY-----\nfaketestkeydata\n-----END RSA PRIVATE KEY-----";
    const form = new FormData();
    form.append("ghAuthMode", "app");
    form.append("ghAppMode", "manual");
    form.append("ghAppId", "12345");
    form.append("ghAppInstallationId", "67890");
    form.append(
      "ghAppPrivateKeyFile",
      new File([pemContents], "private-key.pem", {
        type: "application/x-pem-file",
      }),
    );

    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: form,
      headers: {
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect(patchCalls.some((c) => c.env.GH_APP_ID === "12345")).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_INSTALLATION_ID === "67890"),
    ).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_PRIVATE_KEY === pemContents),
    ).toBe(true);
  });

  it("non-numeric App ID → error, no env write", async () => {
    let patched = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "manual",
      ghAppId: "not-numeric",
      ghAppInstallationId: "67890",
      ghAppPrivateKey:
        "-----BEGIN RSA PRIVATE KEY-----\nfoo\n-----END RSA PRIVATE KEY-----",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });

  it("invalid PEM (missing BEGIN/PRIVATE KEY) → error, no env write", async () => {
    let patched = false;
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "manual",
      ghAppId: "12345",
      ghAppInstallationId: "67890",
      ghAppPrivateKey: "not-a-pem-key",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });
});

describe("admin UI — POST /admin/agents/:id/connect-github (mode=app, app-auto)", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  it("valid githubOrg → renders auto-submitting manifest redirect page targeting the org, with manifest hidden field, and sets state cookie with agentId + githubOrg", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "auto",
      githubOrg: "my-org",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      'action="https://github.com/organizations/my-org/settings/apps/new"',
    );
    expect(html).toContain('name="manifest"');

    const setCookieHeader = res.headers.get("Set-Cookie") ?? "";
    const match = setCookieHeader.match(/([a-zA-Z_]+_provision_state)=([^;]+)/);
    expect(match).toBeTruthy();
    const jwtToken = decodeURIComponent(match?.[2] ?? "");
    const parts = jwtToken.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? "", "base64url").toString("utf-8"),
    );
    expect(payload.githubOrg).toBe("my-org");
    expect(payload.agentId).toBe(AGENT_ID);
  });

  it.each([
    ["ghAppPublic=true", { ghAppPublic: "true" }, true],
    ["checkbox unchecked", {}, false],
  ])("%s → manifest public flag is %p", async (_label, extra, expectPublic) => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "auto",
      githubOrg: "my-org",
      ...extra,
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    const html = await res.text();
    expect(html).toMatch(
      new RegExp(`(&quot;|")public(&quot;|"):${expectPublic}`),
    );
  });

  it("invalid githubOrg → error before any redirect page is rendered", async () => {
    const app = createAdminUIApp(makeMockDeps());

    const body = new URLSearchParams({
      ghAuthMode: "app",
      ghAppMode: "auto",
      githubOrg: "-not-valid-!!",
    });
    const res = await app.request(`/admin/agents/${AGENT_ID}/connect-github`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(html).not.toContain("github.com/organizations/");
  });
});

describe("admin UI — GET /admin/agents/:id/connect-github/callback", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  async function makeProvisionStateCookie(
    overrides?: Record<string, unknown>,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        agentId: AGENT_ID,
        githubOrg: "my-org",
        iat: now,
        exp: now + 300,
        ...overrides,
      },
      SESSION_SECRET,
      "HS256",
    );
  }

  it("valid state cookie + code param → exchanges code, writes GH_APP_ID + GH_APP_PRIVATE_KEY, renders installations/new link (same outcome as /admin/provision/github-app/complete)", async () => {
    const patchCalls: Array<{
      agentId: string;
      env: Record<string, string>;
      secretKeys?: Set<string>;
    }> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        githubAppClient: {
          exchangeManifestCode: async (code: string) => {
            expect(code).toBe("valid-code-123");
            return {
              appId: "999111",
              slug: "my-shipwright-agent",
              pem: "-----BEGIN RSA PRIVATE KEY-----\nmock\n-----END RSA PRIVATE KEY-----",
              clientId: "gh-client-id",
              clientSecret: "gh-client-secret",
            };
          },
        },
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (
            agentId: string,
            env: Record<string, string>,
            secretKeys?: Set<string>,
          ) => {
            patchCalls.push({ agentId, env, secretKeys });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );

    const stateCookie = await makeProvisionStateCookie();
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback?code=valid-code-123`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      "https://github.com/apps/my-shipwright-agent/installations/new",
    );
    expect(
      patchCalls.some(
        (c) => c.agentId === AGENT_ID && c.env.GH_APP_ID === "999111",
      ),
    ).toBe(true);
    expect(
      patchCalls.some((c) =>
        c.env.GH_APP_PRIVATE_KEY?.includes("BEGIN RSA PRIVATE KEY"),
      ),
    ).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_CLIENT_ID === "gh-client-id"),
    ).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_CLIENT_SECRET === "gh-client-secret"),
    ).toBe(true);
    expect(
      patchCalls.some((c) => c.env.GH_APP_SLUG === "my-shipwright-agent"),
    ).toBe(true);
    const clientIdCall = patchCalls.find(
      (c) => c.env.GH_APP_CLIENT_ID === "gh-client-id",
    );
    expect(clientIdCall?.secretKeys?.has("GH_APP_SLUG")).toBe(false);
    expect(clientIdCall?.secretKeys?.has("GH_APP_CLIENT_SECRET")).toBe(true);
    expect(clientIdCall?.secretKeys?.has("GH_APP_CLIENT_ID")).toBe(false);
  });

  it("missing state cookie → renders an error page", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback?code=some-code`,
      {
        headers: { Cookie: `admin_session=${adminCookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });

  it("state cookie for a different agent id → forbidden", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const stateCookie = await makeProvisionStateCookie({
      agentId: "different-agent-id",
    });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback?code=some-code`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );
    // Either forbidden or a state-mismatch error page — must not proceed to
    // exchange the code for the wrong agent's env.
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const html = await res.text();
      expect(html.toLowerCase()).toContain("error");
    }
  });

  it("exchangeManifestCode rejecting → renders an error page rather than throwing", async () => {
    const stateCookie = await makeProvisionStateCookie();
    const app = createAdminUIApp(
      makeMockDeps({
        githubAppClient: {
          exchangeManifestCode: async () => {
            throw new Error("GitHub conversion failed");
          },
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback?code=bad-code`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });

  it("missing code query param → renders an error page", async () => {
    const stateCookie = await makeProvisionStateCookie();
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/callback`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });
});

describe("admin UI — GET /admin/agents/:id/connect-github/installed", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  async function makeProvisionStateCookie(
    overrides?: Record<string, unknown>,
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        agentId: AGENT_ID,
        githubOrg: "my-org",
        iat: now,
        exp: now + 300,
        ...overrides,
      },
      SESSION_SECRET,
      "HS256",
    );
  }

  it("valid state cookie + installation_id → writes GH_APP_INSTALLATION_ID, renders success, reconciles crons (same outcome as /admin/provision/github-app/installed)", async () => {
    const patchCalls: Array<{ agentId: string; env: Record<string, string> }> =
      [];
    const reconcileCalls: string[] = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async (agentId: string, env: Record<string, string>) => {
            patchCalls.push({ agentId, env });
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
        agentCronJobService: {
          list: async () => [MOCK_CRON],
          listWithRunSummary: async () => [
            { ...MOCK_CRON, lastRun: null, runCountToday: 0 },
          ],
          get: async () => MOCK_CRON,
          create: async () => MOCK_CRON,
          setEnabled: async () => MOCK_CRON,
          update: async () => MOCK_CRON,
          delete: async () => {},
          reconcileSystemCrons: async (agentId: string) => {
            reconcileCalls.push(agentId);
            return { created: 2, updated: 0, deleted: 0 };
          },
        },
      }),
    );

    const stateCookie = await makeProvisionStateCookie();
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/installed?installation_id=778899`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alert-success");
    expect(
      patchCalls.some(
        (c) =>
          c.agentId === AGENT_ID && c.env.GH_APP_INSTALLATION_ID === "778899",
      ),
    ).toBe(true);
    expect(reconcileCalls).toContain(AGENT_ID);
  });

  it("stored GH_APP_INSTALLATION_ID → left unchanged, renders install-received page", async () => {
    const patchCalls: Array<Record<string, string>> = [];
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({
            env: { GH_APP_INSTALLATION_ID: "111" },
            secretKeys: [],
          }),
          upsert: async () => {},
          patch: async (_id: string, env: Record<string, string>) => {
            patchCalls.push(env);
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );
    const stateCookie = await makeProvisionStateCookie();
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/installed?installation_id=778899`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alert-success");
    expect(html).toContain("Install received");
    expect(patchCalls.some((e) => "GH_APP_INSTALLATION_ID" in e)).toBe(false);
  });

  it("reconcileSystemCrons rejecting → still renders success (best-effort, non-fatal)", async () => {
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
        agentCronJobService: {
          list: async () => [MOCK_CRON],
          listWithRunSummary: async () => [
            { ...MOCK_CRON, lastRun: null, runCountToday: 0 },
          ],
          get: async () => MOCK_CRON,
          create: async () => MOCK_CRON,
          setEnabled: async () => MOCK_CRON,
          update: async () => MOCK_CRON,
          delete: async () => {},
          reconcileSystemCrons: async () => {
            throw new Error("reconcile boom");
          },
        },
      }),
    );

    const stateCookie = await makeProvisionStateCookie();
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/installed?installation_id=778899`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alert-success");
  });

  it("non-numeric installation_id → error, no env write", async () => {
    let patched = false;
    const stateCookie = await makeProvisionStateCookie();
    const app = createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env: {}, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {
            patched = true;
          },
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/installed?installation_id=not-a-number`,
      {
        headers: {
          Cookie: `admin_session=${adminCookie}; ${GITHUB_PROVISION_STATE_COOKIE}=${stateCookie}`,
        },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
    expect(patched).toBe(false);
  });

  it("missing state cookie → renders an error page", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/connect-github/installed?installation_id=123`,
      {
        headers: { Cookie: `admin_session=${adminCookie}` },
      },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("error");
  });
});

describe("admin UI — GET /admin/agents/:id/connect-github/add-org", () => {
  let adminCookie: string;

  beforeAll(async () => {
    adminCookie = await makeSessionCookie();
  });

  function appWithEnv(env: Record<string, string>) {
    return createAdminUIApp(
      makeMockDeps({
        agentEnvService: {
          getByAgentId: async () => ({ env, secretKeys: [] }),
          upsert: async () => {},
          patch: async () => {},
          deleteKey: async () => {},
          getConfigBundle: async () => null,
        },
      }),
    );
  }

  it("redirects to the App install URL for the stored slug", async () => {
    const res = await appWithEnv({ GH_APP_SLUG: "my-app" }).request(
      `/admin/agents/${AGENT_ID}/connect-github/add-org`,
      { headers: { Cookie: `admin_session=${adminCookie}` } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/apps/my-app/installations/new",
    );
  });

  it("rejects an invalid slug without redirecting to GitHub", async () => {
    const res = await appWithEnv({ GH_APP_SLUG: "evil/../x?y" }).request(
      `/admin/agents/${AGENT_ID}/connect-github/add-org`,
      { headers: { Cookie: `admin_session=${adminCookie}` } },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`/admin/agents/${AGENT_ID}?error=`);
    expect(location).not.toContain("github.com/apps");
  });

  it("missing slug redirects back with an error", async () => {
    const res = await appWithEnv({}).request(
      `/admin/agents/${AGENT_ID}/connect-github/add-org`,
      { headers: { Cookie: `admin_session=${adminCookie}` } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      `/admin/agents/${AGENT_ID}?error=`,
    );
  });
});

describe("admin UI — create agent with author allowlist", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents with valid authorAllowlist creates agent and redirects to detail page", async () => {
    let capturedAllowlist: string[] | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      updateFields: async (
        id: string,
        input: { reviewAuthorAllowlist?: string[] },
      ) => {
        capturedAllowlist = input.reviewAuthorAllowlist;
        return {
          id,
          name: "Test Agent",
          slackId: null,
          selfHosted: true,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: capturedAllowlist ?? [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "Test Agent",
      type: "coding",
      authorAllowlist: "octocat\nanother-user\noctocat",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    // Deduped — "octocat" only appears once even though submitted twice.
    expect(capturedAllowlist).toEqual(["octocat", "another-user"]);
  });

  it("POST /admin/agents records the session user's lower-cased email as owner and ignores a form-supplied owner (PAI-1.2)", async () => {
    const deps = makeMockDeps();
    const created: Array<Record<string, unknown>> = [];
    const plain = deps.agentService;
    deps.agentService = {
      ...plain,
      create: async (...args: Parameters<typeof plain.create>) => {
        created.push(args[0] as unknown as Record<string, unknown>);
        return plain.create(...args);
      },
    };
    const ownerCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-owner",
      "Owner.Person@Example.com",
    );
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: new URLSearchParams({
        name: "Test Agent",
        type: "coding",
        ownerEmail: "attacker@evil.example",
      }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${ownerCookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(created).toHaveLength(1);
    expect(created[0]?.ownerEmail).toBe("owner.person@example.com");
  });

  // Regression guard for the createAgent() deps wiring: production injects a
  // real `new AgentService(prisma)`, whose create/delete/updateFields are
  // ordinary class methods and therefore live on AgentService.prototype — NOT
  // as own enumerable properties. Every other double in this file is a plain
  // object literal, so a `{...agentService}` spread at the call site would
  // look fine here while throwing "create is not a function" in production.
  // `withPrototypeMethods()` reproduces the class-instance shape: the returned
  // object has zero own enumerable properties and resolves every method
  // through its prototype, so a spread would yield `{}`.
  it("POST /admin/agents works when agentService's methods live on its prototype (class instance, not object literal)", async () => {
    const withPrototypeMethods = <T extends object>(source: T): T => {
      const proto: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === "function") proto[key] = value;
      }
      return Object.create(proto) as T;
    };

    const deps = makeMockDeps();
    const plain = deps.agentService;
    const calls: string[] = [];
    deps.agentService = withPrototypeMethods({
      ...plain,
      create: async (...args: Parameters<typeof plain.create>) => {
        calls.push("create");
        return plain.create(...args);
      },
      updateFields: async (...args: Parameters<typeof plain.updateFields>) => {
        calls.push("updateFields");
        return plain.updateFields(...args);
      },
      delete: async (...args: Parameters<typeof plain.delete>) => {
        calls.push("delete");
        return plain.delete(...args);
      },
    });
    // Sanity check: the double really does hide its methods from a spread.
    expect(Object.keys({ ...deps.agentService })).toEqual([]);
    expect(typeof deps.agentService.create).toBe("function");

    const app = createAdminUIApp(deps);
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: `admin_session=${cookie}`,
    };

    // Happy path — exercises create() + updateFields().
    const okRes = await app.request("/admin/agents", {
      method: "POST",
      body: new URLSearchParams({
        name: "Test Agent",
        type: "coding",
        repos: "octocat/hello-world",
      }).toString(),
      headers,
    });
    expect(okRes.status).toBe(302);
    expect(okRes.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    expect(calls).toEqual(["create", "updateFields"]);

    // Rollback path — exercises delete().
    calls.length = 0;
    const badRes = await app.request("/admin/agents", {
      method: "POST",
      body: new URLSearchParams({
        name: "Test Agent",
        type: "coding",
        repos: "not-an-org-repo",
      }).toString(),
      headers,
    });
    expect(badRes.status).toBe(302);
    expect(badRes.headers.get("Location")).toBe(
      "/admin/agents/new?error=invalid_repo_format",
    );
    expect(calls).toEqual(["create", "delete"]);
  });

  it("POST /admin/agents with invalid authorAllowlist entries deletes the created agent and redirects with error", async () => {
    let deletedId: string | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      delete: async (id: string) => {
        deletedId = id;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "Test Agent",
      type: "coding",
      authorAllowlist: "octocat\nnot a valid login!",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=invalid_author_allowlist_format",
    );
    expect(deletedId).toBe(AGENT_ID);
  });
});

describe("admin UI — create agent with patch author allowlist", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents with valid patchAuthorAllowlist creates agent and redirects to detail page", async () => {
    let capturedAllowlist: string[] | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      updateFields: async (
        id: string,
        input: { patchAuthorAllowlist?: string[] },
      ) => {
        capturedAllowlist = input.patchAuthorAllowlist;
        return {
          id,
          name: "Test Agent",
          slackId: null,
          selfHosted: true,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          authorAllowlist: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: capturedAllowlist ?? [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "Test Agent",
      type: "coding",
      patchAuthorAllowlist: "octocat\nanother-user\noctocat",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    // Deduped — "octocat" only appears once even though submitted twice.
    expect(capturedAllowlist).toEqual(["octocat", "another-user"]);
  });

  it("POST /admin/agents with invalid patchAuthorAllowlist entries deletes the created agent and redirects with error", async () => {
    let deletedId: string | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      delete: async (id: string) => {
        deletedId = id;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({
      name: "Test Agent",
      type: "coding",
      patchAuthorAllowlist: "octocat\nnot a valid login!",
    });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=invalid_author_allowlist_format",
    );
    expect(deletedId).toBe(AGENT_ID);
  });
});

describe("admin UI — create agent seeds manifest tools and plugins", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents with type=coding seeds AgentTool rows for every manifest tool (including Bash) and an AgentPlugin row named shipwright", async () => {
    const seededTools: string[] = [];
    const seededPlugins: string[] = [];
    const deps = makeMockDeps();
    deps.agentToolService = {
      ...deps.agentToolService,
      add: async (agentId: string, pattern: string) => {
        seededTools.push(pattern);
        return { ...MOCK_TOOL, agentId, pattern };
      },
    };
    deps.agentPluginService = {
      ...deps.agentPluginService,
      add: async (agentId: string, name: string) => {
        seededPlugins.push(name);
        return {
          id: "p1",
          agentId,
          name,
          version: null,
          enabled: true,
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ name: "Test Agent", type: "coding" });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
    expect(seededTools).toEqual([
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Bash",
      "WebSearch",
      "WebFetch",
      "Skill",
      "Agent",
      "Monitor",
    ]);
    expect(seededTools).toContain("Bash");
    expect(seededPlugins).toEqual(["shipwright"]);
  });

  it("POST /admin/agents rolls back the agent and redirects with error when tool seeding fails", async () => {
    let deletedId: string | undefined;
    const deps = makeMockDeps();
    deps.agentToolService = {
      ...deps.agentToolService,
      add: async () => {
        throw new Error("boom: tool seeding failed");
      },
    };
    deps.agentService = {
      ...deps.agentService,
      delete: async (id: string) => {
        deletedId = id;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ name: "Test Agent", type: "coding" });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=seed_failed",
    );
    expect(deletedId).toBe(AGENT_ID);
  });

  it("POST /admin/agents rolls back the agent and redirects with error when plugin seeding fails", async () => {
    let deletedId: string | undefined;
    const deps = makeMockDeps();
    deps.agentPluginService = {
      ...deps.agentPluginService,
      add: async () => {
        throw new Error("boom: plugin seeding failed");
      },
    };
    deps.agentService = {
      ...deps.agentService,
      delete: async (id: string) => {
        deletedId = id;
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ name: "Test Agent", type: "coding" });
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "/admin/agents/new?error=seed_failed",
    );
    expect(deletedId).toBe(AGENT_ID);
  });
});

describe("admin UI — repos mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/repos/add returns 403 for non-admin non-member", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ repo: "org/repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${outsiderCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/repos/add with invalid repo format redirects with error=invalid_repo_format", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ repo: "not-a-valid-repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?error=invalid_repo_format`,
    );
  });

  it("POST /admin/agents/:id/repos/add with a same-basename repo under another owner redirects with an error naming both repos", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({ id: AGENT_ID, repos: ["acme/api"] }) as never,
    };
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: new URLSearchParams({ repo: "globex/api" }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    const location = decodeURIComponent(res.headers.get("Location") ?? "");
    expect(location).toContain("acme/api");
    expect(location).toContain("globex/api");
  });

  it("POST /admin/agents with colliding repos redirects to the form with an error naming both repos", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/agents", {
      method: "POST",
      body: new URLSearchParams({
        name: "Test Agent",
        type: "coding",
        repos: "acme/api\nglobex/api",
      }).toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("/admin/agents/new?error=")).toBe(true);
    const follow = await app.request(location, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    const page = await follow.text();
    expect(page).toContain("acme/api");
    expect(page).toContain("globex/api");
  });

  it("POST /admin/agents/:id/repos/add returns 404 when agent not found", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => null,
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ repo: "org/repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(404);
  });

  it("POST /admin/agents/:id/repos/add with valid repo redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ repo: "my-org/my-repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/repos/add deduplicates — does not add the same repo twice", async () => {
    let capturedRepos: string[] | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: ["my-org/my-repo"],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (id: string, input: { repos?: string[] }) => {
        capturedRepos = input.repos;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: capturedRepos ?? [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ repo: "my-org/my-repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/add`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    // update should not have been called — no-op deduplication returns existing list
    // If update was called, repos should still be exactly ["my-org/my-repo"]
    if (capturedRepos !== undefined) {
      expect(capturedRepos).toEqual(["my-org/my-repo"]);
    }
  });

  it("POST /admin/agents/:id/repos/delete with valid repo redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ repo: "my-org/my-repo" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/repos/delete`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });
});

describe("admin UI — author allowlist mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/review-author-allowlist/add returns 403 for non-admin non-member", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${outsiderCookie}`,
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/review-author-allowlist/add with invalid login format redirects with error=invalid_author_allowlist_format", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "not a valid login!" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?error=invalid_author_allowlist_format`,
    );
  });

  it("POST /admin/agents/:id/review-author-allowlist/add returns 404 when agent not found", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => null,
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("POST /admin/agents/:id/review-author-allowlist/add with valid login redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/review-author-allowlist/add deduplicates — does not add the same login twice", async () => {
    let capturedAllowlist: string[] | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: ["octocat"],
        patchAuthorAllowlist: ["octocat"],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (
        id: string,
        input: { reviewAuthorAllowlist?: string[] },
      ) => {
        capturedAllowlist = input.reviewAuthorAllowlist;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: capturedAllowlist ?? [],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    // update should not have been called — no-op deduplication returns existing list
    // If update was called, allowlist should still be exactly ["octocat"]
    if (capturedAllowlist !== undefined) {
      expect(capturedAllowlist).toEqual(["octocat"]);
    }
  });

  it("POST /admin/agents/:id/review-author-allowlist/add writes to reviewAuthorAllowlist", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (id: string, input: Record<string, unknown>) => {
        capturedInput = input;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: ["octocat"],
          patchAuthorAllowlist: [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(capturedInput).toEqual({ reviewAuthorAllowlist: ["octocat"] });
  });

  it("POST /admin/agents/:id/review-author-allowlist/delete with valid login redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/review-author-allowlist/delete`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("old route path /admin/agents/:id/author-allowlist/add no longer exists", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("old route path /admin/agents/:id/author-allowlist/delete no longer exists", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/author-allowlist/delete`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("admin UI — patch author allowlist mutation routes", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add returns 403 for non-admin non-member", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${outsiderCookie}`,
        },
      },
    );
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add with invalid login format redirects with error=invalid_author_allowlist_format", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "not a valid login!" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?error=invalid_author_allowlist_format`,
    );
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add returns 404 when agent not found", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => null,
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add with valid login redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add deduplicates — does not add the same login twice", async () => {
    let capturedAllowlist: string[] | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: ["octocat"],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (
        id: string,
        input: { patchAuthorAllowlist?: string[] },
      ) => {
        capturedAllowlist = input.patchAuthorAllowlist;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: capturedAllowlist ?? [],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    // update should not have been called — no-op deduplication returns existing list
    // If update was called, allowlist should still be exactly ["octocat"]
    if (capturedAllowlist !== undefined) {
      expect(capturedAllowlist).toEqual(["octocat"]);
    }
  });

  it("POST /admin/agents/:id/patch-author-allowlist/add writes to patchAuthorAllowlist", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (id: string, input: Record<string, unknown>) => {
        capturedInput = input;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: ["octocat"],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/add`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(capturedInput).toEqual({ patchAuthorAllowlist: ["octocat"] });
  });

  it("POST /admin/agents/:id/patch-author-allowlist/delete with valid login redirects to agent detail", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/delete`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/patch-author-allowlist/delete removes the login from patchAuthorAllowlist", async () => {
    let capturedInput: Record<string, unknown> | undefined;
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      getDetail: async () => ({
        id: AGENT_ID,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: ["octocat", "other-user"],
        restrictSlackToMembers: false,
        missingRequiredEnv: [],
      }),
      updateFields: async (id: string, input: Record<string, unknown>) => {
        capturedInput = input;
        return {
          id,
          name: "Test Agent",
          slackId: "U123456",
          selfHosted: false,
          typeName: "coding",
          createdAt: new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
          repos: [],
          reviewAuthorAllowlist: [],
          patchAuthorAllowlist: ["other-user"],
          restrictSlackToMembers: false,
          missingRequiredEnv: [],
        };
      },
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ login: "octocat" });
    const res = await app.request(
      `/admin/agents/${AGENT_ID}/patch-author-allowlist/delete`,
      {
        method: "POST",
        body: body.toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `admin_session=${cookie}`,
        },
      },
    );
    expect(res.status).toBe(302);
    expect(capturedInput).toEqual({ patchAuthorAllowlist: ["other-user"] });
  });
});

describe("admin UI — Slack access settings route (restrictSlackToMembers)", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("POST /admin/agents/:id/settings returns 403 for non-admin non-member", async () => {
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-outsider",
      "outsider@example.com",
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({ restrictSlackToMembers: "true" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${outsiderCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/settings returns 403 for non-admin AgentMember", async () => {
    const MEMBER_EMAIL = "member@example.com";
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      MEMBER_EMAIL,
      false,
    );
    const deps = makeMockDeps();
    deps.agentMemberService = {
      ...deps.agentMemberService,
      exists: async (_agentId: string, email: string) => email === MEMBER_EMAIL,
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ restrictSlackToMembers: "true" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${memberCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/agents/:id/settings with restrictSlackToMembers:true and zero members redirects with warning query param", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      updateFields: async (
        id: string,
        input: { restrictSlackToMembers?: boolean },
      ) => ({
        id,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: input.restrictSlackToMembers ?? false,
        missingRequiredEnv: [],
      }),
    };
    deps.agentMemberService = {
      ...deps.agentMemberService,
      listByAgentId: async () => [],
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ restrictSlackToMembers: "true" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      `/admin/agents/${AGENT_ID}?warning=restrict_slack_no_members`,
    );
  });

  it("POST /admin/agents/:id/settings with restrictSlackToMembers:true and existing members redirects with no warning param", async () => {
    const deps = makeMockDeps();
    deps.agentService = {
      ...deps.agentService,
      updateFields: async (
        id: string,
        input: { restrictSlackToMembers?: boolean },
      ) => ({
        id,
        name: "Test Agent",
        slackId: "U123456",
        selfHosted: false,
        typeName: "coding",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        repos: [],
        reviewAuthorAllowlist: [],
        patchAuthorAllowlist: [],
        restrictSlackToMembers: input.restrictSlackToMembers ?? false,
        missingRequiredEnv: [],
      }),
    };
    deps.agentMemberService = {
      ...deps.agentMemberService,
      listByAgentId: async () => [
        {
          id: "m1",
          agentId: AGENT_ID,
          email: "member@example.com",
          createdAt: new Date("2024-01-01"),
        },
      ],
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({ restrictSlackToMembers: "true" });
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("POST /admin/agents/:id/settings with restrictSlackToMembers:false never redirects with a warning, even with zero members", async () => {
    const deps = makeMockDeps();
    deps.agentMemberService = {
      ...deps.agentMemberService,
      listByAgentId: async () => [],
    };
    const app = createAdminUIApp(deps);
    const body = new URLSearchParams({});
    const res = await app.request(`/admin/agents/${AGENT_ID}/settings`, {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("GET /admin/agents/:id with warning=restrict_slack_no_members renders a warning banner", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(
      `/admin/agents/${AGENT_ID}?warning=restrict_slack_no_members`,
      { headers: { Cookie: `admin_session=${cookie}` } },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="alert alert-warning"');
    expect(html).toContain("no members");
  });

  it("GET /admin/agents/:id without a warning query param renders no warning banner", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("restrict_slack_no_members");
  });
});

// ─── Okta-authenticated access control ────────────────────────────────────────
//
// ESR-2.1: verification-only coverage. These duplicate the Google-authenticated
// access-control cases above (agents-list filtering, per-agent 403s,
// admin-only-route 403s, /admin/chat 403) under an Okta-issued session, to
// confirm isAdmin/AgentMember/assertAgentAccess behave identically regardless
// of which OAuth provider minted the session cookie — completeLogin() in
// admin-ui.ts is shared across providers, so the session JWT shape (and thus
// every downstream access check) is provider-agnostic. No new access-control
// logic is introduced here.
//
// The first test below closes the gap flagged in review: rather than minting
// the session JWT directly via makeSessionCookie() (which never touches Okta
// code), it drives the real GET /admin/auth/okta/callback handler — token
// exchange + userinfo normalization via the makeOktaClient mock — and then
// reuses the cookie that handler actually sets on a subsequent authenticated
// request, proving the callback-minted session drives access control exactly
// like the directly-minted ones the remaining tests below use.

describe("admin UI — Okta-authenticated access control", () => {
  const OKTA_MEMBER_EMAIL = "okta-member@example.com";
  const OKTA_OTHER_AGENT_ID = "agent-okta-other-456";

  it("session minted by the real Okta callback route grants access like a directly-minted session", async () => {
    // Drive the actual /admin/auth/okta/callback handler: CSRF state check,
    // exchangeCode() + getUserInfo() via the makeOktaClient mock, allowlist
    // check, then completeLogin() mints the session cookie.
    const nonce = "test-okta-nonce-real-callback";
    const oauthState = encodeURIComponent(JSON.stringify({ nonce }));
    const params = new URLSearchParams({ state: nonce, code: "auth-code-123" });
    const callbackApp = createAdminUIApp(
      makeMockDeps({
        oktaClient: makeOktaClient({
          getUserInfo: () =>
            Promise.resolve({
              sub: "okta-sub-real-callback",
              email: "admin@example.com",
              email_verified: true,
              name: "Admin User",
            }),
        }),
      }),
    );
    const callbackRes = await callbackApp.request(
      new Request(
        `https://example.com/admin/auth/okta/callback?${params.toString()}`,
        { headers: { Cookie: `oauth_state=${oauthState}` } },
      ),
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("Location")).toBe("/admin/agents");
    // Response.headers.get() folds multiple Set-Cookie headers (here: the
    // oauth_state deletion + the new admin_session) into one comma-joined
    // string, so pull out the admin_session value specifically.
    const setCookieHeader = callbackRes.headers.get("Set-Cookie") ?? "";
    const sessionCookieMatch = setCookieHeader.match(/admin_session=([^;,]+)/);
    const sessionCookie = sessionCookieMatch?.[1];
    expect(sessionCookie).toBeTruthy();

    // Reuse the callback-minted cookie on a subsequent request — same
    // access-control path (isAdmin from the session) as the
    // makeSessionCookie()-based tests below, but now proven to originate
    // from the real Okta callback handler rather than a bypass.
    const listApp = createAdminUIApp(makeMockDeps());
    const listRes = await listApp.request("/admin/agents", {
      headers: { Cookie: `admin_session=${sessionCookie}` },
    });
    expect(listRes.status).toBe(200);
    const listHtml = await listRes.text();
    expect(listHtml).toContain("Test Agent");
  });

  it("Okta-authenticated admin sees all agents and can create one", async () => {
    const adminCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-admin",
      "admin@example.com",
      true,
    );

    // AC1a: admin sees all agents in the agents list.
    const listApp = createAdminUIApp(makeMockDeps());
    const listRes = await listApp.request("/admin/agents", {
      headers: { Cookie: `admin_session=${adminCookie}` },
    });
    expect(listRes.status).toBe(200);
    const listHtml = await listRes.text();
    expect(listHtml).toContain("Test Agent");

    // AC1b: admin can create an agent.
    const createApp = createAdminUIApp(makeMockDeps());
    const body = new URLSearchParams({
      name: "Okta Created Agent",
      type: "coding",
    });
    const createRes = await createApp.request("/admin/agents", {
      method: "POST",
      body: body.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `admin_session=${adminCookie}`,
      },
    });
    expect(createRes.status).toBe(302);
    expect(createRes.headers.get("Location")).toBe(`/admin/agents/${AGENT_ID}`);
  });

  it("Okta-authenticated non-admin sees only their AgentMember agent(s), 403s elsewhere", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-member",
      OKTA_MEMBER_EMAIL,
      false,
    );

    // AC2a: agents list is filtered down to the member's own agent(s).
    const deps = makeMockDeps({
      prisma: {
        agent: {
          findMany: async ({
            where,
          }: {
            where?: { id?: { in?: string[] } };
          } = {}) => {
            const allAgents = [
              {
                id: AGENT_ID,
                name: "My Okta Agent",
                slackId: "U1",
                createdAt: new Date("2024-01-01"),
              },
              {
                id: OKTA_OTHER_AGENT_ID,
                name: "Other Okta Agent",
                slackId: "U2",
                createdAt: new Date("2024-01-01"),
              },
            ];
            if (where?.id?.in) {
              return allAgents.filter((a) => where.id?.in?.includes(a.id));
            }
            return allAgents;
          },
          findUnique: async () => null,
          create: async () => ({
            id: AGENT_ID,
            name: "My Okta Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          update: async () => ({
            id: AGENT_ID,
            name: "My Okta Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
          delete: async () => ({
            id: AGENT_ID,
            name: "My Okta Agent",
            slackId: "U1",
            createdAt: new Date(),
            updatedAt: new Date(),
            repos: [],
          }),
        },
        agentEnv: { findMany: async () => [] },
        agentPlugin: { findMany: async () => [] },
        agentMember: {
          findMany: async () => [
            {
              id: "m1",
              agentId: AGENT_ID,
              email: OKTA_MEMBER_EMAIL,
              createdAt: new Date(),
            },
          ],
          findUnique: async () => null,
          create: async () => ({
            id: "m1",
            agentId: AGENT_ID,
            email: OKTA_MEMBER_EMAIL,
          }),
          deleteMany: async () => ({ count: 0 }),
        },
      },
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === OKTA_MEMBER_EMAIL
            ? [
                {
                  id: "m1",
                  agentId: AGENT_ID,
                  email: OKTA_MEMBER_EMAIL,
                  createdAt: new Date(),
                },
              ]
            : [],
        exists: async (_agentId: string, email: string) =>
          email === OKTA_MEMBER_EMAIL,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: OKTA_MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
      agentService: {
        listAll: async () => [
          {
            id: AGENT_ID,
            name: "My Okta Agent",
            slackId: "U1",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
          {
            id: OKTA_OTHER_AGENT_ID,
            name: "Other Okta Agent",
            slackId: "U2",
            selfHosted: false,
            typeName: "coding",
            createdAt: new Date("2024-01-01"),
            updatedAt: new Date("2024-01-01"),
          },
        ],
        listByIds: async (ids: string[]) =>
          [
            {
              id: AGENT_ID,
              name: "My Okta Agent",
              slackId: "U1",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
            {
              id: OKTA_OTHER_AGENT_ID,
              name: "Other Okta Agent",
              slackId: "U2",
              selfHosted: false,
              typeName: "coding",
              createdAt: new Date("2024-01-01"),
              updatedAt: new Date("2024-01-01"),
            },
          ].filter((a) => ids.includes(a.id)),
        searchByName: async () => [],
        listOptions: async () => [
          { id: AGENT_ID, name: "My Okta Agent" },
          { id: OKTA_OTHER_AGENT_ID, name: "Other Okta Agent" },
        ],
        create: async () => {
          throw new Error("not implemented");
        },
        delete: async () => {},
        getDetail: async () => null,
        updateFields: async () => {
          throw new Error("not implemented");
        },
      },
    });
    const listApp = createAdminUIApp(deps);
    const listRes = await listApp.request("/admin/agents", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(listRes.status).toBe(200);
    const listHtml = await listRes.text();
    expect(listHtml).toContain("My Okta Agent");
    expect(listHtml).not.toContain("Other Okta Agent");

    // AC2b: per-agent access — a non-member gets 403 on an agent they don't belong to.
    const outsiderCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-outsider",
      "okta-outsider@example.com",
      false,
    );
    const detailApp = createAdminUIApp(makeMockDeps());
    const detailRes = await detailApp.request(`/admin/agents/${AGENT_ID}`, {
      headers: { Cookie: `admin_session=${outsiderCookie}` },
    });
    expect(detailRes.status).toBe(403);

    // AC2c: admin-only-route 403 for a non-admin Okta session.
    const provisionApp = createAdminUIApp(makeMockDeps());
    const provisionRes = await provisionApp.request("/admin/agents/new", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(provisionRes.status).toBe(403);
  });

  it("Okta-authenticated non-admin can configure their own agent's settings", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-member",
      OKTA_MEMBER_EMAIL,
      false,
    );
    let upsertCalledWith: unknown[] = [];
    const deps = makeMockDeps({
      agentMemberService: {
        listByEmail: async (email: string) =>
          email === OKTA_MEMBER_EMAIL
            ? [{ id: "m1", agentId: AGENT_ID, email, createdAt: new Date() }]
            : [],
        exists: async (_agentId: string, email: string) =>
          email === OKTA_MEMBER_EMAIL,
        add: async () => ({
          id: "m1",
          agentId: AGENT_ID,
          email: OKTA_MEMBER_EMAIL,
          createdAt: new Date(),
        }),
        remove: async () => {},
        listByAgentId: async () => [],
      },
      agentEnvService: {
        getByAgentId: async () => ({ env: { FOO: "bar" }, secretKeys: [] }),
        upsert: async (...args: unknown[]) => {
          upsertCalledWith = args;
        },
        patch: async (...args: unknown[]) => {
          upsertCalledWith = args;
        },
        deleteKey: async () => {},
        getConfigBundle: async () => null,
      },
    });
    const app = createAdminUIApp(deps);
    const form = new FormData();
    form.append("key", "MY_VAR");
    form.append("value", "configured-by-okta-member");
    const res = await app.request(`/admin/agents/${AGENT_ID}/envs`, {
      method: "POST",
      body: form,
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(302);
    expect(upsertCalledWith.length).toBeGreaterThan(0);
  });

  it("/admin/chat?agentId=<unrelated agent> returns 403 for an Okta-authenticated non-member", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "okta-sub-member",
      OKTA_MEMBER_EMAIL,
      false,
    );
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/chat?agentId=not-my-agent", {
      headers: { Cookie: `admin_session=${memberCookie}` },
    });
    expect(res.status).toBe(403);
  });
});

// ─── Web Push routes (CFB-4.2) ─────────────────────────────────────────────

const PUSH_WEBHOOK_TOKEN = "test-push-webhook-token";
const PUSH_SUBSCRIPTION_BODY = {
  endpoint: "https://push.example.com/sub-1",
  p256dh: "test-p256dh-key",
  auth: "test-auth-secret",
};

function makeFakePushService(
  notifyThreadReply: (thread: {
    threadId: string;
    agentId: string;
    title: string | null;
    preview: string | null;
  }) => Promise<{ delivered: number; pruned: number }> = async () => ({
    delivered: 0,
    pruned: 0,
  }),
  subscribe: (
    userEmail: string,
    endpoint: string,
    p256dh: string,
    auth: string,
  ) => Promise<
    { ok: true } | { ok: false; reason: "unavailable" | "store_failed" }
  > = async () => ({ ok: true }),
  unsubscribe: (
    userEmail: string,
    endpoint: string,
  ) => Promise<
    { ok: true } | { ok: false; reason: "unavailable" }
  > = async () => ({ ok: true }),
): PushService {
  return {
    notifyThreadReply,
    subscribe,
    unsubscribe,
  } as unknown as PushService;
}

describe("admin UI — POST /admin/chat/:agentId/push/subscribe", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("returns 503 when push is not enabled", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/subscribe`, {
      method: "POST",
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push_disabled" });
  });

  it("returns 403 for a non-admin session", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/subscribe`, {
      method: "POST",
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${memberCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when the body is missing required fields", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/subscribe`, {
      method: "POST",
      body: JSON.stringify({ endpoint: "https://push.example.com/sub-1" }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("upserts the subscription and returns ok:true when push is enabled", async () => {
    let subscribeCalledWith: unknown;
    const deps = makeMockDeps({
      pushService: makeFakePushService(undefined, async (...args) => {
        subscribeCalledWith = args;
        return { ok: true };
      }),
      vapidPublicKey: "test-vapid-public-key",
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/subscribe`, {
      method: "POST",
      body: JSON.stringify(PUSH_SUBSCRIPTION_BODY),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(subscribeCalledWith).toBeDefined();
  });
});

describe("admin UI — POST /admin/chat/:agentId/push/unsubscribe", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await makeSessionCookie();
  });

  it("returns 503 when push is not enabled", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/unsubscribe`, {
      method: "POST",
      body: JSON.stringify({ endpoint: PUSH_SUBSCRIPTION_BODY.endpoint }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push_disabled" });
  });

  it("returns 403 for a non-admin session", async () => {
    const memberCookie = await makeSessionCookie(
      SESSION_SECRET,
      "google-sub-member",
      "member@example.com",
      false,
    );
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/unsubscribe`, {
      method: "POST",
      body: JSON.stringify({ endpoint: PUSH_SUBSCRIPTION_BODY.endpoint }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${memberCookie}`,
      },
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when the body is missing the endpoint", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/unsubscribe`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("deletes the caller's subscription and returns ok:true when push is enabled", async () => {
    let unsubscribeCalledWith: unknown;
    const deps = makeMockDeps({
      pushService: makeFakePushService(
        undefined,
        undefined,
        async (...args) => {
          unsubscribeCalledWith = args;
          return { ok: true };
        },
      ),
      vapidPublicKey: "test-vapid-public-key",
    });
    const app = createAdminUIApp(deps);
    const res = await app.request(`/admin/chat/${AGENT_ID}/push/unsubscribe`, {
      method: "POST",
      body: JSON.stringify({ endpoint: PUSH_SUBSCRIPTION_BODY.endpoint }),
      headers: {
        "Content-Type": "application/json",
        Cookie: `admin_session=${cookie}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(unsubscribeCalledWith).toBeDefined();
  });
});

describe("admin UI — POST /admin/push/notify", () => {
  it("returns 503 when push is not enabled (no pushService/token configured)", async () => {
    const app = createAdminUIApp(makeMockDeps());
    const res = await app.request("/admin/push/notify", {
      method: "POST",
      body: JSON.stringify({ threadId: "thread-1", agentId: AGENT_ID }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "push_disabled" });
  });

  it("returns 401 when the bearer token does not match", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
      pushWebhookToken: PUSH_WEBHOOK_TOKEN,
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/push/notify", {
      method: "POST",
      body: JSON.stringify({ threadId: "thread-1", agentId: AGENT_ID }),
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer wrong-token",
      },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 400 when the body is missing threadId or agentId", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(),
      vapidPublicKey: "test-vapid-public-key",
      pushWebhookToken: PUSH_WEBHOOK_TOKEN,
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/push/notify", {
      method: "POST",
      body: JSON.stringify({ threadId: "thread-1" }),
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${PUSH_WEBHOOK_TOKEN}`,
      },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request" });
  });

  it("returns ok:true with delivered/pruned counts on a valid request", async () => {
    const deps = makeMockDeps({
      pushService: makeFakePushService(async () => ({
        delivered: 2,
        pruned: 1,
      })),
      vapidPublicKey: "test-vapid-public-key",
      pushWebhookToken: PUSH_WEBHOOK_TOKEN,
    });
    const app = createAdminUIApp(deps);
    const res = await app.request("/admin/push/notify", {
      method: "POST",
      body: JSON.stringify({
        threadId: "thread-1",
        agentId: AGENT_ID,
        title: "Agent replied",
        preview: "Here's the answer...",
      }),
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${PUSH_WEBHOOK_TOKEN}`,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      delivered: 2,
      pruned: 1,
    });
  });
});

// ─── SSP-4.3: agent-access holders manage their agent when self-serve is on ──

describe("admin UI — self-serve agent management (SSP-4.3)", () => {
  const HOLDER = "holder@example.com";
  const selfServe = (enabled: boolean) => ({
    enabled,
    defaultMaxAgents: 1,
    contactEmail: "ops@example.com",
  });
  const scopedTo = (agentIds: string[]) => async () => ({
    kind: "scoped" as const,
    accountId: "acct-a",
    agentIds,
  });
  const holderCookie = () =>
    makeSessionCookie(SESSION_SECRET, "google-sub-holder", HOLDER, false);
  const form = (fields: Record<string, string>) => ({
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  const routes: Array<[string, Record<string, string>]> = [
    ["settings", { restrictSlackToMembers: "true" }],
    ["members", { email: "new@example.com" }],
    ["members/delete", { memberId: "m1" }],
    ["delete", {}],
  ];

  for (const [path, fields] of routes) {
    it(`flag on: access holder is not blocked on POST /admin/agents/:id/${path}`, async () => {
      const cookie = await holderCookie();
      const app = createAdminUIApp(
        makeMockDeps({
          selfServe: selfServe(true),
          callerScopeResolver: scopedTo([AGENT_ID]),
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}/${path}`, {
        ...form(fields),
        headers: {
          ...form(fields).headers,
          Cookie: `admin_session=${cookie}`,
        },
      });
      expect(res.status).not.toBe(403);
    });

    it(`flag on: user without access gets 403 on POST /admin/agents/:id/${path}`, async () => {
      const cookie = await holderCookie();
      const app = createAdminUIApp(
        makeMockDeps({
          selfServe: selfServe(true),
          callerScopeResolver: scopedTo(["some-other-agent"]),
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}/${path}`, {
        ...form(fields),
        headers: {
          ...form(fields).headers,
          Cookie: `admin_session=${cookie}`,
        },
      });
      expect(res.status).toBe(403);
    });

    it(`flag off: access holder gets 403 on POST /admin/agents/:id/${path} (regression)`, async () => {
      const cookie = await holderCookie();
      const app = createAdminUIApp(
        makeMockDeps({
          selfServe: selfServe(false),
          callerScopeResolver: scopedTo([AGENT_ID]),
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}/${path}`, {
        ...form(fields),
        headers: {
          ...form(fields).headers,
          Cookie: `admin_session=${cookie}`,
        },
      });
      expect(res.status).toBe(403);
    });
  }

  for (const [enabled, shown] of [
    [true, true],
    [false, false],
  ] as const) {
    it(`agent detail for an access holder ${shown ? "renders" : "hides"} Danger Zone / Slack access / Members cards when flag is ${enabled ? "on" : "off"}`, async () => {
      const cookie = await holderCookie();
      const app = createAdminUIApp(
        makeMockDeps({
          selfServe: selfServe(enabled),
          callerScopeResolver: scopedTo([AGENT_ID]),
        }),
      );
      const res = await app.request(`/admin/agents/${AGENT_ID}`, {
        headers: { Cookie: `admin_session=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html.includes("Danger Zone")).toBe(shown);
      expect(html.includes('<div class="card-title">Slack access</div>')).toBe(
        shown,
      );
      expect(html.includes(`/admin/agents/${AGENT_ID}/members`)).toBe(shown);
    });
  }
});

describe("admin UI — Anthropic federation credential guards (WIF-2.1)", () => {
  const FED_COOKIE_AGENT = "agent-test-123";

  async function cookieHeader(): Promise<string> {
    const token = await sign(
      {
        isAdmin: true,
        userId: "user-123",
        email: "admin@example.com",
        name: "Admin User",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      "test-admin-session-secret-32-bytes!",
      "HS256",
    );
    return `admin_session=${token}`;
  }

  it("env editor shows the blocked-credentials error instead of a 500", async () => {
    const deps = makeMockDeps({
      agentEnvService: {
        getByAgentId: async () => null,
        upsert: async () => {},
        patch: async () => {
          throw new AnthropicCredentialsBlockedError(["ANTHROPIC_API_KEY"]);
        },
        deleteKey: async () => {},
        getConfigBundle: async () => null,
      },
    });
    const app = createAdminUIApp(deps);
    const form = new FormData();
    form.append("key", "ANTHROPIC_API_KEY");
    form.append("value", "sk-ant-secret");
    const res = await app.request(`/admin/agents/${FED_COOKIE_AGENT}/envs`, {
      method: "POST",
      body: form,
      headers: { Cookie: await cookieHeader() },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain(`/admin/agents/${FED_COOKIE_AGENT}?error=`);
    expect(decodeURIComponent(location)).toContain(
      "anthropic_credentials_blocked_federation",
    );
    expect(location).not.toContain("sk-ant-secret");
  });

  it("new-agent form omits the Claude credential fields under federation", async () => {
    const app = createAdminUIApp({
      ...makeMockDeps(),
      anthropicFederationEnabled: true,
    });
    const res = await app.request("/admin/agents/new", {
      headers: { Cookie: await cookieHeader() },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('name="claudeCodeOauthToken"');
  });
});
