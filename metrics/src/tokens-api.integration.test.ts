/**
 * metrics/src/tokens-api.integration.test.ts
 * Integration tests for GET /metrics/tokens endpoint.
 * Uses mock PostHogClientLike — no live PostHog calls.
 */

import { describe, expect, test } from "bun:test";
import { type MetricsDeps, createMetricsApp } from "./api.ts";
import type { AccountsClient, CronJobRecord, UserRecord } from "./lib/accounts-client.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { makeAccountsClientMock } from "./lib/test-helpers.ts";
import type { HogQLResult } from "./types.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADMIN_KEY = "sk_admin_metrics_tokens";
const apiKeys = parseApiKeys(`admin:${ADMIN_KEY}:*`);

function authHeader(key: string) {
  return { Authorization: `Bearer ${key}` };
}

/** Make a minimal HogQLResult */
function makeResult(columns: string[], rows: unknown[][]): HogQLResult {
  return { columns, results: rows, types: [] };
}

/** Minimal mock PostHogClientLike that returns different results per query content */
function makeMockClient(
  totalsResult: HogQLResult,
  bySessionTypeResult: HogQLResult,
  byAgentResult: HogQLResult,
  trendsResult: HogQLResult,
  byAgentBySessionTypeResult?: HogQLResult,
  byAgentByCronResult?: HogQLResult,
  byAgentByModelResult?: HogQLResult,
) {
  return {
    query: async (hogql: string): Promise<HogQLResult> => {
      // More specific patterns first to avoid GROUP BY agent_id ambiguity
      if (hogql.includes("agent_id, session_type"))
        return (
          byAgentBySessionTypeResult ??
          makeResult(byAgentBySessionTypeColumns, [])
        );
      if (
        hogql.includes("agent_id, cron_name") ||
        hogql.includes("isNotNull(properties.cron_name)")
      )
        return byAgentByCronResult ?? makeResult(byAgentByCronColumns, []);
      if (hogql.includes("agent_id, model"))
        return byAgentByModelResult ?? makeResult(byAgentByModelColumns, []);
      if (hogql.includes("GROUP BY session_type")) return bySessionTypeResult;
      if (
        hogql.includes("GROUP BY agent_id") &&
        !hogql.includes("session_type") &&
        !hogql.includes("cron_name") &&
        !hogql.includes(", model")
      )
        return byAgentResult;
      if (hogql.includes("GROUP BY period")) return trendsResult;
      return totalsResult;
    },
  };
}

// ─── Fixture data ─────────────────────────────────────────────────────────────

const totalsColumns = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
  "cost_usd",
];
const totalsRow = [1000, 500, 200, 100, 1800, 0.5];

const bySessionTypeColumns = [
  "session_type",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
  "cost_usd",
];
const bySessionTypeRows = [
  ["slack_dm", 400, 200, 80, 40, 720, 0.2],
  ["cron", 600, 300, 120, 60, 1080, 0.3],
];

const byAgentColumns = [
  "agent_id",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
  "cost_usd",
];
const byAgentRows = [["agent-abc123", 1000, 500, 200, 100, 1800, 0.5]];

const trendsColumns = [
  "period",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
  "cost_usd",
];
const trendsRows = [
  ["2026-04-01", 300, 150, 60, 30, 540, 0.15],
  ["2026-04-02", 700, 350, 140, 70, 1260, 0.35],
];

const byAgentBySessionTypeColumns = [
  "agent_id",
  "session_type",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
  "cost_usd",
];
const byAgentBySessionTypeRows = [
  ["agent-abc123", "slack_dm", 400, 200, 80, 40, 720, 0.2],
  ["agent-abc123", "cron", 600, 300, 120, 60, 1080, 0.3],
];

const byAgentByCronColumns = [
  "agent_id",
  "cron_name",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
  "cost_usd",
];
const byAgentByCronRows = [
  ["agent-abc123", "daily-report", 600, 300, 120, 60, 1080, 0.3],
];

