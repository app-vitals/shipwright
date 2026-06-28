/**
 * metrics/src/select-provider.ts
 * Pure mode selector mapping the process environment to a provider mode.
 * Kept side-effect-free so server.ts wiring is fully unit-testable.
 */

/** The two read-backend modes the server can run in. */
export type ProviderMode = "fixtures" | "taskstore";

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
  [key: string]: string | undefined;
}

/**
 * Select the provider mode from env, in priority order:
 *   1. METRICS_OFFLINE === "true"                         → fixtures
 *   2. METRICS_TASK_STORE_URL + METRICS_ADMIN_URL both
 *      http(s)                                            → taskstore
 *   3. otherwise                                          → taskstore (default;
 *      server.ts will error out if the URLs are missing)
 *
 * Precedence rationale: offline/fixtures wins for local dev (no credentials
 * needed); taskstore is the only live backend.
 */
export function selectProviderMode(env: ProviderEnv): ProviderMode {
  if (env.METRICS_OFFLINE === "true") return "fixtures";

  const hasTaskStore =
    env.METRICS_TASK_STORE_URL?.startsWith("http") === true &&
    env.METRICS_ADMIN_URL?.startsWith("http") === true;
  if (hasTaskStore) return "taskstore";

  // Default: return taskstore so server.ts can provide a clear error when URLs
  // are not configured, rather than silently falling back to a removed backend.
  return "taskstore";
}
