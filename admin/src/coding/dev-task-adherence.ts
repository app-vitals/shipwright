/**
 * admin/src/coding/dev-task-adherence.ts
 * Dev-task adherence report (DTA-1.2). For each non-skipped dev-task run,
 * compares the run's AgentCronRunSkillUsage rows (subagents appear as
 * kind="agent", name=<subagent_type>) against the required-steps table
 * (plugins/shipwright/references/required-steps/dev-task.json, DTA-2.1) and
 * records per-step ran/skipped. Aggregates per-step adherence rates over a
 * time window, per contextFingerprint (byVariant; null when absent) and per
 * commandVariant (byCommandVariant: "default" | "alternate", DTA-1.3; null for
 * unattributed runs) — the key the DTA-2.3 A/B trial splits on.
 *
 * Task-bearing vs silent: a run is task-bearing when it was dispatched against
 * a work item (itemId set). Non-skipped runs with no itemId are silent /
 * no-ready-task ticks that never executed the command; they are listed
 * (taskBearing=false) and counted, but excluded from every series so rates
 * cover only runs that actually executed dev-task.
 *
 * Step detection check: a run whose skill usage contains an
 * agent/general-purpose row (the Step 5 implementation subagent) is reported
 * as Step 5 ran — covered by a unit fixture. A single dispatch does not also
 * satisfy 6.5 (see evaluateRun).
 *
 * Task-store join (DTA-6.2): steps 2, 8, 9 and 9b are proven by task-store
 * data rather than a dispatch — task.startedAt (2), verification-check rows
 * (8), task.pr/prCreatedAt (9) and the PR record's CI outcome (9b). They are
 * measured only when the caller supplies a RunEnrichment for the run;
 * otherwise (no fetchers, task 404, fetch failure) they stay "unmeasured".
 *
 * Per-arm outcomes (DTA-8.2): each series (overall, byVariant,
 * byCommandVariant) also carries `outcomes` — PRs, mean patch/review cycles,
 * share of tasks with 0 and 2+ patch cycles, CI first-pass rate and mean
 * ciFixAttempts — computed from the same per-itemId RunEnrichment the step
 * measurements use (no extra task-store lookups). A task counts once per
 * series (deduped by itemId) and only when ALL its task-bearing runs share
 * that series' key; tasks that ran under more than one commandVariant
 * (retries across arms, null counts as a value) are excluded from arm
 * outcomes and reported as counts.mixedTasks. Means are sum/count over those
 * single-arm tasks; ciFirstPassRate = count(ciFixAttempts == 0) /
 * count(ciFixAttempts != null).
 *
 * IMPORTANT: a dispatch proves a step *started*, not that it was done well.
 * Steps with neither a dispatch nor task-store proof (6, 7, 10) are reported
 * as "unmeasured" and excluded from adherence rates.
 */

import type { PrismaClient } from "@app-vitals/agent-admin/prisma/client/client.ts";
import requiredStepsFile from "../../../plugins/shipwright/references/required-steps/dev-task.json" with {
  type: "json",
};

export interface RequiredStep {
  stepNumber: string;
  title: string;
  mandatory: boolean;
  proofOfRunning: string;
  measurable: boolean;
}

export interface SkillUsageRow {
  kind: string;
  name: string;
  invocations: number;
}

/** Task-store data joined onto a run (DTA-6.2). */
export interface RunEnrichment {
  task: {
    repo?: string | null;
    startedAt: string | null;
    pr: number | null;
    prCreatedAt: string | null;
    /** Task-store CI fix attempts (DTA-8.2); null/absent when unrecorded. */
    ciFixAttempts?: number | null;
  };
  checks: { status: string }[];
  /** PR record outcome; null when the task has no PR / it wasn't found. */
  pr: {
    commitsCiFix: number | null;
    patchCycles?: number | null;
    reviewCycles?: number | null;
  } | null;
}

