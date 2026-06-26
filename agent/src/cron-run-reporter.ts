/**
 * CronRunReporter — reports cron run outcomes to the admin API.
 *
 * Two-step interface:
 *   1. createRun()  — POST at run start, returns runId (or null on error)
 *   2. completeRun() / skipRun() — PATCH at run completion
 *
 * HttpCronRunReporter: production implementation, fire-and-forget.
 * NoopCronRunReporter: testing / default when not configured.
 */

export interface CronRunReporter {
  /** Called at run start — returns the runId to use for completion (null for no-op). */
  createRun(cronId: string, startedAt: Date): Promise<string | null>;
  /** Called when run completes (success or error). Includes token data for non-error. */
  completeRun(
    cronId: string,
    runId: string | null,
    completedAt: Date,
    outcome: "completed" | "failed",
    opts?: {
      error?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
      model?: string;
    },
  ): Promise<void>;
  /** Called when precheck causes a skip. No token data. */
  skipRun(
    cronId: string,
    runId: string | null,
    completedAt: Date,
    skipReason: string,
    opts?: { error?: string },
  ): Promise<void>;
}

export interface HttpCronRunReporterOptions {
  apiUrl: string;
  agentId: string;
  apiKey: string;
}

export class HttpCronRunReporter implements CronRunReporter {
  constructor(private opts: HttpCronRunReporterOptions) {}

  async createRun(cronId: string, startedAt: Date): Promise<string | null> {
    const { apiUrl, agentId, apiKey } = this.opts;
    const url = `${apiUrl}/agents/${agentId}/crons/${cronId}/runs`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ startedAt: startedAt.toISOString() }),
      });
      if (!res.ok) {
        console.warn(
          `[cron-run-reporter] POST ${url} returned ${res.status} — swallowing`,
        );
        return null;
      }
      const data = (await res.json()) as { run: { id: string } };
      return data.run.id;
    } catch (err) {
      console.warn(
        `[cron-run-reporter] failed to create run for cron ${cronId}: ${String(err)} — swallowing`,
      );
      return null;
    }
  }

  async completeRun(
    cronId: string,
    runId: string | null,
    completedAt: Date,
    outcome: "completed" | "failed",
    opts?: {
      error?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
      model?: string;
    },
  ): Promise<void> {
    if (runId === null) return;

    const { apiUrl, agentId, apiKey } = this.opts;
    const url = `${apiUrl}/agents/${agentId}/crons/${cronId}/runs/${runId}`;

    const body: Record<string, unknown> = {
      completedAt: completedAt.toISOString(),
      outcome,
    };
    if (opts?.error !== undefined) body.error = opts.error;
    if (opts?.inputTokens !== undefined) body.inputTokens = opts.inputTokens;
    if (opts?.outputTokens !== undefined) body.outputTokens = opts.outputTokens;
    if (opts?.cacheReadTokens !== undefined)
      body.cacheReadTokens = opts.cacheReadTokens;
    if (opts?.cacheCreationTokens !== undefined)
      body.cacheCreationTokens = opts.cacheCreationTokens;
    if (opts?.costUsd !== undefined) body.costUsd = opts.costUsd;
    if (opts?.model !== undefined) body.model = opts.model;

    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(
          `[cron-run-reporter] PATCH ${url} returned ${res.status} — swallowing`,
        );
      }
    } catch (err) {
      console.warn(
        `[cron-run-reporter] failed to complete run ${runId} for cron ${cronId}: ${String(err)} — swallowing`,
      );
    }
  }

  async skipRun(
    cronId: string,
    runId: string | null,
    completedAt: Date,
    skipReason: string,
    opts?: { error?: string },
  ): Promise<void> {
    if (runId === null) return;

    const { apiUrl, agentId, apiKey } = this.opts;
    const url = `${apiUrl}/agents/${agentId}/crons/${cronId}/runs/${runId}`;

    const body: Record<string, unknown> = {
      completedAt: completedAt.toISOString(),
      skipped: true,
      skipReason,
    };
    if (opts?.error !== undefined) body.error = opts.error;

    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(
          `[cron-run-reporter] PATCH ${url} returned ${res.status} — swallowing`,
        );
      }
    } catch (err) {
      console.warn(
        `[cron-run-reporter] failed to skip run ${runId} for cron ${cronId}: ${String(err)} — swallowing`,
      );
    }
  }
}

export class NoopCronRunReporter implements CronRunReporter {
  async createRun(_cronId: string, _startedAt: Date): Promise<string | null> {
    return null;
  }

  async completeRun(
    _cronId: string,
    _runId: string | null,
    _completedAt: Date,
    _outcome: "completed" | "failed",
    _opts?: {
      error?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      costUsd?: number;
      model?: string;
    },
  ): Promise<void> {
    // intentional no-op
  }

  async skipRun(
    _cronId: string,
    _runId: string | null,
    _completedAt: Date,
    _skipReason: string,
    _opts?: { error?: string },
  ): Promise<void> {
    // intentional no-op
  }
}
