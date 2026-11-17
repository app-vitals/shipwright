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

export function parseLcov(content: string): NormalizedCoverage | null {
  let files = 0;
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

  const result: NormalizedCoverage = {
    lines: { covered: lh, total: lf },
    tool: "lcov",
  };
  if (hasBranches) result.branches = { covered: brh, total: brf };
  if (hasFunctions) result.functions = { covered: fnh, total: fnf };
  return result;
}
