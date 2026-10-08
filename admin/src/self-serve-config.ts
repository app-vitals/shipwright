/**
 * admin/src/self-serve-config.ts
 *
 * Pure parser for the self-serve agent provisioning env config. Takes an
 * injected env object (no process.env reads) so it is deterministically
 * unit-testable; admin/src/main.ts reads it once at startup and injects the
 * resolved config as deps.
 */

export const DEFAULT_SELF_SERVE_CONTACT_EMAIL = "dan@app-vitals.com";

/** Structural env shape — accepts `process.env` or a plain test object. */
export type SelfServeEnv = Readonly<Record<string, string | undefined>>;

export interface SelfServeConfig {
  /** True only when SHIPWRIGHT_SELF_SERVE_ENABLED === "enabled". */
  enabled: boolean;
  /** Default per-account agent quota (integer >= 0). */
  defaultMaxAgents: number;
  /** Contact address shown when a user needs more quota. */
  contactEmail: string;
}

/**
 * Resolve the self-serve config from env. Invalid DEFAULT_MAX_AGENTS values
 * (negative, non-integer, non-numeric) fall back to 0 and log a warning via
 * the injected `warn` (defaults to console.warn).
 */
export function parseSelfServeConfig(
  env: SelfServeEnv,
  warn: (message: string) => void = console.warn,
): SelfServeConfig {
  const enabled = env.SHIPWRIGHT_SELF_SERVE_ENABLED === "enabled";

  let defaultMaxAgents = 0;
  const raw = env.SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS?.trim();
  if (raw) {
    if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) {
      defaultMaxAgents = Number(raw);
    } else {
      warn(
        `[admin] invalid SHIPWRIGHT_SELF_SERVE_DEFAULT_MAX_AGENTS=${JSON.stringify(raw)} (expected integer >= 0) — falling back to 0`,
      );
    }
  }

  const contactEmail =
    env.SHIPWRIGHT_SELF_SERVE_CONTACT_EMAIL?.trim() ||
    DEFAULT_SELF_SERVE_CONTACT_EMAIL;

  return { enabled, defaultMaxAgents, contactEmail };
}
