/**
 * admin/src/trial-expiry-sweeper.ts
 *
 * TrialExpiryWarningSweeper (ATE-2.1) — the admin service's second background
 * loop, alongside session-alert-sweeper.ts. Every tick it:
 *
 *   1. Finds Agent rows with `trialExpiresAt` set and `trialExpiryWarnedAt`
 *      still null (an unset `trialExpiresAt` — the ATE-1.1 default — is never
 *      considered; see isDueForWarning below).
 *   2. For each candidate whose `trialExpiresAt` falls within the configured
 *      warning window (default 3 days, `warningDays`), looks up that agent's
 *      own `SLACK_BOT_TOKEN` / `SLACK_ALERT_CHANNEL` (AgentEnv rows, decrypted
 *      via AgentEnvService.getConfigBundle) and posts one Slack warning
 *      naming the expiry date.
 *   3. On a successful send, stamps `trialExpiryWarnedAt = now` via
 *      AgentService.updateFields so the same agent is never warned twice.
 *
 * Structure mirrors session-alert-sweeper.ts: an injected Clock, a narrow
 * *PrismaLike interface for the one read this sweeper does directly, a
 * per-agent try/catch so one bad row can never abort the sweep, an in-flight
 * `sweeping` guard on tick(), and registration via `setInterval` in
 * admin/src/main.ts (NEVER inside an app factory, which must stay
 * side-effect-free).
 *
 * Unlike session-alert-sweeper.ts, the write path reuses AgentService's
 * existing updateFields() rather than a raw Prisma call — admin/src/agents.ts
 * already owns "generic partial-field update for an agent" and ATE-2.1 is one
 * more field on that same whitelist (see UpdateAgentFieldsInput).
 *
 * Admin has no bot-token WebClient of its own: each tenant agent's Slack
 * credentials are its own AgentEnv rows, not a shared admin-side secret. So
 * `sendSlackMessage` is injected (defaulting to sendTrialExpiryWarning, which
 * constructs a fresh @slack/web-api WebClient per call using *that agent's*
 * token) rather than a single shared client living on the sweeper.
 *
 * Failed-send / missing-config policy (see sweepAgent below): neither case
 * stamps `trialExpiryWarnedAt`. A missing SLACK_BOT_TOKEN/SLACK_ALERT_CHANNEL
 * or a failed postMessage both leave the dedup gate open so the next tick
 * retries — silently stamping over an alert nobody received would satisfy
 * "never warn twice" at the cost of "never warn at all" for a
 * misconfigured/flaky tenant, which is worse. Both cases are logged (not
 * swallowed) each tick so a persistently failing agent stays visible in the
 * admin service's logs rather than silently going dark forever.
 */

import type { AgentEnvBundle, AgentEnvService } from "./agent-envs.ts";
import type { AgentDetail, AgentService } from "./agents.ts";
import { type Clock, SystemClock } from "./clock.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

/** The slice of an Agent row this sweeper's candidate query needs. */
export interface TrialExpiryAgentRow {
  id: string;
  name: string;
  trialExpiresAt: Date | null;
  trialExpiryWarnedAt: Date | null;
}

/**
 * The narrow slice of PrismaClient this sweeper touches directly — same
 * *PrismaLike pattern as session-alert-sweeper.ts's SessionAlertPrismaLike,
 * so tests inject a plain object double instead of a real client. The write
 * path (stamping trialExpiryWarnedAt) goes through AgentService.updateFields
 * instead, so this interface only needs the one read.
 */
export interface TrialExpiryPrismaLike {
  agent: {
    findMany(args: {
      where: { trialExpiresAt: { not: null }; trialExpiryWarnedAt: null };
    }): Promise<TrialExpiryAgentRow[]>;
  };
}

/** Params passed to the injected Slack-sending function. */
export interface SendSlackWarningParams {
  botToken: string;
  channel: string;
  text: string;
}

/**
 * Sends one Slack message and reports whether it actually went out. Returns
 * `false` (never throws) on any failure so a Slack outage can't abort the
 * sweep — see the header comment for why a failed send does not stamp
 * `trialExpiryWarnedAt`.
 */
export type SendSlackWarning = (
  params: SendSlackWarningParams,
) => Promise<boolean>;

