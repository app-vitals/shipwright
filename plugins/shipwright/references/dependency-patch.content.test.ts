import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "dependency-patch.md");

let content: string;

beforeAll(() => {
  if (existsSync(REFERENCE_PATH)) {
    content = readFileSync(REFERENCE_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("dependency-patch.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("dependency-patch.md — cross-references dependency-risk-analysis.md", () => {
  it("names dependency-risk-analysis.md directly as the producer of its inputs", () => {
    expect(content).toContain("dependency-risk-analysis.md");
  });

  it("frames its inputs as the {recommendation, flags, reasoning} shape", () => {
    expect(content).toContain("recommendation");
    expect(content).toContain("flags");
    expect(content).toContain("reasoning");
  });
});

describe("dependency-patch.md — Inputs/Output sections", () => {
  it("documents an Inputs section", () => {
    expect(content).toContain("## Inputs");
  });

  it("documents an Output section", () => {
    expect(content).toContain("## Output");
  });

  it("documents the PR's worktree and diff as inputs", () => {
    expect(content.toLowerCase()).toContain("worktree");
    expect(content.toLowerCase()).toContain("diff");
  });
});

describe("dependency-patch.md — reproduce-before-fixing protocol", () => {
  it("documents a reproduce-before-fixing protocol section", () => {
    expect(content.toLowerCase()).toContain("reproduce-before-fixing protocol");
  });

  it("requires running the verification command before attempting any fix", () => {
    expect(content.toLowerCase()).toContain("verification command");
    expect(content.toLowerCase()).toContain("before");
  });

  it("requires re-running the verification command after the fix, before claiming it fixed", () => {
    expect(content.toLowerCase()).toContain("re-run");
    expect(content.toLowerCase()).toContain("after");
    expect(content.toLowerCase()).toContain("claiming");
  });
});

describe("dependency-patch.md — bounded remediation strategy catalog", () => {
  it("documents the catalog is explicitly bounded", () => {
    expect(content.toLowerCase()).toContain("bounded");
  });

  it("documents the transitive-dependency override/resolution pin strategy", () => {
    expect(content.toLowerCase()).toContain("transitive");
    expect(content.toLowerCase()).toContain("override");
    expect(content.toLowerCase()).toContain("resolution pin");
  });

  it("documents the removed/renamed first-party API call-site update strategy", () => {
    expect(content.toLowerCase()).toContain("renamed");
    expect(content.toLowerCase()).toContain("removed");
    expect(content.toLowerCase()).toContain("call site");
  });
});

describe("dependency-patch.md — no-safe-strategy exit", () => {
  it("documents the leave-as-hold exit language", () => {
    expect(content.toLowerCase()).toContain("leave as hold");
  });

  it("documents that anything outside the catalog exits to hold", () => {
    expect(content.toLowerCase()).toContain("outside");
  });

  it("documents that an unreproducible or unverifiable claim exits to hold", () => {
    expect(content.toLowerCase()).toContain("unreproducible");
    expect(content.toLowerCase()).toContain("unverifiable");
  });

  it("explicitly forbids fabricating a fix", () => {
    expect(content.toLowerCase()).toContain("fabricate");
  });
});
