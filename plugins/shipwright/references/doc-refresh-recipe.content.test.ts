import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RECIPE_PATH = join(import.meta.dir, "doc-refresh-recipe.md");
const REFRESHER_PATH = join(import.meta.dir, "..", "agents", "docs-refresher.md");

let recipe: string;
let refresher: string;

beforeAll(() => {
  recipe = readFileSync(RECIPE_PATH, "utf-8");
  refresher = readFileSync(REFRESHER_PATH, "utf-8");
});

describe("doc-refresh-recipe.md — Measured values rule", () => {
  it("has a Measured values section", () => {
    expect(recipe).toContain("## Measured values");
  });

  it("defines observed vs configured values", () => {
    expect(recipe).toContain("Observed value");
    expect(recipe).toContain("Configured value");
    expect(recipe).toContain("fail_under = 51");
  });

  it("defines replace-with-pointer behavior", () => {
    expect(recipe).toContain("Replace-with-pointer");
  });

  it("lists the exempt paths", () => {
    expect(recipe).toContain("docs/test-readiness/**");
    expect(recipe).toContain("planning/**");
    expect(recipe).toContain("dated snapshots");
  });

  it("includes the TESTING.md before/after worked example", () => {
    expect(recipe).toContain("CI baseline 51.82% (CI run");
    expect(recipe).toContain("on PR #52)");
    expect(recipe).toContain("latest CI run");
  });
});

describe("docs-refresher.md — references the Measured values rule", () => {
  it("references the rule in the recipe", () => {
    expect(refresher).toContain("Measured values");
    expect(refresher).toContain("references/doc-refresh-recipe.md");
  });

  it("lists it under the never-write guidance", () => {
    expect(refresher).toContain("Never write measured values");
  });
});
