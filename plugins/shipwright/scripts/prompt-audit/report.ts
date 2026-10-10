/**
 * plugins/shipwright/scripts/prompt-audit/report.ts
 *
 * Renders prompt-audit-report.md from the ledger: header, always-loaded
 * baseline table, skill-listing budget table, then one section per finding
 * class sorted by projected weekly token saving.
 */

import {
  type CommandAdherence,
  commandOfFile,
  rankAdherence,
} from "./adherence.ts";
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
  /** Per-command adherence; null/absent when the data is unavailable. */
  adherence?: CommandAdherence[] | null;
  /** Show low-severity unresolvable-path findings; hidden (and counted) by default. */
  includeUnresolvable?: boolean;
}

const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;

function adherenceSection(adherence: CommandAdherence[] | null): string[] {
  if (adherence === null) {
    return [
      "## Step adherence",
      "",
      "Adherence data unavailable (admin API unreachable or not configured); findings are ranked by projected saving only.",
    ];
  }
  if (adherence.length === 0) {
    return [
      "## Step adherence",
      "",
      "No adherence data in the window; findings are ranked by projected saving only.",
    ];
  }
  return [
    "## Step adherence",
    "",
    "Share of runs where every mandatory, measurable step ran (a dispatch proves a step started, not that it was done well). Findings for lower-adherence commands rank first.",
    "",
    "| Command | Adherence | Adherent runs | Runs |",
    "|---|---|---|---|",
    ...rankAdherence(adherence).map(
      (a) =>
        `| ${a.command} | ${pct(a.rate)} | ${a.adherentRuns} | ${a.runs} |`,
    ),
  ];
}

const QUIETED_RULE = "unresolvable-path";

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
  adherence = null,
  includeUnresolvable = false,
}: ReportInput): string {
  const rateOf = new Map((adherence ?? []).map((a) => [a.command, a.rate]));
  // Rates are <= 1, so 2 sorts commands with no rate after every rated one.
  const rateFor = (file: string): number => {
    const cmd = commandOfFile(file);
    return (cmd ? rateOf.get(cmd) : undefined) ?? 2;
  };
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
    ...adherenceSection(adherence),
    "",
    "## Findings",
  ];

  const seen = Object.values(ledger.findings).filter(
    (f) =>
      f.lastSeen === ledger.lastRun &&
      f.status !== "suppressed" &&
      f.status !== "resolved",
  );
  const active = includeUnresolvable
    ? seen
    : seen.filter((f) => f.rule !== QUIETED_RULE);
  const hidden = seen.length - active.length;
  if (hidden > 0)
    out.push(
      "",
      `${fmt(hidden)} low-severity \`${QUIETED_RULE}\` finding${hidden === 1 ? "" : "s"} hidden; pass \`--include-unresolvable\` to show.`,
    );
  const classes = [...new Set(active.map((f) => f.class))].sort();
  if (classes.length === 0) out.push("", "No findings.");
  for (const cls of classes) {
    const rows = active
      .filter((f) => f.class === cls)
      .sort(
        (a, b) =>
          rateFor(a.file) - rateFor(b.file) ||
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
