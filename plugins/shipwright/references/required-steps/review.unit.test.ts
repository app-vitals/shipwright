import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REVIEW_JSON_PATH = join(import.meta.dir, "review.json");
const REVIEW_MD_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "commands",
  "review.md",
);

interface RequiredStep {
  stepNumber: string;
  title: string;
  mandatory: boolean;
  proofOfRunning: string;
  measurable: boolean;
  lane?: "any" | "review" | "conflict" | "ci";
}

const steps = (
  JSON.parse(readFileSync(REVIEW_JSON_PATH, "utf-8")) as {
    steps: RequiredStep[];
  }
).steps;
const byNumber = (n: string) => steps.find((s) => s.stepNumber === n);

describe("review.json — file structure and schema", () => {
  it("has a non-empty steps array", () => {
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });

  it("each step has stepNumber, title, mandatory, proofOfRunning, measurable, lane", () => {
    for (const step of steps) {
      expect(typeof step.stepNumber).toBe("string");
      expect(step.title.length).toBeGreaterThan(0);
      expect(typeof step.mandatory).toBe("boolean");
      expect(step.proofOfRunning.length).toBeGreaterThan(0);
      expect(typeof step.measurable).toBe("boolean");
      expect(["any", "review", "conflict", "ci"]).toContain(step.lane);
    }
  });
});

describe("review.json — measurable steps", () => {
  it("Step 7 is a measurable agent dispatch", () => {
    const step = byNumber("7");
    expect(step?.measurable).toBe(true);
    expect(step?.proofOfRunning.toLowerCase()).toContain("agent dispatch");
  });

  it("Step 11b is measurable via PR-record enrichment fields", () => {
    const step = byNumber("11b");
    expect(step?.measurable).toBe(true);
    for (const field of ["reviewState", "reviewedCommitSha", "agentId"]) {
      expect(step?.proofOfRunning).toContain(field);
    }
  });
});

describe("review.json — unmeasured steps", () => {
  it("steps 5, 6.1, 9.5, 10.5 are measurable: false with a 'marker needed' note", () => {
    for (const n of ["5", "6.1", "9.5", "10.5"]) {
      const step = byNumber(n);
      expect(step).toBeDefined();
      expect(step?.measurable).toBe(false);
      expect(step?.proofOfRunning.toLowerCase()).toContain("marker needed");
    }
  });
});

describe("review.json — every step is present in review.md", () => {
  it("each stepNumber appears as a '## Step N:' / '### Step N:' heading", () => {
    const md = readFileSync(REVIEW_MD_PATH, "utf-8");
    const missing = steps
      .map((s) => s.stepNumber)
      .filter(
        (n) =>
          !new RegExp(`^#{2,3} Step ${n.replace(/\./g, "\\.")}:`, "m").test(md),
      );
    expect(missing).toEqual([]);
  });
});
