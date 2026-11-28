/**
 * metrics/src/lib/task-store-client.ts
 * Slim read-only HTTP client for the Shipwright task-store service.
 *
 * The metrics TaskStoreProvider reads tasks + PR records from the task store to
 * compute the task-derived metric kinds. Mirrors the accounts-client.ts pattern:
 * a slim interface, inline record types (no Prisma import), and an
 * Http<Thing>Client that strips trailing slashes, sends Bearer auth, and throws
 * a typed error on non-2xx.
 *
 * Usage:
 *   const client = new HttpTaskStoreClient(taskStoreUrl, taskStoreToken);
 *   const tasks = await client.listTasks({ from, to });
 */

import type { components } from "../../../admin/src/coding/task-store-types.ts";

// ─── Record types derived from the generated task-store schema ───────────────
//
// TaskRecord/PrRecord are Pick<>'d from the OpenAPI-generated
// components["schemas"]["Task"] / ["PullRequest"] types (@app-vitals/agent-lib/
// task-store-types) rather than hand-rolled — the field list below is exactly
// the subset the metrics provider reads. The generated schema marks several
// of these fields as required (e.g. Task.status/createdAt,
// PullRequest.id/repo/reviewState/createdAt/...) because every row the *store*
// returns always has them; metrics code and its fixtures/tests, however,
// build partial literals (e.g. a PR fixture with no `id`), so each Pick is
// widened back to optional via `Partial<...>` for exactly the fields that
// need it — preserving the same shape metrics has always read.

type TaskSchema = components["schemas"]["Task"];
type PullRequestSchema = components["schemas"]["PullRequest"];

/** Fields required on the generated Task schema that TaskRecord treats as optional. */
type TaskOptionalOverrides = Pick<TaskSchema, "createdAt">;

/**
 * Slim Task record — only the fields the metrics provider reads. Terminal /
 * completed statuses are `merged | done | deployed | released`; `blocked` is
 * blocked; `in_progress | pr_open | approved` are mid-flight.
 */
export type TaskRecord = Pick<
  TaskSchema,
  | "id"
  | "status"
  | "session"
  | "layer"
  | "repo"
  | "hours"
  | "complexity"
  | "startedAt"
  | "completedAt"
  | "mergedAt"
  | "prCreatedAt"
  | "ciFixAttempts"
  | "simplifyTotal"
  | "model"
  | "effortLevel"
  | "coverageDelta"
  | "simplifyDry"
  | "simplifyDeadCode"
  | "simplifyNaming"
  | "simplifyComplexity"
  | "simplifyConsistency"
  | "pr"
  | "source"
  | "originKind"
  | "originRef"
> &
  Partial<TaskOptionalOverrides>;

/** Fields required on the generated PullRequest schema that PrRecord treats as optional. */
type PrOptionalOverrides = Pick<
  PullRequestSchema,
  | "id"
  | "repo"
  | "reviewState"
  | "createdAt"
  | "reviewCycles"
  | "patchCycles"
  | "prNumber"
  | "state"
  | "origin"
  | "authorLogin"
  | "headRef"
  | "title"
>;

/**
 * Slim PR record — drives review-derived metrics. `reviewState` takes the live
 * task-store values `approved | posted | pending` (an `approved` review is the
 * "ship it" equivalent). The store records no per-PR findings count, so
 * `avg_review_findings` is emitted as null by this provider. `state`
 * (`open | merged | closed`) and `origin` (POM-1.1's `shipwright | ci |
 * dependency_bot | human | unknown | null`) drive the merged-PRs-by-repo
 * metric (POM-2.1); `authorLogin`/`headRef`/`title` are carried through for
 * completeness but not currently read by any provider query. `commitCount`/
 * `commitsDocsRefresh`/`commitsReviewPatch`/`commitsCiFix`/
 * `commitsImplementation` (CPP-1.1's census-sweep-only columns) drive the
 * merged-PRs-by-repo commits-per-PR aggregation (CPP-1.3).
 */
