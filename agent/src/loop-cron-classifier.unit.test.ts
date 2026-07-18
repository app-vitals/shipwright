/**
 * agent/src/loop-cron-classifier.unit.test.ts
 *
 * Unit tests for classifyCronJobsForScheduling() and
 * resolveLoopPhaseToggles() — pure logic, no I/O.
 */

import { describe, expect, it } from "bun:test";
import {
  type CronJobLike,
  classifyCronJobsForScheduling,
  resolveLoopPhaseToggles,
} from "./loop-cron-classifier.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<CronJobLike> = {}): CronJobLike {
  return {
    id: "job-1",
    name: "some-job",
    enabled: true,
    parentCronId: null,
    ...overrides,
  };
}

const PIPELINE_NAMES = [
  "shipwright-dev-task",
  "shipwright-review",
  "shipwright-patch",
  "shipwright-review-patch",
  "shipwright-deploy",
] as const;

function makePipelineJobs(enabled = true): CronJobLike[] {
  return PIPELINE_NAMES.map((name, i) =>
    makeJob({ id: `pipeline-${i}`, name, enabled }),
  );
}

// ─── classifyCronJobsForScheduling ─────────────────────────────────────────────

describe("classifyCronJobsForScheduling", () => {
  it("unmigrated agent: no shipwright-loop job — all enabled jobs including the 5 pipeline jobs get dispatch: generic", () => {
    const jobs = [
      ...makePipelineJobs(true),
      makeJob({
        id: "daily-1",
        name: "shipwright-test-readiness",
        enabled: true,
      }),
    ];
    const result = classifyCronJobsForScheduling(jobs);
    expect(result).toHaveLength(jobs.length);
    for (const entry of result) {
      expect(entry.dispatch).toBe("generic");
    }
    const ids = result.map((r) => r.job.id);
    for (const job of jobs) {
      expect(ids).toContain(job.id);
    }
  });

  it("unmigrated agent: shipwright-loop present but disabled — behaves identically to absent (all pipeline jobs still generic, loop itself excluded since disabled)", () => {
    const jobs = [
      makeJob({ id: "loop-1", name: "shipwright-loop", enabled: false }),
      ...makePipelineJobs(true),
    ];
    const result = classifyCronJobsForScheduling(jobs);
    // loop job is disabled -> never included
    expect(result.some((r) => r.job.id === "loop-1")).toBe(false);
    // all 5 pipeline jobs included as generic
    const pipelineResults = result.filter((r) =>
      PIPELINE_NAMES.includes(r.job.name as (typeof PIPELINE_NAMES)[number]),
    );
    expect(pipelineResults).toHaveLength(5);
    for (const entry of pipelineResults) {
      expect(entry.dispatch).toBe("generic");
    }
  });

  it("migrated agent: shipwright-loop present and enabled — the 5 pipeline jobs are excluded entirely, loop itself is included with dispatch: loop", () => {
    const jobs = [
      makeJob({ id: "loop-1", name: "shipwright-loop", enabled: true }),
      ...makePipelineJobs(true),
    ];
    const result = classifyCronJobsForScheduling(jobs);

    const loopEntry = result.find((r) => r.job.id === "loop-1");
    expect(loopEntry).toBeDefined();
    expect(loopEntry?.dispatch).toBe("loop");

    for (const name of PIPELINE_NAMES) {
      const found = result.find((r) => r.job.name === name);
      expect(found).toBeUndefined();
    }
  });

  it("migrated agent: any other enabled job (e.g. a daily cron) still gets dispatch: generic", () => {
    const jobs = [
      makeJob({ id: "loop-1", name: "shipwright-loop", enabled: true }),
      ...makePipelineJobs(true),
      makeJob({
        id: "daily-1",
        name: "shipwright-test-readiness",
        enabled: true,
      }),
    ];
    const result = classifyCronJobsForScheduling(jobs);
    const dailyEntry = result.find((r) => r.job.id === "daily-1");
    expect(dailyEntry).toBeDefined();
    expect(dailyEntry?.dispatch).toBe("generic");
  });

  it("disabled jobs (other than shipwright-loop, already covered) are never included, loop-enabled or not", () => {
    const disabledPipeline = makePipelineJobs(false);

    const unmigratedResult = classifyCronJobsForScheduling(disabledPipeline);
    expect(unmigratedResult).toHaveLength(0);

    const migratedJobs = [
      makeJob({ id: "loop-1", name: "shipwright-loop", enabled: true }),
      ...disabledPipeline,
    ];
    const migratedResult = classifyCronJobsForScheduling(migratedJobs);
    // Only the loop job itself should be present
    expect(migratedResult).toHaveLength(1);
    expect(migratedResult[0]?.job.id).toBe("loop-1");
  });

  it("a job with name: null never matches a special-cased name and falls through to generic when enabled", () => {
    const jobs = [
      makeJob({ id: "loop-1", name: "shipwright-loop", enabled: true }),
      makeJob({ id: "null-name", name: null, enabled: true }),
    ];
    const result = classifyCronJobsForScheduling(jobs);
    const nullEntry = result.find((r) => r.job.id === "null-name");
    expect(nullEntry).toBeDefined();
    expect(nullEntry?.dispatch).toBe("generic");
  });

  it("a job with parentCronId set and enabled: true is excluded regardless of shipwright-loop being absent", () => {
    const jobs = [
      makeJob({
        id: "parented-1",
        name: "some-child-job",
        enabled: true,
        parentCronId: "parent-1",
      }),
    ];
    const result = classifyCronJobsForScheduling(jobs);
    expect(result.some((r) => r.job.id === "parented-1")).toBe(false);
  });

  it("a job with parentCronId set and enabled: true is excluded regardless of shipwright-loop being present and disabled", () => {
    const jobs = [
      makeJob({ id: "loop-1", name: "shipwright-loop", enabled: false }),
      makeJob({
        id: "parented-1",
        name: "some-child-job",
        enabled: true,
        parentCronId: "parent-1",
      }),
    ];
    const result = classifyCronJobsForScheduling(jobs);
    expect(result.some((r) => r.job.id === "parented-1")).toBe(false);
  });

  it("a job with parentCronId set and enabled: true is excluded regardless of shipwright-loop being present and enabled", () => {
    const jobs = [
      makeJob({ id: "loop-1", name: "shipwright-loop", enabled: true }),
      makeJob({
        id: "parented-1",
        name: "some-child-job",
        enabled: true,
        parentCronId: "parent-1",
      }),
    ];
    const result = classifyCronJobsForScheduling(jobs);
    expect(result.some((r) => r.job.id === "parented-1")).toBe(false);
  });

  it("a parented job with enabled: false is still excluded (belt-and-suspenders with the pre-existing disabled check)", () => {
    const jobs = [
      makeJob({
        id: "parented-disabled",
        name: "some-child-job",
        enabled: false,
        parentCronId: "parent-1",
      }),
    ];
    const result = classifyCronJobsForScheduling(jobs);
    expect(result.some((r) => r.job.id === "parented-disabled")).toBe(false);
  });

  it("a same-agent top-level cron (parentCronId: null, enabled: true, arbitrary name) is NOT excluded — no regression", () => {
    const jobs = [
      makeJob({
        id: "top-level-1",
        name: "some-arbitrary-cron",
        enabled: true,
        parentCronId: null,
      }),
    ];
    const result = classifyCronJobsForScheduling(jobs);
    const entry = result.find((r) => r.job.id === "top-level-1");
    expect(entry).toBeDefined();
    expect(entry?.dispatch).toBe("generic");
  });
});

