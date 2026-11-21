/**
 * admin/src/coding/system-cron-scheduler.ts
 * The system-cron scheduler (SCR-1.3): the admin background pass that turns
 * the task-store's system-cron definitions into fired slots.
 *
 * Each tick:
 *   1. GET /system-crons?enabled=true.
 *   2. Per definition: read its last claimed slot (GET .../last-trigger) and
 *      compute every due slot strictly after the baseline and at or before
 *      now (system-cron-schedule.ts), oldest first. Catch-up is unbounded.
 *      baseline = max(last claimed slot, enabledAt):
 *        - never fired → the enable time, so enabling never fires a backlog
 *          and the first fire is the first slot after enabling;
 *        - re-enabled after a disabled stretch → slots from while it was
 *          disabled aren't replayed;
 *        - otherwise the last claimed slot, so slots missed while the admin
 *          was down (or the lookup App unconfigured) are caught up.
 *      enabledAt is null only for rows predating it; updatedAt stands in.
 *   3. Due definitions are grouped by their accountId (CRS-2.2); each
 *      account's repos are listed ONCE per tick via the platform's lookup App
 *      (AdminPlatformServices.githubLookup.listRepositories(accountId)).
 *      `configured: false` → log and skip that account's definitions only,
 *      recording nothing. The listing is cache-backed and per-account
 *      failures are tolerated: a never-synced lookup (syncing, no repos) or a
 *      rejected listing skips that account only (logged, nothing recorded);
 *      a stale snapshot is used with its age logged. A lookup problem never
 *      rejects the tick or blocks other accounts. Archived repos are
 *      dropped; an account with none left is skipped likewise.
 *      The tick status is 'fired' unless EVERY due definition was skipped by
 *      its account's listing (then skipped-unconfigured when all were
 *      unconfigured, else skipped-no-repos).
 *   4. POST /system-crons/:id/fire {scheduledFor, repos} per slot, oldest
 *      first. The task-store claims each (id, scheduledFor) exactly once and
 *      rolls a failed fire back, so N admin replicas firing the same slot
 *      create one task set and a failed fire records no trigger. A failure
 *      stops that definition's remaining slots for this tick (later slots are
 *      never claimed ahead of an earlier one, which would move last-trigger
 *      past it); the next tick retries from the same baseline.
 *
 * A tick never overlaps itself in one process (a long catch-up can outlast
 * the 60s interval); overlap across replicas is harmless (see 4).
 *
 * Dependency-free apart from type imports, so task-store's integration suite
 * can drive it against the real task-store app in-process.
 */

import type { Clock } from "@app-vitals/agent-admin/clock";
import { dueSlots, parseCronSchedule } from "./system-cron-schedule.ts";

export const SYSTEM_CRON_SCHEDULER_INTERVAL_MS = 60_000;
export const SYSTEM_CRON_SCHEDULER_LOG_PREFIX = "[system-cron-scheduler]";

/** The definition fields the scheduler reads (GET /system-crons). */
export interface SystemCronDefinitionView {
  id: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  enabledAt: string | null;
  updatedAt: string;
  /** CRS-2.2 — owning account; absent/null → the deployment-wide listing. */
  accountId?: string | null;
  /** CRS-1.1 — optional so older task-store responses still parse. */
  repoScope?: "all" | "selected";
  repos?: string[];
}

/** The task-store's system-cron surface the scheduler drives. */
export interface SystemCronStore {
  listEnabled(): Promise<SystemCronDefinitionView[]>;
  /** Max claimed slot (ISO), or null when the definition never fired. */
  lastTrigger(id: string): Promise<string | null>;
  fire(
    id: string,
    scheduledFor: string,
    repos: string[],
  ): Promise<{ claimed: boolean; taskIds: string[] }>;
}

/**
 * Structural match for @app-vitals/agent-admin's GithubLookupService
 * (AdminPlatformServices.githubLookup, 1.40.0+).
 */
export interface LookupRepositoryLister {
  listRepositories(accountId?: string | null): Promise<{
    configured: boolean;
    repos: { fullName: string; archived: boolean }[];
    /** Cache state; absent on older platform versions (treated as ready). */
    syncState?: "syncing" | "ready" | "stale" | "failed";
    fetchedAt?: string | number | Date | null;
  }>;
}

export interface SystemCronFire {
  cronId: string;
  scheduledFor: string;
  claimed: boolean;
  taskCount: number;
}

