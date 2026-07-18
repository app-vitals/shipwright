#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-consolidation-patrol.ts
 *
 * Pre-check for the consolidation-patrol-maintenance cron.
 *
 * Reads state/consolidation-ledger.json (see
 * skills/consolidation-scan/references/ledger-schema.md for the schema) and
 * looks for candidates worth waking a full Claude session for:
 *   - Already `ready_to_propose` (met the Rule of Three promotion bar).
 *   - Still `tracking` but with `occurrence_count >= 2` — one observation away
 *     from the count threshold. occurrence_count alone doesn't promote a
 *     candidate (consecutive_stable_runs and suppression checks also apply —
 *     see the ledger schema's promotion rule), but it's a cheap proxy signal
 *     worth surfacing; the consolidation-scan/consolidation-fix skills remain
 *     authoritative on whether there's real work.
 *
 * - A missing ledger is a normal first run (no candidates could possibly
 *   exist yet) → exit 1 (nothing to do).
 * - A ledger that fails to read/parse → exit 0 (permissive; can't rule out
 *   work exists).
 * - Zero interesting candidates → exit 1 (nothing to do).
 * - At least one interesting candidate → exit 0 with a short summary as stdout.
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-consolidation-patrol.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LedgerCandidate {
  description: string;
  files: string[];
  occurrence_count: number;
  consecutive_stable_runs: number;
  status: "tracking" | "ready_to_propose";
  firstSeen: string;
  lastSeen: string;
}

interface Ledger {
  lastRun: string | null;
  candidates: Record<string, LedgerCandidate>;
}

interface Deps {
  readLedger: () => Ledger | null;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * True if a candidate is worth waking a full Claude session for: already
 * promoted, or a tracking candidate one occurrence away from the count
 * threshold. Mirrors the "close to the stabilization threshold" bar from
 * the ledger schema's promotion rule.
 */
function isInteresting(candidate: LedgerCandidate): boolean {
  if (candidate.status === "ready_to_propose") return true;
  return candidate.status === "tracking" && candidate.occurrence_count >= 2;
}

export async function run(deps: Deps): Promise<RunResult> {
  let ledger: Ledger | null;
  try {
    ledger = deps.readLedger();
  } catch {
    // Read/parse failure — unknown state, exit permissively per the
    // precheck contract's "err permissive" rule.
    return {
      exit: 0,
      output: "Consolidation ledger unreadable — running permissively.",
    };
  }

  // Missing ledger — normal first run, no candidates could possibly exist yet.
  if (ledger === null) {
    return { exit: 1, output: "" };
  }

  const interestingCount = Object.values(ledger.candidates).filter(
    isInteresting,
  ).length;

  if (interestingCount === 0) {
    return { exit: 1, output: "" };
  }

  return {
    exit: 0,
    output: `${interestingCount} consolidation candidate(s) near the stabilization threshold — running consolidation-patrol check.`,
  };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  const cwd = process.cwd();

  return {
    readLedger: (): Ledger | null => {
      const ledgerPath = join(cwd, "state", "consolidation-ledger.json");
      if (!existsSync(ledgerPath)) return null;
      // A missing file is the normal "no candidates yet" case (handled
      // above), but a present-and-unparsable file is genuinely unknown
      // state — let JSON.parse throw so run() can tell the two apart and
      // exit permissively (0) rather than treating corruption as "nothing
      // to do" (1).
      return JSON.parse(readFileSync(ledgerPath, "utf-8")) as Ledger;
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const deps = buildProductionDeps();
  const result = await run(deps);
  if (result.exit === 0) {
    process.stdout.write(`${result.output}\n`);
  }
  process.exit(result.exit);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`error: ${String(e)}\n`);
    process.exit(2);
  });
}
