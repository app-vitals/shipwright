/**
 * plugins/shipwright/scripts/coverage/types.ts
 *
 * Normalized coverage shape shared by every report parser. Percentages are
 * never carried — only raw covered/total counts, so reports can be summed.
 */

export interface CoverageCounts {
  covered: number;
  total: number;
}

export interface NormalizedCoverage {
  lines: CoverageCounts;
  branches?: CoverageCounts;
  functions?: CoverageCounts;
  tool: string;
}

export type CoverageFormat =
  | "lcov"
  | "cobertura"
  | "jacoco"
  | "go-cover"
  | "shipwright";
