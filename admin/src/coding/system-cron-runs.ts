/**
 * admin/src/coding/system-cron-runs.ts
 * Pure row formatting for the system-crons settings page's "Recent runs" list
 * (SCR-1.10): one line per claimed trigger, from the task-store's
 * GET /system-crons/:id/triggers (SCR-1.9). Dependency-free so it is
 * unit-testable.
 */

/** A claimed trigger as returned by GET /system-crons/:id/triggers. */
export interface SystemCronTrigger {
  scheduledFor: string;
  claimedAt: string;
  taskCount: number;
}

/** How many recent triggers the page shows per definition. */
export const RECENT_RUNS_LIMIT = 5;

/** "2026-11-14T09:00:00.000Z" → "2026-11-14 09:00 UTC"; unparseable input is returned as-is. */
export function formatScheduledFor(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatTaskCount(n: number): string {
  return `${n} ${n === 1 ? "task" : "tasks"} created`;
}

/** Plain-text row, e.g. "2026-11-14 09:00 UTC — 2 tasks created". */
export function formatTriggerRow(t: SystemCronTrigger): string {
  return `${formatScheduledFor(t.scheduledFor)} — ${formatTaskCount(t.taskCount)}`;
}

/** Newest first by scheduledFor, capped at `limit`; does not mutate the input. */
export function recentTriggers(
  triggers: SystemCronTrigger[],
  limit = RECENT_RUNS_LIMIT,
): SystemCronTrigger[] {
  return [...triggers]
    .sort((a, b) => Date.parse(b.scheduledFor) - Date.parse(a.scheduledFor))
    .slice(0, limit);
}
