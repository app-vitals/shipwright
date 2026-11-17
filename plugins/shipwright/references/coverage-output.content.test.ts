/**
 * coverage-output.md content tests — CVT-1.3
 *
 * Verifies the coverage-output reference documents the artifact contract,
 * accepted formats, the JSON escape hatch, the default-branch requirement,
 * an example upload step, per-language recipes and the exclusion contract. Content-assertion only (mirrors decisions-registry.content.test.ts).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REFERENCE_PATH = join(import.meta.dir, "coverage-output.md");

let content: string;

beforeAll(() => {
  content = existsSync(REFERENCE_PATH)
    ? readFileSync(REFERENCE_PATH, "utf-8")
    : "";
});

describe("coverage-output.md — contract", () => {
  it("exists", () => {
    expect(existsSync(REFERENCE_PATH)).toBe(true);
  });

  it("names the shipwright-coverage artifact", () => {
    expect(content).toContain("`shipwright-coverage`");
  });

  it("lists every accepted format", () => {
    for (const f of ["lcov", "Cobertura", "JaCoCo", "Go coverprofile"]) {
      expect(content).toContain(f);
    }
  });

  it("documents the shipwright-coverage.json escape hatch", () => {
    expect(content).toContain("shipwright-coverage.json");
    expect(content).toContain('"lines": { "covered"');
  });

  it("requires CI to run on pushes to the default branch", () => {
    expect(content).toContain("pushes to the default branch");
  });

  it("includes an example upload step", () => {
    expect(content).toContain("actions/upload-artifact");
    expect(content).toContain("name: shipwright-coverage");
  });
});

describe("coverage-output.md — per-language recipes", () => {
  const recipes = [
    "Bun",
    "Jest",
    "Vitest",
    "Python",
    "Go",
    "Rust",
    "Java / Kotlin",
    ".NET",
    "Ruby",
    "PHP",
  ];
  for (const lang of recipes) {
    it(`has a recipe row for ${lang}`, () => {
      expect(content).toMatch(new RegExp(`^\\| .*${lang.replace(".", "\\.")}`, "m"));
    });
  }
});

describe("coverage-output.md — exclusion contract", () => {
  it("documents the exclusion file and its shape", () => {
    expect(content).toContain(".shipwright/coverage.json");
    for (const k of [
      "maxExcludedPct",
      "excludePrefixes",
      "excludeSubstrings",
      "reason",
    ]) {
      expect(content).toContain(k);
    }
  });

  it("documents prefix startsWith and substring includes semantics", () => {
    expect(content).toContain("startsWith");
    expect(content).toContain("includes");
  });

  it("documents the per-commit-SHA lookup and 404 handling", () => {
    expect(content).toContain("commit SHA");
    expect(content).toContain("404");
  });

  it("documents the honesty rules", () => {
    expect(content).toContain("reason is required");
    expect(content).toContain("ceiling");
    expect(content).toContain("dead");
  });

  it("documents the excluded block and the lcov-only scope", () => {
    expect(content).toContain("`excluded`");
    expect(content).toContain("deadEntries");
    expect(content).toContain("lcov only");
  });

  it("no longer claims the reader applies no excludes", () => {
    expect(content).not.toContain("Raw total, no path excludes");
  });
});

describe("coverage-output.md — no repo-specific names", () => {
  it("does not name an org, repo or workflow", () => {
    expect(content).not.toContain("app-vitals");
    expect(content).not.toContain("check-coverage");
  });
});
