/**
 * metrics/src/server.ts
 * Metrics API process entrypoint — standalone Bun server on port 3460.
 *
 * Serves:
 *   /metrics/*   — API endpoints (query results, auth-gated)
 *   /dashboard   — Server-rendered dashboard UI
 *   /health      — Health check (no auth required)
 *
 * Backend mode (pure selector — see select-provider.ts):
 *
 *   Priority order (highest first):
 *   1. METRICS_OFFLINE=true                  → fixtures  (offline TaskStoreProvider
 *                                                         over recorded cassettes;
 *                                                         auth bypassed)
 *   2. METRICS_TASK_STORE_URL + METRICS_ADMIN_URL
 *      both http(s)                          → taskstore (live HttpTaskStoreClient +
 *                                                         HttpAdminMetricsClient)
 *   3. METRICS_DATABASE_URL / DATABASE_URL_METRICS
 *      starts with "postgres"               → postgres  (PostgresProvider; POST /batch/ ingest)
 *   4. otherwise (DEFAULT)                   → sqlite   (SqliteProvider; POST /batch/ ingest)
 *
 * Postgres mode wraps the shared SqlEventStoreProvider over a pg.Pool,
 * giving identical query semantics to SQLite mode.
 */

import { Hono } from "hono";
import { createMetricsApp } from "./api.ts";
import type { MetricsDeps } from "./api.ts";
import { HttpAccountsClient } from "./lib/accounts-client.ts";
import { parseApiKeys } from "./lib/api-auth.ts";
import { loadEnv } from "./lib/env.ts";
import { createLocalEventStore } from "./local-store.ts";
import { SqliteProvider } from "./providers/sqlite-provider.ts";
import { resolvePostgresUrl, selectProviderMode } from "./select-provider.ts";

loadEnv();

const mode = selectProviderMode(process.env);
const offlineMode = mode === "fixtures";

const port = Number(process.env.METRICS_API_PORT ?? 3460);
const basePath = process.env.METRICS_BASE_PATH ?? "";
// Local-dev auth bypass for /dashboard + /metrics/* (no login flow in `task stack`).
// Keeps the real provider — only relaxes auth. Never enable in production.
const dashboardDevAuth = process.env.METRICS_DASHBOARD_DEV_AUTH === "true";
if (dashboardDevAuth && process.env.NODE_ENV === "production") {
  console.error(
    "[metrics-api] FATAL: METRICS_DASHBOARD_DEV_AUTH cannot be enabled in production",
  );
  process.exit(1);
}

if (!process.env.METRICS_ADMIN_URL && process.env.METRICS_ACCOUNTS_URL) {
  console.warn(
    "[metrics-api] DEPRECATION: METRICS_ACCOUNTS_URL is deprecated — rename it to METRICS_ADMIN_URL. Support will be removed in a future release.",
  );
}
const accountsClient = new HttpAccountsClient(
  process.env.METRICS_ADMIN_URL ??
    process.env.METRICS_ACCOUNTS_URL ??
    "http://localhost:3000",
  process.env.METRICS_INTERNAL_API_KEY ?? "",
);

let deps: MetricsDeps;

