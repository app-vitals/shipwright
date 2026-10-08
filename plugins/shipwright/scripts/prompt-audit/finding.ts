/**
 * plugins/shipwright/scripts/prompt-audit/finding.ts
 *
 * Finding record, rule context and thresholds shared by the prompt-audit rule
 * modules. Thresholds are documented in
 * plugins/shipwright/skills/prompt-scan/references/thresholds.md.
 */

import type { BlameAge } from "./blame-age.ts";
import { fingerprint } from "./fingerprint.ts";
import type {
  AuditContext,
  InventoryItem,
  LoadClass,
} from "./inventory.ts";
import type {
  OrphanedAutoSection,
  UnresolvedReference,
} from "./reference-resolver.ts";
import type { TokenCount } from "./token-count.ts";
import type { SkillStat } from "./usage-attribution.ts";

export const THRESHOLDS = {
  claudeMdMaxLines: 200,
  /** Always-loaded tokens per context × model above which the set is flagged. */
  alwaysSetTokens: 20_000,
  /** Maximum @-import hops before an import chain is flagged. */
  importDepthMax: 2,
  /** Fraction of the 1% listing budget above which the listing is flagged. */
  listingShareWarn: 0.8,
  descriptionMaxChars: 1_536,
  onInvokeHeavyTokens: 8_000,
  /** Static or measured tokens × invocations per week. */
  invokeWeeklyTokens: 500_000,
  blameAgeDays: 180,
  /** Share of runs in which a skill is invoked, above which it is "hot". */
  skillHotRunShare: 0.6,
  skillMaxLines: 500,
  /** First hard constraint after this fraction of the file is "buried". */
  keyInstructionRatio: 0.4,
  keyInstructionMinLines: 30,
  postCompactionCapTokens: 5_000,
  instructionCountMax: 60,
  capsRatioMax: 0.05,
  capsMinCount: 5,
  prohibitionClusterSize: 4,
  prohibitionClusterWindow: 10,
  moveToPathMinLines: 15,
  moveToPathMinRefs: 3,
} as const;

/** Eval cost model: cases × runs × arms × per-case cost (spec default $0.10). */
const EVAL_CASES = 8;
const EVAL_RUNS = 3;
const EVAL_COST_PER_CASE_USD = 0.1;

export type FindingClass = "a" | "b" | "c" | "e" | "f";
export type EvalKind = "with-without" | "ab" | "trigger" | "production-series";
export type Claim = "cost-only" | "quality-claimed";

export interface Finding {
  fingerprint: string;
  class: FindingClass;
  rule: string;
  file: string;
  line: number;
  lineEnd?: number;
  loadClass: LoadClass;
  contexts: AuditContext[];
  evidence: string;
  metrics: {
    before: number;
    projectedAfter?: number;
    units: string;
    estimated: boolean;
  };
  measurement: {
    tier: "static" | "eval";
    evals?: Array<{ kind: EvalKind; estCostUsd: number }>;
    acceptance: string;
  };
  /** Every finding is labelled; quality-claimed always carries an eval. */
  claim: Claim;
  confidence: "high" | "medium" | "low";
  action: string;
  severity: "low" | "medium" | "high";
}

export interface RuleContext {
  items: InventoryItem[];
  /** File text by root-relative path (frontmatter included). */
  read(path: string): string;
  models: string[];
  /** Token counts by path, then model. */
  tokens: Record<string, Record<string, TokenCount>>;
  unresolved: UnresolvedReference[];
  orphans: OrphanedAutoSection[];
  blame: Record<string, BlameAge>;
  /** Skill usage rows; null when unavailable. */
  usage: SkillStat[] | null;
  /** Runs observed in the usage window (denominator for run share). */
  totalRuns: number;
  usageWindowDays: number;
}

export type Rule = (ctx: RuleContext) => Finding[];

export interface FindingInput {
  class: FindingClass;
  rule: string;
  item: InventoryItem;
  /** Contexts the finding applies to; defaults to every context. */
  contexts?: AuditContext[];
  line?: number;
  lineEnd?: number;
  /** Stable text: no counts or line numbers, they would churn the fingerprint. */
  evidence: string;
  metrics: Finding["metrics"];
  action: string;
  severity: Finding["severity"];
  confidence?: Finding["confidence"];
  /**
   * Set when the change could affect model behaviour. This is the only way to
   * produce a quality-claimed finding, and it always attaches an eval.
   */
  evalKind?: EvalKind;
}

export const CONTEXTS: AuditContext[] = ["local-dev", "agent-runtime"];

export function estEvalCostUsd(kind: EvalKind): number {
  if (kind === "production-series") return 0;
  const arms = kind === "trigger" ? 1 : 2;
  return +(EVAL_CASES * EVAL_RUNS * arms * EVAL_COST_PER_CASE_USD).toFixed(2);
}

/** Eval kind that can actually test a file: plugin eval only loads the plugin under test. */
export function evalKindFor(item: InventoryItem): EvalKind {
  return item.loadClass["local-dev"] === "always" ||
    item.loadClass["agent-runtime"] === "always"
    ? "production-series"
    : "with-without";
}

export function makeFinding(input: FindingInput): Finding {
  const contexts = input.contexts ?? CONTEXTS;
  const { item } = input;
  const loadClass = item.loadClass[contexts[0]];
  const claim: Claim = input.evalKind ? "quality-claimed" : "cost-only";
  const acceptance = input.evalKind
    ? `cli.ts measure reports a same-model token delta, and ${input.evalKind} eval reports score delta >= 0 (no regression detected within the minimum detectable effect)`
    : "cli.ts measure reports a same-model token delta < 0";
  return {
    fingerprint: fingerprint(input.class, {
      rule: input.rule,
      file: item.path,
      evidence: input.evidence,
    }),
    class: input.class,
    rule: input.rule,
    file: item.path,
    line: input.line ?? 1,
    ...(input.lineEnd === undefined ? {} : { lineEnd: input.lineEnd }),
    loadClass,
    contexts,
    evidence: input.evidence,
    metrics: input.metrics,
    measurement: input.evalKind
      ? {
          tier: "eval",
          evals: [
            { kind: input.evalKind, estCostUsd: estEvalCostUsd(input.evalKind) },
          ],
          acceptance,
        }
      : { tier: "static", acceptance },
    claim,
    confidence: input.confidence ?? "high",
    action: input.action,
    severity: input.severity,
  };
}

/** Contexts in which `item` has one of the given load classes. */
export function contextsWhere(
  item: InventoryItem,
  classes: LoadClass[],
): AuditContext[] {
  return CONTEXTS.filter((c) => classes.includes(item.loadClass[c]));
}

/** Largest token count across models for a path, with its estimated flag. */
export function maxTokens(
  ctx: RuleContext,
  path: string,
): { tokens: number; estimated: boolean } {
  const byModel = Object.values(ctx.tokens[path] ?? {});
  return {
    tokens: Math.max(0, ...byModel.map((t) => t.tokens)),
    estimated: byModel.some((t) => t.estimated),
  };
}
