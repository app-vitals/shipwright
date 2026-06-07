import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const AGENT_DIR = import.meta.dir;
const REFERENCES_DIR = join(AGENT_DIR, "../references");

const CODE_REVIEWER_PATH = join(AGENT_DIR, "code-reviewer.md");
const TENETS_PATH = join(REFERENCES_DIR, "test-readiness-tenets.md");

let reviewerContent: string;
let tenetsContent: string;

beforeAll(() => {
  reviewerContent = readFileSync(CODE_REVIEWER_PATH, "utf-8");
  if (existsSync(TENETS_PATH)) {
    tenetsContent = readFileSync(TENETS_PATH, "utf-8");
  } else {
    tenetsContent = "";
  }
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
      reviewerContent.includes("test-readiness-tenets.md") &&
      (reviewerContent.includes("absent") ||
        reviewerContent.includes("fallback") ||
        reviewerContent.includes("falls back"));
    expect(hasFallback).toBe(true);
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

describe("test-readiness-tenets.md — file exists and contains universal baseline", () => {
  it("the reference file exists", () => {
    expect(existsSync(TENETS_PATH)).toBe(true);
  });

  it("is readable and non-empty", () => {
    expect(tenetsContent.length).toBeGreaterThan(200);
  });

  it("contains the no global mocking tenet", () => {
    const hasTenet =
      tenetsContent.toLowerCase().includes("global mocking") ||
      tenetsContent.toLowerCase().includes("no global mock");
    expect(hasTenet).toBe(true);
  });

  it("contains the clock injection tenet", () => {
    const hasTenet =
      tenetsContent.toLowerCase().includes("clock injection") ||
      tenetsContent.toLowerCase().includes("clock interface") ||
      (tenetsContent.toLowerCase().includes("clock") &&
        tenetsContent.toLowerCase().includes("inject"));
    expect(hasTenet).toBe(true);
  });

  it("contains the recorded fixtures tenet", () => {
    const hasTenet =
      tenetsContent.toLowerCase().includes("recorded fixture") ||
      tenetsContent.toLowerCase().includes("recorded-fixture");
    expect(hasTenet).toBe(true);
  });

  it("contains the real-boundary integration tenet", () => {
    const hasTenet =
      tenetsContent.toLowerCase().includes("real-boundary") ||
      (tenetsContent.toLowerCase().includes("real") &&
        tenetsContent.toLowerCase().includes("boundary") &&
        tenetsContent.toLowerCase().includes("integration"));
    expect(hasTenet).toBe(true);
  });

  it("contains the no-duplicate coverage tenet", () => {
    const hasTenet =
      tenetsContent.toLowerCase().includes("duplicate") &&
      (tenetsContent.toLowerCase().includes("coverage") ||
        tenetsContent.toLowerCase().includes("layer"));
    expect(hasTenet).toBe(true);
  });

  it("contains confidence guidance", () => {
    const hasConfidenceGuidance =
      tenetsContent.toLowerCase().includes("confidence") &&
      (tenetsContent.includes("75") || tenetsContent.includes("80"));
    expect(hasConfidenceGuidance).toBe(true);
  });

  it("contains a graceful-degradation note for repos without test-readiness docs", () => {
    const hasDegradationNote =
      tenetsContent.toLowerCase().includes("graceful") ||
      tenetsContent.toLowerCase().includes("degradation") ||
      (tenetsContent.toLowerCase().includes("absent") &&
        tenetsContent.toLowerCase().includes("docs")) ||
      tenetsContent.toLowerCase().includes("no test-readiness");
    expect(hasDegradationNote).toBe(true);
  });
});