/** Subset of the task-store fetchers the report uses; all optional. */
export interface AdherenceFetchers {
  getTask?: (
    itemId: string,
  ) => Promise<(RunEnrichment["task"] & { repo?: string | null }) | null>;
  getPrByNumber?: (repo: string, pr: number) => Promise<RunEnrichment["pr"]>;
  getVerificationChecks?: (itemId: string) => Promise<{ status: string }[]>;
}

type StepStatus = "ran" | "skipped" | "unmeasured";

interface RunStepResult {
  stepNumber: string;
  status: StepStatus;
}

interface RunAdherence {
  runId: string;
  itemId: string | null;
  contextFingerprint: string | null;
  commandVariant: string | null;
  /** True when dispatched against a work item; false for silent ticks. */
  taskBearing: boolean;
  steps: RunStepResult[];
  /** True when every mandatory, dispatch-measurable step ran. */
  adherent: boolean;
  missingSteps: string[];
}

interface StepAdherenceRate {
  stepNumber: string;
  title: string;
  mandatory: boolean;
  measured: boolean;
  ran: number;
  skipped: number;
  /** ran / (ran + skipped); null when the step is unmeasured or has no runs. */
  rate: number | null;
}

/** Per-arm task outcomes (DTA-8.2); null means = no data. */
interface OutcomeMetrics {
  /** Distinct single-arm enriched tasks counted in this series. */
  tasks: number;
  /** Of those, tasks with a PR record (denominator for PR metrics). */
  prs: number;
  meanPatchCycles: number | null;
  shareZeroPatchCycles: number | null;
  shareTwoPlusPatchCycles: number | null;
  meanReviewCycles: number | null;
  /** count(ciFixAttempts == 0) / count(ciFixAttempts != null). */
  ciFirstPassRate: number | null;
  meanCiFixAttempts: number | null;
}

interface AdherenceSeries {
  /** Variant tag (contextFingerprint); null for runs without one. */
  variant: string | null;
  runs: number;
  adherentRuns: number;
  /** adherentRuns / runs; null when there are no runs. */
  adherenceRate: number | null;
  steps: StepAdherenceRate[];
  outcomes: OutcomeMetrics;
}

interface CommandVariantSeries extends Omit<AdherenceSeries, "variant"> {
  /** "default" | "alternate"; null for runs without attribution. */
  commandVariant: string | null;
}

interface RunCounts {
  /** All non-skipped dev-task runs in the window. */
  totalRuns: number;
  /** Runs dispatched against a work item; the denominator for all rates. */
  taskBearingRuns: number;
  /** Non-skipped runs with no work item (empty-queue ticks). */
  silentTicks: number;
  /**
   * Tasks whose task-bearing runs used more than one commandVariant (null
   * counts as a value). Excluded from per-arm outcomes.
   */
  mixedTasks: number;
}

interface DevTaskAdherenceReport {
  disclaimer: string;
  counts: RunCounts;
  runs: RunAdherence[];
  overall: AdherenceSeries;
  byVariant: AdherenceSeries[];
  byCommandVariant: CommandVariantSeries[];
}

export const ADHERENCE_DISCLAIMER =
  "A dispatch proves a step started, not that it was done well. Steps proven by neither a dispatch nor task-store data are unmeasured and excluded from rates.";

export const REQUIRED_STEPS: RequiredStep[] = requiredStepsFile.steps;

/**
 * Max runs enriched concurrently in report(). Each enrichment makes up to 3
 * task-store calls and the task store sits on a small pg pool, so an unbounded
 * fan-out over a large window queues hundreds of requests.
 */
export const ENRICHMENT_CONCURRENCY = 4;

const DOCS_REFRESHER = "shipwright:docs-refresher";
const GENERAL_PURPOSE = "general-purpose";
// Auxiliary subagents dispatched inside or around Step 5 that don't count as
// the implementation dispatch.
const NON_IMPLEMENTER_AGENTS = new Set([
  DOCS_REFRESHER,
  "shipwright:researcher",
  "shipwright:code-reviewer",
]);

function isDispatchStep(step: RequiredStep): boolean {
  return step.measurable && step.proofOfRunning.startsWith("agent dispatch");
}