const byAgentByModelColumns = [
  "agent_id",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "total_tokens",
  "cost_usd",
];
const byAgentByModelRows = [
  ["agent-abc123", "claude-sonnet-4-6", 700, 350, 140, 70, 1260, 0.35],
  ["agent-abc123", "claude-opus-4-6", 300, 150, 60, 30, 540, 0.15],
];

function makeTestApp(
  accountsClient: AccountsClient = makeAccountsClientMock(async () => []),
  deps?: Partial<MetricsDeps>,
) {
  const postHogClient = makeMockClient(
    makeResult(totalsColumns, [totalsRow]),
    makeResult(bySessionTypeColumns, bySessionTypeRows),
    makeResult(byAgentColumns, byAgentRows),
    makeResult(trendsColumns, trendsRows),
    makeResult(byAgentBySessionTypeColumns, byAgentBySessionTypeRows),
    makeResult(byAgentByCronColumns, byAgentByCronRows),
    makeResult(byAgentByModelColumns, byAgentByModelRows),
  );
  return createMetricsApp(apiKeys, accountsClient, { postHogClient, ...deps });
}

// ─── GET /metrics/tokens — auth ───────────────────────────────────────────────

describe("GET /metrics/tokens — auth", () => {
  test("returns 401 without auth header", async () => {
    const app = makeTestApp();
    const res = await app.request("/metrics/tokens?preset=7d");
    expect(res.status).toBe(401);
  });

  test("returns 401 with invalid token", async () => {
    const app = makeTestApp();
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader("wrong-key"),
    });
    expect(res.status).toBe(401);
  });

  test("returns 200 with valid admin token", async () => {
    const app = makeTestApp();
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
  });
});

// ─── GET /metrics/tokens — happy path ────────────────────────────────────────

