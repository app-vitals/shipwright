/**
 * WorkQueueReporter — reports the loop orchestrator's per-tick ranked work
 * queue snapshot to the admin API: POST /agents/:agentId/work-queue.
 *
 * Mirrors CronRunReporter's fire-and-forget contract (never throws, swallows
 * non-2xx responses and thrown errors with console.warn) — but unlike
 * HttpCronRunReporter (which calls the global `fetch` directly and is only
 * covered by an integration test against a real Bun.serve stub), this
 * reporter accepts an injectable `fetchFn` so it can be unit-tested with a
 * stub, per the repo's test-isolation contract (no global.fetch overrides).
 *
 * HttpWorkQueueReporter: production implementation, fire-and-forget.
 * NoopWorkQueueReporter: testing / default when not configured.
 */

import type { RankedWorkItem } from "./work-selector.ts";

/** Cap on the number of items sent per snapshot POST. */
export const MAX_WORK_QUEUE_ITEMS = 50;

export interface WorkQueueSnapshot {
  computedAt: string;
  items: RankedWorkItem[];
}

export interface WorkQueueReporter {
  /**
   * Reports a single tick's ranked work-queue snapshot. Fire-and-forget:
   * never throws, never blocks the caller on a failed POST.
   *
   * `items` longer than MAX_WORK_QUEUE_ITEMS is truncated by dropping the
   * tail past the cap — since rankWorkItems() already returns items
   * oldest-first, "drop the tail" is equivalent to "keep the oldest (most
   * actionable) items".
   */
  reportSnapshot(snapshot: WorkQueueSnapshot): Promise<void>;
}

export interface HttpWorkQueueReporterOptions {
  apiUrl: string;
  agentId: string;
  apiKey: string;
  /** Injectable fetch — defaults to the global `fetch`. Never call the
   * global `fetch` identifier directly inside this class; always go through
   * `this.fetchFn` so tests can inject a stub without overriding globals. */
  fetchFn?: typeof fetch;
}

export class HttpWorkQueueReporter implements WorkQueueReporter {
  private readonly fetchFn: typeof fetch;

  constructor(private opts: HttpWorkQueueReporterOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async reportSnapshot(snapshot: WorkQueueSnapshot): Promise<void> {
    const { apiUrl, agentId, apiKey } = this.opts;
    const url = `${apiUrl}/agents/${agentId}/work-queue`;
    const body = {
      computedAt: snapshot.computedAt,
      items: snapshot.items.slice(0, MAX_WORK_QUEUE_ITEMS),
    };

    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(
          `[work-queue-reporter] POST ${url} returned ${res.status} — swallowing`,
        );
      }
    } catch (err) {
      console.warn(
        `[work-queue-reporter] POST ${url} failed: ${String(err)} — swallowing`,
      );
    }
  }
}

export class NoopWorkQueueReporter implements WorkQueueReporter {
  async reportSnapshot(_snapshot: WorkQueueSnapshot): Promise<void> {
    // intentional no-op
  }
}