// Steps proven by task-store data instead of an agent dispatch.
const ENRICHMENT_STEPS = new Set(["2", "8", "9", "9b"]);

function isMeasuredStep(step: RequiredStep): boolean {
  return (
    isDispatchStep(step) ||
    (step.measurable && ENRICHMENT_STEPS.has(step.stepNumber))
  );
}

function evaluateEnrichedStep(
  stepNumber: string,
  e: RunEnrichment,
): boolean | null {
  switch (stepNumber) {
    case "2":
      return e.task.startedAt != null;
    case "8":
      return e.checks.some(
        (c) => c.status === "ran_passed" || c.status === "ran_failed",
      );
    case "9":
      return e.task.pr != null || e.task.prCreatedAt != null;
    case "9b":
      return e.pr?.commitsCiFix != null;
    default:
      return null;
  }
}

function invocationsOf(rows: SkillUsageRow[], name: string): number {
  return rows
    .filter((r) => r.kind === "agent" && r.name === name)
    .reduce((n, r) => n + r.invocations, 0);
}

/**
 * Evaluates one run's per-step status from its skill-usage rows.
 * Step 5 ran = any implementer-type agent dispatch. Step 6.5 ran = a further
 * general-purpose dispatch beyond the one Step 5 consumed (when Step 5 used
 * the built-in implementer). Step 8.5 ran = a docs-refresher dispatch.
 */
function evaluateRun(
  steps: RequiredStep[],
  usage: SkillUsageRow[],
  enrichment?: RunEnrichment,
): RunStepResult[] {
  const gp = invocationsOf(usage, GENERAL_PURPOSE);
  const customImplementer = usage.some(
    (r) =>
      r.kind === "agent" &&
      r.invocations > 0 &&
      r.name !== GENERAL_PURPOSE &&
      !NON_IMPLEMENTER_AGENTS.has(r.name),
  );
  const step5Ran = gp >= 1 || customImplementer;
  const step5ConsumedGp = !customImplementer && gp >= 1 ? 1 : 0;

  return steps.map((step) => {
    if (!isDispatchStep(step)) {
      const enriched =
        enrichment && step.measurable
          ? evaluateEnrichedStep(step.stepNumber, enrichment)
          : null;
      if (enriched !== null) {
        return {
          stepNumber: step.stepNumber,
          status: enriched ? ("ran" as const) : ("skipped" as const),
        };
      }
      return { stepNumber: step.stepNumber, status: "unmeasured" as const };
    }
    let ran: boolean;
    switch (step.stepNumber) {
      case "5":
        ran = step5Ran;
        break;
      case "6.5":
        ran = gp >= step5ConsumedGp + 1;
        break;
      case "8.5":
        ran = invocationsOf(usage, DOCS_REFRESHER) >= 1;
        break;
      default:
        // Dispatch-proof step we have no mapping for: don't guess.
        return { stepNumber: step.stepNumber, status: "unmeasured" as const };
    }
    return {
      stepNumber: step.stepNumber,
      status: ran ? ("ran" as const) : ("skipped" as const),
    };
  });
}

