/**
 * plugins/shipwright/scripts/prompt-audit/fingerprint.ts
 *
 * Stable finding fingerprints for the prompt audit. A fingerprint identifies
 * "the same finding" across runs, so it must not depend on line numbers or
 * incidental whitespace/case in the evidence text.
 */

import { createHash } from "node:crypto";

export const FINGERPRINT_LENGTH = 12;

export interface FingerprintInput {
  rule: string;
  file: string;
  evidence: string;
}

/** Collapse whitespace, lowercase, and strip line-number references. */
export function normalizeEvidence(evidence: string): string {
  return evidence
    .replace(/\b(?:lines?|ln|l)\s*\d+(?:\s*[-–]\s*\d+)?/gi, " ")
    .replace(/:\d+(?::\d+)?(?:-\d+)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** sha256(class|rule|file|normalizedEvidence), truncated to 12 hex chars. */
export function fingerprint(
  loadClass: string,
  { rule, file, evidence }: FingerprintInput,
): string {
  const key = [loadClass, rule, file, normalizeEvidence(evidence)].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, FINGERPRINT_LENGTH);
}
