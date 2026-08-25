import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR = import.meta.dir;

const CODE_REVIEWER_PATH = join(AGENT_DIR, "code-reviewer.md");

let reviewerContent: string;

beforeAll(() => {
  reviewerContent = readFileSync(CODE_REVIEWER_PATH, "utf-8");
});

describe("code-reviewer.md — Rule 6 test-readiness adherence", () => {
  it("contains a Rule 6 Test-readiness adherence section", () => {
    const hasRule6 =
      reviewerContent.includes("Rule 6") ||
      (reviewerContent.toLowerCase().includes("test-readiness") &&
        reviewerContent.toLowerCase().includes("adherence"));
    expect(hasRule6).toBe(true);
  });

  it("has Rule 6 labeled as Test-readiness adherence", () => {
    const hasLabel =
      reviewerContent.includes("Test-readiness adherence") ||
      reviewerContent.includes("test-readiness adherence");
    expect(hasLabel).toBe(true);
  });

  it("documents an activation gate for test files", () => {
    const hasActivationGate =
      (reviewerContent.includes("*.test.*") ||
        reviewerContent.includes(".test.")) &&
      (reviewerContent.includes("*.spec.*") ||
        reviewerContent.includes(".spec.")) &&
      reviewerContent.includes("tests/");
    expect(hasActivationGate).toBe(true);
  });

  it("documents that Rule 6 defers to passed testReadinessContext when present", () => {
    const hasContextDeference =
      reviewerContent.includes("testReadinessContext") &&
      (reviewerContent.includes("when present") ||
        reviewerContent.includes("if present") ||
        reviewerContent.includes("defers to"));
    expect(hasContextDeference).toBe(true);
  });

  it("documents fallback to universal baseline when context is absent", () => {
    const hasFallback =
      reviewerContent.includes("principles.md") &&
      (reviewerContent.includes("absent") ||
        reviewerContent.includes("fallback") ||
        reviewerContent.includes("falls back"));
    expect(hasFallback).toBe(true);
  });

  it("references principles.md as the source for testing-domain entries", () => {
    expect(reviewerContent.includes("principles.md")).toBe(true);
  });

  it("references the pre-existing issue filter from Rule 4", () => {
    const hasRule4Reference =
      reviewerContent.includes("Rule 4") ||
      (reviewerContent.includes("pre-existing") &&
        reviewerContent.includes("filter"));
    expect(hasRule4Reference).toBe(true);
  });

  it("references the CLAUDE.md endorsement filter from Rule 5", () => {
    const hasRule5Reference =
      reviewerContent.includes("Rule 5") ||
      (reviewerContent.includes("CLAUDE.md") &&
        reviewerContent.includes("endorsement") &&
        reviewerContent.includes("filter"));
    expect(hasRule5Reference).toBe(true);
  });
});

describe("code-reviewer.md — Rule 7 architecture-layering adherence", () => {
  it("contains a Rule 7 Architecture-layering adherence section", () => {
    const hasRule7 =
      reviewerContent.includes("Rule 7") ||
      (reviewerContent.toLowerCase().includes("architecture") &&
        reviewerContent.toLowerCase().includes("layering"));
    expect(hasRule7).toBe(true);
  });

  it("has the new rule labeled as Architecture-layering adherence", () => {
    const hasLabel =
      reviewerContent.includes("Architecture-layering adherence") ||
      reviewerContent.toLowerCase().includes("architecture-layering adherence");
    expect(hasLabel).toBe(true);
  });

  it("documents an activation gate for direct layer-skipping calls", () => {
    const hasActivationGate =
      reviewerContent.toLowerCase().includes("activation gate") &&
      reviewerContent.toLowerCase().includes("layer") &&
      (reviewerContent.toLowerCase().includes("handler") ||
        reviewerContent.toLowerCase().includes("skip"));
    expect(hasActivationGate).toBe(true);
  });

  it("references principles.md as the source for architecture-domain entries", () => {
    expect(reviewerContent.includes("principles.md")).toBe(true);
  });

  it("documents graceful degradation when no declared layer structure exists", () => {
    const hasDegradation =
      reviewerContent.toLowerCase().includes("no declared layer structure") ||
      (reviewerContent.toLowerCase().includes("no layer structure") ||
        (reviewerContent.toLowerCase().includes("layer structure") &&
          (reviewerContent.toLowerCase().includes("no ") ||
            reviewerContent.toLowerCase().includes("does not"))));
    expect(hasDegradation).toBe(true);
  });

  it("applies the Rule 4 pre-existing issue filter to the new rule", () => {
    const rule7Section = reviewerContent.slice(
      reviewerContent.indexOf("Architecture-layering adherence"),
    );
    const hasRule4Reference =
      rule7Section.includes("Rule 4") ||
      (rule7Section.includes("pre-existing") && rule7Section.includes("filter"));
    expect(hasRule4Reference).toBe(true);
  });

  it("applies the Rule 5 CLAUDE.md endorsement filter to the new rule", () => {
    const rule7Section = reviewerContent.slice(
      reviewerContent.indexOf("Architecture-layering adherence"),
    );
    const hasRule5Reference =
      rule7Section.includes("Rule 5") ||
      (rule7Section.includes("CLAUDE.md") &&
        rule7Section.includes("endorsement") &&
        rule7Section.includes("filter"));
    expect(hasRule5Reference).toBe(true);
  });
});

