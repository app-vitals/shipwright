/**
 * task-store/src/task-transition-diff.ts
 *
 * Pure diff-computation for the Task audit trail (TCS-1.1). Ports
 * pr-transition-diff.ts's computePrTransitionDiff pattern to Task.
 *
 * `computeTaskTransitionDiff` compares a Task record's before/after state and
 * returns one entry per changed, auditable field. It is deliberately free of
 * any I/O so it can be unit-tested in isolation; TaskService.recordTaskTransition()
 * wraps it to persist the resulting entries as TaskEvent rows inside the
 * same transaction as the source update.
 *
 * Design notes (mirrors pr-transition-diff.ts exactly):
 *   - `heartbeatAt` is excluded from the audit trail entirely: a bare liveness
 *     ping carries no diagnostic value and would dominate write volume. A
 *     heartbeatAt change never produces an event row — neither on its own (a
 *     bare heartbeat() call yields zero entries) nor incidentally alongside a
 *     real field change (the real field still produces its entry).
 *   - Only the scalar, application-meaningful columns are diffed. System
 *     columns (createdAt/updatedAt), the primary key (id), and relation/array
 *     columns (acceptanceCriteria, dependencies, events) are never diffed —
 *     an audit trail of "updatedAt changed" is noise, and arrays/relations
 *     aren't part of a mutation's field-level intent. The allowlist is
 *     explicit (TASK_AUDITED_FIELDS) rather than a denylist so a newly-added
 *     scalar column defaults to NOT being audited until it's deliberately
 *     opted in — safer than silently auditing (and potentially leaking) a
 *     new field.
 *   - `before === null` (create path) returns [] — no events on creation.
 *   - Values are compared via `String(value)` stringification so null/
 *     undefined are treated identically.
 */

import type { Task } from "./index.ts";

/** A single field-level change between a before/after Task state. */
export interface TaskTransitionChange {
  field: string;
  /** Prior value, stringified; null when the field was null/absent before. */
  oldValue: string | null;
  /** New value, stringified; null when the field is null after. */
  newValue: string | null;
}

/**
 * The scalar Task fields that participate in the audit trail. Explicit
 * allowlist (see file header for why). `heartbeatAt` is intentionally absent
 * — it is never audited.
 */
export const TASK_AUDITED_FIELDS: ReadonlyArray<keyof Task> = [
  "title",
  "status",
  "source",
  "session",
  "repo",
  "description",
  "layer",
  "branch",
  "pr",
  "hours",
  "startedAt",
  "prCreatedAt",
  "mergedAt",
  "blockedAt",
  "blockedReason",
  "note",
  "type",
  "priority",
  "cancelledAt",
  "completedAt",
  "deployingAt",
  "deployedAt",
  "ciFixAttempts",
  "mergeCommit",
  "prUrl",
  "assignee",
  "issue",
  "model",
  "complexity",
  "hitl",
  "skipCount",
  "lastSkippedAt",
  "claimedBy",
  "agentHint",
  "claimedAt",
  "simplifyTotal",
  "simplifyDry",
  "simplifyDeadCode",
  "simplifyNaming",
  "simplifyComplexity",
  "simplifyConsistency",
  "coverageDelta",
  "effortLevel",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "costUsd",
  "metadata",
];

/** Stringify a scalar field value for storage as an event's old/new value. */
function toEventValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Compute the field-level diff between two Task states. Returns one entry
 * per audited field whose value changed (compared by stringified value, so
 * null/undefined are treated identically and no-op writes produce nothing).
 *
 * When `before` is null, the record is brand new and there is no meaningful
 * prior state to diff against; we return [] so Task creation is not logged
 * as a wall of "null → value" events. The acceptance criteria only require
 * auditing transitions of existing records, and a creation is already
 * captured by the Task row's own createdAt.
 */
export function computeTaskTransitionDiff(
  before: Task | null,
  after: Task,
): TaskTransitionChange[] {
  if (before === null) return [];

  const changes: TaskTransitionChange[] = [];
  for (const field of TASK_AUDITED_FIELDS) {
    const oldValue = toEventValue(before[field]);
    const newValue = toEventValue(after[field]);
    if (oldValue !== newValue) {
      changes.push({ field: String(field), oldValue, newValue });
    }
  }
  return changes;
}
