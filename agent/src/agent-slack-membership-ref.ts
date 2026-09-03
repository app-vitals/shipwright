/**
 * agent/src/agent-slack-membership-ref.ts
 *
 * A tiny mutable box holding the agent's most recently synced
 * Slack membership restriction config (whether to restrict Slack access to
 * specific members + the list of allowed member email addresses), so
 * downstream consumers can read a live view without closing over a single
 * syncConfig() tick. Kept pure and zero-I/O so it's unit-testable in
 * isolation — mirrors review-author-allowlist-ref.ts's style.
 */

export interface SlackMembershipConfig {
  restrict: boolean;
  emails: string[];
}

export interface AgentSlackMembershipRef {
  /**
   * Returns the most recently set Slack membership config, or
   * {restrict: false, emails: []} if set() was never called. Callers that
   * need to distinguish "never synced" (config-bundle fetch has never
   * succeeded — e.g. a persistent 404) from "synced to a deliberately
   * unrestricted state" must check hasSynced() rather than inferring it
   * from the default value, since both states return {restrict: false,
   * emails: []}.
   */
  get(): SlackMembershipConfig;
  /**
   * True once set() has been called at least once. Consumers that gate on
   * the membership restriction should fail open (skip filtering / allow) while
   * this is false, so a persistent config-sync failure doesn't silently
   * restrict Slack access — before the first successful config sync,
   * unrestricted access is the safe default.
   */
  hasSynced(): boolean;
  /** Replaces the current Slack membership config. */
  set(config: SlackMembershipConfig): void;
}

/**
 * Defaults a config-bundle's restrictSlackToMembers and memberEmails to
 * fail-open when the values are null/undefined before they're handed to
 * agentSlackMembershipRef.set().
 *
 * The AgentConfigResponse type declares restrictSlackToMembers as a
 * non-nullable boolean and memberEmails as a non-nullable string[], but
 * the live config-bundle API has been observed returning null/undefined
 * for fields in production — a runtime/type mismatch that, left unguarded,
 * gets baked into the process-wide agentSlackMembershipRef singleton.
 * Defaulting here, at the config-sync write site, ensures every downstream
 * consumer of the ref never sees null and always respects fail-open semantics
 * (restrict: false, emails: []) on config-sync failure.
 */
export function resolveSlackMembership(
  restrictSlackToMembers: boolean | null | undefined,
  memberEmails: string[] | null | undefined,
): SlackMembershipConfig {
  return {
    restrict: restrictSlackToMembers ?? false,
    emails: memberEmails ?? [],
  };
}

/** Creates a new, independent agent Slack membership ref defaulting to an unrestricted state. */
export function createAgentSlackMembershipRef(): AgentSlackMembershipRef {
  let config: SlackMembershipConfig = { restrict: false, emails: [] };
  let synced = false;

  return {
    get(): SlackMembershipConfig {
      return config;
    },
    hasSynced(): boolean {
      return synced;
    },
    set(next: SlackMembershipConfig): void {
      config = next;
      synced = true;
    },
  };
}

/**
 * The process-wide agent Slack membership ref. Downstream consumers
 * (e.g. Slack message handlers checking membership restriction) will
 * default their restriction-checking behavior to this same instance
 * (once the consuming code lands), so membership changes take effect on
 * the very next candidate-collection or message-handling call without
 * requiring any agent restart. If the agent's config bundle never becomes
 * available, `hasSynced()` stays false for the process lifetime —
 * consumers must fail open (allow) in that case.
 */
export const agentSlackMembershipRef: AgentSlackMembershipRef =
  createAgentSlackMembershipRef();