export interface TrialExpirySweeperDeps {
  prisma: TrialExpiryPrismaLike;
  agentService: Pick<AgentService, "updateFields">;
  agentEnvService: Pick<AgentEnvService, "getConfigBundle">;
  /**
   * Injected so tests substitute a double instead of constructing a real
   * @slack/web-api WebClient / hitting a real Slack API. Defaults to
   * sendTrialExpiryWarning (the production implementation) when omitted.
   */
  sendSlackMessage?: SendSlackWarning;
  clock?: Clock;
  /** How many days out from `trialExpiresAt` the warning should fire. */
  warningDays?: number;
  /** Line logger for per-agent outcomes; defaults to `console.log`. */
  log?: (line: string) => void;
}

/** Per-tick counters, also the value `tick()` resolves to. */
export interface TrialExpirySweepResult {
  /** Warning sent and trialExpiryWarnedAt stamped. */
  warned: number;
  /** Due for a warning, but the agent has no usable Slack config. */
  skipped: number;
  /** Due for a warning, Slack config present, but the send itself failed. */
  failed: number;
}

/** Matches the task description's default warning window. */
export const DEFAULT_TRIAL_EXPIRY_WARNING_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Whether an agent is due for a trial-expiry warning right now, given only
 * the two schema fields (trialExpiresAt, trialExpiryWarnedAt) plus the
 * current time and the configured window:
 *
 *   - `trialExpiresAt` unset (ATE-1.1 default)      → never due
 *   - `trialExpiryWarnedAt` already set              → never due (dedup —
 *     acceptance criterion 2: a warned agent is never warned twice)
 *   - otherwise due once `trialExpiresAt` is at most `windowDays` away —
 *     including an already-past `trialExpiresAt` (a trial that expired
 *     before anyone noticed still deserves exactly one warning, not silence)
 */
export function isDueForWarning(
  trialExpiresAt: Date | null,
  trialExpiryWarnedAt: Date | null,
  now: Date,
  windowDays: number = DEFAULT_TRIAL_EXPIRY_WARNING_DAYS,
): boolean {
  if (!trialExpiresAt) return false;
  if (trialExpiryWarnedAt) return false;
  const msUntilExpiry = trialExpiresAt.getTime() - now.getTime();
  return msUntilExpiry <= windowDays * MS_PER_DAY;
}

/**
 * The Slack warning text for a given agent + expiry date. Explicitly does
 * NOT say "deprovisioned" — ATE-3.1 was corrected (same planning session,
 * same day) from auto-deprovisioning to lockdown-only: crons disabled and
 * Slack access blocked, agent never deleted. Naming the actual date (rather
 * than "in N days") matters because the sweeper's own dedup means this is
 * often the *only* warning an operator gets before lockdown.
 */
export function buildTrialExpiryWarningMessage(
  agentName: string,
  trialExpiresAt: Date,
): string {
  const dateStr = trialExpiresAt.toISOString().slice(0, 10);
  return (
    `:warning: Trial for agent \`${agentName}\` expires on ${dateStr}. ` +
    `After that date this agent's crons will be disabled and its Slack ` +
    `access will be blocked until the trial is renewed.`
  );
}

// ─── Production Slack sender ────────────────────────────────────────────────

/**
 * Production implementation of SendSlackWarning. Constructs a fresh
 * @slack/web-api WebClient per call using *the target agent's own* bot token
 * — mirrors (not reuses, since it's cross-service) the alert-posting pattern
 * in agent/src/cron-handler.ts. There is no long-lived client to share/cache:
 * every tenant agent has a distinct token, and posting is infrequent (at most
 * once per agent, ever, thanks to the dedup gate).
 */
export async function sendTrialExpiryWarning(
  params: SendSlackWarningParams,
): Promise<boolean> {
  try {
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(params.botToken);
    await client.chat.postMessage({
      channel: params.channel,
      text: params.text,
    });
    return true;
  } catch (err) {
    console.error("[trial-expiry-sweeper] Slack chat.postMessage failed:", err);
    return false;
  }
}

// ─── Sweeper ────────────────────────────────────────────────────────────────

