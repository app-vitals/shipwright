import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "review.md");

let content: string;

beforeAll(() => {
  if (existsSync(REFERENCE_PATH)) {
    content = readFileSync(REFERENCE_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("review.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("review.md — framed as an implementation-agnostic interface contract", () => {
  it("frames the contract as applying to any review-phase subagent, not just code-reviewer by name", () => {
    expect(content.toLowerCase()).toMatch(/any (?:review-phase )?subagent|custom subagent/);
  });

  it("references code-reviewer.md as the reference implementation", () => {
    expect(content).toContain("code-reviewer.md");
  });
});

describe("review.md — inputs", () => {
  it("documents PR metadata fields", () => {
    expect(content).toContain("title");
    expect(content).toContain("author");
    expect(content).toContain("headRefName");
    expect(content).toContain("baseRefName");
    expect(content).toContain("headRefOid");
  });

  it("documents the full diff input", () => {
    expect(content.toLowerCase()).toContain("diff");
  });

  it("documents the changed files list input", () => {
    expect(content.toLowerCase()).toContain("changed files");
  });

  it("documents CLAUDE.md content input, including directory-scoped files", () => {
    expect(content).toContain("CLAUDE.md");
    expect(content.toLowerCase()).toContain("directory");
  });

  it("documents optional acceptanceCriteria", () => {
    expect(content).toContain("acceptanceCriteria");
  });

  it("documents optional testReadinessContext", () => {
    expect(content).toContain("testReadinessContext");
  });

  it("documents the prior-findings-requires-resolution-check input (PVD-1.2) with a ref per entry", () => {
    expect(content).toContain("PVD-1.2");
    expect(content.toLowerCase()).toContain("prior findings");
    expect(content).toContain("ref");
  });

  it("documents policy thresholds min_confidence (default 75) and max_findings (default 5)", () => {
    expect(content).toContain("min_confidence");
    expect(content).toContain("75");
    expect(content).toContain("max_findings");
    expect(content).toContain("5");
  });
});

describe("review.md — output", () => {
  it("documents summary", () => {
    expect(content).toContain("summary");
  });

  it("documents findings[] fields", () => {
    expect(content).toContain("findings");
    expect(content).toContain("title");
    expect(content).toContain("file");
    expect(content).toContain("line");
    expect(content).toContain("severity");
    expect(content).toContain("confidence");
    expect(content).toContain("category");
    expect(content).toContain("description");
    expect(content).toContain("suggestion");
  });

  it("documents strengths[]", () => {
    expect(content).toContain("strengths");
  });

  it("documents recommendation as APPROVE/COMMENT", () => {
    expect(content).toContain("recommendation");
    expect(content).toContain("APPROVE");
    expect(content).toContain("COMMENT");
  });

  it("documents recommendation_reason", () => {
    expect(content).toContain("recommendation_reason");
  });

  it("documents priorFindingsStatus[] with ref/resolved/evidence fields", () => {
    expect(content).toContain("priorFindingsStatus");
    expect(content).toContain("resolved");
    expect(content).toContain("evidence");
  });

  it("notes evidence is required in both the resolved true and false cases", () => {
    expect(content.toLowerCase()).toContain("required");
    expect(content).toMatch(/resolved:\s*true/);
    expect(content).toMatch(/resolved:\s*false/);
  });
});
