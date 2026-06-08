/**
 * metrics/src/server.ts
 * Metrics API process entrypoint — standalone Bun server on port 3460.
 *
 * Serves:
 *   /metrics/*   — API endpoints (PostHog query results, auth-gated)
 *   /dashboard   — Server-rendered dashboard UI
 *   /health      — Health check (no auth required)
 *
 * Offline mode (METRICS_OFFLINE=true):
 *   - Skips the POSTHOG_* required-env gate
 *   - Injects a fixture PostHog client via deps.postHogClient
 *   - Bypasses session auth for /dashboard (serves as "Offline User")
 *   - Safe to run with no secrets or external services configured
 */

import { HttpAccountsClient } from "./lib/accounts-client.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { loadEnv, validateRequiredEnv } from "./lib/env.ts";
import { createMetricsApp } from "./api.ts";
import type { MetricsDeps } from "./api.ts";

loadEnv();

const offlineMode = process.env.METRICS_OFFLINE === "true";

if (!offlineMode) {
  validateRequiredEnv(["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"]);
}

const port = Number(process.env.METRICS_API_PORT ?? 3460);
const accountsClient = new HttpAccountsClient(
  process.env.METRICS_ACCOUNTS_URL ?? "http://localhost:3457",
  process.env.METRICS_INTERNAL_API_KEY ?? "",
);

let deps: MetricsDeps;

if (offlineMode) {
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
