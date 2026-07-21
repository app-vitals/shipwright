/**
 * The `claude -p` hard ceiling timeout (1hr) — a backstop, not the primary
 * timeout. The idle-reset timer (`SHIPWRIGHT_CLAUDE_IDLE_TIMEOUT_MS`, default
 * 25min, see `agent/src/config.ts`) is cleared/restarted on every stdout line
 * and is what fires for the vast majority of hung/stuck sessions. This
 * ceiling only fires for a session that stays continuously active (so the
 * idle timer keeps resetting) but never converges — e.g. a runaway loop that
 * keeps emitting output without ever finishing.
 */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 3_600_000;

/** Extra headroom added on top of the session timeout (5min). */
export const CLAIM_TTL_BUFFER_MS = 300_000;

/**
 * Default claim TTL: how long a claim (Task or PR review/patch/deploy) remains
 * valid without a heartbeat before it's eligible for reaping. Must exceed
 * DEFAULT_CLAUDE_TIMEOUT_MS so a claim isn't reaped mid-session.
 */
export const DEFAULT_CLAIM_TTL_MS = DEFAULT_CLAUDE_TIMEOUT_MS + CLAIM_TTL_BUFFER_MS;
