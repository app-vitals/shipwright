/**
 * metrics/src/api.auth-gate.integration.test.ts
 * Integration tests for SW-2.3: owner-gate optional, METRICS_DASHBOARD_TOKEN gate,
 * and toolbar/nav assertions.
 *
 * Uses app.request() — no real server, no PostHog network calls.
 */

import { describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import type { AccountsClient, UserRecord } from "./lib/accounts-client.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import type { HogQLResult } from "./types.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = "sk_admin_gate_test";
const SCOPED_KEY = "sk_scoped_gate_test";
const DASHBOARD_TOKEN = "dt_my_secret_dashboard_token";
const apiKeys = parseApiKeys(
  `admin:${ADMIN_KEY}:*,agent:${SCOPED_KEY}:client-xyz`,
);
const TEST_SESSION_SECRET = "test-session-secret-32-bytes-min";

/** No-op AccountsClient — listUsers returns empty, getUser returns OWNER by default */
const noopAccountsClient = makeAccountsClientMock(async () => []);

const summaryColumns = [
  "tasks_completed",
  "tasks_blocked",
  "avg_actual_hours",
  "avg_estimated_hours",
  "avg_retries",
  "avg_files_changed",
  "ci_gates_total",
  "ci_first_pass",
  "avg_fix_attempts",
  "simplify_total",
  "simplify_total_fixes",
  "simplify_avg_dry",
  "simplify_avg_dead_code",
  "simplify_avg_naming",
  "simplify_avg_complexity",
  "simplify_avg_consistency",
  "reviews_total",
  "reviews_ship_it",
  "complexity_1",
  "complexity_2",
  "complexity_3",
  "complexity_4",
  "complexity_5",
  "avg_fix_cascade_depth",
];

function makeResult(columns: string[], rows: unknown[][]): HogQLResult {
  return {
    columns,
    results: rows,
    types: [],
    hasMore: false,
    limit: 100,
    offset: 0,
  };
}

const mockSummaryResult = makeResult(summaryColumns, [
  [
    10, 2, 2.5, 3.0, 1.2, 5.0, 8, 6, 0.5, 4, 12, 3.1, 2.0, 1.5, 0.8, 1.0, 5, 4,
    2, 3, 4, 1, 0, 1.5,
  ],
]);

function authHeader(key: string): { Authorization: string } {
  return { Authorization: `Bearer ${key}` };
}

function makeAccountsClientStub(
  role: "OWNER" | "MEMBER" | "AGENT",
): AccountsClient {
  const user: UserRecord = {
    id: "user-123",
    email: "test@example.com",
    name: "Test User",
    role,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const notImpl = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  return {
    getUser: async (_id: string) => user,
    listUsers: async () => [],
    listAgents: async () => [],
    createUser: notImpl,
    updateUser: notImpl,
    listClients: async () => [],
    getClient: notImpl,
    createClient: notImpl,
    updateClient: notImpl,
    deleteClient: notImpl,
    listEngagements: async () => [],
    getEngagement: notImpl,
    createEngagement: notImpl,
    updateEngagement: notImpl,
    deleteEngagement: notImpl,
    listOAuthConnections: async () => [],
    getOAuthConnection: async () => null,
    deleteOAuthConnection: notImpl,
    getOAuthToken: notImpl,
    listConnections: async () => [],
    getConnectionToken: notImpl,
    getAgentEnv: notImpl,
    upsertAgentEnv: notImpl,
    patchAgentEnv: notImpl,
    getAgentConfigBundle: notImpl,
    listAgentEnvs: async () => [],
    createAgentToken: notImpl,
    getTeam: async () => null,
    listTeams: async () => [],
    listEnabledCronJobs: async () => [],
    listAgentCronJobs: async () => [],
    createAgentCronJob: notImpl,
    deleteAgentCronJob: notImpl,
    setAgentCronJobEnabled: notImpl,
    reconcileSystemCrons: async () => ({ created: 0, updated: 0, deleted: 0 }),
    validateAgentToken: async () => null,
  };
}

async function makeSessionCookie(
  secret: string = TEST_SESSION_SECRET,
): Promise<string> {
  const payload = {
    userId: "user-123",
    email: "test@example.com",
    name: "Test User",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  return sign(payload, secret, "HS256");
}

// ─── owner gate — off by default ─────────────────────────────────────────────

describe("owner gate — off by default", () => {
  test("MEMBER session → 200 on /metrics/summary when requireOwnerRole unset (default off)", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      // requireOwnerRole not set — defaults to off
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("MEMBER"),
      deps,
    );

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
  });

  test("AGENT session → 200 on /metrics/summary when requireOwnerRole unset (default off)", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("AGENT"),
      deps,
    );

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
  });

  test("OWNER session → 200 on /metrics/summary when requireOwnerRole unset (default off)", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("OWNER"),
      deps,
    );

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
  });

  test("dashboard serves with noopAccountsClient when requireOwnerRole unset", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
  });
});

