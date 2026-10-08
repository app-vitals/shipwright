/**
 * plugins/shipwright/scripts/prompt-audit/rules.ts
 *
 * One function per v1 prompt-audit rule, grouped by class across
 * rules-cost.ts (a, b), rules-stale.ts (c) and rules-structure.ts (e, f).
 * Class (d) is delegated to `/doctor prompt-audit` in the prompt-scan skill.
 * Thresholds: skills/prompt-scan/references/thresholds.md.
 */

import type { Finding, Rule, RuleContext } from "./finding.ts";
import { COST_RULES } from "./rules-cost.ts";
import { STALE_RULES } from "./rules-stale.ts";
import { STRUCTURE_RULES } from "./rules-structure.ts";

export * from "./finding.ts";
export * from "./rules-cost.ts";
export * from "./rules-stale.ts";
export * from "./rules-structure.ts";

export const ALL_RULES: Rule[] = [...COST_RULES, ...STALE_RULES, ...STRUCTURE_RULES];

/** Run every rule; ordering is stable (file, line, rule). */
export function runAllRules(ctx: RuleContext): Finding[] {
  return ALL_RULES.flatMap((rule) => rule(ctx)).sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule),
  );
}
