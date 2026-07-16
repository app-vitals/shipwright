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
  /**
   * Returns the most recently set repos list, or [] if set() was never
   * called. Callers that need to distinguish "never synced" (config-bundle
   * fetch has never succeeded — e.g. a persistent 404) from "synced to a
   * deliberately empty scope" must check hasSynced() rather than inferring
   * it from an empty get() result, since both states return [].
   */
  get(): string[];
  /**
   * True once set() has been called at least once. Consumers that gate
   * candidacy on scope should fail open (skip filtering) while this is
   * false, so a persistent config-sync failure doesn't silently exclude
   * every repo from candidacy — before this ref existed, scope was never a
   * candidacy gate at all, and that pre-sync behavior must be preserved.
   */
  hasSynced(): boolean;
  /** Replaces the current repos list. */
  set(repos: string[]): void;
}

/** Creates a new, independent agent repos ref defaulting to an empty list. */
export function createAgentReposRef(): AgentReposRef {
  let repos: string[] = [];
  let synced = false;

  return {
    get(): string[] {
      return repos;
    },
    hasSynced(): boolean {
      return synced;
    },
    set(next: string[]): void {
      repos = next;
      synced = true;
    },
  };
}

/**
 * The process-wide agent repos ref. index.ts's syncConfig() calls
 * `.set(bundle.repos)` on every successful config sync tick; check-review.ts,
 * check-patch.ts, and check-deploy.ts's buildProductionDeps default their
 * getScopedRepos/hasSynced dependencies to `.get`/`.hasSynced` from this same
 * instance, so scope changes take effect on their very next
 * candidate-collection call without requiring loop-orchestrator.ts (which
 * builds those deps once and reuses them for the orchestrator's lifetime) to
 * be touched at all. syncConfig()'s 404 branch never calls `.set()`, so
 * `hasSynced()` stays false for the process lifetime if the agent's config
 * bundle never becomes available — consumers must fail open in that case.
 */
export const agentReposRef: AgentReposRef = createAgentReposRef();
