/**
 * plugins/shipwright/scripts/coverage/go-cover.ts
 *
 * Parses a Go coverprofile ("mode: set|count|atomic" header, then
 * "file:start.col,end.col numStmts count" blocks). Statements are treated as
 * lines; Go reports no branch or function data.
 */

import type { NormalizedCoverage } from "./types.ts";

const MODE_RE = /^mode:\s*(set|count|atomic)\s*$/;
const BLOCK_RE = /^.+:\d+\.\d+,\d+\.\d+\s+(\d+)\s+(\d+)\s*$/;

export function parseGoCover(content: string): NormalizedCoverage | null {
  const lines = content.split("\n").map((l) => l.trim());
  const first = lines.find((l) => l !== "");
  if (first === undefined || !MODE_RE.test(first)) return null;

  let total = 0;
  let covered = 0;
  for (const line of lines) {
    const m = BLOCK_RE.exec(line);
    if (!m) continue;
    const stmts = Number.parseInt(m[1] as string, 10);
    const count = Number.parseInt(m[2] as string, 10);
    total += stmts;
    if (count > 0) covered += stmts;
  }

  return { lines: { covered, total }, tool: "go-cover" };
}
