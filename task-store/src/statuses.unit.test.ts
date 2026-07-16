/**
 * task-store/src/statuses.unit.test.ts
 *
 * Direct unit coverage of the CLOSED_STATUSES / OPEN_STATUSES contract:
 * exact membership, mutual exclusivity, and exhaustiveness against the
 * canonical status vocabulary defined by the `TaskStatus` enum in
 * task-store/prisma/schema.prisma. No I/O — pure data assertions only.
 */

import { describe, expect, it } from "bun:test";
import { CLOSED_STATUSES, OPEN_STATUSES } from "./statuses.ts";

// The full canonical status vocabulary, mirrored from the `TaskStatus` enum
// in task-store/prisma/schema.prisma. Kept as a literal list (not imported)
// so this test independently grounds the contract against the schema rather
// than trusting statuses.ts's own values.
const ALL_KNOWN_STATUSES = [
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
] as const;

describe("CLOSED_STATUSES", () => {
  it("contains exactly the terminal statuses (order-independent)", () => {
    expect(Array.from<string>(CLOSED_STATUSES).sort()).toEqual(
      ["merged", "done", "deploying", "deployed", "cancelled"].sort(),
    );
  });

  it("has length 5", () => {
    expect(CLOSED_STATUSES.length).toBe(5);
  });

  it("has no duplicate entries", () => {
    expect(new Set(CLOSED_STATUSES).size).toBe(CLOSED_STATUSES.length);
  });
});

describe("OPEN_STATUSES", () => {
  it("contains exactly the open statuses (order-independent)", () => {
    expect(Array.from<string>(OPEN_STATUSES).sort()).toEqual(
      ["pending", "in_progress", "pr_open", "approved", "blocked"].sort(),
    );
  });

  it("has length 5", () => {
    expect(OPEN_STATUSES.length).toBe(5);
  });

  it("has no duplicate entries", () => {
    expect(new Set(OPEN_STATUSES).size).toBe(OPEN_STATUSES.length);
  });
});

describe("CLOSED_STATUSES / OPEN_STATUSES contract", () => {
  it("does not overlap: no status appears in both sets (mutual exclusivity)", () => {
    const closedSet = new Set<string>(CLOSED_STATUSES);
    const overlap = OPEN_STATUSES.filter((status) => closedSet.has(status));
    expect(overlap).toEqual([]);
  });

  it("the union of both sets equals the full known status vocabulary (exhaustiveness)", () => {
    const union = new Set<string>([...CLOSED_STATUSES, ...OPEN_STATUSES]);
    expect(union.size).toBe(ALL_KNOWN_STATUSES.length);
    expect([...union].sort()).toEqual([...ALL_KNOWN_STATUSES].sort());
  });

  it("every known status is classified as either open or closed, and never both", () => {
    const closedSet = new Set<string>(CLOSED_STATUSES);
    const openSet = new Set<string>(OPEN_STATUSES);

    for (const status of ALL_KNOWN_STATUSES) {
      const isClosed = closedSet.has(status);
      const isOpen = openSet.has(status);
      // Exactly one of isClosed/isOpen must be true — an exhaustive,
      // mutually exclusive partition.
      expect(isClosed !== isOpen).toBe(true);
    }
  });

  it("combined length equals the full known status vocabulary length", () => {
    expect(CLOSED_STATUSES.length + OPEN_STATUSES.length).toBe(
      ALL_KNOWN_STATUSES.length,
    );
  });
});

describe("array independence", () => {
  it("mutating a copy of CLOSED_STATUSES does not affect the exported array", () => {
    const copy: string[] = [...CLOSED_STATUSES];
    copy.push("something-else");
    expect(CLOSED_STATUSES.length).toBe(5);
    expect(CLOSED_STATUSES).not.toContain("something-else");
  });

  it("mutating a copy of OPEN_STATUSES does not affect the exported array", () => {
    const copy: string[] = [...OPEN_STATUSES];
    copy.push("something-else");
    expect(OPEN_STATUSES.length).toBe(5);
    expect(OPEN_STATUSES).not.toContain("something-else");
  });
});
