/**
 * plugins/shipwright/scripts/prompt-audit/report.unit.test.ts
 */

import { describe, expect, test } from "bun:test";
import { emptyLedger, mergeScan, type ScanFinding } from "./ledger.ts";
import { projectedSaving, renderReport } from "./report.ts";

const NOW = new Date("2026-10-08T00:00:00Z");

function f(fp: string, over: Partial<ScanFinding> = {}): ScanFinding {
  return {
    fingerprint: fp,
    class: "a",
    rule: "always-set-tokens",
    file: `docs/${fp}.md`,
    line: 3,
    loadClass: "always",
    contexts: ["local-dev"],
    evidence: `e-${fp}`,
    metrics: {
      before: 1000,
      projectedAfter: 400,
      units: "tokens",
      estimated: true,
    },
    measurement: { tier: "static", acceptance: "delta < 0" },
    claim: "cost-only",
    confidence: "high",
    action: "trim",
    severity: "medium",
    blastRadius: {
      file: `docs/${fp}.md`,
      lowerBound: true,
      note: "lower bound",
      referrers: [
        { path: "CLAUDE.md", kind: "claude-md", via: "path", line: 1 },
      ],
      crons: [{ name: "c", loopPhase: null }],
      pinningTests: [],
      sourceMapPages: [],
      loadClass: null,
    },
    scannedAt: "abc1234",
    ...over,
  };
}

function build(findings: ScanFinding[]) {
  return mergeScan(
    emptyLedger(),
    {
      findings,
      models: ["claude-sonnet-5-5", "claude-sonnet-4-6"],
      baselines: {
        "local-dev": {
          "claude-sonnet-5-5": {
            alwaysTokens: 12345,
            listingChars: 4000,
            estimated: true,
          },
          "claude-sonnet-4-6": {
            alwaysTokens: 11000,
            listingChars: 4000,
            estimated: false,
            measuredContextTokens: 15000,
          },
        },
        "agent-runtime": {
          "claude-sonnet-5-5": {
            alwaysTokens: 900,
            listingChars: 100,
            estimated: true,
          },
        },
      },
      claudeCodeVersion: "2.5.0",
    },
    NOW,
  );
}

describe("projectedSaving", () => {
  test("multiplies token deltas by weekly runs and ignores non-token units", () => {
    expect(projectedSaving(f("a"), 10)).toBe(6000);
    expect(
      projectedSaving(
        f("a", {
          metrics: {
            before: 300,
            projectedAfter: 200,
            units: "lines",
            estimated: false,
          },
        }),
        10,
      ),
    ).toBe(0);
  });
});

describe("renderReport", () => {
  const ledger = build([
    f("small", {
      metrics: {
        before: 500,
        projectedAfter: 400,
        units: "tokens",
        estimated: true,
      },
    }),
    f("big"),
    f("stale", {
      class: "c",
      rule: "unresolvable-path",
      metrics: { before: 1, units: "refs", estimated: false },
      claim: "quality-claimed",
      measurement: {
        tier: "eval",
        evals: [{ kind: "with-without", estCostUsd: 4.8 }],
        acceptance: "x",
      },
    }),
  ]);
  const out = renderReport({ ledger, generatedAt: NOW, weeklyRuns: 1 });

  test("header lists models, contexts, Claude Code version and estimate state", () => {
    expect(out).toMatch(/^# Prompt Audit Report/);
    expect(out).toContain("claude-sonnet-5-5");
    expect(out).toContain("claude-sonnet-4-6");
    expect(out).toContain("local-dev");
    expect(out).toContain("agent-runtime");
    expect(out).toContain("2.5.0");
    expect(out).toMatch(/estimated/i);
  });

  test("has the always-loaded baseline table with static and measured figures", () => {
    expect(out).toContain("## Always-loaded baseline");
    expect(out).toContain("12,345");
    expect(out).toContain("15,000");
    expect(out).toContain("estimate");
  });

  test("has the listing-budget table", () => {
    expect(out).toContain("## Skill listing budget");
    expect(out).toContain("4,000");
    expect(out).toContain("10,000");
  });

  test("one section per class, rows sorted by projected saving", () => {
    expect(out).toContain("### Class a");
    expect(out).toContain("### Class c");
    expect(out).not.toContain("### Class b");
    expect(out.indexOf("`docs/big.md")).toBeLessThan(
      out.indexOf("`docs/small.md"),
    );
  });

  test("rows carry before -> after, tier, eval cost, label, blast radius and scannedAt", () => {
    expect(out).toContain("1,000 -> 400 tokens");
    expect(out).toContain("cost-only");
    expect(out).toContain("quality-claimed");
    expect(out).toContain("$4.80");
    expect(out).toContain("abc1234");
    expect(out).toMatch(/1 referrer/);
    expect(out).toMatch(/1 cron/);
    expect(out).toMatch(/lower bound/i);
  });

  test("states the evidence caveat without claiming no effect", () => {
    expect(out).toContain("no effect detected in these settings");
  });

  test("omits resolved and suppressed findings and findings not seen this run", () => {
    const l = build([f("a"), f("b")]);
    l.findings.a.status = "suppressed";
    l.findings.b.lastSeen = "2020-01-01T00:00:00.000Z";
    expect(renderReport({ ledger: l, generatedAt: NOW })).not.toContain(
      "docs/a.md",
    );
    expect(renderReport({ ledger: l, generatedAt: NOW })).not.toContain(
      "docs/b.md",
    );
  });
});

describe("renderReport adherence", () => {
  const ledger = build([
    f("patch", { file: "plugins/shipwright/commands/patch.md" }),
    f("devtask", {
      file: "plugins/shipwright/commands/dev-task.md",
      metrics: {
        before: 500,
        projectedAfter: 400,
        units: "tokens",
        estimated: true,
      },
    }),
    f("other", { file: "docs/other.md" }),
  ]);
  const adherence = [
    { command: "dev-task", runs: 10, adherentRuns: 4, rate: 0.4 },
  ];

  test("shows per-command adherence and ranks lowest-rate command findings first", () => {
    const out = renderReport({ ledger, generatedAt: NOW, adherence });
    expect(out).toContain("## Step adherence");
    expect(out).toContain("| dev-task | 40.0% | 4 | 10 |");
    const at = (s: string) => out.indexOf(s);
    // dev-task has a lower rate and a smaller saving, but ranks above the rest.
    expect(at("commands/dev-task.md")).toBeGreaterThan(-1);
    expect(at("commands/dev-task.md")).toBeLessThan(at("commands/patch.md"));
    expect(at("commands/dev-task.md")).toBeLessThan(at("docs/other.md"));
  });

  test("without adherence data the scan renders, says so, and ranks by saving", () => {
    for (const adherenceInput of [null, undefined]) {
      const out = renderReport({
        ledger,
        generatedAt: NOW,
        adherence: adherenceInput,
      });
      expect(out).toContain("Adherence data unavailable");
      expect(out.indexOf("commands/patch.md")).toBeLessThan(
        out.indexOf("commands/dev-task.md"),
      );
    }
  });

  test("empty adherence says there is no data in the window", () => {
    const out = renderReport({ ledger, generatedAt: NOW, adherence: [] });
    expect(out).toContain("No adherence data in the window");
  });
});
