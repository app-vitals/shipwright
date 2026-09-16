/**
 * Metrics E2E test server — starts the metrics API on a test port.
 * No DB needed — metrics API calls are intercepted by Playwright route mocking;
 * the fixture provider satisfies the required provider seam without live services.
 */

import { createMetricsApp, createPublicMetricsApp } from "../src/api.ts";
import { createFixtureTaskStoreProvider } from "../src/fixtures/task-store-fixtures.ts";
import { parseApiKeys } from "../src/lib/api-auth.ts";
import { makeAccountsClientMock } from "../src/lib/test-helpers.ts";

const port = Number.parseInt(process.env.METRICS_E2E_PORT ?? "3461", 10);
const apiKeys = parseApiKeys("e2e:sk_e2e_test_key:*");
const sessionSecret =
  process.env.SHIPWRIGHT_SESSION_SECRET ?? "e2e-test-session-secret-32b";
const noopAccountsClient = makeAccountsClientMock(async () => []);
const app = createMetricsApp(apiKeys, noopAccountsClient, {
  sessionSecret,
  provider: createFixtureTaskStoreProvider(),
});

// Public, unauthenticated /public/* surface (mirrors server.ts's PUBLIC_MODE
// wiring) — scoped to a single repo so dashboard.e2e.ts can exercise the
// Merged PRs by repo panel's "public dashboard shows only the public repo"
// behavior (POM-2.2) against real fixture-computed data, not a route mock.
const publicProvider = createFixtureTaskStoreProvider("org/alpha");
const publicApp = createPublicMetricsApp(publicProvider);
app.route("/", publicApp);

app.get("/health", (c) => c.json({ status: "ok" }, 200));

Bun.serve({ port, fetch: app.fetch });
console.log(`[metrics-e2e] Server running on :${port}`);