describe("GET /metrics/tokens?preset=7d — happy path", () => {
  test("returns 200 with correct response schema", async () => {
    const app = makeTestApp();
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // Top-level structure
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("meta");

    // data.totals
    expect(body.data).toHaveProperty("totals");
    expect(body.data.totals.input).toBe(1000);
    expect(body.data.totals.output).toBe(500);
    expect(body.data.totals.cacheRead).toBe(200);
    expect(body.data.totals.cacheCreation).toBe(100);
    expect(body.data.totals.total).toBe(1800);
    expect(body.data.totals.cost).toBe(0.5);

    // data.bySessionType
    expect(body.data).toHaveProperty("bySessionType");
    expect(Array.isArray(body.data.bySessionType)).toBe(true);
    expect(body.data.bySessionType).toHaveLength(2);
    expect(body.data.bySessionType[0].sessionType).toBe("slack_dm");
    expect(body.data.bySessionType[0].input).toBe(400);
    expect(body.data.bySessionType[0].output).toBe(200);
    expect(body.data.bySessionType[0].cacheRead).toBe(80);
    expect(body.data.bySessionType[0].cacheCreation).toBe(40);
    expect(body.data.bySessionType[0].total).toBe(720);
    expect(body.data.bySessionType[0].cost).toBe(0.2);

    // data.byAgent
    expect(body.data).toHaveProperty("byAgent");
    expect(Array.isArray(body.data.byAgent)).toBe(true);
    expect(body.data.byAgent).toHaveLength(1);
    expect(body.data.byAgent[0].agentId).toBe("agent-abc123");
    expect(body.data.byAgent[0].input).toBe(1000);
    expect(body.data.byAgent[0].output).toBe(500);
    expect(body.data.byAgent[0].cacheRead).toBe(200);
    expect(body.data.byAgent[0].cacheCreation).toBe(100);
    expect(body.data.byAgent[0].total).toBe(1800);
    expect(body.data.byAgent[0].cost).toBe(0.5);

    // data.trends
    expect(body.data).toHaveProperty("trends");
    expect(Array.isArray(body.data.trends)).toBe(true);
    expect(body.data.trends).toHaveLength(2);
    expect(body.data.trends[0].date).toBe("2026-04-01");
    expect(body.data.trends[0].input).toBe(300);
    expect(body.data.trends[0].output).toBe(150);
    expect(body.data.trends[0].cacheRead).toBe(60);
    expect(body.data.trends[0].cacheCreation).toBe(30);
    expect(body.data.trends[0].total).toBe(540);
    expect(body.data.trends[0].cost).toBe(0.15);
    expect(body.data.trends[1].date).toBe("2026-04-02");

    // data.byAgentSessionType
    expect(body.data).toHaveProperty("byAgentSessionType");
    expect(Array.isArray(body.data.byAgentSessionType)).toBe(true);
    expect(body.data.byAgentSessionType).toHaveLength(2);
    expect(body.data.byAgentSessionType[0].agentId).toBe("agent-abc123");
    expect(body.data.byAgentSessionType[0].sessionType).toBe("slack_dm");
    expect(body.data.byAgentSessionType[0].input).toBe(400);
    expect(body.data.byAgentSessionType[0].total).toBe(720);
    expect(body.data.byAgentSessionType[0].cost).toBe(0.2);

    // data.byAgentCron
    expect(body.data).toHaveProperty("byAgentCron");
    expect(Array.isArray(body.data.byAgentCron)).toBe(true);
    expect(body.data.byAgentCron).toHaveLength(1);
    expect(body.data.byAgentCron[0].agentId).toBe("agent-abc123");
    expect(body.data.byAgentCron[0].cronName).toBe("daily-report");
    expect(body.data.byAgentCron[0].input).toBe(600);
    expect(body.data.byAgentCron[0].total).toBe(1080);
    expect(body.data.byAgentCron[0].cost).toBe(0.3);

    // data.byAgentModel
    expect(body.data).toHaveProperty("byAgentModel");
    expect(Array.isArray(body.data.byAgentModel)).toBe(true);
    expect(body.data.byAgentModel).toHaveLength(2);
    expect(body.data.byAgentModel[0].agentId).toBe("agent-abc123");
    expect(body.data.byAgentModel[0].model).toBe("claude-sonnet-4-6");
    expect(body.data.byAgentModel[0].input).toBe(700);
    expect(body.data.byAgentModel[0].total).toBe(1260);
    expect(body.data.byAgentModel[0].cost).toBe(0.35);

    // meta
    expect(body.meta).toHaveProperty("dateRange");
    expect(body.meta.dateRange).toHaveProperty("from");
    expect(body.meta.dateRange).toHaveProperty("to");
    expect(body.meta).toHaveProperty("generatedAt");
    expect(typeof body.meta.queryTimeMs).toBe("number");
  });

  test("defaults to 7d preset when no preset param given", async () => {
    const app = makeTestApp();
    const res = await app.request("/metrics/tokens", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.total).toBe(1800);
  });
});

// ─── GET /metrics/tokens — preset variants ────────────────────────────────────

