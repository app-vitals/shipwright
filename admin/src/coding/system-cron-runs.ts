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

// ─── Per-repo run history (PCR-5.1) ──────────────────────────────────────────

/**
 * The fields of a GET /cron-runs record the page reads. Deliberately omits
 * `machineState`: it is never rendered, and `pickRepoRun` drops it even if a
 * caller passes the full record.
 */
export interface RepoRunSummary {
  repo: string;
  outcome: "ok" | "no_op" | "failed";
  finishedAt: string;
  commitSha: string;
  metrics: Record<string, number>;
}

/** Latest run per in-scope repo; `null` = never run, `undefined` entry = fetch failed. */
export type RepoRunHistory = Record<string, RepoRunSummary | null | undefined>;

/** Repos fetched concurrently per definition. */
export const REPO_FETCH_BATCH = 10;

/** Copies only the displayable fields, so nothing else (machineState) can leak into HTML. */
export function pickRepoRun(r: RepoRunSummary): RepoRunSummary {
  return {
    repo: r.repo,
    outcome: r.outcome,
    finishedAt: r.finishedAt,
    commitSha: r.commitSha,
    metrics: { ...r.metrics },
  };
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** "scanned 12 · auto 2" — keys sorted, capped at `max` entries. */
export function formatMetrics(
  metrics: Record<string, number>,
  max = 4,
): string {
  const entries = Object.entries(metrics).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const shown = entries.slice(0, max).map(([k, v]) => `${k} ${v}`);
  if (entries.length > max) shown.push(`+${entries.length - max} more`);
  return shown.join(" · ");
}
