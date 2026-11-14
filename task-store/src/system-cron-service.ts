/**
 * task-store/src/system-cron-service.ts
 * SystemCronService — system-cron definitions plus the idempotent fire
 * operation (SCR-1.1).
 *
 * A system cron is a definition (schedule, timezone, title/description
 * templates) whose every firing fans out into one ordinary `dev` task per
 * repo. The scheduler that decides *when* to fire lives outside the task
 * store; it calls fire(cronId, { scheduledFor, repos }) and this service
 * guarantees each (cronId, scheduledFor) slot is claimed exactly once.
 *
 * fire() runs ONE interactive transaction:
 *   1. INSERT the SystemCronTrigger row with ON CONFLICT DO NOTHING
 *      (createMany + skipDuplicates) on the [cronId, scheduledFor] unique key.
 *      Under Postgres's default READ COMMITTED, a concurrent fire for the same
 *      slot blocks on the in-flight unique-index entry until the first
 *      transaction commits, then inserts nothing (count 0) — so exactly one
 *      caller wins. If the first transaction instead rolls back, the waiter's
 *      insert proceeds and it becomes the winner.
 *   2. Losers return { claimed: false } having written nothing.
 *   3. The winner bulk-inserts one task per repo (deterministic ids — see
 *      system-cron-template.ts) and dispatches a single `task.write` webhook
 *      for the batch, mirroring TaskService.bulk().
 * Any failure after step 1 rolls back the trigger row together with the
 * tasks, so a retry after failure can claim the slot afresh and never
 * produces duplicate tasks. A task-id collision rolls the claim back and
 * surfaces as a 409 (distinct repos that collide are rejected up front with a
 * 400); any other P2002 escaping the transaction is reported as a lost race,
 * i.e. claimed:false.
 *
 * Account scope: generated tasks and the trigger row inherit the definition's
 * accountId. Methods taking `accountId` treat null as unrestricted (admin
 * without ?accountId=) and otherwise 404 a definition in another account.
 */

import { type Clock, SystemClock } from "./clock.ts";
import { DEFAULT_ACCOUNT_ID } from "./default-account.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import type {
  Prisma,
  PrismaClient,
  SystemCronDefinition,
  Task,
} from "./index.ts";
import {
  formatSlot,
  isValidCronId,
  isValidSystemCronRepo,
  parseScheduledFor,
  renderRepoTemplate,
  systemCronTaskId,
} from "./system-cron-template.ts";
import { bulkTxTimeoutMs, MAX_BULK_TASKS } from "./task-service.ts";
import type { WebhookDispatcher } from "./webhook-dispatcher.ts";

/** Max repos per fire — the same cap (and tx budget) as POST /tasks/bulk. */
export const MAX_FIRE_REPOS = MAX_BULK_TASKS;

/** `source` stamped on every task a system cron creates. */
export const SYSTEM_CRON_TASK_SOURCE = "system-cron";

export interface CreateSystemCronInput {
  id: string;
  name: string;
  schedule: string;
  timezone?: string;
  enabled?: boolean;
  titleTemplate: string;
  descriptionTemplate: string;
}

export type UpdateSystemCronInput = Partial<
  Omit<CreateSystemCronInput, "id" | "enabled">
>;

export interface FireSystemCronInput {
  scheduledFor: unknown;
  repos: unknown;
}

export interface FireSystemCronResult {
  claimed: boolean;
  cronId: string;
  /** Normalized whole-second UTC ISO timestamp of the slot. */
  scheduledFor: string;
  /** Compact UTC slot string (YYYYMMDDTHHMMSSZ) embedded in task ids. */
  slot: string;
  /** Ids of the tasks this call created — always [] when claimed is false. */
  taskIds: string[];
}

/** The subset of SystemCronService the routes depend on. */
export interface SystemCronServiceLike {
  list(filters: {
    accountId: string | null;
    enabled?: boolean;
  }): Promise<SystemCronDefinition[]>;
  create(
    data: CreateSystemCronInput,
    accountId: string,
  ): Promise<SystemCronDefinition>;
  update(
    id: string,
    patch: UpdateSystemCronInput,
    accountId: string | null,
  ): Promise<SystemCronDefinition>;
  setEnabled(
    id: string,
    enabled: boolean,
    accountId: string | null,
  ): Promise<SystemCronDefinition>;
  fire(
    id: string,
    input: FireSystemCronInput,
    accountId?: string | null,
  ): Promise<FireSystemCronResult>;
  lastTrigger(
    id: string,
    accountId: string | null,
  ): Promise<{ scheduledFor: string | null }>;
  recentTriggers(
    id: string,
    limit: number,
    accountId: string | null,
  ): Promise<{ triggers: RecentTrigger[] }>;
}

