/**
 * task-store/src/session-service.ts
 * SessionService — upserts Session rows in lockstep with Task writes.
 *
 * v1 scope (SESH-1.2): upsert only. get/list/update/purge land in later
 * tasks. Task.session (String?) is a free-text field that maps 1:1 to
 * Session.slug whenever it's non-blank — a task write with a blank/absent
 * session performs no Session write at all (see isBlankSession below).
 *
 * upsert() is designed to run inside the SAME transaction as the Task write
 * that triggers it: it accepts an explicit tx-compatible client
 * (PrismaTxClient, mirrors the identically-named alias in task-service.ts /
 * pull-request-service.ts) rather than always reaching for `this.prisma`, so
 * TaskService.create()/bulk() can hand it the same `tx` their task write ran
 * on and get one atomic write across both tables.
 */

import type { Clock } from "./clock.ts";
import { SystemClock } from "./clock.ts";
import type { Prisma, PrismaClient, Task } from "./index.ts";
import {
  type SessionRollupCounts,
  type SessionRollupState,
  type WaitingTaskEntry,
  computeSessionRollup,
} from "./session-rollup.ts";

/**
 * The Prisma client surface shared by the top-level client and a
 * $transaction callback's `tx`. Mirrors PrismaTxClient in task-service.ts /
 * pull-request-service.ts — upsert() accepts this so it can run against
 * either, though in practice its only caller (TaskService) always hands it
 * the same `tx` the paired task write ran on.
 */
export type PrismaTxClient = Pick<Prisma.TransactionClient, "session">;

/**
 * Batched (repo, prNumber) → blocked-prNumbers lookup, mirroring
 * PullRequestService.lookupBlockedPrNumbers()'s signature exactly (SESH-2.2).
 * Injected as a plain function (rather than a PullRequestServiceLike
 * dependency) to keep SessionService decoupled from pull-request-service.ts —
 * main.ts wires the real implementation in; the default below is a no-op so
 * every existing caller of `new SessionService(prisma, clock)` (TaskService)
 * is unaffected.
 */
export type LookupBlockedPrNumbers = (
  pairs: { repo: string; prNumber: number }[],
) => Promise<Set<number>>;

/**
 * Filters accepted by SessionService.list(). `agentScope` (auth) is distinct
 * from `agentId` (a caller-supplied narrowing filter) — see list()'s doc
 * comment.
 */
export interface SessionListFilters {
  state?: "waiting" | "active" | "closed" | "empty" | "archived" | "all";
  /** Order results. Defaults to "lastActivityAt" desc (nulls last). */
  sort?: "waitingSince" | "lastActivityAt";
  /** Caller filter: only sessions whose rollup.agentIds includes this agent. */
  agentId?: string;
  /** Caller filter: only sessions whose rollup.repos includes any of these repos. */
  repo?: string | string[];
  /** Case-insensitive substring match against slug OR title. */
  q?: string;
  limit?: number;
  offset?: number;
  /**
   * AUTH scope for agent tokens — separate from the `agentId` filter above.
   * When set, a session is visible only if at least one of its tasks
   * satisfies `task.assignee === agentScope.agentId OR (task.repo !== null &&
   * agentScope.repos.includes(task.repo))`. Undefined (admin tokens) sees
   * every session unconditionally.
   */
  agentScope?: { agentId: string; repos: string[] };
}

/**
 * A Session row's own fields flattened together with its computed rollup
 * (SESH-2.1's computeSessionRollup) into one flat object — never nested under
 * a `rollup` key.
 */
export interface SessionListItem {
  slug: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  archivedBy: string | null;
  state: SessionRollupState;
  waitingSince: string | null;
  lastActivityAt: string | null;
  counts: SessionRollupCounts;
  agentIds: string[];
  repos: string[];
  waitingTasks: WaitingTaskEntry[];
  archived: boolean;
}