// ─── resolveLoopPhaseToggles ────────────────────────────────────────────────

describe("resolveLoopPhaseToggles", () => {
  const LOOP_ID = "loop-1";

  it("resolves four independent booleans 1:1 from the four named child rows' enabled states (parentCronId = loop id)", () => {
    const jobs = [
      makeJob({
        id: "1",
        name: "shipwright-dev-task",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
      makeJob({
        id: "2",
        name: "shipwright-review",
        enabled: false,
        parentCronId: LOOP_ID,
      }),
      makeJob({
        id: "3",
        name: "shipwright-patch",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
      makeJob({
        id: "4",
        name: "shipwright-deploy",
        enabled: false,
        parentCronId: LOOP_ID,
      }),
    ];
    const toggles = resolveLoopPhaseToggles(jobs, LOOP_ID);
    expect(toggles).toEqual({
      devTask: true,
      review: false,
      patch: true,
      deploy: false,
    });
  });

  it("returns false for a phase whose child row is absent", () => {
    const jobs = [
      makeJob({
        id: "1",
        name: "shipwright-dev-task",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
    ];
    const toggles = resolveLoopPhaseToggles(jobs, LOOP_ID);
    expect(toggles).toEqual({
      devTask: true,
      review: false,
      patch: false,
      deploy: false,
    });
  });

  it("all phases independently on is a valid, correctly-resolved combination", () => {
    const jobs = [
      makeJob({
        id: "1",
        name: "shipwright-dev-task",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
      makeJob({
        id: "2",
        name: "shipwright-review",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
      makeJob({
        id: "3",
        name: "shipwright-patch",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
      makeJob({
        id: "4",
        name: "shipwright-deploy",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
    ];
    const toggles = resolveLoopPhaseToggles(jobs, LOOP_ID);
    expect(toggles).toEqual({
      devTask: true,
      review: true,
      patch: true,
      deploy: true,
    });
  });

  it("shipwright-review-patch's enabled state has no effect on the output — identical toggles regardless of its presence/enabled state", () => {
    const baseJobs = [
      makeJob({
        id: "1",
        name: "shipwright-dev-task",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
      makeJob({
        id: "2",
        name: "shipwright-review",
        enabled: false,
        parentCronId: LOOP_ID,
      }),
      makeJob({
        id: "3",
        name: "shipwright-patch",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
      makeJob({
        id: "4",
        name: "shipwright-deploy",
        enabled: false,
        parentCronId: LOOP_ID,
      }),
    ];

    const withReviewPatchEnabled = [
      ...baseJobs,
      makeJob({
        id: "rp-1",
        name: "shipwright-review-patch",
        enabled: true,
        parentCronId: LOOP_ID,
      }),
    ];
    const withReviewPatchDisabled = [
      ...baseJobs,
      makeJob({
        id: "rp-2",
        name: "shipwright-review-patch",
        enabled: false,
        parentCronId: LOOP_ID,
      }),
    ];
    const withoutReviewPatch = [...baseJobs];

    const togglesA = resolveLoopPhaseToggles(withReviewPatchEnabled, LOOP_ID);
    const togglesB = resolveLoopPhaseToggles(withReviewPatchDisabled, LOOP_ID);
    const togglesC = resolveLoopPhaseToggles(withoutReviewPatch, LOOP_ID);

    expect(togglesA).toEqual(togglesB);
    expect(togglesB).toEqual(togglesC);
    expect(togglesA).toEqual({
      devTask: true,
      review: false,
      patch: true,
      deploy: false,
    });
  });

  it("ignores a top-level job (parentCronId: null) with a matching phase name — not a child of the loop", () => {
    const jobs = [
      makeJob({ id: "loop-1", name: "shipwright-loop", enabled: true }),
      makeJob({
        id: "top-level-dev-task",
        name: "shipwright-dev-task",
        enabled: true,
        parentCronId: null,
      }),
    ];
    const toggles = resolveLoopPhaseToggles(jobs, LOOP_ID);
    expect(toggles).toEqual({
      devTask: false,
      review: false,
      patch: false,
      deploy: false,
    });
  });

  it("ignores a child row under a different parent even when the name matches (e.g. a future multi-loop-per-agent scenario, or leftover unreconciled rows)", () => {
    const jobs = [
      makeJob({
        id: "other-loop-dev-task",
        name: "shipwright-dev-task",
        enabled: true,
        parentCronId: "some-other-loop-id",
      }),
    ];
    const toggles = resolveLoopPhaseToggles(jobs, LOOP_ID);
    expect(toggles).toEqual({
      devTask: false,
      review: false,
      patch: false,
      deploy: false,
    });
  });

  it("soft-fail: an agent with no child rows at all (pre-LPC-1.2-reconcile state) resolves all four toggles to false, not an error", () => {
    const jobs = [
      makeJob({ id: "loop-1", name: "shipwright-loop", enabled: true }),
      makeJob({
        id: "top-level-dev-task",
        name: "shipwright-dev-task",
        enabled: true,
        parentCronId: null,
      }),
      makeJob({
        id: "top-level-review",
        name: "shipwright-review",
        enabled: true,
        parentCronId: null,
      }),
    ];
    expect(() => resolveLoopPhaseToggles(jobs, LOOP_ID)).not.toThrow();
    const toggles = resolveLoopPhaseToggles(jobs, LOOP_ID);
    expect(toggles).toEqual({
      devTask: false,
      review: false,
      patch: false,
      deploy: false,
    });
  });
});