/** One claimed slot as returned by recentTriggers. */
export interface RecentTrigger {
  scheduledFor: string;
  /** SystemCronTrigger.createdAt — when the slot was claimed. */
  claimedAt: string;
  taskCount: number;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

/** True when `tz` is an IANA zone this runtime recognizes. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Five whitespace-separated cron fields. Semantics are the scheduler's. */
const CRON_SCHEDULE_RE = /^\S+(\s+\S+){4}$/;

function requireNonEmpty(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BadRequestError(`${field} must be a non-empty string`);
  }
  return value;
}

function validateSchedule(value: unknown): string {
  const schedule = requireNonEmpty("schedule", value).trim();
  if (!CRON_SCHEDULE_RE.test(schedule)) {
    throw new BadRequestError(
      "schedule must be a 5-field cron expression (e.g. '0 9 * * 1')",
    );
  }
  return schedule;
}

function validateTimezone(value: unknown): string {
  const tz = requireNonEmpty("timezone", value);
  if (!isValidTimezone(tz)) {
    throw new BadRequestError(`timezone '${tz}' is not a valid IANA timezone`);
  }
  return tz;
}

/** Validates and de-duplicates the repos list, preserving first-seen order. */
function validateRepos(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError("repos must be a non-empty array of org/repo");
  }
  const repos = [...new Set(value)];
  if (repos.length > MAX_FIRE_REPOS) {
    throw new BadRequestError(
      `repos accepts at most ${MAX_FIRE_REPOS} entries (received ${repos.length})`,
    );
  }
  const seen = new Map<string, string>();
  for (const repo of repos) {
    if (typeof repo !== "string" || !isValidSystemCronRepo(repo)) {
      throw new BadRequestError(
        `repo '${String(repo)}' must be in org/repo format`,
      );
    }
    // Task ids join owner and repo with '-' (and repos compare case-folded),
    // so distinct repos can collide on one id; reject rather than let the
    // second row be silently dropped while the slot stays claimed.
    const key = systemCronTaskId("", "", repo).toLowerCase();
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new BadRequestError(
        `repos '${prior}' and '${repo}' map to the same task id`,
      );
    }
    seen.set(key, repo);
  }
  return repos as string[];
}

