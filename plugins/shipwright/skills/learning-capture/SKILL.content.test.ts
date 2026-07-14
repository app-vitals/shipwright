import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_PATH = join(import.meta.dir, "SKILL.md");

let skill: string;

beforeAll(() => {
  skill = readFileSync(SKILL_PATH, "utf-8");
});

// Helper: extract a section of the file between two headings
function extractSection(
  content: string,
  startHeading: string,
  endHeading: string,
): string {
  const startIdx = content.indexOf(startHeading);
  const endIdx = content.indexOf(endHeading);
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return "";
  return content.slice(startIdx, endIdx);
}

describe("SKILL.md — scope table and distinction notes", () => {
  it("has a Person / agent row in the scope table", () => {
    const section = extractSection(
      skill,
      "**Question 1 — what scope?**",
      "**Question 2 — instruction or skill?**",
    );
    expect(section).toContain("Person / agent");
  });

  it("Person / agent row references the harness memory system home", () => {
    const section = extractSection(
      skill,
      "**Question 1 — what scope?**",
      "**Question 2 — instruction or skill?**",
    );
    expect(section).toContain("~/.claude/projects");
    expect(section).toContain("memory");
  });

  it("Person / agent row references workspace/LEARNINGS.md as fallback", () => {
    const section = extractSection(
      skill,
      "**Question 1 — what scope?**",
      "**Question 2 — instruction or skill?**",
    );
    expect(section).toContain("workspace/LEARNINGS.md");
  });

  it("has a distinguishing note that mentions Person / agent and User", () => {
    const section = extractSection(
      skill,
      "**Question 1 — what scope?**",
      "**Question 2 — instruction or skill?**",
    );
    expect(section).toMatch(/Person\s*\/\s*agent.*User|User.*Person\s*\/\s*agent/is);
  });

  it("distinguishing note explains acting user vs facts about someone else", () => {
    const section = extractSection(
      skill,
      "**Question 1 — what scope?**",
      "**Question 2 — instruction or skill?**",
    );
    // Look for language that distinguishes "the person at the keyboard" from "facts about a specific individual"
    expect(section).toMatch(
      /acting\s+user|person\s+currently|keyboard|facts\s+about|specific\s+(person|individual|agent)/is,
    );
  });
});
