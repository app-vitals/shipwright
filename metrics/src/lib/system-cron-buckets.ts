/**
 * metrics/src/lib/system-cron-buckets.ts
 * Pure bucket rules for the system-cron work metrics (SCM-8.3).
 *
 * A cron task lands in exactly one bucket, derived from the task's status and
 * its linked PR's state only — never from an outcome field or PR size.
 * Precedence, first match wins:
 *   1. shipped   PR merged, or task merged | deployed | released
 *   2. failed    task cancelled
 *   3. stuck     task blocked, or PR open for >= 24h
 *   4. inFlight  PR open for < 24h
 *   5. noOp      task done with no PR
 *   6. pending   everything else
 */

import type { PrRecord, TaskRecord } from "./task-store-client.ts";

/** A PR open for this long (inclusive) is stuck; younger is in flight. */
export const IN_FLIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CronBucket =
  | "shipped"
  | "inFlight"
  | "stuck"
  | "failed"
  | "noOp"
  | "pending";

export const CRON_BUCKETS: readonly CronBucket[] = [
  "shipped",
  "inFlight",
  "stuck",
  "failed",
  "noOp",
  "pending",
];

const SHIPPED_STATUSES = new Set(["merged", "deployed", "released"]);

/** The slice of a task the rules read. */
export interface BucketTask {
  status: string;
  pr?: TaskRecord["pr"];
  prCreatedAt?: TaskRecord["prCreatedAt"];
}
/** The slice of a PR the rules read. */
export interface BucketPr {
  state?: PrRecord["state"] | string;
  createdAt?: PrRecord["createdAt"];
}

/** True when the task counts as shipped (PR merged or task past merge). */
export function isShipped(task: BucketTask, pr: BucketPr | undefined): boolean {
  return pr?.state === "merged" || SHIPPED_STATUSES.has(task.status);
}

export function classifyCronTask(
  task: BucketTask,
  pr: BucketPr | undefined,
  nowMs: number,
): CronBucket {
  if (isShipped(task, pr)) return "shipped";
  if (task.status === "cancelled") return "failed";
  if (task.status === "blocked") return "stuck";

  // Open-PR age: the PR record when present, else (PR record not synced yet)
  // the task's own pr_open / approved status with its prCreatedAt.
  let openSince: string | null | undefined;
  if (pr) {
    openSince = pr.state === "open" ? pr.createdAt : undefined;
  } else if (task.status === "pr_open" || task.status === "approved") {
    openSince = task.prCreatedAt;
  }
  if (openSince) {
    const ageMs = nowMs - Date.parse(openSince);
    if (!Number.isNaN(ageMs)) {
      return ageMs >= IN_FLIGHT_MAX_AGE_MS ? "stuck" : "inFlight";
    }
  }

  if (task.status === "done" && (task.pr === null || task.pr === undefined)) {
    return "noOp";
  }
  return "pending";
}

const SLOT_RE = /^\d{8}T\d{6}Z$/;

/**
 * The fired slot (YYYYMMDDTHHMMSSZ) embedded in a system-cron task id
 * `SC-<cronId>-<slot>-<owner>-<name>`, or null when the id is not one of
 * `cronId`'s tasks.
 */
export function slotOf(taskId: string, cronId: string): string | null {
  const prefix = `SC-${cronId}-`;
  if (!taskId.startsWith(prefix)) return null;
  const slot = taskId.slice(prefix.length, prefix.length + 16);
  return SLOT_RE.test(slot) && taskId[prefix.length + 16] === "-" ? slot : null;
}
