import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RESEARCH_MD_PATH = join(import.meta.dir, "research.md");

let content: string;

beforeAll(() => {
  content = readFileSync(RESEARCH_MD_PATH, "utf-8");
});

function extractStep2Section(source: string): string {
  const match = source.match(/## Step 2: Launch Research Agent[\s\S]*?(?=\n## Step 3)/);
  if (!match) {
    throw new Error("Could not find Step 2 section in research.md");
  }
  return match[0];
}

describe("research.md — Step 2 dispatch pins run_in_background: false (ABD-1.5)", () => {
  it("pins run_in_background: false on the Agent tool dispatch", () => {
    const step2Section = extractStep2Section(content);
    expect(step2Section).toContain("run_in_background: false");
  });
});
