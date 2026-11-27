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
import { cursorWhere, decodeCursor, encodeCursor } from "./lib/cursor.ts";
import type { OriginKind } from "./origin-kinds.ts";
import {
  formatSlot,
  isValidCronId,
  isValidSystemCronRepo,
  parseScheduledFor,
  renderRepoTemplate,
  systemCronTaskBranch,
  systemCronTaskId,
} from "./system-cron-template.ts";
import { bulkTxTimeoutMs, MAX_BULK_TASKS } from "./task-service.ts";
import type { WebhookDispatcher } from "./webhook-dispatcher.ts";

/** Max repos per fire — the same cap (and tx budget) as POST /tasks/bulk. */
export const MAX_FIRE_REPOS = MAX_BULK_TASKS;

/** `source` stamped on every task a system cron creates. */
export const SYSTEM_CRON_TASK_SOURCE = "system-cron";

/**
 * Definitions seeded at boot (SCR-1.3), disabled. seedDefaults() only inserts
 * missing ids, so an operator's later edits and enable state always win.
 * Schedules match the agent-level crons they replace.
 */
export const DEFAULT_SYSTEM_CRONS: readonly CreateSystemCronInput[] = [
  {
    id: "docs-freshness",
    name: "Docs freshness",
    schedule: "0 7 * * *",
    timezone: "UTC",
    enabled: false,
    titleTemplate: "Docs freshness: {repo}",
    descriptionTemplate: "/shipwright:research-docs --auto --repo {repo}",
  },
  {
    id: "test-readiness",
    name: "Test readiness",
    schedule: "0 6 * * *",
    timezone: "UTC",
    enabled: false,
    titleTemplate: "Test readiness: {repo}",
    descriptionTemplate:
      "/shipwright:test-readiness --repo {repo} --full --publish",
  },
  {
    id: "entropy-patrol",
    name: "Entropy patrol",
    schedule: "0 4 * * 1",
    timezone: "UTC",
    enabled: false,
    titleTemplate: "Entropy patrol: {repo}",
    descriptionTemplate:
      "/shipwright:entropy-scan --repo {repo}\n/shipwright:entropy-fix --repo {repo}",
  },
  {
    id: "security-patrol",
    name: "Security patrol",
    schedule: "0 6 * * 1",
    timezone: "UTC",
    enabled: false,
    titleTemplate: "Security patrol: {repo}",
    descriptionTemplate:
      "/shipwright:security-scan --repo {repo}\n/shipwright:security-fix --repo {repo}",
  },
  {
    id: "consolidation-patrol",
    name: "Consolidation patrol",
    schedule: "0 5 * * 1",
    timezone: "UTC",
    enabled: false,
    titleTemplate: "Consolidation patrol: {repo}",
    descriptionTemplate:
      "/shipwright:consolidation-scan --repo {repo}\n/shipwright:consolidation-fix --repo {repo}",
  },
  {
    id: "error-patrol",
    name: "Error patrol",
    schedule: "0 4 * * *",
    timezone: "UTC",
    enabled: false,
    titleTemplate: "Error patrol: {repo}",
    descriptionTemplate:
      "/shipwright:error-scan --repo {repo}\n/shipwright:error-fix --repo {repo}\n/shipwright:error-resolve --repo {repo}\nThese three commands are not independent suggestions -- invoke each one immediately after the previous one finishes, in this same session, using the Skill tool. Do not stop after a command's own output tells you to 'run /X next' (e.g. error-scan's summary) -- that phrasing is written for a standalone manual invocation, not this chained session. Continue automatically through all three commands before doing anything else.",
  },
];

export interface CreateSystemCronInput {
  id: string;
  name: string;
  schedule: string;
  timezone?: string;
  enabled?: boolean;
  titleTemplate: string;
  descriptionTemplate: string;
  /** CRS-1.1: 'all' (default) or 'selected' (requires `repos`). */
  repoScope?: string;
  /** org/repo list; only meaningful (and required) when repoScope is 'selected'. */
  repos?: unknown;
}

export type UpdateSystemCronInput = Partial<
  Omit<CreateSystemCronInput, "id" | "enabled">
>;

export const REPO_SCOPES = ["all", "selected"] as const;
export type RepoScope = (typeof REPO_SCOPES)[number];

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
    cursor?: string,
  ): Promise<{ triggers: RecentTrigger[]; nextCursor?: string | null }>;
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

/**
 * Resolves the stored (repoScope, repos) pair from a create/update input,
 * falling back to `current` for omitted fields. 'all' always clears repos;
 * 'selected' requires a valid, non-empty, de-duplicated list.
 */
