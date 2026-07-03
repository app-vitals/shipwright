/**
 * agent/src/config-sync.ts
 *
 * Periodic config sync for the agent server (index.ts).
 *
 * Fetches the agent's config bundle from the admin service every 60s and
 * applies its env vars to the live process so changes made after startup —
 * e.g. a newly-added GH_TOKEN — reach a RUNNING agent without a restart.
 * Without this, config is fetched exactly once, by the entrypoint, and later
 * edits never propagate.
 *
 * Pure + injectable: the bundle source, timer seams, env target, and the
 * live-claude setter are all injected (defaulting to the real implementations)
 * so this is unit-testable with doubles and never overrides globals — per the
 * test-isolation contract.
 */

import type { AgentConfigResponse } from "@shipwright/admin";
import { type LiveClaudeConfig, setLiveClaudeConfig } from "./claude.ts";

const DEFAULT_INTERVAL_MS = 60_000;

/** Minimal slice of the runtime client this module needs. */
export interface ConfigBundleSource {
  getAgentConfigBundle(agentId: string): Promise<AgentConfigResponse>;
}

export interface ConfigSyncDeps {
  source: ConfigBundleSource;
  agentId: string;
  /** Model used when neither env nor the bundle sets ANTHROPIC_MODEL. */
  defaultModel: string;
  /** Poll interval in ms; defaults to 60s. */
  intervalMs?: number;
  /** Env target — defaults to process.env. Injected in tests. */
  env?: Record<string, string | undefined>;
  /** Live-claude config setter — defaults to claude.ts. Injected in tests. */
  applyClaudeConfig?: (patch: Partial<LiveClaudeConfig>) => void;
  /**
   * Schedules `fn` every `ms` and returns a canceller. Defaults to a
   * setInterval/clearInterval pair; injected in tests. Returning the canceller
   * (rather than exposing a raw timer handle) keeps this free of the
   * DOM-vs-Node `setInterval` return-type union.
   */
  setIntervalFn?: (fn: () => void, ms: number) => () => void;
  /** Log sink — defaults to console.log. */
  log?: (msg: string) => void;
}

export interface ConfigSyncHandle {
  /** Run a single sync now (also called internally before the interval). */
  syncOnce(): Promise<void>;
  /** Stop the periodic poll. */
  stop(): void;
}

/**
 * Start the config-sync loop: runs one sync immediately (awaited, so applied
 * env is in place before the caller proceeds), then every `intervalMs`.
 * Returns a handle to sync on demand or stop the loop.
 */
export async function startConfigSync(
  deps: ConfigSyncDeps,
): Promise<ConfigSyncHandle> {
  const {
    source,
    agentId,
    defaultModel,
    intervalMs = DEFAULT_INTERVAL_MS,
    env = process.env,
    applyClaudeConfig = setLiveClaudeConfig,
    setIntervalFn = (fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
    log = console.log,
  } = deps;

  let notFoundLogged = false;

  async function syncOnce(): Promise<void> {
    let bundle: AgentConfigResponse;
    try {
      bundle = await source.getAgentConfigBundle(agentId);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        // Expected before a config bundle exists — log once, keep polling.
        if (!notFoundLogged) {
          log("[config-sync] no config bundle found — skipping env sync");
          notFoundLogged = true;
        }
        return;
      }
      log(
        `[config-sync] failed to fetch config bundle: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    notFoundLogged = false;

    // Apply env vars — log only the changed KEYS, never the values (secrets).
    const changed = Object.keys(bundle.env).filter(
      (key) => bundle.env[key] !== env[key],
    );
    Object.assign(env, bundle.env);
    if (changed.length > 0) {
      log(`[config-sync] updated: ${changed.join(", ")}`);
    }

    const allowedTools = bundle.allowedTools ?? [];
    // Always write AGENT_ALLOWED_TOOLS — even when the list is cleared — so a
    // previously-set value doesn't linger as a stale env var after tools are
    // removed. undefined removes the key; applyClaudeConfig always receives the
    // current (possibly empty) array and is the authoritative live source.
    env.AGENT_ALLOWED_TOOLS =
      allowedTools.length > 0 ? JSON.stringify(allowedTools) : undefined;

    // Push the refreshed config into the live claude runner.
    applyClaudeConfig({
      model: env.ANTHROPIC_MODEL ?? defaultModel,
      fallbackModel: env.ANTHROPIC_FALLBACK_MODEL,
      effortLevel: env.ANTHROPIC_EFFORT_LEVEL,
      allowedTools,
    });
  }

  // Await the first sync so applied env (e.g. GH_TOKEN) is in place before the
  // caller proceeds — mirrors index.ts's "await first sync" ordering.
  await syncOnce();
  const cancel = setIntervalFn(() => void syncOnce(), intervalMs);
  log("[agent] config sync started (60s interval)");

  return { syncOnce, stop: cancel };
}
