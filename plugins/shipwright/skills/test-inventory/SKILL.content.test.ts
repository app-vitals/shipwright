import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");
const TEMPLATE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "assets",
  "templates",
  "test-inventory.md.tmpl",
);

let content: string;
let templateContent: string;

beforeAll(() => {
  content = existsSync(SKILL_MD_PATH)
    ? readFileSync(SKILL_MD_PATH, "utf-8")
    : "";
  templateContent = existsSync(TEMPLATE_PATH)
    ? readFileSync(TEMPLATE_PATH, "utf-8")
    : "";
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
  it("has frontmatter with name: test-inventory", () => {
    expect(content).toContain("name: test-inventory");
  });

  it("has frontmatter with a description field", () => {
    expect(content).toMatch(/^description:/m);
  });
});

describe("SKILL.md — feature-grouping step", () => {
  it("describes heuristic inference using directory structure, route prefix, and entry point signals", () => {
    expect(content).toMatch(/directory structure/i);
    expect(content).toMatch(/route[ -]prefix/i);
    expect(content).toMatch(/entry[ -]point/i);
  });

  it("requires every code unit be assigned to exactly one feature", () => {
    expect(content).toMatch(/exactly one feature/i);
  });

  it("documents the four importance labels", () => {
    expect(content).toContain("revenue-path");
    expect(content).toContain("security-path");
    expect(content).toContain("core");
    expect(content).toContain("auxiliary");
  });

  it("states importance tagging is prioritization-only and never excludes a feature from the denominator", () => {
    expect(content).toMatch(/prioritization[- ]only/i);
    expect(content).toMatch(/never exclud(e|es|ing)/i);
    expect(content).toMatch(/denominator/i);
  });

  it("does not conflate feature importance with Step 4's per-unit criticality tier", () => {
    expect(content).toMatch(/not the same as/i);
  });
});

describe("SKILL.md — ambiguous groupings reuse the existing classifier-confidence pattern", () => {
  it("reuses the 'classifier was not confident' wording for ambiguous feature groupings", () => {
    expect(content).toMatch(/classifier was not confident/i);
  });

  it("directs ambiguous feature groupings into the existing Ambiguous items section, not a new mechanism", () => {
    expect(content).toMatch(/Ambiguous items/);
    expect(content).toMatch(/not a\s+new\s+mechanism/i);
  });
});

describe("SKILL.md — feature_coverage_pct formula", () => {
  it("documents the formula verbatim as covered_features / total_features x 100", () => {
    expect(content).toContain("covered_features / total_features x 100");
  });

  it("states there is no exclusion category of any kind", () => {
    expect(content).toMatch(/no exclusion category of any kind/i);
  });
});

describe("SKILL.md — negative constraint: no maintained per-file criticality→CI mapping", () => {
  it("explicitly states the feature-grouping structure must not reintroduce a maintained per-file criticality-to-CI mapping", () => {
    expect(content).toMatch(/must not reintroduce/i);
    expect(content).toMatch(/per-file criticality/i);
    expect(content).toMatch(/CI\s+mapping/i);
  });

  it("describes the feature structure as coarser and separate from Step 4's per-unit criticality ranking", () => {
    expect(content).toMatch(/coarser/i);
    expect(content).toMatch(/separate structure/i);
  });
});

describe("SKILL.md — Step 6 mentions filling in Features section placeholders", () => {
  it("references the Features section when writing the artifact", () => {
    const step6Idx = content.indexOf("Step 6");
    expect(step6Idx).toBeGreaterThan(-1);
    const step6Section = content.slice(step6Idx, step6Idx + 1500);
    expect(step6Section).toMatch(/Features section/i);
  });
});

describe("test-inventory.md.tmpl — file exists and has content", () => {
  it("file exists", () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
  });

  it("is non-empty", () => {
    expect(templateContent.length).toBeGreaterThan(200);
  });
});

describe("test-inventory.md.tmpl — Features section", () => {
  it("has a Features section header", () => {
    expect(templateContent).toMatch(/^## Features/m);
  });

  it("has a table with the required columns", () => {
    expect(templateContent).toContain("Feature name");
    expect(templateContent).toContain("Member units");
    expect(templateContent).toContain("Required layer");
    expect(templateContent).toContain("Importance");
    expect(templateContent).toMatch(/Covered \(y\/n\)/);
  });

  it("has a placeholder for the feature rows", () => {
    expect(templateContent).toContain("{{FEATURES_ROWS}}");
  });

  it("has a placeholder surfacing the computed feature_coverage_pct value", () => {
    expect(templateContent).toContain("{{FEATURE_COVERAGE_PCT}}");
  });
});
