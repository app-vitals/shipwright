/**
 * consolidation-scan content tests — DRU-1.1
 *
 * Verifies Step 1 ("Load the Decisions Registry (Suppressions)") cites the
 * shared decisions-registry pattern reference doc
 * (references/decisions-registry.md), the generic description of the schema
 * consolidation-decisions.md and test-readiness-decisions.md both follow.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_MD_PATH = join(import.meta.dir, "SKILL.md");

function readSkill(): string {
  return readFileSync(SKILL_MD_PATH, "utf8");
}

describe("consolidation-scan — SKILL.md exists", () => {
  it("file exists", () => {
    expect(existsSync(SKILL_MD_PATH)).toBe(true);
  });
});

describe("consolidation-scan — cites the shared decisions-registry reference doc", () => {
  it("Step 1 cites references/decisions-registry.md", () => {
    expect(readSkill()).toContain("references/decisions-registry.md");
  });
});
