/**
 * agent/src/loop-cron-classifier.ts
 *
 * Pure helpers backing syncCrons()'s decision of which of an agent's own
 * fetched cron jobs get an independent node-cron schedule, and — once the
 * shipwright-loop job is enabled for an agent — which dispatch kind each
 * scheduled job should use.
 *
 * classifyCronJobsForScheduling(jobs) → ScheduledCronJob[]
 *   The shipwright-loop job (if present and enabled) is always included with
 *   dispatch: "loop". Every other enabled job is included with
 *   dispatch: "generic" UNLESS shipwright-loop is present and enabled AND
 *   the job's name is one of the five pipeline phase jobs
 *   (shipwright-dev-task, shipwright-review, shipwright-patch,
 *   shipwright-review-patch, shipwright-deploy) — those are excluded
 *   entirely (loop-config-only: readable by the loop handler, not
 *   independently scheduled). Disabled jobs are never included. An agent
 *   whose job list has no shipwright-loop entry at all behaves identically
 *   to one where it's present-but-disabled — both are the "unmigrated"
 *   case, and produce byte-for-byte today's scheduling behavior.
 *
 * resolveLoopPhaseToggles(jobs) → LoopPhaseToggles
 *   The loop's own toggle-reading logic (used by the not-yet-built WL-3.3
 *   drain-until-dry orchestrator). Resolves dev-task/review/patch/deploy as
 *   four independent, non-mutually-exclusive phase booleans looked up by
 *   job name (false when the named job is absent). Deliberately never reads
 *   or references shipwright-review-patch — its internal review-vs-patch
 *   selection is redundant with what the loop does at a higher level across
 *   all four phases once shipwright-loop is enabled.
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

// ─── classifyCronJobsForScheduling ─────────────────────────────────────────────

export function classifyCronJobsForScheduling<T extends CronJobLike>(
  jobs: T[],
): ScheduledCronJob<T>[] {
  const loopJob = jobs.find((job) => job.name === LOOP_JOB_NAME);
  const loopEnabled = loopJob?.enabled === true;

  const result: ScheduledCronJob<T>[] = [];

  for (const job of jobs) {
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
): LoopPhaseToggles {
  const enabledByName = (name: string): boolean =>
    jobs.find((job) => job.name === name)?.enabled === true;

  return {
    devTask: enabledByName("shipwright-dev-task"),
    review: enabledByName("shipwright-review"),
    patch: enabledByName("shipwright-patch"),
    deploy: enabledByName("shipwright-deploy"),
  };
}

// ─── Loop cron handler (placeholder) ───────────────────────────────────────────

/**
 * PLACEHOLDER for the shipwright-loop dispatch handler. Resolves the current
 * phase toggles and logs them — the actual multi-invocation drain-until-dry
 * orchestration (claiming work, firing /shipwright:dev-task, /shipwright:review,
 * /shipwright:patch, /shipwright:deploy per enabled phase, looping until dry)
 * is WL-3.3's job and explicitly out of scope here.
 */
export async function handleLoopCronRequest<T extends CronJobLike>(
  jobs: T[],
): Promise<void> {
  const toggles = resolveLoopPhaseToggles(jobs);
  console.log("[cron] loop toggles:", toggles);
}
