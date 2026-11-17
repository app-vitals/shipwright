/**
 * plugins/shipwright/scripts/coverage/lcov.ts
 *
 * Parses LCOV content (SF/LF/LH/BRF/BRH/FNF/FNH records) into normalized
 * counts. Ported from the repo coverage gate so the plugin ships standalone.
 */

import type { NormalizedCoverage } from "./types.ts";

function num(line: string, prefixLength: number): number {
  const n = Number.parseInt(line.slice(prefixLength), 10);
  return Number.isNaN(n) ? 0 : n;
}

export interface LcovScan {
  /** Total LF of files dropped by the exclusion predicate. */
  excludedLines: number;
  /** Every SF path seen, excluded or not. */
  paths: string[];
}

/**
 * With `exclude`, files whose SF path matches are left out of every count and
 * the result also carries an LcovScan. Without it the result is unchanged.
 */
export function parseLcov(
  content: string,
  exclude?: (path: string) => boolean,
): (NormalizedCoverage & Partial<LcovScan>) | null {
  let files = 0;
  let skipping = false;
  let excludedLines = 0;
  const paths: string[] = [];
  let lf = 0;
  let lh = 0;
  let brf = 0;
  let brh = 0;
  let fnf = 0;
  let fnh = 0;
  let hasBranches = false;
  let hasFunctions = false;

  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      files++;
      const path = line.slice(3);
      paths.push(path);
      skipping = exclude?.(path) ?? false;
    } else if (skipping) {
      if (line.startsWith("LF:")) excludedLines += num(line, 3);
    } else if (line.startsWith("LF:")) {
      lf += num(line, 3);
    } else if (line.startsWith("LH:")) {
      lh += num(line, 3);
    } else if (line.startsWith("BRF:")) {
      brf += num(line, 4);
      hasBranches = true;
    } else if (line.startsWith("BRH:")) {
      brh += num(line, 4);
    } else if (line.startsWith("FNF:")) {
      fnf += num(line, 4);
      hasFunctions = true;
    } else if (line.startsWith("FNH:")) {
      fnh += num(line, 4);
    }
  }

  if (files === 0) return null;

  const result: NormalizedCoverage & Partial<LcovScan> = {
    lines: { covered: lh, total: lf },
    tool: "lcov",
  };
  if (exclude) {
    result.excludedLines = excludedLines;
    result.paths = paths;
  }
  if (hasBranches) result.branches = { covered: brh, total: brf };
  if (hasFunctions) result.functions = { covered: fnh, total: fnf };
  return result;
}
