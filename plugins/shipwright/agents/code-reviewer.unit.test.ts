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