export interface SystemCronTickResult {
  status:
    | "busy"
    | "idle"
    | "skipped-unconfigured"
    | "skipped-no-repos"
    | "fired";
  fired: SystemCronFire[];
  errors: { cronId: string; error: string }[];
}

export interface SystemCronSchedulerDeps {
  store: SystemCronStore;
  lookup: LookupRepositoryLister;
  clock?: Clock;
  log?: (message: string) => void;
  error?: (message: string, err?: unknown) => void;
}

const P = SYSTEM_CRON_SCHEDULER_LOG_PREFIX;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Human-readable age of a cache snapshot, "age unknown" when untimed. */
function snapshotAge(
  fetchedAt: string | number | Date | null | undefined,
  now: Date,
): string {
  const t = fetchedAt == null ? NaN : new Date(fetchedAt).getTime();
  if (Number.isNaN(t)) return "age unknown";
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  return mins < 60
    ? `${mins}m old`
    : mins < 1440
      ? `${Math.round(mins / 60)}h old`
      : `${Math.round(mins / 1440)}d old`;
}

/** The catch-up baseline: max(last claimed slot, enable time). */
export function catchUpBaseline(
  def: Pick<SystemCronDefinitionView, "enabledAt" | "updatedAt">,
  lastTrigger: string | null,
): Date {
  const enabled = Date.parse(def.enabledAt ?? def.updatedAt);
  const last =
    lastTrigger === null ? Number.NEGATIVE_INFINITY : Date.parse(lastTrigger);
  return new Date(Math.max(enabled, last));
}

export class SystemCronScheduler {
  private readonly clock: Clock;
  private readonly log: (message: string) => void;
  private readonly error: (message: string, err?: unknown) => void;
  private inFlight = false;

  constructor(private readonly deps: SystemCronSchedulerDeps) {
    this.clock = deps.clock ?? { now: () => new Date() };
    this.log = deps.log ?? ((m) => console.log(m));
    this.error = deps.error ?? ((m, e) => console.error(m, e));
  }

  async tick(): Promise<SystemCronTickResult> {
    if (this.inFlight) return { status: "busy", fired: [], errors: [] };
    this.inFlight = true;
    try {
      return await this.run();
    } finally {
      this.inFlight = false;
    }
  }

