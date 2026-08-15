// Per-repo coverage-tool dispatch (MTC-1.6): selects the CoverageParser to
// use based on the `**Coverage toolchain:**` field recorded per repo in
// docs/test-readiness/test-system.md (added by CGT-1.3), defaulting to
// LcovParser when the field is unset or unrecognized — preserving today's
// behavior for every repo without an explicit record.
import {
  CoveragePyParser,
  type CoverageParser,
  GoCoverParser,
  IstanbulParser,
  JacocoParser,
  LcovParser,
} from "./check-coverage";

const COVERAGE_TOOL_RE = /\*\*Coverage toolchain:\*\*\s*`([^`]+)`/;

export function extractCoverageTool(
  markdownContent: string,
): string | undefined {
  const match = markdownContent.match(COVERAGE_TOOL_RE);
  return match ? match[1] : undefined;
}

// Dispatches a recorded `tool` value (from extractCoverageTool) to the
// matching CoverageParser. "c8", "nyc", and "c8-nyc" are all aliases for the
// same Istanbul JSON format (c8 and nyc both produce it), so all three
// dispatch to IstanbulParser. Unset or unrecognized values fall back to
// LcovParser — the pre-MTC-1.6 default — so every repo without an explicit
// recorded tool keeps behaving exactly as it did before this dispatch
// existed.
export function selectParser(tool: string | undefined): CoverageParser {
  switch (tool) {
    case "jacoco":
      return JacocoParser;
    case "coverage.py":
      return CoveragePyParser;
    case "c8":
    case "nyc":
    case "c8-nyc":
      return IstanbulParser;
    case "go-cover":
      return GoCoverParser;
    default:
      return LcovParser;
  }
}
