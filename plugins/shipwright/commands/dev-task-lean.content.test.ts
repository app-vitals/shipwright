import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LEAN_PATH = join(import.meta.dir, "dev-task-lean.md");
const REQUIRED_STEPS_PATH = join(
  import.meta.dir,
  "..",
  "references",
  "required-steps",
  "dev-task.json",
);
const lean = readFileSync(LEAN_PATH, "utf-8");
const steps = JSON.parse(readFileSync(REQUIRED_STEPS_PATH, "utf-8")).steps as {
  stepNumber: string;
  title: string;
  mandatory: boolean;
}[];

describe("dev-task-lean.md — required steps", () => {
  for (const step of steps) {
    it(`names step ${step.stepNumber} (${step.title})`, () => {
      expect(lean).toContain(`## Step ${step.stepNumber}: ${step.title}`);
    });
  }

  it("gives every mandatory step a Proof line", () => {
    for (const step of steps.filter((s) => s.mandatory)) {
      const start = lean.indexOf(`## Step ${step.stepNumber}:`);
      const next = lean.indexOf("\n## ", start + 1);
      expect(lean.slice(start, next)).toContain("**Proof:**");
    }
  });

  it("keeps the no-size-exemption rule and required task-id", () => {
    expect(lean).toMatch(/no size exemption/i);
    expect(lean).toContain('argument-hint: "<task-id>"');
  });
});

describe("dev-task-lean.md — links", () => {
  const links = [...lean.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map((m) => m[1]);

  it("links at least one reference file", () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it("every linked reference file exists", () => {
    for (const link of links) {
      expect(existsSync(resolve(dirname(LEAN_PATH), link))).toBe(true);
    }
  });
});
