import { describe, expect, it } from "bun:test";
import {
  ADHERENCE_DISCLAIMER,
  buildReport,
  buildRunAdherence,
  DevTaskAdherenceService,
  ENRICHMENT_CONCURRENCY,
  mergeRunRows,
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
