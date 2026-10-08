/**
 * admin/src/account-trial-expiry-sweeper.ts
 *
 * AccountTrialExpirySweeper (SSP-8.2) — the account-level counterpart of
 * trial-expiry-sweeper.ts (which keeps handling per-agent trialExpiresAt,
 * unchanged). Every tick:
 *
 *   1. Flips every *active* account whose trialExpiresAt is strictly in the
 *      past to 'trial_expired' (conditional write — a concurrent admin
 *      reactivation/extension wins).
 *   2. Runs AccountLifecycle.lockDown() across all locked accounts
 *      (suspended or trial_expired): every enabled cron of their agents is
 *      disabled with the SSP-8.1 lockdown marker. This both locks down the
 *      accounts expired in step 1 and self-heals any cron re-enabled (or
 *      created) while its account is locked — mirroring how the per-agent
 *      sweeper continuously re-applies its lockdown.
 *
 * Idempotent by construction: once an account is trial_expired and its crons
 * are disabled, neither query matches anything, so a re-run writes nothing.
 * Never deletes anything (no deleteAgentFully call). Registered via setInterval
 * in main.ts, flag-gated on self-serve.
 */

import type { AccountLifecycle } from "./account-lifecycle.ts";
import type { AccountService } from "./accounts.ts";
import { type Clock, SystemClock } from "./clock.ts";

export interface AccountTrialExpirySweeperDeps {
  accounts: Pick<AccountService, "listExpiredActiveIds" | "expireTrial">;
  lifecycle: Pick<AccountLifecycle, "lockDown">;
  clock?: Clock;
  log?: (line: string) => void;
}

export interface AccountTrialExpirySweepResult {
  /** Accounts flipped active → trial_expired this tick. */
  expired: number;
  /** Crons disabled (lockdown-marked) this tick. */
  disabled: number;
}

export class AccountTrialExpirySweeper {
  private readonly clock: Clock;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: AccountTrialExpirySweeperDeps) {
    this.clock = deps.clock ?? SystemClock();
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** One sweep. Never throws; per-account failures are logged and skipped. */
  async tick(): Promise<AccountTrialExpirySweepResult> {
    const now = this.clock.now();
    let expired = 0;
    try {
      const ids = await this.deps.accounts.listExpiredActiveIds(now);
      for (const id of ids) {
        try {
          if (await this.deps.accounts.expireTrial(id, now)) expired++;
        } catch (err) {
          console.error(
            `[account-trial-expiry-sweeper] expire account ${id} failed:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error("[account-trial-expiry-sweeper] listing failed:", err);
    }

    let disabled = 0;
    try {
      disabled = await this.deps.lifecycle.lockDown();
    } catch (err) {
      console.error("[account-trial-expiry-sweeper] lockdown failed:", err);
    }

    if (expired > 0 || disabled > 0) {
      this.log(
        `[account-trial-expiry-sweeper] expired=${expired} disabled=${disabled}`,
      );
    }
    return { expired, disabled };
  }
}
