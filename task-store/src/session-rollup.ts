/**
 * task-store/src/session-rollup.ts
 *
 * Pure helper: computeSessionRollup(tasks, prBlockedSet, clock, session?) →
 * SessionRollup
 *
 * Summarizes a session's task set into a single rollup: overall state,
 * activity timestamps, per-status counts, distinct agents/repos, and the
 * list of tasks currently "waiting".
 *
 * ─── Signature note ─────────────────────────────────────────────────────────
 * The spec names a 3-arg contract — (tasks, prBlockedSet, clock) — for the
 * core state computation, but AC3 also requires reporting `archived: true`
 * for archived sessions, and archival status (Session.archivedAt) lives
 * outside the Task rows this function otherwise operates on. Rather than
 * force session metadata through the Task rows (or drop the 3-arg contract),
 * `session` is added as a 4th, OPTIONAL parameter: omitting it (the primary
 * 3-arg call shape) means "not archived"; passing `{ archivedAt }` satisfies
 * AC3. `archived` is computed independently of `state`, so both are always
 * reportable together — including for an empty task list.
 *
 * ─── Waiting definition (reuses computeBlockedBy semantics) ────────────────
 * A task counts as "waiting" when, among its open (non-terminal) tasks:
 *   1. status === "blocked" (explicit park), or
 *   2. hitl === true AND computeBlockedBy reports no unsatisfied dependency
 *      for it (i.e. the HITL gate is the only thing holding it back), or
 *   3. it has a linked PR (task.pr != null) present in prBlockedSet.
 * A task whose ONLY computeBlockedBy entry is an unsatisfied dependency does
 * NOT count as waiting — dependency-only waits are excluded by design.
 *
 * When more than one condition applies to the same task, precedence is
 * blocked > pr_blocked > hitl: status="blocked" is the most explicit,
 * operator-visible signal; pr_blocked is an external system signal; the
 * hitl gate is considered last since AC1 already conditions it on having no
 * unmet dependency.
 */

import { computeBlockedBy } from "./blocked-by.ts";
import type { Clock } from "./clock.ts";
import type { ReadyTaskLike } from "./ready.ts";
import { CLOSED_STATUSES } from "./statuses.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The minimal Task shape computeSessionRollup needs. */
export interface SessionRollupTaskLike extends ReadyTaskLike {
  repo?: string | null;
  assignee?: string | null;
  claimedBy?: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** The minimal Session shape needed to report `archived`. See the file-level
 * doc comment for why this is a separate, optional parameter. */
export interface SessionRollupSessionLike {
  archivedAt?: string | Date | null;
}

export type SessionRollupState = "waiting" | "active" | "closed" | "empty";

export type WaitingKind = "hitl" | "blocked" | "pr_blocked";

export interface WaitingTaskEntry {
  id: string;
  kind: WaitingKind;
}

export interface SessionRollupCounts {
  total: number;
  open: number;
  closed: number;
}

export interface SessionRollup {
  state: SessionRollupState;
  waitingSince: string | null;
  lastActivityAt: string | null;
  counts: SessionRollupCounts;
  agentIds: string[];
  repos: string[];
  waitingTasks: WaitingTaskEntry[];
  archived: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CLOSED_STATUS_SET = new Set<string>(CLOSED_STATUSES);

function toIso(value: string | Date): string {
  return typeof value === "string"
    ? new Date(value).toISOString()
    : value.toISOString();
}

function toTime(value: string | Date): number {
  return typeof value === "string"
    ? new Date(value).getTime()
    : value.getTime();
}

function isArchived(session?: SessionRollupSessionLike): boolean {
  return session?.archivedAt != null;
}

/**
 * Determine the WaitingKind (if any) for a single open task, per the
 * precedence documented at the top of this file.
 */
function classifyWaiting(
  task: SessionRollupTaskLike,
  allTasks: SessionRollupTaskLike[],
  prBlockedSet: Set<number>,
): WaitingKind | null {
  if (task.status === "blocked") {
    return "blocked";
  }

  if (task.pr != null && prBlockedSet.has(task.pr)) {
    return "pr_blocked";
  }

  if (task.hitl === true) {
    const blockedBy = computeBlockedBy(task, allTasks);
    const hasUnmetDependency = blockedBy.some(
      (entry) => entry.type === "dependency",
    );
    if (!hasUnmetDependency) {
      return "hitl";
    }
  }

  return null;
}

// ─── Core helper ─────────────────────────────────────────────────────────────

/**
 * Compute a session-level rollup from its task set.
 *
 * @param tasks         All tasks belonging to the session.
 * @param prBlockedSet  PR numbers (task-store `pr` field) currently blocked.
 * @param clock         Injected time source (reserved for "now"-relative
 *                       fields; current fields are all derived from task
 *                       timestamps, not wall-clock time).
 * @param session       Optional session metadata, used only for `archived`.
 */
export function computeSessionRollup(
  tasks: SessionRollupTaskLike[],
  prBlockedSet: Set<number>,
  clock: Clock,
  session?: SessionRollupSessionLike,
): SessionRollup {
  void clock;
  const archived = isArchived(session);

  if (tasks.length === 0) {
    return {
      state: "empty",
      waitingSince: null,
      lastActivityAt: null,
      counts: { total: 0, open: 0, closed: 0 },
      agentIds: [],
      repos: [],
      waitingTasks: [],
      archived,
    };
  }

  const openTasks = tasks.filter((t) => !CLOSED_STATUS_SET.has(t.status));
  const closedCount = tasks.length - openTasks.length;

  const waitingTasks: WaitingTaskEntry[] = [];
  for (const task of openTasks) {
    const kind = classifyWaiting(task, tasks, prBlockedSet);
    if (kind) {
      waitingTasks.push({ id: task.id, kind });
    }
  }
  const waitingIds = new Set(waitingTasks.map((w) => w.id));

  let state: SessionRollupState;
  if (openTasks.length === 0) {
    state = "closed";
  } else if (waitingTasks.length > 0) {
    state = "waiting";
  } else {
    state = "active";
  }

  const lastActivityAt = toIso(
    tasks.reduce(
      (latest, t) =>
        toTime(t.updatedAt) > toTime(latest) ? t.updatedAt : latest,
      tasks[0].updatedAt,
    ),
  );

  let waitingSince: string | null = null;
  if (state === "waiting") {
    const waitingTaskRecords = openTasks.filter((t) => waitingIds.has(t.id));
    const earliest = waitingTaskRecords.reduce(
      (earliestSoFar, t) =>
        toTime(t.updatedAt) < toTime(earliestSoFar)
          ? t.updatedAt
          : earliestSoFar,
      waitingTaskRecords[0].updatedAt,
    );
    waitingSince = toIso(earliest);
  }

  const agentIds = Array.from(
    new Set(
      tasks
        .map((t) => t.claimedBy ?? t.assignee ?? null)
        .filter((id): id is string => id != null),
    ),
  );

  const repos = Array.from(
    new Set(
      tasks.map((t) => t.repo ?? null).filter((r): r is string => r != null),
    ),
  );

  return {
    state,
    waitingSince,
    lastActivityAt,
    counts: {
      total: tasks.length,
      open: openTasks.length,
      closed: closedCount,
    },
    agentIds,
    repos,
    waitingTasks,
    archived,
  };
}
