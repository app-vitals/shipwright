/**
 * lib/default-agent-env.ts
 * Non-secret env vars seeded onto every newly created agent so they're visible
 * (and editable) in the agent's env view instead of being an invisible runtime
 * fallback. Secrets (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN, ...) are never defaulted
 * here — see secret-env-vars.ts.
 */

/** Model used when an agent has no ANTHROPIC_MODEL set. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

/** Env vars written to a new agent's AgentEnv at creation. Operator-supplied values win. */
export const DEFAULT_AGENT_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_MODEL: DEFAULT_ANTHROPIC_MODEL,
};
