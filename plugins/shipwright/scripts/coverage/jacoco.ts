/**
 * plugins/shipwright/scripts/coverage/jacoco.ts
 *
 * Parses JaCoCo XML without an XML library. Only <counter> elements that are
 * direct children of <report> are used — package/class/group counters are
 * nested and would double count.
 */

import type { CoverageCounts, NormalizedCoverage } from "./types.ts";

function readAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? (m[1] as string) : null;
}

export function parseJacoco(content: string): NormalizedCoverage | null {
  const xml = content.replace(/<!--[\s\S]*?-->/g, "");
  const counters = new Map<string, CoverageCounts>();
  let depth = 0;
  let sawReport = false;

  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:-]*)\b[^>]*>/g)) {
    const [tag, closing, name] = m as unknown as [string, string, string];
    const selfClosing = tag.endsWith("/>");
    if (closing) {
      depth--;
      continue;
    }
    if (depth === 0 && name === "report") sawReport = true;
    if (depth === 1 && sawReport && name === "counter") {
      const type = readAttr(tag, "type");
      const missed = Number.parseInt(readAttr(tag, "missed") ?? "", 10);
      const covered = Number.parseInt(readAttr(tag, "covered") ?? "", 10);
      if (type && !Number.isNaN(missed) && !Number.isNaN(covered)) {
        counters.set(type, { covered, total: covered + missed });
      }
    }
    if (!selfClosing) depth++;
  }

  const lines = counters.get("LINE");
  if (!lines) return null;

  const result: NormalizedCoverage = { lines, tool: "jacoco" };
  const branches = counters.get("BRANCH");
  const functions = counters.get("METHOD");
  if (branches) result.branches = branches;
  if (functions) result.functions = functions;
  return result;
}
