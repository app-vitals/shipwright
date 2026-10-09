/**
 * plugins/shipwright/scripts/prompt-audit/watch.unit.test.ts
 *
 * Recorded series fixtures with injected fetch and clock; no git, merge or
 * filesystem action is possible from the module under test.
 */

import { describe, expect, test } from "bun:test";
import type { Ledger, LedgerEntry } from "./ledger.ts";
import { runCli, type CliDeps } from "./cli.ts";
import {
  buildRevertProposal,
  evaluateWatch,
  fetchWatchSeries,
  type OutcomeRow,
  type PrOutcomeRow,
  watchFinding,
  type WatchFetch,
  type WatchOptions,
  type WatchPostFetch,
} from "./watch.ts";

const NOW = new Date("2026-10-09T00:00:00Z");
const FP = "abc123def456";

const row = (
  fp: string,
  over: Partial<OutcomeRow> = {},
  phase = "dev-task",
): OutcomeRow => ({
  phase,
  contextFingerprint: fp,
  runs: 30,
  completed: 28,
  failed: 2,
  skipped: 0,
  avgTurns: 40,
  avgContextTokens: 20_000,
  ...over,
});

const OPTS: WatchOptions = {
  baseUrl: "http://admin",
  token: "t",
  beforeFingerprint: "before",
  afterFingerprint: "after",
};

const flat = [row("before"), row("after")];
const regression = [row("before"), row("after", { avgContextTokens: 30_000 })];

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    fingerprint: FP,
    rule: "claude-md-over-200-lines",
    file: "CLAUDE.md",
    status: "measured",
    history: [],
    ...over,
  } as unknown as LedgerEntry;
}

const ledgerOf = (e: LedgerEntry): Ledger => ({
  lastRun: null,
  models: [],
  baselines: {},
  findings: { [FP]: e },
});

function fetchOf(
  outcomes: OutcomeRow[],
  prs: PrOutcomeRow[] = [],
): WatchFetch {
  return async (url) => ({
    ok: true,
    status: 200,
    json: async () =>
      url.includes("pr-outcomes") ? { series: prs } : { series: outcomes },
  });
}

describe("evaluateWatch", () => {
  test("under 20 runs on either side is insufficient data", () => {
    const small = [row("before", { completed: 10, failed: 5 }), row("after")];
    const r = evaluateWatch(FP, OPTS, { outcomes: small, prOutcomes: [] });
    expect(r.verdict).toBe("insufficient-data");
    expect(r.phases[0]).toMatchObject({
      verdict: "insufficient-data",
      beforeRuns: 15,
      afterRuns: 30,
    });
    const afterSmall = [row("before"), row("after", { completed: 19, failed: 0 })];
    expect(
      evaluateWatch(FP, OPTS, { outcomes: afterSmall, prOutcomes: [] }).verdict,
    ).toBe("insufficient-data");
  });

  test("skipped runs do not count toward the 20-run floor", () => {
    const skippy = [row("before", { runs: 40, completed: 10, failed: 5, skipped: 25 }), row("after")];
    expect(
      evaluateWatch(FP, OPTS, { outcomes: skippy, prOutcomes: [] }).verdict,
    ).toBe("insufficient-data");
  });

  test("flat series is ok", () => {
    expect(
      evaluateWatch(FP, OPTS, { outcomes: flat, prOutcomes: [] }).verdict,
    ).toBe("ok");
  });

  test.each([
    ["cost", { avgContextTokens: 25_000 }],
    ["turns", { avgTurns: 50 }],
    ["skipRate", { runs: 36, skipped: 6 }],
  ] as const)("%s beyond threshold is regressed", (metric, over) => {
    const r = evaluateWatch(FP, OPTS, {
      outcomes: [row("before"), row("after", over)],
      prOutcomes: [],
    });
    expect(r.verdict).toBe("regressed");
    expect(
      r.phases[0].comparisons.find((c) => c.metric === metric)?.regressed,
    ).toBe(true);
  });

  test("patch cycles regress from PR windows, not phases", () => {
    const pr = (fp: string, avg: number): PrOutcomeRow => ({
      contextFingerprint: fp,
      prs: 25,
      avgPatchCycles: avg,
    });
    const r = evaluateWatch(FP, OPTS, {
      outcomes: flat,
      prOutcomes: [pr("before", 1), pr("after", 1.8)],
    });
    expect(r.verdict).toBe("regressed");
  });

  test("patch cycles from fewer than 20 PRs are ignored", () => {
    const r = evaluateWatch(FP, OPTS, {
      outcomes: flat,
      prOutcomes: [
        { contextFingerprint: "before", prs: 5, avgPatchCycles: 0 },
        { contextFingerprint: "after", prs: 5, avgPatchCycles: 3 },
      ],
    });
    expect(r.verdict).toBe("ok");
  });

  test("carries the confound caveats", () => {
    const r = evaluateWatch(FP, OPTS, { outcomes: flat, prOutcomes: [] });
    expect(r.caveats.join(" ")).toContain("model cutover");
    expect(r.caveats.join(" ")).toContain("imultaneous");
  });
});

