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
import {
  inWindow,
  type PrRecord,
  prAnchor,
  type TaskRecord,
  taskAnchor,
  type TaskStoreClient,
} from "../lib/task-store-client.ts";

// ─── Task store double ────────────────────────────────────────────────────────
//
// Window-filtering helpers (`taskAnchor`, `prAnchor`, `inWindow`) live in
// task-store-client.ts so the cassette double and the live HTTP client apply
// byte-identical date-range filtering — the double must mirror production, not
// reimplement it.

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
      return inWindow(prAnchor(p), params);
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
