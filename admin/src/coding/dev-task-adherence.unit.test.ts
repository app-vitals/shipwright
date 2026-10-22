import { describe, expect, it } from "bun:test";
import {
  ADHERENCE_DISCLAIMER,
  buildReport,
  buildRunAdherence,
  DevTaskAdherenceService,
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
    expect(status("6")).toBe("unmeasured");
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
    const step6 = report.overall.steps.find((s) => s.stepNumber === "6");
    expect(step6).toMatchObject({ measured: false, rate: null });
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
        report.overall.steps.find((s) => s.stepNumber === "6")?.measured,
      ).toBe(false);
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

    it("behaves as before with no fetchers", async () => {
      const report = await new DevTaskAdherenceService(prisma).report();
      expect(
        report.runs[0]?.steps.find((s) => s.stepNumber === "9")?.status,
      ).toBe("unmeasured");
    });
  });
});
