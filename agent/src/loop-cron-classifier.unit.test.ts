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
});

// ─── resolveLoopPhaseToggles ────────────────────────────────────────────────

describe("resolveLoopPhaseToggles", () => {
  it("resolves four independent booleans 1:1 from the four named jobs' enabled states", () => {
    const jobs = [
      makeJob({ id: "1", name: "shipwright-dev-task", enabled: true }),
      makeJob({ id: "2", name: "shipwright-review", enabled: false }),
      makeJob({ id: "3", name: "shipwright-patch", enabled: true }),
      makeJob({ id: "4", name: "shipwright-deploy", enabled: false }),
    ];
    const toggles = resolveLoopPhaseToggles(jobs);
    expect(toggles).toEqual({
      devTask: true,
      review: false,
      patch: true,
      deploy: false,
    });
  });

  it("returns false for a phase whose job is absent", () => {
    const jobs = [
      makeJob({ id: "1", name: "shipwright-dev-task", enabled: true }),
    ];
    const toggles = resolveLoopPhaseToggles(jobs);
    expect(toggles).toEqual({
      devTask: true,
      review: false,
      patch: false,
      deploy: false,
    });
  });

  it("all phases independently on is a valid, correctly-resolved combination", () => {
    const jobs = [
      makeJob({ id: "1", name: "shipwright-dev-task", enabled: true }),
      makeJob({ id: "2", name: "shipwright-review", enabled: true }),
      makeJob({ id: "3", name: "shipwright-patch", enabled: true }),
      makeJob({ id: "4", name: "shipwright-deploy", enabled: true }),
    ];
    const toggles = resolveLoopPhaseToggles(jobs);
    expect(toggles).toEqual({
      devTask: true,
      review: true,
      patch: true,
      deploy: true,
    });
  });

  it("shipwright-review-patch's enabled state has no effect on the output — identical toggles regardless of its presence/enabled state", () => {
    const baseJobs = [
      makeJob({ id: "1", name: "shipwright-dev-task", enabled: true }),
      makeJob({ id: "2", name: "shipwright-review", enabled: false }),
      makeJob({ id: "3", name: "shipwright-patch", enabled: true }),
      makeJob({ id: "4", name: "shipwright-deploy", enabled: false }),
    ];

    const withReviewPatchEnabled = [
      ...baseJobs,
      makeJob({ id: "rp-1", name: "shipwright-review-patch", enabled: true }),
    ];
    const withReviewPatchDisabled = [
      ...baseJobs,
      makeJob({ id: "rp-2", name: "shipwright-review-patch", enabled: false }),
    ];
    const withoutReviewPatch = [...baseJobs];

    const togglesA = resolveLoopPhaseToggles(withReviewPatchEnabled);
    const togglesB = resolveLoopPhaseToggles(withReviewPatchDisabled);
    const togglesC = resolveLoopPhaseToggles(withoutReviewPatch);

    expect(togglesA).toEqual(togglesB);
    expect(togglesB).toEqual(togglesC);
    expect(togglesA).toEqual({
      devTask: true,
      review: false,
      patch: true,
      deploy: false,
    });
  });
});
