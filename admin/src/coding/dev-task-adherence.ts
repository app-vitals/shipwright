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
 * Task-store join (DTA-6.2): steps 2, 6, 8, 9 and 9b are proven by task-store
 * data rather than a dispatch — task.startedAt (2), task.simplifyTotal (6, the
 * lean dev-task PATCHes the Simplify counts at Step 10; DTA-8.3), verification-check rows
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
 * count(ciFixAttempts != null). Arm membership is judged on the raw
 * (pre-merge) cron rows, so a task re-dispatched under another arm still
 * counts as mixed after mergeRunRows collapses it into one logical run.
 *
 * Stalled/resumed runs (DTA-8.3): a stalled run that is reclaimed gets a new
 * AgentCronRun row for the same itemId (and sessionId). Rows sharing an itemId
 * are merged into one logical run judged on the union of their skill usage
 * (see mergeRunRows); it is counted once, attributed to the latest row.
 * Step 6 caveat: simplifyTotal is task-level, so a null means "never recorded
 * by Step 10" (including runs that stalled before Step 10) and reads as skipped.
 *
 * Patch scoring (DTA-9.2): `command: "patch"` scores the phase cron
 * shipwright-patch against patch.json. First cut is lane-agnostic: the run's
 * lane (conflict | review | ci) isn't recorded, so the three lane-specific
 * "Dispatch ... Subagent" steps (4b, 5b, 6c) cannot be told apart. 5b is the
 * representative fix-dispatch proof (any agent: row — the configured
 * subagent_type varies), scored across all task-bearing runs; 4b/6c stay
 * unmeasured. The push proof is 4c.5 (lane "any"): the PR record shows
 * patchCycles > 0 and a commitSha (cumulative per PR, so it is a PR-level
 * proof, and a no-op run on an already-patched PR also reads as ran). The
 * claim/release steps (3d, 4a.6, 5a.6, 6b.5), the findings-ledger
 * settlement (5c.5) and the marker-only escalation checks have no durable
 * per-run record and stay unmeasured. A patch run's itemId is "org/repo#N"
 * (or a task id, resolved via getTask) and keys the PR lookup.
 *
 * Cost and patch guardrails (DTA-9.3): each series carries `cost` — mean cost
 * per run and token totals, summed from the run's modelBreakdown rows (a
 * merged stalled/resumed run sums all its rows). Runs with no breakdown are
 * not counted in meanCostUsd. Arm series (byVariant, byCommandVariant) drop
 * runs of tasks that ran under more than one key, like outcomes; overall
 * keeps every run. For `command: "patch"` each series also carries
 * `patchGuardrails` over its single-arm PRs: repeatPatchRate
 * (patchCycles >= 2, i.e. patched again after a push), ciGreenAfterPatchRate
 * (patched PRs with consecutiveCiFailureCount == 0 — a proxy, the PR record
 * has no direct CI-green flag) and meanPatchCycles. Mixed PRs (run under both
 * arms) are excluded and reported as counts.mixedPrs.
 *
 * IMPORTANT: a dispatch proves a step *started*, not that it was done well.
 * Steps with neither a dispatch nor task-store proof (7, 10) are reported
 * as "unmeasured" and excluded from adherence rates.
 */

import type { PrismaClient } from "@app-vitals/agent-admin/prisma/client/client.ts";
import requiredStepsFile from "../../../plugins/shipwright/references/required-steps/dev-task.json" with {
  type: "json",
};
import patchStepsFile from "../../../plugins/shipwright/references/required-steps/patch.json" with {
  type: "json",
};

export interface RequiredStep {
  stepNumber: string;
  title: string;
  mandatory: boolean;
  proofOfRunning: string;
  measurable: boolean;
  /** Patch only: any | review | conflict | ci. */
  lane?: string;
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
    /** Simplify fix count PATCHed at Step 10; null/absent when never recorded. */
    simplifyTotal?: number | null;
  };
  checks: { status: string }[];
  /** PR record outcome; null when the task has no PR / it wasn't found. */
  pr: {
    commitsCiFix: number | null;
    /** Per-arm outcomes (DTA-8.2) and patch scoring (DTA-9.2). */
    patchCycles?: number | null;
    reviewCycles?: number | null;
    /** Patch scoring (DTA-9.2). */
    commitSha?: string | null;
    /** Patch guardrails (DTA-9.3); 0 = no CI failure reported to patch. */
    consecutiveCiFailureCount?: number | null;
  } | null;
}

