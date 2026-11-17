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

import {
  type AdminMetricsClient,
  AdminMetricsClientError,
  type ChatTokenStats,
  type CronRunTokenStats,
} from "../lib/admin-metrics-client.ts";
import {
  type CoverageSnapshotRecord,
  inWindow,
  matchesRepo,
  type PrRecord,
  prAnchor,
  type TaskRecord,
  type TaskStoreClient,
  taskAnchor,
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
    private readonly coverage: CoverageSnapshotRecord[] = [],
  ) {}

  async listTasks(params: {
    from?: string;
    to?: string;
    status?: string;
    repo?: string;
  }): Promise<TaskRecord[]> {
    return this.tasks.filter((t) => {
      if (params.status && t.status !== params.status) return false;
      if (!matchesRepo(t.repo, params.repo)) return false;
      return inWindow(taskAnchor(t), params);
    });
  }

  async listPrs(params: {
    from?: string;
    to?: string;
    reviewState?: string;
    repo?: string;
    state?: string;
  }): Promise<PrRecord[]> {
    return this.prs.filter((p) => {
      if (params.reviewState && p.reviewState !== params.reviewState)
        return false;
      if (params.state && p.state !== params.state) return false;
      if (!matchesRepo(p.repo, params.repo)) return false;
      return inWindow(prAnchor(p), params);
    });
  }

  async listLatestCoverage(params: {
    repo?: string;
  }): Promise<CoverageSnapshotRecord[]> {
    const newest = new Map<string, CoverageSnapshotRecord>();
    for (const s of this.coverage) {
      if (!matchesRepo(s.repo, params.repo)) continue;
      const cur = newest.get(s.repo);
      if (!cur || s.measuredAt > cur.measuredAt) newest.set(s.repo, s);
    }
    return [...newest.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  }

  async listCoverageHistory(params: {
    repo?: string;
    since?: string;
    limit?: number;
  }): Promise<CoverageSnapshotRecord[]> {
    const since =
      params.since === undefined ? undefined : new Date(params.since).getTime();
    const rows = this.coverage
      .filter(
        (s) =>
          matchesRepo(s.repo, params.repo) &&
          (since === undefined || new Date(s.measuredAt).getTime() >= since),
      )
      .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt));
    return params.limit === undefined ? rows : rows.slice(0, params.limit);
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

// ─── Faulting doubles for graceful degradation tests ────────────────────────

export class FaultingCronAdminMetricsClient implements AdminMetricsClient {
  constructor(
    _cron: CronRunTokenStats,
    private readonly chat: ChatTokenStats,
  ) {}

  async cronRunTokenStats(): Promise<CronRunTokenStats> {
    throw new AdminMetricsClientError(500, "cron stats endpoint failed");
  }

  async chatTokenStats(): Promise<ChatTokenStats> {
    return this.chat;
  }
}

export class FaultingChatAdminMetricsClient implements AdminMetricsClient {
  constructor(
    private readonly cron: CronRunTokenStats,
    _chat: ChatTokenStats,
  ) {}

  async cronRunTokenStats(): Promise<CronRunTokenStats> {
    return this.cron;
  }

  async chatTokenStats(): Promise<ChatTokenStats> {
    throw new AdminMetricsClientError(500, "chat stats endpoint failed");
  }
}

export class FaultingBothAdminMetricsClient implements AdminMetricsClient {
  async cronRunTokenStats(): Promise<CronRunTokenStats> {
    throw new AdminMetricsClientError(500, "cron stats endpoint failed");
  }

  async chatTokenStats(): Promise<ChatTokenStats> {
    throw new AdminMetricsClientError(500, "chat stats endpoint failed");
  }
}
