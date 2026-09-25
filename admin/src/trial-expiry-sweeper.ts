/**
 * admin/src/trial-expiry-sweeper.ts
 *
 * TrialExpirySweeper — disables crons for agents whose trial has expired
 * (ATE-3.1). Every tick it finds every enabled AgentCronJob belonging to an
 * agent whose trialExpiresAt has passed and PATCHes each to enabled:false via
 * AgentCronJobService.setEnabled() — the same service method the
 * PATCH /agents/:id/crons/:cronId route itself calls (admin/src/agents-api.ts),
 * invoked in-process rather than over HTTP (mirrors session-alert-sweeper.ts
 * calling services directly instead of self-calling its own admin API).
 *
 * Deliberately does NOT deprovision the agent — no deleteAgentFully() call,
 * no touching the K8s workload, tokens, or chat history. A trial that ends
 * should not destroy the workspace, since the customer may convert to paid
 * later. This sweeper only flips AgentCronJob.enabled; agent/src/slack.ts's
 * isTrialExpired() gate is the other half of the lockdown, blocking inbound
 * Slack messages.
 *
 * Naturally idempotent — once every cron for an expired-trial agent is
 * disabled, listEnabledWithExpiredTrial() finds nothing for that agent on the
 * next tick, so no extra "have I already swept this agent" state is needed
 * (unlike session-alert-sweeper's SessionAlertState dedup). No re-entrancy
 * guard either: overlapping ticks both disabling the same already-disabled
 * row is harmless (setEnabled is idempotent), unlike the session sweeper's
 * push-notification side effects.
 *
 * Structure mirrors session-alert-sweeper.ts: an injected Clock, a per-row
 * try/catch so one bad cron can never abort the rest of the sweep, a counted
 * return value, and registration via setInterval in main.ts (never inside an
 * app factory, which must stay side-effect-free).
 */

import { type Clock, SystemClock } from "./clock.ts";

/** The narrow slice of AgentCronJobService this sweeper touches. */
export interface TrialExpiryCronJobServiceLike {
  listEnabledWithExpiredTrial(
    now: Date,
  ): Promise<Array<{ id: string; agentId: string }>>;
  setEnabled(
    agentId: string,
    cronId: string,
    enabled: boolean,
  ): Promise<unknown>;
}

export interface TrialExpirySweeperDeps {
  agentCronJobService: TrialExpiryCronJobServiceLike;
  clock?: Clock;
  /** Line logger for per-row outcomes. Defaults to console.log. */
  log?: (line: string) => void;
}

/** Per-tick counter, also the value `tick()` resolves to. */
export interface TrialExpirySweepResult {
  disabled: number;
}

/** Default cadence of the trial-expiry sweeper. */
export const DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

/**
 * Resolve the trial-expiry sweeper's tick interval from the environment.
 * Reads SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_SWEEP_INTERVAL_MS; anything unset,
 * blank, non-numeric, or non-positive falls back to the default rather than
 * producing a setInterval that spins (0/NaN) or never fires.
 */
export function resolveTrialExpirySweepIntervalMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env.SHIPWRIGHT_ADMIN_TRIAL_EXPIRY_SWEEP_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TRIAL_EXPIRY_SWEEP_INTERVAL_MS;
  }
  return parsed;
}

export class TrialExpirySweeper {
  private readonly clock: Clock;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: TrialExpirySweeperDeps) {
    this.clock = deps.clock ?? SystemClock();
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * One sweep: disables every enabled AgentCronJob belonging to an agent
   * whose trial has expired. Never throws — a listing failure short-circuits
   * to an all-zero result, and each row's setEnabled() call is individually
   * try/caught so one bad row can't abort the rest.
   */
  async tick(): Promise<TrialExpirySweepResult> {
    const now = this.clock.now();
    let rows: Array<{ id: string; agentId: string }>;
    try {
      rows =
        await this.deps.agentCronJobService.listEnabledWithExpiredTrial(now);
    } catch (err) {
      console.error("[trial-expiry-sweeper] listing failed:", err);
      return { disabled: 0 };
    }

    let disabled = 0;
    for (const row of rows) {
      try {
        await this.deps.agentCronJobService.setEnabled(
          row.agentId,
          row.id,
          false,
        );
        disabled++;
      } catch (err) {
        console.error(
          `[trial-expiry-sweeper] disable cron ${row.id} (agent ${row.agentId}) failed:`,
          err,
        );
      }
    }

    if (disabled > 0) {
      this.log(`[trial-expiry-sweeper] disabled=${disabled}`);
    }

    return { disabled };
  }
}
