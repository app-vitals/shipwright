/**
 * principles-pattern.md citation tests — PRU-1.1
 *
 * Verifies the shared, skill-agnostic principles-file pattern doc
 * (plugins/shipwright/references/principles-pattern.md) exists and is cited by
 * both entropy-scan's customization.md and security-scan's SKILL.md, so the
 * pattern (schema, override semantics, init flow) has one canonical description
 * instead of being re-documented per consumer.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads (mirrors principles-content.content.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → plugins/shipwright/
const pluginRoot = resolve(import.meta.dir, "..");

function pluginPath(...parts: string[]): string {
  return join(pluginRoot, ...parts);
}

const patternDocPath = pluginPath("references", "principles-pattern.md");
const customizationPath = pluginPath(
  "skills",
  "entropy-scan",
  "references",
  "customization.md",
);
const securityScanSkillPath = pluginPath("skills", "security-scan", "SKILL.md");

const CITATION = "references/principles-pattern.md";

describe("principles-pattern.md — file exists", () => {
  it("references/principles-pattern.md exists", () => {
    expect(existsSync(patternDocPath)).toBe(true);
  });

  it("documents the schema, override semantics, and init flow generically", () => {
    const content = readFileSync(patternDocPath, "utf8");
    expect(content).toContain("## Schema");
    expect(content).toContain("## Override semantics");
    expect(content).toContain("## Init flow");
  });
});

describe("entropy-scan's customization.md cites the shared reference", () => {
  it("mentions references/principles-pattern.md", () => {
    const content = readFileSync(customizationPath, "utf8");
    expect(content).toContain(CITATION);
  });
});

describe("security-scan's SKILL.md cites the shared reference", () => {
  it("mentions references/principles-pattern.md", () => {
    const content = readFileSync(securityScanSkillPath, "utf8");
    expect(content).toContain(CITATION);
  });
});