export class TrialExpiryWarningSweeper {
  private readonly clock: Clock;
  private readonly warningDays: number;
  private readonly sendSlackMessage: SendSlackWarning;
  private readonly log: (line: string) => void;
  /** True while a sweep is running — mirrors SessionAlertSweeper's guard. */
  private sweeping = false;

  constructor(private readonly deps: TrialExpirySweeperDeps) {
    this.clock = deps.clock ?? SystemClock();
    this.warningDays = deps.warningDays ?? DEFAULT_TRIAL_EXPIRY_WARNING_DAYS;
    this.sendSlackMessage = deps.sendSlackMessage ?? sendTrialExpiryWarning;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * One sweep. Never throws: a candidate-fetch failure short-circuits to an
   * all-zero result, and every per-agent step is individually try/caught so
   * one bad row can't abort the rest.
   *
   * Not re-entrant by design, for the same reason as SessionAlertSweeper: the
   * dedup check-then-write straddles network I/O (Slack + Prisma), so two
   * overlapping ticks could both observe `trialExpiryWarnedAt = null` and
   * both send. If a previous tick is still in flight this returns an
   * all-zero result immediately rather than racing it.
   */
  async tick(): Promise<TrialExpirySweepResult> {
    if (this.sweeping) {
      console.warn(
        "[trial-expiry-sweeper] previous tick still in flight — skipping",
      );
      return { warned: 0, skipped: 0, failed: 0 };
    }
    this.sweeping = true;
    try {
      return await this.sweep();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweep(): Promise<TrialExpirySweepResult> {
    const result: TrialExpirySweepResult = {
      warned: 0,
      skipped: 0,
      failed: 0,
    };

    let candidates: TrialExpiryAgentRow[];
    try {
      candidates = await this.deps.prisma.agent.findMany({
        where: { trialExpiresAt: { not: null }, trialExpiryWarnedAt: null },
      });
    } catch (err) {
      console.error("[trial-expiry-sweeper] candidate fetch failed:", err);
      return result;
    }

    const now = this.clock.now();
    for (const agent of candidates) {
      try {
        await this.sweepAgent(agent, now, result);
      } catch (err) {
        console.error(`[trial-expiry-sweeper] agent ${agent.id} failed:`, err);
      }
    }

    const acted = result.warned + result.skipped + result.failed;
    if (acted > 0) {
      console.log(
        `[trial-expiry-sweeper] warned=${result.warned} skipped=${result.skipped} failed=${result.failed}`,
      );
    }

    return result;
  }

  private async sweepAgent(
    agent: TrialExpiryAgentRow,
    now: Date,
    result: TrialExpirySweepResult,
  ): Promise<void> {
    if (
      !isDueForWarning(
        agent.trialExpiresAt,
        agent.trialExpiryWarnedAt,
        now,
        this.warningDays,
      )
    ) {
      return;
    }

    const bundle: AgentEnvBundle | null =
      await this.deps.agentEnvService.getConfigBundle(agent.id);
    const botToken = bundle?.env.SLACK_BOT_TOKEN;
    const channel = bundle?.env.SLACK_ALERT_CHANNEL;
    if (!botToken || !channel) {
      this.log(
        `[trial-expiry-sweeper] skip ${agent.id} (${agent.name}): missing SLACK_BOT_TOKEN or SLACK_ALERT_CHANNEL — will retry next tick`,
      );
      result.skipped++;
      return;
    }

    // trialExpiresAt is guaranteed non-null here (isDueForWarning returned
    // true), but TypeScript can't see through that without a cast.
    const trialExpiresAt = agent.trialExpiresAt as Date;
    const text = buildTrialExpiryWarningMessage(agent.name, trialExpiresAt);
    const sent = await this.sendSlackMessage({ botToken, channel, text });
    if (!sent) {
      console.error(
        `[trial-expiry-sweeper] failed to post trial-expiry warning for agent ${agent.id} (${agent.name}) — will retry next tick`,
      );
      result.failed++;
      return;
    }

    const updated: AgentDetail = await this.deps.agentService.updateFields(
      agent.id,
      { trialExpiryWarnedAt: now },
    );
    void updated;
    result.warned++;
    this.log(
      `[trial-expiry-sweeper] warned ${agent.id} (${agent.name}): trial expires ${trialExpiresAt.toISOString()}`,
    );
  }
}
