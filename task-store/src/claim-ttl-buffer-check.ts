/**
 * task-store/src/claim-ttl-buffer-check.ts
 *
 * checkClaimTtlBuffer — an opt-in, pure sanity check run once at task-store
 * startup. task-store and the agent are separate deployables with independent
 * env surfaces (see the Helm chart's separate `agent.extraEnv` / `taskStore.extraEnv`
 * lists) — there is no in-process way for task-store to read the agent's
 * SHIPWRIGHT_CLAUDE_TIMEOUT_MS. Rather than add cross-service network coupling
 * to fetch it, task-store can optionally be given its own copy of that value
 * (task-store already reads other unrelated cross-service env vars into its
 * own process, e.g. SHIPWRIGHT_TASK_STORE_AGENTS_URL) purely to validate that
 * its own claim TTL leaves enough headroom.
 *
 * When SHIPWRIGHT_CLAUDE_TIMEOUT_MS is unset, this is a no-op (today's
 * behavior, zero new required config).
 */

import { CLAIM_TTL_BUFFER_MS } from "@shipwright/lib/claim-ttl";

/**
 * Returns a warning message when the resolved claim TTL doesn't cover the
 * configured claude timeout plus the standard buffer, or `null` when the
 * check passes (or `claudeTimeoutMs` is undefined — opt-in, no-op by default).
 */
export function checkClaimTtlBuffer(
  ttlMs: number,
  claudeTimeoutMs: number | undefined,
): string | null {
  if (claudeTimeoutMs === undefined) {
    return null;
  }

  const minimumTtlMs = claudeTimeoutMs + CLAIM_TTL_BUFFER_MS;
  if (ttlMs > minimumTtlMs) {
    return null;
  }

  return `[task-store] SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS (${ttlMs}ms) does not leave enough headroom over SHIPWRIGHT_CLAUDE_TIMEOUT_MS (${claudeTimeoutMs}ms) + the ${CLAIM_TTL_BUFFER_MS}ms buffer (minimum: ${minimumTtlMs}ms). A claim may be reaped and re-dispatched before a long-running agent session finishes. Raise SHIPWRIGHT_TASK_STORE_CLAIM_TTL_MS to at least the maximum SHIPWRIGHT_CLAUDE_TIMEOUT_MS across the whole agent fleet, plus the buffer.`;
}
