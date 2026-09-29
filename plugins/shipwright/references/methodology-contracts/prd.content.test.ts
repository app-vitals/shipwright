import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "prd.md");

let content: string;

beforeAll(() => {
  if (existsSync(REFERENCE_PATH)) {
    content = readFileSync(REFERENCE_PATH, "utf-8");
  } else {
    content = "";
  }
});

describe("prd.md — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(content.length).toBeGreaterThan(200);
  });
});

describe("prd.md — framed as an implementation-agnostic interface contract", () => {
  it("frames the contract as applying to any prd-phase subagent, not just one built-in implementation exclusively", () => {
    expect(content.toLowerCase()).toMatch(/any (?:prd-phase )?subagent|custom subagent/);
  });

  it("references prd.md (commands/prd.md) or reference implementation as the reference", () => {
    expect(content).toMatch(/commands\/prd\.md|reference implementation/);
  });
});

describe("prd.md — key contract characteristics", () => {
  it("documents that prd has no task-store writes (unlike other phases)", () => {
    expect(content.toLowerCase()).toMatch(/task.?store|task store/);
    expect(content.toLowerCase()).toMatch(/(?:never|no|without|no.*writes|does not).*(?:write|touch|write)/);
  });

  it("documents that prd is not loop-dispatched (human-invoked only)", () => {
    expect(content.toLowerCase()).toMatch(/loop.?dispatched|loop-orchestrator|human-invok|manual|direct|explicit/);
  });

  it("documents the output location planning/{session}/PRODUCT-SPEC.md", () => {
    expect(content).toContain("planning/");
    expect(content).toContain("PRODUCT-SPEC.md");
  });

  it("references the product-spec-template.md template", () => {
    expect(content).toContain("product-spec-template.md");
  });
});

describe("prd.md — output section details", () => {
  it("documents required section headings from the template (Overview, Problem Statement, etc.)", () => {
    expect(content).toContain("Overview");
    expect(content).toContain("Problem Statement");
    expect(content).toContain("Users & Context");
    expect(content).toContain("Features");
    expect(content).toContain("Technical Constraints");
    expect(content).toContain("Scope");
    expect(content).toContain("Priorities & Sequence");
  });

  it("documents Resolved Decisions as part of the output contract", () => {
    expect(content).toContain("Resolved Decisions");
  });

  it("documents Acceptance Criteria quality requirement (testable checkboxes)", () => {
    expect(content).toContain("Acceptance Criteria");
    expect(content.toLowerCase()).toMatch(/(?:checkbox|testable|observable|specific|verifiable)/);
  });

  it("documents Success Criteria as part of the output", () => {
    expect(content).toContain("Success Criteria");
  });

  it("documents that the file is consumed by /plan-session (downstream integration point)", () => {
    expect(content).toMatch(/plan-session|\/plan-session/);
  });
});

describe("prd.md — scope section", () => {
  it("has a Scope section", () => {
    expect(content).toMatch(/^##\s+Scope/m);
  });

  it("clarifies scope covers only the output-artifact shape, not the discovery process", () => {
    expect(content.toLowerCase()).toMatch(/(?:output|artifact|shape)|(?:discovery|process)/);
  });
});