describe("code-reviewer.md — Rule 8 security-domain adherence", () => {
  it("contains a Rule 8 Security-domain adherence section", () => {
    const hasRule8 =
      reviewerContent.includes("Rule 8") ||
      (reviewerContent.toLowerCase().includes("security-domain") &&
        reviewerContent.toLowerCase().includes("adherence"));
    expect(hasRule8).toBe(true);
  });

  it("has the new rule labeled as Security-domain adherence", () => {
    const hasLabel =
      reviewerContent.includes("Security-domain adherence") ||
      reviewerContent.toLowerCase().includes("security-domain adherence");
    expect(hasLabel).toBe(true);
  });

  it("documents an activation gate for security-sensitive surface", () => {
    const hasActivationGate =
      reviewerContent.toLowerCase().includes("activation gate") &&
      reviewerContent.toLowerCase().includes("security") &&
      (reviewerContent.toLowerCase().includes("authn") ||
        reviewerContent.toLowerCase().includes("webhook") ||
        reviewerContent.toLowerCase().includes("secret"));
    expect(hasActivationGate).toBe(true);
  });

  it("references principles.md as the source for security-domain entries", () => {
    const hasSecurityDomainReference = reviewerContent.includes(
      "security-domain",
    );
    expect(hasSecurityDomainReference).toBe(true);
    expect(reviewerContent.includes("principles.md")).toBe(true);
  });

  it("applies the Rule 4 pre-existing issue filter to the new rule", () => {
    const rule8Section = reviewerContent.slice(
      reviewerContent.indexOf("Security-domain adherence"),
    );
    const hasRule4Reference =
      rule8Section.includes("Rule 4") ||
      (rule8Section.includes("pre-existing") && rule8Section.includes("filter"));
    expect(hasRule4Reference).toBe(true);
  });

  it("applies the Rule 5 CLAUDE.md endorsement filter to the new rule", () => {
    const rule8Section = reviewerContent.slice(
      reviewerContent.indexOf("Security-domain adherence"),
    );
    const hasRule5Reference =
      rule8Section.includes("Rule 5") ||
      (rule8Section.includes("CLAUDE.md") &&
        rule8Section.includes("endorsement") &&
        rule8Section.includes("filter"));
    expect(hasRule5Reference).toBe(true);
  });

  it("documents an activation clause for workflow file jobs", () => {
    const rule8Section = reviewerContent.slice(
      reviewerContent.indexOf("Security-domain adherence"),
      reviewerContent.indexOf("## Confidence Scoring"),
    );
    const hasWorkflowClause =
      rule8Section.includes(".github/workflows/*.yml") &&
      rule8Section.toLowerCase().includes("job");
    expect(hasWorkflowClause).toBe(true);
  });
});

describe("code-reviewer.md — principles.md override check (PCO-1.3)", () => {
  function rulesPreamble(): string {
    const start = reviewerContent.indexOf("## Shipwright-specific Rules");
    const end = reviewerContent.indexOf("1. **Breaking API changes");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(-1);
    return reviewerContent.slice(start, end);
  }

  it("Shipwright-specific Rules preamble checks .claude/shipwright/principles.md before falling back", () => {
    expect(rulesPreamble()).toContain(".claude/shipwright/principles.md");
  });

  it("Shipwright-specific Rules preamble mentions fallback to references/principles.md", () => {
    expect(rulesPreamble()).toContain("references/principles.md");
  });

  it("Shipwright-specific Rules preamble describes checking/loading project override before falling back", () => {
    const lower = rulesPreamble().toLowerCase();
    expect(lower).toMatch(/check.*project|project.*override|override.*check/);
  });

  it("Rule 6 references the override-aware principles source, not a hardcoded plugin path", () => {
    const rule6Section = reviewerContent.slice(
      reviewerContent.indexOf("Test-readiness adherence"),
      reviewerContent.indexOf("Architecture-layering adherence"),
    );
    expect(rule6Section).toContain("principles source");
    expect(rule6Section).not.toContain("`references/principles.md`");
  });

  it("Rule 7 references the override-aware principles source, not a hardcoded plugin path", () => {
    const rule7Section = reviewerContent.slice(
      reviewerContent.indexOf("Architecture-layering adherence"),
      reviewerContent.indexOf("Security-domain adherence"),
    );
    expect(rule7Section).toContain("principles source");
    expect(rule7Section).not.toContain("`references/principles.md`");
  });

  it("Rule 8 references the override-aware principles source, not a hardcoded plugin path", () => {
    const rule8Section = reviewerContent.slice(
      reviewerContent.indexOf("Security-domain adherence"),
      reviewerContent.indexOf("## Confidence Scoring"),
    );
    expect(rule8Section).toContain("principles source");
    expect(rule8Section).not.toContain("`references/principles.md`");
  });
});

