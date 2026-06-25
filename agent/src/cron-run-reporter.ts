/**
 * CronRunReporter — reports cron run outcomes to the admin API.
 *
 * HttpCronRunReporter: production implementation, fire-and-forget.
 * NoopCronRunReporter: testing / default when not configured.
 */

export interface CronRunPayload {
  cronId: string;
  startedAt: Date;
  completedAt: Date;
  skipped: boolean;
  skipReason?: string;
  outcome?: string;
  error?: string;
}

export interface CronRunReporter {
  report(run: CronRunPayload): Promise<void>;
}

export interface HttpCronRunReporterOptions {
  apiUrl: string;
  agentId: string;
  apiKey: string;
}

export class HttpCronRunReporter implements CronRunReporter {
  constructor(private opts: HttpCronRunReporterOptions) {}

  async report(run: CronRunPayload): Promise<void> {
    const { apiUrl, agentId, apiKey } = this.opts;
    const url = `${apiUrl}/agents/${agentId}/crons/${run.cronId}/runs`;

    const body: Record<string, unknown> = {
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt.toISOString(),
      skipped: run.skipped,
    };
    if (run.skipReason !== undefined) body.skipReason = run.skipReason;
    if (run.outcome !== undefined) body.outcome = run.outcome;
    if (run.error !== undefined) body.error = run.error;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(
          `[cron-run-reporter] POST ${url} returned ${res.status} — swallowing`,
        );
      }
    } catch (err) {
      console.warn(
        `[cron-run-reporter] failed to report run for cron ${run.cronId}: ${String(err)} — swallowing`,
      );
    }
  }
}

export class NoopCronRunReporter implements CronRunReporter {
  async report(_run: CronRunPayload): Promise<void> {
    // intentional no-op
  }
}