export class SystemCronService implements SystemCronServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
    // Same outbound task.write dispatcher TaskService uses; no-op by default.
    private webhookDispatcher: WebhookDispatcher = async () => {},
  ) {}

  async list(filters: {
    accountId: string | null;
    enabled?: boolean;
  }): Promise<SystemCronDefinition[]> {
    const where: Prisma.SystemCronDefinitionWhereInput = {};
    if (filters.accountId !== null) where.accountId = filters.accountId;
    if (filters.enabled !== undefined) where.enabled = filters.enabled;
    return this.prisma.systemCronDefinition.findMany({
      where,
      orderBy: { id: "asc" },
    });
  }

  async create(
    data: CreateSystemCronInput,
    accountId: string = DEFAULT_ACCOUNT_ID,
  ): Promise<SystemCronDefinition> {
    if (typeof data.id !== "string" || !isValidCronId(data.id)) {
      throw new BadRequestError(
        "id must be a lowercase slug ([a-z0-9][a-z0-9-]*, max 63 chars)",
      );
    }
    try {
      return await this.prisma.systemCronDefinition.create({
        data: {
          id: data.id,
          accountId,
          name: requireNonEmpty("name", data.name),
          schedule: validateSchedule(data.schedule),
          timezone:
            data.timezone === undefined
              ? "UTC"
              : validateTimezone(data.timezone),
          enabled: data.enabled ?? true,
          titleTemplate: requireNonEmpty("titleTemplate", data.titleTemplate),
          descriptionTemplate: requireNonEmpty(
            "descriptionTemplate",
            data.descriptionTemplate,
          ),
        },
      });
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`system cron '${data.id}' already exists`);
      }
      throw err;
    }
  }

  async update(
    id: string,
    patch: UpdateSystemCronInput,
    accountId: string | null,
  ): Promise<SystemCronDefinition> {
    await this.findScoped(id, accountId);
    const data: Prisma.SystemCronDefinitionUpdateInput = {};
    if (patch.name !== undefined)
      data.name = requireNonEmpty("name", patch.name);
    if (patch.schedule !== undefined)
      data.schedule = validateSchedule(patch.schedule);
    if (patch.timezone !== undefined)
      data.timezone = validateTimezone(patch.timezone);
    if (patch.titleTemplate !== undefined)
      data.titleTemplate = requireNonEmpty(
        "titleTemplate",
        patch.titleTemplate,
      );
    if (patch.descriptionTemplate !== undefined)
      data.descriptionTemplate = requireNonEmpty(
        "descriptionTemplate",
        patch.descriptionTemplate,
      );
    return this.prisma.systemCronDefinition.update({ where: { id }, data });
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    accountId: string | null,
  ): Promise<SystemCronDefinition> {
    await this.findScoped(id, accountId);
    return this.prisma.systemCronDefinition.update({
      where: { id },
      data: { enabled },
    });
  }

  async fire(
    id: string,
    input: FireSystemCronInput,
    accountId: string | null = null,
  ): Promise<FireSystemCronResult> {
    const scheduledFor = parseScheduledFor(input.scheduledFor);
    if (scheduledFor === null) {
      throw new BadRequestError(
        "scheduledFor must be an ISO-8601 timestamp with an explicit timezone (e.g. 2026-11-14T09:00:00Z)",
      );
    }
    const repos = validateRepos(input.repos);

    const def = await this.findScoped(id, accountId);
    if (!def.enabled) {
      throw new ConflictError(`system cron '${id}' is disabled`);
    }

    const slot = formatSlot(scheduledFor);
    const base = {
      cronId: def.id,
      scheduledFor: scheduledFor.toISOString(),
      slot,
    };
    const notClaimed: FireSystemCronResult = {
      claimed: false,
      ...base,
      taskIds: [],
    };

    const tasks: Prisma.TaskCreateManyInput[] = repos.map((repo) => ({
      id: systemCronTaskId(def.id, slot, repo),
      accountId: def.accountId,
      title: renderRepoTemplate(def.titleTemplate, repo),
      description: renderRepoTemplate(def.descriptionTemplate, repo),
      status: "pending",
      kind: "dev",
      hitl: false,
      assignee: null,
      repo,
      source: SYSTEM_CRON_TASK_SOURCE,
    }));

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const claim = await tx.systemCronTrigger.createMany({
            data: [
              {
                accountId: def.accountId,
                cronId: def.id,
                scheduledFor,
                slot,
                taskCount: tasks.length,
                createdAt: this.clock.now(),
              },
            ],
            skipDuplicates: true,
          });
          if (claim.count === 0) return notClaimed;

          // No skipDuplicates: an id collision (e.g. a row created
          // out-of-band) must fail loudly and roll the claim back, matching
          // TaskService.bulk(), instead of silently dropping a repo's task.
          let rows: Task[];
          try {
            rows = await tx.task.createManyAndReturn({ data: tasks });
          } catch (err: unknown) {
            if (isUniqueViolation(err)) {
              throw new ConflictError(
                "a task with a deterministic system-cron id already exists",
              );
            }
            throw err;
          }
          await this.webhookDispatcher("task.write", rows);
          return { claimed: true, ...base, taskIds: rows.map((r) => r.id) };
        },
        { timeout: bulkTxTimeoutMs(tasks.length) },
      );
    } catch (err: unknown) {
      if (isUniqueViolation(err)) return notClaimed;
      throw err;
    }
  }

  /** Most recent claimed slot for the definition, or null if it never fired. */
  async lastTrigger(
    id: string,
    accountId: string | null,
  ): Promise<{ scheduledFor: string | null }> {
    await this.findScoped(id, accountId);
    const latest = await this.prisma.systemCronTrigger.aggregate({
      where: { cronId: id },
      _max: { scheduledFor: true },
    });
    return { scheduledFor: latest._max.scheduledFor?.toISOString() ?? null };
  }

  /**
   * The definition's most recent claimed slots, newest first by scheduledFor
   * (createdAt breaks ties), capped at `limit`.
   */
  async recentTriggers(
    id: string,
    limit: number,
    accountId: string | null,
  ): Promise<{ triggers: RecentTrigger[] }> {
    await this.findScoped(id, accountId);
    const rows = await this.prisma.systemCronTrigger.findMany({
      where: { cronId: id },
      orderBy: [{ scheduledFor: "desc" }, { createdAt: "desc" }],
      take: limit,
    });
    return {
      triggers: rows.map((r) => ({
        scheduledFor: r.scheduledFor.toISOString(),
        claimedAt: r.createdAt.toISOString(),
        taskCount: r.taskCount,
      })),
    };
  }

  private async findScoped(
    id: string,
    accountId: string | null,
  ): Promise<SystemCronDefinition> {
    const def = await this.prisma.systemCronDefinition.findUnique({
      where: { id },
    });
    if (!def || (accountId !== null && def.accountId !== accountId)) {
      throw new NotFoundError(`system cron '${id}' not found`);
    }
    return def;
  }
}