// ─── owner gate — on when requireOwnerRole: true ──────────────────────────────

describe("owner gate — on when requireOwnerRole: true", () => {
  test("MEMBER session → 401 on /metrics/summary when requireOwnerRole: true", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      requireOwnerRole: true,
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("MEMBER"),
      deps,
    );

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test("OWNER session → 200 on /metrics/summary when requireOwnerRole: true", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      requireOwnerRole: true,
    };
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientStub("OWNER"),
      deps,
    );

    const res = await app.request("/metrics/summary", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
  });
});

// ─── METRICS_DASHBOARD_TOKEN gate ────────────────────────────────────────────

describe("METRICS_DASHBOARD_TOKEN gate", () => {
  test("with dashboardToken unset → existing admin bearer token → 200", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      // dashboardToken not set
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
  });

  test("with dashboardToken set → correct token → 200 on /metrics/summary", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      dashboardToken: DASHBOARD_TOKEN,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader(DASHBOARD_TOKEN),
    });

    expect(res.status).toBe(200);
  });

  test("with dashboardToken set → no auth → 401 on /metrics/summary", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      dashboardToken: DASHBOARD_TOKEN,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary");

    expect(res.status).toBe(401);
  });

  test("with dashboardToken set → wrong token → 401 on /metrics/summary", async () => {
    const deps: MetricsDeps = {
      postHogClient: { query: async () => mockSummaryResult },
      sessionSecret: TEST_SESSION_SECRET,
      dashboardToken: DASHBOARD_TOKEN,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/metrics/summary", {
      headers: authHeader("wrong_token_value"),
    });

    expect(res.status).toBe(401);
  });
});

// ─── dashboard HTML — no dead nav links ──────────────────────────────────────

describe("dashboard HTML — no dead nav links", () => {
  test("rendered HTML has no Cal/Time/Billing links", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    // Must not contain links to dead Cal/Time/Billing pages
    expect(html.toLowerCase()).not.toContain("calendar");
    expect(html.toLowerCase()).not.toContain("/cal");
    expect(html.toLowerCase()).not.toContain("/billing");
    expect(html.toLowerCase()).not.toContain("/time");
  });

  test("rendered HTML has no vitals-os platform links (/cal, /time, /billing)", async () => {
    const cookie = await makeSessionCookie();
    const deps: MetricsDeps = {
      sessionSecret: TEST_SESSION_SECRET,
    };
    const app = createMetricsApp(apiKeys, noopAccountsClient, deps);

    const res = await app.request("/dashboard", {
      headers: { Cookie: `admin_session=${cookie}` },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    // Check for platform-specific dead links
    expect(html).not.toMatch(/href=["'][^"']*\/cal["']/);
    expect(html).not.toMatch(/href=["'][^"']*\/time["']/);
    expect(html).not.toMatch(/href=["'][^"']*\/billing["']/);
  });
});
