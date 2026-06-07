import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PATCH_PATH = join(import.meta.dir, "patch.md");

let patch: string;

beforeAll(() => {
  patch = readFileSync(PATCH_PATH, "utf-8");
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

describe("patch.md — toolchain detection steps present", () => {
  it("has toolchain detection between Step 5a and Step 5b (Step 5a.5)", () => {
    const section = extractSection(patch, "### Step 5a:", "### Step 5b:");
    expect(section).toContain("### Step 5a.5: Detect Project Toolchain");
  });

  it("has toolchain detection between Step 6a and Step 6b (Step 6a.5)", () => {
    const section = extractSection(patch, "### Step 6a:", "### Step 6b:");
    expect(section).toContain("### Step 6a.5: Detect Project Toolchain");
  });

  it("has toolchain detection between Step 7a and Step 7b (Step 7a.5)", () => {
    const section = extractSection(patch, "### Step 7a:", "### Step 7b:");
    expect(section).toContain("### Step 7a.5: Detect Project Toolchain");
  });

  it("references toolchain-patterns.md in the Step 5a.5 detection step", () => {
    const section = extractSection(patch, "### Step 5a.5:", "### Step 5b:");
    expect(section).toContain("toolchain-patterns.md");
  });

  it("references toolchain-patterns.md in the Step 6a.5 detection step", () => {
    const section = extractSection(patch, "### Step 6a.5:", "### Step 6b:");
    expect(section).toContain("toolchain-patterns.md");
  });

  it("references toolchain-patterns.md in the Step 7a.5 detection step", () => {
    const section = extractSection(patch, "### Step 7a.5:", "### Step 7b:");
    expect(section).toContain("toolchain-patterns.md");
  });
});

describe("patch.md — Step 5b subagent prompt: no hardcoded bun commands", () => {
  it("does NOT contain 'Run: bun run lint' in Step 5b subagent prompt", () => {
    const section = extractSection(patch, "### Step 5b:", "### Step 5c:");
    expect(section).not.toContain("Run: bun run lint");
  });

  it("does NOT contain 'Run: bun test' in Step 5b subagent prompt", () => {
    const section = extractSection(patch, "### Step 5b:", "### Step 5c:");
    expect(section).not.toContain("Run: bun test");
  });

  it("has a TOOLCHAIN: block in Step 5b subagent prompt", () => {
    const section = extractSection(patch, "### Step 5b:", "### Step 5c:");
    expect(section).toContain("TOOLCHAIN:");
  });

  it("uses {lint command} placeholder in Step 5b [C] Validate", () => {
    const section = extractSection(patch, "### Step 5b:", "### Step 5c:");
    expect(section).toContain("{lint command}");
  });

  it("uses {test command} placeholder in Step 5b [C] Validate", () => {
    const section = extractSection(patch, "### Step 5b:", "### Step 5c:");
    expect(section).toContain("{test command}");
  });
});

describe("patch.md — Step 6c subagent prompt: no hardcoded bun commands", () => {
  it("does NOT contain 'Run: bun run lint' in Step 6c subagent prompt", () => {
    const section = extractSection(patch, "### Step 6c:", "### Step 6d:");
    expect(section).not.toContain("Run: bun run lint");
  });

  it("does NOT contain 'Run: bun test' in Step 6c subagent prompt", () => {
    const section = extractSection(patch, "### Step 6c:", "### Step 6d:");
    expect(section).not.toContain("Run: bun test");
  });

  it("has a TOOLCHAIN: block in Step 6c subagent prompt", () => {
    const section = extractSection(patch, "### Step 6c:", "### Step 6d:");
    expect(section).toContain("TOOLCHAIN:");
  });

  it("uses {lint command} placeholder in Step 6c [C] Validate", () => {
    const section = extractSection(patch, "### Step 6c:", "### Step 6d:");
    expect(section).toContain("{lint command}");
  });

  it("uses {test command} placeholder in Step 6c [C] Validate", () => {
    const section = extractSection(patch, "### Step 6c:", "### Step 6d:");
    expect(section).toContain("{test command}");
  });
});

describe("patch.md — Step 7c subagent prompt: no hardcoded bun commands", () => {
  it("does NOT contain 'Run: bun run lint' in Step 7c subagent prompt", () => {
    const section = extractSection(patch, "### Step 7c:", "### Step 7d:");
    expect(section).not.toContain("Run: bun run lint");
  });

  it("does NOT contain 'Run: bun test' in Step 7c subagent prompt", () => {
    const section = extractSection(patch, "### Step 7c:", "### Step 7d:");
    expect(section).not.toContain("Run: bun test");
  });

  it("has a TOOLCHAIN: block in Step 7c subagent prompt", () => {
    const section = extractSection(patch, "### Step 7c:", "### Step 7d:");
    expect(section).toContain("TOOLCHAIN:");
  });

  it("uses {lint command} placeholder in Step 7c [C] Validate", () => {
    const section = extractSection(patch, "### Step 7c:", "### Step 7d:");
    expect(section).toContain("{lint command}");
  });

  it("uses {test command} placeholder in Step 7c [C] Validate", () => {
    const section = extractSection(patch, "### Step 7c:", "### Step 7d:");
    expect(section).toContain("{test command}");
  });
});
