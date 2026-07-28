/**
 * test-fix content tests — TRD-1.2
 *
 * Verifies plugins/shipwright/skills/test-fix/SKILL.md documents a
 * registry cross-check step before filing any task-store task (not just
 * rule-(d) HITL ones): checking .claude/shipwright/test-readiness-decisions.md
 * for a matching entry, skipping and logging a match as suppressed, and
 * surfacing suppressed rows in the run-summary output. Mirrors
 * consolidation-fix.content.test.ts's "cross-checks consolidation-decisions.md"
 * coverage of consolidation-fix/SKILL.md's Step 3.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads (mirrors consolidation-fix.content.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → plugins/shipwright/
const pluginRoot = resolve(import.meta.dir, "..");

function pluginPath(...parts: string[]): string {
  return join(pluginRoot, ...parts);
}

const skillPath = pluginPath("skills", "test-fix", "SKILL.md");

function readSkill(): string {
  return readFileSync(skillPath, "utf8");
}

// ── File exists ─────────────────────────────────────────────────────────────

describe("test-fix — file exists", () => {
  it("skills/test-fix/SKILL.md exists", () => {
    expect(existsSync(skillPath)).toBe(true);
  });
});

// ── Cross-checks test-readiness-decisions.md before filing any task ────────

describe("test-fix — cross-checks test-readiness-decisions.md", () => {
  it("mentions .claude/shipwright/test-readiness-decisions.md", () => {
    expect(readSkill()).toContain(".claude/shipwright/test-readiness-decisions.md");
  });

  it("documents cross-checking it before filing (not just reading it once)", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("cross-check");
  });

  it("documents the check applies to every task, not just rule-(d)/HITL ones", () => {
    const lower = readSkill().toLowerCase();
    expect(lower.includes("any task") || lower.includes("not just")).toBe(true);
  });

  it("documents skipping and logging a matched row as suppressed", () => {
    const lower = readSkill().toLowerCase();
    expect(lower).toContain("suppress");
  });

  it('documents the run-summary "SUPPRESSED {N} - resolved per test-readiness-decisions.md" line', () => {
    expect(readSkill()).toContain("resolved per test-readiness-decisions.md");
    expect(readSkill().toUpperCase()).toContain("SUPPRESSED");
  });
});
