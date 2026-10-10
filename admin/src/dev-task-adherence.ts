/**
 * admin/src/dev-task-adherence.ts
 * Dev-task adherence report (DTA-1.2). For each non-skipped dev-task run,
 * compares the run's AgentCronRunSkillUsage rows (subagents appear as
 * kind="agent", name=<subagent_type>) against the required-steps table
 * (plugins/shipwright/references/required-steps/dev-task.json, DTA-2.1) and
 * records per-step ran/skipped. Aggregates per-step adherence rates over a
 * time window and per variant (the run's contextFingerprint, the only
 * variant-like tag AgentCronRun carries; null when absent).
 *
 * IMPORTANT: a dispatch proves a step *started*, not that it was done well.
 * Steps whose proof is not an agent dispatch (6, 7, 8, 9, 9b, 10) are
 * reported as "unmeasured" and excluded from adherence rates.
 */

import type { PrismaClient } from "../prisma/client/client.ts";
import requiredStepsFile from "../../plugins/shipwright/references/required-steps/dev-task.json" with {
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

export type StepStatus = "ran" | "skipped" | "unmeasured";

export interface RunStepResult {
  stepNumber: string;
  status: StepStatus;
}

export interface RunAdherence {
  runId: string;
  itemId: string | null;
  contextFingerprint: string | null;
  steps: RunStepResult[];
  /** True when every mandatory, dispatch-measurable step ran. */
  adherent: boolean;
  missingSteps: string[];
}

export interface StepAdherenceRate {
  stepNumber: string;
  title: string;
  mandatory: boolean;
  measured: boolean;
  ran: number;
  skipped: number;
  /** ran / (ran + skipped); null when the step is unmeasured or has no runs. */
  rate: number | null;
}

export interface AdherenceSeries {
  /** Variant tag (contextFingerprint); null for runs without one. */
  variant: string | null;
  runs: number;
  adherentRuns: number;
  steps: StepAdherenceRate[];
}

export interface DevTaskAdherenceReport {
  disclaimer: string;
  runs: RunAdherence[];
  overall: AdherenceSeries;
  byVariant: AdherenceSeries[];
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
export function evaluateRun(
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
  run: { id: string; itemId: string | null; contextFingerprint: string | null },
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
    steps: results,
    adherent: missingSteps.length === 0,
    missingSteps,
  };
}

export function summarize(
  steps: RequiredStep[],
  runs: RunAdherence[],
  variant: string | null,
): AdherenceSeries {
  return {
    variant,
    runs: runs.length,
    adherentRuns: runs.filter((r) => r.adherent).length,
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

export function buildReport(
  steps: RequiredStep[],
  runs: RunAdherence[],
): DevTaskAdherenceReport {
  const groups = new Map<string | null, RunAdherence[]>();
  for (const r of runs) {
    const g = groups.get(r.contextFingerprint) ?? [];
    g.push(r);
    groups.set(r.contextFingerprint, g);
  }
  return {
    disclaimer: ADHERENCE_DISCLAIMER,
    runs,
    overall: summarize(steps, runs, null),
    byVariant: [...groups.entries()].map(([variant, rs]) =>
      summarize(steps, rs, variant),
    ),
  };
}

export class DevTaskAdherenceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly steps: RequiredStep[] = REQUIRED_STEPS,
  ) {}

  /** Report over non-skipped dev-task runs with startedAt in [from, to). */
  async report(from?: string, to?: string): Promise<DevTaskAdherenceReport> {
    const startedAt: { gte?: Date; lt?: Date } = {};
    if (from) startedAt.gte = new Date(from);
    if (to) startedAt.lt = new Date(to);

    const rows = await this.prisma.agentCronRun.findMany({
      where: {
        skipped: false,
        phaseCron: { name: "shipwright-dev-task" },
        ...(from || to ? { startedAt } : {}),
      },
      select: {
        id: true,
        itemId: true,
        contextFingerprint: true,
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
