/**
 * agent/src/agent-account-status-ref.ts
 *
 * A tiny mutable box holding the agent's most recently synced owning-account
 * status (SSP-8.3), so agent/src/slack.ts's isAccountPaused() gate can read a
 * live view without closing over a single syncConfig() tick. Pure and
 * zero-I/O — mirrors agent-trial-expiry-ref.ts exactly.
 */

export interface AgentAccountStatusRef {
  /**
   * Most recently synced account status ('active' | 'suspended' |
   * 'trial_expired'), or null when set() was never called or the agent has
   * no account. Use hasSynced() to tell "never synced" from "no account".
   */
  get(): string | null;
  /**
   * True once set() has been called at least once. Consumers gating on
   * account status should fail open while this is false, so a persistent
   * config-sync failure never locks a customer out of their own agent.
   */
  hasSynced(): boolean;
  /** Replaces the current account status. */
  set(status: string | null): void;
}

/** Creates a new, independent ref defaulting to "no account". */
export function createAgentAccountStatusRef(): AgentAccountStatusRef {
  let accountStatus: string | null = null;
  let synced = false;

  return {
    get(): string | null {
      return accountStatus;
    },
    hasSynced(): boolean {
      return synced;
    },
    set(next: string | null): void {
      accountStatus = next;
      synced = true;
    },
  };
}

/**
 * The process-wide account-status ref. agent/src/index.ts's syncConfig()
 * writes into it on every successful config-sync tick; slack.ts's
 * isAccountPaused() reads it on every inbound Slack event, so a status change
 * (suspension or reactivation) takes effect on the next sync with no restart.
 */
export const agentAccountStatusRef: AgentAccountStatusRef =
  createAgentAccountStatusRef();
