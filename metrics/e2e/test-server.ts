/**
 * Metrics E2E test server — starts the metrics API on a test port.
 * No DB needed — PostHog requests are intercepted by Playwright route mocking.
 */

import { createMetricsApp } from "../src/api.ts";
import { parseApiKeys } from "../src/lib/api-auth.ts";
import { makeAccountsClientMock } from "../src/lib/test-doubles.ts";

const port = Number.parseInt(process.env.METRICS_E2E_PORT ?? "3461", 10);
const apiKeys = parseApiKeys("e2e:sk_e2e_test_key:*");
const sessionSecret =
  process.env.SHIPWRIGHT_METRICS_SESSION_SECRET ?? "e2e-test-session-secret-32b";
const noopAccountsClient = makeAccountsClientMock(async () => []);
const app = createMetricsApp(apiKeys, noopAccountsClient, { sessionSecret });

app.get("/health", (c) => c.json({ status: "ok" }, 200));

Bun.serve({ port, fetch: app.fetch });
console.log(`[metrics-e2e] Server running on :${port}`);
