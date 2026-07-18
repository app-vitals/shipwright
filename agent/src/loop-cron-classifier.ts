/**
 * agent/src/loop-cron-classifier.ts
 *
 * Pure helpers backing syncCrons()'s decision of which of an agent's own
 * fetched cron jobs get an independent node-cron schedule, and — once the
 * shipwright-loop job is enabled for an agent — which dispatch kind each
 * scheduled job should use.
 *
 * classifyCronJobsForScheduling(jobs) → ScheduledCronJob[]
 *   Any job with a non-null parentCronId is excluded unconditionally —
 *   a row that belongs to a parent cron is config-only and never
 *   independently scheduled, regardless of its own enabled value or
 *   whether shipwright-loop is present/enabled (LPC-1.3). This is the
 *   structural replacement for the enabled=false hack: previously the
 *   generic dispatcher was kept off these rows only by force-disabling
 *   them; now it's off by construction.
 *
 *   For rows with no parent, the shipwright-loop job (if present and
 *   enabled) is always included with dispatch: "loop". Every other enabled
 *   job is included with dispatch: "generic" UNLESS shipwright-loop is
 *   present and enabled AND the job's name is one of the five pipeline
 *   phase jobs (shipwright-dev-task, shipwright-review, shipwright-patch,
 *   shipwright-review-patch, shipwright-deploy) — those are excluded
 *   entirely (loop-config-only: readable by the loop handler, not
 *   independently scheduled). This name-based fallback stays load-bearing
 *   until every legacy pipeline-phase system cron has parentCronId
 *   backfilled by reconcileSystemCrons() (LPC-1.2, separately gated) — do
 *   not remove it. Disabled jobs are never included. An agent whose job
 *   list has no shipwright-loop entry at all behaves identically to one
 *   where it's present-but-disabled — both are the "unmigrated" case, and
 *   produce byte-for-byte today's scheduling behavior.
 *
 * resolveLoopPhaseToggles(jobs, loopCronId) → LoopPhaseToggles
 *   The loop's own toggle-reading logic (consumed by the WL-3.3
 *   drain-until-dry orchestrator in loop-orchestrator.ts). Resolves
 *   dev-task/review/patch/deploy as four independent, non-mutually-exclusive
 *   phase booleans, each read exclusively from a CHILD row — one whose
 *   parentCronId equals the given loopCronId — matched by name (LPC-2.1).
 *   A same-named row that is top-level (parentCronId: null) or a child of a
 *   different parent is ignored; the phase resolves false in either case,
 *   as it does when no matching child row exists at all. This relies on
 *   reconcileSystemCrons() (LPC-1.2) having already run for the given agent
 *   to populate parentCronId on its four phase rows — an agent that hasn't
 *   reconciled since LPC-1.2 deployed will see zero active phases here
 *   (soft-fail: the loop simply pauses dispatch, not an error) until its
 *   next reconcile. Deliberately never reads or references
 *   shipwright-review-patch — its internal review-vs-patch selection is
 *   redundant with what the loop does at a higher level across all four
 *   phases once shipwright-loop is enabled.
 *
 * resolveLoopPhaseJobId(jobs, loopCronId, jobName) → string | null
 *   Resolves a single phase job name (e.g. "shipwright-dev-task") to its
 *   child AgentCronJob id under the given loop cron — same same-parent-name-
 *   match semantics as resolveLoopPhaseToggles, but returning the row's id
 *   instead of its enabled flag. Used by loop-orchestrator.ts (LPC-3.1) to
 *   attribute each dispatch's AgentCronRun to the specific phase cron row it
 *   was dispatched by (phaseId), rather than a loose string label. Returns
 *   null when no matching child row exists — e.g. an agent that hasn't
 *   reconciled since LPC-1.2/2.1 shipped.
 *
 * Kept isolated from the loop orchestrator (WL-3.3), pure and zero-I/O, so
 * it stays cleanly unit-testable — mirrors agent/src/work-selector.ts.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal structural view of a cron job as seen by this module. Deliberately
 * NOT the admin/Prisma-derived AgentCronJob type — zero coupling to
 * admin/Prisma, mirroring work-selector.ts's own candidate types.
 */
