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
 *
 * index.ts's catch wraps BOTH the loop-dispatch path (which calls into
 * loop-orchestrator.ts's dispatch()) and the handleCronRequest path
 * (cron-handler.ts) — both of those already call
 * cronRunReporter.completeRun(..., "failed", ...) on their own runId before
 * rethrowing. To avoid a duplicate AgentCronRun "failed" row per real
 * failure, those callers tag the rethrown error via
 * markCronRunFailureReported() first; reportCronFailure() always logs and
 * captures to Sentry, but skips its own createRun/completeRun pair when the
 * error is already tagged.
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
 * Symbol tag used to mark a thrown error as "an AgentCronRun failure row has
 * already been recorded for this error" — set by callers (cron-handler.ts's
 * runner-scope catch, loop-orchestrator.ts's dispatch() catch) that already
 * called cronRunReporter.completeRun(..., "failed", ...) on their own runId
 * before rethrowing. Symbol.for() (not Symbol()) so the tag survives across
 * module instances if the error crosses a boundary.
 */
const CRON_RUN_ALREADY_REPORTED = Symbol.for(
  "shipwright.cronRunAlreadyReported",
);

/**
 * Marks a thrown error as already reported to CronRunReporter, so a later,
 * broader catch (e.g. index.ts's cron-sync scheduled callback) can call
 * reportCronFailure() for logging/Sentry purposes without also creating a
 * duplicate AgentCronRun "failed" row.
 */
export function markCronRunFailureReported(err: unknown): void {
  if (err && typeof err === "object") {
    Reflect.set(err as object, CRON_RUN_ALREADY_REPORTED, true);
  }
}

function isCronRunFailureReported(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      Reflect.get(err as object, CRON_RUN_ALREADY_REPORTED),
  );
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

  if (isCronRunFailureReported(err)) {
    // A more specific layer (cron-handler.ts / loop-orchestrator.ts) already
    // recorded a failed AgentCronRun on its own runId before rethrowing —
    // skip creating a second, untagged row for the same failure.
    return;
  }

  const runId = await cronRunReporter.createRun(cronId, clock.now());
  await cronRunReporter.completeRun(cronId, runId, clock.now(), "failed", {
    error: message,
  });
}
