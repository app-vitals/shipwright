import { describe, expect, it } from "bun:test";
import {
  ADHERENCE_DISCLAIMER,
  buildReport,
  buildRunAdherence,
  type CronRunRow,
  DevTaskAdherenceService,
  ENRICHMENT_CONCURRENCY,
  type ModelBreakdownRow,
  mergeRunRows,
  PATCH_REQUIRED_STEPS,
  parsePrRef,
  REQUIRED_STEPS,
  type RequiredStep,
  type RunEnrichment,
  type SkillUsageRow,
} from "./dev-task-adherence.ts";

const agent = (name: string, invocations = 1): SkillUsageRow => ({
  kind: "agent",
  name,
  invocations,
});

const run = (
  id: string,
  fp: string | null = null,
  commandVariant: string | null = null,
) => ({
  id,
  itemId: id,
  contextFingerprint: fp,
  commandVariant,
});

// The nine known sessions skipped the Step 5 and 6.5 dispatches: no
// general-purpose agent rows at all (only skills / root attribution).
const KNOWN_SESSIONS = [
  "VRW-1.1",
  "VRW-1.2",
  "PAU-4.2",
  "PAU-1.10",
  "PAU-1.8",
  "SSX-3.1",
  "SSX-2.2",
  "CDV-1.1",
  "PRL-1.1",
];

