/**
 * metrics/src/server.ts
 * Metrics API process entrypoint — standalone Bun server on port 3460.
 *
 * Serves:
 *   /metrics/*   — API endpoints (PostHog query results, auth-gated)
 *   /dashboard   — UI entrypoint (served by this process)
 *   /health      — Health check (no auth required)
 */

import { HttpAccountsClient } from "./lib/accounts-client.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { loadEnv, validateRequiredEnv } from "./lib/env.ts";
import { createMetricsApp } from "./api.ts";

loadEnv();
validateRequiredEnv(["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"]);

const port = Number(process.env.METRICS_API_PORT ?? 3460);
const accountsClient = new HttpAccountsClient(
  process.env.METRICS_ACCOUNTS_URL ?? "http://localhost:3457",
  process.env.METRICS_INTERNAL_API_KEY ?? "",
);
const app = createMetricsApp(
  parseApiKeys(process.env.METRICS_API_KEYS),
  accountsClient,
  {
    sessionSecret: process.env.SESSION_SECRET ?? "",
  },
);

// Health check — no auth required
app.get("/health", (c) => c.json({ status: "ok" }, 200));

// Dashboard entrypoint — returns a minimal redirect or placeholder
// The actual dashboard UI is served by the frontend build; this path
// is routed to this service at the ingress level.
app.get("/dashboard", (c) =>
  c.json({ service: "metrics-api", status: "ok" }, 200),
);

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
