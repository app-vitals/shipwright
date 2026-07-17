/** The `claude -p` hard session timeout (30min). */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 1_800_000;

/** Extra headroom added on top of the session timeout (5min). */
export const CLAIM_TTL_BUFFER_MS = 300_000;

/**
 * Default claim TTL: how long a claim (Task or PR review/patch/deploy) remains
 * valid without a heartbeat before it's eligible for reaping. Must exceed
 * DEFAULT_CLAUDE_TIMEOUT_MS so a claim isn't reaped mid-session.
 */
export const DEFAULT_CLAIM_TTL_MS = DEFAULT_CLAUDE_TIMEOUT_MS + CLAIM_TTL_BUFFER_MS;
