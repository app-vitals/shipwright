/**
 * admin/src/account-lifecycle.ts
 *
 * AccountLifecycle (SSP-8.2) — the one place an account's status transition
 * turns into cron side effects, shared by the admin PATCH /accounts/:id
 * handler (accounts-api.ts), the admin UI suspend/reactivate actions
 * (admin-ui-accounts.ts) and the account trial-expiry sweeper
 * (account-trial-expiry-sweeper.ts).
 *
 *   - active → suspended | trial_expired: lock down — every *enabled* cron of
 *     the account's agents is disabled via AgentCronJobService.setEnabled()
 *     with `{ lockdown: true }`, stamping lockdownDisabledAt (SSP-8.1). Crons
 *     the user had already disabled stay unmarked.
 *   - suspended | trial_expired → active: restore — restoreLockdownDisabled()
 *     re-enables exactly the marked crons. Agents whose *own* per-agent
 *     trialExpiresAt has lapsed are skipped, so the per-agent lockdown
 *     (trial-expiry-sweeper.ts) keeps its crons off. Reactivation requires
 *     the account's trialExpiresAt to be cleared or in the future (422
 *     otherwise — the expiry sweeper would just flip it straight back), and
 *     resets trialExpiryWarnedAt so a new trial gets its own warning.
 *
 * Nothing is ever deleted — no deleteAgentFully call, no workload changes. Both
 * directions are idempotent: lockdown only touches enabled crons, restore
 * only touches marked ones.
 */

import type {
  Account,
  AccountService,
  UpdateAccountInput,
} from "./accounts.ts";
import type { AgentCronJobService } from "./agent-cron-jobs.ts";
import { type Clock, SystemClock } from "./clock.ts";
import { NotFoundError, UnprocessableEntityError } from "./errors.ts";
import {
  DEFAULT_TRIAL_EXPIRY_WARNING_DAYS,
  isDueForWarning,
} from "./trial-expiry-warning-sweeper.ts";

// ─── Pure helpers ───────────────────────────────────────────────────────────

const LOCKED_STATUSES: ReadonlySet<string> = new Set([
  "suspended",
  "trial_expired",
]);

/** Whether an account status means its agents are locked down. */
export function isLockedStatus(status: string): boolean {
  return LOCKED_STATUSES.has(status);
}

export type LockdownAction = "lockdown" | "restore" | "none";

/** Cron side effect implied by moving an account from `prev` to `next`. */
export function resolveLockdownAction(
  prev: string,
  next: string,
): LockdownAction {
  if (prev === next) return "none";
  if (isLockedStatus(next)) return "lockdown";
  if (isLockedStatus(prev) && next === "active") return "restore";
  return "none";
}

/**
 * Whether a trial has lapsed — strictly before `now`, matching the per-agent
 * sweeper's `lt` (a trial expiring at exactly `now` is not yet expired).
 */
export function isTrialLapsed(trialExpiresAt: Date | null, now: Date): boolean {
  return trialExpiresAt !== null && trialExpiresAt.getTime() < now.getTime();
}

/**
 * Account-level warning window — the same comparison the per-agent warning
 * sweeper uses (isDueForWarning), applied to the account's fields.
 */
export function isAccountTrialWarningDue(
  trialExpiresAt: Date | null,
  trialExpiryWarnedAt: Date | null,
  now: Date,
  windowDays: number = DEFAULT_TRIAL_EXPIRY_WARNING_DAYS,
  graceDays: number = windowDays,
): boolean {
  return isDueForWarning(
    trialExpiresAt,
    trialExpiryWarnedAt,
    now,
    windowDays,
    graceDays,
  );
}

// ─── Service ────────────────────────────────────────────────────────────────

export interface AccountLifecycleDeps {
  accounts: Pick<AccountService, "getById" | "update" | "listAgentTrialStates">;
  cronJobs: Pick<
    AgentCronJobService,
    "listEnabledInLockedAccounts" | "setEnabled" | "restoreLockdownDisabled"
  >;
  clock?: Clock;
  log?: (line: string) => void;
}

export class AccountLifecycle {
  private readonly clock: Clock;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: AccountLifecycleDeps) {
    this.clock = deps.clock ?? SystemClock();
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /**
   * Apply an admin edit to an account and run the cron side effect its
   * status transition implies. Throws NotFoundError for an unknown account
   * and UnprocessableEntityError for a reactivation with a lapsed trial
   * (nothing is written in either case).
   */
  async update(id: string, data: UpdateAccountInput): Promise<Account> {
    const current = await this.deps.accounts.getById(id);
    if (!current) throw new NotFoundError(`account ${id} not found`);

    const now = this.clock.now();
    const nextStatus = data.status ?? current.status;
    const action = resolveLockdownAction(current.status, nextStatus);
    const nextTrial =
      data.trialExpiresAt !== undefined
        ? data.trialExpiresAt
        : current.trialExpiresAt;

    if (action === "restore" && isTrialLapsed(nextTrial, now)) {
      throw new UnprocessableEntityError(
        "Clear or extend trialExpiresAt before reactivating the account.",
      );
    }

    const trialChanged =
      data.trialExpiresAt !== undefined &&
      (data.trialExpiresAt?.getTime() ?? null) !==
        (current.trialExpiresAt?.getTime() ?? null);
    const write: UpdateAccountInput = { ...data };
    if (
      (action === "restore" || trialChanged) &&
      data.trialExpiryWarnedAt === undefined
    ) {
      write.trialExpiryWarnedAt = null;
    }

    const updated = await this.deps.accounts.update(id, write);

    if (action === "lockdown") await this.lockDown(id);
    if (action === "restore") await this.restore(id);
    return updated;
  }

  /**
   * Disable (with the lockdown marker) every enabled cron of an agent in a
   * locked account — one account, or all of them when `accountId` is
   * omitted (the sweeper's self-healing pass). Per-row failures are logged
   * and skipped. Returns the number disabled.
   */
  async lockDown(accountId?: string): Promise<number> {
    const rows =
      await this.deps.cronJobs.listEnabledInLockedAccounts(accountId);
    let disabled = 0;
    for (const row of rows) {
      try {
        await this.deps.cronJobs.setEnabled(row.agentId, row.id, false, {
          lockdown: true,
        });
        disabled++;
      } catch (err) {
        console.error(
          `[account-lifecycle] disable cron ${row.id} (agent ${row.agentId}) failed:`,
          err,
        );
      }
    }
    if (disabled > 0) {
      this.log(
        `[account-lifecycle] lockdown${accountId ? ` ${accountId}` : ""}: disabled=${disabled}`,
      );
    }
    return disabled;
  }

  /**
   * Re-enable the lockdown-disabled crons of the account's agents, skipping
   * agents whose own per-agent trial has lapsed. Returns the number restored.
   */
  async restore(accountId: string): Promise<number> {
    const now = this.clock.now();
    const agents = await this.deps.accounts.listAgentTrialStates(accountId);
    const ids = agents
      .filter((a) => !isTrialLapsed(a.trialExpiresAt, now))
      .map((a) => a.id);
    const restored = await this.deps.cronJobs.restoreLockdownDisabled(ids);
    if (restored > 0) {
      this.log(
        `[account-lifecycle] restore ${accountId}: restored=${restored}`,
      );
    }
    return restored;
  }
}
