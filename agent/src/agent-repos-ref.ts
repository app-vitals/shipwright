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

/**
 * The process-wide agent repos ref. index.ts's syncConfig() calls
 * `.set(bundle.repos)` on every successful config sync tick; check-review.ts,
 * check-patch.ts, and check-deploy.ts's buildProductionDeps default their
 * getScopedRepos dependency to `.get` from this same instance, so scope
 * changes take effect on their very next candidate-collection call without
 * requiring loop-orchestrator.ts (which builds those deps once and reuses
 * them for the orchestrator's lifetime) to be touched at all.
 */
export const agentReposRef: AgentReposRef = createAgentReposRef();