/** Paginated list result from SessionService.list. */
export interface SessionListResult {
  sessions: SessionListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** The subset of SessionService the routes depend on. */
export interface SessionServiceLike {
  list(filters?: SessionListFilters): Promise<SessionListResult>;
  get(
    slug: string,
    agentScope?: { agentId: string; repos: string[] },
  ): Promise<SessionListItem | null>;
}

/** True when at least one task satisfies the agentScope OR-visibility rule
 * shared by list() and get() — assignee match OR repo-scope match. Mirrors
 * TaskService's agentScope OR shape exactly (assignee only, not claimedBy). */
function hasQualifyingTask(
  tasks: Pick<Task, "assignee" | "repo">[],
  agentScope: { agentId: string; repos: string[] },
): boolean {
  return tasks.some(
    (t) =>
      t.assignee === agentScope.agentId ||
      (t.repo !== null && agentScope.repos.includes(t.repo)),
  );
}

/** -Infinity for null (sorts last in a descending sort); otherwise epoch ms. */
function activityTime(value: string | null): number {
  return value === null ? Number.NEGATIVE_INFINITY : new Date(value).getTime();
}

/**
 * True when `session` should be treated as absent for the purposes of the
 * Session upsert hook: null, undefined, or a string that is empty or
 * whitespace-only. Pure logic, no I/O — kept as a standalone export so it
 * has its own fast unit test (session-service.unit.test.ts) distinct from
 * the DB-backed integration coverage of upsert() itself.
 */
export function isBlankSession(session: string | null | undefined): boolean {
  return (
    session === null || session === undefined || session.trim().length === 0
  );
}

export class SessionService implements SessionServiceLike {
  constructor(
    private prisma: PrismaClient,
    private clock: Clock = SystemClock(),
    private lookupBlockedPrNumbers: LookupBlockedPrNumbers = async () =>
      new Set<number>(),
  ) {}

  // ─── Reads (SESH-2.2) ────────────────────────────────────────────────────────

  /**
   * List sessions, each flattened with its computeSessionRollup() result.
   *
   * `state` semantics (see SessionListFilters):
   *   - omitted: archived===false AND rollup.state !== "closed"
   *   - "waiting"|"active"|"closed"|"empty": rollup.state === value (NOT
   *     additionally archived-filtered — an explicit state request overrides
   *     the default archived-exclusion)
   *   - "archived": archived === true (rollup state ignored)
   *   - "all": no state/archived filtering at all
   *
   * `agentScope` (auth) is applied before every other filter — a session
   * with zero tasks is never visible under a scoped token. `agentId`/`repo`
   * are separate, caller-supplied narrowing filters applied afterward.
   */
  async list(filters: SessionListFilters = {}): Promise<SessionListResult> {
    const where: Prisma.SessionWhereInput = {};
    if (filters.q) {
      where.OR = [
        { slug: { contains: filters.q, mode: "insensitive" } },
        { title: { contains: filters.q, mode: "insensitive" } },
      ];
    }

    const sessionRows = await this.prisma.session.findMany({ where });
    const slugs = sessionRows.map((s) => s.slug);
    const tasks = slugs.length
      ? await this.prisma.task.findMany({ where: { session: { in: slugs } } })
      : [];

    const tasksBySlug = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.session === null) continue;
      const bucket = tasksBySlug.get(task.session);
      if (bucket) bucket.push(task);
      else tasksBySlug.set(task.session, [task]);
    }

    const prBlockedSet = await this.lookupBlockedPrNumbers(
      tasks
        .filter(
          (t): t is Task & { repo: string; pr: number } =>
            t.repo !== null && t.pr !== null,
        )
        .map((t) => ({ repo: t.repo, prNumber: t.pr })),
    );

    let items: SessionListItem[] = sessionRows.map((session) => {
      const sessionTasks = tasksBySlug.get(session.slug) ?? [];
      const rollup = computeSessionRollup(
        sessionTasks,
        prBlockedSet,
        this.clock,
        { archivedAt: session.archivedAt },
      );
      return { ...session, ...rollup };
    });

    if (filters.agentScope) {
      const agentScope = filters.agentScope;
      items = items.filter((item) =>
        hasQualifyingTask(tasksBySlug.get(item.slug) ?? [], agentScope),
      );
    }

    if (filters.state === undefined) {
      items = items.filter((item) => !item.archived && item.state !== "closed");
    } else if (filters.state === "archived") {
      items = items.filter((item) => item.archived);
    } else if (filters.state !== "all") {
      const state = filters.state;
      items = items.filter((item) => item.state === state);
    }

    if (filters.agentId !== undefined) {
      const agentId = filters.agentId;
      items = items.filter((item) => item.agentIds.includes(agentId));
    }

    if (filters.repo !== undefined) {
      const repoList = Array.isArray(filters.repo)
        ? filters.repo
        : [filters.repo];
      items = items.filter((item) =>
        item.repos.some((repo) => repoList.includes(repo)),
      );
    }

