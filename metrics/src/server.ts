/**
 * metrics/src/server.ts
 * Metrics API process entrypoint — standalone Bun server on port 3460.
 *
 * Serves:
 *   /metrics/*   — API endpoints (PostHog query results, auth-gated)
 *   /dashboard   — Server-rendered dashboard UI
 *   /health      — Health check (no auth required)
 *
 * Backend mode (pure selector — see select-provider.ts):
 *   METRICS_OFFLINE=true                  → fixtures (PostHogProvider over
 *                                            fixture client; auth bypassed)
 *   POSTHOG read-keys present             → posthog (live PostHogProvider)
 *   otherwise (DEFAULT)                   → sqlite  (SqliteProvider over the
 *                                            local store; POST /batch/ ingest)
 */

import { HttpAccountsClient } from "./lib/accounts-client.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { loadEnv } from "./lib/env.ts";
import { createMetricsApp } from "./api.ts";
import type { MetricsDeps } from "./api.ts";
import { createLocalEventStore } from "./local-store.ts";
import { SqliteProvider } from "./providers/sqlite-provider.ts";
import { selectProviderMode } from "./select-provider.ts";

loadEnv();

const mode = selectProviderMode(process.env);
const offlineMode = mode === "fixtures";

const port = Number(process.env.METRICS_API_PORT ?? 3460);
const accountsClient = new HttpAccountsClient(
  process.env.METRICS_ACCOUNTS_URL ?? "http://localhost:3457",
  process.env.METRICS_INTERNAL_API_KEY ?? "",
);

let deps: MetricsDeps;

if (mode === "fixtures") {
  const { createFixturePostHogClient } = await import(
    "./fixtures/posthog-fixtures.ts"
  );
  deps = {
    postHogClient: createFixturePostHogClient(),
    sessionSecret: "",
    requireOwnerRole: false,
    offlineMode: true,
  };
  console.log("[metrics-api] Running in OFFLINE mode — fixture data injected");
} else if (mode === "sqlite") {
  const store = createLocalEventStore({
    path: process.env.METRICS_DB_PATH ?? "state/metrics.db",
  });
  deps = {
    provider: new SqliteProvider(store),
    localStore: store,
    sessionSecret: process.env.SESSION_SECRET ?? "",
    requireOwnerRole: process.env.METRICS_REQUIRE_OWNER_ROLE === "true",
    dashboardToken: process.env.METRICS_DASHBOARD_TOKEN,
  };
  console.log(
    "[metrics-api] Running in LOCAL mode — SQLite provider + /batch/ ingest",
  );
} else {
  deps = {
    sessionSecret: process.env.SESSION_SECRET ?? "",
    requireOwnerRole: process.env.METRICS_REQUIRE_OWNER_ROLE === "true",
    dashboardToken: process.env.METRICS_DASHBOARD_TOKEN,
  };
}

const app = createMetricsApp(parseApiKeys(process.env.METRICS_API_KEYS), accountsClient, deps);

// OpenAPI doc for standalone mode
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
});
app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Vitals Metrics API",
    version: "1.0.0",
    description: "Metrics service — PostHog pipeline analytics and dashboard.",
  },
  security: [{ bearerAuth: [] }],
});

Bun.serve({ port, fetch: app.fetch });
console.log(`[metrics-api] Server running on :${port}`);
