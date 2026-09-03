/**
 * task-store/src/pr-transition-diff.ts
 *
 * Pure diff-computation for the PullRequest audit trail (PSA-1.2).
 *
 * `computePrTransitionDiff` compares a PR record's before/after state and
 * returns one entry per changed, auditable field. It is deliberately free of
 * any I/O so it can be unit-tested in isolation; PullRequestService.recordTransition()
 * wraps it to persist the resulting entries as PullRequestEvent rows inside the
 * same transaction as the source update.
 *
 * Design notes:
 *   - `heartbeatAt` is excluded from the audit trail entirely: a bare liveness
 *     ping carries no diagnostic value and would dominate write volume. A
 *     heartbeatAt change never produces an event row — neither on its own (a
 *     bare heartbeat() call yields zero entries) nor incidentally alongside a
 *     real field change (the real field still produces its entry).
 *   - Only the scalar, application-meaningful columns are diffed. System
 *     columns (createdAt/updatedAt), the primary key (id), and relation arrays
 *     (findings/events) are never diffed — an audit trail of "updatedAt
 *     changed" is noise, and relations aren't part of a mutation's field-level
 *     intent. The allowlist is explicit (AUDITED_FIELDS) rather than a
 *     denylist so a newly-added scalar column defaults to NOT being audited
 *     until it's deliberately opted in — safer than silently auditing (and
 *     potentially leaking) a new field.
 */

import type { PullRequest } from "./index.ts";

/** A single field-level change between a before/after PR state. */
export interface PrTransitionChange {
  field: string;
  /** Prior value, stringified; null when the field was null/absent before. */
  oldValue: string | null;
  /** New value, stringified; null when the field is null after. */
  newValue: string | null;
}

/**
 * The scalar PullRequest fields that participate in the audit trail. Explicit
 * allowlist (see file header for why). `heartbeatAt` is intentionally absent —
 * it is never audited.
 */
export const AUDITED_FIELDS: ReadonlyArray<keyof PullRequest> = [
  "repo",
  "prNumber",
  "staged",
  "state",
  "reviewState",
  "commitSha",
  "reviewedCommitSha",
  "patchCycles",
  "reviewCycles",
  "agentId",
  "reviewedAt",
  "patchedAt",
  "mergedAt",
  "prCreatedAt",
  "claimedBy",
  "claimedAt",
  "phase",
  "readyForReviewAt",
  "readyForPatchAt",
  "readyForDeployAt",
  "blocked",
  "blockedReason",
  "skipCount",
  "lastSkippedAt",
  "lastCiFailureSignature",
  "consecutiveCiFailureCount",
];

/** Stringify a scalar field value for storage as an event's old/new value. */
function toEventValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Compute the field-level diff between two PR states. Returns one entry per
 * audited field whose value changed (compared by stringified value, so
 * null/undefined are treated identically and no-op writes produce nothing).
 *
 * When `before` is null (the create-path in claim()), the record is brand new
 * and there is no meaningful prior state to diff against; we return [] so PR
 * creation is not logged as a wall of "null → value" events. The acceptance
 * criteria only require auditing transitions of existing records, and a
 * creation is already captured by the PullRequest row's own createdAt.
 */
export function computePrTransitionDiff(
  before: PullRequest | null,
  after: PullRequest,
): PrTransitionChange[] {
  if (before === null) return [];

  const changes: PrTransitionChange[] = [];
  for (const field of AUDITED_FIELDS) {
    const oldValue = toEventValue(before[field]);
    const newValue = toEventValue(after[field]);
    if (oldValue !== newValue) {
      changes.push({ field: String(field), oldValue, newValue });
    }
  }
  return changes;
}
