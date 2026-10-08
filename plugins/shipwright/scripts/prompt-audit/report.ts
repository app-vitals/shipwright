/**
 * plugins/shipwright/scripts/prompt-audit/report.ts
 *
 * Renders prompt-audit-report.md from the ledger: header, always-loaded
 * baseline table, skill-listing budget table, then one section per finding
 * class sorted by projected weekly token saving.
 */

import { CONTEXTS, type FindingClass } from "./finding.ts";
import type { Ledger, LedgerEntry, ScanFinding } from "./ledger.ts";
import { listingBudget } from "./token-count.ts";

export const REPORT_PATH = "prompt-audit-report.md";

const CLASS_TITLES: Record<FindingClass, string> = {
  a: "always-loaded cost",
  b: "on-invoke cost",
  c: "stale references",
  e: "structure",
  f: "instruction density",
};

const fmt = (n: number) => n.toLocaleString("en-US");

/** Projected token saving per week; non-token units contribute nothing. */
export function projectedSaving(f: ScanFinding, weeklyRuns = 1): number {
  if (f.metrics.units !== "tokens") return 0;
  const after = f.metrics.projectedAfter ?? f.metrics.before;
  return Math.max(0, f.metrics.before - after) * weeklyRuns;
}

export interface ReportInput {
  ledger: Ledger;
  generatedAt: Date;
  /** Runs per week used to scale per-run token savings; default 1. */
  weeklyRuns?: number;
}

function blastSummary(f: ScanFinding): string {
  const b = f.blastRadius;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return `${plural(b.referrers.length, "referrer")}, ${plural(b.crons.length, "cron")}, ${plural(b.pinningTests.length, "pinning test")}, ${plural(b.sourceMapPages.length, "page")} (lower bound)`;
}

function row(f: LedgerEntry, weeklyRuns: number): string {
  const m = f.metrics;
  const after = m.projectedAfter === undefined ? "?" : fmt(m.projectedAfter);
  const est = m.estimated ? " (estimate)" : "";
  const evalCost = (f.measurement.evals ?? []).reduce(
    (s, e) => s + e.estCostUsd,
    0,
  );
  const saving = projectedSaving(f, weeklyRuns);
  return [
    `| \`${f.file}:${f.line}\``,
    f.rule,
    `${fmt(m.before)} -> ${after} ${m.units}${est}`,
    saving > 0 ? fmt(saving) : "-",
    f.measurement.tier,
    f.measurement.tier === "eval" ? `$${evalCost.toFixed(2)}` : "-",
    f.claim,
    f.severity,
    blastSummary(f),
    `\`${f.scannedAt}\` |`,
  ].join(" | ");
}

export function renderReport({
  ledger,
  generatedAt,
  weeklyRuns = 1,
}: ReportInput): string {
  const baselineRows = CONTEXTS.flatMap((c) =>
    Object.entries(ledger.baselines[c] ?? {}).map(([model, b]) => ({
      c,
      model,
      b,
    })),
  );
  const anyEstimated =
    baselineRows.some(({ b }) => b.estimated) ||
    Object.values(ledger.findings).some((f) => f.metrics.estimated);

  const out: string[] = [
    "# Prompt Audit Report",
    "",
    `- Generated: ${generatedAt.toISOString()}`,
    `- Models: ${ledger.models.join(", ") || "none"}`,
    `- Contexts: ${CONTEXTS.join(", ")}`,
    `- Claude Code version: ${ledger.claudeCodeVersion ?? "unknown"}`,
    `- Token figures: ${anyEstimated ? "some are estimated (labelled estimate; no API key or count_tokens failed)" : "exact count_tokens"}`,
    "",
    "Token deltas are only valid same-model. Shorten findings are cost-only: reduced tokens are certain, unchanged quality is unmeasured (no effect detected in these settings is the most the cited studies support). Blast radius is derived from prose references and is a lower bound.",
    "",
    "## Always-loaded baseline",
    "",
    "| Context | Model | Always-loaded tokens (static) | Measured first-turn tokens | Figure |",
    "|---|---|---|---|---|",
    ...baselineRows.map(
      ({ c, model, b }) =>
        `| ${c} | ${model} | ${fmt(b.alwaysTokens)} | ${b.measuredContextTokens === undefined ? "n/a" : fmt(b.measuredContextTokens)} | ${b.estimated ? "estimate" : "exact"} |`,
    ),
    "",
    "## Skill listing budget",
    "",
    "| Context | Model | Listing chars | Budget (1% of window) | Share |",
    "|---|---|---|---|---|",
    ...baselineRows.map(({ c, model, b }) => {
      const budget = listingBudget(model);
      return `| ${c} | ${model} | ${fmt(b.listingChars)} | ${budget === undefined ? "unknown" : fmt(budget)} | ${budget ? `${((b.listingChars / budget) * 100).toFixed(1)}%` : "n/a"} |`;
    }),
    "",
    "## Findings",
  ];

  const active = Object.values(ledger.findings).filter(
    (f) =>
      f.lastSeen === ledger.lastRun &&
      f.status !== "suppressed" &&
      f.status !== "resolved",
  );
  const classes = [...new Set(active.map((f) => f.class))].sort();
  if (classes.length === 0) out.push("", "No findings.");
  for (const cls of classes) {
    const rows = active
      .filter((f) => f.class === cls)
      .sort(
        (a, b) =>
          projectedSaving(b, weeklyRuns) - projectedSaving(a, weeklyRuns) ||
          a.file.localeCompare(b.file) ||
          a.rule.localeCompare(b.rule),
      );
    out.push(
      "",
      `### Class ${cls}: ${CLASS_TITLES[cls]}`,
      "",
      `| Location | Rule | Before -> projected after | Saving/week (tokens) | Tier | Est. eval cost | Label | Severity | Blast radius | Scanned at |`,
      "|---|---|---|---|---|---|---|---|---|---|",
      ...rows.map((f) => row(f, weeklyRuns)),
    );
  }
  return `${out.join("\n")}\n`;
}