describe("dev-task adherence", () => {
  it("flags the nine known sessions as missing Steps 5 and 6.5", () => {
    for (const id of KNOWN_SESSIONS) {
      const r = buildRunAdherence(REQUIRED_STEPS, run(id), [
        { kind: "skill", name: "shipwright:dev-task", invocations: 1 },
        agent("shipwright:researcher"),
      ]);
      expect(r.adherent).toBe(false);
      expect(r.missingSteps).toContain("5");
      expect(r.missingSteps).toContain("6.5");
    }
  });

  it("reports runs with all required dispatches as adherent", () => {
    const r = buildRunAdherence(REQUIRED_STEPS, run("ok"), [
      agent("general-purpose", 2),
      agent("shipwright:docs-refresher"),
    ]);
    expect(r.adherent).toBe(true);
    expect(r.missingSteps).toEqual([]);
  });

  it("does not count Step 5's dispatch toward Step 6.5", () => {
    const r = buildRunAdherence(REQUIRED_STEPS, run("one"), [
      agent("general-purpose", 1),
      agent("shipwright:docs-refresher"),
    ]);
    expect(r.missingSteps).toEqual(["6.5"]);
  });

  it("accepts a custom implementer subagent for Step 5", () => {
    const r = buildRunAdherence(REQUIRED_STEPS, run("custom"), [
      agent("my-implementer"),
      agent("general-purpose"),
      agent("shipwright:docs-refresher"),
    ]);
    expect(r.adherent).toBe(true);
  });

  it("marks non-dispatch steps unmeasured", () => {
    const r = buildRunAdherence(REQUIRED_STEPS, run("u"), []);
    const status = (n: string) =>
      r.steps.find((s) => s.stepNumber === n)?.status;
    expect(status("6")).toBe("unmeasured"); // no enrichment => no proof
    expect(status("7")).toBe("unmeasured");
    expect(status("9")).toBe("unmeasured");
  });

  it("aggregates per-step rates overall and per variant", () => {
    const good = buildRunAdherence(REQUIRED_STEPS, run("g", "fpA"), [
      agent("general-purpose", 2),
      agent("shipwright:docs-refresher"),
    ]);
    const bad = buildRunAdherence(REQUIRED_STEPS, run("b", "fpB"), []);
    const report = buildReport(REQUIRED_STEPS, [good, bad]);
    const step5 = report.overall.steps.find((s) => s.stepNumber === "5");
    expect(step5).toMatchObject({ ran: 1, skipped: 1, rate: 0.5 });
    expect(report.overall.adherentRuns).toBe(1);
    expect(report.byVariant.map((v) => v.variant).sort()).toEqual([
      "fpA",
      "fpB",
    ]);
    // Step 6 is now measured (task-store), but no enrichment here => no rate.
    const step6 = report.overall.steps.find((s) => s.stepNumber === "6");
    expect(step6).toMatchObject({ measured: true, rate: null });
    const step7 = report.overall.steps.find((s) => s.stepNumber === "7");
    expect(step7).toMatchObject({ measured: false, rate: null });
    expect(report.disclaimer).toBe(ADHERENCE_DISCLAIMER);
    expect(report.disclaimer).toContain("started, not that it was done well");
  });

  it("reports a general-purpose dispatch fixture as Step 5 ran", () => {
    const r = buildRunAdherence(REQUIRED_STEPS, run("gp"), [
      agent("general-purpose"),
    ]);
    expect(r.steps.find((s) => s.stepNumber === "5")?.status).toBe("ran");
    expect(r.missingSteps).not.toContain("5");
  });

  it("splits adherence by commandVariant over task-bearing runs only", () => {
    const good = [
      agent("general-purpose", 2),
      agent("shipwright:docs-refresher"),
    ];
    const runs = [
      buildRunAdherence(REQUIRED_STEPS, run("d1", null, "default"), good),
      buildRunAdherence(REQUIRED_STEPS, run("d2", null, "default"), []),
      buildRunAdherence(REQUIRED_STEPS, run("a1", null, "alternate"), good),
      buildRunAdherence(REQUIRED_STEPS, run("n1"), good),
      // Silent tick: no work item, no usage — must not drag rates down.
      buildRunAdherence(
        REQUIRED_STEPS,
        {
          id: "s1",
          itemId: null,
          contextFingerprint: null,
          commandVariant: "alternate",
        },
        [],
      ),
    ];
    const report = buildReport(REQUIRED_STEPS, runs);
    expect(report.counts).toEqual({
      totalRuns: 5,
      taskBearingRuns: 4,
      silentTicks: 1,
      mixedTasks: 0,
    });
    expect(report.overall.runs).toBe(4);
    expect(
      report.byCommandVariant.map((v) => [
        v.commandVariant,
        v.runs,
        v.adherentRuns,
        v.adherenceRate,
      ]),
    ).toEqual([
      ["alternate", 1, 1, 1],
      ["default", 2, 1, 0.5],
      [null, 1, 1, 1],
    ]);
  });

  describe("task-store enrichment (DTA-6.2)", () => {
    const STEPS: RequiredStep[] = [
      ...REQUIRED_STEPS,
      {
        stepNumber: "2",
        title: "Start",
        mandatory: true,
        proofOfRunning: "task startedAt set",
        measurable: true,
      },
    ];
    const baseTask = {
      repo: "app-vitals/shipwright",
      startedAt: null,
      pr: null,
      prCreatedAt: null,
    };
    const enrich = (over: Partial<RunEnrichment> = {}): RunEnrichment => ({
      task: baseTask,
      checks: [],
      pr: null,
      ...over,
    });
    const status = (e: RunEnrichment | undefined, n: string) =>
      buildRunAdherence(STEPS, run("e"), [], e).steps.find(
        (s) => s.stepNumber === n,
      )?.status;

    it("leaves steps 2/8/9/9b unmeasured when enrichment is absent", () => {
      for (const n of ["2", "8", "9", "9b"]) {
        expect(status(undefined, n)).toBe("unmeasured");
      }
    });

    it("Step 2 ran when task.startedAt is set, else skipped", () => {
      const started = enrich({
        task: { ...baseTask, startedAt: "2026-10-01T00:00:00Z" },
      });
      expect(status(started, "2")).toBe("ran");
      expect(status(enrich(), "2")).toBe("skipped");
    });

    it("Step 8 ran on ran_passed/ran_failed rows; skipped otherwise", () => {
      expect(status(enrich({ checks: [{ status: "ran_passed" }] }), "8")).toBe(
        "ran",
      );
      expect(status(enrich({ checks: [{ status: "ran_failed" }] }), "8")).toBe(
        "ran",
      );
      expect(
        status(
          enrich({ checks: [{ status: "skipped" }, { status: "timed_out" }] }),
          "8",
        ),
      ).toBe("skipped");
      expect(status(enrich(), "8")).toBe("skipped");
    });

    it("Step 9 ran when task.pr or prCreatedAt is set", () => {
      expect(status(enrich({ task: { ...baseTask, pr: 12 } }), "9")).toBe(
        "ran",
      );
      expect(
        status(
          enrich({
            task: { ...baseTask, prCreatedAt: "2026-10-01T00:00:00Z" },
          }),
          "9",
        ),
      ).toBe("ran");
      expect(status(enrich(), "9")).toBe("skipped");
    });

    it("Step 9b ran with CI outcome data; absence is not penalized", () => {
      const withCi = enrich({ pr: { commitsCiFix: 2 } });
      expect(status(withCi, "9b")).toBe("ran");
      expect(status(enrich({ pr: { commitsCiFix: 0 } }), "9b")).toBe("ran");
      const none = buildRunAdherence(
        STEPS,
        run("n"),
        [agent("general-purpose", 2), agent("shipwright:docs-refresher")],
        enrich({
          task: {
            ...baseTask,
            startedAt: "2026-10-01T00:00:00Z",
            pr: 3,
            simplifyTotal: 0,
          },
          checks: [{ status: "ran_passed" }],
          pr: { commitsCiFix: null },
        }),
      );
      expect(none.steps.find((s) => s.stepNumber === "9b")?.status).toBe(
        "skipped",
      );
      expect(none.missingSteps).toEqual([]);
      expect(none.adherent).toBe(true);
    });

    it("summarize counts the four steps as measured", () => {
      const r = buildRunAdherence(STEPS, run("m"), [], enrich());
      const report = buildReport(STEPS, [r]);
      for (const n of ["2", "8", "9", "9b"]) {
        expect(
          report.overall.steps.find((s) => s.stepNumber === n)?.measured,
        ).toBe(true);
      }
      expect(
        report.overall.steps.find((s) => s.stepNumber === "7")?.measured,
      ).toBe(false);
    });

    it("measures Step 6 from task.simplifyTotal (DTA-8.3)", () => {
      const st = (simplifyTotal: number | null | undefined) =>
        buildRunAdherence(
          STEPS,
          run("s6"),
          [],
          enrich({ task: { ...enrich().task, simplifyTotal } }),
        ).steps.find((s) => s.stepNumber === "6")?.status;
      expect(st(0)).toBe("ran");
      expect(st(3)).toBe("ran");
      expect(st(null)).toBe("skipped");
      expect(st(undefined)).toBe("skipped");
      const report = buildReport(STEPS, [
        buildRunAdherence(STEPS, run("m"), [], enrich()),
      ]);
      expect(
        report.overall.steps.find((s) => s.stepNumber === "6")?.measured,
      ).toBe(true);
    });
  });

  describe("mergeRunRows / stalled-then-resumed runs (DTA-8.3)", () => {
    const base = {
      itemId: "SPL-2.8",
      contextFingerprint: null,
      commandVariant: null,
    };

    it("merges two rows for one itemId: union of dispatches, counted once", async () => {
      const rows = [
        {
          ...base,
          id: "stalled",
          skillUsage: [agent("shipwright:researcher")],
        },
        {
          ...base,
          id: "resumed",
          commandVariant: "alternate",
          skillUsage: [
            agent("general-purpose", 2),
            agent("shipwright:researcher"),
          ],
        },
        { ...base, id: "tick", itemId: null, skillUsage: [] },
        { ...base, id: "tick2", itemId: null, skillUsage: [] },
      ];
      const merged = mergeRunRows(rows);
      expect(merged.map((r) => r.id)).toEqual(["resumed", "tick", "tick2"]);
      expect(merged[0].commandVariant).toBe("alternate");
      expect(
        merged[0].skillUsage.find((u) => u.name === "shipwright:researcher")
          ?.invocations,
      ).toBe(2);

      const p = { agentCronRun: { findMany: async () => rows } } as never;
      const report = await new DevTaskAdherenceService(p).report();
      expect(report.counts).toEqual({
        totalRuns: 3,
        taskBearingRuns: 1,
        silentTicks: 2,
        // Arm membership uses the raw rows: stalled (null) + resumed
        // (alternate) spans two commandVariant values, so it is mixed.
        mixedTasks: 1,
      });
      const r = report.runs[0];
      expect(r.steps.find((s) => s.stepNumber === "5")?.status).toBe("ran");
      expect(r.missingSteps).not.toContain("5");
    });

    it("falls back to earlier fingerprint when the latest row lacks one", () => {
      const merged = mergeRunRows([
        { ...base, id: "a", contextFingerprint: "fp", skillUsage: [] },
        { ...base, id: "b", skillUsage: [] },
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0].contextFingerprint).toBe("fp");
    });
  });

  describe("DevTaskAdherenceService enrichment fetching", () => {
    const rows = [
      {
        id: "r1",
        itemId: "T-1",
        contextFingerprint: null,
        commandVariant: null,
        skillUsage: [],
      },
      {
        id: "r2",
        itemId: "T-2",
        contextFingerprint: null,
        commandVariant: null,
        skillUsage: [],
      },
      {
        id: "r3",
        itemId: "T-3",
        contextFingerprint: null,
        commandVariant: null,
        skillUsage: [],
      },
      {
        id: "r4",
        itemId: null,
        contextFingerprint: null,
        commandVariant: null,
        skillUsage: [],
      },
    ];
    const prisma = {
      agentCronRun: { findMany: async () => rows },
    } as never;
    const task = {
      repo: "o/r",
      startedAt: "2026-10-01T00:00:00Z",
      pr: 7,
      prCreatedAt: null,
      mergedAt: null,
      deployedAt: null,
      ciFixAttempts: 0,
    };

    it("enriches task-bearing runs, degrading on 404 and fetch failure", async () => {
      const calls: string[] = [];
      const svc = new DevTaskAdherenceService(prisma, REQUIRED_STEPS, {
        getTask: async (id: string) => {
          calls.push(id);
          if (id === "T-2") return null;
          if (id === "T-3") throw new Error("boom");
          return task;
        },
        getPrByNumber: async () => ({ commitsCiFix: 1 }) as never,
        getVerificationChecks: (async () => [
          { status: "ran_passed" },
        ]) as never,
      });
      const report = await svc.report();
      const st = (i: number, n: string) =>
        report.runs[i]?.steps.find((s) => s.stepNumber === n)?.status;
      expect(st(0, "8")).toBe("ran");
      expect(st(0, "9")).toBe("ran");
      expect(st(0, "9b")).toBe("ran");
      for (const i of [1, 2, 3]) expect(st(i, "8")).toBe("unmeasured");
      expect(calls).toEqual(["T-1", "T-2", "T-3"]);
    });

    const manyRuns = (ids: string[]) =>
      ids.map((itemId, i) => ({
        id: `r${i}`,
        itemId,
        contextFingerprint: null,
        commandVariant: null,
        skillUsage: [],
      }));

    it("bounds in-flight enrichment to ENRICHMENT_CONCURRENCY", async () => {
      const ids = Array.from({ length: 30 }, (_, i) => `T-${i}`);
      const p = {
        agentCronRun: { findMany: async () => manyRuns(ids) },
      } as never;
      let inFlight = 0;
      let max = 0;
      const svc = new DevTaskAdherenceService(p, REQUIRED_STEPS, {
        getTask: async () => {
          inFlight++;
          max = Math.max(max, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight--;
          return task;
        },
      });
      const report = await svc.report();
      expect(report.runs).toHaveLength(30);
      expect(max).toBeGreaterThan(1);
      expect(max).toBeLessThanOrEqual(ENRICHMENT_CONCURRENCY);
    });

    it("looks up each shared itemId once per request", async () => {
      const p = {
        agentCronRun: {
          findMany: async () => manyRuns(["T-1", "T-1", "T-1", "T-2"]),
        },
      } as never;
      const calls = { task: 0, checks: 0, pr: 0 };
      const svc = new DevTaskAdherenceService(p, REQUIRED_STEPS, {
        getTask: async () => {
          calls.task++;
          return task;
        },
        getVerificationChecks: async () => {
          calls.checks++;
          return [{ status: "ran_passed" }];
        },
        getPrByNumber: async () => {
          calls.pr++;
          return { commitsCiFix: 1 };
        },
      });
      await svc.report();
      expect(calls).toEqual({ task: 2, checks: 2, pr: 2 });
      await svc.report();
      expect(calls).toEqual({ task: 4, checks: 4, pr: 4 });
    });

    it("behaves as before with no fetchers", async () => {
      const report = await new DevTaskAdherenceService(prisma).report();
      expect(
        report.runs[0]?.steps.find((s) => s.stepNumber === "9")?.status,
      ).toBe("unmeasured");
    });
  });
});

describe("per-arm outcomes (DTA-8.2)", () => {
  const enr = (
    ciFixAttempts: number | null | undefined,
    pr: { patchCycles: number; reviewCycles: number } | null,
  ): RunEnrichment => ({
    task: {
      startedAt: null,
      pr: pr ? 1 : null,
      prCreatedAt: null,
      ...(ciFixAttempts === undefined ? {} : { ciFixAttempts }),
    },
    checks: [],
    pr: pr ? { commitsCiFix: null, ...pr } : null,
  });
  const r = (id: string, arm: string | null, itemId: string | null = id) =>
    buildRunAdherence(
      REQUIRED_STEPS,
      {
        id: `${id}-${arm}-${Math.random()}`,
        itemId,
        contextFingerprint: null,
        commandVariant: arm,
      },
      [],
    );
  const arm = (report: ReturnType<typeof buildReport>, v: string | null) =>
    report.byCommandVariant.find((s) => s.commandVariant === v)?.outcomes;

  it("computes single-arm means, shares and CI first-pass rate", () => {
    const runs = [
      r("a", "default"),
      r("b", "default"),
      r("c", "default"),
      r("d", "alternate"),
    ];
    const e = new Map<string, RunEnrichment | undefined>([
      ["a", enr(0, { patchCycles: 0, reviewCycles: 1 })],
      ["b", enr(2, { patchCycles: 2, reviewCycles: 3 })],
      ["c", enr(0, { patchCycles: 4, reviewCycles: 2 })],
      ["d", enr(1, { patchCycles: 1, reviewCycles: 0 })],
    ]);
    const rep = buildReport(REQUIRED_STEPS, runs, e);
    expect(arm(rep, "default")).toEqual({
      tasks: 3,
      prs: 3,
      meanPatchCycles: 2,
      shareZeroPatchCycles: 1 / 3,
      shareTwoPlusPatchCycles: 2 / 3,
      meanReviewCycles: 2,
      ciFirstPassRate: 2 / 3,
      meanCiFixAttempts: 2 / 3,
    });
    expect(arm(rep, "alternate")).toMatchObject({
      tasks: 1,
      meanPatchCycles: 1,
      ciFirstPassRate: 0,
      meanCiFixAttempts: 1,
    });
    expect(rep.counts.mixedTasks).toBe(0);
  });

  it("excludes tasks that ran in both arms and counts them", () => {
    const runs = [
      r("a", "default"),
      r("m", "default"),
      r("m", "alternate"),
      r("n", "default"),
      r("n", null),
    ];
    const e = new Map<string, RunEnrichment | undefined>([
      ["a", enr(0, { patchCycles: 1, reviewCycles: 1 })],
      ["m", enr(3, { patchCycles: 5, reviewCycles: 5 })],
      ["n", enr(3, { patchCycles: 5, reviewCycles: 5 })],
    ]);
    const rep = buildReport(REQUIRED_STEPS, runs, e);
    expect(rep.counts.mixedTasks).toBe(2);
    expect(arm(rep, "default")).toMatchObject({
      tasks: 1,
      meanPatchCycles: 1,
      ciFirstPassRate: 1,
    });
    expect(arm(rep, "alternate")?.tasks).toBe(0);
    expect(arm(rep, "alternate")?.meanPatchCycles).toBeNull();
    expect(arm(rep, null)?.tasks).toBe(0);
    // runs themselves still counted per arm
    expect(
      rep.byCommandVariant.find((s) => s.commandVariant === "alternate")?.runs,
    ).toBe(1);
  });

  it("dedupes a task with several runs in the same arm", () => {
    const runs = [r("a", "default"), r("a", "default"), r("a", "default")];
    const e = new Map([["a", enr(1, { patchCycles: 2, reviewCycles: 4 })]]);
    const rep = buildReport(REQUIRED_STEPS, runs, e);
    expect(arm(rep, "default")).toMatchObject({
      tasks: 1,
      prs: 1,
      meanPatchCycles: 2,
      meanReviewCycles: 4,
      meanCiFixAttempts: 1,
    });
    expect(rep.byVariant[0]?.outcomes.tasks).toBe(1);
    expect(rep.overall.outcomes.tasks).toBe(1);
  });

  it("handles unenriched tasks, missing PRs and null ciFixAttempts", () => {
    const runs = [
      r("u", "default"),
      r("nopr", "default"),
      r("nullci", "default"),
      r("silent", "default", null),
    ];
    const e = new Map<string, RunEnrichment | undefined>([
      ["u", undefined],
      ["nopr", enr(0, null)],
      ["nullci", enr(null, { patchCycles: 0, reviewCycles: 0 })],
    ]);
    const rep = buildReport(REQUIRED_STEPS, runs, e);
    expect(arm(rep, "default")).toEqual({
      tasks: 2,
      prs: 1,
      meanPatchCycles: 0,
      shareZeroPatchCycles: 1,
      shareTwoPlusPatchCycles: 0,
      meanReviewCycles: 0,
      ciFirstPassRate: 1,
      meanCiFixAttempts: 0,
    });
    // no enrichment map at all -> all-null outcomes, no leakage into runs
    const bare = buildReport(REQUIRED_STEPS, runs);
    expect(bare.overall.outcomes.tasks).toBe(0);
    expect(bare.overall.outcomes.ciFirstPassRate).toBeNull();
    expect(JSON.stringify(bare.runs)).not.toContain("patchCycles");
  });

  it("service passes cached enrichment through without extra lookups", async () => {
    const rows = ["T-1", "T-1", "T-2"].map((itemId, i) => ({
      id: `r${i}`,
      itemId,
      contextFingerprint: null,
      commandVariant: i === 1 ? "alternate" : "default",
      skillUsage: [],
    }));
    const calls = { task: 0, pr: 0 };
    const svc = new DevTaskAdherenceService(
      { agentCronRun: { findMany: async () => rows } } as never,
      REQUIRED_STEPS,
      {
        getTask: async () => {
          calls.task++;
          return {
            repo: "o/r",
            startedAt: null,
            pr: 1,
            prCreatedAt: null,
            ciFixAttempts: 0,
          };
        },
        getPrByNumber: async () => {
          calls.pr++;
          return { commitsCiFix: 0, patchCycles: 1, reviewCycles: 2 };
        },
      },
    );
    const rep = await svc.report();
    expect(calls).toEqual({ task: 2, pr: 2 });
    expect(rep.counts.mixedTasks).toBe(1);
    expect(arm(rep, "default")).toMatchObject({
      tasks: 1,
      meanPatchCycles: 1,
      ciFirstPassRate: 1,
    });
  });
});

describe("patch adherence (DTA-9.2)", () => {
  const patchRun = (
    steps: RequiredStep[],
    r: Parameters<typeof buildRunAdherence>[1],
    usage: SkillUsageRow[],
    e?: RunEnrichment,
  ) => buildRunAdherence(steps, r, usage, e, "patch");
  const status = (
    r: { steps: { stepNumber: string; status: string }[] },
    n: string,
  ) => r.steps.find((s) => s.stepNumber === n)?.status;
  const pr = (id: string, cv: string | null = null) => ({
    id,
    itemId: `o/r#${id}`,
    contextFingerprint: null,
    commandVariant: cv,
  });

  it("scores fix dispatch lane-agnostically on any agent row", () => {
    for (const name of ["general-purpose", "shipwright:code-reviewer", "x:y"]) {
      const r = patchRun(PATCH_REQUIRED_STEPS, pr("1"), [agent(name)]);
      expect(status(r, "5b")).toBe("ran");
    }
    const none = patchRun(PATCH_REQUIRED_STEPS, pr("2"), [
      { kind: "skill", name: "shipwright:patch", invocations: 1 },
    ]);
    expect(status(none, "5b")).toBe("skipped");
    expect(none.missingSteps).toContain("5b");
  });

  it("leaves lane-specific, claim and marker steps unmeasured", () => {
    const r = patchRun(PATCH_REQUIRED_STEPS, pr("1"), [agent("a")]);
    for (const n of [
      "4b",
      "6c",
      "5c.5",
      "6d.5",
      "6.5",
      "3d",
      "4a.6",
      "5a.6",
      "6b.5",
      "5a.6b",
      "5a.7",
      "6b.6",
    ]) {
      expect(status(r, n)).toBe("unmeasured");
    }
  });

  it("proves the push (4c.5) from the PR record, else unmeasured", () => {
    const base = {
      task: { startedAt: null, pr: null, prCreatedAt: null },
      checks: [],
    };
    const run = (e?: RunEnrichment) =>
      patchRun(PATCH_REQUIRED_STEPS, pr("1"), [agent("a")], e);
    expect(status(run(), "4c.5")).toBe("unmeasured");
    expect(
      status(
        run({
          ...base,
          pr: { commitsCiFix: null, patchCycles: 2, commitSha: "abc" },
        }),
        "4c.5",
      ),
    ).toBe("ran");
    expect(
      status(
        run({
          ...base,
          pr: { commitsCiFix: null, patchCycles: 0, commitSha: "abc" },
        }),
        "4c.5",
      ),
    ).toBe("skipped");
    expect(status(run({ ...base, pr: null }), "4c.5")).toBe("unmeasured");
  });

  it("parses org/repo#N item ids", () => {
    expect(parsePrRef("app-vitals/shipwright#12")).toEqual({
      repo: "app-vitals/shipwright",
      pr: 12,
    });
    expect(parsePrRef("DTA-9.2")).toBeNull();
    expect(parsePrRef(null)).toBeNull();
  });

  it("reproduces ~5% fix dispatch over task-bearing runs, grouped by commandVariant", () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      patchRun(
        PATCH_REQUIRED_STEPS,
        pr(String(i), i % 2 ? "alternate" : "default"),
        i === 3 ? [agent("general-purpose")] : [],
      ),
    );
    runs.push(
      patchRun(
        PATCH_REQUIRED_STEPS,
        {
          id: "silent",
          itemId: null,
          contextFingerprint: null,
          commandVariant: null,
        },
        [],
      ),
    );
    const report = buildReport(PATCH_REQUIRED_STEPS, runs, undefined, "patch");
    expect(report.counts).toEqual({
      totalRuns: 21,
      taskBearingRuns: 20,
      silentTicks: 1,
      mixedTasks: 0,
      mixedPrs: 0,
    });
    const rate = (s: {
      steps: { stepNumber: string; rate: number | null }[];
    }) => s.steps.find((x) => x.stepNumber === "5b")?.rate;
    expect(rate(report.overall)).toBe(0.05);
    expect(report.byCommandVariant.map((c) => c.commandVariant)).toEqual([
      "alternate",
      "default",
    ]);
    expect(rate(report.byCommandVariant[0])).toBe(0.1);
    expect(rate(report.byCommandVariant[1])).toBe(0);
    expect(
      report.overall.steps.find((x) => x.stepNumber === "4b")?.measured,
    ).toBe(false);
    expect(
      report.overall.steps.find((x) => x.stepNumber === "5b")?.measured,
    ).toBe(true);
  });

  describe("service", () => {
    const rows = [
      {
        id: "r1",
        itemId: "o/r#1",
        contextFingerprint: null,
        commandVariant: "default",
        skillUsage: [agent("general-purpose")],
      },
      {
        id: "r1b",
        itemId: "o/r#1",
        contextFingerprint: null,
        commandVariant: "default",
        skillUsage: [],
      },
      {
        id: "r2",
        itemId: "DTA-1.1",
        contextFingerprint: null,
        commandVariant: "alternate",
        skillUsage: [],
      },
      {
        id: "r3",
        itemId: null,
        contextFingerprint: null,
        commandVariant: null,
        skillUsage: [],
      },
    ];
    const make = () => {
      const where: unknown[] = [];
      const prisma = {
        agentCronRun: {
          findMany: async (a: { where: unknown }) => {
            where.push(a.where);
            return rows;
          },
        },
      } as never;
      return { prisma, where };
    };

    it("queries the shipwright-patch cron, merges resumes, and enriches via PR ref or task", async () => {
      const { prisma, where } = make();
      const prCalls: string[] = [];
      const svc = new DevTaskAdherenceService(prisma, REQUIRED_STEPS, {
        getTask: async () => ({
          repo: "o/r",
          startedAt: null,
          pr: 9,
          prCreatedAt: null,
        }),
        getPrByNumber: async (repo: string, n: number) => {
          prCalls.push(`${repo}#${n}`);
          return { commitsCiFix: null, patchCycles: 1, commitSha: "s" };
        },
      });
      const report = await svc.report(undefined, undefined, "agent-1", "patch");
      expect(where[0]).toMatchObject({
        skipped: false,
        phaseCron: { name: "shipwright-patch" },
        agentId: "agent-1",
      });
      expect(report.command).toBe("patch");
      expect(report.counts).toEqual({
        totalRuns: 3,
        taskBearingRuns: 2,
        silentTicks: 1,
        mixedTasks: 0,
        mixedPrs: 0,
      });
      expect(status(report.runs[0], "5b")).toBe("ran");
      expect(status(report.runs[0], "4c.5")).toBe("ran");
      expect(status(report.runs[1], "5b")).toBe("skipped");
      expect(prCalls.sort()).toEqual(["o/r#1", "o/r#9"]);
    });

    it("defaults to dev-task with unchanged output (no command key)", async () => {
      const { prisma, where } = make();
      const report = await new DevTaskAdherenceService(prisma).report();
      expect(where[0]).toMatchObject({
        phaseCron: { name: "shipwright-dev-task" },
      });
      expect("command" in report).toBe(false);
    });
  });
});