describe("code-reviewer.md — architecture category in output format", () => {
  it("includes architecture in the category enum", () => {
    expect(reviewerContent).toContain("architecture");
  });
});

describe("code-reviewer.md — test-readiness category in output format", () => {
  it("includes test-readiness in the category enum", () => {
    expect(reviewerContent).toContain("test-readiness");
  });

  it("has test-readiness alongside other categories in the category field", () => {
    const hasCategoryLine = reviewerContent.includes(
      "bug|security|api-break|acceptance-criteria|silent-failure|claude-md|quality|test-readiness",
    );
    const hasSeparateEntry =
      reviewerContent.includes("test-readiness") &&
      reviewerContent.includes("category");
    expect(hasCategoryLine || hasSeparateEntry).toBe(true);
  });
});

describe("code-reviewer.md — frontmatter and inputs", () => {
  it("mentions test-readiness in the frontmatter description", () => {
    const lines = reviewerContent.split("\n");
    const descriptionLine = lines.find((l) => l.startsWith("description:"));
    expect(descriptionLine).toBeDefined();
    const hasTestReadiness =
      descriptionLine?.toLowerCase().includes("test-readiness") ?? false;
    expect(hasTestReadiness).toBe(true);
  });

  it("documents the optional testReadinessContext input", () => {
    const hasInputNote =
      reviewerContent.includes("testReadinessContext") &&
      (reviewerContent.includes("Optional") ||
        reviewerContent.includes("optional"));
    expect(hasInputNote).toBe(true);
  });
});

describe("test-readiness-tenets.md — retired in favor of principles.md", () => {
  it("the legacy reference file is absent", () => {
    const tenetsPath = join(AGENT_DIR, "../references/test-readiness-tenets.md");
    expect(existsSync(tenetsPath)).toBe(false);
  });
});

describe("code-reviewer.md — prior findings attestation input and output (PVD-1.2)", () => {
  it("documents the new optional prior-findings input in the caller-passes-in list", () => {
    const inputsIdx = reviewerContent.indexOf("The caller");
    expect(inputsIdx).toBeGreaterThan(-1);
    const outputFormatIdx = reviewerContent.indexOf("## Output Format");
    const inputsSection = reviewerContent.slice(inputsIdx, outputFormatIdx);

    expect(inputsSection).toContain("Optional");
    expect(inputsSection.toLowerCase()).toContain("prior");
    expect(inputsSection.toLowerCase()).toContain("finding");
  });

  it("instructs the subagent to assess, for each prior finding, whether the issue is still present in the current diff", () => {
    const inputsIdx = reviewerContent.indexOf("The caller");
    const outputFormatIdx = reviewerContent.indexOf("## Output Format");
    const inputsSection = reviewerContent.slice(inputsIdx, outputFormatIdx);

    const priorIdx = inputsSection.toLowerCase().indexOf("prior");
    expect(priorIdx).toBeGreaterThan(-1);
    const wholeDoc = reviewerContent.toLowerCase();
    expect(wholeDoc).toContain("still present");
  });

  it("documents priorFindingsStatus as a new top-level field in the Output Format JSON schema", () => {
    const outputFormatIdx = reviewerContent.indexOf("## Output Format");
    expect(outputFormatIdx).toBeGreaterThan(-1);
    const outputSection = reviewerContent.slice(outputFormatIdx);

    expect(outputSection).toContain("priorFindingsStatus");
    expect(outputSection).toContain("ref");
    expect(outputSection).toContain("resolved");
    expect(outputSection).toContain("evidence");
  });

  it("documents priorFindingsStatus is required whenever prior-findings input was passed", () => {
    const outputFormatIdx = reviewerContent.indexOf("## Output Format");
    const outputSection = reviewerContent.slice(outputFormatIdx);

    const fieldIdx = outputSection.indexOf("priorFindingsStatus");
    expect(fieldIdx).toBeGreaterThan(-1);
    const nearby = outputSection.slice(Math.max(0, fieldIdx - 400), fieldIdx + 800);

    expect(nearby.toLowerCase()).toContain("required");
  });

  it("documents evidence is required in both the resolved:true and resolved:false cases", () => {
    const outputFormatIdx = reviewerContent.indexOf("## Output Format");
    const outputSection = reviewerContent.slice(outputFormatIdx);

    const fieldIdx = outputSection.indexOf("priorFindingsStatus");
    expect(fieldIdx).toBeGreaterThan(-1);
    const nearby = outputSection.slice(fieldIdx, fieldIdx + 1200);

    expect(nearby.toLowerCase()).toContain("evidence");
    expect(nearby.toLowerCase()).toContain("required");
    expect(nearby.toLowerCase()).toContain("both");
  });
});
