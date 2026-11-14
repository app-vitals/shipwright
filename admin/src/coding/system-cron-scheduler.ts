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
 *   3. Only when at least one slot is due: list repos ONCE via the platform's
 *      lookup App (AdminPlatformServices.githubLookup.listRepositories()).
 *      `configured: false` → log and skip the tick, recording nothing. A
 *      lister failure rejects the tick before anything is fired. Archived
 *      repos are dropped; with none left the tick is skipped.
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
  listRepositories(): Promise<{
    configured: boolean;
    repos: { fullName: string; archived: boolean }[];
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

    const due: { id: string; slots: Date[] }[] = [];
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
        if (slots.length > 0) due.push({ id: def.id, slots });
      } catch (err) {
        fail(def.id, "slot computation", err);
      }
    }
    if (due.length === 0) return { status: "idle", fired, errors };

    const listing = await this.deps.lookup.listRepositories();
    if (!listing.configured) {
      this.log(
        `${P} lookup App not configured; skipping tick (${due.length} definition(s) due, nothing recorded)`,
      );
      return { status: "skipped-unconfigured", fired, errors };
    }
    const repos = listing.repos
      .filter((r) => !r.archived)
      .map((r) => r.fullName);
    if (repos.length === 0) {
      this.log(`${P} lookup App lists no unarchived repos; skipping tick`);
      return { status: "skipped-no-repos", fired, errors };
    }

    for (const { id, slots } of due) {
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