/** Commands the report can score; dev-task is the default. */
export type AdherenceCommand = "dev-task" | "patch";
export const ADHERENCE_COMMANDS: readonly AdherenceCommand[] = [
  "dev-task",
  "patch",
];

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
  /** Summed modelBreakdown (DTA-9.3); null when the run has none. */
  usage: ModelBreakdownRow | null;
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

/** Token/cost usage of one run, summed over its modelBreakdown rows. */
export interface ModelBreakdownRow {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

interface CostMetrics {
  /** Runs counted (those with a modelBreakdown). */
  runsWithCost: number;
  totalCostUsd: number;
  /** totalCostUsd / runsWithCost; null when no run has a breakdown. */
  meanCostUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Patch guardrails (DTA-9.3) over single-arm PRs with a PR record. */
interface PatchGuardrails {
  prs: number;
  /** count(patchCycles >= 2) / prs: patched again after a push. */
  repeatPatchRate: number | null;
  /** Of patched PRs (patchCycles > 0) with the field known, share with no CI failure. */
  ciGreenAfterPatchRate: number | null;
  meanPatchCycles: number | null;
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
  cost: CostMetrics;
  /** Patch command only. */
  patchGuardrails?: PatchGuardrails;
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
  /** Patch command only: mixedTasks, where the item is a PR. */
  mixedPrs?: number;
}

interface DevTaskAdherenceReport {
  disclaimer: string;
  counts: RunCounts;
  runs: RunAdherence[];
  overall: AdherenceSeries;
  byVariant: AdherenceSeries[];
  byCommandVariant: CommandVariantSeries[];
  /** Set only for non-default commands (patch); absent for dev-task. */
  command?: AdherenceCommand;
}

export const ADHERENCE_DISCLAIMER =
  "A dispatch proves a step started, not that it was done well. Steps proven by neither a dispatch nor task-store data are unmeasured and excluded from rates.";

export const REQUIRED_STEPS: RequiredStep[] = requiredStepsFile.steps;
export const PATCH_REQUIRED_STEPS: RequiredStep[] = patchStepsFile.steps;

/** Phase cron name per command (see agent/src/coding/loop-cron-classifier.ts). */
const PHASE_CRON_NAME: Record<AdherenceCommand, string> = {
  "dev-task": "shipwright-dev-task",
  patch: "shipwright-patch",
};

const PATCH_FIX_DISPATCH_STEP = "5b";
const PATCH_PUSH_STEP = "4c.5";
const PATCH_MEASURED_STEPS = new Set([
  PATCH_FIX_DISPATCH_STEP,
  PATCH_PUSH_STEP,
]);

/** Parses a patch run's "org/repo#N" itemId; null for anything else. */
export function parsePrRef(
  itemId: string | null | undefined,
): { repo: string; pr: number } | null {
  const m = itemId?.match(/^([^\s#]+\/[^\s#]+)#(\d+)$/);
  return m ? { repo: m[1], pr: Number(m[2]) } : null;
}

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
const ENRICHMENT_STEPS = new Set(["2", "6", "8", "9", "9b"]);

function isMeasuredStep(
  step: RequiredStep,
  command: AdherenceCommand = "dev-task",
): boolean {
  if (command === "patch") {
    return step.measurable && PATCH_MEASURED_STEPS.has(step.stepNumber);
  }
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
    case "6":
      return e.task.simplifyTotal != null;
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

/**
 * Patch evaluation (DTA-9.2, lane-agnostic first cut): 5b = any agent
 * dispatch; 4c.5 = PR record shows a pushed patch (patchCycles > 0 with a
 * commitSha), unmeasured without PR enrichment. Everything else unmeasured.
 */
function evaluatePatchRun(
  steps: RequiredStep[],
  usage: SkillUsageRow[],
  enrichment?: RunEnrichment,
): RunStepResult[] {
  const dispatched = usage.some((r) => r.kind === "agent" && r.invocations > 0);
  return steps.map((step) => {
    let ran: boolean | null = null;
    if (step.measurable && step.stepNumber === PATCH_FIX_DISPATCH_STEP) {
      ran = dispatched;
    } else if (
      step.measurable &&
      step.stepNumber === PATCH_PUSH_STEP &&
      enrichment?.pr
    ) {
      ran = (enrichment.pr.patchCycles ?? 0) > 0 && !!enrichment.pr.commitSha;
    }
    return {
      stepNumber: step.stepNumber,
      status: ran === null ? "unmeasured" : ran ? "ran" : "skipped",
    };
  });
}

export interface CronRunRow {
  id: string;
  itemId: string | null;
  contextFingerprint: string | null;
  commandVariant?: string | null;
  skillUsage: SkillUsageRow[];
  modelBreakdown?: ModelBreakdownRow[];
}

/**
 * Collapses rows that belong to one logical run. Task-bearing rows sharing an
 * itemId (a stalled run and its resume, SPL-2.8) merge into one: skill usage
 * is summed by kind+name, and id/contextFingerprint/commandVariant come from
 * the latest row (input is startedAt-ascending), falling back to the most
 * recent earlier non-null value. Silent ticks (itemId null) stay separate.
 * Output preserves first-appearance order.
 */
export function mergeRunRows(rows: CronRunRow[]): CronRunRow[] {
  const out: CronRunRow[] = [];
  const byItem = new Map<string, number>();
  for (const row of rows) {
    const idx = row.itemId == null ? undefined : byItem.get(row.itemId);
    if (idx === undefined) {
      if (row.itemId != null) byItem.set(row.itemId, out.length);
      out.push({
        ...row,
        skillUsage: [...row.skillUsage],
        modelBreakdown: [...(row.modelBreakdown ?? [])],
      });
      continue;
    }
    const prev = out[idx];
    const usage = new Map<string, SkillUsageRow>();
    for (const u of [...prev.skillUsage, ...row.skillUsage]) {
      const k = `${u.kind}\0${u.name}`;
      const cur = usage.get(k);
      usage.set(k, {
        ...u,
        invocations: (cur?.invocations ?? 0) + u.invocations,
      });
    }
    out[idx] = {
      id: row.id,
      itemId: row.itemId,
      contextFingerprint: row.contextFingerprint ?? prev.contextFingerprint,
      commandVariant: row.commandVariant ?? prev.commandVariant ?? null,
      skillUsage: [...usage.values()],
      modelBreakdown: [
        ...(prev.modelBreakdown ?? []),
        ...(row.modelBreakdown ?? []),
      ],
    };
  }
  return out;
}

function sumUsage(rows?: ModelBreakdownRow[]): ModelBreakdownRow | null {
  if (!rows || rows.length === 0) return null;
  const t: ModelBreakdownRow = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
  };
  for (const r of rows) {
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheCreationTokens += r.cacheCreationTokens;
    t.costUsd += r.costUsd;
  }
  return t;
}

export function buildRunAdherence(
  steps: RequiredStep[],
  run: {
    id: string;
    itemId: string | null;
    contextFingerprint: string | null;
    commandVariant?: string | null;
    modelBreakdown?: ModelBreakdownRow[];
  },
  usage: SkillUsageRow[],
  enrichment?: RunEnrichment,
  command: AdherenceCommand = "dev-task",
): RunAdherence {
  const results =
    command === "patch"
      ? evaluatePatchRun(steps, usage, enrichment)
      : evaluateRun(steps, usage, enrichment);
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
    usage: sumUsage(run.modelBreakdown),
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

/** Minimal row shape arm membership is judged on (runs or raw cron rows). */
export interface ArmKeyRow {
  itemId: string | null;
  contextFingerprint: string | null;
  commandVariant?: string | null;
}

/** Distinct itemIds of task-bearing rows → set of keys they ran under. */
function keysByTask(
  runs: ArmKeyRow[],
  key: (r: ArmKeyRow) => string | null,
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

function computeCost(runs: RunAdherence[]): CostMetrics {
  const used = runs.flatMap((r) => (r.usage ? [r.usage] : []));
  const sum = (f: (u: ModelBreakdownRow) => number) =>
    used.reduce((n, u) => n + f(u), 0);
  const totalCostUsd = sum((u) => u.costUsd);
  return {
    runsWithCost: used.length,
    totalCostUsd,
    meanCostUsd: used.length === 0 ? null : totalCostUsd / used.length,
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    cacheReadTokens: sum((u) => u.cacheReadTokens),
    cacheCreationTokens: sum((u) => u.cacheCreationTokens),
  };
}

function computePatchGuardrails(
  itemIds: Iterable<string>,
  enrichments: Map<string, RunEnrichment | undefined> | undefined,
): PatchGuardrails {
  const cycles: number[] = [];
  const patchedCi: number[] = [];
  for (const id of itemIds) {
    const pr = enrichments?.get(id)?.pr;
    if (!pr || pr.patchCycles == null) continue;
    cycles.push(pr.patchCycles);
    if (pr.patchCycles > 0 && pr.consecutiveCiFailureCount != null) {
      patchedCi.push(pr.consecutiveCiFailureCount);
    }
  }
  return {
    prs: cycles.length,
    repeatPatchRate:
      cycles.length === 0
        ? null
        : cycles.filter((n) => n >= 2).length / cycles.length,
    ciGreenAfterPatchRate:
      patchedCi.length === 0
        ? null
        : patchedCi.filter((n) => n === 0).length / patchedCi.length,
    meanPatchCycles: mean(cycles),
  };
}

function summarize(
  steps: RequiredStep[],
  runs: RunAdherence[],
  variant: string | null,
  outcomes: OutcomeMetrics,
  cost: CostMetrics,
  guardrails: PatchGuardrails | undefined,
  command: AdherenceCommand = "dev-task",
): AdherenceSeries {
  const adherentRuns = runs.filter((r) => r.adherent).length;
  return {
    variant,
    runs: runs.length,
    adherentRuns,
    adherenceRate: runs.length === 0 ? null : adherentRuns / runs.length,
    outcomes,
    cost,
    ...(guardrails ? { patchGuardrails: guardrails } : {}),
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
        measured: isMeasuredStep(step, command),
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
  command: AdherenceCommand = "dev-task",
  /**
   * Rows arm membership is judged on; defaults to `runs`. The service passes
   * the raw pre-merge cron rows so cross-arm retries stay visible as mixed.
   */
  armRows?: ArmKeyRow[],
): DevTaskAdherenceReport {
  const taskBearing = runs.filter((r) => r.taskBearing);
  const keyRows = armRows ?? taskBearing;

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

  const fpKeys = keysByTask(keyRows, (r) => r.contextFingerprint);
  const cvKeys = keysByTask(keyRows, (r) => r.commandVariant ?? null);
  const allIds = [...cvKeys.keys()];
  const mixedTasks = [...cvKeys.values()].filter((s) => s.size > 1).length;

  const isPatch = command === "patch";
  const singleArmIds = (
    keys: Map<string, Set<string | null>>,
    seriesKey: string | null,
  ) =>
    [...keys]
      .filter(([, set]) => set.size === 1 && set.has(seriesKey))
      .map(([id]) => id);
  const guardrailsFor = (ids: string[]) =>
    isPatch ? computePatchGuardrails(ids, enrichments) : undefined;
  // Cost counts a run only when its task stayed in one arm (silent ticks have
  // no task and no cost worth attributing).
  const costFor = (rs: RunAdherence[], keys: Map<string, Set<string | null>>) =>
    computeCost(
      rs.filter((r) => r.itemId !== null && keys.get(r.itemId)?.size === 1),
    );

  return {
    ...(command === "dev-task" ? {} : { command }),
    disclaimer: ADHERENCE_DISCLAIMER,
    counts: {
      totalRuns: runs.length,
      taskBearingRuns: taskBearing.length,
      silentTicks: runs.length - taskBearing.length,
      mixedTasks,
      ...(isPatch ? { mixedPrs: mixedTasks } : {}),
    },
    runs,
    // Overall spans every arm, so it keeps every task, mixed or not.
    overall: summarize(
      steps,
      taskBearing,
      null,
      computeOutcomes(allIds, enrichments),
      computeCost(taskBearing),
      guardrailsFor(allIds),
      command,
    ),
    byVariant: [...groupBy(taskBearing, (r) => r.contextFingerprint)].map(
      ([variant, rs]) =>
        summarize(
          steps,
          rs,
          variant,
          outcomesFor(fpKeys, variant),
          costFor(rs, fpKeys),
          guardrailsFor(singleArmIds(fpKeys, variant)),
          command,
        ),
    ),
    byCommandVariant: [...groupBy(taskBearing, (r) => r.commandVariant)]
      .sort(([a], [b]) => (a ?? "\uffff").localeCompare(b ?? "\uffff"))
      .map(([commandVariant, rs]) => {
        const { variant: _variant, ...series } = summarize(
          steps,
          rs,
          commandVariant,
          outcomesFor(cvKeys, commandVariant),
          costFor(rs, cvKeys),
          guardrailsFor(singleArmIds(cvKeys, commandVariant)),
          command,
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
    command: AdherenceCommand,
  ): Promise<RunEnrichment | undefined> {
    if (!itemId) return Promise.resolve(undefined);
    let pending = cache.get(itemId);
    if (!pending) {
      pending =
        command === "patch"
          ? this.fetchPatchEnrichment(itemId)
          : this.fetchEnrichment(itemId);
      cache.set(itemId, pending);
    }
    return pending;
  }

  /** PR-record enrichment for a patch run; undefined on any failure. */
  private async fetchPatchEnrichment(
    itemId: string,
  ): Promise<RunEnrichment | undefined> {
    const { getTask, getPrByNumber } = this.fetchers;
    if (!getPrByNumber) return undefined;
    try {
      let ref = parsePrRef(itemId);
      if (!ref && getTask) {
        const t = await getTask(itemId);
        if (t?.repo && t.pr != null) ref = { repo: t.repo, pr: t.pr };
      }
      if (!ref) return undefined;
      const pr = await getPrByNumber(ref.repo, ref.pr);
      return {
        task: {
          repo: ref.repo,
          startedAt: null,
          pr: ref.pr,
          prCreatedAt: null,
        },
        checks: [],
        pr,
      };
    } catch {
      return undefined;
    }
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
   * Report over non-skipped runs of `command`'s phase cron (default
   * dev-task) with startedAt in [from, to). When `agentId` is given, only that
   * agent's runs are included; omitted is fleet-wide. For patch the steps come
   * from patch.json (the service's own `steps` are dev-task's).
   */
  async report(
    from?: string,
    to?: string,
    agentId?: string,
    command: AdherenceCommand = "dev-task",
  ): Promise<DevTaskAdherenceReport> {
    const steps = command === "patch" ? PATCH_REQUIRED_STEPS : this.steps;
    const startedAt: { gte?: Date; lt?: Date } = {};
    if (from) startedAt.gte = new Date(from);
    if (to) startedAt.lt = new Date(to);

    const rawRows = await this.prisma.agentCronRun.findMany({
      where: {
        skipped: false,
        phaseCron: { name: PHASE_CRON_NAME[command] },
        ...(agentId ? { agentId } : {}),
        ...(from || to ? { startedAt } : {}),
      },
      select: {
        id: true,
        itemId: true,
        contextFingerprint: true,
        commandVariant: true,
        skillUsage: { select: { kind: true, name: true, invocations: true } },
        modelBreakdown: {
          select: {
            inputTokens: true,
            outputTokens: true,
            cacheReadTokens: true,
            cacheCreationTokens: true,
            costUsd: true,
          },
        },
      },
      orderBy: { startedAt: "asc" },
    });
    const rows = mergeRunRows(rawRows);

    // Per-request memo: runs sharing an itemId share one set of lookups.
    const cache = new Map<string, Promise<RunEnrichment | undefined>>();
    const enrichments = new Map<string, RunEnrichment | undefined>();
    const runs: RunAdherence[] = new Array(rows.length);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        const row = rows[i];
        const enrichment = await this.enrich(row.itemId, cache, command);
        if (row.itemId) enrichments.set(row.itemId, enrichment);
        runs[i] = buildRunAdherence(
          steps,
          row,
          row.skillUsage,
          enrichment,
          command,
        );
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ENRICHMENT_CONCURRENCY, rows.length) },
        worker,
      ),
    );
    return buildReport(steps, runs, enrichments, command, rawRows);
  }
}