describe("GET /metrics/tokens — preset variants", () => {
  const presets = ["today", "7d", "30d", "90d"] as const;

  for (const preset of presets) {
    test(`preset=${preset} returns 200`, async () => {
      const app = makeTestApp();
      const res = await app.request(`/metrics/tokens?preset=${preset}`, {
        headers: authHeader(ADMIN_KEY),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.totals).toBeDefined();
    });
  }
});

// ─── GET /metrics/tokens — custom date range ─────────────────────────────────

describe("GET /metrics/tokens — custom date range", () => {
  test("from+to params return 200", async () => {
    const app = makeTestApp();
    const res = await app.request(
      "/metrics/tokens?from=2026-04-01&to=2026-04-07",
      { headers: authHeader(ADMIN_KEY) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals).toBeDefined();
  });

  test("from without to returns 400", async () => {
    const app = makeTestApp();
    const res = await app.request("/metrics/tokens?from=2026-04-01", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(400);
  });

  test("to without from returns 400", async () => {
    const app = makeTestApp();
    const res = await app.request("/metrics/tokens?to=2026-04-07", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(400);
  });
});

// ─── GET /metrics/tokens — empty results ─────────────────────────────────────

describe("GET /metrics/tokens — empty results", () => {
  test("empty PostHog results return zero totals and empty arrays", async () => {
    const emptyClient = makeMockClient(
      makeResult(totalsColumns, []),
      makeResult(bySessionTypeColumns, []),
      makeResult(byAgentColumns, []),
      makeResult(trendsColumns, []),
      makeResult(byAgentBySessionTypeColumns, []),
      makeResult(byAgentByCronColumns, []),
      makeResult(byAgentByModelColumns, []),
    );
    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientMock(async () => []),
      { postHogClient: emptyClient },
    );
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.input).toBe(0);
    expect(body.data.totals.output).toBe(0);
    expect(body.data.totals.cacheRead).toBe(0);
    expect(body.data.totals.cacheCreation).toBe(0);
    expect(body.data.totals.total).toBe(0);
    expect(body.data.bySessionType).toHaveLength(0);
    expect(body.data.byAgent).toHaveLength(0);
    expect(body.data.trends).toHaveLength(0);
    // New fields must be empty arrays, not 500
    expect(body.data.byAgentSessionType).toHaveLength(0);
    expect(body.data.byAgentCron).toHaveLength(0);
    expect(body.data.byAgentModel).toHaveLength(0);
  });
});

// ─── GET /metrics/tokens — cost=0 when cost_usd missing ─────────────────────

describe("GET /metrics/tokens — cost is 0 when cost_usd is absent", () => {
  test("cost defaults to 0 for totals, bySessionType, byAgent, trends when cost_usd column is missing", async () => {
    // Simulate pre-deploy historical events that don't have cost_usd
    const legacyTotalsColumns = [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
    ];
    const legacyBySessionTypeColumns = [
      "session_type",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
    ];
    const legacyByAgentColumns = [
      "agent_id",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
    ];
    const legacyTrendsColumns = [
      "period",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "total_tokens",
    ];

    const legacyClient = makeMockClient(
      makeResult(legacyTotalsColumns, [[1000, 500, 200, 100, 1800]]),
      makeResult(legacyBySessionTypeColumns, [["slack_dm", 400, 200, 80, 40, 720]]),
      makeResult(legacyByAgentColumns, [["agent-abc123", 1000, 500, 200, 100, 1800]]),
      makeResult(legacyTrendsColumns, [["2026-04-01", 300, 150, 60, 30, 540]]),
    );

    const app = createMetricsApp(
      apiKeys,
      makeAccountsClientMock(async () => []),
      { postHogClient: legacyClient },
    );
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.cost).toBe(0);
    expect(body.data.bySessionType[0].cost).toBe(0);
    expect(body.data.byAgent[0].cost).toBe(0);
    expect(body.data.trends[0].cost).toBe(0);
  });
});

// ─── GET /metrics/tokens — agent name resolution ──────────────────────────────

describe("GET /metrics/tokens — agent name resolution", () => {
  test("populates agentName when accountsClient returns a matching user", async () => {
    const accountsClient = makeAccountsClientMock(async () => [
      {
        id: "agent-abc123",
        name: "Bodhi",
        email: "bodhi@example.com",
        slackId: null,
        role: "AGENT" as const,
        workingHoursStart: "09:00",
        workingHoursEnd: "17:00",
        timezone: "America/Los_Angeles",
        mercuryCounterparty: null,
        ownerUserId: null,
        clientId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const app = makeTestApp(accountsClient);
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.byAgent).toHaveLength(1);
    expect(body.data.byAgent[0].agentId).toBe("agent-abc123");
    expect(body.data.byAgent[0].agentName).toBe("Bodhi");
  });

  test("omits agentName (undefined) when no user matches the agent ID", async () => {
    const accountsClient = makeAccountsClientMock(async () => [
      {
        id: "some-other-id",
        name: "Other",
        email: "other@example.com",
        slackId: null,
        role: "AGENT" as const,
        workingHoursStart: "09:00",
        workingHoursEnd: "17:00",
        timezone: "America/Los_Angeles",
        mercuryCounterparty: null,
        ownerUserId: null,
        clientId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const app = makeTestApp(accountsClient);
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.byAgent[0].agentName).toBeUndefined();
  });

  test("returns 200 with no agentName when accountsClient.listUsers() throws", async () => {
    const accountsClient = makeAccountsClientMock(async () => {
      throw new Error("accounts service unavailable");
    });
    const app = makeTestApp(accountsClient);
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Response still returns data; agentName is absent (fallback gracefully)
    expect(body.data.byAgent).toHaveLength(1);
    expect(body.data.byAgent[0].agentId).toBe("agent-abc123");
    expect(body.data.byAgent[0].agentName).toBeUndefined();
  });
});

// ─── GET /metrics/tokens — cron name resolution ───────────────────────────────

describe("GET /metrics/tokens — cron name resolution", () => {
  const CRON_ID = "cmq000cron0001abc";

  function makeCronPostHogClient(cronName: string) {
    return makeMockClient(
      makeResult(totalsColumns, [totalsRow]),
      makeResult(bySessionTypeColumns, bySessionTypeRows),
      makeResult(byAgentColumns, byAgentRows),
      makeResult(trendsColumns, trendsRows),
      makeResult(byAgentBySessionTypeColumns, byAgentBySessionTypeRows),
      makeResult(byAgentByCronColumns, [
        ["agent-abc123", cronName, 600, 300, 120, 60, 1080, 0.3],
      ]),
      makeResult(byAgentByModelColumns, byAgentByModelRows),
    );
  }

  function makeClientWithCrons(
    impl: (agentId: string) => Promise<CronJobRecord[]>,
  ): AccountsClient {
    return {
      ...makeAccountsClientMock(async () => []),
      listAgentCronJobs: impl,
    };
  }

  test("resolves cron ID to job.name when name is set", async () => {
    const app = createMetricsApp(
      apiKeys,
      makeClientWithCrons(async () => [
        { id: CRON_ID, name: "daily-report", prompt: "Run the daily report" },
      ]),
      { postHogClient: makeCronPostHogClient(CRON_ID) },
    );
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.byAgentCron[0].cronName).toBe("daily-report");
  });

  test("truncates prompt when name is null and prompt exceeds 40 chars", async () => {
    // 57-char prompt; slice(0,40) = "Check the task store for new items now. "
    // trim() removes trailing space → "Check the task store for new items now."
    const longPrompt =
      "Check the task store for new items now. Then process them";
    const app = createMetricsApp(
      apiKeys,
      makeClientWithCrons(async () => [
        { id: CRON_ID, name: null, prompt: longPrompt },
      ]),
      { postHogClient: makeCronPostHogClient(CRON_ID) },
    );
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.byAgentCron[0].cronName).toBe(
      "Check the task store for new items now.…",
    );
  });

  test("uses full prompt when name is null and prompt is short", async () => {
    const shortPrompt = "Run the daily report";
    const app = createMetricsApp(
      apiKeys,
      makeClientWithCrons(async () => [
        { id: CRON_ID, name: null, prompt: shortPrompt },
      ]),
      { postHogClient: makeCronPostHogClient(CRON_ID) },
    );
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.byAgentCron[0].cronName).toBe(shortPrompt);
  });

  test("falls back to raw cron ID when listAgentCronJobs throws", async () => {
    const app = createMetricsApp(
      apiKeys,
      makeClientWithCrons(async () => {
        throw new Error("admin unavailable");
      }),
      { postHogClient: makeCronPostHogClient(CRON_ID) },
    );
    const res = await app.request("/metrics/tokens?preset=7d", {
      headers: authHeader(ADMIN_KEY),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.byAgentCron[0].cronName).toBe(CRON_ID);
  });
});
