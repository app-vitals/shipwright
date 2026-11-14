#!/usr/bin/env bun
// Risk-rating merge (RSK-1.3).
//
// Merges the deterministic heuristic factors from compute-pr-risk-signals.ts
// with the optional judgment-based `riskAssessment` contributions returned by
// review subagents into a single {level, factors[], table, reason} rating.
//
// Merge rule: heuristic points map to a baseline band via RISK_THRESHOLDS.
// Subagents can only RAISE the level: any subagent "high" floors the result at
// high, any "medium" floors it at medium. They can never lower it below the
// heuristic band. Malformed subagent input (bad level, missing factor name,
// non-object entries) is ignored; empty/missing input yields the
// heuristic-only rating. Pure and deterministic: no IO outside the CLI.
//
// CLI:
//   bun run plugins/shipwright/scripts/compute-risk-rating.ts '{"heuristic":{"factors":[...],"totalPoints":5},"subagents":[{"level":"high","factors":[{"factor":"blast radius","level":"high","evidence":"a.ts:1"}]}]}'
// or pipe the same JSON blob via stdin.

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high";

export type HeuristicFactor = {
  factor: string;
  level: RiskLevel;
  points: number;
  evidence: string;
};

export type SubagentFactor = {
  factor: string;
  level: RiskLevel;
  evidence: string;
};

export type RiskRatingInput = {
  heuristic: { factors: HeuristicFactor[]; totalPoints: number };
  /** Each entry is a reviewer's `riskAssessment` (shape not trusted). */
  subagents?: unknown[];
};

export type RatedFactor = {
  source: "heuristic" | "subagent";
  factor: string;
  level: RiskLevel;
  points?: number;
  evidence: string;
};

export type RiskRating = {
  level: RiskLevel;
  heuristicLevel: RiskLevel;
  factors: RatedFactor[];
  table: string;
  reason: string;
};

// ─── Thresholds ───────────────────────────────────────────────────────────────

/** Published heuristic-points → baseline band table (inclusive lower bounds). */
export const RISK_THRESHOLDS: { level: RiskLevel; minPoints: number }[] = [
  { level: "high", minPoints: 8 },
  { level: "medium", minPoints: 4 },
  { level: "low", minPoints: 0 },
];

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

const isLevel = (v: unknown): v is RiskLevel =>
  v === "low" || v === "medium" || v === "high";

const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  RANK[a] >= RANK[b] ? a : b;

export function bandFor(points: number): RiskLevel {
  const p = Number.isFinite(points) ? points : 0;
  return (
    RISK_THRESHOLDS.find((t) => p >= t.minPoints)?.level ??
    RISK_THRESHOLDS[RISK_THRESHOLDS.length - 1].level
  );
}

// ─── Subagent parsing ─────────────────────────────────────────────────────────

type ParsedAssessment = { level: RiskLevel | null; factors: SubagentFactor[] };

function parseAssessment(raw: unknown): ParsedAssessment {
  if (typeof raw !== "object" || raw === null) {
    return { level: null, factors: [] };
  }
  const a = raw as { level?: unknown; factors?: unknown };
  const factors: SubagentFactor[] = [];
  if (Array.isArray(a.factors)) {
    for (const f of a.factors) {
      if (typeof f !== "object" || f === null) continue;
      const { factor, level, evidence } = f as Record<string, unknown>;
      if (typeof factor !== "string" || factor.trim() === "") continue;
      if (!isLevel(level)) continue;
      factors.push({
        factor: factor.trim(),
        level,
        evidence: typeof evidence === "string" ? evidence : "",
      });
    }
  }
  return { level: isLevel(a.level) ? a.level : null, factors };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

function renderTable(factors: RatedFactor[]): string {
  const rows = factors.map(
    (f) =>
      `| ${cell(f.factor)} | ${f.level} | ${f.source === "heuristic" ? `${f.points} pts` : "judgment"} | ${cell(f.evidence)} |`,
  );
  return [
    "| Factor | Level | Basis | Evidence |",
    "|--------|-------|-------|----------|",
    ...rows,
  ].join("\n");
}

// ─── computeRiskRating ────────────────────────────────────────────────────────

export function computeRiskRating(input: RiskRatingInput): RiskRating {
  const heuristicFactors = input.heuristic?.factors ?? [];
  const heuristicLevel = bandFor(input.heuristic?.totalPoints ?? 0);

  const assessments = (
    Array.isArray(input.subagents) ? input.subagents : []
  ).map(parseAssessment);

  // A reviewer's overall level and its factor levels all count as raises.
  let level = heuristicLevel;
  for (const a of assessments) {
    if (a.level) level = maxLevel(level, a.level);
    for (const f of a.factors) level = maxLevel(level, f.level);
  }

  const factors: RatedFactor[] = [
    ...heuristicFactors.map((f) => ({
      source: "heuristic" as const,
      factor: f.factor,
      level: f.level,
      points: f.points,
      evidence: f.evidence,
    })),
    ...assessments.flatMap((a) =>
      a.factors.map((f) => ({ source: "subagent" as const, ...f })),
    ),
  ];

  const raised = RANK[level] > RANK[heuristicLevel];
  const drivers = factors
    .filter((f) => f.level === level && f.level !== "low")
    .map((f) => f.factor);
  const driverText = drivers.length > 0 ? ` — ${[...new Set(drivers)].join(", ")}` : "";
  const reason = raised
    ? `Risk: ${level} (raised from ${heuristicLevel} by reviewer assessment)${driverText}`
    : `Risk: ${level}${driverText}`;

  return { level, heuristicLevel, factors, table: renderTable(factors), reason };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseCliInput(raw: string): RiskRatingInput {
  const parsed = JSON.parse(raw) as Partial<RiskRatingInput>;
  const h = parsed.heuristic;
  if (!h || !Array.isArray(h.factors) || typeof h.totalPoints !== "number") {
    throw new Error(
      'Input JSON must have "heuristic": {"factors": [...], "totalPoints": number}',
    );
  }
  return { heuristic: h, subagents: parsed.subagents };
}

if (import.meta.main) {
  const arg = process.argv[2];
  const raw = arg && arg.length > 0 ? arg : await Bun.stdin.text();
  console.log(JSON.stringify(computeRiskRating(parseCliInput(raw))));
}
