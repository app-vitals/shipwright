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

  it("references a threshold of 3 or more consecutive cycles", () => {
    const hasThreshold = /\b3\b[^.]*consecutive|\bconsecutive\b[^.]*\b3\b/i.test(
      content,
    );
    expect(hasThreshold).toBe(true);
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
