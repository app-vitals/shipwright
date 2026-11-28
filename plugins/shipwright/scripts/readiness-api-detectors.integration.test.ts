/**
 * Integration tests for readiness-api-detectors.ts — recorded GitHub and
 * task-store response fixtures served through injected client doubles, with an
 * injected Clock for the 30-day boundaries.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.ts";
import {
  type BranchProtection,
  type BranchRule,
  type CronRun,
  type DetectorDeps,
  detectDefaultBranchProtected,
  detectDocsFresh,
  detectNoCriticalSecurityFindings,
  detectNoHighEntropyFindings,
  detectNoStaleConsolidationPattern,
  detectOwnerCronsRunning,
  detectTestSuiteSpeedBudget,
  type PatrolFinding,
  runApiDetectors,
  type SystemCron,
} from "./readiness-api-detectors.ts";

const REPO = "acme/widgets";
const dir = join(import.meta.dir, "test-helpers/fixtures/readiness");
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(join(dir, name), "utf8")) as T;

const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const NOW = "2026-11-28T00:00:00.000Z";

interface Data {
  protection: BranchProtection | null;
  rules: BranchRule[];
  runs: CronRun[];
  findings: PatrolFinding[];
  crons: SystemCron[];
}

function baseData(): Data {
  return {
    protection: load("github-protection-required-ci.json"),
    rules: [],
    runs: load("cron-runs.json"),
    findings: load("patrol-findings.json"),
    crons: load("system-crons.json"),
  };
}

function depsFor(d: Data, clock: Clock = at(NOW), broken = false): DetectorDeps {
  const boom = async (): Promise<never> => {
    throw new Error("ECONNREFUSED");
  };
  const runsFor = (cronId: string, repo: string) =>
    d.runs.filter((r) => r.cronId === cronId && r.repo === repo);
  return {
    clock,
    github: {
      getDefaultBranch: broken ? boom : async () => "main",
      getBranchProtection: async () => d.protection,
      getBranchRules: async () => d.rules,
    },
    taskStore: {
      latestRun: broken
        ? boom
        : async (c, r) =>
            runsFor(c, r).filter((x) => x.outcome !== "failed").at(-1) ?? null,
      newestRun: async (c, r) => runsFor(c, r).at(-1) ?? null,
      listFindings: async (q) =>
        d.findings.filter(
          (f) =>
            f.cronId === q.cronId &&
            f.repo === q.repo &&
            (q.status === undefined || f.status === q.status),
        ),
    },
    systemCrons: { list: async () => d.crons },
  };
}

describe("default-branch-protected", () => {
  test("passes with classic protection requiring CI", async () => {
    const r = await detectDefaultBranchProtected(REPO, depsFor(baseData()));
    expect(r.result).toBe("pass");
  });
  test("passes with a ruleset requiring CI", async () => {
    const d = baseData();
    d.protection = null;
    d.rules = load("github-rules-required-ci.json");
    expect((await detectDefaultBranchProtected(REPO, depsFor(d))).result).toBe(
      "pass",
    );
  });
  test("fails when protected without status checks", async () => {
    const d = baseData();
    d.protection = load("github-protection-no-ci.json");
    const r = await detectDefaultBranchProtected(REPO, depsFor(d));
    expect(r.result).toBe("fail");
    expect(r.reason).toContain("no CI");
  });
  test("fails with no protection at all", async () => {
    const d = baseData();
    d.protection = null;
    expect((await detectDefaultBranchProtected(REPO, depsFor(d))).result).toBe(
      "fail",
    );
  });
});

describe("docs-fresh 30-day boundary", () => {
  // fixture run finished 2026-10-29T00:04:00Z
  test("passes at exactly 30 days", async () => {
    const r = await detectDocsFresh(
      REPO,
      depsFor(baseData(), at("2026-11-28T00:04:00.000Z")),
    );
    expect(r.result).toBe("pass");
  });
  test("fails one ms past 30 days", async () => {
    const r = await detectDocsFresh(
      REPO,
      depsFor(baseData(), at("2026-11-28T00:04:00.001Z")),
    );
    expect(r.result).toBe("fail");
  });
  test("fails (does not throw) when no docs-freshness run exists", async () => {
    const d = baseData();
    d.runs = d.runs.filter((x) => x.cronId !== "docs-freshness");
    const r = await detectDocsFresh(REPO, depsFor(d));
    expect(r.result).toBe("fail");
    expect(r.reason).toContain("no docs-freshness run");
  });
  for (const finishedAt of ["", "not-a-date"]) {
    test(`fails on an unparseable finishedAt (${JSON.stringify(finishedAt)})`, async () => {
      const d = baseData();
      for (const run of d.runs) {
        if (run.cronId === "docs-freshness") run.finishedAt = finishedAt;
      }
      const r = await detectDocsFresh(REPO, depsFor(d));
      expect(r.result).toBe("fail");
      expect(r.reason).toContain("unparseable finishedAt");
    });
  }
});

describe("no-critical-security-findings", () => {
  test("fails with an open critical finding", async () => {
    const r = await detectNoCriticalSecurityFindings(REPO, depsFor(baseData()));
    expect(r.result).toBe("fail");
  });
  test("passes when only non-critical findings are open", async () => {
    const d = baseData();
    d.findings = d.findings.filter((f) => f.detail?.severity !== "critical");
    expect(
      (await detectNoCriticalSecurityFindings(REPO, depsFor(d))).result,
    ).toBe("pass");
  });
  test("fails when the security patrol never ran", async () => {
    const d = baseData();
    d.runs = d.runs.filter((x) => x.cronId !== "security-patrol");
    expect(
      (await detectNoCriticalSecurityFindings(REPO, depsFor(d))).result,
    ).toBe("fail");
  });
});

describe("test-suite-speed-budget", () => {
  test("passes within budget, fails over it", async () => {
    const d = baseData();
    expect((await detectTestSuiteSpeedBudget(REPO, depsFor(d))).result).toBe(
      "pass",
    );
    const run = d.runs.find((r) => r.cronId === "test-readiness") as CronRun;
    run.metrics.suiteWallSeconds = 901;
    expect((await detectTestSuiteSpeedBudget(REPO, depsFor(d))).result).toBe(
      "fail",
    );
    run.metrics.suiteWallSeconds = 900;
    expect((await detectTestSuiteSpeedBudget(REPO, depsFor(d))).result).toBe(
      "pass",
    );
  });
  test("fails when the run recorded no duration", async () => {
    const d = baseData();
    const run = d.runs.find((r) => r.cronId === "test-readiness") as CronRun;
    run.metrics = {};
    expect((await detectTestSuiteSpeedBudget(REPO, depsFor(d))).result).toBe(
      "fail",
    );
  });
});

describe("no-high-entropy-findings", () => {
  test("passes at zero, fails above, fails without a run", async () => {
    const d = baseData();
    expect((await detectNoHighEntropyFindings(REPO, depsFor(d))).result).toBe(
      "pass",
    );
    const run = d.runs.find((r) => r.cronId === "entropy-patrol") as CronRun;
    run.metrics.high = 2;
    expect((await detectNoHighEntropyFindings(REPO, depsFor(d))).result).toBe(
      "fail",
    );
    d.runs = d.runs.filter((r) => r.cronId !== "entropy-patrol");
    expect((await detectNoHighEntropyFindings(REPO, depsFor(d))).result).toBe(
      "fail",
    );
  });
});

describe("no-stale-consolidation-pattern 30-day boundary", () => {
  // fixture pattern ready since 2026-10-29T05:00:00Z
  test("passes at exactly 30 days", async () => {
    const r = await detectNoStaleConsolidationPattern(
      REPO,
      depsFor(baseData(), at("2026-11-28T05:00:00.000Z")),
    );
    expect(r.result).toBe("pass");
  });
  test("fails one ms past 30 days", async () => {
    const r = await detectNoStaleConsolidationPattern(
      REPO,
      depsFor(baseData(), at("2026-11-28T05:00:00.001Z")),
    );
    expect(r.result).toBe("fail");
  });
  for (const bad of ["", "not-a-date"]) {
    test(`counts an unparseable readySince (${JSON.stringify(bad)}) as stale`, async () => {
      const d = baseData();
      for (const f of d.findings) {
        if (f.cronId !== "consolidation-patrol") continue;
        f.firstSeen = bad;
        f.history = f.history.map((h) => ({ ...h, at: bad }));
      }
      // At exactly 30 days the well-formed fixture passes; only the bad date fails it.
      const r = await detectNoStaleConsolidationPattern(
        REPO,
        depsFor(d, at("2026-11-28T05:00:00.000Z")),
      );
      expect(r.result).toBe("fail");
    });
  }
});

describe("owner-crons-running", () => {
  test("passes when every owner cron is enabled for the repo with an ok run", async () => {
    const r = await detectOwnerCronsRunning(REPO, depsFor(baseData()));
    expect(r.result).toBe("pass");
  });
  test("fails for a disabled cron, an out-of-scope repo, and a failed run", async () => {
    const d = baseData();
    (d.crons.find((c) => c.id === "docs-freshness") as SystemCron).enabled =
      false;
    (d.crons.find((c) => c.id === "test-readiness") as SystemCron).repos = [
      "acme/other",
    ];
    d.runs.push({
      ...(d.runs.find((r) => r.cronId === "entropy-patrol") as CronRun),
      startedAt: "2026-11-27T04:00:00.000Z",
      finishedAt: "2026-11-27T04:01:00.000Z",
      outcome: "failed",
    });
    const r = await detectOwnerCronsRunning(REPO, depsFor(d));
    expect(r.result).toBe("fail");
    expect(r.reason).toContain("docs-freshness: not enabled");
    expect(r.reason).toContain("test-readiness: not enabled");
    expect(r.reason).toContain("entropy-patrol: latest run failed");
  });
});

describe("unreachable sources", () => {
  test("every detector fails with a reason instead of throwing", async () => {
    const results = await runApiDetectors(
      REPO,
      depsFor(baseData(), at(NOW), true),
    );
    expect(results.length).toBe(7);
    for (const r of results.filter((x) => x.id !== "owner-crons-running")) {
      expect(r.result).toBe("fail");
      expect(r.reason).toContain("unreachable");
    }
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId["docs-fresh"]?.result).toBe("fail");
  });
});
