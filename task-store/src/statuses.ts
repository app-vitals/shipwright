/**
 * task-store/src/statuses.ts
 *
 * Shared task status constants. Extracted here so that both task-service.ts
 * and blocked-by.ts can import from a single source of truth, eliminating
 * any risk of silent drift when new statuses are added.
 */

/** Terminal statuses — a task in one of these is considered "closed". */
export const CLOSED_STATUSES = [
  "merged",
  "done",
  "deploying",
  "deployed",
  "cancelled",
] as const;

/** Open statuses — everything not closed. */
export const OPEN_STATUSES = [
  "pending",
  "in_progress",
  "pr_open",
  "approved",
  "blocked",
] as const;
