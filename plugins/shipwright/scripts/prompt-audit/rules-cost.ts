/**
 * plugins/shipwright/scripts/prompt-audit/rules-cost.ts
 *
 * Class (a) always-loaded cost and class (b) on-invoke cost rules. All are
 * cost-only: the proof is a token delta, quality is never claimed.
 */

import {
  contextsWhere,
  type Finding,
  makeFinding,
  maxTokens,
  type Rule,
  type RuleContext,
  THRESHOLDS,
} from "./finding.ts";
import type { InventoryItem } from "./inventory.ts";
import { CONTEXT_WINDOW, listingBudget } from "./token-count.ts";
import type { SkillStat } from "./usage-attribution.ts";

const WEEK_DAYS = 7;

const isAlways = (i: InventoryItem) =>
  contextsWhere(i, ["always"]).length > 0;
const isListing = (i: InventoryItem) =>
  contextsWhere(i, ["listing"]).length > 0;

export const claudeMdOver200Lines: Rule = (ctx) =>
  ctx.items
    .filter(
      (i) =>
        i.kind === "claude-md" &&
        isAlways(i) &&
        i.bodyLines > THRESHOLDS.claudeMdMaxLines,
    )
    .map((item) => {
      const { estimated } = maxTokens(ctx, item.path);
      return makeFinding({
        class: "a",
        rule: "claude-md-over-200-lines",
        item,
        contexts: contextsWhere(item, ["always"]),
        evidence: "always-loaded CLAUDE.md exceeds the 200-line guidance",
        metrics: {
          before: item.bodyLines,
          projectedAfter: THRESHOLDS.claudeMdMaxLines,
          units: "lines",
          estimated,
        },
        action:
          "Move task-specific sections into path-scoped rules or on-demand docs.",
        severity: "medium",
      });
    });

/** Always-loaded tokens per context × model. */
export const alwaysSetTokens: Rule = (ctx) => {
  const out: Finding[] = [];
  for (const context of ["local-dev", "agent-runtime"] as const) {
    const always = ctx.items.filter((i) => i.loadClass[context] === "always");
    for (const model of ctx.models) {
      const counts = always.map((i) => ({
        item: i,
        t: ctx.tokens[i.path]?.[model],
      }));
      const total = counts.reduce((s, c) => s + (c.t?.tokens ?? 0), 0);
      if (total <= THRESHOLDS.alwaysSetTokens) continue;
      const biggest = counts.reduce((a, b) =>
        (b.t?.tokens ?? 0) > (a.t?.tokens ?? 0) ? b : a,
      ).item;
      out.push(
        makeFinding({
          class: "a",
          rule: "always-set-tokens",
          item: biggest,
          contexts: [context],
          evidence: `always-loaded set for ${context} on ${model} is over budget`,
          metrics: {
            before: total,
            projectedAfter: THRESHOLDS.alwaysSetTokens,
            units: "tokens",
            estimated: counts.some((c) => c.t?.estimated ?? true),
          },
          action: `Trim the always-loaded set; ${biggest.path} is the largest contributor.`,
          severity: total > 2 * THRESHOLDS.alwaysSetTokens ? "high" : "medium",
        }),
      );
    }
  }
  return out;
};

export const ruleWithoutPaths: Rule = (ctx) =>
  ctx.items
    .filter((i) => i.kind === "rule" && i.paths.length === 0)
    .map((item) =>
      makeFinding({
        class: "a",
        rule: "rule-without-paths",
        item,
        contexts: contextsWhere(item, ["always"]),
        evidence: "rule has no paths: frontmatter, so it loads every session",
        metrics: {
          before: maxTokens(ctx, item.path).tokens,
          projectedAfter: 0,
          units: "tokens",
          estimated: maxTokens(ctx, item.path).estimated,
        },
        action: "Add paths: frontmatter so the rule loads only when relevant.",
        severity: "low",
      }),
    );

/** @-imports load at launch, so a deep chain costs the same as inlining. */
export const importChain: Rule = (ctx) =>
  ctx.items
    .filter((i) => i.kind === "import" && i.importDepth > THRESHOLDS.importDepthMax)
    .map((item) =>
      makeFinding({
        class: "a",
        rule: "import-chain",
        item,
        contexts: contextsWhere(item, ["always"]),
        evidence: "file is reached through a long @-import chain at launch",
        metrics: {
          before: item.importDepth,
          projectedAfter: THRESHOLDS.importDepthMax,
          units: "hops",
          estimated: false,
        },
        action:
          "Flatten the chain or drop the import; @-imports never reduce cost.",
        severity: "low",
      }),
    );

