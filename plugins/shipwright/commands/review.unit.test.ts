import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REVIEW_MD_PATH = join(import.meta.dir, "review.md");

let content: string;

beforeAll(() => {
  content = readFileSync(REVIEW_MD_PATH, "utf-8");
});

describe("review.md — Step 13 structured findings (MDR-2.1)", () => {
  it("describes review.findings as an array of objects with category, severity, resolved", () => {
    // Must describe findings as array of objects with these three fields
    const hasCategoryField = content.includes("category");
    const hasSeverityField = content.includes("severity");
    const hasResolvedField = content.includes("resolved");
    const hasArrayDescription =
      content.includes("findings[]") ||
      content.includes('"findings": [') ||
      content.includes("array");
    expect(hasCategoryField).toBe(true);
    expect(hasSeverityField).toBe(true);
    expect(hasResolvedField).toBe(true);
    expect(hasArrayDescription).toBe(true);
  });

  it("mentions review.findings_count integer for backward compatibility", () => {
    const hasFindingsCount =
      content.includes("findings_count") &&
      (content.includes("backward") ||
        content.includes("backward compat") ||
        content.includes("compat"));
    expect(hasFindingsCount).toBe(true);
  });

  it("mentions review_latency_h as a float computed from prCreatedAt", () => {
    const hasLatencyField = content.includes("review_latency_h");
    const hasPrCreatedAt = content.includes("prCreatedAt");
    expect(hasLatencyField).toBe(true);
    expect(hasPrCreatedAt).toBe(true);
  });

  it("mentions rework_cycles as commits after first review event", () => {
    const hasReworkCycles = content.includes("rework_cycles");
    const hasCommitsAfterReview =
      content.includes("commits") &&
      (content.includes("after") || content.includes("first review"));
    expect(hasReworkCycles).toBe(true);
    expect(hasCommitsAfterReview).toBe(true);
  });
});

describe("review.md — TRR-1.2 test-readiness context", () => {
  it("Step 5.7 references test-system.md as the source for test-readiness context (AC1)", () => {
    // The gather step must name the file it reads for test-readiness context
    const hasTestSystemMd = content.includes("test-system.md");
    expect(hasTestSystemMd).toBe(true);
  });

  it("Step 6 mentions 'Testing changes' classification", () => {
    // Step 6 classify-changes step must include a Testing changes bullet
    const hasTestingChanges = content.includes("Testing changes");
    expect(hasTestingChanges).toBe(true);
  });

  it("Step 7 mentions testReadinessContext as a field passed to the subagent", () => {
    // Step 7 subagent dispatch must reference testReadinessContext as a named field
    const hasTestReadinessContext = content.includes("testReadinessContext");
    expect(hasTestReadinessContext).toBe(true);
  });
});
