/**
 * Cassette/VCR terminology rename regression guard — PRN-1.2
 *
 * Verifies docs/testing.md, docs/test-readiness/test-system.md,
 * skills/test-design/SKILL.md, and skills/repo-config/SKILL.md use
 * "recorded fixture doubles" terminology instead of "VCR"/"cassette"
 * (mirrors plugins/shipwright/test/principles-content.content.test.ts, PRN-1.1).
 *
 * Content-assertion only: readFileSync, no I/O beyond local file reads.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → repo root
const repoRoot = resolve(import.meta.dir, "..", "..", "..");

function repoPath(...parts: string[]): string {
  return join(repoRoot, ...parts);
}

const TARGET_FILES = [
  "docs/testing.md",
  "docs/test-readiness/test-system.md",
  "plugins/shipwright/skills/test-design/SKILL.md",
  "plugins/shipwright/skills/repo-config/SKILL.md",
] as const;

function readTarget(path: string): string {
  return readFileSync(repoPath(path), "utf8");
}

describe("fixture terminology rename — no cassette/VCR", () => {
  for (const path of TARGET_FILES) {
    it(`${path} does not contain 'cassette' (case-insensitive)`, () => {
      expect(readTarget(path).toLowerCase()).not.toContain("cassette");
    });

    it(`${path} does not contain 'VCR' (case-insensitive)`, () => {
      expect(readTarget(path).toLowerCase()).not.toContain("vcr");
    });

    it(`${path} uses 'recorded fixture double' terminology`, () => {
      expect(readTarget(path).toLowerCase()).toContain("recorded fixture double");
    });
  }
});
