/**
 * plugins/shipwright/scripts/prompt-audit/rules-structure.ts
 *
 * Class (e) structure-vs-loading-rules and class (f) instruction-density
 * rules. Rules that rearrange what the model reads are quality-claimed and
 * always carry an eval; size and format repairs are cost-only.
 */

import {
  contextsWhere,
  evalKindFor,
  type Finding,
  makeFinding,
  maxTokens,
  type Rule,
  THRESHOLDS,
} from "./finding.ts";
import {
  analyzeInstructionDensity,
  maskNonProse,
} from "./instruction-density.ts";
import type { InventoryItem } from "./inventory.ts";
import { statFor } from "./rules-cost.ts";

const isListing = (i: InventoryItem) => contextsWhere(i, ["listing"]).length > 0;
const isAlways = (i: InventoryItem) => contextsWhere(i, ["always"]).length > 0;
const PROMPT_KINDS = new Set(["claude-md", "rule", "import", "skill", "command", "agent", "template"]);
const PATH_REF = /`?((?:[\w.-]+\/)+[\w.-]+\.\w+)`?/g;

/** Sections of an always-loaded file that only matter under one directory. */
export const moveToPathRule: Rule = (ctx) =>
  ctx.items
    .filter((i) => isAlways(i) && (i.kind === "claude-md" || i.kind === "import"))
    .flatMap((item): Finding[] => {
      const lines = ctx.read(item.path).split("\n");
      const starts = lines.flatMap((l, n) => (/^##\s/.test(l) ? [n] : []));
      return starts.flatMap((start, k): Finding[] => {
        const end = starts[k + 1] ?? lines.length;
        const section = lines.slice(start, end);
        if (section.length < THRESHOLDS.moveToPathMinLines) return [];
        const refs = [...section.join("\n").matchAll(PATH_REF)].map((m) => m[1]);
        const dirs = new Set(refs.map((r) => r.split("/").slice(0, 2).join("/")));
        if (refs.length < THRESHOLDS.moveToPathMinRefs || dirs.size !== 1) return [];
        return [
          makeFinding({
            class: "e",
            rule: "move-to-path-rule",
            item,
            contexts: contextsWhere(item, ["always"]),
            line: start + 1,
            lineEnd: end,
            evidence: `section ${lines[start].replace(/^#+\s*/, "")} only concerns ${[...dirs][0]}`,
            metrics: { before: section.length, projectedAfter: 0, units: "lines", estimated: true },
            action: `Move the section into a .claude/rules file with paths: ${[...dirs][0]}/**.`,
            severity: "medium",
            confidence: "medium",
            evalKind: evalKindFor(item),
          }),
        ];
      });
    });

/** A skill invoked in most runs is paid for twice: listing plus body. */
export const skillToDocsIndex: Rule = (ctx) => {
  if (!ctx.usage || ctx.totalRuns <= 0) return [];
  return ctx.items
    .filter((i) => i.kind === "skill")
    .flatMap((item): Finding[] => {
      const stat = statFor(ctx.usage, item);
      const share = stat ? stat.runs / ctx.totalRuns : 0;
      if (share <= THRESHOLDS.skillHotRunShare) return [];
      return [
        makeFinding({
          class: "e",
          rule: "skill-to-docs-index",
          item,
          contexts: contextsWhere(item, ["listing"]),
          evidence: "skill is invoked in most runs",
          metrics: { before: +share.toFixed(2), projectedAfter: THRESHOLDS.skillHotRunShare, units: "run share", estimated: false },
          action: "Fold the skill into an always-loaded docs index instead of invoking it.",
          severity: "medium",
          evalKind: "trigger",
        }),
      ];
    });
};

export const skillOver500Lines: Rule = (ctx) =>
  ctx.items
    .filter((i) => i.kind === "skill" && i.bodyLines > THRESHOLDS.skillMaxLines)
    .map((item) =>
      makeFinding({
        class: "e",
        rule: "skill-over-500-lines",
        item,
        contexts: contextsWhere(item, ["listing"]),
        evidence: "skill body exceeds the 500-line guidance",
        metrics: { before: item.bodyLines, projectedAfter: THRESHOLDS.skillMaxLines, units: "lines", estimated: false },
        action: "Split rarely-used detail into references/ files read on demand.",
        severity: "medium",
      }),
    );

/** Hard constraints buried late in a file are lost after compaction. */
export const keyInstructionsNotNearTop: Rule = (ctx) =>
  ctx.items
    .filter((i) => PROMPT_KINDS.has(i.kind) && i.bodyLines >= THRESHOLDS.keyInstructionMinLines)
    .flatMap((item): Finding[] => {
      const d = analyzeInstructionDensity(ctx.read(item.path));
      if (d.firstHardConstraintRatio === null || d.firstHardConstraintRatio <= THRESHOLDS.keyInstructionRatio) return [];
      const { tokens, estimated } = maxTokens(ctx, item.path);
      const pastCap = tokens * d.firstHardConstraintRatio > THRESHOLDS.postCompactionCapTokens;
      return [
        makeFinding({
          class: "e",
          rule: "key-instructions-not-near-top",
          item,
          line: d.firstHardConstraintLine ?? 1,
          evidence: pastCap
            ? "first hard constraint sits past the post-compaction cap"
            : "first hard constraint appears late in the file",
          metrics: { before: +d.firstHardConstraintRatio.toFixed(2), projectedAfter: THRESHOLDS.keyInstructionRatio, units: "file fraction", estimated },
          action: "Move the hard constraints to the top of the file.",
          severity: pastCap ? "high" : "medium",
          evalKind: evalKindFor(item),
        }),
      ];
    });

/** Commands carry descriptions too, but are not listing entries (see listing-entry-over-1536). */
export const descriptionOver1536: Rule = (ctx) =>
  ctx.items
    .filter((i) => !isListing(i) && i.descriptionChars > THRESHOLDS.descriptionMaxChars)
    .map((item) =>
      makeFinding({
        class: "e",
        rule: "description-over-1536",
        item,
        evidence: "description exceeds the 1,536-char cap",
        metrics: { before: item.descriptionChars, projectedAfter: THRESHOLDS.descriptionMaxChars, units: "chars", estimated: false },
        action: "Shorten the description below the cap.",
        severity: "low",
      }),
    );

const MULTILINE_DESC = /^description:\s*[>|][+-]?\s*$/m;

export const descriptionMultiline: Rule = (ctx) =>
  ctx.items.flatMap((item): Finding[] => {
    const fm = ctx.read(item.path).match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm || !MULTILINE_DESC.test(fm[1])) return [];
    return [
      makeFinding({
        class: "e",
        rule: "description-multiline",
        item,
        evidence: "description uses a multi-line YAML block scalar",
        metrics: { before: 1, projectedAfter: 0, units: "block scalars", estimated: false },
        action: "Rewrite the description as a single-line string.",
        severity: "low",
      }),
    ];
  });

export const frontmatterMissingName: Rule = (ctx) =>
  ctx.items
    .filter((i) => (i.kind === "skill" || i.kind === "agent") && !i.name)
    .map((item) =>
      makeFinding({
        class: "e",
        rule: "frontmatter-missing-name",
        item,
        contexts: contextsWhere(item, ["listing"]),
        evidence: "listing entry has no name in its frontmatter",
        metrics: { before: 1, projectedAfter: 0, units: "missing fields", estimated: false },
        action: "Add a name: field to the frontmatter.",
        severity: "medium",
      }),
    );

/** Stub plus skill carrying the same description are both listed. */
export const duplicateListingEntry: Rule = (ctx) => {
  const groups = new Map<string, InventoryItem[]>();
  for (const i of ctx.items.filter((x) => isListing(x) && x.description)) {
    const key = (i.description ?? "").trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .flatMap((g) =>
      g.slice(1).map((item) =>
        makeFinding({
          class: "e",
          rule: "duplicate-listing-entry",
          item,
          contexts: contextsWhere(item, ["listing"]),
          evidence: `description duplicates ${g[0].path}`,
          metrics: { before: item.descriptionChars, projectedAfter: 0, units: "chars", estimated: false },
          action: "Give the stub a distinct short description or hide it from the listing.",
          severity: "low",
        }),
      ),
    );
};

const densityItems = (ctx: Parameters<Rule>[0]) =>
  ctx.items.filter((i) => PROMPT_KINDS.has(i.kind));

export const instructionCountHigh: Rule = (ctx) =>
  densityItems(ctx).flatMap((item): Finding[] => {
    const d = analyzeInstructionDensity(ctx.read(item.path));
    if (d.imperatives <= THRESHOLDS.instructionCountMax) return [];
    return [
      makeFinding({
        class: "f",
        rule: "instruction-count-high",
        item,
        evidence: "file carries more imperative instructions than the threshold",
        metrics: { before: d.imperatives, projectedAfter: THRESHOLDS.instructionCountMax, units: "imperatives", estimated: false },
        action: "Consolidate or drop low-value instructions.",
        severity: "medium",
        evalKind: evalKindFor(item),
      }),
    ];
  });

export const capsEmphasisRatio: Rule = (ctx) =>
  densityItems(ctx).flatMap((item): Finding[] => {
    const d = analyzeInstructionDensity(ctx.read(item.path));
    const ratio = d.nonBlankLines === 0 ? 0 : d.capsEmphasis / d.nonBlankLines;
    if (d.capsEmphasis < THRESHOLDS.capsMinCount || ratio <= THRESHOLDS.capsRatioMax) return [];
    return [
      makeFinding({
        class: "f",
        rule: "caps-emphasis-ratio",
        item,
        evidence: "MUST/NEVER/ALWAYS/CRITICAL emphasis is dense relative to file length",
        metrics: { before: +ratio.toFixed(3), projectedAfter: THRESHOLDS.capsRatioMax, units: "caps per line", estimated: false },
        action: "Reserve capitals for the few constraints that matter.",
        severity: "low",
        evalKind: evalKindFor(item),
      }),
    ];
  });

const PROHIBITION = /\b(?:never|do not|don['’]t|must not)\b/i;

export const prohibitionCluster: Rule = (ctx) =>
  densityItems(ctx).flatMap((item): Finding[] => {
    const lines = maskNonProse(ctx.read(item.path));
    const hits = lines.flatMap((l, n) => (PROHIBITION.test(l) ? [n] : []));
    const size = THRESHOLDS.prohibitionClusterSize;
    for (let k = 0; k + size - 1 < hits.length; k++) {
      if (hits[k + size - 1] - hits[k] < THRESHOLDS.prohibitionClusterWindow) {
        return [
          makeFinding({
            class: "f",
            rule: "prohibition-cluster",
            item,
            line: hits[k] + 1,
            lineEnd: hits[k + size - 1] + 1,
            evidence: "several prohibitions are stacked in a short span",
            metrics: { before: size, projectedAfter: 1, units: "prohibitions", estimated: false },
            action: "Rephrase as one positive instruction with a single exception list.",
            severity: "low",
            evalKind: evalKindFor(item),
          }),
        ];
      }
    }
    return [];
  });

export const STRUCTURE_RULES: Rule[] = [
  moveToPathRule,
  skillToDocsIndex,
  skillOver500Lines,
  keyInstructionsNotNearTop,
  descriptionOver1536,
  descriptionMultiline,
  frontmatterMissingName,
  duplicateListingEntry,
  instructionCountHigh,
  capsEmphasisRatio,
  prohibitionCluster,
];
