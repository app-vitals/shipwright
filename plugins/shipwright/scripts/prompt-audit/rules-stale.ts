/**
 * plugins/shipwright/scripts/prompt-audit/rules-stale.ts
 *
 * Class (c) stale-fact rules. Static-only, cost-only: repairing a dead
 * reference changes no behaviour the model could have relied on. Class (d)
 * dated-model patterns are delegated to `/doctor prompt-audit` in the skill.
 */

import { type Finding, makeFinding, type Rule, THRESHOLDS } from "./finding.ts";
import type { ResolverRule } from "./reference-resolver.ts";

const BY_RESOLVER_RULE: Array<[ResolverRule, string]> = [
  ["unresolvable-path", "path"],
  ["unresolvable-command", "command"],
  ["unknown-flag", "flag"],
  ["retired-model-id", "model id"],
];

function resolverRule(rule: ResolverRule): Rule {
  const label = BY_RESOLVER_RULE.find(([r]) => r === rule)?.[1] ?? rule;
  return (ctx) =>
    ctx.unresolved
      .filter((u) => u.rule === rule)
      .flatMap((u) => {
        const item = ctx.items.find((i) => i.path === u.file);
        if (!item) return [];
        return [
          makeFinding({
            class: "c",
            rule,
            item,
            line: u.line,
            evidence: `${label} ${u.value}: ${u.reason}`,
            metrics: { before: 1, projectedAfter: 0, units: "references", estimated: false },
            action: `Fix or remove the stale ${label} ${u.value}.`,
            severity: rule === "retired-model-id" ? "medium" : "low",
          }),
        ];
      });
}

export const unresolvablePath = resolverRule("unresolvable-path");
export const unresolvableCommand = resolverRule("unresolvable-command");
export const unknownFlag = resolverRule("unknown-flag");
export const retiredModelId = resolverRule("retired-model-id");

export const orphanedAutoSection: Rule = (ctx) =>
  ctx.orphans.flatMap((o) => {
    const item = ctx.items.find((i) => i.path === o.file);
    if (!item) return [];
    return [
      makeFinding({
        class: "c",
        rule: "orphaned-auto-section",
        item,
        line: o.line,
        evidence: `auto-maintained section ${o.heading ?? o.banner} has no writer`,
        metrics: { before: 1, projectedAfter: 0, units: "sections", estimated: false },
        action: "Delete the section or restore the job that maintains it.",
        severity: "medium",
      }),
    ];
  });

/** Median, not max: one old line is normal, mostly-old lines mean a stale file. */
export const blameAge: Rule = (ctx) =>
  ctx.items.flatMap((item): Finding[] => {
    const age = ctx.blame[item.path];
    if (!age || age.medianAgeDays <= THRESHOLDS.blameAgeDays) return [];
    return [
      makeFinding({
        class: "c",
        rule: "blame-age",
        item,
        line: age.oldestLine?.line,
        evidence: "most lines are older than the staleness threshold",
        metrics: {
          before: Math.round(age.medianAgeDays),
          projectedAfter: THRESHOLDS.blameAgeDays,
          units: "days",
          estimated: false,
        },
        action: "Re-verify the file's claims against the current code.",
        severity: "low",
        confidence: "medium",
      }),
    ];
  });

export const STALE_RULES: Rule[] = [
  unresolvablePath,
  unresolvableCommand,
  unknownFlag,
  retiredModelId,
  orphanedAutoSection,
  blameAge,
];
