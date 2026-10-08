/**
 * plugins/shipwright/scripts/prompt-audit/ledger.ts
 *
 * Prompt-audit ledger: a snapshot of every finding the patrol has seen, with
 * an append-only per-finding history. Pure merge logic; file access goes
 * through an injected `LedgerFs` and time through an injected `Date`.
 * Schema: skills/prompt-scan/references/ledger-schema.md.
 */

import type { BlastReport } from "./blast.ts";
import type { Finding } from "./finding.ts";

export type FindingStatus =
  | "tracking"
  | "proposed"
  | "queued"
  | "measured"
  | "resolved"
  | "suppressed";

/** A finding as recorded: the rule output plus its blast radius at scan time. */
export type ScanFinding = Finding & {
  blastRadius: BlastReport;
  /** Commit sha the scan ran against. */
  scannedAt: string;
};

export interface Baseline {
  alwaysTokens: number;
  listingChars: number;
  estimated: boolean;
  /** Measured first-turn context tokens, when reachable. */
  measuredContextTokens?: number;
}

export interface Measured {
  kind: string;
  before: number;
  after: number;
  delta: number;
  costUsd: number;
  series?: unknown;
  artifacts?: string[];
  runAt: string;
}

export interface HistoryEvent {
  at: string;
  event: string;
  status: FindingStatus;
}

export type LedgerEntry = ScanFinding & {
  status: FindingStatus;
  firstSeen: string;
  lastSeen: string;
  runsSeen: number;
  taskId?: string;
  measured?: Measured;
  history: HistoryEvent[];
};

export interface Ledger {
  lastRun: string | null;
  models: string[];
  claudeCodeVersion?: string;
  /** context -> model -> baseline */
  baselines: Record<string, Record<string, Baseline>>;
  findings: Record<string, LedgerEntry>;
}

export interface LedgerFs {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, content: string): void;
}

export interface ScanResult {
  findings: ScanFinding[];
  models: string[];
  baselines: Ledger["baselines"];
  claudeCodeVersion?: string;
}

export interface MergeOptions {
  /**
   * Registry check. When given, matching findings become `suppressed` and
   * previously suppressed findings that no longer match return to tracking.
   */
  suppress?: (finding: ScanFinding) => boolean;
}

export const LEDGER_PATH = "state/prompt-audit-ledger.json";

export function emptyLedger(): Ledger {
  return { lastRun: null, models: [], baselines: {}, findings: {} };
}

/** Missing file reads as an empty ledger; unparseable content throws. */
export function readLedger(fs: LedgerFs, path: string): Ledger {
  if (!fs.exists(path)) return emptyLedger();
  const parsed = JSON.parse(fs.read(path)) as Partial<Ledger> | null;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.findings !== "object"
  ) {
    throw new Error(`prompt-audit ledger at ${path} is malformed`);
  }
  return { ...emptyLedger(), ...parsed } as Ledger;
}

export function writeLedger(fs: LedgerFs, path: string, ledger: Ledger): void {
  fs.write(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

function withStatus(
  entry: LedgerEntry,
  status: FindingStatus,
  event: string,
  at: string,
): LedgerEntry {
  return {
    ...entry,
    status,
    history: [...entry.history, { at, event, status }],
  };
}

/**
 * Merge a scan into the ledger. `resolved` is reserved for `queued`/`measured`
 * entries that stop reproducing; a vanished `tracking`/`proposed`/`suppressed`
 * entry is left alone.
 */
export function mergeScan(
  ledger: Ledger,
  scan: ScanResult,
  now: Date,
  opts: MergeOptions = {},
): Ledger {
  const at = now.toISOString();
  const findings: Record<string, LedgerEntry> = structuredClone(
    ledger.findings,
  );
  const seen = new Set<string>();

  for (const f of scan.findings) {
    seen.add(f.fingerprint);
    const prior = findings[f.fingerprint];
    const suppressed = opts.suppress?.(f) ?? false;
    if (!prior) {
      const status: FindingStatus = suppressed ? "suppressed" : "tracking";
      findings[f.fingerprint] = {
        ...f,
        status,
        firstSeen: at,
        lastSeen: at,
        runsSeen: 1,
        history: [{ at, event: "first-seen", status }],
      };
      continue;
    }
    let entry: LedgerEntry = {
      ...prior,
      ...f,
      status: prior.status,
      firstSeen: prior.firstSeen,
      lastSeen: at,
      runsSeen: prior.runsSeen + 1,
      history: prior.history,
    };
    if (suppressed && entry.status !== "suppressed") {
      entry = withStatus(entry, "suppressed", "suppressed", at);
    } else if (
      !suppressed &&
      (entry.status === "resolved" ||
        (opts.suppress !== undefined && entry.status === "suppressed"))
    ) {
      entry = withStatus(entry, "tracking", "reappeared", at);
    }
    findings[f.fingerprint] = entry;
  }

  for (const [fp, entry] of Object.entries(findings)) {
    if (seen.has(fp)) continue;
    if (entry.status === "queued" || entry.status === "measured") {
      findings[fp] = withStatus(entry, "resolved", "stopped-reproducing", at);
    }
  }

  return {
    lastRun: at,
    models: scan.models,
    claudeCodeVersion: scan.claudeCodeVersion ?? ledger.claudeCodeVersion,
    baselines: scan.baselines,
    findings,
  };
}

export function recordMeasurement(
  ledger: Ledger,
  fp: string,
  measured: Measured,
  now: Date,
): Ledger {
  const entry = ledger.findings[fp];
  if (!entry) throw new Error(`no ledger entry for finding ${fp}`);
  const next = withStatus(
    { ...entry, measured },
    "measured",
    "measured",
    now.toISOString(),
  );
  return { ...ledger, findings: { ...ledger.findings, [fp]: next } };
}
