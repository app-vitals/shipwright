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

/**
 * Every valid task status — the union of open and closed. Mirrors the
 * `TaskStatus` enum in prisma/schema.prisma; keep the two in sync.
 */
export const ALL_STATUSES = [...OPEN_STATUSES, ...CLOSED_STATUSES] as const;

export type TaskStatusValue = (typeof ALL_STATUSES)[number];

/**
 * Aliases accepted at the API write boundary and normalized to a canonical
 * status before persistence.
 *
 * "completed" is the terminal status LLM-based workers most often improvise
 * when finishing a task — it is not in the enum, so a raw `status:"completed"`
 * write reaches Prisma and 500s, which cheap workers exit on before any
 * fallback, leaving the task stuck `in_progress` for the stale-claim reaper to
 * re-dispatch. Mapping it to "done" lets the worker's first completion write
 * terminalize the task. No schema migration — the alias resolves before Prisma.
 */
export const STATUS_ALIASES: Record<string, TaskStatusValue> = {
  completed: "done",
};

/** Resolve a status alias to its canonical value; pass non-aliases through. */
export function normalizeStatus(status: string): string {
  return STATUS_ALIASES[status] ?? status;
}

/** True when `status` is a canonical (post-normalization) TaskStatus value. */
export function isValidStatus(status: string): boolean {
  return (ALL_STATUSES as readonly string[]).includes(status);
}