    if (filters.sort === "waitingSince") {
      const waiting = items.filter((item) => item.state === "waiting");
      const nonWaiting = items.filter((item) => item.state !== "waiting");
      waiting.sort(
        (a, b) =>
          new Date(a.waitingSince as string).getTime() -
          new Date(b.waitingSince as string).getTime(),
      );
      nonWaiting.sort(
        (a, b) =>
          activityTime(b.lastActivityAt) - activityTime(a.lastActivityAt),
      );
      items = [...waiting, ...nonWaiting];
    } else {
      items = [...items].sort(
        (a, b) =>
          activityTime(b.lastActivityAt) - activityTime(a.lastActivityAt),
      );
    }

    const total = items.length;
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    const sessions = items.slice(offset, offset + limit);

    return { sessions, total, limit, offset };
  }

  /**
   * Fetch a single session by slug, flattened with its rollup. Returns null
   * when missing OR when an agentScope is set and no task in the session
   * qualifies (mirrors list()'s visibility rule) — both map to a route-level
   * 404, indistinguishable to the caller by design.
   */
  async get(
    slug: string,
    agentScope?: { agentId: string; repos: string[] },
  ): Promise<SessionListItem | null> {
    const session = await this.prisma.session.findUnique({ where: { slug } });
    if (!session) return null;

    const tasks = await this.prisma.task.findMany({ where: { session: slug } });

    if (agentScope && !hasQualifyingTask(tasks, agentScope)) {
      return null;
    }

    const prBlockedSet = await this.lookupBlockedPrNumbers(
      tasks
        .filter(
          (t): t is Task & { repo: string; pr: number } =>
            t.repo !== null && t.pr !== null,
        )
        .map((t) => ({ repo: t.repo, prNumber: t.pr })),
    );

    const rollup = computeSessionRollup(tasks, prBlockedSet, this.clock, {
      archivedAt: session.archivedAt,
    });

    return { ...session, ...rollup };
  }

  /**
   * Upsert the Session row implied by a task write's `session` value.
   *
   * - Blank (see isBlankSession): a pure no-op — does not touch the DB at
   *   all, so tasks with session: null/""/"   " never create a Session row.
   * - The actual write is Prisma's native `upsert()` — a single atomic
   *   `INSERT ... ON CONFLICT (slug) DO UPDATE` statement, not a separate
   *   findUnique-then-create/update. That matters under concurrency: two
   *   overlapping task writes into the same brand-new slug both running a
   *   plain findUnique-then-create would race on the create(), and a caught
   *   P2002 from *inside* a Prisma interactive transaction doesn't actually
   *   recover it — Postgres marks the whole transaction aborted after any
   *   failed statement, so a subsequent COMMIT silently discards it
   *   (including the already-successful Task insert) without Prisma
   *   surfacing an error. A single-statement ON CONFLICT upsert has no such
   *   window: it always cleanly creates-or-updates, never errors on a
   *   concurrent slug collision.
   * - `create` sets only `slug` — this call site has no title to provide, so
   *   `title` is left null and `createdAt`/`updatedAt` fall back to their
   *   schema defaults.
   * - `update` sets only `archivedAt: null` — `title` and `createdAt` are
   *   never part of the update payload, so a second write into the same
   *   session can't overwrite an already-set title or reset createdAt.
   *   Setting `archivedAt: null` un-archives a currently-archived row; it's
   *   a harmless no-op value-wise when the row is already un-archived
   *   (though Prisma still issues the UPDATE, bumping `updatedAt`).
   *
   * The pre-write `findUnique` read below exists solely to decide whether to
   * log an un-archive transition (mirroring StaleClaimReaper's console.log
   * convention — no TaskEvent-style audit row for v1); it never gates the
   * write's correctness, so a stale read under concurrency can at worst
   * suppress or emit one log line, never corrupt data.
   */
  async upsert(
    client: PrismaTxClient,
    session: string | null | undefined,
  ): Promise<void> {
    if (isBlankSession(session)) return;
    // Non-null/undefined per isBlankSession's guard above.
    const slug = session as string;

    const existing = await client.session.findUnique({ where: { slug } });

    await client.session.upsert({
      where: { slug },
      create: { slug },
      update: { archivedAt: null },
    });

    if (existing?.archivedAt) {
      console.log(
        `[session-service] un-archived session "${slug}" on task write at ${this.clock.now().toISOString()}`,
      );
    }
  }
}
