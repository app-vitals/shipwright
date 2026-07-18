/**
 * consolidation-decisions.md content tests — CVG-1.2
 *
 * Verifies the repo-tracked consolidation-decisions registry
 * (.claude/shipwright/consolidation-decisions.md) exists, documents its own
 * entry format, explains who maintains it and how `consolidation-scan`
 * consumes it, and carries a real seeded entry: shipwright's own decision
 * not to build an abstraction layer over Claude Code.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads (mirrors principles-content.content.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → repo root
const repoRoot = resolve(import.meta.dir, "..", "..", "..");

const registryPath = join(repoRoot, ".claude", "shipwright", "consolidation-decisions.md");

function readRegistry(): string {
  return readFileSync(registryPath, "utf8");
}

/** Extract the markdown block for a `### <heading>` entry, up to the next `##`/`###`. */
function entryBlock(content: string, headingSubstring: string): string {
  const headingLineMatch = content
    .split("\n")
    .find((line) => line.startsWith("###") && line.includes(headingSubstring));
  if (!headingLineMatch) return "";
  const start = content.indexOf(headingLineMatch);
  const rest = content.slice(start + headingLineMatch.length);
  const next = rest.search(/\n#{2,3}\s/);
  return next === -1 ? rest : rest.slice(0, next);
}

// ── File exists ─────────────────────────────────────────────────────────────

describe("consolidation-decisions.md — file", () => {
  it(".claude/shipwright/consolidation-decisions.md exists", () => {
    expect(existsSync(registryPath)).toBe(true);
  });
});

// ── Top-of-file doc-comment explains maintenance and consumption ────────────

describe("consolidation-decisions.md — top-of-file doc-comment", () => {
  it("explains humans edit this file", () => {
    expect(readRegistry().toLowerCase()).toContain("human");
  });

  it("mentions review of consolidation-fix PRs as an editing occasion", () => {
    expect(readRegistry().toLowerCase()).toContain("consolidation-fix");
  });

  it("explains consolidation-scan consumes/reads this file", () => {
    expect(readRegistry()).toContain("consolidation-scan");
  });

  it("mentions the suppression list consolidation-scan builds from this file", () => {
    expect(readRegistry().toLowerCase()).toContain("suppression");
  });
});

// ── Documented entry format ──────────────────────────────────────────────────

describe("consolidation-decisions.md — documented entry format", () => {
  const requiredFields = ["**Pattern:**", "**Decision:**", "**Rationale:**", "**Revisit:**"];

  for (const field of requiredFields) {
    it(`documents the ${field} field`, () => {
      expect(readRegistry()).toContain(field);
    });
  }
});

// ── Seeded entry: Claude Code non-abstraction decision ──────────────────────

describe("consolidation-decisions.md — seeded Claude Code non-abstraction entry", () => {
  it("mentions Claude Code", () => {
    expect(readRegistry()).toContain("Claude Code");
  });

  it("mentions not building an abstraction layer", () => {
    expect(readRegistry().toLowerCase()).toContain("abstraction layer");
  });

  it("has a Pattern field with recognizable content in the same entry as the decision", () => {
    const block = entryBlock(readRegistry(), "Claude Code");
    expect(block).toContain("**Pattern:**");
    expect(block).toContain("**Decision:**");
    expect(block).toContain("**Rationale:**");
    expect(block).toContain("**Revisit:**");
  });

  it("rationale mentions upgrading to new Claude Code features stays easy", () => {
    const block = entryBlock(readRegistry(), "Claude Code");
    expect(block.toLowerCase()).toContain("upgrad");
  });

  it("revisit condition names a concrete triggering event (second harness/provider)", () => {
    const block = entryBlock(readRegistry(), "Claude Code");
    expect(block.toLowerCase()).toMatch(/second (agent )?(harness|provider|llm)/);
  });
});