export type PrRecord = Pick<PullRequestSchema, "mergedAt"> &
  Partial<
    PrOptionalOverrides &
      Pick<
        PullRequestSchema,
        | "commitCount"
        | "commitsDocsRefresh"
        | "commitsReviewPatch"
        | "commitsCiFix"
        | "commitsImplementation"
      >
  >;

/**
 * Slim coverage snapshot record (CVT-3.1) — only the fields the metrics
 * coverage query reads from GET /coverage-snapshots[/latest]. The percentages
 * are computed server-side; `branchesPct`/`functionsPct` are null when the
 * reporter supplied no branch/function counts.
 */
export interface CoverageSnapshotRecord {
  repo: string;
  commitSha: string;
  linesPct: number;
  branchesPct: number | null;
  functionsPct: number | null;
  measuredAt: string;
}

/**
 * Fleet readiness roll-up (RDY-5.1) — the response of the task store's
 * GET /readiness/summary (RDY-4.1), passed through unchanged. `ownerRunning`
 * is computed server-side; `percentAtOrAboveFloor` is null with no fresh repo.
 */
export interface ReadinessFailingCheck {
  id: string;
  level: number;
  owner: string;
  ownerRunning: boolean;
}

export interface ReadinessRepoRecord {
  repo: string;
  level: number;
  failingChecks: ReadinessFailingCheck[];
  scoredAt: string;
  stale: boolean;
}

export interface ReadinessTrendPoint {
  weekStart: string;
  weekEnd: string;
  percentAtOrAboveFloor: number | null;
  repoCount: number;
}

export interface ReadinessSummaryRecord {
  percentAtOrAboveFloor: number | null;
  repoCount: number;
  staleCount: number;
  levelDistribution: Record<string, number>;
  repos: ReadinessRepoRecord[];
  trend: ReadinessTrendPoint[];
}

/**
 * Slim system-cron definition (GET /system-crons, admin-only) — the registry
 * the system-cron metrics list one row per.
 */
export interface SystemCronRecord {
  id: string;
  accountId: string;
  name: string;
  schedule: string;
  enabled: boolean;
}

/** Filters for the cron-task read: originKind=cron + originRef + createdAt range. */
export interface CronTaskQuery {
  /** SystemCronDefinition id (Task.originRef). */
  originRef: string;
  /** Inclusive ISO lower bound on Task.createdAt. */
  createdFrom: string;
  /** Inclusive ISO upper bound on Task.createdAt. */
  createdTo: string;
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class TaskStoreClientError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(`[${statusCode}] ${message}`);
    this.name = "TaskStoreClientError";
  }
}

// ─── Slim interface ───────────────────────────────────────────────────────────

export interface TaskStoreClient {
  listTasks(params: {
    from?: string;
    to?: string;
    status?: string;
    repo?: string;
  }): Promise<TaskRecord[]>;
  listPrs(params: {
    from?: string;
    to?: string;
    reviewState?: string;
    repo?: string;
    state?: string;
  }): Promise<PrRecord[]>;
  /**
   * Every registered system-cron definition (GET /system-crons). Needs a
   * token with account-wide visibility (an admin token): agent tokens are
   * rejected, and scoped tokens see only a slice of the tasks.
   */
  listSystemCrons(): Promise<SystemCronRecord[]>;
  /**
   * Cron-origin tasks (GET /tasks?originKind=cron&originRef=&createdFrom=
   * &createdTo=), every page. Filtered server-side on createdAt, so — unlike
   * listTasks — no anchor-based client windowing is applied.
   */
  listCronTasks(query: CronTaskQuery): Promise<TaskRecord[]>;
  /**
   * PRs updated at/after `since` (GET /prs?updatedSince=), every page, with no
   * anchor-based client windowing — the caller joins them to tasks by
   * repo + prNumber.
   */
  listPrsUpdatedSince(since: string): Promise<PrRecord[]>;
  /** Newest snapshot per repo (GET /coverage-snapshots/latest). */
  listLatestCoverage(params: {
    repo?: string;
  }): Promise<CoverageSnapshotRecord[]>;
  /**
   * Snapshot history, newest first (GET /coverage-snapshots). With `limit`
   * only that many are returned (one page); without it every page is walked.
   */
  listCoverageHistory(params: {
    repo?: string;
    since?: string;
    limit?: number;
  }): Promise<CoverageSnapshotRecord[]>;
  /** Fleet readiness roll-up (GET /readiness/summary). */
  getReadinessSummary(): Promise<ReadinessSummaryRecord>;
}

