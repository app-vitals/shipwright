import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEARNINGS_PATH = join(import.meta.dir, "pipeline-learnings.md");
const SKILL_PATH = join(import.meta.dir, "..", "SKILL.md");

let learnings: string;
let skill: string;

beforeAll(() => {
  learnings = readFileSync(LEARNINGS_PATH, "utf-8");
  skill = readFileSync(SKILL_PATH, "utf-8");
});

describe("pipeline-learnings.md — purpose and structure", () => {
  it("has an intro explaining what the file is and when to consult/append it", () => {
    expect(learnings).toMatch(/^# /m);
    expect(learnings).toMatch(/consult|append|before|during/i);
  });

  it("has a dated, repo-attributed entry for shipwright", () => {
    expect(learnings).toMatch(/##\s*.*shipwright/i);
    expect(learnings).toContain("2026-07-15");
  });
});

describe("pipeline-learnings.md — captured lessons from this run", () => {
  it("captures the doc-anchor staleness lesson", () => {
    expect(learnings).toContain("test-migration.md");
    expect(learnings).toMatch(
      /doesn't exist|does not exist|not guaranteed|didn't exist|neither file existed/i,
    );
  });

  it("captures the verification-command repo-specific adjustment lesson", () => {
    expect(learnings).toMatch(/workflow file/i);
    expect(learnings).toMatch(/job name/i);
  });

  it("captures the sandbox coverage-gate false-failure lesson", () => {
    expect(learnings).toMatch(/coverage gate/i);
    expect(learnings).toMatch(/sandbox/i);
  });

  it("captures the task-ID collision-across-repos lesson", () => {
    expect(learnings).toMatch(/task[-\s]?id/i);
    expect(learnings).toMatch(/collision/i);
  });
});

describe("SKILL.md — references pipeline-learnings.md", () => {
  it("points to references/pipeline-learnings.md", () => {
    expect(skill).toContain("references/pipeline-learnings.md");
  });
});