export const listingBudgetShare: Rule = (ctx) => {
  const listing = ctx.items.filter(isListing);
  const out: Finding[] = [];
  for (const model of ctx.models) {
    const budget = listingBudget(model);
    if (budget === undefined || !(model in CONTEXT_WINDOW)) continue;
    const chars = listing.reduce((s, i) => s + i.descriptionChars, 0);
    if (chars <= budget * THRESHOLDS.listingShareWarn) continue;
    const biggest = listing.reduce((a, b) =>
      b.descriptionChars > a.descriptionChars ? b : a,
    );
    out.push(
      makeFinding({
        class: "a",
        rule: "listing-budget-share",
        item: biggest,
        contexts: contextsWhere(biggest, ["listing"]),
        evidence: `skill listing approaches the 1% budget for ${model}`,
        metrics: {
          before: chars,
          projectedAfter: Math.floor(budget * THRESHOLDS.listingShareWarn),
          units: "chars",
          estimated: false,
        },
        action: `Shorten listing descriptions; ${biggest.path} is the longest.`,
        severity: chars > budget ? "high" : "medium",
      }),
    );
  }
  return out;
};

export const listingEntryOver1536: Rule = (ctx) =>
  ctx.items
    .filter(
      (i) => isListing(i) && i.descriptionChars > THRESHOLDS.descriptionMaxChars,
    )
    .map((item) =>
      makeFinding({
        class: "a",
        rule: "listing-entry-over-1536",
        item,
        contexts: contextsWhere(item, ["listing"]),
        evidence: "listing description exceeds the per-entry cap and is truncated",
        metrics: {
          before: item.descriptionChars,
          projectedAfter: THRESHOLDS.descriptionMaxChars,
          units: "chars",
          estimated: false,
        },
        action: "Shorten the description below the cap; the tail is cut anyway.",
        severity: "medium",
      }),
    );

export const onInvokeHeavy: Rule = (ctx) =>
  ctx.items
    .filter((i) => i.kind === "command" || i.kind === "skill")
    .flatMap((item) => {
      const { tokens, estimated } = maxTokens(ctx, item.path);
      if (tokens <= THRESHOLDS.onInvokeHeavyTokens) return [];
      return [
        makeFinding({
          class: "b",
          rule: "on-invoke-heavy",
          item,
          contexts: contextsWhere(item, ["on-invoke", "listing"]),
          evidence: "body loads in full on every invocation",
          metrics: {
            before: tokens,
            projectedAfter: THRESHOLDS.onInvokeHeavyTokens,
            units: "tokens",
            estimated,
          },
          action: "Move rarely-needed detail into references read on demand.",
          severity: "medium",
        }),
      ];
    });

/** Name as the usage rows report it: drop any `plugin:` prefix. */
const bareName = (n: string) => n.slice(n.lastIndexOf(":") + 1);

export function statFor(
  usage: SkillStat[] | null,
  item: InventoryItem,
): SkillStat | undefined {
  const base = item.path.split("/").at(-1)?.replace(/\.md$/, "");
  const name = bareName(
    item.kind === "skill" ? (item.name ?? base ?? "") : (base ?? ""),
  );
  return usage?.find((s) => s.kind === "skill" && bareName(s.name) === name);
}

/** Per-invocation cost × weekly invocations; measured delta beats the static count. */
export const invokeCostWeekly: Rule = (ctx: RuleContext) => {
  if (!ctx.usage) return [];
  const weeks = ctx.usageWindowDays / WEEK_DAYS;
  return ctx.items
    .filter((i) => i.kind === "command" || i.kind === "skill")
    .flatMap((item) => {
      const stat = statFor(ctx.usage, item);
      if (!stat || stat.invocations === 0 || weeks <= 0) return [];
      const measured = stat.avgInvokeContextDelta;
      const fallback = maxTokens(ctx, item.path);
      const perInvoke = measured ?? fallback.tokens;
      const weekly = (perInvoke * stat.invocations) / weeks;
      if (weekly <= THRESHOLDS.invokeWeeklyTokens) return [];
      return [
        makeFinding({
          class: "b",
          rule: "invoke-cost-weekly",
          item,
          contexts: contextsWhere(item, ["on-invoke", "listing"]),
          evidence: "invocation cost multiplied by weekly invocations is high",
          metrics: {
            before: Math.round(weekly),
            projectedAfter: THRESHOLDS.invokeWeeklyTokens,
            units: "tokens/week",
            estimated: measured === null && fallback.estimated,
          },
          action: "Trim the body; this is among the most-paid-for prompts.",
          severity: "high",
        }),
      ];
    });
};

export const COST_RULES: Rule[] = [
  claudeMdOver200Lines,
  alwaysSetTokens,
  ruleWithoutPaths,
  importChain,
  listingBudgetShare,
  listingEntryOver1536,
  onInvokeHeavy,
  invokeCostWeekly,
];
