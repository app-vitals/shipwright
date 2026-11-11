/**
 * plugins/shipwright/scripts/prompt-audit/ledger.unit.test.ts
 *
 * Ledger read/merge/write with an injected fs and clock.
 */

import { describe, expect, test } from "bun:test";
import {
  emptyLedger,
  type Ledger,
  type LedgerFs,
  mergeScan,
  readLedger,
  recordMeasurement,
  type ScanFinding,
  writeLedger,
} from "./ledger.ts";

const T1 = new Date("2026-10-01T00:00:00Z");
const T2 = new Date("2026-10-08T00:00:00Z");
const T3 = new Date("2026-10-15T00:00:00Z");

function finding(fp: string, over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    fingerprint: fp,
    class: "a",
    rule: "claude-md-over-200-lines",
    file: "CLAUDE.md",
    line: 1,
    loadClass: "always",
    contexts: ["local-dev"],
    evidence: "too long",
    metrics: {
      before: 300,
      projectedAfter: 200,
      units: "lines",
      estimated: false,
    },
    measurement: { tier: "static", acceptance: "delta < 0" },
    claim: "cost-only",
    confidence: "high",
    action: "trim",
    severity: "medium",
    blastRadius: {
      file: "CLAUDE.md",
      lowerBound: true,
      note: "lower bound",
      referrers: [],
      crons: [],
      pinningTests: [],
      sourceMapPages: [],
      loadClass: null,
    },
    scannedAt: "abc123",
    ...over,
  };
}

const scan = (findings: ScanFinding[]) => ({
  findings,
  models: ["claude-sonnet-5-5"],
  baselines: {},
});

function memFs(files: Record<string, string> = {}): LedgerFs & {
  files: Record<string, string>;
  writes: number;
} {
  const state = { files, writes: 0 };
  return {
    files,
    get writes() {
      return state.writes;
    },
    exists: (p) => p in files,
    read: (p) => files[p],
    write: (p, s) => {
      files[p] = s;
      state.writes++;
    },
  };
}

describe("ledger io", () => {
  test("missing ledger reads as empty", () => {
    expect(readLedger(memFs(), "l.json")).toEqual(emptyLedger());
  });

  test("corrupt ledger throws", () => {
    expect(() => readLedger(memFs({ "l.json": "{nope" }), "l.json")).toThrow();
  });

  test("round-trips through write/read", () => {
    const fs = memFs();
    const l = mergeScan(emptyLedger(), scan([finding("aaa")]), T1);
    writeLedger(fs, "l.json", l);
    expect(readLedger(fs, "l.json")).toEqual(l);
  });
});

describe("mergeScan", () => {
  test("new finding is tracking with firstSeen/lastSeen/runsSeen and history", () => {
    const l = mergeScan(emptyLedger(), scan([finding("aaa")]), T1);
    const e = l.findings.aaa;
    expect(l.lastRun).toBe(T1.toISOString());
    expect(e.status).toBe("tracking");
    expect(e.firstSeen).toBe(T1.toISOString());
    expect(e.lastSeen).toBe(T1.toISOString());
    expect(e.runsSeen).toBe(1);
    expect(e.history).toHaveLength(1);
    expect(e.blastRadius.lowerBound).toBe(true);
    expect(e.scannedAt).toBe("abc123");
  });

  test("a repeat sighting bumps runsSeen/lastSeen and keeps status and taskId", () => {
    let l = mergeScan(emptyLedger(), scan([finding("aaa")]), T1);
    l.findings.aaa.status = "queued";
    l.findings.aaa.taskId = "prompt-1";
    l = mergeScan(l, scan([finding("aaa", { scannedAt: "def456" })]), T2);
    const e = l.findings.aaa;
    expect(e.status).toBe("queued");
    expect(e.taskId).toBe("prompt-1");
    expect(e.runsSeen).toBe(2);
    expect(e.firstSeen).toBe(T1.toISOString());
    expect(e.lastSeen).toBe(T2.toISOString());
    expect(e.scannedAt).toBe("def456");
  });

  test("a queued or measured finding that stops reproducing becomes resolved", () => {
    let l = mergeScan(emptyLedger(), scan([finding("q"), finding("m")]), T1);
    l.findings.q.status = "queued";
    l.findings.m.status = "measured";
    l = mergeScan(l, scan([]), T2);
    expect(l.findings.q.status).toBe("resolved");
    expect(l.findings.m.status).toBe("resolved");
    expect(l.findings.q.history.at(-1)?.status).toBe("resolved");
    expect(l.findings.q.lastSeen).toBe(T1.toISOString());
  });

  test("a vanished tracking or proposed finding is left alone", () => {
    let l = mergeScan(emptyLedger(), scan([finding("t"), finding("p")]), T1);
    l.findings.p.status = "proposed";
    const before = structuredClone(l.findings);
    l = mergeScan(l, scan([]), T2);
    expect(l.findings).toEqual(before);
    expect(l.lastRun).toBe(T2.toISOString());
  });

  test("a resolved finding that reappears goes back to tracking", () => {
    let l = mergeScan(emptyLedger(), scan([finding("q")]), T1);
    l.findings.q.status = "queued";
    l = mergeScan(l, scan([]), T2);
    l = mergeScan(l, scan([finding("q")]), T3);
    expect(l.findings.q.status).toBe("tracking");
  });

  test("suppress predicate marks matching findings suppressed and releases others", () => {
    let l = mergeScan(emptyLedger(), scan([finding("s")]), T1, {
      suppress: (f) => f.fingerprint === "s",
    });
    expect(l.findings.s.status).toBe("suppressed");
    l = mergeScan(l, scan([finding("s")]), T2, { suppress: () => false });
    expect(l.findings.s.status).toBe("tracking");
  });

  test("does not mutate its input", () => {
    const base = emptyLedger();
    mergeScan(base, scan([finding("aaa")]), T1);
    expect(base).toEqual(emptyLedger());
  });

  test("records models, baselines and claudeCodeVersion", () => {
    const baselines = {
      "local-dev": {
        "claude-sonnet-5-5": {
          alwaysTokens: 10,
          listingChars: 5,
          estimated: true,
        },
      },
    };
    const l = mergeScan(
      emptyLedger(),
      {
        findings: [],
        models: ["claude-sonnet-5-5"],
        baselines,
        claudeCodeVersion: "2.5.0",
      },
      T1,
    );
    expect(l.models).toEqual(["claude-sonnet-5-5"]);
    expect(l.baselines).toEqual(baselines);
    expect(l.claudeCodeVersion).toBe("2.5.0");
  });
});

describe("recordMeasurement", () => {
  test("populates measured and moves the finding to measured", () => {
    let l: Ledger = mergeScan(emptyLedger(), scan([finding("aaa")]), T1);
    l = recordMeasurement(
      l,
      "aaa",
      {
        kind: "static",
        before: 100,
        after: 80,
        delta: -20,
        costUsd: 0,
        runAt: T2.toISOString(),
      },
      T2,
    );
    expect(l.findings.aaa.measured?.delta).toBe(-20);
    expect(l.findings.aaa.status).toBe("measured");
  });

  test("throws for an unknown fingerprint", () => {
    expect(() =>
      recordMeasurement(
        emptyLedger(),
        "zzz",
        {
          kind: "static",
          before: 1,
          after: 1,
          delta: 0,
          costUsd: 0,
          runAt: "",
        },
        T1,
      ),
    ).toThrow();
  });
});
