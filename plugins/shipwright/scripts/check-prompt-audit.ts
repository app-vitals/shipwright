#!/usr/bin/env bun
/**
 * plugins/shipwright/scripts/check-prompt-audit.ts
 *
 * Pre-check for the prompt-audit-maintenance cron.
 *
 * Reads state/prompt-audit-ledger.json (see
 * skills/prompt-scan/references/ledger-schema.md for the schema) and decides
 * whether a weekly scan is due or there is proposed work to act on:
 *
 * - A missing ledger → exit 0 (permissive; one-time bootstrap unlock). The
 *   ledger is only ever written by prompt-scan, which this precheck gates —
 *   exiting 1 here would deadlock, since the scan that creates it never runs.
 * - A ledger that fails to read/parse → exit 0 (permissive; can't rule out
 *   work exists).
 * - `lastRun` null/unparseable, or 7+ days old → exit 0 (scan is due).
 * - `lastRun` < 7 days old with at least one `proposed` finding → exit 0
 *   (prompt-fix has work to queue).
 * - `lastRun` < 7 days old with no `proposed` findings → exit 1.
 *
 * Usage:
 *   bun plugins/shipwright/scripts/check-prompt-audit.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Clock, SystemClock } from "./clock.ts";
import type { Ledger } from "./prompt-audit/ledger.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Only the ledger fields the precheck reads. */
type PrecheckLedger = Pick<Ledger, "lastRun"> & {
  findings: Record<string, { status: string }>;
};

interface Deps {
  readLedger: () => PrecheckLedger | null;
  clock: Clock;
}

interface RunResult {
  exit: 0 | 1;
  output: string;
}

const SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function run(deps: Deps): Promise<RunResult> {
  let ledger: PrecheckLedger | null;
  try {
    ledger = deps.readLedger();
  } catch {
    // Read/parse failure — unknown state, exit permissively per the
    // precheck contract's "err permissive" rule.
    return {
      exit: 0,
      output: "Prompt-audit ledger unreadable — running permissively.",
    };
  }

  if (ledger === null) {
    return {
      exit: 0,
      output: "No prompt-audit ledger yet -- running to bootstrap tracking.",
    };
  }

  const lastRunMs = ledger.lastRun ? Date.parse(ledger.lastRun) : Number.NaN;
  const ageMs = deps.clock.now().getTime() - lastRunMs;
  if (Number.isNaN(ageMs) || ageMs >= SCAN_INTERVAL_MS) {
    return {
      exit: 0,
      output: "Prompt-audit scan is due (last run 7+ days ago or never).",
    };
  }

  const proposed = Object.values(ledger.findings ?? {}).filter(
    (f) => f.status === "proposed",
  ).length;
  if (proposed === 0) {
    return { exit: 1, output: "" };
  }

  return {
    exit: 0,
    output: `${proposed} proposed prompt-audit finding(s) awaiting prompt-fix.`,
  };
}

// ─── Production deps ──────────────────────────────────────────────────────────

function buildProductionDeps(): Deps {
  const cwd = process.cwd();

  return {
    clock: SystemClock(),
    readLedger: (): PrecheckLedger | null => {
      const ledgerPath = join(cwd, "state", "prompt-audit-ledger.json");
      if (!existsSync(ledgerPath)) return null;
      // Present-but-unparsable is unknown state — let JSON.parse throw so
      // run() exits permissively (0) rather than treating corruption as
      // "nothing to do" (1).
      return JSON.parse(readFileSync(ledgerPath, "utf-8")) as PrecheckLedger;
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const result = await run(buildProductionDeps());
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
