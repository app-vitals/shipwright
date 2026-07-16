/**
 * agent/src/cron-failure-reporter.ts
 *
 * Extracted from index.ts's cron-sync scheduled callback so a thrown dispatch
 * error (either the `dispatch === "loop"` path or the regular
 * handleCronRequest path) surfaces the same way any other failed cron run
 * does: an AgentCronRun row (visible in the admin run-history UI / Slack),
 * not just raw pod stdout.
 *
 * Mirrors loop-orchestrator.ts's dispatch() catch block: createRun() is
 * called for the tick, then on a thrown error completeRun() is called with
 * outcome "failed" and { error: <message> }. Also calls
 * sentryClient.captureException(err) — this is a genuinely unhandled failure
 * (the whole tick aborted), not a swallowed/handled one, so it's captured as
 * a proper Sentry Issue rather than relying on consoleLoggingIntegration to
 * turn a console.error call into a lower-signal Sentry log line.
 *
 * `cronRunReporter` and `sentryClient` are both optional-by-convention at the
 * call site (NoopCronRunReporter / undefined respectively) — this function
 * itself requires a CronRunReporter (callers pass the Noop fallback) and
 * treats sentryClient as optional so it behaves identically whether or not
 * SENTRY_DSN is set.
 */

import type { ErrorCapturingClient } from "@shipwright/lib/sentry";
import type { Clock } from "./clock.ts";
import type { CronRunReporter } from "./cron-run-reporter.ts";

export interface ReportCronFailureDeps {
  cronRunReporter: CronRunReporter;
  sentryClient?: ErrorCapturingClient;
  clock: Clock;
}

/**
 * Reports a cron tick's dispatch failure: logs locally (console.error),
 * captures the error in Sentry (when a sentryClient is wired), and records a
 * failed AgentCronRun via createRun/completeRun so the failure shows up in
 * the admin run-history UI and metrics dashboard, not just raw pod logs.
 */
export async function reportCronFailure(
  cronId: string,
  err: unknown,
  deps: ReportCronFailureDeps,
): Promise<void> {
  const { cronRunReporter, sentryClient, clock } = deps;
  const message = err instanceof Error ? err.message : String(err);

  console.error(`[cron] job ${cronId} failed:`, message);

  sentryClient?.captureException(err);

  const runId = await cronRunReporter.createRun(cronId, clock.now());
  await cronRunReporter.completeRun(cronId, runId, clock.now(), "failed", {
    error: message,
  });
}
