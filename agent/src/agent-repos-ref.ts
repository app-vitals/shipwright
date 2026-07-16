/**
 * agent/src/agent-repos-ref.ts
 *
 * A tiny mutable box holding the agent's most recently synced list of scoped
 * repos (org/repo strings from AgentConfigResponse.repos), so downstream
 * consumers can read a live view without closing over a single syncConfig()
 * tick. Kept pure and zero-I/O so it's unit-testable in isolation — mirrors
 * loop-jobs-ref.ts's style.
 */

export interface AgentReposRef {
  /** Returns the most recently set repos list, or [] if set() was never called. */
  get(): string[];
  /** Replaces the current repos list. */
  set(repos: string[]): void;
}

/** Creates a new, independent agent repos ref defaulting to an empty list. */
export function createAgentReposRef(): AgentReposRef {
  let repos: string[] = [];

  return {
    get(): string[] {
      return repos;
    },
    set(next: string[]): void {
      repos = next;
    },
  };
}
