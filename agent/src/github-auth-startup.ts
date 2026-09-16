/**
 * agent/src/github-auth-startup.ts
 *
 * Decision logic + live "already active" flag for (re)starting GitHub App
 * auth once credentials are available — whether that happens at boot
 * (entrypoint-main.ts's one-shot setupGitHubAuth() call, Step 5) or later,
 * when index.ts's syncConfig() picks up a GH_APP_ID / GH_APP_INSTALLATION_ID
 * / GH_APP_PRIVATE_KEY triple that was saved to the admin DB after this
 * agent-server process already started.
 *
 * Why this exists: entrypoint-main.ts spawns index.ts as a SEPARATE child
 * process (spawnAgentServer) and just waits for it to exit — index.ts does
 * not share in-memory state (e.g. a GitHubTokenManager instance) with
 * entrypoint-main.ts's process. If a GitHub App is installed after the pod
 * boots, entrypoint-main.ts's one-shot setupGitHubAuth() call already ran
 * and found no credentials; index.ts's syncConfig() re-applies process.env
 * every tick but had no hook to retry GitHub App auth setup in its own
 * process — the agent stayed unable to authenticate as the App until a full
 * pod restart. This module gives syncConfig() a single, shared, testable
 * decision: "are credentials live now, and has GitHub App auth not already
 * been set up successfully in this process? If so, set it up — exactly
 * once."
 *
 * setupGitHubAuth() (setup-github-auth.ts) itself is NOT safely
 * re-invokable: each call creates a brand-new GitHubTokenManager and calls
 * startBackgroundRefresh() on it. A manager's startBackgroundRefresh() only
 * stops ITS OWN prior interval — a second, independent manager from a
 * second setupGitHubAuth() call has its own separate interval that the
 * first manager's stopBackgroundRefresh() never touches, leaking a
 * duplicate background refresh. The isActive() guard below is what must
 * prevent a second call after a successful setup — setupGitHubAuth() itself
 * does not protect against repeated invocation.
 *
 * Kept dependency-injected and I/O-free itself (matches the project's
 * no-`mock.module()` isolation rule) — the real setupGitHubAuth() call is
 * injected by the caller (index.ts), so this module's own tests use
 * fakes/spies instead of a real GitHub App. Mirrors slack-startup.ts's
 * ref/guard style for the "already active" flag and the start-in-flight
 * guard so no module-scope mutable state leaks across test cases (each test
 * constructs its own via createGitHubAuthActiveRef()/
 * createGitHubAuthStartGuard()).
 */

/** True iff all three GitHub App credential env vars are present. */
export function hasGitHubAppCredentials(
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(
    env.GH_APP_ID && env.GH_APP_INSTALLATION_ID && env.GH_APP_PRIVATE_KEY,
  );
}

export interface GitHubAuthActiveRef {
  /** True once GitHub App auth has been set up successfully in this process. */
  isActive(): boolean;
  setActive(active: boolean): void;
}

/** Creates a new, independent "already active" ref defaulting to false. */
export function createGitHubAuthActiveRef(): GitHubAuthActiveRef {
  let active = false;
  return {
    isActive: (): boolean => active,
    setActive: (next: boolean): void => {
      active = next;
    },
  };
}

/**
 * The process-wide "already active" ref used by index.ts's syncConfig()
 * call site.
 */
export const githubAuthActiveRef: GitHubAuthActiveRef =
  createGitHubAuthActiveRef();

/**
 * Guards startGitHubAuthIfPossible() against overlapping callers — e.g. two
 * syncConfig() ticks racing because syncConfig() is dispatched via an
 * unawaited setInterval. Kept as its own tiny ref (rather than a
 * module-scope `let`) so tests can construct an independent, disposable
 * guard instead of mutating shared state that would otherwise leak between
 * test cases.
 */
export interface GitHubAuthStartGuard {
  isInFlight(): boolean;
  set(inFlight: boolean): void;
}

export function createGitHubAuthStartGuard(): GitHubAuthStartGuard {
  let inFlight = false;
  return {
    isInFlight: (): boolean => inFlight,
    set: (next: boolean): void => {
      inFlight = next;
    },
  };
}

/**
 * The process-wide start-in-flight guard used by index.ts's syncConfig()
 * call site. A single shared instance is required in production so
 * overlapping ticks can't race each other; tests should construct their own
 * via createGitHubAuthStartGuard() instead of reusing this singleton.
 */
export const githubAuthStartGuard: GitHubAuthStartGuard =
  createGitHubAuthStartGuard();

export interface StartGitHubAuthDeps {
  /** Live process env, read at call time (not a static snapshot). */
  env: Record<string, string | undefined>;
  /** True once GitHub App auth has already been set up successfully (by any prior call in this process). */
  isActive: () => boolean;
  /** Records that setup succeeded so isActive() reflects it on the next call. */
  markActive: () => void;
  /** Performs the actual setup — real prod wiring or a test fake. Errors propagate. */
  setupGitHubAuth: () => Promise<void>;
  /** Start-in-flight guard — defaults to the process-wide singleton; tests inject their own. */
  guard?: GitHubAuthStartGuard;
}

/**
 * Attempts to set up GitHub App auth if — and only if — credentials are
 * complete right now AND setup hasn't already succeeded in this process.
 * Safe to call on every syncConfig() tick: a no-op when credentials are
 * still incomplete, and a no-op once a prior call already succeeded.
 *
 * Returns true iff this call actually ran setup; false for every no-op path
 * (incomplete credentials, already active, or a racing call that lost the
 * in-flight guard).
 *
 * Errors from `setupGitHubAuth()` propagate to the caller (not swallowed
 * here) so index.ts's call site can log a start failure distinctly from a
 * config-bundle fetch/env-sync failure — see the call site in index.ts.
 */
export async function startGitHubAuthIfPossible(
  deps: StartGitHubAuthDeps,
): Promise<boolean> {
  const guard = deps.guard ?? githubAuthStartGuard;

  if (guard.isInFlight()) return false;
  if (deps.isActive()) return false;
  if (!hasGitHubAppCredentials(deps.env)) return false;

  guard.set(true);
  try {
    // Re-check after acquiring the guard in case another call already
    // succeeded between the check above and here — defense in depth on top
    // of the guard itself (JS has no preemption between the isActive check
    // and the set(true) above, so this branch is unreachable today, but
    // keeps the invariant obvious even if that ordering ever changes).
    if (deps.isActive()) return false;

    await deps.setupGitHubAuth();
    deps.markActive();
    return true;
  } finally {
    guard.set(false);
  }
}