if (mode === "fixtures") {
  const { createFixtureTaskStoreProvider } = await import(
    "./fixtures/task-store-fixtures.ts"
  );
  deps = {
    provider: createFixtureTaskStoreProvider(),
    sessionSecret: "",
    requireOwnerRole: false,
    offlineMode: true,
    basePath,
  };
  console.log("[metrics-api] Running in OFFLINE mode — fixture data injected");
} else if (mode === "taskstore") {
  const { HttpTaskStoreClient } = await import("./lib/task-store-client.ts");
  const { HttpAdminMetricsClient } = await import(
    "./lib/admin-metrics-client.ts"
  );
  const { TaskStoreProvider } = await import(
    "./providers/task-store-provider.ts"
  );
  const taskStoreClient = new HttpTaskStoreClient(
    process.env.METRICS_TASK_STORE_URL ?? "",
    process.env.METRICS_TASK_STORE_TOKEN ?? "",
  );
  const adminMetricsClient = new HttpAdminMetricsClient(
    process.env.METRICS_ADMIN_URL ?? "",
    process.env.METRICS_INTERNAL_API_KEY ?? "",
  );
  deps = {
    provider: new TaskStoreProvider(taskStoreClient, adminMetricsClient),
    sessionSecret: process.env.SHIPWRIGHT_SESSION_SECRET ?? "",
    requireOwnerRole: process.env.METRICS_REQUIRE_OWNER_ROLE === "true",
    dashboardToken: process.env.METRICS_DASHBOARD_TOKEN,
    dashboardDevAuth,
    basePath,
  };
  console.log(
    "[metrics-api] Running in TASKSTORE mode — TaskStoreProvider over task-store + admin APIs",
  );
  // NOTE: the `tokens*` metric kinds call the admin token-aggregation stats
  // endpoints (`/agents/:id/cron-runs/stats`, `/agents/chat-tokens/daily/stats`),
  // which are not implemented server-side until MME-4.2 — those kinds will throw
  // `AdminMetricsClientError` (404) in taskstore mode until then. The task/PR
  // -derived kinds (summary, trends, features, queue) are fully live.
} else if (mode === "postgres") {
  const pgUrl = resolvePostgresUrl(process.env);
  if (!pgUrl) {
    console.error(
      "[metrics-api] FATAL: postgres mode selected but no URL found in METRICS_DATABASE_URL / DATABASE_URL_METRICS",
    );
    process.exit(1);
  }
  const { createPostgresEventStore } = await import(
    "./providers/postgres-provider.ts"
  );
  const pgStore = await createPostgresEventStore(pgUrl);
  // Adapt PostgresEventStore.insertEvent (async) to the LocalEventStore interface
  // expected by MetricsDeps.localStore. LocalEventStore.insertEvent now returns
  // void | Promise<void>, so we can return the Promise directly — the POST /batch/
  // handler awaits it, giving callers exactly-once write semantics.
  const localStoreShim = {
    insertEvent: (
      e: Parameters<typeof pgStore.insertEvent>[0],
    ): Promise<void> => {
      return pgStore.insertEvent(e);
    },
    queryByEvent: () => [],
    close: () => {},
  };
  deps = {
    provider: pgStore.provider,
    localStore: localStoreShim,
    sessionSecret: process.env.SHIPWRIGHT_SESSION_SECRET ?? "",
    requireOwnerRole: process.env.METRICS_REQUIRE_OWNER_ROLE === "true",
    dashboardToken: process.env.METRICS_DASHBOARD_TOKEN,
    dashboardDevAuth,
    basePath,
  };
  console.log(
    "[metrics-api] Running in POSTGRES mode — PostgresProvider + /batch/ ingest",
  );
} else {
  const store = createLocalEventStore({
    path: process.env.METRICS_DB_PATH ?? "state/metrics.db",
  });
  deps = {
    provider: new SqliteProvider(store),
    localStore: store,
    sessionSecret: process.env.SHIPWRIGHT_SESSION_SECRET ?? "",
    requireOwnerRole: process.env.METRICS_REQUIRE_OWNER_ROLE === "true",
    dashboardToken: process.env.METRICS_DASHBOARD_TOKEN,
    dashboardDevAuth,
    basePath,
  };
  console.log(
    "[metrics-api] Running in LOCAL mode — SQLite provider + /batch/ ingest",
  );
}

const metricsApp = createMetricsApp(
  parseApiKeys(process.env.METRICS_API_KEYS),
  accountsClient,
  deps,
);

// OpenAPI doc for standalone mode
metricsApp.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
});
metricsApp.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Vitals Metrics API",
    version: "1.0.0",
    description:
      "Metrics service — task-store & pipeline analytics and dashboard.",
  },
  security: [{ bearerAuth: [] }],
});

// When METRICS_BASE_PATH is set, mount the app under that prefix so all routes
// (dashboard, metrics/*, static assets) are served at e.g. /sw/dashboard.
const serverApp = basePath
  ? new Hono().route(basePath, metricsApp)
  : metricsApp;

Bun.serve({ port, fetch: serverApp.fetch });
console.log(
  `[metrics-api] Server running on :${port}${basePath ? ` (base: ${basePath})` : ""}`,
);
