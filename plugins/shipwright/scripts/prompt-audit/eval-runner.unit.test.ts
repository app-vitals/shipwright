import { describe, expect, test } from "bun:test";
import {
  abOnTwoCheckouts,
  parsePluginEvalJson,
  productionSeries,
  type RunnerDeps,
  runPluginEval,
  type SeriesFetch,
} from "./eval-runner.ts";
import { emptyLedger, type Ledger, recordMeasurement } from "./ledger.ts";

const evalJson = (passes: boolean[][], costUsd: number) =>
  JSON.stringify({
    costUsd,
    cases: passes.map((seeds, i) => ({ id: `c${i}`, seeds })),
  });

const NOW = new Date("2026-10-08T00:00:00Z");

function deps(outputs: Record<string, string>, calls: string[][] = []) {
  const d: RunnerDeps = {
    exec: (cwd, cmd) => {
      calls.push([cwd, ...cmd]);
      if (cmd[0] === "claude") {
        const key = cwd.includes("/base/") ? "base" : "head";
        return outputs[key];
      }
      return "";
    },
    mkTmp: () => "/tmp/ab",
    now: () => NOW,
  };
  return d;
}

describe("runPluginEval", () => {
  test("passes required flags and parses score and cost", () => {
    const calls: string[][] = [];
    const run = runPluginEval(
      "a",
      "/p",
      "/p/cases.json",
      { maxCostUsd: 5 },
      {
        exec: (cwd, cmd) => {
          calls.push([cwd, ...cmd]);
          return evalJson([[true, true, false]], 1.5);
        },
      },
    );
    expect(run.score).toBeCloseTo(2 / 3);
    expect(run.costUsd).toBe(1.5);
    const cmd = calls[0];
    for (const f of ["--json", "--trust-plugin", "--no-publish"]) {
      expect(cmd).toContain(f);
    }
    expect(cmd[cmd.indexOf("--max-cost-usd") + 1]).toBe("5");
  });

  test("passes append-system-prompt for with/without runs", () => {
    const calls: string[][] = [];
    runPluginEval(
      "a",
      "/p",
      "/c",
      { maxCostUsd: 1, appendSystemPrompt: "RULE" },
      {
        exec: (_cwd, cmd) => {
          calls.push(cmd);
          return evalJson([[true]], 0);
        },
      },
    );
    expect(calls[0]).toContain("RULE");
  });

  test("requires a positive cost cap", () => {
    expect(() =>
      runPluginEval("a", "/p", "/c", { maxCostUsd: 0 }, { exec: () => "" }),
    ).toThrow(/maxCostUsd/);
  });

  test("rejects malformed output", () => {
    expect(() => parsePluginEvalJson("a", "{}")).toThrow(/no cases/);
  });
});

describe("abOnTwoCheckouts", () => {
  const opts = {
    repoDir: "/repo",
    baseRef: "main",
    headRef: "feat",
    pluginRel: "plugins/x",
    casesRel: "cases.json",
    maxCostUsd: 10,
  };

  test("runs identical cases on both checkouts and records measured", () => {
    const calls: string[][] = [];
    const seeds = (n: number) =>
      Array.from({ length: 5 }, () => [true, true, true]).map((s, i) =>
        i < n ? [true, true, false] : s,
      );
    const out = abOnTwoCheckouts(
      opts,
      deps({ base: evalJson(seeds(0), 2), head: evalJson(seeds(5), 3) }, calls),
    );
    expect(out.measured.kind).toBe("ab-eval");
    expect(out.measured.before).toBe(1);
    expect(out.measured.after).toBeCloseTo(10 / 15);
    expect(out.measured.delta).toBeCloseTo(10 / 15 - 1, 5);
    expect(out.measured.costUsd).toBe(5);
    expect(out.measured.runAt).toBe(NOW.toISOString());
    const evals = calls.filter((c) => c[1] === "claude");
    expect(evals).toHaveLength(2);
    expect(evals[0]).toContain("/tmp/ab/base/cases.json");
    expect(evals[1]).toContain("/tmp/ab/head/cases.json");
    // cap is split per arm
    expect(evals[0][evals[0].indexOf("--max-cost-usd") + 1]).toBe("5");
  });

  test("removes worktrees even when an eval throws", () => {
    const calls: string[][] = [];
    const d = deps({}, calls);
    const bad: RunnerDeps = {
      ...d,
      exec: (cwd, cmd) => {
        calls.push([cwd, ...cmd]);
        if (cmd[0] === "claude") throw new Error("boom");
        return "";
      },
    };
    expect(() => abOnTwoCheckouts(opts, bad)).toThrow("boom");
    expect(calls.filter((c) => c.includes("remove"))).toHaveLength(2);
  });
});

