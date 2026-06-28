/**
 * metrics/src/providers/task-store-recorded.ts
 * Recorded test doubles for the TaskStoreProvider's two upstream clients.
 *
 * RecordedTaskStoreClient + RecordedAdminMetricsClient replay cassette data
 * deterministically (mirrors createFixturePostHogClient). They make no network
 * calls. The task-store double applies the same from/to window filtering a real
 * server would, so date-range tests exercise real filtering logic over the
 * cassette rows.
 */

import type {
  AdminMetricsClient,
  ChatTokenStats,
  CronRunTokenStats,
} from "../lib/admin-metrics-client.ts";
import type {
  PrRecord,
  TaskRecord,
  TaskStoreClient,
} from "../lib/task-store-client.ts";

// ─── Task store double ────────────────────────────────────────────────────────

/** Pick the timestamp a task is "anchored" to for window filtering. */
function taskAnchor(t: TaskRecord): string | null {
  return t.completedAt ?? t.mergedAt ?? t.startedAt ?? t.addedAt ?? null;
}

function inWindow(
  iso: string | null | undefined,
  params: { from?: string; to?: string },
): boolean {
  if (!iso) return params.from === undefined && params.to === undefined;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (params.from !== undefined && t < new Date(params.from).getTime())
    return false;
  if (params.to !== undefined && t > new Date(params.to).getTime())
    return false;
  return true;
}

export class RecordedTaskStoreClient implements TaskStoreClient {
  constructor(
    private readonly tasks: TaskRecord[],
    private readonly prs: PrRecord[],
  ) {}

  async listTasks(params: {
    from?: string;
    to?: string;
    status?: string;
  }): Promise<TaskRecord[]> {
    return this.tasks.filter((t) => {
      if (params.status && t.status !== params.status) return false;
      return inWindow(taskAnchor(t), params);
    });
  }

  async listPrs(params: {
    from?: string;
    to?: string;
    reviewState?: string;
  }): Promise<PrRecord[]> {
    return this.prs.filter((p) => {
      if (params.reviewState && p.reviewState !== params.reviewState)
        return false;
      return inWindow(p.mergedAt ?? p.createdAt, params);
    });
  }
}

// ─── Admin metrics double ─────────────────────────────────────────────────────

export class RecordedAdminMetricsClient implements AdminMetricsClient {
  constructor(
    private readonly cron: CronRunTokenStats,
    private readonly chat: ChatTokenStats,
  ) {}

  async cronRunTokenStats(): Promise<CronRunTokenStats> {
    return this.cron;
  }

  async chatTokenStats(): Promise<ChatTokenStats> {
    return this.chat;
  }
}
