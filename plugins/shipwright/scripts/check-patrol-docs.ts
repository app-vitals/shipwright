#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-patrol-docs.ts
 *
 * Local pre-commit check for docs/patrols/<patrol>.md, called by the entropy
 * and consolidation skills before they commit a patrol doc. No task-store API:
 * the agent reads and writes repo files locally.
 *
 * Two jobs:
 *   1. validate  — hard cap of 150 lines; no count/summary-number tables; no
 *                  run-history or resolved-items section.
 *   2. material  — is the candidate materially different from the current
 *                  repo file? A timestamp-only change or a pure reorder is not,
 *                  so no docs PR is opened for it.
 *
 * Also exports renderPatrolDoc(), which fits any number of open items under
 * the cap and appends the overflow pointer line.
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-patrol-docs.ts <candidate.md> [current.md]
 *
 * Output: one JSON object { violations, materiallyChanged } on stdout.
 * Exit 0 → no violations; exit 1 → at least one violation.
 */

import { existsSync, readFileSync } from "node:fs";

export const MAX_LINES = 150;

export interface Violation {
  rule: "max-lines" | "count-table" | "run-history" | "resolved-items";
  message: string;
}

export interface CheckResult {
  violations: Violation[];
  materiallyChanged: boolean;
}

const HISTORY_HEADING =
  /^#{1,6}\s*(run[\s-]*history|history|previous runs?|past runs?|run log)\b/i;
const RESOLVED_HEADING = /^#{1,6}\s*(resolved|fixed|closed|completed)\b/i;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const TIMESTAMP_LINE =
  /^\s*(?:[>*_\s-]*)(last[\s-]*(updated|run|scanned|refreshed)|updated|generated|as of|scan(ned)? (at|on)|run (at|on))\b.*$/i;
const ISO_DATE = /\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?/g;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** A table is a count table when any data cell (or a header) is a bare number. */
function findCountTable(lines: string[]): boolean {
  for (let i = 1; i < lines.length; i++) {
    if (!TABLE_SEP.test(lines[i]) || !lines[i].includes("-")) continue;
    if (!lines[i - 1].includes("|")) continue;
    const header = cells(lines[i - 1]).join(" ").toLowerCase();
    if (/\b(count|total|number of|#)\b/.test(header)) return true;
    for (let j = i + 1; j < lines.length && lines[j].includes("|"); j++) {
      if (cells(lines[j]).some((c) => /^\**\d+(\.\d+)?%?\**$/.test(c))) {
        return true;
      }
    }
  }
  return false;
}

export function validatePatrolDoc(candidate: string): Violation[] {
  const lines = candidate.replace(/\n$/, "").split("\n");
  const violations: Violation[] = [];
  if (lines.length > MAX_LINES) {
    violations.push({
      rule: "max-lines",
      message: `max-lines: ${lines.length} lines exceeds the ${MAX_LINES}-line cap`,
    });
  }
  if (findCountTable(lines)) {
    violations.push({
      rule: "count-table",
      message: "count-table: summary/count-number tables belong in the task store run record",
    });
  }
  if (lines.some((l) => HISTORY_HEADING.test(l))) {
    violations.push({
      rule: "run-history",
      message: "run-history: run history belongs in the task store, not the repo doc",
    });
  }
  if (lines.some((l) => RESOLVED_HEADING.test(l))) {
    violations.push({
      rule: "resolved-items",
      message: "resolved-items: the doc lists open items only",
    });
  }
  return violations;
}

/** Normalised, order-independent content lines, with timestamps stripped. */
function contentLines(doc: string): string[] {
  return doc
    .split("\n")
    .filter((l) => !TIMESTAMP_LINE.test(l))
    .map((l) => l.replace(ISO_DATE, "").replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0)
    .sort();
}

export function isMaterialChange(current: string | null, candidate: string): boolean {
  if (current === null) return true;
  const a = contentLines(current);
  const b = contentLines(candidate);
  return a.length !== b.length || a.some((l, i) => l !== b[i]);
}

export function checkPatrolDoc(candidate: string, current: string | null): CheckResult {
  return {
    violations: validatePatrolDoc(candidate),
    materiallyChanged: isMaterialChange(current, candidate),
  };
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

export interface PatrolItem {
  /** Lower number = higher priority. */
  priority: number;
  title: string;
  why: string;
  paths: string[];
}

export function renderPatrolDoc(opts: {
  title: string;
  items: PatrolItem[];
  maxLines?: number;
}): string {
  const cap = opts.maxLines ?? MAX_LINES;
  const sorted = [...opts.items].sort((a, b) => a.priority - b.priority);
  const render = (it: PatrolItem) =>
    `- **${it.title}** — ${it.why} (${it.paths.map((p) => `\`${p}\``).join(", ")})`;
  const header = [`# ${opts.title}`, "", "Open items, highest priority first.", ""];
  // Reserve 2 lines (blank + pointer) in case of overflow.
  const fitsAll = header.length + sorted.length <= cap;
  const room = fitsAll ? sorted.length : Math.max(0, cap - header.length - 2);
  const lines = [...header, ...sorted.slice(0, room).map(render)];
  const rest = sorted.length - room;
  if (rest > 0) {
    lines.push(
      "",
      `The remaining ${rest} open items are tracked in the fix tasks.`,
    );
  }
  return lines.join("\n") + "\n";
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [candidatePath, currentPath] = process.argv.slice(2);
  if (!candidatePath) {
    console.error("usage: check-patrol-docs.ts <candidate.md> [current.md]");
    process.exit(2);
  }
  const candidate = readFileSync(candidatePath, "utf8");
  const current =
    currentPath && existsSync(currentPath) ? readFileSync(currentPath, "utf8") : null;
  const result = checkPatrolDoc(candidate, current);
  console.log(JSON.stringify(result));
  process.exit(result.violations.length > 0 ? 1 : 0);
}
