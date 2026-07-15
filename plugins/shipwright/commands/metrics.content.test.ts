import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const METRICS_MD_PATH = join(import.meta.dir, "metrics.md");

let content: string;

beforeAll(() => {
  content = readFileSync(METRICS_MD_PATH, "utf-8");
});

describe("metrics.md — Test Health section heading", () => {
  it('contains a "Test Health" section heading', () => {
    expect(content).toContain("Test Health");
  });
});

describe("metrics.md — Test Health aggregate (Step 3i)", () => {
  it("references test_layers field for per-layer data", () => {
    expect(content).toContain("test_layers");
  });

  it("references measured key for per-layer file counts", () => {
    expect(content).toContain("measured");
  });

  it("describes per-layer tests added and removed", () => {
    const hasAdded =
      content.includes("tests added") ||
      content.includes("added per layer") ||
      content.includes("Tests added");
    const hasRemoved =
      content.includes("tests removed") ||
      content.includes("removed per layer") ||
      content.includes("Tests removed");
    expect(hasAdded).toBe(true);
    expect(hasRemoved).toBe(true);
  });

  it("describes the redundant-test removal rate", () => {
    const hasRemovalRate =
      content.includes("removal rate") || content.includes("Removal rate");
    expect(hasRemovalRate).toBe(true);
  });

  it("describes planned-vs-actual drift rate using drift field", () => {
    const hasDriftRate =
      content.includes("drift rate") || content.includes("Drift rate");
    expect(hasDriftRate).toBe(true);
  });

  it("describes conformance deviation rate", () => {
    const hasDeviationRate =
      content.includes("deviation rate") || content.includes("Deviation rate");
    expect(hasDeviationRate).toBe(true);
  });
});

describe("metrics.md — mixed-vintage handling (pre-feature records)", () => {
  it('treats records missing test_layers as "not captured" (pre-feature), not errors', () => {
    const hasNotCaptured =
      content.includes("not captured") || content.includes("pre-feature");
    expect(hasNotCaptured).toBe(true);
  });

  it("skips the Test Health section entirely when zero records have test_layers", () => {
    const hasSkipLegacy =
      content.includes("zero records") ||
      (content.includes("skip") && content.includes("legacy")) ||
      content.includes("skip this section") ||
      content.includes("skip the section");
    expect(hasSkipLegacy).toBe(true);
  });
});

describe("metrics.md — per-layer coverage null handling", () => {
  it("explicitly handles the case when per-layer coverage is null for all records", () => {
    const hasCoverageNull =
      content.includes("null for all records") ||
      content.includes("not captured (null") ||
      (content.includes("coverage_per_layer") && content.includes("null"));
    expect(hasCoverageNull).toBe(true);
  });

  it("does not show 0% or blank when coverage is null — says so explicitly", () => {
    // The instruction must say to surface null explicitly, not show 0% or blank
    const hasExplicitNull =
      content.includes("null for all records") ||
      content.includes("not captured (null") ||
      content.includes("state explicitly") ||
      content.includes("say so");
    expect(hasExplicitNull).toBe(true);
  });
});

describe("metrics.md — determinism instruction", () => {
  it("states that running /metrics twice produces byte-identical output", () => {
    const hasDeterminism =
      content.includes("byte-identical") ||
      content.includes("idempotent") ||
      content.includes("creates no files") ||
      content.includes("side-effect-free");
    expect(hasDeterminism).toBe(true);
  });
});

describe("metrics.md — recommendation rules for Test Health (Step 5)", () => {
  it("includes a recommendation rule for high drift rate (>20%)", () => {
    const hasDriftRule =
      content.includes("drift") &&
      (content.includes("20%") ||
        content.includes("> 20%") ||
        content.includes(">20%"));
    expect(hasDriftRule).toBe(true);
  });

  it("includes a recommendation rule when less than 50% of records have test_layers data", () => {
    const hasLegacyRule =
      content.includes("50%") &&
      (content.includes("pre-date") ||
        content.includes("test layer feature") ||
        content.includes("test health data"));
    expect(hasLegacyRule).toBe(true);
  });
});

describe("metrics.md — Step 6 rendered Test Health output block", () => {
  it("includes Tests added in the rendered output template", () => {
    const hasAddedOutput =
      content.includes("Tests added:") || content.includes("tests added:");
    expect(hasAddedOutput).toBe(true);
  });

  it("includes Tests removed in the rendered output template", () => {
    const hasRemovedOutput =
      content.includes("Tests removed:") || content.includes("tests removed:");
    expect(hasRemovedOutput).toBe(true);
  });

  it("includes Drift rate in the rendered output template", () => {
    const hasDriftOutput =
      content.includes("Drift rate:") || content.includes("drift rate:");
    expect(hasDriftOutput).toBe(true);
  });

  it("includes Deviation rate in the rendered output template", () => {
    const hasDeviationOutput =
      content.includes("Deviation rate:") ||
      content.includes("deviation rate:");
    expect(hasDeviationOutput).toBe(true);
  });
});

