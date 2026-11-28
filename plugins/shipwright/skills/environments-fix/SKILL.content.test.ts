import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fix = readFileSync(join(import.meta.dir, "SKILL.md"), "utf-8");

describe("environments-fix SKILL.md", () => {
  it("requires --repo and prints usage", () => {
    expect(fix).toContain("name: environments-fix");
    expect(fix).toContain(
      "Usage: /shipwright:environments-fix --repo org/repo [--dry-run]",
    );
  });

  it("routes auto / review / plan per check", () => {
    expect(fix).toContain("lockfile, tool-versions");
    expect(fix).toContain("structured-logging, error-tracking");
    expect(fix).toContain("preview-environment, tracing-metrics, staged-canary");
    expect(fix).toContain("`needs-review:`");
    expect(fix).toContain("`kind: prd`, `hitl: true`");
  });

  it("points the preview plan task at Shipwright's own pattern", () => {
    expect(fix).toContain("docs/preview-environment.md");
    expect(fix).toContain("scripts/preview-env.ts");
  });

  it("dedups pagination-safely and never opens PRs", () => {
    expect(fix).toContain("limit=1000");
    expect(fix).toContain("nextCursor");
    expect(fix).toContain("never opens PRs");
  });
});
