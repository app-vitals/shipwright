/**
 * agent/src/slack-startup.ts
 *
 * Decision logic + live-client box for (re)starting the Slack Bolt Socket
 * Mode app once credentials are available — whether that happens at boot
 * (Step 7 in index.ts) or later, when syncConfig() picks up a
 * SLACK_BOT_TOKEN/SLACK_APP_TOKEN pair that was saved to the admin DB after
 * the pod already started.
 *
 * Why this exists: before this module, both the Bolt `app` and the `slack`
 * WebClient were built once at boot from a static config snapshot taken
 * before syncConfig() ever ran. If credentials arrived even a few seconds
 * late (a plausible race during provisioning), the boot-time
 * hasSlackCredentials() check failed once and the agent stayed in permanent
 * offline mode — syncConfig() re-applies process.env every tick but had no
 * hook to retry Slack startup. This module gives syncConfig() (and the boot
 * path) a single, shared, testable decision: "are credentials live now, and
 * has Bolt not already started? If so, start it — exactly once."
 *
 * Kept dependency-injected and I/O-free itself (matches the project's
 * no-`mock.module()` isolation rule) — real Slack/Bolt/DM calls are injected
 * by the caller (index.ts), so this module's own tests use fakes/spies
 * instead of hitting real Slack. Mirrors agent-repos-ref.ts /
 * agent-slack-membership-ref.ts's get/set-ref style for the live client box,
 * and the same style is reused here for the start-in-flight guard so no
 * module-scope mutable state leaks across test cases (each test constructs
 * its own guard via createSlackStartGuard()).
 */

import type { WebClient } from "@slack/web-api";

/** Minimal shape `startSlackIfPossible` needs from a started Bolt App. */
export interface StartableSlackApp {
  start(): Promise<unknown>;
}

export interface SlackClientRef {
  /** Returns the current live Slack WebClient, or undefined if Slack hasn't started yet. */
  get(): WebClient | undefined;
  /** Replaces the current live Slack WebClient. */
  set(client: WebClient | undefined): void;
}

/** Creates a new, independent Slack client ref defaulting to undefined (no client yet). */
export function createSlackClientRef(): SlackClientRef {
  let client: WebClient | undefined;

  return {
    get(): WebClient | undefined {
      return client;
    },
    set(next: WebClient | undefined): void {
      client = next;
    },
  };
}

/**
 * The process-wide Slack client ref. index.ts's cronDeps.slack and the
 * back-online DM call site read through `.get()` rather than closing over a
 * boot-time `const slack`, so a late (re)start via startSlackIfPossible()
 * makes both see a live client without an agent restart.
 */
export const slackClientRef: SlackClientRef = createSlackClientRef();

/**
 * Guards startSlackIfPossible() against overlapping callers — e.g. two
 * syncConfig() ticks racing because syncConfig() is dispatched via an
 * unawaited setInterval, or a boot call racing a config-sync call. Kept as
 * its own tiny ref (rather than a module-scope `let`) so tests can construct
 * an independent, disposable guard instead of mutating shared state that
 * would otherwise leak between test cases.
 */
export interface SlackStartGuard {
  isInFlight(): boolean;
  set(inFlight: boolean): void;
}

export function createSlackStartGuard(): SlackStartGuard {
  let inFlight = false;
  return {
    isInFlight: () => inFlight,
    set: (next: boolean) => {
      inFlight = next;
    },
  };
}

/**
 * The process-wide start-in-flight guard used by index.ts's two real call
 * sites (boot + syncConfig()). A single shared instance is required in
 * production so a boot-time start and a config-sync-tick start can't race
 * each other; tests should construct their own via createSlackStartGuard()
 * instead of reusing this singleton.
 */
export const slackStartGuard: SlackStartGuard = createSlackStartGuard();

export interface StartSlackDeps {
  /** Reads live env-derived Slack config (botToken/appToken/signingSecret) at call time — not a static snapshot. */
  buildSlackConfig: () => {
    botToken: string;
    appToken: string;
    signingSecret: string;
  };
  /** Same credential-completeness check used at boot — see slack.ts. */
  hasSlackCredentials: (cfg: { botToken: string; appToken: string }) => boolean;
  /** True once Bolt has already been started (by any prior call, boot or config-sync). */
  isAppStarted: () => boolean;
  /** Builds (but does not start) the Bolt app from live config. */
  createSlackApp: () => StartableSlackApp;
  /** Records the started Bolt app so isAppStarted() reflects it on the next call. */
  setApp: (app: StartableSlackApp) => void;
  /** Builds the WebClient to publish via the slack client ref once credentials are confirmed live. */
  createSlackClient: () => WebClient;
  setSlackClient: (client: WebClient | undefined) => void;
  markSlackConnected: () => void;
  sendBackOnlineDm: (client: WebClient) => Promise<void>;
  /** Start-in-flight guard — defaults to the process-wide singleton; tests inject their own. */
  guard?: SlackStartGuard;
}

/**
 * Attempts to start the Slack Bolt app if — and only if — credentials are
 * complete right now AND Bolt hasn't already been started. Safe to call on
 * every boot attempt and every syncConfig() tick: a no-op when credentials
 * are still incomplete, and a no-op once a prior call already started Bolt.
 *
 * Returns true iff this call actually started Bolt; false for every no-op
 * path (incomplete credentials, already started, or a racing call that lost
 * the in-flight guard).
 *
 * Errors from `createSlackApp()`/`app.start()` propagate to the caller (not
 * swallowed here) so index.ts's two call sites can each decide how to
 * handle a start failure consistently with their surrounding context — see
 * the call sites in index.ts for the boot-vs-config-sync tradeoff.
 */
export async function startSlackIfPossible(
  deps: StartSlackDeps,
): Promise<boolean> {
  const guard = deps.guard ?? slackStartGuard;

  if (guard.isInFlight()) return false;
  if (deps.isAppStarted()) return false;

  const slackConfig = deps.buildSlackConfig();
  if (!deps.hasSlackCredentials(slackConfig)) return false;

  guard.set(true);
  try {
    // Re-check after acquiring the guard in case another call already
    // started Bolt between the check above and here — defense in depth on
    // top of the guard itself (JS has no preemption between the isInFlight
    // check and the set(true) above, so this branch is unreachable today,
    // but keeps the invariant obvious even if that ordering ever changes).
    if (deps.isAppStarted()) return false;

    const app = deps.createSlackApp();
    await app.start();
    deps.setApp(app);
    deps.markSlackConnected();

    const client = deps.createSlackClient();
    deps.setSlackClient(client);

    await deps.sendBackOnlineDm(client);
    return true;
  } finally {
    guard.set(false);
  }
}