export function resolveRepoScope(
  input: { repoScope?: unknown; repos?: unknown },
  current: { repoScope: string; repos: string[] } = {
    repoScope: "all",
    repos: [],
  },
): { repoScope: RepoScope; repos: string[] } {
  const scope =
    input.repoScope === undefined ? current.repoScope : input.repoScope;
  if (scope !== "all" && scope !== "selected") {
    throw new BadRequestError("repoScope must be 'all' or 'selected'");
  }
  if (scope === "all") return { repoScope: "all", repos: [] };
  const repos = input.repos === undefined ? current.repos : input.repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new BadRequestError(
      "repos must be a non-empty array of org/repo when repoScope is 'selected'",
    );
  }
  return { repoScope: "selected", repos: validateRepos(repos) };
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
    const enabled = data.enabled ?? true;
    const scope = resolveRepoScope(data);
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
          enabled,
          enabledAt: enabled ? this.clock.now() : null,
          titleTemplate: requireNonEmpty("titleTemplate", data.titleTemplate),
          descriptionTemplate: requireNonEmpty(
            "descriptionTemplate",
            data.descriptionTemplate,
          ),
          repoScope: scope.repoScope,
          repos: scope.repos,
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
    const existing = await this.findScoped(id, accountId);
    const data: Prisma.SystemCronDefinitionUpdateInput = {};
    if (patch.repoScope !== undefined || patch.repos !== undefined) {
      const scope = resolveRepoScope(patch, existing);
      data.repoScope = scope.repoScope;
      data.repos = scope.repos;
    }
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
    const def = await this.findScoped(id, accountId);
    // Only a disabled→enabled flip moves enabledAt: re-enabling an enabled
    // definition must not push the scheduler's catch-up baseline forward.
    if (def.enabled === enabled) return def;
    return this.prisma.systemCronDefinition.update({
      where: { id },
      data: { enabled, enabledAt: enabled ? this.clock.now() : null },
    });
  }

  /**
   * Inserts DEFAULT_SYSTEM_CRONS that don't exist yet (default account).
   * Idempotent and race-safe across replicas (ON CONFLICT DO NOTHING); never
   * touches an existing row.
   */
  async seedDefaults(): Promise<void> {
    await this.prisma.systemCronDefinition.createMany({
      data: DEFAULT_SYSTEM_CRONS.map((d) => ({
        id: d.id,
        accountId: DEFAULT_ACCOUNT_ID,
        name: d.name,
        schedule: d.schedule,
        timezone: d.timezone ?? "UTC",
        enabled: false,
        enabledAt: null,
        titleTemplate: d.titleTemplate,
        descriptionTemplate: d.descriptionTemplate,
      })),
      skipDuplicates: true,
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

    const tasks: Prisma.TaskCreateManyInput[] = repos.map((repo) => {
      const id = systemCronTaskId(def.id, slot, repo);
      return {
        id,
        branch: systemCronTaskBranch(id),
        accountId: def.accountId,
        title: renderRepoTemplate(def.titleTemplate, repo),
        description: renderRepoTemplate(def.descriptionTemplate, repo),
        status: "pending",
        kind: "dev",
        hitl: false,
        assignee: null,
        repo,
        source: SYSTEM_CRON_TASK_SOURCE,
        // PLU-2.5: typed provenance. No owner — never invented for cron tasks.
        originKind: "cron" satisfies OriginKind,
        originRef: def.id,
      };
    });

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
    cursor?: string,
  ): Promise<{ triggers: RecentTrigger[]; nextCursor?: string | null }> {
    await this.findScoped(id, accountId);
    // (cronId, scheduledFor) is unique, so (scheduledFor, id) is a total order
    // consistent with the newest-first listing. The cursor encodes
    // scheduledFor in the createdAt slot of the shared codec.
    const where =
      cursor !== undefined
        ? {
            AND: [
              { cronId: id },
              cursorWhere(decodeCursor(cursor), "desc", "scheduledFor"),
            ],
          }
        : { cronId: id };
    // Fetch limit+1 rows to learn whether another page exists.
    const fetched = await this.prisma.systemCronTrigger.findMany({
      where,
      orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = fetched.length > limit;
    const rows = hasMore ? fetched.slice(0, limit) : fetched;
    const last = rows[rows.length - 1];
    return {
      triggers: rows.map((r) => ({
        scheduledFor: r.scheduledFor.toISOString(),
        claimedAt: r.createdAt.toISOString(),
        taskCount: r.taskCount,
      })),
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.scheduledFor, id: last.id })
          : null,
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