describe("fetchWatchSeries", () => {
  test("closes a from-only range at now so pr-outcomes is not half-open", async () => {
    const urls: string[] = [];
    const fetchFn: WatchFetch = async (url) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => ({ series: [] }) };
    };
    await fetchWatchSeries(
      { ...OPTS, from: "2026-09-01T00:00:00.000Z", to: undefined },
      fetchFn,
      () => NOW,
    );
    for (const u of urls) {
      expect(u).toContain("from=");
      expect(u).toContain(`to=${encodeURIComponent(NOW.toISOString())}`);
    }
  });

  test("a failed PR fetch warns and yields an empty PR series", async () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => warnings.push(m);
    try {
      const fetchFn: WatchFetch = async (url) =>
        url.includes("pr-outcomes")
          ? { ok: false, status: 400, json: async () => ({}) }
          : { ok: true, status: 200, json: async () => ({ series: flat }) };
      const s = await fetchWatchSeries(OPTS, fetchFn, () => NOW);
      expect(s.prOutcomes).toEqual([]);
      expect(warnings.join(" ")).toContain("patchCycles");
    } finally {
      console.warn = warn;
    }
  });
});

describe("watchFinding", () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const postFn: WatchPostFetch = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 201 };
  };
  const deps = (outcomes: OutcomeRow[]) => ({
    fetchFn: fetchOf(outcomes),
    postFn,
    now: () => NOW,
    taskStoreUrl: "http://tasks",
    taskStoreToken: "tok",
  });

  test("synthetic regression is marked regressed and files exactly one hitl task", async () => {
    posts.length = 0;
    const two = [
      ...regression,
      row("before", {}, "review"),
      row("after", { avgTurns: 90 }, "review"),
    ];
    const out = await watchFinding(ledgerOf(entry()), FP, OPTS, "o/r", deps(two));
    expect(out.result.verdict).toBe("regressed");
    expect(out.ledger.findings[FP].status).toBe("regressed");
    expect(out.ledger.findings[FP].history.at(-1)).toEqual({
      at: NOW.toISOString(),
      event: "regressed",
      status: "regressed",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("http://tasks/tasks");
    expect(posts[0].body).toMatchObject({
      hitl: true,
      status: "pending",
      repo: "o/r",
    });
    expect(String(posts[0].body.description)).toContain("dev-task");
    expect(String(posts[0].body.description)).toContain("review");
  });

  test("an already regressed finding is not re-filed", async () => {
    posts.length = 0;
    const out = await watchFinding(
      ledgerOf(entry({ status: "regressed" })),
      FP,
      OPTS,
      "o/r",
      deps(regression),
    );
    expect(out.filed).toBe(false);
    expect(posts).toHaveLength(0);
  });

  test("insufficient or ok series changes nothing and files nothing", async () => {
    posts.length = 0;
    const ledger = ledgerOf(entry());
    const out = await watchFinding(ledger, FP, OPTS, "o/r", deps(flat));
    expect(out.ledger).toBe(ledger);
    expect(posts).toHaveLength(0);
  });

  test("409 from the task store is tolerated; other failures throw", async () => {
    const conflict: WatchPostFetch = async () => ({ ok: false, status: 409 });
    const out = await watchFinding(ledgerOf(entry()), FP, OPTS, "o/r", {
      ...deps(regression),
      postFn: conflict,
    });
    expect(out.filed).toBe(false);
    expect(out.ledger.findings[FP].status).toBe("regressed");
    const boom: WatchPostFetch = async () => ({ ok: false, status: 500 });
    await expect(
      watchFinding(ledgerOf(entry()), FP, OPTS, "o/r", {
        ...deps(regression),
        postFn: boom,
      }),
    ).rejects.toThrow("500");
  });

  test("unknown finding throws", async () => {
    await expect(
      watchFinding(ledgerOf(entry()), "nope", OPTS, "o/r", deps(flat)),
    ).rejects.toThrow("not in the ledger");
  });
});

describe("buildRevertProposal", () => {
  test("is hitl, pending, and stable per finding", () => {
    const result = evaluateWatch(FP, OPTS, {
      outcomes: regression,
      prOutcomes: [],
    });
    const a = buildRevertProposal(entry(), result, "o/r");
    expect(a.hitl).toBe(true);
    expect(a.status).toBe("pending");
    expect(a.id).toBe(buildRevertProposal(entry(), result, "o/r").id);
  });
});

describe("cli watch", () => {
  function cliDeps(files: Record<string, string>): CliDeps {
    return {
      fs: {
        listFiles: () => [],
        readFile: (_r, p) => files[p],
        exists: (_r, p) => p in files,
        writeFile: (_r, p, c) => {
          files[p] = c;
        },
      },
      exec: () => {
        throw new Error("watch must not run commands");
      },
      now: () => NOW,
      countTokens: async () => ({}),
      loadUsage: async () => null,
      env: {
        SHIPWRIGHT_API_URL: "http://admin",
        SHIPWRIGHT_AGENT_API_KEY: "k",
        SHIPWRIGHT_TASK_STORE_URL: "http://tasks",
        SHIPWRIGHT_TASK_STORE_TOKEN: "t",
      },
      http: {
        get: fetchOf(regression),
        post: async () => ({ ok: true, status: 201 }),
      },
    };
  }

  test("flags the regression, persists it, runs no commands", async () => {
    const files = {
      "state/prompt-audit-ledger.json": JSON.stringify(ledgerOf(entry())),
    };
    const res = await runCli(
      ["watch", "--finding", FP, "--before-fp", "before", "--after-fp", "after"],
      cliDeps(files),
    );
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain("regressed");
    expect(res.stdout).toContain("filed (hitl)");
    expect(
      JSON.parse(files["state/prompt-audit-ledger.json"]).findings[FP].status,
    ).toBe("regressed");
  });

  test("requires --finding and fingerprints", async () => {
    const files = {
      "state/prompt-audit-ledger.json": JSON.stringify(ledgerOf(entry())),
    };
    expect((await runCli(["watch"], cliDeps(files))).exit).toBe(2);
    expect(
      (await runCli(["watch", "--finding", FP], cliDeps(files))).exit,
    ).toBe(2);
  });
});
