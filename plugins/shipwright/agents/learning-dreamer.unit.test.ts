import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR = import.meta.dir;
const LEARNING_DREAMER_PATH = join(AGENT_DIR, "learning-dreamer.md");

let dreamerContent: string;
let miningTableSection: string;
let reviewModeSection: string;

// Helper: extract a section of the file between two headings
function extractSection(content: string, startHeading: string, endHeading: string): string {
  const startIdx = content.indexOf(startHeading);
  const endIdx = content.indexOf(endHeading, startIdx + startHeading.length);
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) return "";
  return content.slice(startIdx, endIdx);
}

// Helper: extract lines mentioning person/agent from the mining table
function personAgentRowText(section: string): string {
  return section
    .split("\n")
    .filter((line) => /person|agent/i.test(line))
    .join("\n");
}

beforeAll(() => {
  dreamerContent = readFileSync(LEARNING_DREAMER_PATH, "utf-8");
  miningTableSection = extractSection(dreamerContent, "## What to mine for", "## The gate");
  reviewModeSection = extractSection(dreamerContent, "### Review mode", "### Apply mode");
});

describe("learning-dreamer.md — mining table", () => {
  it("has a mining table with a person/agent row", () => {
    expect(miningTableSection).not.toBe("");
    expect(personAgentRowText(miningTableSection)).not.toBe("");
  });

  it("person/agent mining row does not mention CLAUDE.md", () => {
    expect(personAgentRowText(miningTableSection).toLowerCase()).not.toContain("claude.md");
  });

  it("person/agent mining row references the memory system or workspace/LEARNINGS.md", () => {
    const rowText = personAgentRowText(miningTableSection);
    const hasMemoryReference = rowText.includes("memory") || rowText.includes("LEARNINGS.md");
    expect(hasMemoryReference).toBe(true);
  });
});

describe("learning-dreamer.md — LEARNINGS-REVIEW.md example template", () => {
  it("contains a Memory section in the example LEARNINGS-REVIEW.md template", () => {
    expect(reviewModeSection).toContain("## Memory");
  });

  it("Memory section example includes citation format 'Seen in'", () => {
    const memorySection = extractSection(reviewModeSection, "## Memory", "## Harness");
    expect(memorySection).toContain("Seen in");
  });

  it("Memory section appears alongside Add, Edit, Remove sections", () => {
    expect(reviewModeSection).toContain("## Add");
    expect(reviewModeSection).toContain("## Edit");
    expect(reviewModeSection).toContain("## Remove");
    expect(reviewModeSection).toContain("## Memory");
  });
});
