/**
 * metrics/src/select-provider.ts
 * Pure mode selector mapping the process environment to a provider mode.
 * Kept side-effect-free so server.ts wiring is fully unit-testable.
 */

/** The four read-backend modes the server can run in. */
export type ProviderMode = "fixtures" | "taskstore" | "postgres" | "sqlite";

/**
 * Minimal env shape the selector reads (subset of process.env). The index
 * signature keeps `process.env` (ProcessEnv) assignable while documenting the
 * keys actually consumed.
 */
export interface ProviderEnv {
  METRICS_OFFLINE?: string;
  /** Base URL of the Shipwright task-store service (read-only tasks + PRs). */
  METRICS_TASK_STORE_URL?: string;
  /** Base URL of the admin service (token-aggregation stats endpoints). */
  METRICS_ADMIN_URL?: string;
  /** Postgres connection URL for the metrics event store. */
  METRICS_DATABASE_URL?: string;
  /** Alias for METRICS_DATABASE_URL (accepted for symmetry with other services). */
  DATABASE_URL_METRICS?: string;
  [key: string]: string | undefined;
}

/**
 * Select the provider mode from env, in priority order:
 *   1. METRICS_OFFLINE === "true"                         → fixtures
 *   2. METRICS_TASK_STORE_URL + METRICS_ADMIN_URL both
 *      http(s)                                            → taskstore
 *   3. METRICS_DATABASE_URL (or DATABASE_URL_METRICS)
 *      starts with "postgres"                             → postgres
 *   4. otherwise                                          → sqlite (default-local)
 *
 * Precedence rationale: offline/fixtures wins for local dev (no credentials
 * needed); taskstore wins when both upstream service URLs are configured (the
 * live task-store + admin pipeline); Postgres wins when a database URL is
 * supplied (self-hosted event store); SQLite is the safe default that works
 * with zero configuration.
 */
export function selectProviderMode(env: ProviderEnv): ProviderMode {
  if (env.METRICS_OFFLINE === "true") return "fixtures";

  const hasTaskStore =
    env.METRICS_TASK_STORE_URL?.startsWith("http") === true &&
    env.METRICS_ADMIN_URL?.startsWith("http") === true;
  if (hasTaskStore) return "taskstore";

  const dbUrl =
    env.METRICS_DATABASE_URL?.trim() || env.DATABASE_URL_METRICS?.trim() || "";
  if (dbUrl.startsWith("postgres")) return "postgres";

  return "sqlite";
}

/**
 * Resolve the Postgres connection URL from env.
 * Returns the first non-empty value among METRICS_DATABASE_URL /
 * DATABASE_URL_METRICS, or undefined when neither is set.
 */
export function resolvePostgresUrl(env: ProviderEnv): string | undefined {
  const url =
    env.METRICS_DATABASE_URL?.trim() || env.DATABASE_URL_METRICS?.trim();
  return url || undefined;
}
