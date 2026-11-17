/**
 * plugins/shipwright/scripts/coverage/cobertura.ts
 *
 * Parses Cobertura XML without an XML library. Counts come from the root
 * <coverage> attributes (lines-covered/lines-valid); when absent, <line hits>
 * elements are counted. Rate attributes are never read.
 */

import type { NormalizedCoverage } from "./types.ts";

function attr(tag: string, name: string): number | null {
  const m = new RegExp(`\\b${name}="(\\d+)"`).exec(tag);
  return m ? Number.parseInt(m[1] as string, 10) : null;
}

export function parseCobertura(content: string): NormalizedCoverage | null {
  const root = /<coverage\b[^>]*>/.exec(content);
  if (!root) return null;
  const tag = root[0];

  const result: NormalizedCoverage = {
    lines: { covered: 0, total: 0 },
    tool: "cobertura",
  };

  const covered = attr(tag, "lines-covered");
  const valid = attr(tag, "lines-valid");
  if (covered !== null && valid !== null) {
    result.lines = { covered, total: valid };
  } else {
    // <method> blocks repeat their lines inside the owning class — drop them.
    const body = content.replace(/<methods\b[\s\S]*?<\/methods>/g, "");
    let total = 0;
    let hit = 0;
    for (const m of body.matchAll(/<line\b[^>]*>/g)) {
      const hits = attr(m[0], "hits");
      if (hits === null) continue;
      total++;
      if (hits > 0) hit++;
    }
    result.lines = { covered: hit, total };
  }

  const bc = attr(tag, "branches-covered");
  const bv = attr(tag, "branches-valid");
  if (bc !== null && bv !== null) result.branches = { covered: bc, total: bv };

  return result;
}
