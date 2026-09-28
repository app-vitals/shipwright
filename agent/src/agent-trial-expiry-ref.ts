/**
 * agent/src/agent-trial-expiry-ref.ts
 *
 * A tiny mutable box holding the agent's most recently synced trial-expiry
 * timestamp (ATE-3.1), so downstream consumers (agent/src/slack.ts's
 * isTrialExpired() gate) can read a live view without closing over a single
 * syncConfig() tick. Kept pure and zero-I/O so it's unit-testable in
 * isolation — mirrors agent-slack-membership-ref.ts's style exactly.
 */

export interface AgentTrialExpiryRef {
  /**
   * Returns the most recently synced trial-expiry Date, or null if either
   * set() was never called or the agent has no trial configured. Callers
   * that need to distinguish "never synced" (config-bundle fetch has never
   * succeeded) from "synced to no-trial-configured" must check hasSynced()
   * rather than inferring it from the null return value, since both states
   * return null.
   */
  get(): Date | null;
  /**
   * True once set() has been called at least once. Consumers gating on
   * trial expiry should fail open (treat as not-expired) while this is
   * false, so a persistent config-sync failure never locks a customer out
   * of their own paying agent — before the first successful config sync,
   * unexpired access is the safe default.
   */
  hasSynced(): boolean;
  /** Replaces the current trial-expiry timestamp. */
  set(trialExpiresAt: Date | null): void;
}

/** Creates a new, independent agent trial-expiry ref defaulting to "no trial configured". */
export function createAgentTrialExpiryRef(): AgentTrialExpiryRef {
  let trialExpiresAt: Date | null = null;
  let synced = false;

  return {
    get(): Date | null {
      return trialExpiresAt;
    },
    hasSynced(): boolean {
      return synced;
    },
    set(next: Date | null): void {
      trialExpiresAt = next;
      synced = true;
    },
  };
}

/**
 * The process-wide agent trial-expiry ref. agent/src/index.ts's syncConfig()
 * writes into this on every successful config-sync tick;
 * agent/src/slack.ts's isTrialExpired() gate reads it on every inbound Slack
 * event, so a trial-expiry change (set via PATCH /agents/:id) takes effect
 * on the very next config-sync tick without requiring an agent restart. If
 * the agent's config bundle never becomes available, hasSynced() stays
 * false for the process lifetime — consumers must fail open (allow) in that
 * case.
 */
export const agentTrialExpiryRef: AgentTrialExpiryRef =
  createAgentTrialExpiryRef();