export function buildRunAdherence(
  steps: RequiredStep[],
  run: {
    id: string;
    itemId: string | null;
    contextFingerprint: string | null;
    commandVariant?: string | null;
  },
  usage: SkillUsageRow[],
  enrichment?: RunEnrichment,
): RunAdherence {
  const results = evaluateRun(steps, usage, enrichment);
  const missingSteps = results
    .filter(
      (r) =>
        r.status === "skipped" &&
        steps.find((s) => s.stepNumber === r.stepNumber)?.mandatory,
    )
    .map((r) => r.stepNumber);
  return {
    runId: run.id,
    itemId: run.itemId,
    contextFingerprint: run.contextFingerprint,
    commandVariant: run.commandVariant ?? null,
    taskBearing: run.itemId !== null,
    steps: results,
    adherent: missingSteps.length === 0,
    missingSteps,
  };
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Distinct itemIds of task-bearing runs → set of keys they ran under. */
function keysByTask(
  runs: RunAdherence[],
  key: (r: RunAdherence) => string | null,
): Map<string, Set<string | null>> {
  const m = new Map<string, Set<string | null>>();
  for (const r of runs) {
    if (r.itemId === null) continue;
    const set = m.get(r.itemId) ?? new Set<string | null>();
    set.add(key(r));
    m.set(r.itemId, set);
  }
  return m;
}

function computeOutcomes(
  itemIds: Iterable<string>,
  enrichments: Map<string, RunEnrichment | undefined> | undefined,
): OutcomeMetrics {
  let tasks = 0;
  const patch: number[] = [];
  const review: number[] = [];
  const ci: number[] = [];
  for (const id of itemIds) {
    const e = enrichments?.get(id);
    if (!e) continue;
    tasks++;
    if (e.pr) {
      if (e.pr.patchCycles != null) patch.push(e.pr.patchCycles);
      if (e.pr.reviewCycles != null) review.push(e.pr.reviewCycles);
    }
    if (e.task.ciFixAttempts != null) ci.push(e.task.ciFixAttempts);
  }
  const share = (pred: (n: number) => boolean) =>
    patch.length === 0 ? null : patch.filter(pred).length / patch.length;
  return {
    tasks,
    prs: patch.length,
    meanPatchCycles: mean(patch),
    shareZeroPatchCycles: share((n) => n === 0),
    shareTwoPlusPatchCycles: share((n) => n >= 2),
    meanReviewCycles: mean(review),
    ciFirstPassRate:
      ci.length === 0 ? null : ci.filter((n) => n === 0).length / ci.length,
    meanCiFixAttempts: mean(ci),
  };
}

function summarize(
  steps: RequiredStep[],
  runs: RunAdherence[],
  variant: string | null,
  outcomes: OutcomeMetrics,
): AdherenceSeries {
  const adherentRuns = runs.filter((r) => r.adherent).length;
  return {
    variant,
    runs: runs.length,
    adherentRuns,
    adherenceRate: runs.length === 0 ? null : adherentRuns / runs.length,
    outcomes,
    steps: steps.map((step) => {
      let ran = 0;
      let skipped = 0;
      for (const run of runs) {
        const s = run.steps.find((x) => x.stepNumber === step.stepNumber);
        if (s?.status === "ran") ran++;
        else if (s?.status === "skipped") skipped++;
      }
      const total = ran + skipped;
      return {
        stepNumber: step.stepNumber,
        title: step.title,
        mandatory: step.mandatory,
        measured: isMeasuredStep(step),
        ran,
        skipped,
        rate: total === 0 ? null : ran / total,
      };
    }),
  };
}

function groupBy(
  runs: RunAdherence[],
  key: (r: RunAdherence) => string | null,
): Map<string | null, RunAdherence[]> {
  const groups = new Map<string | null, RunAdherence[]>();
  for (const r of runs) {
    const g = groups.get(key(r)) ?? [];
    g.push(r);
    groups.set(key(r), g);
  }
  return groups;
}

export function buildReport(
  steps: RequiredStep[],
  runs: RunAdherence[],
  enrichments?: Map<string, RunEnrichment | undefined>,
): DevTaskAdherenceReport {
  const taskBearing = runs.filter((r) => r.taskBearing);

  // Outcomes for one series: tasks whose runs ALL share `seriesKey` in the
  // given dimension (a task spanning several keys belongs to no series).
  const outcomesFor = (
    keys: Map<string, Set<string | null>>,
    seriesKey: string | null,
  ): OutcomeMetrics =>
    computeOutcomes(
      [...keys]
        .filter(([, set]) => set.size === 1 && set.has(seriesKey))
        .map(([id]) => id),
      enrichments,
    );

  const fpKeys = keysByTask(taskBearing, (r) => r.contextFingerprint);
  const cvKeys = keysByTask(taskBearing, (r) => r.commandVariant);
  const allIds = [...cvKeys.keys()];
  const mixedTasks = [...cvKeys.values()].filter((s) => s.size > 1).length;

  return {
    disclaimer: ADHERENCE_DISCLAIMER,
    counts: {
      totalRuns: runs.length,
      taskBearingRuns: taskBearing.length,
      silentTicks: runs.length - taskBearing.length,
      mixedTasks,
    },
    runs,
    // Overall spans every arm, so it keeps every task, mixed or not.
    overall: summarize(
      steps,
      taskBearing,
      null,
      computeOutcomes(allIds, enrichments),
    ),
    byVariant: [...groupBy(taskBearing, (r) => r.contextFingerprint)].map(
      ([variant, rs]) =>
        summarize(steps, rs, variant, outcomesFor(fpKeys, variant)),
    ),
    byCommandVariant: [...groupBy(taskBearing, (r) => r.commandVariant)]
      .sort(([a], [b]) => (a ?? "\uffff").localeCompare(b ?? "\uffff"))
      .map(([commandVariant, rs]) => {
        const { variant: _variant, ...series } = summarize(
          steps,
          rs,
          commandVariant,
          outcomesFor(cvKeys, commandVariant),
        );
        return { commandVariant, ...series };
      }),
  };
}

export class DevTaskAdherenceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly steps: RequiredStep[] = REQUIRED_STEPS,
    private readonly fetchers: AdherenceFetchers = {},
  ) {}

  /**
   * Task-store enrichment for one task-bearing run. Any failure (or a 404
   * task) degrades to undefined so the report never fails on the join.
   */
  private enrich(
    itemId: string | null,
    cache: Map<string, Promise<RunEnrichment | undefined>>,
  ): Promise<RunEnrichment | undefined> {
    if (!itemId) return Promise.resolve(undefined);
    let pending = cache.get(itemId);
    if (!pending) {
      pending = this.fetchEnrichment(itemId);
      cache.set(itemId, pending);
    }
    return pending;
  }

  private async fetchEnrichment(
    itemId: string,
  ): Promise<RunEnrichment | undefined> {
    const { getTask, getVerificationChecks, getPrByNumber } = this.fetchers;
    if (!getTask) return undefined;
    try {
      const task = await getTask(itemId);
      if (!task) return undefined;
      const checks = getVerificationChecks
        ? await getVerificationChecks(itemId)
        : [];
      const pr =
        getPrByNumber && task.repo && task.pr != null
          ? await getPrByNumber(task.repo, task.pr)
          : null;
      return { task, checks, pr };
    } catch {
      return undefined;
    }
  }

  /**
   * Report over non-skipped dev-task runs with startedAt in [from, to).
   * When `agentId` is given, only that agent's runs are included; omitted is
   * fleet-wide.
   */
  async report(
    from?: string,
    to?: string,
    agentId?: string,
  ): Promise<DevTaskAdherenceReport> {
    const startedAt: { gte?: Date; lt?: Date } = {};
    if (from) startedAt.gte = new Date(from);
    if (to) startedAt.lt = new Date(to);

    const rows = await this.prisma.agentCronRun.findMany({
      where: {
        skipped: false,
        phaseCron: { name: "shipwright-dev-task" },
        ...(agentId ? { agentId } : {}),
        ...(from || to ? { startedAt } : {}),
      },
      select: {
        id: true,
        itemId: true,
        contextFingerprint: true,
        commandVariant: true,
        skillUsage: { select: { kind: true, name: true, invocations: true } },
      },
      orderBy: { startedAt: "asc" },
    });

    // Per-request memo: runs sharing an itemId share one set of lookups.
    const cache = new Map<string, Promise<RunEnrichment | undefined>>();
    const enrichments = new Map<string, RunEnrichment | undefined>();
    const runs: RunAdherence[] = new Array(rows.length);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        const row = rows[i];
        const enrichment = await this.enrich(row.itemId, cache);
        if (row.itemId) enrichments.set(row.itemId, enrichment);
        runs[i] = buildRunAdherence(
          this.steps,
          row,
          row.skillUsage,
          enrichment,
        );
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ENRICHMENT_CONCURRENCY, rows.length) },
        worker,
      ),
    );
    return buildReport(this.steps, runs, enrichments);
  }
}
