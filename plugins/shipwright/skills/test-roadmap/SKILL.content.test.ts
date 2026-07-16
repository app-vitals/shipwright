import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

let content: string;

beforeAll(() => {
  if (existsSync(SKILL_MD_PATH)) {
    content = readFileSync(SKILL_MD_PATH, "utf-8");
  } else {
    content = "";
  }
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
  it("has frontmatter with name: test-roadmap", () => {
    expect(content).toContain("name: test-roadmap");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — E2E classification guardrail", () => {
  it("mentions the E2E classification guardrail in the Process section", () => {
    expect(content).toContain("E2E classification guardrail");
  });

  it("references test-system.md's Classifying a new test section", () => {
    expect(content).toContain("test-system.md");
    expect(content).toContain("Classifying a new test");
  });

  it("states that tasks with layer: e2e must be verified against the classification rule", () => {
    const hasE2eCheck =
      content.includes("layer: e2e") &&
      (content.includes("verify") ||
        content.includes("Verify") ||
        content.includes("check"));
    expect(hasE2eCheck).toBe(true);
  });

  it("mentions that e2e tasks must exercise a real browser", () => {
    expect(content).toContain("multi-step browser flow");
  });

  it("requires downgrading non-browser flows to integration or smoke", () => {
    const hasDowngrade =
      (content.includes("downgrade") ||
        content.includes("Downgrade") ||
        content.includes("downgraded")) &&
      (content.includes("integration") || content.includes("smoke"));
    expect(hasDowngrade).toBe(true);
  });

  it("mentions explaining the downgrade reason in a note", () => {
    const hasNote =
      content.includes("note") ||
      content.includes("Note") ||
      content.includes("explain") ||
      content.includes("Explain");
    expect(hasNote).toBe(true);
  });
});