describe("metrics.md — Step 3c review phase enrichment (MDR-2.1)", () => {
  it("handles both integer and array findings formats", () => {
    // Must handle old integer format and new array format for review.findings
    const hasIntegerHandling =
      content.includes("integer") &&
      (content.includes("findings") || content.includes("review.findings"));
    const hasArrayHandling =
      content.includes("array") &&
      (content.includes("findings") || content.includes("review.findings"));
    expect(hasIntegerHandling).toBe(true);
    expect(hasArrayHandling).toBe(true);
  });

  it("describes finding category breakdown (count by category)", () => {
    const hasCategoryBreakdown =
      (content.includes("category") || content.includes("categories")) &&
      (content.includes("breakdown") ||
        content.includes("count by") ||
        content.includes("occurrences"));
    expect(hasCategoryBreakdown).toBe(true);
  });

  it("computes average review_latency_h across review-enriched records", () => {
    const hasAvgLatency =
      content.includes("review_latency_h") &&
      (content.includes("avg") ||
        content.includes("average") ||
        content.includes("mean") ||
        content.includes("Avg"));
    expect(hasAvgLatency).toBe(true);
  });

  it("computes average rework_cycles across review-enriched records", () => {
    const hasAvgRework =
      content.includes("rework_cycles") &&
      (content.includes("avg") ||
        content.includes("average") ||
        content.includes("mean") ||
        content.includes("Avg"));
    expect(hasAvgRework).toBe(true);
  });
});

describe("metrics.md — Step 5 recommendation for most common finding category (MDR-2.1)", () => {
  it("includes a recommendation rule citing the most common finding category", () => {
    const hasCategoryRec =
      content.includes("most common") &&
      (content.includes("finding category") || content.includes("category"));
    expect(hasCategoryRec).toBe(true);
  });

  it("uses a threshold (30%) for calling out a dominant category", () => {
    const has30Percent =
      content.includes("30%") &&
      (content.includes("category") || content.includes("findings"));
    expect(has30Percent).toBe(true);
  });
});

describe("metrics.md — Step 6 review output block enrichment (MDR-2.1)", () => {
  it("includes category breakdown in the rendered Review output section", () => {
    const hasCategoryOutput =
      content.includes("Categories:") || content.includes("Categories ");
    expect(hasCategoryOutput).toBe(true);
  });

  it("includes Avg latency in the rendered Review output section", () => {
    const hasLatencyOutput =
      content.includes("Avg latency:") ||
      content.includes("latency") ||
      content.includes("review_latency_h");
    expect(hasLatencyOutput).toBe(true);
  });

  it("includes Avg rework cycles in the rendered Review output section", () => {
    const hasReworkOutput =
      content.includes("Avg rework") ||
      content.includes("rework cycles") ||
      content.includes("rework_cycles");
    expect(hasReworkOutput).toBe(true);
  });
});

describe("metrics.md — per-layer First-Time Quality breakdown (MDR-2.2)", () => {
  it("Step 3a mentions per-layer First-Time Quality calculation using the layer field", () => {
    const hasLayerFtq =
      content.includes("layer") &&
      (content.includes("per-layer") ||
        content.includes("Per-layer") ||
        content.includes("per layer") ||
        content.includes("Per layer"));
    expect(hasLayerFtq).toBe(true);
  });

  it("specifies a minimum threshold of 3 records for showing a layer breakdown", () => {
    const hasThreshold =
      content.includes("3 or more") ||
      content.includes("fewer than 3") ||
      content.includes("3 review-enriched") ||
      (content.includes("minimum") && content.includes("3"));
    expect(hasThreshold).toBe(true);
  });

  it("uses the same First-Time Quality formula for per-layer: simplify.total==0 AND SHIP IT AND ci_fix_attempts==0", () => {
    // The per-layer section must reference all three conditions in the same formula context
    const hasLayerFtqFormula =
      content.includes("layer_ftq_rate") ||
      (content.includes("layer") &&
        content.includes("simplify.total") &&
        content.includes("SHIP IT") &&
        content.includes("ci_fix_attempts"));
    expect(hasLayerFtqFormula).toBe(true);
  });

  it("states that records without a layer field do not affect backward compatibility (byte-identical output)", () => {
    const hasBackwardCompat =
      content.includes("byte-identical") && content.includes("layer");
    expect(hasBackwardCompat).toBe(true);
  });

  it("specifies that records without a layer field are excluded from the per-layer breakdown", () => {
    const hasExclusion =
      content.includes("no `layer`") ||
      content.includes("no layer") ||
      content.includes("without a `layer`") ||
      content.includes("excluded from the breakdown") ||
      (content.includes("layer") && content.includes("excluded"));
    expect(hasExclusion).toBe(true);
  });

  it("describes the display format showing per-layer rates indented under the overall First-Time Quality line", () => {
    const hasIndentedDisplay =
      content.includes("Per layer:") ||
      content.includes("per layer:") ||
      (content.includes("Per layer") && content.includes("rate"));
    expect(hasIndentedDisplay).toBe(true);
  });

  it("notes that omitted layers are reported with their record count", () => {
    const hasOmittedNote =
      content.includes("too few for breakdown") ||
      content.includes("too few") ||
      (content.includes("omit") && content.includes("count"));
    expect(hasOmittedNote).toBe(true);
  });
});
