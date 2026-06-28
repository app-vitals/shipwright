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

// ─── Inline record types (no Prisma dependency) ──────────────────────────────

/**
 * Slim Task record — only the fields the metrics provider reads. Terminal /
 * completed statuses are `merged | done | deployed | deploying`; `blocked` is
 * blocked; `in_progress | pr_open | approved` are mid-flight.
 */
export interface TaskRecord {
  id: string;
  status: string;
  session?: string | null;
  layer?: string | null;
  /** Estimated hours for the task. */
  hours?: number | null;
  complexity?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  mergedAt?: string | null;
  prCreatedAt?: string | null;
  ciFixAttempts?: number | null;
  simplifyTotal?: number | null;
  addedAt?: string | null;
}

/**
 * Slim PR record — drives review-derived metrics. `reviewState` takes the live
 * task-store values `approved | posted | pending` (an `approved` review is the
 * "ship it" equivalent). The store records no per-PR findings count, so
 * `avg_review_findings` is emitted as null by this provider.
 */
export interface PrRecord {
  id?: string;
  taskId?: string | null;
  reviewState?: string | null;
  createdAt?: string | null;
  mergedAt?: string | null;
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
  }): Promise<TaskRecord[]>;
  listPrs(params: {
    from?: string;
    to?: string;
    reviewState?: string;
  }): Promise<PrRecord[]>;
}

// ─── Window filtering ─────────────────────────────────────────────────────────
//
// The live task store ignores `from`/`to` query params (the `/tasks` and `/prs`
// routes read only `limit`/`offset`), so the client must window-filter the rows
// it fetches. These helpers are the single source of truth for that filtering —
// the recorded test double imports them so the cassette path and the live HTTP
// path apply byte-identical windowing.

/** Pick the timestamp a task is "anchored" to for window filtering. */
export function taskAnchor(t: TaskRecord): string | null {
  return t.completedAt ?? t.mergedAt ?? t.startedAt ?? t.addedAt ?? null;
}

/** Pick the timestamp a PR is "anchored" to for window filtering. */
export function prAnchor(p: PrRecord): string | null {
  return p.mergedAt ?? p.createdAt ?? null;
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

/** Envelope shape returned by the paginated `/tasks` and `/prs` list routes. */
interface PageEnvelope<T> {
  total?: number;
  limit?: number;
  offset?: number;
  // The data array lives under a route-specific key (`tasks` or `prs`).
  [key: string]: T[] | number | undefined;
}

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
   * a single request drops every record beyond that page. This loops on
   * `offset`, requesting `PAGE_SIZE` rows at a time, until the accumulated count
   * reaches the reported `total` (or a short page signals the end). `total`,
   * `limit`, and `offset` are read defensively so a server that omits them still
   * terminates rather than looping forever.
   */
  private async fetchAllPages<T>(
    path: string,
    dataKey: "tasks" | "prs",
    baseParams: Record<string, string | undefined>,
  ): Promise<T[]> {
    const all: T[] = [];
    let offset = 0;
    // Hard cap on iterations as a belt-and-suspenders guard against a server
    // that never advances past the same page.
    for (let guard = 0; guard < 10_000; guard++) {
      const params = {
        ...baseParams,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      };
      const res = await this.fetch<PageEnvelope<T>>(
        `${path}${HttpTaskStoreClient.query(params)}`,
      );
      const page = (res[dataKey] as T[] | undefined) ?? [];
      all.push(...page);

      const total = typeof res.total === "number" ? res.total : undefined;
      const pageLimit =
        typeof res.limit === "number" && res.limit > 0 ? res.limit : PAGE_SIZE;

      // Stop when we've collected the reported total, or the page came back
      // shorter than the limit (last page), or the page was empty.
      if (page.length === 0) break;
      if (total !== undefined && all.length >= total) break;
      if (page.length < pageLimit) break;
      offset += page.length;
    }
    return all;
  }

  async listTasks(params: {
    from?: string;
    to?: string;
    status?: string;
  }): Promise<TaskRecord[]> {
    // `from`/`to` are ignored by the live route — only `status` narrows server
    // side; the date window is applied client-side below.
    const tasks = await this.fetchAllPages<TaskRecord>("/tasks", "tasks", {
      status: params.status,
    });
    return tasks.filter((t) => inWindow(taskAnchor(t), params));
  }

  async listPrs(params: {
    from?: string;
    to?: string;
    reviewState?: string;
  }): Promise<PrRecord[]> {
    const prs = await this.fetchAllPages<PrRecord>("/prs", "prs", {
      reviewState: params.reviewState,
    });
    return prs.filter((p) => inWindow(prAnchor(p), params));
  }
}
