import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  abOnTwoCheckouts,
  parsePluginEvalJson,
  productionSeries,
  type RunnerDeps,
  runPluginEval,
  type SeriesFetch,
} from "./eval-runner.ts";
import { emptyLedger, type Ledger, recordMeasurement } from "./ledger.ts";

const FIXTURE = readFileSync(
  new URL("./fixtures/plugin-eval-result.v1.json", import.meta.url),
  "utf8",
);

/** A minimal v1 result document; each case is a list of per-run `passed`. */
const evalJson = (passes: boolean[][], costUsd: number, extra = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    costUsd,
    partial: false,
    cases: passes.map((runs, i) => ({
      name: `c${i}`,
      arms: { with: runs.map((passed) => ({ passed })) },
    })),
    aggregates: { casesTotal: passes.length },
    ...extra,
  });

const NOW = new Date("2026-10-08T00:00:00Z");

function deps(outputs: Record<string, string>, calls: string[][] = []) {
  const d: RunnerDeps = {
    exec: (cwd, cmd) => {
      calls.push([cwd, ...cmd]);
      if (cmd[0] === "claude") {
        // the result is written to --json <path>; remember which arm's it is
        const key = cwd.includes("/base/") ? "base" : "head";
        written[cmd[cmd.indexOf("--json") + 1]] = outputs[key];
      }
      return "";
    },
    mkTmp: (prefix) =>
      prefix.startsWith("prompt-eval-ab") ? "/tmp/ab" : `/tmp/${prefix}${n++}`,
    readFile: (p) => written[p],
    now: () => NOW,
  };
  return d;
}
const written: Record<string, string> = {};
let n = 0;

describe("runPluginEval", () => {
  const run = (
    opts: Parameters<typeof runPluginEval>[3],
    out = evalJson([[true]], 0),
  ) => {
    const calls: string[][] = [];
    const result = runPluginEval("a", "/p", "evals", opts, {
      exec: (cwd, cmd) => {
        calls.push([cwd, ...cmd]);
        written["/tmp/r/result.json"] = out;
        return "";
      },
      mkTmp: () => "/tmp/r",
      readFile: (p) => written[p],
    });
    return { calls, cmd: calls[0], result };
  };

  test("builds the real command line and parses score and cost", () => {
    const { cmd, result } = run(
      { maxCostUsd: 5, runs: 1 },
      evalJson([[true, true, false]], 1.5),
    );
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.costUsd).toBe(1.5);
    expect(cmd.slice(0, 5)).toEqual(["/p", "claude", "plugin", "eval", "/p"]);
    const arg = (f: string) => cmd[cmd.indexOf(f) + 1];
    expect(arg("--eval-dir")).toBe("evals");
    expect(arg("--ablation")).toBe("none");
    expect(arg("--runs")).toBe("1");
    expect(arg("--threshold")).toBe("0");
    expect(arg("--json")).toBe("/tmp/r/result.json");
    expect(arg("--max-cost-usd")).toBe("5");
    for (const f of ["--trust-plugin", "--no-publish"]) {
      expect(cmd).toContain(f);
    }
    expect(cmd).not.toContain("--cases");
  });

  test("with-without is opt-in and exposes meanDelta", () => {
    const { cmd, result } = run(
      { maxCostUsd: 1, ablation: "with-without" },
      evalJson([[true]], 0, { aggregates: { meanDelta: 0.25 } }),
    );
    expect(cmd[cmd.indexOf("--ablation") + 1]).toBe("with-without");
    expect(cmd).not.toContain("--runs");
    expect(result.meanDelta).toBe(0.25);
  });

  test("passes append-system-prompt for with/without runs", () => {
    expect(run({ maxCostUsd: 1, appendSystemPrompt: "RULE" }).cmd).toContain(
      "RULE",
    );
  });

  test("requires a positive cost cap", () => {
    expect(() =>
      runPluginEval(
        "a",
        "/p",
        "evals",
        { maxCostUsd: 0 },
        {
          exec: () => "",
          mkTmp: () => "/t",
          readFile: () => "",
        },
      ),
    ).toThrow(/maxCostUsd/);
  });
});

describe("parsePluginEvalJson", () => {
  test("parses a real v1 result into seeds from arms.with[].passed", () => {
    const r = parsePluginEvalJson("a", FIXTURE);
    expect(r.cases).toEqual({
      "trigger-should-step-a": [true, true, false],
      "trigger-shouldnt-b": [true, true, true],
    });
    expect(r.score).toBeCloseTo(5 / 6);
    expect(r.costUsd).toBe(1.02);
    expect(r.meanDelta).toBeUndefined();
  });

  test("round-trips a 30-case document", () => {
    const doc = JSON.parse(FIXTURE);
    doc.cases = Array.from({ length: 30 }, (_, i) => ({
      ...doc.cases[0],
      name: `case-${i}`,
    }));
    doc.aggregates.casesTotal = 30;
    expect(
      Object.keys(parsePluginEvalJson("a", JSON.stringify(doc)).cases),
    ).toHaveLength(30);
  });

  test("throws on a partial run", () => {
    const doc = {
      ...JSON.parse(FIXTURE),
      partial: true,
      partialReason: "cost_cap",
    };
    expect(() => parsePluginEvalJson("a", JSON.stringify(doc))).toThrow(
      /partial \(cost_cap\)/,
    );
  });

  test("rejects malformed or unsupported output", () => {
    expect(() => parsePluginEvalJson("a", "{}")).toThrow(/no cases/);
    expect(() =>
      parsePluginEvalJson("a", '{"schemaVersion":2,"cases":[]}'),
    ).toThrow(/schemaVersion 2/);
    expect(() =>
      parsePluginEvalJson("a", '{"schemaVersion":1,"cases":[]}'),
    ).toThrow(/no results/);
  });
});

describe("abOnTwoCheckouts", () => {
  const opts = {
    repoDir: "/repo",
    baseRef: "main",
    headRef: "feat",
    pluginRel: "plugins/x",
    evalDir: "evals",
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
    expect(evals[0][0]).toBe("/tmp/ab/base/plugins/x");
    expect(evals[1][0]).toBe("/tmp/ab/head/plugins/x");
    expect(evals[0]).not.toContain("with-without");
    expect(evals[0][evals[0].indexOf("--ablation") + 1]).toBe("none");
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
  const row = (fp: string, runs: number, completed: number, skipped = 0) => ({
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
