/**
 * plugins/shipwright/scripts/prompt-audit/hitl-policy.ts
 *
 * Pure policy for the `hitl` field of a `prompt-fix` task. The answer is
 * computed from the blast-radius report and the human-controlled promotion
 * state, never from model judgment: silent prompt regressions throw no errors,
 * so the default is a human in the loop and every exception must be earned.
 *
 * `hitl` is `false` only when ALL of these hold:
 *   - the finding is cost-only (quality-claimed is always `true`);
 *   - a human promoted the rule in `.claude/shipwright/prompt-audit-decisions.md`
 *     (an `**Autonomy:**` entry citing >= 5 accepted proposals);
 *   - the fix is a pure fact repair (class c, replacement verified by command);
 *   - the file is low-fanout, unpinned by any content test, and the change
 *     touches no description or frontmatter;
 *   - the diff is 20 lines or fewer and pulls a single lever.
 */

import type { Claim, FindingClass } from "./finding.ts";

export const PROMOTION_MIN_ACCEPTED = 5;
export const MAX_AUTONOMOUS_DIFF_LINES = 20;

export interface HitlPolicyInput {
  rule: string;
  class: FindingClass;
  claim: Claim;
  /** Root-relative path of the file the fix edits. */
  file: string;
  /** True when a human wrote an `**Autonomy:**` entry for the rule. */
  autonomyEntry: boolean;
  /** Accepted proposals for the rule, as cited by that entry. */
  acceptedProposals: number;
  /** The replacement text was verified by running a command. */
  replacementVerified: boolean;
  /** From the blast-radius report: manifest crons invoking the file. */
  cronCount: number;
  /** From the blast-radius report: content tests pinning the file's wording. */
  pinningTestCount: number;
  /** The change edits a description or any frontmatter field. */
  descriptionOrFrontmatterChange: boolean;
  /** Lines added plus removed by the proposed diff. */
  diffLines: number;
  /** Distinct levers (kinds of change) in the diff. */
  leverCount: number;
}

/** Paths loaded by every run or by many callers; an edit has wide reach. */
const HIGH_FANOUT_PATTERNS: RegExp[] = [
  /(^|\/)agent\/workspace\/[^/]+\.template$/,
  /^CLAUDE\.md$/,
  /^plugins\/[^/]+\/CLAUDE\.md$/,
  /^\.claude\//,
  /(^|\/)commands\/[^/]+\.md$/,
  /(^|\/)agents\/[^/]+\.md$/,
  /(^|\/)references\/methodology-contracts\//,
];

export function isHighFanoutFile(file: string, cronCount: number): boolean {
  return cronCount > 0 || HIGH_FANOUT_PATTERNS.some((re) => re.test(file));
}

/** Reasons the task must stay `hitl: true`; empty means it may run unattended. */
export function hitlReasons(input: HitlPolicyInput): string[] {
  const reasons: string[] = [];
  if (input.claim === "quality-claimed")
    reasons.push("quality-claimed findings always need a human");
  if (!input.autonomyEntry)
    reasons.push("rule has no human-promoted Autonomy entry (propose-only)");
  else if (input.acceptedProposals < PROMOTION_MIN_ACCEPTED)
    reasons.push(
      `rule has ${input.acceptedProposals} accepted proposals, needs ${PROMOTION_MIN_ACCEPTED}`,
    );
  if (input.class !== "c") reasons.push("not a class (c) fact repair");
  else if (!input.replacementVerified)
    reasons.push("replacement not verified by command");
  if (isHighFanoutFile(input.file, input.cronCount))
    reasons.push("high-fanout file");
  if (input.pinningTestCount > 0)
    reasons.push("a content test pins the file's wording");
  if (input.descriptionOrFrontmatterChange)
    reasons.push("description or frontmatter change");
  if (input.diffLines > MAX_AUTONOMOUS_DIFF_LINES)
    reasons.push(`diff exceeds ${MAX_AUTONOMOUS_DIFF_LINES} lines`);
  if (input.leverCount !== 1) reasons.push("not a single-lever diff");
  return reasons;
}

/** The task's `hitl` field. */
export function computeHitl(input: HitlPolicyInput): boolean {
  return hitlReasons(input).length > 0;
}

export interface RulePromotion {
  autonomyEntry: boolean;
  acceptedProposals: number;
}

/**
 * Promotion state for `rule` from the decisions registry text. A promotion is
 * a human-written line `**Autonomy:** <rule>, <evidence>` where the evidence
 * states a count such as "7 accepted proposals". No entry, or an unreadable
 * count, yields no promotion (propose-only).
 */
export function promotionFor(decisions: string, rule: string): RulePromotion {
  const none: RulePromotion = { autonomyEntry: false, acceptedProposals: 0 };
  for (const line of decisions.split("\n")) {
    const m = /^\s*\*\*Autonomy:\*\*\s*([^,\s]+)\s*,\s*(.*)$/.exec(line);
    if (!m || m[1] !== rule) continue;
    const n = /(\d+)\s+accepted/i.exec(m[2]);
    return { autonomyEntry: true, acceptedProposals: n ? Number(n[1]) : 0 };
  }
  return none;
}

if (import.meta.main) {
  const input = JSON.parse(await Bun.stdin.text()) as HitlPolicyInput;
  console.log(
    JSON.stringify({
      hitl: computeHitl(input),
      reasons: hitlReasons(input),
    }),
  );
}
