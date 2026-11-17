/**
 * plugins/shipwright/scripts/coverage/detect.ts
 *
 * Detects a coverage report's format from its CONTENT. The only name-based
 * rule is the shipwright-coverage.json handoff file.
 */

import type { CoverageFormat } from "./types.ts";

export const SHIPWRIGHT_COVERAGE_FILE = "shipwright-coverage.json";

export function detectFormat(
  fileName: string,
  content: string,
): CoverageFormat | null {
  const base = fileName.split(/[\\/]/).pop();
  if (base === SHIPWRIGHT_COVERAGE_FILE) return "shipwright";

  const text = content.replace(/^﻿/, "").trimStart();
  if (text === "") return null;

  if (/^mode:\s*(set|count|atomic)\b/.test(text)) return "go-cover";
  if (text.startsWith("<")) {
    if (/<coverage\b/.test(text)) return "cobertura";
    if (/<report\b/.test(text)) return "jacoco";
    return null;
  }
  if (/^(TN:|SF:)/m.test(text)) return "lcov";
  return null;
}
