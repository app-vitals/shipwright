/**
 * task-store/src/statuses.unit.test.ts
 *
 * Unit tests for the status constants, alias table, and normalize/validate
 * helpers shared across the task-store write paths.
 */

import { describe, expect, it } from "bun:test";
import {
  ALL_STATUSES,
  CLOSED_STATUSES,
  OPEN_STATUSES,
  isValidStatus,
  normalizeStatus,
} from "./statuses.ts";

// The canonical enum in prisma/schema.prisma — the source of truth ALL_STATUSES
// must mirror. Kept as a literal here so the test fails loudly if the two drift.
const PRISMA_TASK_STATUS = [
  "pending",
  "in_progress",
  "pr_open",
  "approved",
  "merged",
  "done",
  "deploying",
  "deployed",
  "blocked",
  "cancelled",
];

describe("ALL_STATUSES (unit)", () => {
  it("is the union of OPEN_STATUSES and CLOSED_STATUSES", () => {
    expect(ALL_STATUSES).toEqual([...OPEN_STATUSES, ...CLOSED_STATUSES]);
  });

  it("matches the TaskStatus enum in prisma/schema.prisma", () => {
    expect(([...ALL_STATUSES] as string[]).sort()).toEqual(
      [...PRISMA_TASK_STATUS].sort(),
    );
  });
});

describe("normalizeStatus (unit)", () => {
  it("maps the 'completed' alias to 'done'", () => {
    expect(normalizeStatus("completed")).toBe("done");
  });

  it("passes every canonical status through unchanged", () => {
    for (const status of ALL_STATUSES) {
      expect(normalizeStatus(status)).toBe(status);
    }
  });

  it("maps case and whitespace variants of the alias to 'done'", () => {
    expect(normalizeStatus("Completed")).toBe("done");
    expect(normalizeStatus("COMPLETED")).toBe("done");
    expect(normalizeStatus(" completed ")).toBe("done");
  });

  it("canonicalizes case and whitespace variants of canonical statuses", () => {
    expect(normalizeStatus("Done")).toBe("done");
    expect(normalizeStatus("IN_PROGRESS")).toBe("in_progress");
    expect(normalizeStatus(" pending ")).toBe("pending");
  });

  it("passes unknown values through trimmed/lowercased (validity is checked separately)", () => {
    expect(normalizeStatus("bogus")).toBe("bogus");
    expect(normalizeStatus(" BoGuS ")).toBe("bogus");
  });
});

describe("isValidStatus (unit)", () => {
  it("accepts every canonical status", () => {
    for (const status of ALL_STATUSES) {
      expect(isValidStatus(status)).toBe(true);
    }
  });

  it("rejects unknown and empty values", () => {
    expect(isValidStatus("bogus")).toBe(false);
    expect(isValidStatus("")).toBe(false);
  });

  it("rejects genuinely-unknown values even after normalization", () => {
    expect(isValidStatus(normalizeStatus("Totally-Bogus"))).toBe(false);
  });

  it("rejects the raw 'completed' alias — it must be normalized first", () => {
    expect(isValidStatus("completed")).toBe(false);
    expect(isValidStatus(normalizeStatus("completed"))).toBe(true);
  });
});
