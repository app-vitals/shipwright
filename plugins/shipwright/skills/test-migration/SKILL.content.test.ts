import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  content = existsSync(SKILL_MD_PATH)
    ? readFileSync(SKILL_MD_PATH, "utf-8")
    : "";
});

describe("SKILL.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("SKILL.md — frontmatter", () => {
  it("has frontmatter with name: test-migration", () => {
    expect(content).toContain("name: test-migration");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — Failure modes: measurement-only items carried forward across cycles", () => {
  it("has a Failure modes to avoid section", () => {
    expect(content).toContain("## Failure modes to avoid");
  });

  it("has a bullet about carried-forward measurement-only items", () => {
    const failureModesIdx = content.indexOf("## Failure modes to avoid");
    expect(failureModesIdx).toBeGreaterThan(-1);
    const section = content.slice(failureModesIdx);
    const hasCarryoverBullet =
      /carried forward/i.test(section) && /measurement-only/i.test(section);
    expect(hasCarryoverBullet).toBe(true);
  });

  it("gates mandatory M1 escalation on an actual Tier-1 budget breach, not a bare cycle count", () => {
    const failureModesIdx = content.indexOf("## Failure modes to avoid");
    expect(failureModesIdx).toBeGreaterThan(-1);
    const section = content.slice(failureModesIdx);
    const hasTier1BreachGate =
      /Tier[\s-]?1/i.test(section) && /budget breach/i.test(section);
    expect(hasTier1BreachGate).toBe(true);
  });

  it("references speed-budgets' escalation formula rather than a bare cycle-count threshold", () => {
    const failureModesIdx = content.indexOf("## Failure modes to avoid");
    const section = content.slice(failureModesIdx);
    expect(section).toContain("speed-budgets");
    expect(section).toMatch(/escalation formula/i);
  });

  it("does not gate mandatory M1 escalation on persistence across cycles alone", () => {
    const failureModesIdx = content.indexOf("## Failure modes to avoid");
    const section = content.slice(failureModesIdx);
    const hasBareCycleCountGate =
      /\b3\b[^.]*consecutive|\bconsecutive\b[^.]*\b3\b/i.test(section);
    expect(hasBareCycleCountGate).toBe(false);
  });

  it("requires test-roadmap to place the item as the first/mandatory M1 task by construction", () => {
    const hasByConstruction =
      /test-roadmap/i.test(content) &&
      /by construction/i.test(content) &&
      (content.includes("first") || /\bM1\b/.test(content)) &&
      /Milestone 1|M1/.test(content);
    expect(hasByConstruction).toBe(true);
  });

  it("does not rely on the roadmap author noticing the streak in prose", () => {
    expect(content).toMatch(/not rely on the roadmap author noticing/i);
  });

  it("distinguishes a measurement-only item from a test file", () => {
    const hasDistinction =
      /measurement-only/i.test(content) && /not a test file/i.test(content);
    expect(hasDistinction).toBe(true);
  });

  it("does not name a specific dependent repo", () => {
    // Concatenated (not a literal) so this assertion string itself doesn't
    // trip the repo's own banned-string scan — see check-banned-strings.ts.
    const bannedRepoName = "vitals-" + "os";
    expect(content.toLowerCase()).not.toContain(bannedRepoName);
  });

  it("does not use dated/cycle-specific framing (e.g. 'this cycle')", () => {
    expect(content.toLowerCase()).not.toContain("this cycle");
  });
});

describe("SKILL.md — Step 4c: sourcing coverage percentages", () => {
  const step4cIdx = () => content.indexOf("Step 4c");
  const step4cSection = () => {
    const idx = step4cIdx();
    expect(idx).toBeGreaterThan(-1);
    // Slice to the next top-level (### ) or Step 5 heading, whichever comes first.
    const rest = content.slice(idx);
    const nextHeadingMatch = rest.slice(1).match(/\n#{2,3}\s/);
    return nextHeadingMatch && nextHeadingMatch.index !== undefined
      ? rest.slice(0, nextHeadingMatch.index + 1)
      : rest;
  };

  it("has a Step 4c heading", () => {
    expect(step4cIdx()).toBeGreaterThan(-1);
  });

  it("states it is mandatory and always runs on every /test-migration invocation", () => {
    const section = step4cSection();
    expect(/mandatory/i.test(section)).toBe(true);
    expect(/\/test-migration/i.test(section)).toBe(true);
    expect(/always/i.test(section)).toBe(true);
  });

  it("mentions line_coverage_pct and function_coverage_pct", () => {
    const section = step4cSection();
    expect(section).toContain("line_coverage_pct");
    expect(section).toContain("function_coverage_pct");
  });

  it("mentions feature_coverage_pct and carrying it forward from test-inventory", () => {
    const section = step4cSection();
    expect(section).toContain("feature_coverage_pct");
    expect(/carr(y|ied|ying) forward/i.test(section)).toBe(true);
    expect(section).toContain("test-inventory.md");
  });

  it("requires citing the CI run URL and commit as the source", () => {
    const section = step4cSection();
    expect(/CI run/i.test(section)).toBe(true);
    expect(/URL/i.test(section)).toBe(true);
    expect(/commit/i.test(section)).toBe(true);
    expect(/cite/i.test(section)).toBe(true);
  });

  it("references the test:coverage CI step and its Lines/Functions summary output", () => {
    const section = step4cSection();
    expect(section).toContain("test:coverage");
    expect(/Lines:/.test(section)).toBe(true);
    expect(/Functions:/.test(section)).toBe(true);
  });

  it("contains the never-guess idiom", () => {
    const section = step4cSection();
    expect(/never guess/i.test(section)).toBe(true);
  });

  it("states unavailable values are null rather than guessed/estimated", () => {
    const section = step4cSection();
    expect(section).toContain("null");
    expect(/guess|estimat/i.test(section)).toBe(true);
  });
});
