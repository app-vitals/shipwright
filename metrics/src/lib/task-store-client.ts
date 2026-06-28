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

/** Slim PR record — drives review (SHIP IT) derived metrics. */
export interface PrRecord {
  id?: string;
  taskId?: string | null;
  reviewState?: string | null;
  /** Number of review findings, when recorded. */
  findings?: number | null;
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

// ─── HTTP implementation ──────────────────────────────────────────────────────

export class HttpTaskStoreClient implements TaskStoreClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  private async fetch<T>(path: string): Promise<T> {
    const res = await globalThis.fetch(`${this.baseUrl}${path}`, {
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

  async listTasks(params: {
    from?: string;
    to?: string;
    status?: string;
  }): Promise<TaskRecord[]> {
    const res = await this.fetch<{ tasks: TaskRecord[] }>(
      `/tasks${HttpTaskStoreClient.query(params)}`,
    );
    return res.tasks ?? [];
  }

  async listPrs(params: {
    from?: string;
    to?: string;
    reviewState?: string;
  }): Promise<PrRecord[]> {
    const res = await this.fetch<{ items: PrRecord[] }>(
      `/prs${HttpTaskStoreClient.query(params)}`,
    );
    return res.items ?? [];
  }
}
