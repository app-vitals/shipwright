/**
 * admin/src/account-trial-warning-sweeper.ts
 *
 * AccountTrialWarningSweeper (SSP-8.2) — the account-level counterpart of
 * trial-expiry-warning-sweeper.ts (which keeps warning per-agent trials,
 * unchanged). Every tick:
 *
 *   1. Lists active accounts with trialExpiresAt set and trialExpiryWarnedAt
 *      null.
 *   2. For each whose trialExpiresAt is inside the warning band
 *      (isAccountTrialWarningDue — same window/grace semantics as the
 *      per-agent sweeper, window from resolveTrialExpiryWarningDays), posts
 *      one Slack warning via *each* of the account's agents' own
 *      SLACK_BOT_TOKEN / SLACK_ALERT_CHANNEL (admin holds no Slack secret of
 *      its own — same pattern as the per-agent sweeper).
 *   3. If at least one post went out, stamps trialExpiryWarnedAt so the
 *      account is never warned again (until a reactivation/extension resets
 *      it, see account-lifecycle.ts). If no agent had usable Slack config,
 *      or every send failed, nothing is stamped and the next tick retries.
 *
 * Non-re-entrant (`sweeping` guard), per-account try/catch, injected Clock
 * and Slack sender — structure mirrors trial-expiry-warning-sweeper.ts.
 */

import { isAccountTrialWarningDue } from "./account-lifecycle.ts";
import type { AccountService } from "./accounts.ts";
import type { AgentEnvService } from "./agent-envs.ts";
import { type Clock, SystemClock } from "./clock.ts";
import {
  DEFAULT_TRIAL_EXPIRY_WARNING_DAYS,
  isPastWarningGrace,
  type SendSlackWarning,
  sendTrialExpiryWarning,
} from "./trial-expiry-warning-sweeper.ts";

export interface AccountTrialWarningSweeperDeps {
  accounts: Pick<
    AccountService,
    "listTrialWarningCandidates" | "listAgents" | "markTrialWarned"
  >;
  agentEnvService: Pick<AgentEnvService, "getConfigBundle">;
  /** Defaults to sendTrialExpiryWarning (real @slack/web-api client). */
  sendSlackMessage?: SendSlackWarning;
  clock?: Clock;
  warningDays?: number;
  graceDays?: number;
  log?: (line: string) => void;
}

export interface AccountTrialWarningSweepResult {
  /** Accounts warned (≥1 post sent) and stamped. */
  warned: number;
  /** Due, but no agent of the account had usable Slack config. */
  skipped: number;
  /** Due, Slack config present, but every send failed. */
  failed: number;
  /** Never warned and trialExpiresAt beyond the grace window — not alerted. */
  stale: number;
}

type Candidate = Awaited<
  ReturnType<AccountService["listTrialWarningCandidates"]>
>[number];

/** Slack text for one account's warning, posted through one of its agents. */
export function buildAccountTrialWarningMessage(
  accountName: string,
  trialExpiresAt: Date,
  now: Date,
): string {
  const dateStr = trialExpiresAt.toISOString().slice(0, 10);
  const verb =
    trialExpiresAt.getTime() <= now.getTime() ? "expired on" : "expires on";
  return (
    `:warning: The trial for account \`${accountName}\` ${verb} ${dateStr}. ` +
    `After that, every agent in the account is paused: crons are disabled ` +
    `and Slack access is blocked until the trial is renewed. Nothing is deleted.`
  );
}

const zero = (): AccountTrialWarningSweepResult => ({
  warned: 0,
  skipped: 0,
  failed: 0,
  stale: 0,
});

export class AccountTrialWarningSweeper {
  private readonly clock: Clock;
  private readonly warningDays: number;
  private readonly graceDays: number;
  private readonly send: SendSlackWarning;
  private readonly log: (line: string) => void;
  private sweeping = false;

  constructor(private readonly deps: AccountTrialWarningSweeperDeps) {
    this.clock = deps.clock ?? SystemClock();
    this.warningDays = deps.warningDays ?? DEFAULT_TRIAL_EXPIRY_WARNING_DAYS;
    this.graceDays = deps.graceDays ?? this.warningDays;
    this.send = deps.sendSlackMessage ?? sendTrialExpiryWarning;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** One sweep. Never throws; skips (all zeros) if a tick is in flight. */
  async tick(): Promise<AccountTrialWarningSweepResult> {
    if (this.sweeping) {
      console.warn(
        "[account-trial-warning-sweeper] previous tick still in flight — skipping",
      );
      return zero();
    }
    this.sweeping = true;
    try {
      return await this.sweep();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweep(): Promise<AccountTrialWarningSweepResult> {
    const result = zero();
    let candidates: Candidate[];
    try {
      candidates = await this.deps.accounts.listTrialWarningCandidates();
    } catch (err) {
      console.error(
        "[account-trial-warning-sweeper] candidate fetch failed:",
        err,
      );
      return result;
    }

    const now = this.clock.now();
    for (const account of candidates) {
      try {
        await this.sweepAccount(account, now, result);
      } catch (err) {
        console.error(
          `[account-trial-warning-sweeper] account ${account.id} failed:`,
          err,
        );
      }
    }

    if (result.warned + result.skipped + result.failed + result.stale > 0) {
      this.log(
        `[account-trial-warning-sweeper] warned=${result.warned} skipped=${result.skipped} failed=${result.failed} stale=${result.stale}`,
      );
    }
    return result;
  }

  private async sweepAccount(
    account: Candidate,
    now: Date,
    result: AccountTrialWarningSweepResult,
  ): Promise<void> {
    const { trialExpiresAt } = account;
    if (
      !trialExpiresAt ||
      !isAccountTrialWarningDue(
        trialExpiresAt,
        account.trialExpiryWarnedAt,
        now,
        this.warningDays,
        this.graceDays,
      )
    ) {
      if (
        trialExpiresAt &&
        !account.trialExpiryWarnedAt &&
        isPastWarningGrace(trialExpiresAt, now, this.graceDays)
      ) {
        result.stale++;
      }
      return;
    }

    const text = buildAccountTrialWarningMessage(
      account.name,
      trialExpiresAt,
      now,
    );
    let configured = 0;
    let sent = 0;
    for (const agent of await this.deps.accounts.listAgents(account.id)) {
      const bundle = await this.deps.agentEnvService.getConfigBundle(agent.id);
      const botToken = bundle?.env.SLACK_BOT_TOKEN;
      const channel = bundle?.env.SLACK_ALERT_CHANNEL;
      if (!botToken || !channel) continue;
      configured++;
      if (await this.send({ botToken, channel, text })) sent++;
    }

    if (configured === 0) {
      this.log(
        `[account-trial-warning-sweeper] skip ${account.id} (${account.name}): no agent with SLACK_BOT_TOKEN + SLACK_ALERT_CHANNEL — will retry next tick`,
      );
      result.skipped++;
      return;
    }
    if (sent === 0) {
      console.error(
        `[account-trial-warning-sweeper] every warning post failed for account ${account.id} (${account.name}) — will retry next tick`,
      );
      result.failed++;
      return;
    }

    await this.deps.accounts.markTrialWarned(account.id, now);
    result.warned++;
    this.log(
      `[account-trial-warning-sweeper] warned ${account.id} (${account.name}) via ${sent} agent(s): trial expires ${trialExpiresAt.toISOString()}`,
    );
  }
}
