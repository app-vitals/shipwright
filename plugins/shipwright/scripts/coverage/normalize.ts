/**
 * plugins/shipwright/scripts/coverage/normalize.ts
 *
 * Turns one or more native coverage report files into a single normalized
 * result. Files in an unrecognised or unparseable format are ignored; the
 * remaining reports are summed.
 */

import { parseCobertura } from "./cobertura.ts";
import { detectFormat } from "./detect.ts";
import { parseGoCover } from "./go-cover.ts";
import { parseJacoco } from "./jacoco.ts";
import { parseLcov } from "./lcov.ts";
import type { CoverageCounts, NormalizedCoverage } from "./types.ts";

export interface ReportFile {
  name: string;
  content: string;
}

function validCounts(v: unknown): v is CoverageCounts {
  if (typeof v !== "object" || v === null) return false;
  const { covered, total } = v as Record<string, unknown>;
  return (
    Number.isInteger(covered) &&
    Number.isInteger(total) &&
    (covered as number) >= 0 &&
    (covered as number) <= (total as number)
  );
}

/** Accepts a shipwright-coverage.json document as-is; null if invalid. */
export function parseShipwrightJson(
  content: string,
): NormalizedCoverage | null {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (!validCounts(d.lines)) return null;

  const result: NormalizedCoverage = {
    lines: { covered: d.lines.covered, total: d.lines.total },
    tool: typeof d.tool === "string" && d.tool !== "" ? d.tool : "shipwright",
  };
  for (const key of ["branches", "functions"] as const) {
    if (d[key] === undefined) continue;
    const v = d[key];
    if (!validCounts(v)) return null;
    result[key] = { covered: v.covered, total: v.total };
  }
  return result;
}

function parseFile(file: ReportFile): NormalizedCoverage | null {
  switch (detectFormat(file.name, file.content)) {
    case "lcov":
      return parseLcov(file.content);
    case "cobertura":
      return parseCobertura(file.content);
    case "jacoco":
      return parseJacoco(file.content);
    case "go-cover":
      return parseGoCover(file.content);
    case "shipwright":
      return parseShipwrightJson(file.content);
    default:
      return null;
  }
}

function add(a: CoverageCounts | undefined, b: CoverageCounts | undefined) {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return a;
  return { covered: a.covered + b.covered, total: a.total + b.total };
}

/** Sums every recognised report; null when none could be parsed. */
export function normalizeReports(
  files: ReportFile[],
): NormalizedCoverage | null {
  const parsed = files
    .map(parseFile)
    .filter((r): r is NormalizedCoverage => r !== null);
  if (parsed.length === 0) return null;

  let lines: CoverageCounts = { covered: 0, total: 0 };
  let branches: CoverageCounts | undefined;
  let functions: CoverageCounts | undefined;
  for (const r of parsed) {
    lines = add(lines, r.lines) as CoverageCounts;
    branches = add(branches, r.branches);
    functions = add(functions, r.functions);
  }

  const tool = [...new Set(parsed.map((r) => r.tool))].sort().join("+");
  const result: NormalizedCoverage = { lines, tool };
  if (branches) result.branches = branches;
  if (functions) result.functions = functions;
  return result;
}
