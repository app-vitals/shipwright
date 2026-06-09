/**
 * metrics/src/select-provider.ts
 * Pure mode selector mapping the process environment to a provider mode.
 * Kept side-effect-free so server.ts wiring is fully unit-testable.
 */

/** The four read-backend modes the server can run in. */
export type ProviderMode = "fixtures" | "posthog" | "postgres" | "sqlite";

/**
 * Minimal env shape the selector reads (subset of process.env). The index
 * signature keeps `process.env` (ProcessEnv) assignable while documenting the
 * keys actually consumed.
 */
export interface ProviderEnv {
  METRICS_OFFLINE?: string;
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
  /** Postgres connection URL for the metrics event store. */
  METRICS_DATABASE_URL?: string;
  /** Alias for METRICS_DATABASE_URL (accepted for symmetry with other services). */
  DATABASE_URL_METRICS?: string;
  [key: string]: string | undefined;
}

/**
 * Select the provider mode from env, in priority order:
 *   1. METRICS_OFFLINE === "true"                         → fixtures
 *   2. both PostHog read keys non-empty                   → posthog
 *   3. METRICS_DATABASE_URL (or DATABASE_URL_METRICS)
 *      starts with "postgres"                             → postgres
 *   4. otherwise                                          → sqlite (default-local)
 *
 * Precedence rationale: offline/fixtures wins for local dev (no credentials
 * needed); PostHog wins when live data is configured (cloud prod); Postgres
 * wins when a database URL is supplied (self-hosted); SQLite is the safe
 * default that works with zero configuration.
 */
export function selectProviderMode(env: ProviderEnv): ProviderMode {
  if (env.METRICS_OFFLINE === "true") return "fixtures";

  const hasPostHog =
    typeof env.POSTHOG_PERSONAL_API_KEY === "string" &&
    env.POSTHOG_PERSONAL_API_KEY.length > 0 &&
    typeof env.POSTHOG_PROJECT_ID === "string" &&
    env.POSTHOG_PROJECT_ID.length > 0;
  if (hasPostHog) return "posthog";

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
