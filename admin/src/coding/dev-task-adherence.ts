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
 * IMPORTANT: a dispatch proves a step *started*, not that it was done well.
 * Steps whose proof is not an agent dispatch (6, 7, 8, 9, 9b, 10) are
 * reported as "unmeasured" and excluded from adherence rates.
 */

import requiredStepsFile from "../../../plugins/shipwright/references/required-steps/dev-task.json" with {
  type: "json",
};
import type { PrismaClient } from "../../prisma/client/client.ts";

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

interface AdherenceSeries {
  /** Variant tag (contextFingerprint); null for runs without one. */
  variant: string | null;
  runs: number;
  adherentRuns: number;
  /** adherentRuns / runs; null when there are no runs. */
  adherenceRate: number | null;
  steps: StepAdherenceRate[];
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
  "A dispatch proves a step started, not that it was done well. Steps without a dispatch signal are unmeasured and excluded from rates.";

export const REQUIRED_STEPS: RequiredStep[] = requiredStepsFile.steps;

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
): RunAdherence {
  const results = evaluateRun(steps, usage);
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

function summarize(
  steps: RequiredStep[],
  runs: RunAdherence[],
  variant: string | null,
): AdherenceSeries {
  const adherentRuns = runs.filter((r) => r.adherent).length;
  return {
    variant,
    runs: runs.length,
    adherentRuns,
    adherenceRate: runs.length === 0 ? null : adherentRuns / runs.length,
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
        measured: isDispatchStep(step),
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
): DevTaskAdherenceReport {
  const taskBearing = runs.filter((r) => r.taskBearing);
  return {
    disclaimer: ADHERENCE_DISCLAIMER,
    counts: {
      totalRuns: runs.length,
      taskBearingRuns: taskBearing.length,
      silentTicks: runs.length - taskBearing.length,
    },
    runs,
    overall: summarize(steps, taskBearing, null),
    byVariant: [...groupBy(taskBearing, (r) => r.contextFingerprint)].map(
      ([variant, rs]) => summarize(steps, rs, variant),
    ),
    byCommandVariant: [...groupBy(taskBearing, (r) => r.commandVariant)]
      .sort(([a], [b]) => (a ?? "\uffff").localeCompare(b ?? "\uffff"))
      .map(([commandVariant, rs]) => {
        const { variant: _variant, ...series } = summarize(
          steps,
          rs,
          commandVariant,
        );
        return { commandVariant, ...series };
      }),
  };
}

export class DevTaskAdherenceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly steps: RequiredStep[] = REQUIRED_STEPS,
  ) {}

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

    const runs = rows.map((row) =>
      buildRunAdherence(this.steps, row, row.skillUsage),
    );
    return buildReport(this.steps, runs);
  }
}
