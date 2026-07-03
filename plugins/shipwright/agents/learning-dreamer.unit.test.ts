import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR = import.meta.dir;
const LEARNING_DREAMER_PATH = join(AGENT_DIR, "learning-dreamer.md");

let dreamerContent: string;

beforeAll(() => {
  dreamerContent = readFileSync(LEARNING_DREAMER_PATH, "utf-8");
});

describe("learning-dreamer.md — mining table", () => {
  it("contains a mining table with person/agent row", () => {
    const hasPersonAgentRow =
      (dreamerContent.toLowerCase().includes("person") ||
        dreamerContent.toLowerCase().includes("recurring")) &&
      dreamerContent.includes("agent") &&
      (dreamerContent.includes("memory") ||
        dreamerContent.includes("LEARNINGS.md"));
    expect(hasPersonAgentRow).toBe(true);
  });

  it("person/agent mining row does not mention CLAUDE.md", () => {
    const miningTableStart = dreamerContent.indexOf("## What to mine for");
    const miningTableEnd = dreamerContent.indexOf("## The gate");

    expect(miningTableStart).toBeGreaterThan(-1);
    expect(miningTableEnd).toBeGreaterThan(miningTableStart);

    const miningTableSection = dreamerContent.substring(
      miningTableStart,
      miningTableEnd,
    );

    // Look for person/agent row specifically
    const hasPersonAgentPattern =
      miningTableSection.includes("Person") && miningTableSection.includes("agent");

    if (hasPersonAgentPattern) {
      // Extract lines that mention person/agent to verify they don't mention CLAUDE.md
      const lines = miningTableSection.split("\n");
      let personAgentRowText = "";

      for (const line of lines) {
        if (line.includes("person") || line.includes("Person") || line.includes("agent")) {
          personAgentRowText += line + "\n";
        }
      }

      expect(personAgentRowText.toLowerCase()).not.toContain("claude.md");
    }
  });

  it("person/agent mining row references memory system or workspace/LEARNINGS.md", () => {
    const miningTableStart = dreamerContent.indexOf("## What to mine for");
    const miningTableEnd = dreamerContent.indexOf("## The gate");

    const miningTableSection = dreamerContent.substring(
      miningTableStart,
      miningTableEnd,
    );

    const lines = miningTableSection.split("\n");
    let personAgentRowText = "";

    for (const line of lines) {
      if (line.includes("person") || line.includes("Person") || line.includes("agent")) {
        personAgentRowText += line + "\n";
      }
    }

    const hasMemoryReference =
      personAgentRowText.includes("memory") ||
      personAgentRowText.includes("LEARNINGS.md");

    expect(hasMemoryReference).toBe(true);
  });
});

describe("learning-dreamer.md — LEARNINGS-REVIEW.md example template", () => {
  it("contains Memory section in example LEARNINGS-REVIEW.md template", () => {
    const reviewModeStart = dreamerContent.indexOf("### Review mode");
    const reviewModeEnd = dreamerContent.indexOf("### Apply mode");

    expect(reviewModeStart).toBeGreaterThan(-1);
    expect(reviewModeEnd).toBeGreaterThan(reviewModeStart);

    const reviewModeSection = dreamerContent.substring(reviewModeStart, reviewModeEnd);

    const hasMemorySection = reviewModeSection.includes("## Memory");

    expect(hasMemorySection).toBe(true);
  });

  it("Memory section example includes citation format 'Seen in'", () => {
    const reviewModeStart = dreamerContent.indexOf("### Review mode");
    const reviewModeEnd = dreamerContent.indexOf("### Apply mode");

    const reviewModeSection = dreamerContent.substring(reviewModeStart, reviewModeEnd);

    const memoryStart = reviewModeSection.indexOf("## Memory");
    expect(memoryStart).toBeGreaterThan(-1);

    // Extract from Memory section to next ## or end of code block
    const memoryEnd = Math.min(
      reviewModeSection.indexOf("## Harness", memoryStart) > -1
        ? reviewModeSection.indexOf("## Harness", memoryStart)
        : reviewModeSection.length,
      reviewModeSection.indexOf("```", memoryStart + 10),
    );

    const memorySection = reviewModeSection.substring(memoryStart, memoryEnd);

    const hasSeenInCitation = memorySection.includes("Seen in");

    expect(hasSeenInCitation).toBe(true);
  });

  it("Memory section appears alongside Add, Edit, Remove sections", () => {
    const reviewModeStart = dreamerContent.indexOf("### Review mode");
    const reviewModeEnd = dreamerContent.indexOf("### Apply mode");

    const reviewModeSection = dreamerContent.substring(reviewModeStart, reviewModeEnd);

    const hasAdd = reviewModeSection.includes("## Add");
    const hasEdit = reviewModeSection.includes("## Edit");
    const hasRemove = reviewModeSection.includes("## Remove");
    const hasMemory = reviewModeSection.includes("## Memory");

    expect(hasAdd && hasEdit && hasRemove && hasMemory).toBe(true);
  });
});