  private async run(): Promise<SystemCronTickResult> {
    const now = this.clock.now();
    const fired: SystemCronFire[] = [];
    const errors: SystemCronTickResult["errors"] = [];
    const fail = (cronId: string, what: string, err: unknown) => {
      errors.push({ cronId, error: message(err) });
      this.error(`${P} ${cronId}: ${what} failed:`, err);
    };

    const due: {
      id: string;
      accountId: string | null;
      slots: Date[];
      scope: Pick<SystemCronDefinitionView, "repoScope" | "repos">;
    }[] = [];
    for (const def of await this.deps.store.listEnabled()) {
      try {
        const spec = parseCronSchedule(def.schedule);
        const last = await this.deps.store.lastTrigger(def.id);
        const slots = dueSlots(
          spec,
          def.timezone,
          catchUpBaseline(def, last),
          now,
        );
        if (slots.length > 0) {
          due.push({
            id: def.id,
            accountId: def.accountId ?? null,
            slots,
            scope: { repoScope: def.repoScope, repos: def.repos },
          });
        }
      } catch (err) {
        fail(def.id, "slot computation", err);
      }
    }
    if (due.length === 0) return { status: "idle", fired, errors };

    // One listing per distinct account. A problem with one account's lookup
    // is a skip for that account only; it never rejects the tick.
    const listings = new Map<
      string | null,
      { unconfigured: true } | { repos: string[] }
    >();
    for (const { accountId } of due) {
      if (listings.has(accountId)) continue;
      const label = accountId ?? "deployment-wide";
      let listing: Awaited<
        ReturnType<LookupRepositoryLister["listRepositories"]>
      >;
      try {
        listing = await this.deps.lookup.listRepositories(accountId);
      } catch (err) {
        this.log(
          `${P} account ${label}: lookup listing failed (${message(err)}); skipping its definition(s) (nothing recorded)`,
        );
        listings.set(accountId, { unconfigured: true });
        continue;
      }
      if (!listing.configured) {
        this.log(
          `${P} account ${label}: lookup App not configured; skipping its definition(s) (nothing recorded)`,
        );
        listings.set(accountId, { unconfigured: true });
        continue;
      }
      if (listing.syncState === "syncing" && listing.repos.length === 0) {
        this.log(
          `${P} account ${label}: lookup has not synced yet; skipping its definition(s) (nothing recorded)`,
        );
        listings.set(accountId, { unconfigured: true });
        continue;
      }
      if (listing.syncState === "stale" || listing.syncState === "failed") {
        this.log(
          `${P} account ${label}: using stale lookup snapshot (${snapshotAge(listing.fetchedAt, now)})`,
        );
      }
      const repos = listing.repos
        .filter((r) => !r.archived)
        .map((r) => r.fullName);
      if (repos.length === 0) {
        this.log(
          `${P} account ${label}: lookup App lists no unarchived repos; skipping its definition(s)`,
        );
      }
      listings.set(accountId, { repos });
    }

    let skippedUnconfigured = 0;
    let skippedNoRepos = 0;
    for (const { id, accountId, slots, scope } of due) {
      const listing = listings.get(accountId);
      if (!listing || "unconfigured" in listing) {
        skippedUnconfigured++;
        continue;
      }
      const allRepos = listing.repos;
      if (allRepos.length === 0) {
        skippedNoRepos++;
        continue;
      }
      const visible = new Set(allRepos);
      // 'selected' → intersect with the listing so archived or
      // no-longer-visible repos drop out; 'all' (or an older task-store
      // response without repoScope) uses every unarchived repo.
      const repos =
        scope.repoScope === "selected"
          ? (scope.repos ?? []).filter((r) => visible.has(r))
          : allRepos;
      if (repos.length === 0) {
        this.log(
          `${P} ${id}: none of its selected repos is visible and unarchived; skipping (nothing recorded)`,
        );
        continue;
      }
      for (const slot of slots) {
        const scheduledFor = slot.toISOString();
        try {
          const res = await this.deps.store.fire(id, scheduledFor, repos);
          fired.push({
            cronId: id,
            scheduledFor,
            claimed: res.claimed,
            taskCount: res.taskIds.length,
          });
          if (res.claimed) {
            this.log(
              `${P} fired ${id} @ ${scheduledFor}: ${res.taskIds.length} task(s)`,
            );
          }
        } catch (err) {
          fail(id, `fire @ ${scheduledFor}`, err);
          break;
        }
      }
    }
    if (skippedUnconfigured + skippedNoRepos === due.length) {
      return {
        status:
          skippedNoRepos === 0 ? "skipped-unconfigured" : "skipped-no-repos",
        fired,
        errors,
      };
    }
    return { status: "fired", fired, errors };
  }
}

// ─── HTTP store ───────────────────────────────────────────────────────────────

const READ_TIMEOUT_MS = 10_000;
/** A 500-repo fire runs one long transaction on the task-store side. */
const FIRE_TIMEOUT_MS = 120_000;

export interface HttpSystemCronStoreConfig {
  url: string;
  adminToken: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * The task-store system-cron routes over HTTP, with the admin token and no
 * ?accountId= (every account's definitions; each fire's tasks inherit their
 * definition's account). Any non-2xx throws — including /fire's 409 for a
 * definition disabled mid-tick. A client-side timeout on /fire is safe: if
 * the task-store committed anyway, the next tick's last-trigger read sees it.
 */
export function createHttpSystemCronStore(
  config: HttpSystemCronStoreConfig,
): SystemCronStore {
  const doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  const headers = { Authorization: `Bearer ${config.adminToken}` };
  const base = `${config.url}/system-crons`;

  async function call<T>(
    label: string,
    url: string,
    init: RequestInit,
  ): Promise<T> {
    const res = await doFetch(url, init);
    if (!res.ok) throw new Error(`task-store ${label} → ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    async listEnabled() {
      const body = await call<{ systemCrons?: SystemCronDefinitionView[] }>(
        "GET /system-crons",
        `${base}?enabled=true`,
        { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
      );
      return body.systemCrons ?? [];
    },
    async lastTrigger(id) {
      const body = await call<{ scheduledFor: string | null }>(
        `GET /system-crons/${id}/last-trigger`,
        `${base}/${encodeURIComponent(id)}/last-trigger`,
        { headers, signal: AbortSignal.timeout(READ_TIMEOUT_MS) },
      );
      return body.scheduledFor;
    },
    async fire(id, scheduledFor, repos) {
      const body = await call<{ claimed: boolean; taskIds: string[] }>(
        `POST /system-crons/${id}/fire`,
        `${base}/${encodeURIComponent(id)}/fire`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ scheduledFor, repos }),
          signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
        },
      );
      return { claimed: body.claimed, taskIds: body.taskIds ?? [] };
    },
  };
}
