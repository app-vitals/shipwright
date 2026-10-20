/**
 * agent/src/runtime/anthropic-federation-guard.ts
 *
 * Defense in depth for Anthropic workload identity federation (WIF-2.1). The
 * admin already refuses to store or serve these keys for federated agents; this
 * guards the agent process itself. When ANTHROPIC_FEDERATION_RULE_ID is in the
 * pod env, CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
 * are skipped and deleted from process.env — each outranks federation in the
 * Anthropic client, even when set to an empty string.
 */

export const ANTHROPIC_CREDENTIAL_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

interface GuardDeps {
  processEnv?: Record<string, string | undefined>;
  /** Keys already logged by this process — log once per key. */
  logged?: Set<string>;
  log?: (message: string) => void;
}

const loggedKeys = new Set<string>();

/**
 * Returns `env` without the Anthropic credential keys and removes them from
 * process.env, when federation is configured. A no-op otherwise. Logs key
 * names only, once per key.
 */
export function filterAnthropicCredentials(
  env: Record<string, string>,
  deps: GuardDeps = {},
): Record<string, string> {
  const processEnv = deps.processEnv ?? process.env;
  if (!processEnv.ANTHROPIC_FEDERATION_RULE_ID) return env;

  const logged = deps.logged ?? loggedKeys;
  const log = deps.log ?? ((m: string) => console.warn(m));
  const filtered = { ...env };
  for (const key of ANTHROPIC_CREDENTIAL_KEYS) {
    const present = key in filtered || processEnv[key] !== undefined;
    delete filtered[key];
    delete processEnv[key];
    if (present && !logged.has(key)) {
      logged.add(key);
      log(
        `[federation] ignoring ${key}: Anthropic workload identity federation is active`,
      );
    }
  }
  return filtered;
}

/**
 * Apply a config-bundle env to process.env, honoring the federation guard.
 * Used by both the entrypoint and syncConfig(). Returns the keys whose value
 * changed (names only, for logging).
 */
export function applyEnvToProcess(
  env: Record<string, string>,
  deps: GuardDeps = {},
): string[] {
  const processEnv = deps.processEnv ?? process.env;
  const filtered = filterAnthropicCredentials(env, deps);
  const changed = Object.keys(filtered).filter(
    (key) => filtered[key] !== processEnv[key],
  );
  Object.assign(processEnv, filtered);
  return changed;
}