describe("cost and patch guardrail metrics (DTA-9.3)", () => {
  const mb = (costUsd: number, tokens = 100): ModelBreakdownRow => ({
    inputTokens: tokens,
    outputTokens: tokens / 2,
    cacheReadTokens: tokens * 10,
    cacheCreationTokens: tokens / 4,
    costUsd,
  });
  const rawRun = (
    id: string,
    arm: string | null,
    modelBreakdown: ModelBreakdownRow[] | undefined,
    itemId: string | null = id,
  ): CronRunRow => ({
    id: `${id}-run`,
    itemId,
    contextFingerprint: null,
    commandVariant: arm,
    skillUsage: [],
    modelBreakdown,
  });
  const build = (rows: CronRunRow[], command?: "patch") => {
    const steps = command ? PATCH_REQUIRED_STEPS : REQUIRED_STEPS;
    return rows.map((r) => buildRunAdherence(steps, r, [], undefined, command));
  };
  const cost = (rep: ReturnType<typeof buildReport>, v: string | null) =>
    rep.byCommandVariant.find((s) => s.commandVariant === v)?.cost;

  it("reproduces dev-task cost 0.90 vs 1.16 per run, summing models", () => {
    const runs = build([
      rawRun("a", "default", [mb(0.5), mb(0.3)]),
      rawRun("b", "default", [mb(1.0)]),
      rawRun("c", "alternate", [mb(1.1)]),
      rawRun("d", "alternate", [mb(0.6), mb(0.62)]),
    ]);
    const rep = buildReport(REQUIRED_STEPS, runs);
    expect(cost(rep, "default")?.meanCostUsd).toBeCloseTo(0.9, 2);
    expect(cost(rep, "alternate")?.meanCostUsd).toBeCloseTo(1.16, 2);
    expect(cost(rep, "default")).toMatchObject({
      runsWithCost: 2,
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 3000,
      cacheCreationTokens: 75,
    });
    expect(rep.overall.cost.runsWithCost).toBe(4);
  });

  it("skips runs without a breakdown and returns null mean when none", () => {
    const runs = build([
      rawRun("a", "default", [mb(2)]),
      rawRun("b", "default", undefined),
      rawRun("c", "alternate", []),
    ]);
    const rep = buildReport(REQUIRED_STEPS, runs);
    expect(cost(rep, "default")?.meanCostUsd).toBe(2);
    expect(cost(rep, "alternate")?.meanCostUsd).toBeNull();
    expect(cost(rep, "alternate")?.runsWithCost).toBe(0);
  });

  it("sums a stalled+resumed run's breakdown rows via mergeRunRows", () => {
    const merged = mergeRunRows([
      rawRun("a", "default", [mb(0.4)]),
      rawRun("a2", "default", [mb(0.5)], "a"),
    ]);
    expect(merged).toHaveLength(1);
    const [r] = build(merged);
    expect(r.usage?.costUsd).toBeCloseTo(0.9, 5);
  });

  it("drops mixed-arm tasks from arm cost but keeps them in overall", () => {
    const rows = [
      rawRun("a", "default", [mb(1)]),
      rawRun("m1", "default", [mb(5)], "m"),
      rawRun("m2", "alternate", [mb(7)], "m"),
    ];
    const rep = buildReport(
      REQUIRED_STEPS,
      build(rows),
      undefined,
      "dev-task",
      rows,
    );
    expect(cost(rep, "default")?.totalCostUsd).toBe(1);
    expect(cost(rep, "alternate")?.runsWithCost).toBe(0);
    expect(rep.overall.cost.totalCostUsd).toBe(13);
  });

  describe("patch guardrails", () => {
    const prEnr = (
      patchCycles: number,
      consecutiveCiFailureCount: number | null | undefined,
    ): RunEnrichment => ({
      task: { startedAt: null, pr: 1, prCreatedAt: null },
      checks: [],
      pr: {
        commitsCiFix: null,
        patchCycles,
        reviewCycles: 0,
        consecutiveCiFailureCount,
      },
    });
    const gr = (rep: ReturnType<typeof buildReport>, v: string | null) =>
      rep.byCommandVariant.find((s) => s.commandVariant === v)?.patchGuardrails;

    it("computes repeat-patch and CI-green rates per arm, mixed PRs apart", () => {
      const rows = [
        rawRun("p1", "default", [mb(0.5)], "o/r#1"),
        rawRun("p2", "default", [mb(0.7)], "o/r#2"),
        rawRun("p3", "default", [mb(0.6)], "o/r#3"),
        rawRun("p4", "alternate", [mb(0.4)], "o/r#4"),
        rawRun("p5a", "default", [mb(0.4)], "o/r#5"),
        rawRun("p5b", "alternate", [mb(0.4)], "o/r#5"),
      ];
      const e = new Map<string, RunEnrichment | undefined>([
        ["o/r#1", prEnr(1, 0)],
        ["o/r#2", prEnr(3, 2)],
        ["o/r#3", prEnr(0, 0)],
        ["o/r#4", prEnr(2, 0)],
        ["o/r#5", prEnr(9, 9)],
      ]);
      const rep = buildReport(
        PATCH_REQUIRED_STEPS,
        build(rows, "patch"),
        e,
        "patch",
        rows,
      );
      expect(gr(rep, "default")).toEqual({
        prs: 3,
        repeatPatchRate: 1 / 3,
        // patched PRs only: #1 green, #2 not (#3 never patched)
        ciGreenAfterPatchRate: 0.5,
        meanPatchCycles: 4 / 3,
      });
      expect(gr(rep, "alternate")).toEqual({
        prs: 1,
        repeatPatchRate: 1,
        ciGreenAfterPatchRate: 1,
        meanPatchCycles: 2,
      });
      expect(rep.counts.mixedPrs).toBe(1);
      expect(cost(rep, "default")?.meanCostUsd).toBeCloseTo(0.6, 5);
    });

    it("is absent for dev-task and null-valued without PR records", () => {
      const rows = [rawRun("a", "default", [mb(1)])];
      const dev = buildReport(REQUIRED_STEPS, build(rows));
      expect(dev.overall.patchGuardrails).toBeUndefined();
      expect(dev.counts.mixedPrs).toBeUndefined();
      const patch = buildReport(
        PATCH_REQUIRED_STEPS,
        build(rows, "patch"),
        undefined,
        "patch",
      );
      expect(patch.overall.patchGuardrails).toEqual({
        prs: 0,
        repeatPatchRate: null,
        ciGreenAfterPatchRate: null,
        meanPatchCycles: null,
      });
    });
  });
});