export interface CronJobLike {
  id: string;
  name: string | null;
  enabled: boolean;
  parentCronId: string | null;
}

export type CronDispatchKind = "loop" | "generic";

export interface ScheduledCronJob<T extends CronJobLike> {
  job: T;
  dispatch: CronDispatchKind;
}

export interface LoopPhaseToggles {
  devTask: boolean;
  review: boolean;
  patch: boolean;
  deploy: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LOOP_JOB_NAME = "shipwright-loop";

const PIPELINE_PHASE_JOB_NAMES = new Set<string>([
  "shipwright-dev-task",
  "shipwright-review",
  "shipwright-patch",
  "shipwright-review-patch",
  "shipwright-deploy",
]);

/**
 * The four phase job names resolveLoopPhaseToggles() reads — deliberately
 * excludes shipwright-review-patch (see the module docstring above). Exported
 * so callers that need to reason about "does this agent have any of the four
 * loop-phase child rows reconciled yet" (e.g. loop-orchestrator.ts's
 * unreconciled-agent guard) share this list instead of duplicating the
 * literal names.
 */
export const LOOP_PHASE_JOB_NAMES = [
  "shipwright-dev-task",
  "shipwright-review",
  "shipwright-patch",
  "shipwright-deploy",
] as const;

// ─── classifyCronJobsForScheduling ─────────────────────────────────────────────

export function classifyCronJobsForScheduling<T extends CronJobLike>(
  jobs: T[],
): ScheduledCronJob<T>[] {
  const loopJob = jobs.find((job) => job.name === LOOP_JOB_NAME);
  const loopEnabled = loopJob?.enabled === true;

  const result: ScheduledCronJob<T>[] = [];

  for (const job of jobs) {
    // Structural exclusion: a row that belongs to a parent cron is
    // config-only and never independently scheduled, regardless of its own
    // enabled value or whether shipwright-loop is present/enabled. This
    // supersedes (but does not replace) the name-based PIPELINE_PHASE_JOB_NAMES
    // fallback below, which stays load-bearing until every legacy pipeline-phase
    // system cron has parentCronId backfilled (LPC-1.2).
    if (job.parentCronId !== null) continue;

    if (!job.enabled) continue;

    if (job.name === LOOP_JOB_NAME) {
      result.push({ job, dispatch: "loop" });
      continue;
    }

    if (
      loopEnabled &&
      job.name !== null &&
      PIPELINE_PHASE_JOB_NAMES.has(job.name)
    ) {
      // loop-config-only: readable by the loop handler, not independently scheduled
      continue;
    }

    result.push({ job, dispatch: "generic" });
  }

  return result;
}

// ─── resolveLoopPhaseToggles ────────────────────────────────────────────────

export function resolveLoopPhaseToggles<T extends CronJobLike>(
  jobs: T[],
  loopCronId: string,
): LoopPhaseToggles {
  const enabledByName = (name: string): boolean =>
    jobs.find((job) => job.parentCronId === loopCronId && job.name === name)
      ?.enabled === true;

  return {
    devTask: enabledByName("shipwright-dev-task"),
    review: enabledByName("shipwright-review"),
    patch: enabledByName("shipwright-patch"),
    deploy: enabledByName("shipwright-deploy"),
  };
}

// ─── resolveLoopPhaseJobId ──────────────────────────────────────────────────

/**
 * Resolves a single phase job name to its child AgentCronJob id under the
 * given loop cron — same same-parent-name-match semantics as
 * resolveLoopPhaseToggles (a same-named row that is top-level or a child of
 * a different parent is ignored). Returns null when no matching child row
 * exists — e.g. an unreconciled agent.
 */
export function resolveLoopPhaseJobId<T extends CronJobLike>(
  jobs: T[],
  loopCronId: string,
  jobName: string,
): string | null {
  return (
    jobs.find((job) => job.parentCronId === loopCronId && job.name === jobName)
      ?.id ?? null
  );
}