// ─── Window filtering ─────────────────────────────────────────────────────────
//
// The live task store accepts `updatedSince` (mapped from `from`) as a coarse,
// inclusive-only pre-filter — it has no window-end (`to`) equivalent and is not
// a precise sync anchor. The client must still window-filter the rows it
// fetches to apply the exact [from, to] boundary. These helpers are the single
// source of truth for that filtering — the recorded test double imports them
// so the cassette path and the live HTTP path apply byte-identical windowing.

/** Pick the timestamp a task is "anchored" to for window filtering. */
export function taskAnchor(t: TaskRecord): string | null {
  return t.completedAt ?? t.mergedAt ?? t.startedAt ?? t.createdAt ?? null;
}

/** Pick the timestamp a PR is "anchored" to for window filtering. */
export function prAnchor(p: PrRecord): string | null {
  return p.mergedAt ?? p.createdAt ?? null;
}

/**
 * True when a record belongs to `repo`. When `repo` is undefined the filter is
 * a no-op (every record matches). Records whose own `repo` is null/absent never
 * match a non-empty `repo` filter — public scoping must not leak un-attributed
 * rows. Shared by the live HTTP client and the recorded test double so both
 * paths scope identically.
 */
export function matchesRepo(
  recordRepo: string | null | undefined,
  repo: string | undefined,
): boolean {
  if (repo === undefined || repo === "") return true;
  return recordRepo === repo;
}

/**
 * True when `iso` falls inside the [from, to] window. A row with no anchor
 * timestamp is kept only when the window is fully open (no from and no to).
 */
