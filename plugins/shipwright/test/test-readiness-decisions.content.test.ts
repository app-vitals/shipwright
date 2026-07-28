/**
 * test-readiness-decisions.md content tests — TRD-1.1
 *
 * Verifies the repo-tracked test-readiness decisions registry
 * (.claude/shipwright/test-readiness-decisions.md) exists, documents its own
 * entry format, explains who maintains it and how `test-inventory`/`test-fix`
 * consume it, and carries a real seeded entry: the html-escape.ts decision
 * accepting indirect Playwright e2e coverage over a bun:test unit file.
 *
 * Content-assertion only: existsSync/readFileSync, no I/O beyond local file
 * reads (mirrors consolidation-decisions.content.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// plugins/shipwright/test/ → repo root
const repoRoot = resolve(import.meta.dir, "..", "..", "..");

const registryPath = join(repoRoot, ".claude", "shipwright", "test-readiness-decisions.md");

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

describe("test-readiness-decisions.md — file", () => {
  it(".claude/shipwright/test-readiness-decisions.md exists", () => {
    expect(existsSync(registryPath)).toBe(true);
  });
});

// ── Top-of-file doc-comment explains maintenance and consumption ────────────

describe("test-readiness-decisions.md — top-of-file doc-comment", () => {
  it("explains humans edit this file", () => {
    expect(readRegistry().toLowerCase()).toContain("human");
  });

  it("mentions test-inventory as a consumer", () => {
    expect(readRegistry()).toContain("test-inventory");
  });

  it("mentions test-fix as a consumer", () => {
    expect(readRegistry()).toContain("test-fix");
  });

  it("explains the file is never written by the skills that consume it", () => {
    expect(readRegistry().toLowerCase()).toContain("never written by them");
  });
});

// ── Documented entry format ──────────────────────────────────────────────────

describe("test-readiness-decisions.md — documented entry format", () => {
  const requiredFields = ["**Item:**", "**Decision:**", "**Rationale:**", "**Revisit:**"];

  for (const field of requiredFields) {
    it(`documents the ${field} field`, () => {
      expect(readRegistry()).toContain(field);
    });
  }
});

// ── Seeded entry: html-escape.ts indirect e2e coverage decision ─────────────

describe("test-readiness-decisions.md — seeded html-escape.ts entry", () => {
  it("mentions html-escape.ts", () => {
    expect(readRegistry()).toContain("html-escape.ts");
  });

  it("mentions test-t-073-shipwright", () => {
    expect(readRegistry()).toContain("test-t-073-shipwright");
  });

  it("has all four fields populated in the same entry as the decision", () => {
    const block = entryBlock(readRegistry(), "html-escape.ts");
    expect(block).toContain("**Item:**");
    expect(block).toContain("**Decision:**");
    expect(block).toContain("**Rationale:**");
    expect(block).toContain("**Revisit:**");
  });

  it("rationale mentions all 3 call sites are covered by matching spec files", () => {
    const block = entryBlock(readRegistry(), "html-escape.ts");
    expect(block).toContain("compare.spec.ts");
    expect(block).toContain("self-hosted.spec.ts");
    expect(block).toContain("vs-devin.spec.ts");
  });

  it("rationale mentions site/ has no unit-test convention", () => {
    const block = entryBlock(readRegistry(), "html-escape.ts");
    expect(block.toLowerCase()).toContain("no unit-test convention");
  });

  it("revisit condition names a concrete triggering event (4th call site or convention change)", () => {
    const block = entryBlock(readRegistry(), "html-escape.ts");
    expect(block.toLowerCase()).toMatch(/4th call site/);
  });
});
