import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REFS = join(import.meta.dir, "..", "references", "patch");

let patch: string;
let laneFindings: string;
let laneCi: string;
let laneShared: string;

beforeAll(() => {
  patch = readFileSync(join(import.meta.dir, "patch.md"), "utf-8");
  laneFindings = readFileSync(join(REFS, "lane-findings.md"), "utf-8");
  laneCi = readFileSync(join(REFS, "lane-ci.md"), "utf-8");
  laneShared = readFileSync(join(REFS, "lane-shared.md"), "utf-8");
});

describe("patch.md — toolchain detection", () => {
  it("the lane skeleton has a Toolchain step that references toolchain-patterns.md", () => {
    expect(patch).toContain("**Toolchain**");
    expect(patch).toContain("toolchain-patterns.md");
  });

  it("lane-shared.md documents detection and storing the lint/test commands", () => {
    expect(laneShared).toContain("toolchain-patterns.md");
    expect(laneShared).toContain("{lint command}");
    expect(laneShared).toContain("{test command}");
  });
});

describe.each([
  ["findings lane (Step 5b)", () => laneFindings],
  ["CI lane (Step 6c)", () => laneCi],
])("patch %s subagent prompt: no hardcoded bun commands", (_name, get) => {
  it("does NOT contain 'Run: bun run lint'", () => {
    expect(get()).not.toContain("Run: bun run lint");
  });

  it("does NOT contain 'Run: bun test'", () => {
    expect(get()).not.toContain("Run: bun test");
  });

  it("has a TOOLCHAIN: block", () => {
    expect(get()).toContain("TOOLCHAIN:");
  });

  it("uses {lint command} and {test command} placeholders", () => {
    expect(get()).toContain("{lint command}");
    expect(get()).toContain("{test command}");
  });

  it("includes Test layers in the TOOLCHAIN block", () => {
    expect(get()).toContain("Test layers:");
  });
});

describe("patch shared validate instruction", () => {
  it("tells subagents to run the placeholders, not hardcoded commands", () => {
    expect(laneShared).toContain("run {lint command}");
    expect(laneShared).toContain("{test command}");
    expect(laneShared).not.toContain("Run: bun run lint");
  });
});