export function inWindow(
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

// ─── HTTP implementation ──────────────────────────────────────────────────────

/** Page size requested per list call when paginating the live store. */
const PAGE_SIZE = 200;

/**
 * Envelope shape returned by the paginated `/tasks` and `/prs` list routes,
 * which follow the keyset contract: `nextCursor` is an opaque string passed
 * back as `?cursor=`, and null on the last page. The data array itself lives under a route-specific key (`tasks` or `prs`), typed
 * generically over `T` since fetchAllPages is shared by both routes.
 */
type PageEnvelope<T> = {
  /** Opaque keyset cursor for the next page; null on the last page. */
  nextCursor?: string | null;
  tasks?: T[];
  prs?: T[];
  snapshots?: T[];
};

/** Minimal `fetch` shape — injectable so the client is testable without
 * overriding any global (Bun shares the test process). Defaults to the
 * platform `fetch`. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export class HttpTaskStoreClient implements TaskStoreClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, apiKey: string, fetchImpl?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private async fetch<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new TaskStoreClientError(
        res.status,
        await res.text().catch(() => "unknown error"),
      );
    }
    return res.json() as Promise<T>;
  }

  private static query(params: Record<string, string | undefined>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, v);
    }
    const s = qs.toString();
    return s ? `?${s}` : "";
  }

  /**
   * Walk the paginated list route at `path` until every record is fetched.
   *
   * The live store defaults to a server `limit` (50) and truncates silently, so
   * a single request drops every record beyond that page. This requests
   * `PAGE_SIZE` rows at a time and follows the opaque `nextCursor` until it is
   * null (the only completeness signal).
   */
  private async fetchAllPages<T>(
    path: string,
    dataKey: "tasks" | "prs" | "snapshots",
    baseParams: Record<string, string | undefined>,
  ): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | null = null;
    // Hard cap on iterations as a belt-and-suspenders guard against a server
    // that never advances past the same page.
    for (let guard = 0; guard < 10_000; guard++) {
      const params: Record<string, string | undefined> = {
        ...baseParams,
        limit: String(PAGE_SIZE),
        cursor: cursor ?? undefined,
      };
      const res = await this.fetch<PageEnvelope<T>>(
        `${path}${HttpTaskStoreClient.query(params)}`,
      );
      all.push(...((res[dataKey] as T[] | undefined) ?? []));
      cursor = res.nextCursor ?? null;
      if (cursor === null) break;
    }
    return all;
  }

  async listTasks(params: {
    from?: string;
    to?: string;
    status?: string;
    repo?: string;
  }): Promise<TaskRecord[]> {
    // `updatedSince`/`repo` narrow server-side to cut down what's fetched over
    // the wire, but `updatedSince` is a conservative pre-filter (inclusive-only,
    // no window-end) rather than a precise sync anchor — the client-side
    // taskAnchor/inWindow/matchesRepo filtering below still runs as the precise
    // final filter, since `to` has no server-side equivalent.
    const tasks = await this.fetchAllPages<TaskRecord>("/tasks", "tasks", {
      status: params.status,
      updatedSince: params.from,
      repo: params.repo,
    });
    return tasks.filter(
      (t) =>
        matchesRepo(t.repo, params.repo) && inWindow(taskAnchor(t), params),
    );
  }

  async listPrs(params: {
    from?: string;
    to?: string;
    reviewState?: string;
    repo?: string;
    state?: string;
  }): Promise<PrRecord[]> {
    // Same server-side pre-filter / client-side precise-filter split as
    // listTasks() above. `state` (open|merged|closed) is a live GET /prs
    // query param — passed straight through server-side, same as
    // reviewState, with no client-side re-filter needed.
    const prs = await this.fetchAllPages<PrRecord>("/prs", "prs", {
      reviewState: params.reviewState,
      state: params.state,
      updatedSince: params.from,
      repo: params.repo,
    });
    return prs.filter(
      (p) => matchesRepo(p.repo, params.repo) && inWindow(prAnchor(p), params),
    );
  }

  async listSystemCrons(): Promise<SystemCronRecord[]> {
    const res = await this.fetch<{ systemCrons?: SystemCronRecord[] }>(
      "/system-crons",
    );
    return res.systemCrons ?? [];
  }

  async listCronTasks(query: CronTaskQuery): Promise<TaskRecord[]> {
    return this.fetchAllPages<TaskRecord>("/tasks", "tasks", {
      originKind: "cron",
      originRef: query.originRef,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
    });
  }

  async listPrsUpdatedSince(since: string): Promise<PrRecord[]> {
    return this.fetchAllPages<PrRecord>("/prs", "prs", {
      updatedSince: since,
    });
  }

  async listLatestCoverage(params: {
    repo?: string;
  }): Promise<CoverageSnapshotRecord[]> {
    // The latest route takes no repo filter, so scope client-side.
    const res = await this.fetch<{ snapshots?: CoverageSnapshotRecord[] }>(
      "/coverage-snapshots/latest",
    );
    return (res.snapshots ?? []).filter((s) =>
      matchesRepo(s.repo, params.repo),
    );
  }

  async listCoverageHistory(params: {
    repo?: string;
    since?: string;
    limit?: number;
  }): Promise<CoverageSnapshotRecord[]> {
    const baseParams = { repo: params.repo, since: params.since };
    if (params.limit !== undefined) {
      const res = await this.fetch<PageEnvelope<CoverageSnapshotRecord>>(
        `/coverage-snapshots${HttpTaskStoreClient.query({
          ...baseParams,
          limit: String(params.limit),
        })}`,
      );
      return res.snapshots ?? [];
    }
    return this.fetchAllPages<CoverageSnapshotRecord>(
      "/coverage-snapshots",
      "snapshots",
      baseParams,
    );
  }

  async getReadinessSummary(): Promise<ReadinessSummaryRecord> {
    return this.fetch<ReadinessSummaryRecord>("/readiness/summary");
  }
}