describe("productionSeries", () => {
  const row = (
    fp: string,
    runs: number,
    completed: number,
    skipped = 0,
  ) => ({
    phase: "dev-task",
    contextFingerprint: fp,
    runs,
    completed,
    failed: runs - completed - skipped,
  });
  const mkFetch =
    (series: unknown[], urls: string[] = []): SeriesFetch =>
    async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.includes("/outcomes")
            ? { series }
            : { totals: { costUsd: 12.5 } },
      };
    };
  const opts = {
    baseUrl: "https://admin.test/",
    token: "t",
    phase: "dev-task",
    beforeFingerprint: "aaa",
    afterFingerprint: "bbb",
  };

  test("computes rates and records both run counts", async () => {
    const urls: string[] = [];
    const m = await productionSeries(
      opts,
      mkFetch([row("aaa", 20, 10), row("bbb", 40, 30)], urls),
      () => NOW,
    );
    expect(m.kind).toBe("production-series");
    expect(m.before).toBe(0.5);
    expect(m.after).toBe(0.75);
    expect(m.delta).toBe(0.25);
    expect(m.costUsd).toBe(0);
    expect(m.series).toMatchObject({ beforeRuns: 20, afterRuns: 40 });
    expect(urls[0]).toBe("https://admin.test/agents/all/cron-runs/outcomes");
  });

  test("excludes skipped runs from the rate and the 20-run floor", async () => {
    const m = await productionSeries(
      opts,
      mkFetch([row("aaa", 40, 10, 20), row("bbb", 40, 15, 20)]),
      () => NOW,
    );
    expect(m.before).toBe(0.5);
    expect(m.after).toBe(0.75);
    expect(m.series).toMatchObject({ beforeRuns: 20, afterRuns: 20 });
    await expect(
      productionSeries(
        opts,
        mkFetch([row("aaa", 20, 2, 18), row("bbb", 40, 30)]),
        () => NOW,
      ),
    ).rejects.toThrow(/before 2, after 40/);
  });

  test("refuses fewer than 20 runs in either arm", async () => {
    await expect(
      productionSeries(
        opts,
        mkFetch([row("aaa", 19, 10), row("bbb", 40, 30)]),
        () => NOW,
      ),
    ).rejects.toThrow(/before 19, after 40/);
    await expect(
      productionSeries(
        opts,
        mkFetch([row("aaa", 40, 10), row("bbb", 5, 3)]),
        () => NOW,
      ),
    ).rejects.toThrow(/after 5/);
  });

  test("refuses when an arm is missing and ignores minRuns below 20", async () => {
    await expect(
      productionSeries(
        { ...opts, minRuns: 1 },
        mkFetch([row("aaa", 25, 10)]),
        () => NOW,
      ),
    ).rejects.toThrow(/after 0/);
  });

  test("surfaces HTTP failures", async () => {
    const f: SeriesFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    });
    await expect(productionSeries(opts, f, () => NOW)).rejects.toThrow(/403/);
  });
});

describe("ledger integration", () => {
  test("measured result is recordable on a finding", () => {
    const ledger = {
      ...emptyLedger(),
      findings: { fp1: { status: "queued", history: [] } },
    } as unknown as Ledger;
    const next = recordMeasurement(
      ledger,
      "fp1",
      {
        kind: "ab-eval",
        before: 1,
        after: 0.9,
        delta: -0.1,
        costUsd: 1,
        runAt: NOW.toISOString(),
      },
      NOW,
    );
    expect(next.findings.fp1.measured?.delta).toBe(-0.1);
    expect(next.findings.fp1.status).toBe("measured");
  });
});
