/**
 * metrics/src/select-provider.ts
 * Pure mode selector mapping the process environment to a provider mode.
 * Kept side-effect-free so server.ts wiring is fully unit-testable.
 */

/** The three read-backend modes the server can run in. */
export type ProviderMode = "fixtures" | "posthog" | "sqlite";

/**
 * Minimal env shape the selector reads (subset of process.env). The index
 * signature keeps `process.env` (ProcessEnv) assignable while documenting the
 * keys actually consumed.
 */
export interface ProviderEnv {
  METRICS_OFFLINE?: string;
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
  [key: string]: string | undefined;
}

/**
 * Select the provider mode from env, in priority order:
 *   1. METRICS_OFFLINE === "true"            → fixtures
 *   2. both PostHog read keys non-empty      → posthog
 *   3. otherwise                             → sqlite (default-local)
 */
export function selectProviderMode(env: ProviderEnv): ProviderMode {
  if (env.METRICS_OFFLINE === "true") return "fixtures";

  const hasPostHog =
    typeof env.POSTHOG_PERSONAL_API_KEY === "string" &&
    env.POSTHOG_PERSONAL_API_KEY.length > 0 &&
    typeof env.POSTHOG_PROJECT_ID === "string" &&
    env.POSTHOG_PROJECT_ID.length > 0;
  if (hasPostHog) return "posthog";

  return "sqlite";
}
